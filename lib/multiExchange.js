'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  APEX-MD v7 PRO VVIP  ·  lib/multiExchange.js
 *  ─────────────────────────────────────────────────────────────
 *  Fetches live Bybit orderbook + volume data using axios and
 *  compares it with Binance data to detect:
 *    • Whale manipulation (orderbook spoofing)
 *    • Cross-exchange divergence (fakeouts)
 *    • Volume anomalies (single-exchange spikes = suspicious)
 *
 *  Returns a score modifier (-3 to +3) for analyzer.js.
 *  Always fails gracefully — never crashes the main bot.
 *
 *  No API keys required — all public endpoints.
 * ═══════════════════════════════════════════════════════════════
 */

const axios = require('axios');

// ── Config ────────────────────────────────────────────────────
const CFG = {
    BYBIT_BASE:             'https://api.bybit.com',
    BINANCE_BASE:           'https://fapi.binance.com',
    TIMEOUT_MS:             5000,
    OB_DEPTH:               20,
    OB_IMBALANCE_THRESHOLD: 1.5,   // bids/asks ratio to flag directional pressure
    SPOOF_WALL_PCT:         0.25,   // single order > 25% of side = spoof warning
    VOLUME_SPIKE_MULT:      2.0,    // current vol > 2× average = spike
    DIVERGENCE_THRESHOLD:   0.30,   // >30% OB ratio difference = fakeout risk
    VOLUME_LOOKBACK:        10,     // candles to average for volume baseline
};

// ── Axios instance with timeout ───────────────────────────────
const http = axios.create({ timeout: CFG.TIMEOUT_MS });

// ── Safe fetch wrapper ────────────────────────────────────────
async function _get(url, label) {
    try {
        const { data } = await http.get(url);
        return data;
    } catch (e) {
        // Silently return null — caller handles missing data
        return null;
    }
}

// ── Bybit Orderbook ───────────────────────────────────────────
async function _getBybitOB(symbol) {
    const data = await _get(
        `${CFG.BYBIT_BASE}/v5/market/orderbook?category=linear&symbol=${symbol}&limit=${CFG.OB_DEPTH}`,
        'Bybit OB'
    );
    if (!data?.result?.b) return null;
    return {
        bids: data.result.b.map(([p, q]) => ({ price: +p, qty: +q })),
        asks: data.result.a.map(([p, q]) => ({ price: +p, qty: +q })),
    };
}

// ── Bybit Volume (15m klines) ─────────────────────────────────
async function _getBybitVolume(symbol) {
    const data = await _get(
        `${CFG.BYBIT_BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=15&limit=${CFG.VOLUME_LOOKBACK + 1}`,
        'Bybit Vol'
    );
    if (!data?.result?.list || data.result.list.length < 2) return null;
    // Bybit returns newest-first
    const candles = data.result.list.reverse().map(k => +k[5]);
    const current = candles[candles.length - 1];
    const avg     = candles.slice(0, -1).reduce((a, b) => a + b, 0) / (candles.length - 1);
    return { current, avg, ratio: avg > 0 ? current / avg : 1 };
}

// ── Binance Volume (15m klines via futures) ───────────────────
async function _getBinanceVolume(symbol) {
    const data = await _get(
        `${CFG.BINANCE_BASE}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=${CFG.VOLUME_LOOKBACK + 1}`,
        'Binance Vol'
    );
    if (!Array.isArray(data) || data.length < 2) return null;
    const candles = data.map(k => +k[5]);
    const current = candles[candles.length - 1];
    const avg     = candles.slice(0, -1).reduce((a, b) => a + b, 0) / (candles.length - 1);
    return { current, avg, ratio: avg > 0 ? current / avg : 1 };
}

// ── Binance Orderbook ─────────────────────────────────────────
async function _getBinanceOB(symbol) {
    const data = await _get(
        `${CFG.BINANCE_BASE}/fapi/v1/depth?symbol=${symbol}&limit=${CFG.OB_DEPTH}`,
        'Binance OB'
    );
    if (!data?.bids) return null;
    return {
        bids: data.bids.map(([p, q]) => ({ price: +p, qty: +q })),
        asks: data.asks.map(([p, q]) => ({ price: +p, qty: +q })),
    };
}

// ── Orderbook Analysis ────────────────────────────────────────
function _analyzeOB(ob) {
    if (!ob) return null;
    const bidTotal = ob.bids.reduce((s, o) => s + o.qty, 0);
    const askTotal = ob.asks.reduce((s, o) => s + o.qty, 0);
    const ratio    = askTotal > 0 ? bidTotal / askTotal : 1;

    const bias = ratio > CFG.OB_IMBALANCE_THRESHOLD
        ? 'BULLISH'
        : ratio < 1 / CFG.OB_IMBALANCE_THRESHOLD
            ? 'BEARISH'
            : 'NEUTRAL';

    // Spoof wall: one order owns > 25% of its side
    const maxBid  = bidTotal > 0 ? Math.max(...ob.bids.map(o => o.qty)) : 0;
    const maxAsk  = askTotal > 0 ? Math.max(...ob.asks.map(o => o.qty)) : 0;
    const spoofBid = bidTotal > 0 && (maxBid / bidTotal) > CFG.SPOOF_WALL_PCT;
    const spoofAsk = askTotal > 0 && (maxAsk / askTotal) > CFG.SPOOF_WALL_PCT;

    return { bidTotal, askTotal, ratio: +ratio.toFixed(3), bias, spoofBid, spoofAsk };
}

