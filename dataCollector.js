'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD  ·  dataCollector.js
 *  ──────────────────────────────────────────────────────────────
 *  Local Data Lake Builder — Standalone Historical Downloader
 *
 *  Downloads years of Binance OHLCV kline data and stores it in
 *  MongoDB using RAM-safe bulkWrite upserts.
 *
 *  Usage:
 *    node dataCollector.js                    # full run
 *    node dataCollector.js --coin BTCUSDT     # single coin
 *    node dataCollector.js --tf 1h            # single timeframe
 *    node dataCollector.js --resume           # skip already-full pairs
 *
 *  Environment:
 *    MONGODB=mongodb://127.0.0.1:27017/APEX_V4   (required)
 *
 *  Design choices for 1 GB RAM VPS
 *  ────────────────────────────────
 *  • Processes one coin+timeframe at a time (no parallel fetches).
 *  • Each HTTP page = max 1 000 candles from Binance.
 *  • Each page is bulkWritten and then immediately GC'd — the array
 *    is never accumulated in memory across pages.
 *  • 2-second sleep between every API call.
 *  • 3 automatic retries with exponential back-off on network errors.
 *  • mongoose bufferCommands:false prevents silent queue blow-up.
 * ════════════════════════════════════════════════════════════════
 */

// ─── bootstrap ────────────────────────────────────────────────────
require('dotenv').config({ path: __dirname + '/config.env' });

const mongoose = require('mongoose');
const axios    = require('axios');
const { MarketData } = require('./lib/marketDataSchema');

// ─────────────────────────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────────────────────────

/** Binance REST base URL — use testnet if you want to dry-run */
const BINANCE_BASE = 'https://api.binance.com';

/** Max candles per Binance request (hard limit is 1 000) */
const PAGE_SIZE = 1000;

/** Milliseconds to sleep between every API call */
const SLEEP_MS = 2000;

/** Max retries on transient network/5xx errors */
const MAX_RETRIES = 3;

/** axios timeout per request in ms */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * COIN LIST
 * ─────────
 * Each entry defines the coin symbol and the earliest date we want.
 * BTC goes back to 2017 (Binance launch era).
 * Everything else starts 2021 — a practical balance between
 * coverage and disk usage on a VPS.
 *
 * Add or remove coins freely; the downloader will skip pairs that
 * are already fully synced when --resume is passed.
 */
const COINS = [
    { symbol: 'BTCUSDT',  startDate: '2017-01-01' },
    { symbol: 'ETHUSDT',  startDate: '2021-01-01' },
    { symbol: 'BNBUSDT',  startDate: '2021-01-01' },
    { symbol: 'SOLUSDT',  startDate: '2021-01-01' },
    { symbol: 'XRPUSDT',  startDate: '2021-01-01' },
    { symbol: 'ADAUSDT',  startDate: '2021-01-01' },
    { symbol: 'DOGEUSDT', startDate: '2021-01-01' },
    { symbol: 'AVAXUSDT', startDate: '2021-01-01' },
    { symbol: 'DOTUSDT',  startDate: '2021-01-01' },
    { symbol: 'LINKUSDT', startDate: '2021-01-01' },
];

/** Timeframes to download for every coin */
const TIMEFRAMES = ['15m', '1h', '4h'];

/** Timeframe string → milliseconds per candle */
const TF_MS = {
    '1m':  60_000,
    '3m':  180_000,
    '5m':  300_000,
    '15m': 900_000,
    '30m': 1_800_000,
    '1h':  3_600_000,
    '2h':  7_200_000,
    '4h':  14_400_000,
    '6h':  21_600_000,
    '8h':  28_800_000,
    '12h': 43_200_000,
    '1d':  86_400_000,
};

// ─────────────────────────────────────────────────────────────────
//  BEAUTIFUL LOGGER
// ─────────────────────────────────────────────────────────────────

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const GREEN  = '\x1b[32m';
const CYAN   = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const MAGENTA= '\x1b[35m';
const BLUE   = '\x1b[34m';

function now() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

