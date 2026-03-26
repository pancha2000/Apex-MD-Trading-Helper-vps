'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD  ·  lib/dataLakeService.js
 *  ──────────────────────────────────────────────────────────────
 *  Drop-in replacement for binance.getKlineDataFromCache().
 *
 *  Priority chain:
 *    1. MongoDB Local Data Lake  (fast, no API quota used)
 *    2. binance.getKlineDataFromCache()  (live fallback)
 *
 *  Output format is IDENTICAL to Binance REST /api/v3/klines:
 *    [ openTime, "open", "high", "low", "close", "volume",
 *      closeTime, "0", 0, "0", "0", "0" ]
 *
 *  This means analyzer.js indicators NEVER need to change —
 *  they index candle[0]…candle[5] exactly as before.
 * ════════════════════════════════════════════════════════════════
 */

const mongoose = require('mongoose');
const binance  = require('./binance');
const { MarketData } = require('./marketDataSchema');

// ─── Timeframe → milliseconds (for closeTime calculation) ────────
const TF_MS = {
    '1m':  60_000,       '3m':  180_000,     '5m':  300_000,
    '15m': 900_000,      '30m': 1_800_000,   '1h':  3_600_000,
    '2h':  7_200_000,    '4h':  14_400_000,  '6h':  21_600_000,
    '8h':  28_800_000,   '12h': 43_200_000,  '1d':  86_400_000,
};

/**
 * Minimum candle count before we trust the lake over live data.
 * Set conservatively — if lake has fewer than this we fall back.
 * (4H needs at least 30 for reliable SMC/OB detection)
 */
const MIN_CANDLES = {
    '1m':  50,   '3m':  50,   '5m':  50,
    '15m': 50,   '30m': 30,   '1h':  30,
    '2h':  30,   '4h':  30,   '6h':  20,
    '8h':  20,   '12h': 20,   '1d':  20,
};

// ─────────────────────────────────────────────────────────────────
//  CORE — map one MongoDB document → Binance kline array row
//
//  Binance REST format (12 elements):
//    [0]  openTime            number  (epoch ms)
//    [1]  open                string
//    [2]  high                string
//    [3]  low                 string
//    [4]  close               string
//    [5]  volume              string
//    [6]  closeTime           number  (epoch ms)
//    [7]  quoteAssetVolume    string  ("0" — not stored)
//    [8]  numberOfTrades      number  (0  — not stored)
//    [9]  takerBuyBaseVol     string  ("0" — not stored)
//    [10] takerBuyQuoteVol    string  ("0" — not stored)
//    [11] ignore              string  ("0")
//
//  Indicators only ever touch [0]–[5], so [6]–[11] being zeroed
//  is completely safe for all existing analysis logic.
// ─────────────────────────────────────────────────────────────────
function docToKline(doc, tfMs) {
    const openTime  = doc.timestamp instanceof Date
        ? doc.timestamp.getTime()
        : new Date(doc.timestamp).getTime();
    const closeTime = openTime + tfMs - 1;

    return [
        openTime,               // [0] openTime
        String(doc.open),       // [1] open
        String(doc.high),       // [2] high
        String(doc.low),        // [3] low
        String(doc.close),      // [4] close
        String(doc.volume),     // [5] volume
        closeTime,              // [6] closeTime
        '0',                    // [7] quoteAssetVolume
        0,                      // [8] numberOfTrades
        '0',                    // [9] takerBuyBaseVol
        '0',                    // [10] takerBuyQuoteVol
        '0',                    // [11] ignore
    ];
}

// ─────────────────────────────────────────────────────────────────
//  isMongoConnected — safe guard so we never crash if DB is down
// ─────────────────────────────────────────────────────────────────
function isMongoConnected() {
    return mongoose.connection.readyState === 1;   // 1 = connected
}

// ─────────────────────────────────────────────────────────────────
//  getKlinesFromLake  — DROP-IN for binance.getKlineDataFromCache
//
//  @param {string}  coin       e.g. 'BTCUSDT'
//  @param {string}  timeframe  e.g. '15m'
//  @param {number}  limit      e.g. 500
//  @returns {Promise<Array[]>} Binance-format kline arrays
// ─────────────────────────────────────────────────────────────────
async function getKlinesFromLake(coin, timeframe, limit = 100) {
    const sym    = coin.toUpperCase();
    const tfMs   = TF_MS[timeframe] || 900_000;
    const minReq = MIN_CANDLES[timeframe] || 30;

    // ── Step 1: Try MongoDB ────────────────────────────────────
    if (isMongoConnected()) {
        try {
            /*
             * Query strategy:
             *   - Sort DESC by timestamp → get the NEWEST candles first
             *   - Limit to what we need (with 20% headroom for safety)
             *   - Reverse → restore chronological order for indicators
             *
             * We use lean() for minimal memory overhead (plain JS objects,
             * no Mongoose overhead — critical on 1 GB RAM VPS).
             */
            const fetchLimit = Math.ceil(limit * 1.2);   // 20% headroom

            const docs = await MarketData.find(
                { coin: sym, timeframe },
                { _id: 0, timestamp: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }
            )
            .sort({ timestamp: -1 })
            .limit(fetchLimit)
            .lean();

            // If lake has enough candles → use it
            if (docs.length >= minReq) {
                // Reverse → chronological order (oldest first, like Binance)
                docs.reverse();

                // Slice to exact limit from newest end
                const sliced = docs.length > limit ? docs.slice(-limit) : docs;

                // Map each MongoDB doc → Binance kline array
                const klines = sliced.map(doc => docToKline(doc, tfMs));

                console.log(
                    `[DataLake] ✅ ${sym} ${timeframe}: ` +
                    `${klines.length} candles from MongoDB lake`
                );
                return klines;
            }

            // Not enough candles in lake — log and fall through
            console.warn(
                `[DataLake] ⚠ ${sym} ${timeframe}: ` +
                `lake has ${docs.length} candles (need ${minReq}) — ` +
                `falling back to Binance live`
            );

        } catch (dbErr) {
            // DB error must never crash the analyser
            console.error(
                `[DataLake] ❌ MongoDB query failed for ${sym} ${timeframe}: ` +
                `${dbErr.message} — falling back to Binance live`
            );
        }
    } else {
        console.warn(`[DataLake] MongoDB not connected — using Binance live for ${sym} ${timeframe}`);
    }

    // ── Step 2: Fallback → Binance live ───────────────────────
    // Identical to what analyzer.js did before — zero behaviour change
    return binance.getKlineDataFromCache(sym, timeframe, limit);
}

// ─────────────────────────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────────────────────────
module.exports = { getKlinesFromLake };
