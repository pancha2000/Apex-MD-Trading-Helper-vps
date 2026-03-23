'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  APEX-MD v7 PRO VVIP  ·  lib/dynamicWeights.js
 *  ─────────────────────────────────────────────────────────────
 *  Calculates dynamic score multipliers based on live regime.
 *
 *  Pro Mode integration:
 *    When config.modules.PRO_MODE = true, ADX thresholds are read
 *    from config.proParams.ADX_CHOPPY / ADX_TRENDING instead of
 *    the hardcoded defaults (20 / 25).
 * ═══════════════════════════════════════════════════════════════
 */

const config = require('../config');

// ── Default thresholds (Auto AI mode) ─────────────────────────
const DEFAULT_ADX_CHOPPY   = 20;
const DEFAULT_ADX_TRENDING = 25;
const ATR_LOW_PCT  = 0.8;
const ATR_HIGH_PCT = 2.5;

function _calcADX(candles, period = 14) {
    if (!candles || candles.length < period * 2 + 2) return 22;
    const dmPlus = [], dmMinus = [], tr = [];
    for (let i = 1; i < candles.length; i++) {
        const h  = parseFloat(candles[i][2]);
        const l  = parseFloat(candles[i][3]);
        const ph = parseFloat(candles[i - 1][2]);
        const pl = parseFloat(candles[i - 1][3]);
        const pc = parseFloat(candles[i - 1][4]);
        const up = h - ph, down = pl - l;
        dmPlus.push( up > down && up > 0   ? up   : 0);
        dmMinus.push(down > up && down > 0 ? down : 0);
        tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    const wilder = (arr, p) => {
        let s = arr.slice(0, p).reduce((a, b) => a + b, 0);
        const out = [s];
        for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; out.push(s); }
        return out;
    };
    const sTR  = wilder(tr,      period);
    const sDMP = wilder(dmPlus,  period);
    const sDMM = wilder(dmMinus, period);
    const dx   = sTR.map((t, i) => t === 0 ? 0 : (Math.abs(sDMP[i] - sDMM[i]) / t) * 100);
    const adxArr = wilder(dx, period);
    return adxArr[adxArr.length - 1];
}

function _calcATRPct(candles, period = 14) {
    if (!candles || candles.length < period + 2) return 1.5;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const h  = parseFloat(candles[i][2]);
        const l  = parseFloat(candles[i][3]);
        const pc = parseFloat(candles[i - 1][4]);
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
    const lc  = parseFloat(candles[candles.length - 1][4]);
    return lc > 0 ? (atr / lc) * 100 : 1.5;
}

function _detectRegime(adx, atrPct, adxChoppy, adxTrending) {
    const trendRegime = adx < adxChoppy ? 'choppy' : adx > adxTrending ? 'trending' : 'neutral';
    const volRegime   = atrPct < ATR_LOW_PCT ? 'low' : atrPct > ATR_HIGH_PCT ? 'high' : 'normal';
    return { trendRegime, volRegime };
}

// ── Hurst Exponent (R/S analysis approximation) ─────────────────────────
// Returns 0–1: >0.55 = trending, <0.45 = mean-reverting/choppy, ~0.5 = random
function _calcHurst(candles) {
    if (!candles || candles.length < 20) return 0.5;
    const closes = candles.map(c => parseFloat(c[4])).filter(v => isFinite(v));
    if (closes.length < 20) return 0.5;

    const logReturns = [];
    for (let i = 1; i < closes.length; i++) {
        if (closes[i] > 0 && closes[i-1] > 0)
            logReturns.push(Math.log(closes[i] / closes[i-1]));
    }
    if (logReturns.length < 10) return 0.5;

    // R/S analysis across 3 window sizes
    const windowSizes = [Math.floor(logReturns.length / 4), Math.floor(logReturns.length / 2), logReturns.length];
    const rsValues = [];

    for (const n of windowSizes) {
        if (n < 4) continue;
        const chunk = logReturns.slice(0, n);
        const mean  = chunk.reduce((s, v) => s + v, 0) / n;
        const deviations = chunk.map((v, i) => chunk.slice(0, i + 1).reduce((s, x) => s + (x - mean), 0));
        const R = Math.max(...deviations) - Math.min(...deviations);
        const S = Math.sqrt(chunk.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / n);
        if (S > 0) rsValues.push({ logN: Math.log(n), logRS: Math.log(R / S) });
    }

    if (rsValues.length < 2) return 0.5;

    // Linear regression slope = Hurst exponent
    const n2 = rsValues.length;
    const sumX  = rsValues.reduce((s, p) => s + p.logN,  0);
    const sumY  = rsValues.reduce((s, p) => s + p.logRS, 0);
    const sumXY = rsValues.reduce((s, p) => s + p.logN * p.logRS, 0);
    const sumX2 = rsValues.reduce((s, p) => s + p.logN * p.logN,  0);
    const denom = n2 * sumX2 - sumX * sumX;
    if (denom === 0) return 0.5;

    const slope = (n2 * sumXY - sumX * sumY) / denom;
    return Math.min(1, Math.max(0, slope));
}

