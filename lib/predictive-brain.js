'use strict';
/**
 * ApexIQ · lib/predictive-brain.js
 * ══════════════════════════════════════════════════════════════════════════
 *  THE PREDICTIVE TRADING BRAIN  ·  Quant Analysis Engine
 *
 *  This module is the analytical core of the Auto-Pilot feature. It takes
 *  raw OHLCV candle data and produces a structured PredictiveSignal object
 *  that answers the question: "Where is this coin going in the next 4–12h?"
 *
 *  Key quant concepts implemented:
 *
 *  1. DYNAMIC TOLERANCE (Gray Area)
 *     Order Blocks and FVGs are not laser-thin lines — price often reacts
 *     within a buffer zone.  We compute a ±0.2%–0.5% adaptive buffer based
 *     on recent ATR so near-misses are still accepted as valid triggers.
 *
 *  2. MINIMUM WEIGHT FLOOR
 *     Adaptive indicator weights (from dynamicWeights.js) can shrink as an
 *     indicator underperforms.  To prevent over-fitting we enforce a hard
 *     minimum of 5 points so every factor always contributes meaningfully.
 *
 *  3. CHOP FILTER (Hurst Exponent)
 *     The Hurst Exponent H classifies market regime:
 *       H > 0.55  → Trending  (breakout strategies valid)
 *       0.45–0.55 → Random walk
 *       H < 0.45  → Mean-reverting / Choppy (breakout signals BLOCKED)
 *     We calculate H using the Rescaled Range (R/S) method on close prices.
 *
 *  4. LEADING vs. LAGGING  (Predictive Logic)
 *     Classic MACD/EMA signals lag by definition — they react to history.
 *     The brain uses SMC structure (Order Blocks, FVGs, ChoCH) to generate
 *     a FORWARD-LOOKING target:
 *       • If price is falling but approaching a Bullish OB in discount zone
 *         → output "Bullish" prediction and upside target, NOT a sell signal.
 *       • If price is rising but approaching a Bearish OB in premium zone
 *         → output "Bearish" prediction and downside target, NOT a buy signal.
 * ══════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────

// Hurst thresholds
const HURST_TRENDING_MIN  = 0.55;  // H ≥ this → trend-following strategies OK
const HURST_CHOPPY_MAX    = 0.45;  // H ≤ this → market is choppy / mean-reverting
const HURST_WINDOW        = 64;    // candles used for R/S analysis (must be power-of-2 friendly)

// Breakout strategy IDs that are BLOCKED when market is choppy
const BREAKOUT_STRATEGIES = new Set(['smc_breakout', 'trend_continuation', 'news_momentum', 'liquidity_sweep']);

// Minimum weight floor — no indicator contributes less than this regardless of performance
const MIN_WEIGHT_FLOOR    = 5;   // points

// Dynamic tolerance range for OB / FVG proximity checks (as % of price)
const TOLERANCE_MIN_PCT   = 0.002;   // 0.2%
const TOLERANCE_MAX_PCT   = 0.005;   // 0.5%

// ATR period for volatility-scaled tolerance
const ATR_PERIOD          = 14;

// ─────────────────────────────────────────────────────────────────────────
//  SECTION 1: HELPER UTILITIES
// ─────────────────────────────────────────────────────────────────────────

/**
 * Clamp a number between min and max.
 */
function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

/**
 * Calculate ATR (Average True Range) for the last `period` candles.
 * candles: array of { high, low, close }  — newest last
 * Returns the ATR value as an absolute price number.
 */
function calcATR(candles, period = ATR_PERIOD) {
  if (!candles || candles.length < period + 1) return null;
  const slice = candles.slice(-(period + 1));
  let trueRanges = [];
  for (let i = 1; i < slice.length; i++) {
    const curr = slice[i], prev = slice[i - 1];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low  - prev.close)
    );
    trueRanges.push(tr);
  }
  return trueRanges.reduce((s, v) => s + v, 0) / trueRanges.length;
}

