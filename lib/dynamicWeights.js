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

    const { trendRegime, volRegime } = _detectRegime(adx, atrPct, adxChoppy, adxTrending);
    const weights = _buildWeights(trendRegime, volRegime);

    const trendEmoji = trendRegime === 'trending' ? '🚀' : trendRegime === 'choppy' ? '⚖️' : '➡️';
    const volEmoji   = volRegime   === 'high'     ? '🔥' : volRegime   === 'low'    ? '🧊' : '✅';
    const modeTag    = config.modules.PRO_MODE ? ' 🔬' : '';
    const regimeLabel =
        `${trendEmoji} ${trendRegime.toUpperCase()} | ${volEmoji} VOL ${volRegime.toUpperCase()} ` +
        `| ADX=${adx.toFixed(1)} (${adxChoppy}/${adxTrending}${modeTag}) ATR%=${atrPct.toFixed(2)}% ` +
        `| W: T=${weights.trend.toFixed(2)} O=${weights.oscillator.toFixed(2)} ` +
        `V=${weights.volume.toFixed(2)} PA=${weights.priceAction.toFixed(2)}`;

    return { weights, adx, atrPct, trendRegime, volRegime, regimeLabel };
}

function w(pts, weight) {
    return Math.round(pts * weight * 100) / 100;
}

module.exports = { getDynamicWeights, w };
