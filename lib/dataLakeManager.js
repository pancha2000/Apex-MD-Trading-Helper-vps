'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD  ·  lib/dataLakeManager.js
 *  ──────────────────────────────────────────────────────────────
 *  Local Data Lake — Brain & Sync Engine
 *
 *  Responsibilities
 *  ────────────────
 *  1. TrackedCoin registry   — which coins belong to the lake
 *  2. Gap-fill sync          — fetch only MISSING candles since
 *                              last update (not a full re-download)
 *  3. Auto-sync scheduler    — cron-style daily update
 *  4. Temp sessions          — ephemeral OHLCV for one-off
 *                              analysis (auto-expire in 48h)
 *  5. getCandles()           — smart getter used by the analyser:
 *                              lake first → gap-fill → temp fallback
 *
 *  Memory safety
 *  ─────────────
 *  • bulkWrite upserts — never accumulates large arrays in RAM
 *  • 2s sleep between Binance pages
 *  • Processes one timeframe at a time
 * ════════════════════════════════════════════════════════════════
 */

const mongoose   = require('mongoose');
const axios      = require('axios');
const { MarketData } = require('./marketDataSchema');

// ─────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────
const BINANCE_BASE       = 'https://api.binance.com';
const PAGE_SIZE          = 1000;
const SLEEP_MS           = 2000;
const MAX_RETRIES        = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const TEMP_TTL_HOURS     = 48;

const TF_MS = {
    '1m':  60_000,       '3m':  180_000,     '5m':  300_000,
    '15m': 900_000,      '30m': 1_800_000,   '1h':  3_600_000,
    '2h':  7_200_000,    '4h':  14_400_000,  '6h':  21_600_000,
    '8h':  28_800_000,   '12h': 43_200_000,  '1d':  86_400_000,
};

// ─────────────────────────────────────────────────────────────────
//  SCHEMA — TrackedCoin  (the lake's coin registry)
// ─────────────────────────────────────────────────────────────────
const TrackedCoinSchema = new mongoose.Schema({
    symbol:       { type: String,   required: true, unique: true, uppercase: true, trim: true },
    startDate:    { type: Date,     required: true },
    timeframes:   { type: [String], default: ['15m', '1h', '4h'] },
    lastSync:     { type: Date,     default: null },   // null = never synced
    totalCandles: { type: Number,   default: 0 },
    status:       { type: String,   enum: ['active','syncing','error','pending'], default: 'pending' },
    errorMsg:     { type: String,   default: '' },
    addedAt:      { type: Date,     default: Date.now },
}, { collection: 'trackedcoins', versionKey: false });

const TrackedCoin = mongoose.models.TrackedCoin
    || mongoose.model('TrackedCoin', TrackedCoinSchema);

// ─────────────────────────────────────────────────────────────────
//  SCHEMA — TempSession  (ephemeral OHLCV for one-off analysis)
// ─────────────────────────────────────────────────────────────────
const TempSessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true, index: true },
    coin:      { type: String, required: true },
    candles:   { type: mongoose.Schema.Types.Mixed, default: {} },
    // { '15m': [{t,o,h,l,c,v}, ...], '1h': [...] }
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
}, { collection: 'tempsessions', versionKey: false });

// MongoDB auto-deletes expired docs
TempSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const TempSession = mongoose.models.TempSession
    || mongoose.model('TempSession', TempSessionSchema);

// ─────────────────────────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** In-memory sync lock — prevents two concurrent syncs */
const _syncLocks = new Set();

/** Progress callbacks registered by SSE routes */
const _progressListeners = new Map();  // syncId → callback(event)

function emitProgress(syncId, event) {
    const cb = _progressListeners.get(syncId);
    if (cb) cb(event);
}

// ─────────────────────────────────────────────────────────────────
//  CORE — fetchKlines (with retry)
// ─────────────────────────────────────────────────────────────────
async function fetchKlines(symbol, interval, startTime, endTime) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const { data } = await axios.get(`${BINANCE_BASE}/api/v3/klines`, {
                timeout: REQUEST_TIMEOUT_MS,
                params:  { symbol, interval, startTime, endTime, limit: PAGE_SIZE },
            });
            if (!Array.isArray(data)) throw new Error(`Bad Binance response: ${JSON.stringify(data)}`);
            return data;
        } catch (err) {
            lastErr = err;
            const isRateLimit = err?.response?.status === 429 || err?.response?.status === 418;
            const backoff     = isRateLimit ? 60_000 : Math.pow(2, attempt) * 1_000;
            await sleep(backoff);
        }
    }
    throw lastErr;
}

