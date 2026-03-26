'use strict';
/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD  ·  lib/ohlcv-cache.js
 *  ──────────────────────────────────────────────────────────────
 *  MongoDB-backed OHLCV cache — reduces Binance API calls ~80%.
 *  Each coin+timeframe+limit combo is cached for exactly one
 *  candle period (TTL = timeframe duration).
 *  After TTL expires MongoDB auto-removes via TTL index.
 * ════════════════════════════════════════════════════════════════
 */

const mongoose = require('mongoose');

// ─── TTL per timeframe (1× candle duration) ───────────────────
const TTL_MS = {
    '1m':  60      * 1000,
    '3m':  3  * 60 * 1000,
    '5m':  5  * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h':  60 * 60 * 1000,
    '2h':  2  * 60 * 60 * 1000,
    '4h':  4  * 60 * 60 * 1000,
    '1d':  24 * 60 * 60 * 1000,
};

// ─── Schema ───────────────────────────────────────────────────
const OHLCVCacheSchema = new mongoose.Schema({
    _id:       String,                                          // "BTCUSDT_15m_200"
    coin:      { type: String, required: true, index: true },
    timeframe: { type: String, required: true },
    limit:     { type: Number, required: true },
    candles:   { type: mongoose.Schema.Types.Mixed, required: true },
    cachedAt:  { type: Date,   default: Date.now },
    expiresAt: { type: Date,   required: true },
});

// TTL index — MongoDB auto-deletes expired documents (runs every 60s)
OHLCVCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
OHLCVCacheSchema.index({ coin: 1, timeframe: 1 });

const OHLCVCache = mongoose.models.OHLCVCache
    || mongoose.model('OHLCVCache', OHLCVCacheSchema);

// ─── In-memory hit/miss counters ─────────────────────────────
let _hits = 0, _misses = 0;

// ─── getCached ───────────────────────────────────────────────
/**
 * Returns cached candle array if fresh, null if stale/missing.
 * @param {string} coin       e.g. 'BTCUSDT'
 * @param {string} timeframe  e.g. '15m'
 * @param {number} limit      e.g. 200
 * @returns {Array|null}
 */
async function getCached(coin, timeframe, limit) {
    try {
        const id  = `${coin}_${timeframe}_${limit}`;
        const doc = await OHLCVCache.findById(id).lean();
        if (!doc) { _misses++; return null; }

        const ttl = TTL_MS[timeframe] || 60_000;
        const age = Date.now() - new Date(doc.cachedAt).getTime();
        if (age > ttl) { _misses++; return null; }   // stale

        _hits++;
        return doc.candles;
    } catch (_e) {
        _misses++;
        return null;   // never crash — cache is best-effort
    }
}

// ─── setCache ────────────────────────────────────────────────
/**
 * Upserts candle array into cache with TTL = 3× candle period
 * (keep longer so fallback is possible when Binance is slow).
 */
async function setCache(coin, timeframe, limit, candles) {
    try {
        const id        = `${coin}_${timeframe}_${limit}`;
        const ttl       = TTL_MS[timeframe] || 60_000;
        const expiresAt = new Date(Date.now() + ttl * 3);   // keep 3× TTL

        await OHLCVCache.findByIdAndUpdate(
            id,
            { _id: id, coin, timeframe, limit, candles, cachedAt: new Date(), expiresAt },
            { upsert: true }
        );
    } catch (_e) {
        // Silent — cache write failure must never abort a signal
    }
}

// ─── getCacheStats ───────────────────────────────────────────
async function getCacheStats() {
    try {
        const total  = await OHLCVCache.countDocuments();
        const coins  = await OHLCVCache.distinct('coin');
        const ratio  = (_hits + _misses) > 0
            ? ((_hits / (_hits + _misses)) * 100).toFixed(1)
            : '0.0';
        return {
            totalEntries:  total,
            uniqueCoins:   coins.length,
            hitRate:       `${ratio}%`,
            hits:          _hits,
            misses:        _misses,
        };
    } catch (_e) {
        return { totalEntries: 0, uniqueCoins: 0, hitRate: '0%', hits: 0, misses: 0 };
    }
}

// ─── clearCache ──────────────────────────────────────────────
async function clearCache() {
    try {
        const r = await OHLCVCache.deleteMany({});
        _hits = 0; _misses = 0;
        return r.deletedCount;
    } catch (_e) { return 0; }
}

module.exports = { getCached, setCache, getCacheStats, clearCache };