/**
 * DYNAMIC TOLERANCE
 * Scales the proximity buffer between TOLERANCE_MIN_PCT and TOLERANCE_MAX_PCT
 * based on current ATR / price ratio (higher volatility = wider buffer).
 *
 * Returns an absolute price buffer.  e.g. for BTC @ $65,000 with ATR $800:
 *   atrPct = 800/65000 = 1.23%  → clamped to 0.5%  → buffer = $325
 */
function getDynamicTolerance(currentPrice, atr) {
  if (!atr || !currentPrice || currentPrice <= 0) {
    return currentPrice * TOLERANCE_MIN_PCT;  // fallback: 0.2%
  }
  const atrPct   = atr / currentPrice;
  // Scale: if ATR is already wide (≥0.5% of price), use max tolerance
  const scaledPct = clamp(atrPct * 0.5, TOLERANCE_MIN_PCT, TOLERANCE_MAX_PCT);
  return currentPrice * scaledPct;
}

/**
 * Apply the MINIMUM WEIGHT FLOOR to an indicator-weight map.
 * rawWeights: { indicatorName: weightValue, … }
 * Returns a new map with all weights ≥ MIN_WEIGHT_FLOOR.
 */
function applyWeightFloor(rawWeights) {
  const result = {};
  for (const [k, v] of Object.entries(rawWeights || {})) {
    result[k] = Math.max(Number(v) || 0, MIN_WEIGHT_FLOOR);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
//  SECTION 2: HURST EXPONENT  (Rescaled Range / R/S method)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Compute the Hurst Exponent using the R/S (Rescaled Range) method.
 *
 * Algorithm:
 *   1. Convert close prices to log returns.
 *   2. For each sub-series of length n, compute mean-adjusted cumulative
 *      deviation, then R (range) / S (std dev).
 *   3. Run OLS on log(n) vs log(R/S) — the slope is H.
 *
 * @param {number[]} closes  — array of close prices, oldest first, min 32 values
 * @returns {{ H: number, regime: string }}
 */
function calcHurstExponent(closes) {
  const DEFAULT = { H: 0.5, regime: 'Random' };
  if (!closes || closes.length < 32) return DEFAULT;

  // Use the last HURST_WINDOW values
  const prices = closes.slice(-HURST_WINDOW);

  // Step 1: Log returns
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] <= 0) return DEFAULT;  // guard division by zero
    returns.push(Math.log(prices[i] / prices[i - 1]));
  }

  const n = returns.length;
  if (n < 8) return DEFAULT;

  // Step 2: Compute R/S for sub-series sizes [8, 16, 32, …] up to n
  const rsSeries = [];   // [ [log(len), log(RS)], … ]

  // We use sub-series lengths that are powers of 2
  let subLen = 8;
  while (subLen <= n / 2) {
    const rsValues = [];

    // Slide window across the returns array
    for (let start = 0; start + subLen <= n; start += subLen) {
      const sub  = returns.slice(start, start + subLen);
      const mean = sub.reduce((s, v) => s + v, 0) / sub.length;

      // Cumulative deviation from mean
      let cum = 0;
      const cumDevs = sub.map(v => (cum += v - mean, cum));

      const R = Math.max(...cumDevs) - Math.min(...cumDevs);  // range
      const variance = sub.reduce((s, v) => s + (v - mean) ** 2, 0) / sub.length;
      const S = Math.sqrt(variance);

      if (S > 0 && R >= 0) rsValues.push(R / S);
    }

    if (rsValues.length > 0) {
      const avgRS = rsValues.reduce((s, v) => s + v, 0) / rsValues.length;
      if (avgRS > 0) {
        rsSeries.push([Math.log(subLen), Math.log(avgRS)]);
      }
    }
    subLen *= 2;
  }

  if (rsSeries.length < 2) return DEFAULT;

  // Step 3: OLS regression of log(n) on log(R/S) → slope = H
  const xs = rsSeries.map(p => p[0]);
  const ys = rsSeries.map(p => p[1]);
  const xMean = xs.reduce((s, v) => s + v, 0) / xs.length;
  const yMean = ys.reduce((s, v) => s + v, 0) / ys.length;

  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }

  const H = den > 0 ? num / den : 0.5;
  const hClamped = clamp(H, 0, 1);

  let regime;
  if (hClamped >= HURST_TRENDING_MIN)  regime = 'Trending';
  else if (hClamped <= HURST_CHOPPY_MAX) regime = 'Choppy';
  else                                   regime = 'Ranging';

  return { H: parseFloat(hClamped.toFixed(4)), regime };
}