// ── Score Builder ─────────────────────────────────────────────
function _buildScore(binOB, bybOB, binVol, bybVol, direction) {
    let score = 0;
    const reasons = [];

    // ── Orderbook Confluence ──────────────────────────────────
    if (binOB && bybOB) {
        const agree = binOB.bias === bybOB.bias && binOB.bias !== 'NEUTRAL';
        const ratioDiv = Math.abs(binOB.ratio - bybOB.ratio) / ((binOB.ratio + bybOB.ratio) / 2 || 1);
        const conflict = (binOB.bias === 'BULLISH' && bybOB.bias === 'BEARISH') ||
                         (binOB.bias === 'BEARISH' && bybOB.bias === 'BULLISH');

        if (agree) {
            const aligned = (direction === 'LONG'  && binOB.bias === 'BULLISH') ||
                            (direction === 'SHORT' && binOB.bias === 'BEARISH');
            if (aligned) { score += 1; reasons.push('OB Confluence ✅(+1)'); }
            else          { score -= 1; reasons.push('OB Against Signal ❌(-1)'); }
        }

        if (conflict) {
            score -= 1;
            reasons.push('Cross-Exchange OB Conflict 🚨(-1)');
        } else if (ratioDiv > CFG.DIVERGENCE_THRESHOLD) {
            score -= 1;
            reasons.push(`OB Divergence ${(ratioDiv * 100).toFixed(0)}% ⚠️(-1)`);
        }

        // Extreme imbalance both exchanges
        const extremeBull = binOB.ratio > 2.0 && bybOB.ratio > 2.0;
        const extremeBear = binOB.ratio < 0.5 && bybOB.ratio < 0.5;
        if (extremeBull && direction === 'LONG')  { score += 1; reasons.push('Extreme Buy Pressure 🔥(+1)'); }
        if (extremeBear && direction === 'SHORT') { score += 1; reasons.push('Extreme Sell Pressure 🔥(+1)'); }
    }

    // ── Spoof Wall Detection ──────────────────────────────────
    const spoofDetected = binOB?.spoofBid || binOB?.spoofAsk || bybOB?.spoofBid || bybOB?.spoofAsk;
    if (spoofDetected) {
        score -= 1;
        reasons.push('Spoof Wall Detected 🐳(-1)');
        // Directional spoof (fake wall propping up/down price)
        const badSpoof = (direction === 'LONG'  && (binOB?.spoofBid || bybOB?.spoofBid)) ||
                         (direction === 'SHORT' && (binOB?.spoofAsk || bybOB?.spoofAsk));
        if (badSpoof) { score -= 1; reasons.push('Directional Spoof Warning 🚨(-1)'); }
    }

    // ── Volume Analysis ───────────────────────────────────────
    const binSpike = binVol && binVol.ratio >= CFG.VOLUME_SPIKE_MULT;
    const bybSpike = bybVol && bybVol.ratio >= CFG.VOLUME_SPIKE_MULT;

    if (binSpike && bybSpike) {
        score += 1;
        reasons.push(`Cross-Exchange Vol Spike 📊(+1) Bin×${binVol.ratio.toFixed(1)} Byb×${bybVol.ratio.toFixed(1)}`);
    } else if (binSpike !== bybSpike && (binSpike || bybSpike)) {
        // Spike on one exchange only = suspicious (wash trading / single-exchange pump)
        score -= 1;
        const who = binSpike ? 'Binance-only' : 'Bybit-only';
        reasons.push(`${who} Vol Spike ⚠️(-1) — possible manipulation`);
    }

    return { score: Math.max(-3, Math.min(3, score)), reasons };
}

// ── Public API ────────────────────────────────────────────────
/**
 * Fetches live Bybit + Binance data in parallel and returns a
 * score modifier for the main trade entry decision.
 *
 * @param {string} symbol     e.g. 'BTCUSDT'
 * @param {'LONG'|'SHORT'} direction  current signal direction
 * @returns {Promise<{
 *   modifier:   number,   // -3 to +3, add directly to longScore/shortScore
 *   reasons:    string[], // human-readable breakdown
 *   regime:     string,   // summary label
 *   available:  boolean,  // false = both APIs offline
 * }>}
 */
async function getBybitConfluence(symbol, direction = 'LONG') {
    const fallback = { modifier: 0, reasons: [], regime: 'BYBIT_OFFLINE', available: false };

    try {
        const sym = symbol.toUpperCase();
        const [binOBRaw, bybOBRaw, binVol, bybVol] = await Promise.all([
            _getBinanceOB(sym),
            _getBybitOB(sym),
            _getBinanceVolume(sym),
            _getBybitVolume(sym),
        ]);

        // If both OBs failed, consider offline
        if (!binOBRaw && !bybOBRaw && !binVol && !bybVol) return fallback;

        const binOB = _analyzeOB(binOBRaw);
        const bybOB = _analyzeOB(bybOBRaw);

        const { score, reasons } = _buildScore(binOB, bybOB, binVol, bybVol, direction);

        let regime;
        if      (score >=  2) regime = 'STRONG_CONFLUENCE 🟢🟢';
        else if (score ===  1) regime = 'MILD_CONFLUENCE 🟢';
        else if (score ===  0) regime = 'NEUTRAL ⚪';
        else if (score === -1) regime = 'MILD_WARNING 🟡';
        else                   regime = 'MANIPULATION_RISK 🚨';

        return { modifier: score, reasons, regime, available: true,
            _debug: { binOB, bybOB, binVol, bybVol } };

    } catch (err) {
        return { ...fallback, regime: `BYBIT_ERROR: ${err.message}` };
    }
}

module.exports = { getBybitConfluence };
