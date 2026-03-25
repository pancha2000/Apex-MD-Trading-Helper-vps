'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ApexIQ  ·  lib/riskGates.js  ·  Capital Preservation Gates
 * ─────────────────────────────────────────────────────────────────────────
 *  Every triggered signal passes through this middleware pipeline BEFORE
 *  it is sent to the user. If ANY gate blocks the signal, dispatch is
 *  cancelled and a reason is logged.
 *
 *  Gate 1 — CORRELATION BLOCK
 *  ───────────────────────────
 *  BTC is the market's gravitational centre. When BTC is dumping hard, no
 *  altcoin LONG signal survives regardless of its own technicals — they
 *  all bleed in correlation. This gate runs a real-time 4H + 1H momentum
 *  check on BTC and blocks any LONG signal for alts when BTC is in
 *  "Aggressive Bear" mode.
 *
 *  Scoring (matches getBTCContext logic in indicators.js):
 *    btcScore ≤ -2  → Aggressive Bear → block ALL alt LONGs
 *    btcScore == -1 → Weak Bear       → warn but allow (reduced confidence)
 *    btcScore ≥  0  → Safe            → pass
 *
 *  Gate 2 — MAX DAILY LOSS (Cooldown Mode)
 *  ────────────────────────────────────────
 *  Revenge trading after a losing streak is the #1 account killer.
 *  We track each user's total paper PnL for the current UTC day.
 *  If their realised loss exceeds the threshold:
 *    → Set SaasUser.cooldownUntil = start of next UTC day
 *    → All signals for that user are suppressed until then
 *
 *  Gate 3 — MINIMUM SCORE FLOOR
 *  ─────────────────────────────
 *  Block signals that score below the user's personal threshold.
 *
 *  Usage in scanner/signalDispatch.js:
 *  ────────────────────────────────────
 *    const gates = require('./riskGates');
 *
 *    const check = await gates.runAllGates(setup, user, { binance, db });
 *    if (!check.passed) {
 *        console.log(`[Gates] Signal blocked: ${check.reason}`);
 *        return;
 *    }
 *    // proceed to dispatch
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { getBTCContext } = require('./indicators');

// ─────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────

// BTC score at or below this threshold → aggressive dump → block alt LONGs
const BTC_DUMP_THRESHOLD        = -2;

// BTC score that triggers a warning but does not fully block
const BTC_WEAK_BEAR_THRESHOLD   = -1;

// Default max daily loss % before cooldown triggers (user-configurable)
const DEFAULT_MAX_DAILY_LOSS_PCT = -5;

// Number of most recent closed paper trades to look back for daily PnL
// (we use time-based filtering, but cap at this many records for performance)
const DAILY_PNL_LOOKBACK_LIMIT  = 200;

// TTL for BTC context cache (avoid hammering Binance on every signal)
const BTC_CACHE_TTL_MS          = 60_000;  // 1 minute

// ─────────────────────────────────────────────────────────────────────────
//  MODULE-LEVEL CACHE  (BTC context)
// ─────────────────────────────────────────────────────────────────────────

let _btcContextCache = {
    data:       null,
    fetchedAt:  0,
    inflight:   null,   // promise guard to prevent thundering herd
};

/**
 * Fetch (and cache) the current BTC market context.
 * Uses getBTCContext() from indicators.js which checks 4H + 1H EMA + RSI.
 *
 * @param {object} binance  — lib/binance.js module
 * @returns {Promise<object>}  { trend, score, rsi1H, bull4H, bull1H, display }
 */