/**
 * CHOP FILTER
 * Returns true if the given strategy should be BLOCKED because the market
 * is in a choppy / mean-reverting regime.
 */
function isSignalBlockedByChopFilter(strategyId, regime) {
  // Only block breakout strategies in choppy markets
  return regime === 'Choppy' && BREAKOUT_STRATEGIES.has(strategyId);
}

// ─────────────────────────────────────────────────────────────────────────
//  SECTION 3: SMC STRUCTURE DETECTION
// ─────────────────────────────────────────────────────────────────────────

/**
 * Detect the most recent Order Blocks (OBs) from candle data.
 * An OB is the last bearish candle before a bullish ChoCH (bullish OB)
 * or the last bullish candle before a bearish ChoCH (bearish OB).
 *
 * Returns up to 3 bullish OBs and 3 bearish OBs sorted by recency.
 * Each OB: { type, high, low, midpoint, age, index }
 */
function detectOrderBlocks(candles, limit = 3) {
  if (!candles || candles.length < 10) return { bullish: [], bearish: [] };

  const bullishOBs = [];
  const bearishOBs = [];
  const n = candles.length;

  // Look for structure breaks — simplified ChoCH detection
  for (let i = 3; i < n - 2; i++) {
    const c  = candles[i];
    const c1 = candles[i - 1];
    const c2 = candles[i - 2];
    const c3 = candles[i + 1];  // confirmation candle

    // Bearish → Bullish flip: bearish candle (c2) before a bullish break
    // Bullish OB: the bearish candle just before the upward ChoCH
    const isBullishFlip = (
      c2.close < c2.open &&          // c2 is bearish
      c.close  > c.open  &&          // c is bullish
      c3.close > Math.max(c.high, c1.high)  // confirmation: break above
    );
    if (isBullishFlip && bullishOBs.length < limit) {
      bullishOBs.push({
        type:     'bullish',
        high:     c2.high,
        low:      c2.low,
        midpoint: (c2.high + c2.low) / 2,
        age:      n - 1 - i,
        index:    i,
      });
    }

    // Bullish → Bearish flip: bullish candle (c2) before a bearish break
    // Bearish OB: the bullish candle just before the downward ChoCH
    const isBearishFlip = (
      c2.close > c2.open &&          // c2 is bullish
      c.close  < c.open  &&          // c is bearish
      c3.close < Math.min(c.low, c1.low)  // confirmation: break below
    );
    if (isBearishFlip && bearishOBs.length < limit) {
      bearishOBs.push({
        type:     'bearish',
        high:     c2.high,
        low:      c2.low,
        midpoint: (c2.high + c2.low) / 2,
        age:      n - 1 - i,
        index:    i,
      });
    }
  }

  return { bullish: bullishOBs, bearish: bearishOBs };
}

/**
 * Detect Fair Value Gaps (FVGs) in the candle data.
 * FVG = gap between candle[i-1].high and candle[i+1].low (bullish FVG)
 *    or gap between candle[i-1].low  and candle[i+1].high (bearish FVG)
 *
 * Returns unfilled FVGs as { type, upper, lower, midpoint, age }.
 */