// ── Choppiness Index ────────────────────────────────────────────────────
// Range: 0–100. >61.8 = choppy. <38.2 = strong trend.
function _calcChoppiness(candles, period = 14) {
    if (!candles || candles.length < period) return 50;
    const slice = candles.slice(-period);
    const highs  = slice.map(c => parseFloat(c[2]));
    const lows   = slice.map(c => parseFloat(c[3]));
    const closes = slice.map(c => parseFloat(c[4]));

    // Sum of True Ranges
    let sumTR = 0;
    for (let i = 1; i < slice.length; i++) {
        const h = highs[i], l = lows[i], pc = closes[i-1];
        sumTR += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }

    const highestHigh = Math.max(...highs);
    const lowestLow   = Math.min(...lows);
    const range       = highestHigh - lowestLow;

    if (range === 0 || sumTR === 0) return 50;
    const chop = 100 * Math.log10(sumTR / range) / Math.log10(period);
    return Math.min(100, Math.max(0, chop));
}

function _buildWeights(trendRegime, volRegime) {
    let trend = 1.0, oscillator = 1.0, volume = 1.0, priceAction = 1.0;
    if (trendRegime === 'choppy') {
        trend = 0.50; oscillator = 1.60; priceAction = 1.10;
    } else if (trendRegime === 'trending') {
        trend = 1.60; oscillator = 0.65; priceAction = 1.20;
    }
    if (volRegime === 'high')     { volume *= 1.40; priceAction *= 0.80; }
    else if (volRegime === 'low') { volume *= 0.75; priceAction *= 1.25; }
    const clamp = v => Math.min(2.5, Math.max(0.1, v));
    return { trend: clamp(trend), oscillator: clamp(oscillator), volume: clamp(volume), priceAction: clamp(priceAction) };
}

function getDynamicWeights(candles) {
    // ── Pro Mode: use custom ADX thresholds when active ───────
    const adxChoppy   = config.modules.PRO_MODE ? config.proParams.ADX_CHOPPY   : DEFAULT_ADX_CHOPPY;
    const adxTrending = config.modules.PRO_MODE ? config.proParams.ADX_TRENDING : DEFAULT_ADX_TRENDING;

    const adx    = _calcADX(candles, 14);
    const atrPct = _calcATRPct(candles, 14);

    // ── Hurst Exponent ──────────────────────────────────────────
    // H > 0.55 → trending (persistent), H < 0.45 → mean-reverting (choppy)
    // Uses R/S analysis on closes (fast approximation, 50 candles)
    const hurst = _calcHurst(candles.slice(-50));

    // ── Choppiness Index ────────────────────────────────────────
    // CHOP > 61.8 → choppy (block breakout signals)
    // CHOP < 38.2 → strong trend (boost trend indicators)
    const chop = _calcChoppiness(candles.slice(-14));

    const { trendRegime, volRegime } = _detectRegime(adx, atrPct, adxChoppy, adxTrending);

    // ── Enhance regime with Hurst + Chop confirmation ───────────
    let enhancedTrend = trendRegime;
    if (hurst < 0.45 || chop > 61.8) {
        // Both say choppy → hard choppy override
        enhancedTrend = 'choppy';
    } else if (hurst > 0.55 && chop < 38.2) {
        // Both say trending → boost trending confidence
        enhancedTrend = 'trending';
    }

    const weights = _buildWeights(enhancedTrend, volRegime);

    const trendEmoji = enhancedTrend === 'trending' ? '🚀' : enhancedTrend === 'choppy' ? '⚖️' : '➡️';
    const volEmoji   = volRegime   === 'high'     ? '🔥' : volRegime   === 'low'    ? '🧊' : '✅';
    const modeTag    = config.modules.PRO_MODE ? ' 🔬' : '';
    const regimeLabel =
        `${trendEmoji} ${enhancedTrend.toUpperCase()} | ${volEmoji} VOL ${volRegime.toUpperCase()} ` +
        `| ADX=${adx.toFixed(1)} CHOP=${chop.toFixed(1)} H=${hurst.toFixed(2)}${modeTag} ` +
        `| W: T=${weights.trend.toFixed(2)} O=${weights.oscillator.toFixed(2)} ` +
        `V=${weights.volume.toFixed(2)} PA=${weights.priceAction.toFixed(2)}`;

    return { weights, adx, atrPct, hurst, chop, trendRegime: enhancedTrend, volRegime, regimeLabel,
             isChoppy: enhancedTrend === 'choppy', isTrending: enhancedTrend === 'trending' };
}

function w(pts, weight) {
    return Math.round(pts * weight * 100) / 100;
}

module.exports = { getDynamicWeights, w };
