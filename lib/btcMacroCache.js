'use strict';
/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD  ·  lib/btcMacroCache.js
 *  ──────────────────────────────────────────────────────────────
 *  Caches BTC macro direction analysis in MongoDB.
 *
 *  Every coin analysis calls getBTCContext(btcCandles1H, btcCandles4H).
 *  Instead of re-computing on every call, we:
 *    1. Compute once from lake data
 *    2. Store result in MongoDB (TTL: 1 candle period = 1h)
 *    3. All subsequent analyses in the same hour read from cache
 *
 *  This means:
 *    - BTC macro direction used even when Binance is slow
 *    - Consistent BTC context across all coins in a scan batch
 *    - Historical BTC trend stored for backtest reference
 * ════════════════════════════════════════════════════════════════
 */

const mongoose = require('mongoose');

// ─── Schema ───────────────────────────────────────────────────────────────
const BtcMacroSchema = new mongoose.Schema({
    _id:        { type: String, default: 'btc_macro' },
    trend:      { type: String, enum: ['BULL','BEAR','NEUTRAL'], default: 'NEUTRAL' },
    strength:   { type: Number, default: 0 },     // 0–100
    ema1H:      { type: Number, default: 0 },
    ema4H:      { type: Number, default: 0 },
    price:      { type: Number, default: 0 },
    dominance:  { type: String, default: 'N/A' },
    reasons:    { type: [String], default: [] },
    updatedAt:  { type: Date, default: Date.now },
    expiresAt:  { type: Date, required: true },
}, { collection: 'btcmacro', versionKey: false, timestamps: false });

BtcMacroSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const BtcMacro = mongoose.models.BtcMacro
    || mongoose.model('BtcMacro', BtcMacroSchema);

// ─── Cache TTL = 1 hour (same as 1h candle period) ───────────────────────
const TTL_MS = 60 * 60 * 1000;

/**
 * getBTCMacro()
 *
 * Returns the cached BTC macro context, or computes it fresh from
 * the data lake if stale/missing.
 *
 * @returns {Promise<{ trend, strength, ema1H, ema4H, price, reasons }>}
 */
async function getBTCMacro() {
    if (mongoose.connection.readyState !== 1) return _neutralContext();

    try {
        // Try cache first
        const cached = await BtcMacro.findById('btc_macro').lean();
        if (cached && new Date(cached.expiresAt) > new Date()) {
            return {
                trend:     cached.trend,
                strength:  cached.strength,
                ema1H:     cached.ema1H,
                ema4H:     cached.ema4H,
                price:     cached.price,
                reasons:   cached.reasons,
                fromCache: true,
            };
        }
    } catch (_) {}

    // Cache miss — compute from lake
    return await _refreshBTCMacro();
}

/**
 * _refreshBTCMacro()
 *
 * Fetches BTC candles from lake → computes trend → saves to MongoDB.
 * Falls back to Binance live if lake is empty.
 */
async function _refreshBTCMacro() {
    try {
        const { getKlinesFromLake } = require('./dataLakeService');
        const indicators = require('./indicators');

        const [candles1H, candles4H] = await Promise.all([
            getKlinesFromLake('BTCUSDT', '1h',  60).catch(() => null),
            getKlinesFromLake('BTCUSDT', '4h',  60).catch(() => null),
        ]);

        if (!candles1H || candles1H.length < 10) return _neutralContext();

        // EMA 20 on 1H and 4H
        const ema1H  = candles1H.length >= 20
            ? parseFloat(indicators.calculateEMA(candles1H, 20))
            : parseFloat(candles1H[candles1H.length-1][4]);
        const ema4H  = candles4H?.length >= 20
            ? parseFloat(indicators.calculateEMA(candles4H, 20))
            : ema1H;

        const price   = parseFloat(candles1H[candles1H.length-1][4]);
        const reasons = [];
        let bullPts = 0, bearPts = 0;

        // ── 1H trend
        if (price > ema1H) { bullPts += 3; reasons.push('₿ 1H above EMA20'); }
        else                { bearPts += 3; reasons.push('₿ 1H below EMA20'); }

        // ── 4H trend
        if (candles4H?.length >= 20) {
            if (price > ema4H) { bullPts += 4; reasons.push('₿ 4H above EMA20'); }
            else                { bearPts += 4; reasons.push('₿ 4H below EMA20'); }
        }

        // ── Last 3 candle direction (momentum)
        if (candles1H.length >= 4) {
            const last3 = candles1H.slice(-4);
            const rising = last3.filter(c => parseFloat(c[4]) > parseFloat(c[1])).length;
            if (rising >= 3) { bullPts += 2; reasons.push('₿ 1H momentum up'); }
            else if (rising <= 1) { bearPts += 2; reasons.push('₿ 1H momentum down'); }
        }

        const total    = bullPts + bearPts;
        const strength = total > 0 ? Math.round((Math.max(bullPts, bearPts) / total) * 100) : 50;
        const trend    = bullPts > bearPts ? 'BULL' : bearPts > bullPts ? 'BEAR' : 'NEUTRAL';

        const ctx = { trend, strength, ema1H, ema4H, price, reasons };

        // Save to MongoDB
        try {
            await BtcMacro.findByIdAndUpdate('btc_macro', {
                $set: {
                    ...ctx,
                    updatedAt: new Date(),
                    expiresAt: new Date(Date.now() + TTL_MS),
                },
            }, { upsert: true });
        } catch (_) {}

        return { ...ctx, fromCache: false };

    } catch (err) {
        console.warn('[BtcMacroCache] Refresh failed:', err.message);
        return _neutralContext();
    }
}

function _neutralContext() {
    return { trend: 'NEUTRAL', strength: 50, ema1H: 0, ema4H: 0, price: 0, reasons: [], fromCache: false };
}

module.exports = { getBTCMacro, BtcMacro };