function detectFairValueGaps(candles, currentPrice, tolerance = 0) {
  if (!candles || candles.length < 5) return { bullish: [], bearish: [] };

  const bullishFVGs = [];
  const bearishFVGs = [];
  const n = candles.length;

  for (let i = 1; i < n - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];

    // Bullish FVG: gap between prev.high and next.low (impulse upward)
    if (next.low > prev.high && (curr.close > curr.open)) {
      const fvg = {
        type:     'bullish',
        upper:    next.low,
        lower:    prev.high,
        midpoint: (next.low + prev.high) / 2,
        age:      n - 1 - i,
      };
      // Only keep UNFILLED gaps (price hasn't revisited this zone)
      const filled = candles.slice(i + 2).some(c =>
        c.low <= fvg.upper + tolerance && c.high >= fvg.lower - tolerance
      );
      if (!filled) bullishFVGs.push(fvg);
    }

    // Bearish FVG: gap between prev.low and next.high (impulse downward)
    if (next.high < prev.low && (curr.close < curr.open)) {
      const fvg = {
        type:    'bearish',
        upper:   prev.low,
        lower:   next.high,
        midpoint:(prev.low + next.high) / 2,
        age:     n - 1 - i,
      };
      const filled = candles.slice(i + 2).some(c =>
        c.low <= fvg.upper + tolerance && c.high >= fvg.lower - tolerance
      );
      if (!filled) bearishFVGs.push(fvg);
    }
  }

  // Return up to 3 nearest unfilled gaps by midpoint proximity to current price
  const sort = (arr) => arr
    .sort((a, b) => Math.abs(a.midpoint - currentPrice) - Math.abs(b.midpoint - currentPrice))
    .slice(0, 3);

  return { bullish: sort(bullishFVGs), bearish: sort(bearishFVGs) };
}

// ─────────────────────────────────────────────────────────────────────────
//  SECTION 4: PREMIUM / DISCOUNT ZONE
// ─────────────────────────────────────────────────────────────────────────

/**
 * Determine if price is in a premium or discount zone relative to the
 * swing range.  SMC principle: buy discounts, sell premiums.
 *
 * Returns: 'discount' | 'premium' | 'equilibrium'
 */
function getPriceZone(currentPrice, swingHigh, swingLow) {
  if (!swingHigh || !swingLow || swingHigh <= swingLow) return 'equilibrium';
  const range  = swingHigh - swingLow;
  const pct    = (currentPrice - swingLow) / range;

  if (pct < 0.40) return 'discount';
  if (pct > 0.60) return 'premium';
  return 'equilibrium';
}

// ─────────────────────────────────────────────────────────────────────────
//  SECTION 5: LEADING vs. LAGGING  ← The Predictive Logic Core
// ─────────────────────────────────────────────────────────────────────────

/**
 * PREDICTIVE TREND EVALUATION
 *
 * This is the key differentiator from traditional lagging-indicator bots.
 *
 * Logic:
 * ─────
 * 1. If price is currently FALLING (bearish momentum):
 *    → Check if a Bullish OB exists BELOW current price within tolerance.
 *    → Check if a Bullish FVG magnet exists below.
 *    → If yes → PREDICTIVE BULLISH: price is likely to bounce off the OB.
 *       The target becomes the next bearish OB above (or swing high).
 *
 * 2. If price is currently RISING (bullish momentum):
 *    → Check if a Bearish OB exists ABOVE current price within tolerance.
 *    → Check if a Bearish FVG exists above.
 *    → If yes → PREDICTIVE BEARISH: price is likely to reject at the OB.
 *       The target becomes the next bullish OB below (or swing low).
 *
 * 3. If no SMC structure is nearby:
 *    → Fall back to Hurst regime + momentum direction.
 *
 * @param {object} params
 * @param {number}   params.currentPrice
 * @param {number}   params.atr
 * @param {object}   params.orderBlocks    — { bullish: OB[], bearish: OB[] }
 * @param {object}   params.fvgs           — { bullish: FVG[], bearish: FVG[] }
 * @param {number}   params.swingHigh      — recent swing high
 * @param {number}   params.swingLow       — recent swing low
 * @param {boolean}  params.isBearishMomentum  — last 3 candles net bearish
 * @param {string}   params.regime         — Hurst regime
 * @param {object}   params.weights        — floor-applied indicator weights
 *
 * @returns {PredictiveTrendResult}
 */