async function getBTCContextCached(binance) {
    const now = Date.now();

    // Return cached value if still fresh
    if (_btcContextCache.data && (now - _btcContextCache.fetchedAt) < BTC_CACHE_TTL_MS) {
        return _btcContextCache.data;
    }

    // If another call is already fetching, piggyback on it (prevent duplicate requests)
    if (_btcContextCache.inflight) {
        return _btcContextCache.inflight;
    }

    _btcContextCache.inflight = (async () => {
        try {
            const [candles1H, candles4H] = await Promise.all([
                binance.getKlineData('BTCUSDT', '1h', 60),
                binance.getKlineData('BTCUSDT', '4h', 60),
            ]);
            const ctx = await getBTCContext(candles1H, candles4H);
            _btcContextCache.data      = ctx;
            _btcContextCache.fetchedAt = Date.now();
            return ctx;
        } catch (err) {
            // If BTC fetch fails, return a safe NEUTRAL context
            // (don't block signals due to network failures)
            console.warn('[riskGates] BTC context fetch failed, using NEUTRAL fallback:', err.message);
            return { trend: 'NEUTRAL', score: 0, display: '⚪ BTC N/A (fetch failed)' };
        } finally {
            _btcContextCache.inflight = null;
        }
    })();

    return _btcContextCache.inflight;
}

// ─────────────────────────────────────────────────────────────────────────
//  GATE 1: CORRELATION BLOCK
// ─────────────────────────────────────────────────────────────────────────

/**
 * checkCorrelationGate
 *
 * @param {object} setup    — signal setup { coin, direction, score, … }
 * @param {object} binance  — lib/binance.js
 * @returns {Promise<GateResult>}
 */
async function checkCorrelationGate(setup, binance) {
    // BTC itself is never blocked by its own correlation
    if (setup.coin === 'BTCUSDT' || setup.coin === 'BTC') {
        return { passed: true, gate: 'correlation' };
    }

    // Only LONG signals are at risk from BTC dumps
    if (setup.direction !== 'LONG') {
        return { passed: true, gate: 'correlation' };
    }

    const btcCtx = await getBTCContextCached(binance);

    // AGGRESSIVE BEAR  → hard block
    if (btcCtx.score <= BTC_DUMP_THRESHOLD) {
        return {
            passed:  false,
            gate:    'correlation',
            reason:  `BTC Correlation Block 🚫 — ${btcCtx.display} (score: ${btcCtx.score}). ` +
                     `Alt LONG signals suppressed during BTC aggressive dump.`,
            btcCtx,
        };
    }

    // WEAK BEAR  → allow but attach a warning to the signal
    if (btcCtx.score === BTC_WEAK_BEAR_THRESHOLD) {
        return {
            passed:   true,
            gate:     'correlation',
            warning:  `⚠️ BTC showing weak bearish momentum (${btcCtx.display}). ` +
                      `Trade with reduced size or wait for BTC confirmation.`,
            btcCtx,
        };
    }

    return { passed: true, gate: 'correlation', btcCtx };
}

// ─────────────────────────────────────────────────────────────────────────
//  GATE 2: MAXIMUM DAILY LOSS  (Cooldown Mode)
// ─────────────────────────────────────────────────────────────────────────

/**
 * getDailyPaperPnL
 *
 * Calculates the sum of all closed paper trade pnlPct values for the
 * current UTC day for a given user.
 *
 * @param {string}   userId   — SaasUser._id
 * @param {object}   db       — lib/database.js
 * @returns {Promise<number>} totalPnlPct (e.g. -7.3)
 */
async function getDailyPaperPnL(userId, db) {
    // Start of current UTC day
    const now        = new Date();
    const todayStart = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate()
    ));

    let trades;
    try {
        if (typeof db.getDailyPaperPnL === 'function') {
            return await db.getDailyPaperPnL(userId);
        }
        // Direct model query via exported Trade model
        const TradeModel = db.Trade;
        if (TradeModel) {
            trades = await TradeModel
                .find({ userId, isPaper: true, status: 'closed', closedAt: { $gte: todayStart } })
                .limit(DAILY_PNL_LOOKBACK_LIMIT).select('pnlPct').lean();
        } else {
            return 0;  // safe fallback
        }
    } catch (err) {
        console.warn('[riskGates] Daily PnL query failed:', err.message);
        return 0;
    }

    return trades.reduce((sum, t) => sum + (t.pnlPct || 0), 0);
}

/**
 * getNextUTCMidnight
 * Returns a Date object set to 00:00:00 UTC tomorrow.
 */
function getNextUTCMidnight() {
    const now = new Date();
    return new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1  // tomorrow
    ));
}

/**
 * checkDailyLossGate
 *
 * @param {object} user    — SaasUser document (from db.getSaasUserById)
 * @param {object} db      — lib/database.js
 * @returns {Promise<GateResult>}
 */