const log = {
    info:    (msg) => console.log(`${DIM}[${now()}]${RESET} ${CYAN}ℹ${RESET}  ${msg}`),
    success: (msg) => console.log(`${DIM}[${now()}]${RESET} ${GREEN}✔${RESET}  ${msg}`),
    warn:    (msg) => console.log(`${DIM}[${now()}]${RESET} ${YELLOW}⚠${RESET}  ${msg}`),
    error:   (msg) => console.log(`${DIM}[${now()}]${RESET} ${RED}✘${RESET}  ${msg}`),
    save:    (coin, tf, count, total) =>
        console.log(
            `${DIM}[${now()}]${RESET} ${GREEN}💾${RESET}  ` +
            `${BOLD}${CYAN}${coin}${RESET} ${MAGENTA}${tf}${RESET}` +
            ` — saved ${BOLD}${GREEN}${count.toLocaleString()}${RESET} candles` +
            ` ${DIM}(total ≈ ${total.toLocaleString()})${RESET}`
        ),
    page:    (coin, tf, from, pageNum) =>
        console.log(
            `${DIM}[${now()}]${RESET} ${BLUE}→${RESET}  ` +
            `${BOLD}${coin}${RESET} ${MAGENTA}${tf}${RESET}` +
            ` page ${BOLD}${pageNum}${RESET}` +
            ` ${DIM}from ${new Date(from).toISOString().substring(0,10)}${RESET}`
        ),
    pair:    (coin, tf, from) =>
        console.log(
            `\n${'═'.repeat(60)}\n` +
            `  ${BOLD}${CYAN}${coin}${RESET}  ${MAGENTA}${tf}${RESET}` +
            `  ${DIM}starting ${from}${RESET}\n` +
            `${'─'.repeat(60)}`
        ),
    banner:  () => {
        console.log(`
${CYAN}╔══════════════════════════════════════════════════════════╗
║         APEX-MD  ·  Local Data Lake Builder             ║
║         Binance Historical OHLCV Downloader             ║
╚══════════════════════════════════════════════════════════╝${RESET}
${DIM}  Coins     : ${COINS.length}
  Timeframes : ${TIMEFRAMES.join(', ')}
  Page size  : ${PAGE_SIZE.toLocaleString()} candles
  Sleep      : ${SLEEP_MS}ms between requests
${RESET}`);
    },
};

// ─────────────────────────────────────────────────────────────────
//  UTILITY — sleep
// ─────────────────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────
//  UTILITY — parse CLI args
// ─────────────────────────────────────────────────────────────────
function parseArgs() {
    const args   = process.argv.slice(2);
    const result = { coinFilter: null, tfFilter: null, resume: false };

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--coin' && args[i + 1]) result.coinFilter = args[++i].toUpperCase();
        if (args[i] === '--tf'   && args[i + 1]) result.tfFilter   = args[++i];
        if (args[i] === '--resume')               result.resume     = true;
    }
    return result;
}

// ─────────────────────────────────────────────────────────────────
//  CORE — fetch one page of klines from Binance with retries
// ─────────────────────────────────────────────────────────────────
/**
 * Fetches up to PAGE_SIZE candles starting at `startTime`.
 * Retries up to MAX_RETRIES times with exponential back-off.
 *
 * @param {string} symbol     e.g. 'BTCUSDT'
 * @param {string} interval   e.g. '15m'
 * @param {number} startTime  epoch ms
 * @param {number} endTime    epoch ms  (= now, acts as ceiling)
 * @returns {Promise<Array[]>}  raw Binance kline arrays
 */
async function fetchKlines(symbol, interval, startTime, endTime) {
    let lastErr;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const resp = await axios.get(`${BINANCE_BASE}/api/v3/klines`, {
                timeout: REQUEST_TIMEOUT_MS,
                params:  {
                    symbol,
                    interval,
                    startTime,
                    endTime,
                    limit: PAGE_SIZE,
                },
            });

            // Binance may return 200 with an error body on some edge cases
            if (!Array.isArray(resp.data)) {
                throw new Error(`Unexpected Binance response: ${JSON.stringify(resp.data)}`);
            }

            return resp.data;

        } catch (err) {
            lastErr = err;
            const isRateLimit = err?.response?.status === 429 || err?.response?.status === 418;
            const backoff     = isRateLimit ? 60_000 : Math.pow(2, attempt) * 1_000;

            if (isRateLimit) {
                log.warn(`Rate-limited by Binance. Waiting 60s before retry ${attempt}/${MAX_RETRIES}…`);
            } else {
                log.warn(
                    `Network error on attempt ${attempt}/${MAX_RETRIES} ` +
                    `(${err.code || err.message}). Retrying in ${backoff / 1000}s…`
                );
            }

            await sleep(backoff);
        }
    }

    // All retries exhausted — surface the error so the outer loop can decide
    throw lastErr;
}