// ─────────────────────────────────────────────────────────────────
//  CORE — bulkWrite one page
// ─────────────────────────────────────────────────────────────────
async function savePage(coin, timeframe, rawPage) {
    if (!rawPage.length) return 0;
    const ops = rawPage.map(k => ({
        updateOne: {
            filter: { coin, timeframe, timestamp: new Date(k[0]) },
            update: {
                $set: {
                    open:   parseFloat(k[1]),
                    high:   parseFloat(k[2]),
                    low:    parseFloat(k[3]),
                    close:  parseFloat(k[4]),
                    volume: parseFloat(k[5]),
                },
            },
            upsert: true,
        },
    }));
    const r = await MarketData.bulkWrite(ops, { ordered: false });
    return (r.upsertedCount || 0) + (r.modifiedCount || 0) + (r.matchedCount || 0);
}

// ─────────────────────────────────────────────────────────────────
//  CORE — gap-fill ONE coin+timeframe pair
//  fromMs: start timestamp (ms). Defaults to stored lastSync.
// ─────────────────────────────────────────────────────────────────
async function syncPair(coin, timeframe, fromMs, syncId) {
    const tfMs  = TF_MS[timeframe] || 900_000;
    const nowMs = Date.now();
    let cursorMs = fromMs;
    let totalSaved = 0;

    while (cursorMs < nowMs) {
        emitProgress(syncId, { type: 'page', coin, timeframe, from: cursorMs });

        let rawPage;
        try {
            rawPage = await fetchKlines(coin, timeframe, cursorMs, nowMs);
        } catch (err) {
            emitProgress(syncId, { type: 'error', coin, timeframe, msg: err.message });
            throw err;
        }

        if (!rawPage.length) break;

        const saved = await savePage(coin, timeframe, rawPage);
        totalSaved += saved;
        emitProgress(syncId, { type: 'saved', coin, timeframe, count: rawPage.length, total: totalSaved });

        const lastOpenTime = rawPage[rawPage.length - 1][0];
        cursorMs = lastOpenTime + tfMs;

        // Free memory immediately
        rawPage.length = 0;

        if (cursorMs < nowMs) await sleep(SLEEP_MS);
    }

    return totalSaved;
}

// ─────────────────────────────────────────────────────────────────
//  PUBLIC API — addCoin
//  Adds coin to registry. Does NOT immediately download.
//  The next sync (manual or scheduled) will do the initial pull.
// ─────────────────────────────────────────────────────────────────
async function addCoin(symbol, startDate, timeframes) {
    const sym = symbol.trim().toUpperCase();
    if (!sym.endsWith('USDT')) throw new Error('Only USDT pairs supported');
    const tfs = Array.isArray(timeframes) && timeframes.length
        ? timeframes
        : ['15m', '1h', '4h'];

    await TrackedCoin.findOneAndUpdate(
        { symbol: sym },
        {
            $setOnInsert: { addedAt: new Date() },
            $set: {
                startDate: new Date(startDate),
                timeframes: tfs,
                status: 'pending',
                errorMsg: '',
            },
        },
        { upsert: true }
    );
    return { symbol: sym, startDate, timeframes: tfs };
}

// ─────────────────────────────────────────────────────────────────
//  PUBLIC API — removeCoin
//  Removes from registry AND deletes all stored candles.
// ─────────────────────────────────────────────────────────────────
async function removeCoin(symbol) {
    const sym = symbol.trim().toUpperCase();
    const [del, candles] = await Promise.all([
        TrackedCoin.deleteOne({ symbol: sym }),
        MarketData.deleteMany({ coin: sym }),
    ]);
    return { deleted: del.deletedCount > 0, candlesRemoved: candles.deletedCount };
}

// ─────────────────────────────────────────────────────────────────
//  PUBLIC API — syncCoin
//  Gap-fills from lastSync (or startDate) to NOW for one coin.
//  Emits real-time progress via syncId.
// ─────────────────────────────────────────────────────────────────
async function syncCoin(symbol, syncId = null) {
    const sym = symbol.trim().toUpperCase();
    const id  = syncId || `sync_${sym}_${Date.now()}`;

    if (_syncLocks.has(sym)) {
        return { skipped: true, reason: 'Already syncing' };
    }
    _syncLocks.add(sym);

    const coin = await TrackedCoin.findOne({ symbol: sym });
    if (!coin) {
        _syncLocks.delete(sym);
        throw new Error(`${sym} is not in the tracked coin list`);
    }

    await TrackedCoin.updateOne({ symbol: sym }, { $set: { status: 'syncing', errorMsg: '' } });

    let grandTotal = 0;
    let errMsg     = '';

    try {
        for (const tf of coin.timeframes) {
            // Resume from lastSync if available, otherwise start from startDate
            let fromMs;
            if (coin.lastSync) {
                const tfMs = TF_MS[tf] || 900_000;
                fromMs = coin.lastSync.getTime() + tfMs;
            } else {
                fromMs = coin.startDate.getTime();
            }

            const nowMs = Date.now();
            if (fromMs >= nowMs - (TF_MS[tf] || 900_000)) {
                emitProgress(id, { type: 'uptodate', coin: sym, timeframe: tf });
                continue;  // already current
            }

            emitProgress(id, { type: 'start', coin: sym, timeframe: tf, from: fromMs });
            const saved = await syncPair(sym, tf, fromMs, id);
            grandTotal += saved;
        }

        await TrackedCoin.updateOne(
            { symbol: sym },
            {
                $set: {
                    status:       'active',
                    lastSync:     new Date(),
                    errorMsg:     '',
                },
                $inc: { totalCandles: grandTotal },
            }
        );
        emitProgress(id, { type: 'done', coin: sym, totalSaved: grandTotal });

    } catch (err) {
        errMsg = err.message;
        await TrackedCoin.updateOne({ symbol: sym }, { $set: { status: 'error', errorMsg: errMsg } });
        emitProgress(id, { type: 'error', coin: sym, msg: errMsg });
    } finally {
        _syncLocks.delete(sym);
    }

    return { symbol: sym, totalSaved: grandTotal, error: errMsg || null };
}

