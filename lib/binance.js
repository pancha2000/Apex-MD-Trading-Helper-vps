/**
 * ═══════════════════════════════════════════════════════════════
 *  APEX-MD  ·  binance.js  ·  Pro WebSocket Architecture v2
 *  ─────────────────────────────────────────────────────────────
 *  • Maintains in-memory kline cache for 5m, 15m, 1h, 4h per coin
 *  • 5m is now a LIVE WebSocket stream (500 candles deep)
 *  • Single combined WebSocket stream (no polling)
 *  • Exponential-backoff auto-reconnect
 *  • EventEmitter fires candle-close events for 5m/15m/1h/4h
 *  • All original REST helpers preserved for order-book, F&G, etc.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const axios        = require('axios');
const WebSocket    = require('ws');
const EventEmitter = require('events');
const config       = require('../config');

// ─── Public event bus ──────────────────────────────────────────
const wsEvents = new EventEmitter();
wsEvents.setMaxListeners(100);

// ─── Kline cache  ──────────────────────────────────────────────
// key = "BTCUSDT_15m"  value = Array of kline rows (same shape as REST)
// REST row: [openTime, open, high, low, close, volume, closeTime, ...]
const klineCache = new Map();

// ── Timeframes streamed live over WebSocket ──
// 5m is now part of the WS stream — zero REST polling for 5m data.
const STREAM_TIMEFRAMES = ['5m', '15m', '1h', '4h'];

// ── Candle depth kept in memory per key ──
const CACHE_DEPTH = {
    '5m':  500,   // ← upgraded: live WS stream, 500 candles for sniper entries
    '15m': 500,
    '1h':  100,
    '4h':   80,
    '1d':   15,
};

// ─── Internal WS state ─────────────────────────────────────────
let _ws              = null;
let _wsConnected     = false;
let _watchedCoins    = [];
let _reconnectTimer  = null;
let _reconnectDelay  = 2000;        // starts at 2 s, caps at 60 s
const MAX_RECONNECT_DELAY = 60000;
let _isShuttingDown  = false;
let _seedingDone     = false;

// ─── Cache helpers ─────────────────────────────────────────────

function cacheKey(symbol, tf) {
    return `${symbol.toUpperCase()}_${tf}`;
}

function getCache(symbol, tf) {
    return klineCache.get(cacheKey(symbol, tf)) || null;
}

/**
 * Convert a Binance WebSocket kline object to the same row format
 * returned by the REST /api/v3/klines endpoint so analyzer.js works
 * identically against both data sources.
 *
 *  REST row: [openTime, open, high, low, close, volume, closeTime,
 *             quoteAssetVol, numTrades, takerBuyBaseVol, takerBuyQuoteVol, ignore]
 */
function wsKlineToRestRow(k) {
    return [
        k.t, k.o, k.h, k.l, k.c, k.v,   // openTime, OHLCV
        k.T,                               // closeTime
        k.q,                               // quoteAssetVolume
        k.n,                               // numTrades
        k.V,                               // takerBuyBaseVol
        k.Q,                               // takerBuyQuoteVol
        '0'
    ];
}

/**
 * Seed one symbol + timeframe from REST (called once on startup per pair).
 * This gives the WS handler a full historical array to append live ticks to.
 */
async function seedCache(symbol, tf) {
    const limit = CACHE_DEPTH[tf] || 100;
    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`;
        const res = await axios.get(url, { timeout: 12000 });
        klineCache.set(cacheKey(symbol, tf), res.data);
    } catch (e) {
        console.warn(`[WS-Seed] Failed to seed ${symbol} ${tf}: ${e.message}`);
    }
}

// ─── WebSocket logic ───────────────────────────────────────────

/**
 * Build the Binance combined stream URL.
 * With 30 coins × 4 TFs (5m, 15m, 1h, 4h) = 120 simultaneous streams
 * served through a single WebSocket connection.
 */
function buildStreamUrl(coins) {
    const streams = [];
    for (const coin of coins) {
        const sym = coin.toLowerCase();
        for (const tf of STREAM_TIMEFRAMES) {
            streams.push(`${sym}@kline_${tf}`);
        }
    }
    return `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;
}