async function checkDailyLossGate(user, db) {
    if (!user) return { passed: true, gate: 'daily_loss' };

    // ── 1. Check if already in cooldown ───────────────────────────────────
    if (user.cooldownUntil && new Date() < new Date(user.cooldownUntil)) {
        const resumeTime = new Date(user.cooldownUntil).toUTCString();
        return {
            passed: false,
            gate:   'daily_loss',
            reason: `🧊 Cooldown Mode Active. You exceeded your daily loss limit. ` +
                    `Signals resume at ${resumeTime}. ` +
                    `Take a break — revenge trading costs more than a bad day.`,
        };
    }

    // ── 2. Calculate today's realised PnL ─────────────────────────────────
    const userId         = user._id || user.id;
    const maxLossPct     = user.maxDailyLossPct ?? DEFAULT_MAX_DAILY_LOSS_PCT;  // e.g. -5
    const dailyPnl       = await getDailyPaperPnL(userId, db);

    // PnL is stored as a percentage (e.g. -7.3 means -7.3%)
    const threshold = -Math.abs(maxLossPct);  // ensure it's negative

    if (dailyPnl <= threshold) {
        // ── 3. Trigger cooldown ────────────────────────────────────────────
        const cooldownUntil = getNextUTCMidnight();

        // Persist cooldown to DB
        try {
            if (typeof db.updateSaasUser === 'function') {
                await db.updateSaasUser(userId, { cooldownUntil });
            } else if (db.SaasUser) {
                await db.SaasUser.findByIdAndUpdate(userId, { $set: { cooldownUntil } });
            } else {
                // Fallback: try mongoose directly
                const mongoose = require('mongoose');
                const SaasUser = mongoose.models.SaasUser;
                if (SaasUser) await SaasUser.findByIdAndUpdate(userId, { $set: { cooldownUntil } });
            }
        } catch (err) {
            console.warn('[riskGates] Failed to persist cooldown:', err.message);
        }

        const resumeTime = cooldownUntil.toUTCString();
        return {
            passed:      false,
            gate:        'daily_loss',
            reason:      `🚨 Max Daily Loss Gate Triggered — Daily PnL: ${dailyPnl.toFixed(2)}% ` +
                         `(limit: ${threshold}%). Cooldown active until ${resumeTime}. ` +
                         `All signals paused to prevent revenge trading.`,
            dailyPnl,
            threshold,
            cooldownUntil,
        };
    }

    // ── 4. Pass — attach current daily PnL as info ────────────────────────
    return {
        passed:   true,
        gate:     'daily_loss',
        dailyPnl,
        threshold,
        // Soft warning when getting close (> 70% of limit)
        warning:  dailyPnl < threshold * 0.70
            ? `⚠️ Daily PnL at ${dailyPnl.toFixed(2)}%. Approaching daily loss limit (${threshold}%). Consider reducing position size.`
            : null,
    };
}

// ─────────────────────────────────────────────────────────────────────────
//  GATE 3: MINIMUM SCORE FLOOR
// ─────────────────────────────────────────────────────────────────────────

/**
 * checkScoreGate
 *
 * @param {object} setup  — { score: number }
 * @param {object} user   — SaasUser (has minScoreThreshold)
 * @returns {GateResult}
 */
function checkScoreGate(setup, user) {
    const minScore = user?.minScoreThreshold ?? 20;
    if ((setup.score || 0) < minScore) {
        return {
            passed: false,
            gate:   'min_score',
            reason: `Score ${setup.score} below user threshold ${minScore}. Signal discarded.`,
        };
    }
    return { passed: true, gate: 'min_score' };
}

// ─────────────────────────────────────────────────────────────────────────
//  MASTER PIPELINE — runAllGates()
// ─────────────────────────────────────────────────────────────────────────

