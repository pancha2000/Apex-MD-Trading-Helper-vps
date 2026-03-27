'use strict';
/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD  ·  lib/dataLakeService.js
 *  ──────────────────────────────────────────────────────────────
 *  Drop-in replacement for binance.getKlineDataFromCache().
 *
 *  Priority chain:
 *    1. MongoDB Local Data Lake  (fast, historical data)
 *    2. binance.getKlineDataFromCache()  (live fallback)
 *
 *  Output format is IDENTICAL to Binance REST /api/v3/klines:
 *    [ openTime, "open", "high", "low", "close", "volume",
 *      closeTime, "0", 0, "0", "0", "0" ]
 *
 *  Indicators index candle[0]…candle[5] — zero change required.
 *
 *  Also exposes getBTCMacroContext() for BTC-backed macro direction
 *  that persists across all coin analyses in the same hour.
 * ════════════════════════════════════════════════════════════════
 */

const mongoose = require('mongoose');
const binance  = require('./binance');
const { MarketData } = require('./marketDataSchema');

const TF_MS = {
    '1m':  60_000,    '3m':  180_000,   '5m':  300_000,
    '15m': 900_000,   '30m': 1_800_000, '1h':  3_600_000,
    '2h':  7_200_000, '4h':  14_400_000,'6h':  21_600_000,
    '8h':  28_800_000,'12h': 43_200_000,'1d':  86_400_000,
};

const MIN_CANDLES = {
    '1m':  50, '3m': 50,  '5m':  50,
    '15m': 50, '30m': 30, '1h':  30,
    '2h':  30, '4h': 30,  '6h':  20,
    '8h':  20, '12h': 20, '1d':  20,
};

function isMongoConnected() {
    return mongoose.connection.readyState === 1;
}

function docToKline(doc, tfMs) {
    const openTime  = doc.timestamp instanceof Date
        ? doc.timestamp.getTime()
        : new Date(doc.timestamp).getTime();
    return [
        openTime,
        String(doc.open),
        String(doc.high),
        String(doc.low),
        String(doc.close),
        String(doc.volume),
        openTime + tfMs - 1,
        '0', 0, '0', '0', '0',
    ];
}

// ─────────────────────────────────────────────────────────────────
//  getKlinesFromLake — main data bridge
// ─────────────────────────────────────────────────────────────────
async function getKlinesFromLake(coin, timeframe, limit = 100) {
    const sym    = coin.toUpperCase();
    const tfMs   = TF_MS[timeframe] || 900_000;
    const minReq = MIN_CANDLES[timeframe] || 30;

    if (isMongoConnected()) {
        try {
            const fetchLimit = Math.ceil(limit * 1.2);
            const docs = await MarketData.find(
                { coin: sym, timeframe },
                { _id: 0, timestamp: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }
            ).sort({ timestamp: -1 }).limit(fetchLimit).lean();

            if (docs.length >= minReq) {
                docs.reverse();
                const sliced = docs.length > limit ? docs.slice(-limit) : docs;
                const klines = sliced.map(doc => docToKline(doc, tfMs));
                console.log(`[DataLake] ✅ ${sym} ${timeframe}: ${klines.length} candles from lake`);
                return klines;
            }
            console.warn(`[DataLake] ⚠ ${sym} ${timeframe}: ${docs.length}/${minReq} candles — Binance fallback`);
        } catch (dbErr) {
            console.error(`[DataLake] ❌ ${sym} ${timeframe}: ${dbErr.message} — Binance fallback`);
        }
    }

    return binance.getKlineDataFromCache(sym, timeframe, limit);
}

// ─────────────────────────────────────────────────────────────────
//  getBTCMacroContext — cached BTC trend from lake (1h TTL)
//  Used by analyzer to give every coin analysis consistent BTC context
//  without re-fetching BTC candles each time.
// ─────────────────────────────────────────────────────────────────
async function getBTCMacroContext() {
    try {
        const { getBTCMacro } = require('./btcMacroCache');
        return await getBTCMacro();
    } catch (_) {
        return { trend: 'NEUTRAL', strength: 50, ema1H: 0, ema4H: 0, reasons: [] };
    }
}

module.exports = { getKlinesFromLake, getBTCMacroContext };