function connectWebSocket() {
    if (_isShuttingDown || _watchedCoins.length === 0) return;

    const url = buildStreamUrl(_watchedCoins);
    console.log(`[WS] Connecting — ${_watchedCoins.length} coins × ${STREAM_TIMEFRAMES.length} TFs (${STREAM_TIMEFRAMES.join(', ')})...`);

    _ws = new WebSocket(url);

    // ── Open ────────────────────────────────────────────────────
    _ws.on('open', () => {
        _wsConnected    = true;
        _reconnectDelay = 2000;
        console.log(`[WS] ✅ Connected — ${_watchedCoins.length * STREAM_TIMEFRAMES.length} live kline streams active.`);
    });

    // ── Message ─────────────────────────────────────────────────
    _ws.on('message', (raw) => {
        try {
            const msg  = JSON.parse(raw);
            const data = msg.data;
            if (!data || data.e !== 'kline') return;

            const symbol = data.s;       // e.g. "BTCUSDT"
            const k      = data.k;
            const tf     = k.i;         // e.g. "5m"
            const row    = wsKlineToRestRow(k);
            const key    = cacheKey(symbol, tf);

            let arr = klineCache.get(key);

            if (!arr || arr.length === 0) {
                // Cache not yet seeded (startup race condition) — bootstrap
                klineCache.set(key, [row]);
                return;
            }

            const lastRow = arr[arr.length - 1];

            if (lastRow[0] === row[0]) {
                // ── Same open-time: update the live (forming) candle in place ──
                arr[arr.length - 1] = row;
            } else {
                // ── New candle opened: append and trim to max depth ──
                arr.push(row);
                const maxDepth = CACHE_DEPTH[tf] || 200;
                if (arr.length > maxDepth) arr.splice(0, arr.length - maxDepth);
                klineCache.set(key, arr);
            }

            // ── Fire candle-CLOSE events ─────────────────────────
            // k.x === true means the candle just sealed (no more updates for this bar)
            if (k.x === true) {
                if (tf === '5m')  wsEvents.emit('5m_candle_close',  { symbol, candle: row });
                if (tf === '15m') wsEvents.emit('15m_candle_close', { symbol, candle: row });
                if (tf === '1h')  wsEvents.emit('1h_candle_close',  { symbol, candle: row });
                if (tf === '4h')  wsEvents.emit('4h_candle_close',  { symbol, candle: row });
            }

        } catch (_e) { /* silently ignore malformed frames */ }
    });

    // ── Keep-alive ──────────────────────────────────────────────
    _ws.on('ping', () => {
        try { _ws.pong(); } catch (_) {}
    });

    // ── Error ───────────────────────────────────────────────────
    _ws.on('error', (err) => {
        console.error(`[WS] ❌ Error: ${err.message}`);
    });

    // ── Close → schedule exponential-backoff reconnect ──────────
    _ws.on('close', (code) => {
        _wsConnected = false;
        if (_isShuttingDown) return;

        console.warn(`[WS] ⚠️  Disconnected (code=${code}). Reconnecting in ${_reconnectDelay / 1000}s...`);
        _reconnectTimer = setTimeout(() => connectWebSocket(), _reconnectDelay);
        _reconnectDelay = Math.min(_reconnectDelay * 2, MAX_RECONNECT_DELAY);
    });
}

function disconnectWebSocket() {
    _isShuttingDown = true;
    if (_reconnectTimer) clearTimeout(_reconnectTimer);
    if (_ws) { try { _ws.terminate(); } catch (_) {} _ws = null; }
    _wsConnected = false;
    console.log('[WS] Connection closed gracefully.');
}

// ─── Initialisation ────────────────────────────────────────────