function evaluatePredictiveTrend(params) {
  const {
    currentPrice, atr, orderBlocks, fvgs,
    swingHigh, swingLow, isBearishMomentum, regime, weights,
  } = params;

  const tolerance = getDynamicTolerance(currentPrice, atr);
  const zone      = getPriceZone(currentPrice, swingHigh, swingLow);

  // ── Case A: Price is falling → look for bullish OB / FVG below ──────────
  if (isBearishMomentum) {
    // Find the nearest Bullish OB below (within tolerance or reachable in 4h)
    const nearBullishOB = orderBlocks.bullish.find(ob =>
      ob.high >= currentPrice - tolerance * 3 &&  // OB is just below or touching
      ob.low  <= currentPrice                   // price hasn't closed below OB low
    );

    const nearBullishFVG = fvgs.bullish.find(fvg =>
      fvg.upper >= currentPrice - tolerance * 3 &&
      fvg.lower <= currentPrice
    );

    const hasBullishSMC = nearBullishOB || nearBullishFVG;

    // Zone check: Bullish OBs in discount zone are higher probability
    const inDiscount = zone === 'discount';
    const obConfidence = (nearBullishOB ? weights['order_block'] || 15 : 0);
    const fvgConfidence = (nearBullishFVG ? weights['fvg'] || 10 : 0);
    const zoneBonus = inDiscount ? 10 : 0;

    if (hasBullishSMC) {
      // PREDICTIVE BULLISH — price falling into demand zone
      const structureRef  = nearBullishOB || nearBullishFVG;
      const targetAbove   = orderBlocks.bearish[0]
        ? orderBlocks.bearish[0].midpoint
        : swingHigh || currentPrice * 1.02;

      const uptickPct     = ((targetAbove - currentPrice) / currentPrice) * 100;
      const confidence    = clamp(obConfidence + fvgConfidence + zoneBonus, 10, 95);

      return {
        future_trend_4h:             'Bullish',
        ai_predicted_target_price:   parseFloat(targetAbove.toFixed(8)),
        predicted_upside_pct:        parseFloat(uptickPct.toFixed(2)),
        logic_reason:                `Price dropping into ${nearBullishOB ? 'Bullish OB' : 'Bullish FVG'} in ${zone} zone — predictive bounce expected`,
        smc_trigger:                 nearBullishOB ? 'order_block' : 'fvg',
        structure_ref_price:         structureRef.midpoint,
        confidence,
        is_leading:                  true,  // This is a predictive / leading signal
      };
    }
  }

  // ── Case B: Price is rising → look for bearish OB / FVG above ───────────
  if (!isBearishMomentum) {
    const nearBearishOB = orderBlocks.bearish.find(ob =>
      ob.low  <= currentPrice + tolerance * 3 &&
      ob.high >= currentPrice
    );

    const nearBearishFVG = fvgs.bearish.find(fvg =>
      fvg.lower <= currentPrice + tolerance * 3 &&
      fvg.upper >= currentPrice
    );

    const hasBearishSMC = nearBearishOB || nearBearishFVG;
    const inPremium     = zone === 'premium';
    const obConfidence  = (nearBearishOB  ? weights['order_block'] || 15 : 0);
    const fvgConfidence = (nearBearishFVG ? weights['fvg'] || 10 : 0);
    const zoneBonus     = inPremium ? 10 : 0;

    if (hasBearishSMC) {
      // PREDICTIVE BEARISH — price rising into supply zone
      const structureRef  = nearBearishOB || nearBearishFVG;
      const targetBelow   = orderBlocks.bullish[0]
        ? orderBlocks.bullish[0].midpoint
        : swingLow || currentPrice * 0.98;

      const downtickPct   = ((targetBelow - currentPrice) / currentPrice) * 100;
      const confidence    = clamp(obConfidence + fvgConfidence + zoneBonus, 10, 95);

      return {
        future_trend_4h:             'Bearish',
        ai_predicted_target_price:   parseFloat(targetBelow.toFixed(8)),
        predicted_upside_pct:        parseFloat(downtickPct.toFixed(2)),
        logic_reason:                `Price rising into ${nearBearishOB ? 'Bearish OB' : 'Bearish FVG'} in ${zone} zone — predictive rejection expected`,
        smc_trigger:                 nearBearishOB ? 'order_block' : 'fvg',
        structure_ref_price:         structureRef.midpoint,
        confidence,
        is_leading:                  true,
      };
    }
  }

  // ── Case C: No SMC confluence → Hurst regime fallback ───────────────────
  let fallbackTrend = 'Neutral';
  let fallbackTarget = currentPrice;
  if (regime === 'Trending') {
    fallbackTrend  = isBearishMomentum ? 'Bearish' : 'Bullish';
    fallbackTarget = isBearishMomentum
      ? swingLow  || currentPrice * 0.985
      : swingHigh || currentPrice * 1.015;
  }

  return {
    future_trend_4h:           fallbackTrend,
    ai_predicted_target_price: parseFloat(fallbackTarget.toFixed(8)),
    predicted_upside_pct:      parseFloat(((fallbackTarget - currentPrice) / currentPrice * 100).toFixed(2)),
    logic_reason:              `No SMC structure nearby — Hurst regime: ${regime}`,
    smc_trigger:               null,
    structure_ref_price:       null,
    confidence:                25,   // low confidence for fallback
    is_leading:                false,
  };
}