// ─────────────────────────────────────────────────────────────────
//  PUBLIC API — syncAll
//  Gap-fills every tracked coin sequentially.
//  Called by: scheduled cron OR manual "Sync All" button.
// ─────────────────────────────────────────────────────────────────
async function syncAll(syncId = null) {
    const coins = await TrackedCoin.find({ status: { $ne: 'syncing' } }).lean();
    const id    = syncId || `syncall_${Date.now()}`;
    const results = [];

    emitProgress(id, { type: 'start_all', total: coins.length });

    for (const coin of coins) {
        const result = await syncCoin(coin.symbol, id);
        results.push(result);
        // Breathing room between coins
        await sleep(5_000);
    }

    emitProgress(id, { type: 'done_all', results });
    return results;
}

// ─────────────────────────────────────────────────────────────────
//  PUBLIC API — getStatus
//  Returns status of every tracked coin for the dashboard.
// ─────────────────────────────────────────────────────────────────
async function getStatus() {
    const coins = await TrackedCoin.find().sort({ symbol: 1 }).lean();
    const total = await MarketData.countDocuments();

    return {
        coins: coins.map(c => ({
            symbol:       c.symbol,
            startDate:    c.startDate,
            timeframes:   c.timeframes,
            lastSync:     c.lastSync,
            totalCandles: c.totalCandles,
            status:       c.status,
            errorMsg:     c.errorMsg,
            addedAt:      c.addedAt,
            isSyncing:    _syncLocks.has(c.symbol),
        })),
        totalCandles:  total,
        trackedCount:  coins.length,
        activeSyncs:   [..._syncLocks],
    };
}

// ─────────────────────────────────────────────────────────────────
//  PUBLIC API — getCandles  (used by analyser)
//
//  Smart priority:
//    1. If coin is tracked → return from MarketData
//       + gap-fill if lastSync is stale (older than 1 candle period)
//    2. If not tracked → create/reuse TempSession (Binance live fetch)
//
//  Returns: { source: 'lake'|'temp', candles: Array, sessionId? }
// ─────────────────────────────────────────────────────────────────
async function getCandles(coin, timeframe, limit = 500, sessionId = null) {
    const sym   = coin.toUpperCase();
    const tfMs  = TF_MS[timeframe] || 900_000;
    const nowMs = Date.now();

    const tracked = await TrackedCoin.findOne({ symbol: sym }).lean();

    // ── PATH A: Coin is in the lake ──────────────────────────────
    if (tracked) {
        // Check if we need a quick gap-fill first
        const gapMs = tracked.lastSync
            ? nowMs - tracked.lastSync.getTime()
            : Infinity;

        if (gapMs > tfMs * 2) {
            // Background gap-fill (don't await — return stale data fast)
            setImmediate(() => syncCoin(sym).catch(() => {}));
        }

        const from = new Date(nowMs - limit * tfMs * 1.5);   // 50% headroom
        const candles = await MarketData.find(
            { coin: sym, timeframe, timestamp: { $gte: from } },
            { _id: 0, timestamp: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }
        ).sort({ timestamp: 1 }).lean();

        // Slice to exact limit from the newest end
        const sliced = candles.slice(-limit);

        return { source: 'lake', candles: sliced, sessionId: null };
    }

    // ── PATH B: Temp session (coin not in lake) ──────────────────
    let session = sessionId
        ? await TempSession.findOne({ sessionId }).lean()
        : null;

    const tfKey = timeframe;
    const hasEnough = session?.candles?.[tfKey]?.length >= limit;

    if (!hasEnough) {
        // Fetch from Binance
        const startTime = nowMs - limit * tfMs * 1.2;
        const rawPage   = await fetchKlines(sym, timeframe, startTime, nowMs)
            .catch(() => []);

        const newCandles = rawPage.map(k => ({
            t: k[0], o: parseFloat(k[1]), h: parseFloat(k[2]),
            l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5]),
        }));

        if (!session) {
            const newId    = `tmp_${sym}_${Date.now()}`;
            const expiresAt = new Date(Date.now() + TEMP_TTL_HOURS * 3_600_000);
            session = await TempSession.findOneAndUpdate(
                { sessionId: newId },
                { $set: { sessionId: newId, coin: sym, candles: { [tfKey]: newCandles }, expiresAt } },
                { upsert: true, new: true }
            );
            sessionId = newId;
        } else {
            // Update existing session with new TF data
            await TempSession.updateOne(
                { sessionId },
                { $set: { [`candles.${tfKey}`]: newCandles } }
            );
        }

        // Convert to lake-compatible format
        const candles = newCandles.slice(-limit).map(k => ({
            timestamp: new Date(k.t), open: k.o, high: k.h, low: k.l, close: k.c, volume: k.v,
        }));
        return { source: 'temp', candles, sessionId };
    }

    // Return from existing temp session
    const candles = (session.candles[tfKey] || [])
        .slice(-limit)
        .map(k => ({
            timestamp: new Date(k.t), open: k.o, high: k.h, low: k.l, close: k.c, volume: k.v,
        }));

    return { source: 'temp', candles, sessionId };
}