/**
 * Prime the system:
 *   1. Fetch top-N coins by 24h volume via REST (once)
 *   2. Seed all 5 timeframe caches via REST for each coin (once)
 *      — includes 5m (500 candles), 15m, 1h, 4h, 1d
 *   3. Open the persistent WebSocket stream
 *      — streams: 5m, 15m, 1h, 4h  (live, no polling)
 *   4. Schedule a light REST refresh for 1d data every 10 min
 *      (1d is the only TF not in the WS stream)
 *
 * Call this ONCE from scanner.js startScannerFromSettings() or index.js.
 * Subsequent calls are no-ops (idempotent).
 */
async function initWebSocketStreams(limit = 30) {
    if (_seedingDone) {
        console.log('[WS] Already initialised — skipping duplicate init.');
        return;
    }

    console.log(`[WS] 🚀 Bootstrapping WebSocket streams for Top ${limit} coins...`);
    console.log(`[WS] Streaming TFs: ${STREAM_TIMEFRAMES.join(', ')} | 5m depth: ${CACHE_DEPTH['5m']} candles`);

    // 1. Discover top coins by 24h USDT volume
    _watchedCoins = await getTopTrendingCoins(limit);
    console.log(`[WS] Coin list: ${_watchedCoins.join(', ')}`);

    // 2. Build seed task list for ALL timeframes including 5m and 1d
    //    STREAM_TIMEFRAMES (5m, 15m, 1h, 4h) + 1d (daily candles for pivot points)
    const seedTasks = [];
    for (const coin of _watchedCoins) {
        for (const tf of STREAM_TIMEFRAMES) {
            seedTasks.push({ coin, tf });   // seeds 5m, 15m, 1h, 4h
        }
        seedTasks.push({ coin, tf: '1d' }); // seeds daily candles (pivot points)
    }

    // Parallel batches of 8 with a 400ms cooldown between batches
    // This avoids hammering Binance REST and triggering rate limits
    const BATCH = 8;
    for (let i = 0; i < seedTasks.length; i += BATCH) {
        const batch = seedTasks.slice(i, i + BATCH);
        await Promise.all(batch.map(({ coin, tf }) => seedCache(coin, tf)));
        if (i + BATCH < seedTasks.length) await new Promise(r => setTimeout(r, 400));
    }

    console.log('[WS] ✅ Historical kline cache seeded for all TFs (5m/15m/1h/4h/1d).');
    _seedingDone = true;

    // 3. Open the persistent WebSocket (5m, 15m, 1h, 4h — all live)
    connectWebSocket();

    // 4. Refresh ONLY 1d candles every 10 minutes via REST
    //    5m, 15m, 1h, 4h are fully maintained by the live WS — no REST refresh needed.
    setInterval(async () => {
        for (const coin of _watchedCoins) {
            await seedCache(coin, '1d').catch(() => {});
            await new Promise(r => setTimeout(r, 200));
        }
    }, 10 * 60 * 1000);
}

// ─── Public data accessor ──────────────────────────────────────

/**
 * PRIMARY DATA METHOD for analyzer.js and all internal modules.
 *
 * Returns kline data from the in-memory WebSocket cache.
 * Falls back to a one-time REST call and populates the cache if empty.
 * This handles coins not in the top-30 WS stream (e.g. manual .future
 * commands for arbitrary symbols).
 *
 * @param {string} coin       e.g. 'BTCUSDT'
 * @param {string} timeframe  e.g. '5m'
 * @param {number} limit      number of candles to return (from the tail)
 */
async function getKlineDataFromCache(coin, timeframe, limit = 100) {
    const cached = getCache(coin, timeframe);
    if (cached && cached.length >= Math.min(limit, 5)) {
        return cached.length <= limit ? cached : cached.slice(-limit);
    }

    // ✅ FIX: Cache miss — REST fetch with retry. Returns null on failure instead
    // of throwing, so Promise.allSettled in analyzer can handle per-TF failures.
    console.warn(`[Cache] Miss for ${coin} ${timeframe} — fetching via REST.`);
    try {
        const depth = Math.max(limit, CACHE_DEPTH[timeframe] || 100);
        const data  = await getKlineData(coin, timeframe, depth);
        klineCache.set(cacheKey(coin, timeframe), data);
        return data.length <= limit ? data : data.slice(-limit);
    } catch (e) {
        console.error(`[Cache] REST fallback FAILED for ${coin} ${timeframe}: ${e.message}`);
        // Return cached data even if stale, better than nothing
        const stale = getCache(coin, timeframe);
        if (stale && stale.length > 0) {
            console.warn(`[Cache] Using stale cache for ${coin} ${timeframe} (${stale.length} candles)`);
            return stale.length <= limit ? stale : stale.slice(-limit);
        }
        throw e; // re-throw only if truly nothing available
    }
}