// ─────────────────────────────────────────────────────────────────────────
//  SECTION 6: SWING HIGH / LOW DETECTION
// ─────────────────────────────────────────────────────────────────────────

/**
 * Find the swing high and swing low over the last `lookback` candles.
 */
function getSwings(candles, lookback = 50) {
  const slice = candles.slice(-lookback);
  const swingHigh = Math.max(...slice.map(c => c.high));
  const swingLow  = Math.min(...slice.map(c => c.low));
  return { swingHigh, swingLow };
}

/**
 * Determine if the last N candles are net bearish.
 */
function isBearish(candles, n = 4) {
  const slice = candles.slice(-n);
  const netMove = slice[slice.length - 1].close - slice[0].open;
  return netMove < 0;
}

// ─────────────────────────────────────────────────────────────────────────
//  SECTION 7: MAIN ENTRY POINT — runPredictiveBrain()
// ─────────────────────────────────────────────────────────────────────────

/**
 * Full Predictive Brain analysis for a single coin.
 *
 * @param {object} input
 * @param {string}   input.coinPair        — e.g. 'BTCUSDT'
 * @param {number}   input.currentPrice    — latest price
 * @param {object[]} input.candles4h       — OHLCV array for 4h TF (newest last)
 *                                           Each: { open, high, low, close, volume, time }
 * @param {object}   [input.rawWeights]    — adaptive weights from dynamicWeights.js
 *                                           (optional, falls back to defaults)
 * @param {string}   [input.activeStrategy]— the strategy currently active for this coin
 *
 * @returns {PredictiveBrainResult}
 */
