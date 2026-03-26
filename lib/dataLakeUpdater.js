'use strict';
/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD  ·  lib/dataLakeUpdater.js
 *  ──────────────────────────────────────────────────────────────
 *  Daily Data Lake Gap-Fill  (node-cron, 00:05 UTC)
 *
 *  For every coin+timeframe pair it:
 *    1. Queries MarketData for the latest stored timestamp
 *    2. Fetches ONLY the missing newer candles from Binance REST
 *    3. bulkWrite upserts — safe, idempotent, low-memory
 *
 *  Memory safety: one pair at a time, 2s sleep between API calls.
 *  No ram accumulation — rawPage freed after each write.
 * ════════════════════════════════════════════════════════════════
 */

const axios  = require('axios');
const { MarketData } = require('./marketDataSchema');

// ── Coins + timeframes to keep fresh ─────────────────────────────
const COINS = [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
    'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
];
const TIMEFRAMES = ['15m', '1h', '4h'];

const TF_MS = {
    '1m': 60_000, '3m': 180_000, '5m': 300_000,
    '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000,
    '2h': 7_200_000, '4h': 14_400_000, '1d': 86_400_000,
};

const PAGE_SIZE          = 1000;
const SLEEP_BETWEEN_MS   = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES        = 3;
const TAG                = '[DataLakeUpdater]';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────
//  fetchPage — Binance REST with retry + rate-limit handling
// ─────────────────────────────────────────────────────────────────
async function fetchPage(symbol, interval, startTime) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const { data } = await axios.get('https://api.binance.com/api/v3/klines', {
                timeout: REQUEST_TIMEOUT_MS,
                params: { symbol, interval, startTime, limit: PAGE_SIZE },
            });
            if (!Array.isArray(data)) throw new Error('Non-array response');
            return data;
        } catch (err) {
            lastErr = err;
            const is429 = err?.response?.status === 429 || err?.response?.status === 418;
            const wait  = is429 ? 60_000 : Math.pow(2, attempt) * 1_000;
            if (is429) console.warn(`${TAG} Rate limited — waiting 60s`);
            await sleep(wait);
        }
    }
    throw lastErr;
}

// ─────────────────────────────────────────────────────────────────
//  writePage — bulkWrite upsert, then free memory immediately
// ─────────────────────────────────────────────────────────────────
async function writePage(coin, timeframe, rawPage) {
    if (!rawPage.length) return 0;
    const ops = rawPage.map(k => ({
        updateOne: {
            filter: { coin, timeframe, timestamp: new Date(k[0]) },
            update: {
                $set: {
                    open: parseFloat(k[1]), high: parseFloat(k[2]),
                    low:  parseFloat(k[3]), close: parseFloat(k[4]),
                    volume: parseFloat(k[5]),
                },
            },
            upsert: true,
        },
    }));
    const r = await MarketData.bulkWrite(ops, { ordered: false });
    rawPage.length = 0;   // ← free memory immediately (critical on 1 GB VPS)
    return (r.upsertedCount || 0) + (r.modifiedCount || 0);
}

// ─────────────────────────────────────────────────────────────────
//  syncPair — gap-fill one coin+timeframe from latestTs → now
// ─────────────────────────────────────────────────────────────────
async function syncPair(coin, timeframe) {
    const tfMs = TF_MS[timeframe] || 900_000;
    const nowMs = Date.now();

    // Find the newest candle already stored
    const latest = await MarketData.findOne(
        { coin, timeframe },
        { timestamp: 1, _id: 0 }
    ).sort({ timestamp: -1 }).lean();

    // Start one candle after what we have (or 30 days back as fallback)
    const fromMs = latest
        ? latest.timestamp.getTime() + tfMs
        : nowMs - (30 * 24 * 3_600_000);

    if (fromMs >= nowMs - tfMs) {
        console.log(`${TAG} ${coin} ${timeframe} already up to date — skipping`);
        return 0;
    }

    let cursor = fromMs;
    let total  = 0;

    while (cursor < nowMs) {
        let page;
        try {
            page = await fetchPage(coin, timeframe, cursor);
        } catch (err) {
            console.error(`${TAG} ${coin} ${timeframe} fetch failed: ${err.message} — skipping pair`);
            return total;
        }
        if (!page.length) break;

        const saved    = await writePage(coin, timeframe, page);
        total         += saved;
        const lastOpen = page[page.length - 1]?.[0] || cursor;
        cursor         = lastOpen + tfMs;

        if (cursor < nowMs) await sleep(SLEEP_BETWEEN_MS);
    }

    if (total > 0)
        console.log(`${TAG} ✅ ${coin} ${timeframe} — ${total.toLocaleString()} candles added`);

    return total;
}

// ─────────────────────────────────────────────────────────────────
//  runUpdate — full pass over all coins × timeframes
// ─────────────────────────────────────────────────────────────────
async function runUpdate() {
    const start = Date.now();
    console.log(`${TAG} ⏰ Daily gap-fill started at ${new Date().toISOString()}`);

    let grandTotal = 0;
    for (const coin of COINS) {
        for (const tf of TIMEFRAMES) {
            try {
                grandTotal += await syncPair(coin, tf);
            } catch (err) {
                console.error(`${TAG} Unexpected error on ${coin} ${tf}: ${err.message}`);
            }
            await sleep(SLEEP_BETWEEN_MS);
        }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`${TAG} ✅ Done — ${grandTotal.toLocaleString()} candles in ${elapsed}s`);
    return grandTotal;
}

// ─────────────────────────────────────────────────────────────────
//  start — register cron. Call once from web/server.js
// ─────────────────────────────────────────────────────────────────
function start() {
    let nodeCron;
    try {
        nodeCron = require('node-cron');
    } catch (_) {
        console.warn(`${TAG} node-cron not installed. Run: npm i node-cron`);
        return;
    }

    // Daily at 00:05 UTC
    nodeCron.schedule('5 0 * * *', () => {
        runUpdate().catch(err =>
            console.error(`${TAG} Cron run failed: ${err.message}`)
        );
    }, { timezone: 'UTC' });

    console.log(`${TAG} ✅ Scheduled — daily 00:05 UTC`);
}

module.exports = { start, runUpdate, syncPair };