function getWatchedCoins() { return [..._watchedCoins]; }
function isReady()         { return _wsConnected && _seedingDone; }

// ─── Original REST helpers (preserved, unchanged) ──────────────

async function withRetry(fn, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (e) {
            if (i < retries - 1) await new Promise(r => setTimeout(r, delay * (i + 1)));
            else throw e;
        }
    }
}

/**
 * Direct REST kline fetch — kept for backward compatibility and cache-miss fallback.
 * Inside the scanner/analyzer, always prefer getKlineDataFromCache().
 */
async function getKlineData(coin, timeframe, limit = 100) {
    // ✅ FIX: Timeout 10s→20s (500 candles takes longer).
    // ✅ FIX: 429 rate-limit waits Retry-After header before next attempt.
    // ✅ FIX: Real error logged so server logs show actual cause.
    return await withRetry(async () => {
        const url = `https://api.binance.com/api/v3/klines?symbol=${coin}&interval=${timeframe}&limit=${limit}`;
        try {
            const res = await axios.get(url, { timeout: 20000 });
            if (!res.data || !Array.isArray(res.data) || res.data.length === 0)
                throw new Error(`Empty response for ${coin} ${timeframe}`);
            return res.data;
        } catch (e) {
            if (e.response && e.response.status === 429) {
                const retryAfter = parseInt((e.response.headers && e.response.headers['retry-after']) || '5', 10);
                console.warn(`[Binance] Rate limited (429) — waiting ${retryAfter}s before retry`);
                await new Promise(r => setTimeout(r, retryAfter * 1000));
            }
            if (e.response && e.response.status === 418)
                console.error(`[Binance] IP temporarily banned (418) — reduce request frequency`);
            console.error(`[Binance REST] ${coin} ${timeframe}: ${e.message}`);
            throw e;
        }
    }).catch(error => {
        console.error(`[Binance] FAILED — ${coin} ${timeframe} limit=${limit} | ${error.message}`);
        throw new Error(`Binance දත්ත ලබාගැනීමේදී දෝෂයක් (${coin} ${timeframe}): ${error.message}`);
    });
}

