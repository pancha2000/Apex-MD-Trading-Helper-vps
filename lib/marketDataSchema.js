'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD  ·  lib/marketDataSchema.js
 *  ──────────────────────────────────────────────────────────────
 *  Mongoose schema for the Local Data Lake.
 *  Stores historical Binance OHLCV candles for multiple coins
 *  and timeframes, optimised for time-series range queries.
 *
 *  Design decisions
 *  ────────────────
 *  • { timestamps: false }   → no createdAt/updatedAt overhead;
 *    `timestamp` IS the time field we care about.
 *  • { versionKey: false }   → removes __v from every document,
 *    saving ~20 bytes per candle (adds up at millions of docs).
 *  • Compound unique index   → prevents duplicate candles and
 *    drives lightning-fast range queries:
 *      db.marketdata.find({ coin:'BTCUSDT', timeframe:'1h',
 *                           timestamp:{ $gte: t0, $lte: t1 } })
 *  • All OHLCV fields are plain Number (not Decimal128) —
 *    sufficient precision for trading maths and far lighter on RAM.
 * ════════════════════════════════════════════════════════════════
 */

const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────
//  SCHEMA DEFINITION
// ─────────────────────────────────────────────────────────────────
const MarketDataSchema = new mongoose.Schema(
    {
        // ── Identity ─────────────────────────────────────────────
        coin: {
            type:     String,
            required: true,
            uppercase: true,
            trim:     true,
            // e.g. 'BTCUSDT'
        },
        timeframe: {
            type:     String,
            required: true,
            enum:     ['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M'],
            // e.g. '15m', '1h', '4h'
        },

        // ── Time ─────────────────────────────────────────────────
        timestamp: {
            type:     Date,
            required: true,
            // Candle OPEN time, stored as a proper Date object.
            // Indexed as part of the compound unique key below.
        },

        // ── OHLCV ────────────────────────────────────────────────
        open:   { type: Number, required: true },
        high:   { type: Number, required: true },
        low:    { type: Number, required: true },
        close:  { type: Number, required: true },
        volume: { type: Number, required: true },
    },
    {
        // Collection name is explicit — no accidental pluralisation.
        collection:  'marketdata',
        timestamps:  false,   // we have our own `timestamp` field
        versionKey:  false,   // removes __v — saves RAM at scale
    }
);

// ─────────────────────────────────────────────────────────────────
//  INDEXES
// ─────────────────────────────────────────────────────────────────

/**
 * PRIMARY: Compound unique index.
 *
 * Serves three purposes simultaneously:
 *   1. Uniqueness — bulkWrite upserts will never create duplicates.
 *   2. Range-query speed — all time-series lookups hit this index.
 *   3. Sort efficiency — MongoDB uses the index to avoid in-memory sorts.
 *
 * Field order matters for compound indexes:
 *   coin first   → filter by symbol → small working set
 *   timeframe    → filter to one TF  → even smaller
 *   timestamp    → scan the range   → fully covered
 */
MarketDataSchema.index(
    { coin: 1, timeframe: 1, timestamp: 1 },
    { unique: true, name: 'coin_tf_ts_unique' }
);

/**
 * SECONDARY: Descending timestamp per coin+TF.
 *
 * Optimises the most common live-trading query:
 *   "give me the last N candles for BTCUSDT 15m"
 * which sorts by timestamp DESC.  Without this index MongoDB would
 * do a forward index scan + reverse; with it, it's instant.
 */
MarketDataSchema.index(
    { coin: 1, timeframe: 1, timestamp: -1 },
    { name: 'coin_tf_ts_desc' }
);

// ─────────────────────────────────────────────────────────────────
//  STATIC HELPER — getLatestTimestamp
// ─────────────────────────────────────────────────────────────────
/**
 * Returns the openTime (ms) of the newest stored candle for a
 * given coin+timeframe, or null if the collection is empty for
 * that pair.  Used by dataCollector.js to resume interrupted runs.
 *
 * @param {string} coin       e.g. 'BTCUSDT'
 * @param {string} timeframe  e.g. '15m'
 * @returns {Promise<number|null>}
 */
MarketDataSchema.statics.getLatestTimestamp = async function (coin, timeframe) {
    const doc = await this.findOne(
        { coin, timeframe },
        { timestamp: 1, _id: 0 }
    ).sort({ timestamp: -1 }).lean();

    return doc ? doc.timestamp.getTime() : null;
};

// ─────────────────────────────────────────────────────────────────
//  MODEL EXPORT  (guard against OverwriteModelError on hot-reload)
// ─────────────────────────────────────────────────────────────────
const MarketData = mongoose.models.MarketData
    || mongoose.model('MarketData', MarketDataSchema);

module.exports = { MarketData, MarketDataSchema };