/**
 * runAllGates
 *
 * Run the complete risk gate pipeline for a signal before dispatch.
 * Gates run in order: score → correlation → daily_loss.
 * First failure short-circuits (remaining gates not evaluated).
 *
 * @param {object} setup   — signal setup object from analyzer
 *   @param {string}  setup.coin       — e.g. 'SOLUSDT'
 *   @param {string}  setup.direction  — 'LONG' | 'SHORT'
 *   @param {number}  setup.score      — signal quality score
 * @param {object} user    — SaasUser document
 * @param {object} deps
 *   @param {object} deps.binance  — lib/binance.js
 *   @param {object} deps.db       — lib/database.js
 *
 * @returns {Promise<PipelineResult>}
 *   {
 *     passed:   boolean,
 *     reason?:  string,          // set when passed=false
 *     warnings: string[],        // non-blocking notices
 *     gates:    GateResult[],    // all gate results
 *     btcCtx?:  object,          // BTC context for use in signal message
 *   }
 */
async function runAllGates(setup, user, { binance, db }) {
    const warnings = [];
    const gateLog  = [];

    // ── Gate 1: Score Floor ────────────────────────────────────────────────
    const scoreResult = checkScoreGate(setup, user);
    gateLog.push(scoreResult);
    if (!scoreResult.passed) {
        return { passed: false, reason: scoreResult.reason, warnings, gates: gateLog };
    }

    // ── Gate 2: Daily Loss / Cooldown ──────────────────────────────────────
    const lossResult = await checkDailyLossGate(user, db);
    gateLog.push(lossResult);
    if (!lossResult.passed) {
        return { passed: false, reason: lossResult.reason, warnings, gates: gateLog };
    }
    if (lossResult.warning) warnings.push(lossResult.warning);

    // ── Gate 3: BTC Correlation ────────────────────────────────────────────
    const corrResult = await checkCorrelationGate(setup, binance);
    gateLog.push(corrResult);
    if (!corrResult.passed) {
        return { passed: false, reason: corrResult.reason, warnings, gates: gateLog, btcCtx: corrResult.btcCtx };
    }
    if (corrResult.warning) warnings.push(corrResult.warning);

    return {
        passed:   true,
        warnings,
        gates:    gateLog,
        btcCtx:   corrResult.btcCtx,
        dailyPnl: lossResult.dailyPnl,
    };
}

// ─────────────────────────────────────────────────────────────────────────
//  DB SCHEMA PATCH — add cooldown fields to SaasUserSchema
//  Call patchUserSchemaForCooldown(SaasUserSchema) in database.js
//  BEFORE the model is compiled.
// ─────────────────────────────────────────────────────────────────────────

function patchUserSchemaForCooldown(SaasUserSchema) {
    SaasUserSchema.add({
        // Null = not in cooldown.  Date = blocked until this moment.
        cooldownUntil: { type: Date,   default: null },
        // User-configurable max daily loss %.  Default: -5%
        maxDailyLossPct: { type: Number, default: Math.abs(DEFAULT_MAX_DAILY_LOSS_PCT) },
    });
}

// ─────────────────────────────────────────────────────────────────────────
//  CACHE CONTROL (useful for tests / after strategy changes)
// ─────────────────────────────────────────────────────────────────────────

function clearBTCCache() {
    _btcContextCache = { data: null, fetchedAt: 0, inflight: null };
}

// ─────────────────────────────────────────────────────────────────────────

module.exports = {
    runAllGates,
    _getDailyPaperPnL: getDailyPaperPnL,
    checkCorrelationGate,
    checkDailyLossGate,
    checkScoreGate,
    getBTCContextCached,
    patchUserSchemaForCooldown,
    clearBTCCache,
    // Constants (exposed for testing & dashboard display)
    BTC_DUMP_THRESHOLD,
    BTC_WEAK_BEAR_THRESHOLD,
    DEFAULT_MAX_DAILY_LOSS_PCT,
};

/**
 * @typedef {object} GateResult
 * @property {boolean}  passed
 * @property {string}   gate       — gate identifier
 * @property {string}   [reason]   — human-readable block reason
 * @property {string}   [warning]  — non-blocking advisory
 *
 * @typedef {object} PipelineResult
 * @property {boolean}    passed
 * @property {string}     [reason]
 * @property {string[]}   warnings
 * @property {GateResult[]} gates
 * @property {object}     [btcCtx]
 * @property {number}     [dailyPnl]
 */
    