// ─────────────────────────────────────────────────────────────────
//  PUBLIC API — refreshTempSession
//  Pull fresh candles for an existing temp session (called when
//  market moves and analyser needs updated data mid-trade).
// ─────────────────────────────────────────────────────────────────
async function refreshTempSession(sessionId, timeframe, limit = 500) {
    const session = await TempSession.findOne({ sessionId }).lean();
    if (!session) throw new Error('Temp session not found or expired');

    return getCandles(session.coin, timeframe, limit, sessionId);
}

// ─────────────────────────────────────────────────────────────────
//  PUBLIC API — deleteTempSession
//  Called when a trade closes — wipes ephemeral data.
// ─────────────────────────────────────────────────────────────────
async function deleteTempSession(sessionId) {
    const r = await TempSession.deleteOne({ sessionId });
    return { deleted: r.deletedCount > 0 };
}

// ─────────────────────────────────────────────────────────────────
//  AUTO-SYNC SCHEDULER  (daily cron at 00:05 UTC)
//  Call startScheduler() once from server.js or index.js.
// ─────────────────────────────────────────────────────────────────
let _schedulerTimer = null;

function startScheduler() {
    if (_schedulerTimer) return;   // already running

    function msUntilNextRun() {
        const now  = new Date();
        const next = new Date(Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + (now.getUTCHours() >= 0 ? 1 : 0),
            0, 5, 0, 0    // 00:05 UTC
        ));
        return next.getTime() - Date.now();
    }

    function scheduleNext() {
        const ms = msUntilNextRun();
        console.log(`[DataLake] Auto-sync scheduled in ${(ms / 3_600_000).toFixed(2)}h`);
        _schedulerTimer = setTimeout(async () => {
            console.log('[DataLake] ⏰ Auto-sync starting…');
            try {
                const results = await syncAll('auto_' + Date.now());
                const saved   = results.reduce((a, r) => a + (r.totalSaved || 0), 0);
                console.log(`[DataLake] ✅ Auto-sync complete. ${saved.toLocaleString()} candles updated.`);
            } catch (err) {
                console.error('[DataLake] ❌ Auto-sync failed:', err.message);
            }
            scheduleNext();  // schedule the next day
        }, ms);
    }

    scheduleNext();
}

function stopScheduler() {
    if (_schedulerTimer) {
        clearTimeout(_schedulerTimer);
        _schedulerTimer = null;
    }
}

// ─────────────────────────────────────────────────────────────────
//  PROGRESS LISTENER MANAGEMENT  (for SSE routes)
// ─────────────────────────────────────────────────────────────────
function onProgress(syncId, callback) {
    _progressListeners.set(syncId, callback);
}

function offProgress(syncId) {
    _progressListeners.delete(syncId);
}

// ─────────────────────────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────────────────────────
module.exports = {
    // Models (exported for direct query in analyser if needed)
    TrackedCoin,
    TempSession,

    // Registry
    addCoin,
    removeCoin,
    getStatus,

    // Sync
    syncCoin,
    syncAll,

    // Data access
    getCandles,
    refreshTempSession,
    deleteTempSession,

    // Scheduler
    startScheduler,
    stopScheduler,

    // SSE progress
    onProgress,
    offProgress,
};