function runPredictiveBrain({ coinPair, currentPrice, candles4h, rawWeights = {}, activeStrategy = null }) {

  // ── Guard ──────────────────────────────────────────────────────────────
  if (!candles4h || candles4h.length < 35) {
    return {
      ok:      false,
      error:   `Insufficient candle data for ${coinPair} (need ≥35, got ${candles4h?.length ?? 0})`,
      coinPair,
    };
  }

  // ── 1. Apply Minimum Weight Floor ─────────────────────────────────────
  const weights = applyWeightFloor({
    order_block:     rawWeights.orderBlock    || 20,
    fvg:             rawWeights.fvg           || 18,
    choch:           rawWeights.choch         || 16,
    liquidity_sweep: rawWeights.liquiditySweep|| 14,
    rsi:             rawWeights.rsi           || 12,
    macd:            rawWeights.macd          || 10,
    ema_ribbon:      rawWeights.emaRibbon     || 10,
    volume:          rawWeights.volume        || 8,
    atr:             rawWeights.atr           || 8,
    funding:         rawWeights.funding       || 6,
    btc_corr:        rawWeights.btcCorr       || 6,
    // Any weight < MIN_WEIGHT_FLOOR (5) will be raised to 5 by applyWeightFloor
  });

  // ── 2. ATR for dynamic tolerance ──────────────────────────────────────
  const atr       = calcATR(candles4h, ATR_PERIOD);
  const tolerance = getDynamicTolerance(currentPrice, atr);

  // ── 3. Hurst Exponent → Market Regime → Chop Filter ──────────────────
  const closes    = candles4h.map(c => c.close);
  const { H, regime } = calcHurstExponent(closes);

  const signalBlocked = activeStrategy
    ? isSignalBlockedByChopFilter(activeStrategy, regime)
    : false;

  // ── 4. SMC Structure Detection ─────────────────────────────────────────
  const orderBlocks = detectOrderBlocks(candles4h, 3);
  const fvgs        = detectFairValueGaps(candles4h, currentPrice, tolerance);
  const { swingHigh, swingLow } = getSwings(candles4h, 50);

  // ── 5. Predictive Trend (Leading, not Lagging) ─────────────────────────
  const bearishMomentum = isBearish(candles4h, 4);
  const predictive = evaluatePredictiveTrend({
    currentPrice,
    atr,
    orderBlocks,
    fvgs,
    swingHigh,
    swingLow,
    isBearishMomentum: bearishMomentum,
    regime,
    weights,
  });

  // ── 6. Trend Strength (qualitative label) ─────────────────────────────
  let trendLabel = predictive.future_trend_4h;
  if (predictive.future_trend_4h === 'Bullish' && predictive.confidence >= 65) {
    trendLabel = 'Strongly Bullish';
  } else if (predictive.future_trend_4h === 'Bearish' && predictive.confidence >= 65) {
    trendLabel = 'Strongly Bearish';
  }

  // ── 7. Assemble Result ─────────────────────────────────────────────────
  return {
    ok: true,
    coinPair,
    current_price:             currentPrice,
    ai_predicted_target_price: predictive.ai_predicted_target_price,
    predicted_upside_pct:      predictive.predicted_upside_pct,
    future_trend_4h:           trendLabel,
    market_regime:             regime,
    hurst_exponent:            H,
    signal_blocked:            signalBlocked,
    confidence:                predictive.confidence,
    logic_reason:              predictive.logic_reason,
    is_leading_signal:         predictive.is_leading,
    smc_trigger:               predictive.smc_trigger,
    structure_ref_price:       predictive.structure_ref_price,
    atr:                       atr ? parseFloat(atr.toFixed(8)) : null,
    dynamic_tolerance:         parseFloat(tolerance.toFixed(8)),
    swing_high:                swingHigh,
    swing_low:                 swingLow,
    price_zone:                getPriceZone(currentPrice, swingHigh, swingLow),
    order_blocks:              orderBlocks,
    fvgs,
    applied_weights:           weights,
    analysed_at:               new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────────────────────────────────

module.exports = {
  runPredictiveBrain,
  calcHurstExponent,
  getDynamicTolerance,
  applyWeightFloor,
  detectOrderBlocks,
  detectFairValueGaps,
  isSignalBlockedByChopFilter,
  evaluatePredictiveTrend,
  // Constants (useful for tests)
  HURST_TRENDING_MIN,
  HURST_CHOPPY_MAX,
  MIN_WEIGHT_FLOOR,
  TOLERANCE_MIN_PCT,
  TOLERANCE_MAX_PCT,
};