async function getOrderBook(coin) {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/depth?symbol=${coin}&limit=100`);
        let totalBids = res.data.bids.reduce((s, o) => s + parseFloat(o[0]) * parseFloat(o[1]), 0);
        let totalAsks = res.data.asks.reduce((s, o) => s + parseFloat(o[0]) * parseFloat(o[1]), 0);
        return { totalBids: totalBids.toFixed(2), totalAsks: totalAsks.toFixed(2) };
    } catch (e) { return { totalBids: 'Unknown', totalAsks: 'Unknown' }; }
}

async function getFearAndGreed() {
    try {
        const res = await axios.get('https://api.alternative.me/fng/');
        return `${res.data.data[0].value} (${res.data.data[0].value_classification})`;
    } catch (e) { return 'Unknown'; }
}

async function getLiquidationData(symbol) {
    try {
        const oiRes = await axios.get(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`);
        const lsRes = await axios.get(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=15m&limit=1`);
        let longShortRatio = lsRes.data.length > 0 ? parseFloat(lsRes.data[0].longShortRatio).toFixed(2) : '1.00';
        let sentiment = longShortRatio > 1.5 ? 'High Longs 🔴 (Risk Down)' : longShortRatio < 0.7 ? 'High Shorts 🟢 (Risk Up)' : 'Neutral';
        return { openInterest: oiRes.data.openInterest || 'Unknown', longShortRatio, sentiment };
    } catch (e) { return { openInterest: 'Error', longShortRatio: '1.00', sentiment: 'Unknown' }; }
}

async function getNewsHeadlines() {
    try {
        const res = await axios.get('https://min-api.cryptocompare.com/data/v2/news/?lang=EN');
        const raw = res.data && res.data.Data;
        const arr = Array.isArray(raw) ? raw : (Array.isArray(raw && raw.Data) ? raw.Data : []);
        if (arr.length === 0) return 'No recent news';
        return arr.slice(0, 3).map(n => n.title).join(' | ');
    } catch (e) { return 'No recent news'; }
}

async function getTopTrendingCoins(limit = 30) {
    try {
        const res = await axios.get('https://api.binance.com/api/v3/ticker/24hr');
        let coins = res.data.filter(c =>
            c.symbol.endsWith('USDT') &&
            !c.symbol.includes('UP') &&
            !c.symbol.includes('DOWN') &&
            parseFloat(c.lastPrice) > 0.1
        );
        coins.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
        return coins.slice(0, limit).map(c => c.symbol);
    } catch (e) {
        console.log('Top Coins Error: ', e.message);
        return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOGEUSDT'];
    }
}

async function getLiquidityWalls(coin) {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/depth?symbol=${coin}&limit=500`);
        let maxBidVol = 0, bestBidPrice = 0, totalBids = 0;
        res.data.bids.forEach(b => {
            let vol = parseFloat(b[0]) * parseFloat(b[1]);
            totalBids += vol;
            if (vol > maxBidVol) { maxBidVol = vol; bestBidPrice = parseFloat(b[0]); }
        });
        let maxAskVol = 0, bestAskPrice = 0, totalAsks = 0;
        res.data.asks.forEach(a => {
            let vol = parseFloat(a[0]) * parseFloat(a[1]);
            totalAsks += vol;
            if (vol > maxAskVol) { maxAskVol = vol; bestAskPrice = parseFloat(a[0]); }
        });
        let cvdStatus = totalBids > totalAsks ? 'Bullish 🟢 (More Bids)' : 'Bearish 🔴 (More Asks)';
        return {
            supportWall: bestBidPrice.toFixed(4), resistWall: bestAskPrice.toFixed(4),
            supportVol: (maxBidVol / 1000000).toFixed(2) + 'M', resistVol: (maxAskVol / 1000000).toFixed(2) + 'M',
            cvd: cvdStatus
        };
    } catch (e) {
        return { supportWall: 'N/A', resistWall: 'N/A', supportVol: '0', resistVol: '0', cvd: 'Unknown' };
    }
}

