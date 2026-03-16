'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  APEX-MD v7 PRO VVIP  ·  lib/dynamicWeights.js
 *  ─────────────────────────────────────────────────────────────
 *  Calculates dynamic score multipliers for the 14-Factor scoring
 *  system based on live market regime (ADX + ATR%).
 *
 *  Returns four weight categories used directly in analyzer.js:
 *    • weights.trend       — EMA, MACD, Supertrend, Renko, BOS
 *    • weights.oscillator  — RSI, StochRSI, Williams%R, CCI, MFI
 *    • weights.volume      — RVOL, CVD, Vol Breakout, BB Squeeze
 *    • weights.priceAction — OB, ChoCH, Sweep, Wyckoff, Ichimoku
 *
 *  ADX Logic:
 *    ADX < 20  (Choppy)   → trend↓  oscillator↑  (mean-revert mode)
 *    ADX 20–25 (Neutral)  → all multipliers = 1.0 (balanced)
 *    ADX > 25  (Trending) → trend↑  oscillator↓  (momentum mode)
 *
 *  ATR% Overlay:
 *    High Vol (>2.5%) → volume↑  priceAction↓  (OBs get blown)
 *    Low  Vol (<0.8%) → volume↓  priceAction↑  (structure holds)
 * ═══════════════════════════════════════════════════════════════
 */

// ── Thresholds ────────────────────────────────────────────────
const ADX_CHOPPY   = 20;
const ADX_TRENDING = 25;
const ATR_LOW_PCT  = 0.8;
const ATR_HIGH_PCT = 2.5;

// ── ADX Calculation (Wilder-smoothed, pure JS) ────────────────
/**
 * @param {Array} candles  raw kline array [[o,h,l,c,v,...], ...]
 * @param {number} period  default 14
 * @returns {number} ADX value 0–100
 */
function _calcADX(candles, period = 14) {
    if (!candles || candles.length < period * 2 + 2) return 22; // neutral fallback

    const dmPlus = [], dmMinus = [], tr = [];

    for (let i = 1; i < candles.length; i++) {
        const h  = parseFloat(candles[i][2]);
        const l  = parseFloat(candles[i][3]);
        const ph = parseFloat(candles[i - 1][2]);
        const pl = parseFloat(candles[i - 1][3]);
        const pc = parseFloat(candles[i - 1][4]);

        const up   = h - ph;
        const down = pl - l;
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

// ── ATR% Calculation ──────────────────────────────────────────
/**
 * @param {Array} candles  raw kline array
 * @param {number} period  default 14
 * @returns {number} ATR as % of last close
 */
function _calcATRPct(candles, period = 14) {
    if (!candles || candles.length < period + 2) return 1.5; // normal fallback

    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const h  = parseFloat(candles[i][2]);
        const l  = parseFloat(candles[i][3]);
        const pc = parseFloat(candles[i - 1][4]);
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    const recent    = trs.slice(-period);
    const atr       = recent.reduce((a, b) => a + b, 0) / period;
    const lastClose = parseFloat(candles[candles.length - 1][4]);
    return lastClose > 0 ? (atr / lastClose) * 100 : 1.5;
}

// ── Regime Detector ───────────────────────────────────────────
function _detectRegime(adx, atrPct) {
    let trendRegime = adx < ADX_CHOPPY ? 'choppy' : adx > ADX_TRENDING ? 'trending' : 'neutral';
    let volRegime   = atrPct < ATR_LOW_PCT ? 'low' : atrPct > ATR_HIGH_PCT ? 'high' : 'normal';
    return { trendRegime, volRegime };
}

// ── Weight Builder ────────────────────────────────────────────
function _buildWeights(trendRegime, volRegime) {
    // Base weights (all 1.0 = neutral market)
    let trend       = 1.0;
    let oscillator  = 1.0;
    let volume      = 1.0;
    let priceAction = 1.0;

    // ── ADX Layer ─────────────────────────────────────────────
    if (trendRegime === 'choppy') {
        // Ranging: momentum signals unreliable, oscillators shine
        trend       = 0.50;
        oscillator  = 1.60;
        priceAction = 1.10;  // OBs still valid in ranges
    } else if (trendRegime === 'trending') {
        // Strong trend: follow momentum, ignore oscillator extremes
        trend       = 1.60;
        oscillator  = 0.65;
        priceAction = 1.20;  // OBs + trend = high-conviction entries
    }
    // neutral: all stay 1.0

    // ── ATR% Volatility Overlay ───────────────────────────────
    if (volRegime === 'high') {
        // Explosive move: volume signals amplified, OBs unreliable (blown through)
        volume      *= 1.40;
        priceAction *= 0.80;
    } else if (volRegime === 'low') {
        // Tight compression: structure is clean, volume signals weak
        volume      *= 0.75;
        priceAction *= 1.25;
    }

    // Clamp all weights to sensible range [0.1, 2.5]
    const clamp = v => Math.min(2.5, Math.max(0.1, v));
    return {
        trend:       clamp(trend),
        oscillator:  clamp(oscillator),
        volume:      clamp(volume),
        priceAction: clamp(priceAction),
    };
}

// ── Public API ────────────────────────────────────────────────
/**
 * Main entry point — call once per analysis run.
 *
 * @param {Array}  candles  raw 15m kline array from Binance cache
 * @returns {{
 *   weights:      { trend, oscillator, volume, priceAction },
 *   adx:          number,
 *   atrPct:       number,
 *   trendRegime:  string,   // 'choppy' | 'neutral' | 'trending'
 *   volRegime:    string,   // 'low' | 'normal' | 'high'
 *   regimeLabel:  string,   // human-readable display string
 * }}
 */
function getDynamicWeights(candles) {
    const adx    = _calcADX(candles, 14);
    const atrPct = _calcATRPct(candles, 14);

    const { trendRegime, volRegime } = _detectRegime(adx, atrPct);
    const weights = _buildWeights(trendRegime, volRegime);

    const trendEmoji = trendRegime === 'trending' ? '🚀' : trendRegime === 'choppy' ? '⚖️' : '➡️';
    const volEmoji   = volRegime   === 'high'     ? '🔥' : volRegime   === 'low'    ? '🧊' : '✅';
    const regimeLabel =
        `${trendEmoji} ${trendRegime.toUpperCase()} | ${volEmoji} VOL ${volRegime.toUpperCase()} ` +
        `| ADX=${adx.toFixed(1)} ATR%=${atrPct.toFixed(2)}% ` +
        `| W: T=${weights.trend.toFixed(2)} O=${weights.oscillator.toFixed(2)} ` +
        `V=${weights.volume.toFixed(2)} PA=${weights.priceAction.toFixed(2)}`;

    return { weights, adx, atrPct, trendRegime, volRegime, regimeLabel };
}

/**
 * Convenience: apply weight to a raw point value.
 * Keeps fractional precision for smooth score accumulation.
 *
 * @param {number} pts     raw point value (e.g. 1, 2, 0.5, 3)
 * @param {number} weight  from getDynamicWeights().weights[category]
 * @returns {number}
 */
function w(pts, weight) {
    return Math.round(pts * weight * 100) / 100;
}

module.exports = { getDynamicWeights, w };