// ─────────────────────────────────────────────────────────────────
//  CORE — bulkWrite one page into MongoDB
// ─────────────────────────────────────────────────────────────────
/**
 * Upserts an array of raw Binance kline arrays into MarketData.
 * Uses bulkWrite with upsert to be idempotent (safe to re-run).
 * The `rawPage` array is consumed and can be GC'd immediately after.
 *
 * @param {string}  coin
 * @param {string}  timeframe
 * @param {Array[]} rawPage   raw Binance kline arrays
 * @returns {Promise<number>} count of candles written/matched
 */
async function savePage(coin, timeframe, rawPage) {
    if (!rawPage.length) return 0;

    const ops = rawPage.map(k => ({
        updateOne: {
            filter: {
                coin,
                timeframe,
                timestamp: new Date(k[0]),   // k[0] = open time ms
            },
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

    /*
     * ordered: false  →  MongoDB continues past individual write errors
     *                    (e.g. a rare duplicate key race). We log but
     *                    do not abort the whole run.
     */
    const result = await MarketData.bulkWrite(ops, { ordered: false });

    return result.upsertedCount + result.modifiedCount + result.matchedCount;
}

// ─────────────────────────────────────────────────────────────────
//  CORE — download one coin + timeframe pair
// ─────────────────────────────────────────────────────────────────
/**
 * Downloads all historical candles for `coin`/`timeframe` starting
 * from `startMs` up to now, page by page.
 *
 * Each page is:
 *   fetch → bulkWrite → free memory → sleep(2s) → next page
 *
 * @param {string}  coin
 * @param {string}  timeframe
 * @param {number}  startMs     epoch ms to begin from
 * @param {boolean} resume      if true, skip pair if already up to date
 */
async function downloadPair(coin, timeframe, startMs, resume) {
    const tfMs    = TF_MS[timeframe] || 900_000;
    const nowMs   = Date.now();

    // ── Resume: find the latest stored candle and fast-forward ──
    let cursorMs = startMs;

    if (resume) {
        const latest = await MarketData.getLatestTimestamp(coin, timeframe);
        if (latest !== null) {
            // Start one candle after what we already have
            cursorMs = latest + tfMs;
            if (cursorMs >= nowMs - tfMs) {
                log.info(`${BOLD}${coin}${RESET} ${MAGENTA}${timeframe}${RESET} is already up to date — skipping.`);
                return;
            }
            log.info(
                `${BOLD}${coin}${RESET} ${MAGENTA}${timeframe}${RESET}` +
                ` resuming from ${new Date(cursorMs).toISOString().substring(0, 10)}`
            );
        }
    }

    log.pair(coin, timeframe, new Date(cursorMs).toISOString().substring(0, 10));

    let pageNum   = 1;
    let totalSaved = 0;

    while (cursorMs < nowMs) {
        log.page(coin, timeframe, cursorMs, pageNum);

        // ── Fetch ─────────────────────────────────────────────
        let rawPage;
        try {
            rawPage = await fetchKlines(coin, timeframe, cursorMs, nowMs);
        } catch (err) {
            log.error(
                `Fatal fetch error for ${coin} ${timeframe} at ` +
                `${new Date(cursorMs).toISOString()} after ${MAX_RETRIES} retries: ` +
                `${err.message}. Skipping this pair.`
            );
            return;   // Move on to the next pair rather than crashing
        }

        if (!rawPage.length) {
            log.info(`No candles returned for ${coin} ${timeframe} — pair is complete.`);
            break;
        }

        // ── Persist ───────────────────────────────────────────
        const saved = await savePage(coin, timeframe, rawPage);
        totalSaved += saved;
        log.save(coin, timeframe, rawPage.length, totalSaved);

        // ── Advance cursor to the candle AFTER the last one ───
        const lastOpenTime = rawPage[rawPage.length - 1][0];   // ms
        cursorMs = lastOpenTime + tfMs;

        // ── Free memory (critical on 1 GB VPS) ───────────────
        rawPage.length = 0;   // dereference array contents

        // If we got a full page and there might be more, sleep
        // before the next request to avoid hammering Binance.
        if (cursorMs < nowMs) {
            await sleep(SLEEP_MS);
        }

        pageNum++;
    }

    log.success(
        `${BOLD}${CYAN}${coin}${RESET} ${MAGENTA}${timeframe}${RESET}` +
        ` ─ download complete!` +
        ` ${BOLD}${GREEN}${totalSaved.toLocaleString()}${RESET} candles stored.`
    );
}

// ─────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────
async function main() {
    log.banner();

    const { coinFilter, tfFilter, resume } = parseArgs();

    // ── Validate environment ──────────────────────────────────────
    const mongoUri = process.env.MONGODB;
    if (!mongoUri) {
        log.error('MONGODB environment variable is not set. Aborting.');
        process.exit(1);
    }

    // ── Connect to MongoDB ────────────────────────────────────────
    log.info('Connecting to MongoDB…');
    await mongoose.connect(mongoUri, {
        /*
         * bufferCommands: false ensures mongoose throws immediately
         * if a query fires before the connection is ready, rather
         * than silently queuing and potentially blowing up RAM.
         */
        bufferCommands:        false,
        serverSelectionTimeoutMS: 10_000,
        socketTimeoutMS:          45_000,
    });
    log.success(`MongoDB connected → ${mongoUri}`);

    // ── Ensure indexes are in place ───────────────────────────────
    await MarketData.createIndexes();
    log.info('Indexes verified.');

    // ── Build the work queue ──────────────────────────────────────
    const coins = coinFilter
        ? COINS.filter(c => c.symbol === coinFilter)
        : COINS;

    const timeframes = tfFilter
        ? TIMEFRAMES.filter(tf => tf === tfFilter)
        : TIMEFRAMES;

    if (!coins.length) {
        log.error(`Coin "${coinFilter}" is not in the COINS list. Aborting.`);
        await mongoose.disconnect();
        process.exit(1);
    }

    const totalPairs = coins.length * timeframes.length;
    let pairsDone    = 0;

    log.info(
        `Work queue: ${BOLD}${coins.length}${RESET} coin(s) ×` +
        ` ${BOLD}${timeframes.length}${RESET} timeframe(s)` +
        ` = ${BOLD}${totalPairs}${RESET} pair(s).`
    );

    // ── Process every pair sequentially (RAM-safe) ────────────────
    for (const { symbol, startDate } of coins) {
        for (const tf of timeframes) {
            pairsDone++;
            const startMs = new Date(startDate).getTime();

            log.info(
                `Progress: ${pairsDone}/${totalPairs}` +
                ` — starting ${BOLD}${symbol}${RESET} ${MAGENTA}${tf}${RESET}`
            );

            try {
                await downloadPair(symbol, tf, startMs, resume);
            } catch (err) {
                // Catch any unexpected error so one bad pair doesn't
                // abort the whole run
                log.error(
                    `Unexpected error on ${symbol} ${tf}: ${err.message}. ` +
                    `Moving to next pair.`
                );
            }

            // Short pause between pairs (rate-limit courtesy)
            if (pairsDone < totalPairs) {
                log.info(`Cooling down 5s before next pair…`);
                await sleep(5_000);
            }
        }
    }

    // ── Final summary ─────────────────────────────────────────────
    const totalDocs = await MarketData.countDocuments();
    console.log(`
${CYAN}╔══════════════════════════════════════════════════════════╗
║                   ALL DONE  🎉                          ║
╚══════════════════════════════════════════════════════════╝${RESET}
  ${GREEN}Total candles in database : ${BOLD}${totalDocs.toLocaleString()}${RESET}
  ${GREEN}Pairs downloaded          : ${BOLD}${pairsDone}${RESET}
`);

    await mongoose.disconnect();
    process.exit(0);
}

// ─────────────────────────────────────────────────────────────────
//  GRACEFUL SHUTDOWN on Ctrl-C / SIGTERM
// ─────────────────────────────────────────────────────────────────
async function shutdown(signal) {
    console.log(`\n${YELLOW}Received ${signal}. Closing DB connection gracefully…${RESET}`);
    try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
    process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Run ──────────────────────────────────────────────────────────
main().catch(err => {
    log.error(`Unhandled top-level error: ${err.stack || err.message}`);
    mongoose.disconnect().finally(() => process.exit(1));
});