async function getFundingRate(coin) {
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${coin}&limit=1`, { timeout: 5000 });
        if (res.data && res.data.length > 0) {
            const rate      = parseFloat(res.data[0].fundingRate) * 100;
            const nextTime  = res.data[0].fundingTime;
            const hoursLeft = Math.round((nextTime - Date.now()) / 3600000);
            const emoji = rate > 0.05 ? '🔴' : rate < -0.05 ? '🟢' : '⚪';
            const desc  = rate > 0.05 ? 'Longs pay Shorts ⚠️' : rate < -0.05 ? 'Shorts pay Longs ✅' : 'Neutral';
            return `${emoji} ${rate.toFixed(4)}% (${desc}) | Next: ${hoursLeft}h`;
        }
        return 'N/A';
    } catch (e) { return 'N/A'; }
}

async function getMarketSentiment(coin = null) {
    const results = await Promise.allSettled([
        axios.get('https://api.alternative.me/fng/', { timeout: 6000 }),
        axios.get('https://api.coingecko.com/api/v3/global', { timeout: 6000 }),
        axios.get('https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=latest&limit=10', { timeout: 6000 }),
        axios.get('https://api.binance.com/api/v3/ticker/24hr?symbol=USDTBUSD', { timeout: 4000 }).catch(() => null),
    ]);

    let fngValue = 50, fngLabel = 'Neutral', fngEmoji = '⚪';
    if (results[0].status === 'fulfilled') {
        fngValue = parseInt(results[0].value.data.data[0].value);
        fngLabel = results[0].value.data.data[0].value_classification;
        fngEmoji = fngValue >= 75 ? '🤑' : fngValue >= 55 ? '😊' : fngValue >= 45 ? '😐' : fngValue >= 25 ? '😨' : '😱';
    }

    let btcDom = 50;
    if (results[1].status === 'fulfilled') {
        btcDom = results[1].value.data.data.market_cap_percentage.btc || 50;
    }

    let newsSentimentScore = 0, newsHeadlines = [], coinNewsHits = 0;
    if (results[2].status === 'fulfilled') {
        const raw = results[2].value.data && results[2].value.data.Data;
        const newsData = Array.isArray(raw) ? raw : (Array.isArray(raw && raw.Data) ? raw.Data : []);
        newsHeadlines = newsData.slice(0, 5).map(n => n.title);
        const coinBase = coin ? coin.replace('USDT', '').toLowerCase() : '';
        const bullWords = /bull|surge|soar|rally|gain|rise|pump|ath|record|breakout|adoption|buy|moon/i;
        const bearWords = /bear|crash|drop|fall|plunge|dump|warning|fear|ban|hack|sell|scam|fraud|regulation|lawsuit/i;
        newsData.forEach(n => {
            const title = n.title.toLowerCase();
            const isCoinRelated = coinBase && title.includes(coinBase);
            if (isCoinRelated) coinNewsHits++;
            const weight = isCoinRelated ? 2 : 1;
            if (bullWords.test(title)) newsSentimentScore += weight;
            if (bearWords.test(title)) newsSentimentScore -= weight;
        });
        newsSentimentScore = Math.max(-5, Math.min(5, newsSentimentScore));
    }

    const fngBias    = fngValue >= 60 ? 1 : fngValue <= 40 ? -1 : 0;
    const newsBias   = newsSentimentScore > 1 ? 1 : newsSentimentScore < -1 ? -1 : 0;
    const btcDomBias = btcDom > 55 ? -0.5 : btcDom < 45 ? 0.5 : 0;
    const totalBias  = fngBias + newsBias + btcDomBias;

    const overallSentiment = totalBias >= 1.5 ? '🟢 BULLISH' : totalBias <= -1.5 ? '🔴 BEARISH' : '⚪ NEUTRAL';
    const tradingBias      = totalBias >= 1 ? 'LONG favored' : totalBias <= -1 ? 'SHORT favored' : 'Neutral - trade with caution';

    return {
        fngValue, fngLabel, fngEmoji,
        btcDominance: btcDom.toFixed(1),
        newsSentimentScore, coinNewsHits, newsHeadlines,
        overallSentiment, tradingBias,
        totalBias: totalBias.toFixed(1),
        summary: `${fngEmoji} F&G: ${fngValue} (${fngLabel}) | ₿ BTC.D: ${btcDom.toFixed(1)}% | 📰 News: ${newsSentimentScore > 0 ? '+' : ''}${newsSentimentScore}`
    };
}

// ─── Graceful shutdown ─────────────────────────────────────────
process.on('SIGINT',  () => { disconnectWebSocket(); process.exit(0); });
process.on('SIGTERM', () => { disconnectWebSocket(); process.exit(0); });

// ─── Exports ───────────────────────────────────────────────────
module.exports = {
    // ── WebSocket management ──
    initWebSocketStreams,
    disconnectWebSocket,
    wsEvents,
    isReady,
    getWatchedCoins,

    // ── Cache-based data (use inside bot — reads from live WS cache) ──
    getKlineDataFromCache,

    // ── REST helpers (backward compat & direct plugin use) ──
    getKlineData,
    getOrderBook,
    getFearAndGreed,
    getLiquidationData,
    getNewsHeadlines,
    getTopTrendingCoins,
    getLiquidityWalls,
    getFundingRate,
    getMarketSentiment,
};
