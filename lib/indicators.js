// ============================================================
// ✅ UPGRADED indicators.js - Apex MD Trading Helper
// Added: Harmonic Pattern Scanner & ICT Silver Bullet
// ============================================================

// ── Pro Custom Mode config ────────────────────────────────────
let _cfg;
function _getConfig() {
    if (!_cfg) { try { _cfg = require('../config'); } catch (_) { _cfg = null; } }
    return _cfg;
}
/** Returns effective value: custom (if proMode ON) else built-in default. */
function _p(key, builtIn) {
    const c = _getConfig();
    if (c && c.modes && c.modes.proMode && c.indicators && key in c.indicators) {
        return c.indicators[key];
    }
    return builtIn;
}
/** Same but for smc section */
function _smc(key, builtIn) {
    const c = _getConfig();
    if (c && c.modes && c.modes.proMode && c.smc && key in c.smc) {
        return c.smc[key];
    }
    return builtIn;
}
/** Same but for targets section */
function _tgt(key, builtIn) {
    const c = _getConfig();
    if (c && c.modes && c.modes.proMode && c.targets && key in c.targets) {
        return c.targets[key];
    }
    return builtIn;
}

function calculateRSI(candles, period) {
    period = period !== undefined ? period : _p('RSI_PERIOD', 14);
    if (candles.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        let change = parseFloat(candles[i][4]) - parseFloat(candles[i - 1][4]);
        if (change > 0) gains += change;
        else losses -= change;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < candles.length; i++) {
        let change = parseFloat(candles[i][4]) - parseFloat(candles[i - 1][4]);
        avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    }
    if (avgLoss === 0) return 100;
    let rs = avgGain / avgLoss;
    return parseFloat((100 - (100 / (1 + rs))).toFixed(2));
}

function calculateEMA(candles, period = 50, returnArray = false) {
    if (candles.length < period) return returnArray ? [] : 0;
    const k = 2 / (period + 1);
    let emaArray = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += parseFloat(candles[i][4]);
    let ema = sum / period;
    emaArray.push(ema);
    for (let i = period; i < candles.length; i++) {
        ema = (parseFloat(candles[i][4]) - ema) * k + ema;
        emaArray.push(ema);
    }
    return returnArray ? emaArray : ema.toFixed(4);
}

function calculateATR(candles, period) {
    period = period !== undefined ? period : _p('ATR_PERIOD', 14);
    // ✅ FIXED: Wilder's Smoothed ATR (matches TradingView)
    // Simple average was 10-15% off. Wilder's smoothing is the standard.
    if (candles.length < period + 2) return 0;
    
    // Seed: first ATR = simple average of first 'period' TRs
    let trValues = [];
    for (let i = 1; i < candles.length; i++) {
        let high = parseFloat(candles[i][2]), low = parseFloat(candles[i][3]), prevClose = parseFloat(candles[i-1][4]);
        trValues.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    if (trValues.length < period) return 0;
    
    // First ATR = simple mean of first 'period' TRs
    let atr = trValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
    
    // Wilder's smoothing for remaining TRs
    for (let i = period; i < trValues.length; i++) {
        atr = (atr * (period - 1) + trValues[i]) / period;
    }
    return isFinite(atr) ? atr.toFixed(4) : 0;
}

function checkDivergence(candles) {
    // ✅ FIXED: Swing pivot-based divergence (not fixed offset comparison)
    // Finds actual swing lows/highs and compares RSI at those exact points
    if (candles.length < 35) return "None";

    const closes = candles.map(c => parseFloat(c[4]));
    const lows   = candles.map(c => parseFloat(c[3]));
    const highs  = candles.map(c => parseFloat(c[2]));
    const n = closes.length;

    // Find last 2 swing lows (for bullish divergence)
    const swingLows = [];
    for (let i = 3; i < n - 2; i++) {
        if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2]) {
            swingLows.push(i);
        }
    }
    // Find last 2 swing highs (for bearish divergence)
    const swingHighs = [];
    for (let i = 3; i < n - 2; i++) {
        if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2]) {
            swingHighs.push(i);
        }
    }

    // Bullish Divergence: price lower low + RSI higher low
    if (swingLows.length >= 2) {
        const sl1 = swingLows[swingLows.length - 2];
        const sl2 = swingLows[swingLows.length - 1];
        if (sl2 - sl1 >= 5) { // at least 5 bars apart
            const rsi1 = calculateRSI(candles.slice(Math.max(0, sl1 - 14), sl1 + 1), 14);
            const rsi2 = calculateRSI(candles.slice(Math.max(0, sl2 - 14), sl2 + 1), 14);
            if (lows[sl2] < lows[sl1] && rsi2 > rsi1 && rsi2 < 50) {
                return "Bullish Divergence 🚀";
            }
        }
    }
    // Bearish Divergence: price higher high + RSI lower high
    if (swingHighs.length >= 2) {
        const sh1 = swingHighs[swingHighs.length - 2];
        const sh2 = swingHighs[swingHighs.length - 1];
        if (sh2 - sh1 >= 5) {
            const rsi1 = calculateRSI(candles.slice(Math.max(0, sh1 - 14), sh1 + 1), 14);
            const rsi2 = calculateRSI(candles.slice(Math.max(0, sh2 - 14), sh2 + 1), 14);
            if (highs[sh2] > highs[sh1] && rsi2 < rsi1 && rsi2 > 50) {
                return "Bearish Divergence ⚠️";
            }
        }
    }
    return "None";
}

function checkCandlePattern(candles) {
    if (candles.length < 3) return "Neutral";
    const last = candles[candles.length - 1], prev = candles[candles.length - 2];
    const lOpen = parseFloat(last[1]), lHigh = parseFloat(last[2]), lLow = parseFloat(last[3]), lClose = parseFloat(last[4]);
    const pOpen = parseFloat(prev[1]), pClose = parseFloat(prev[4]);
    const isLGreen = lClose > lOpen, isLRed = lClose < lOpen;
    const isPGreen = pClose > pOpen, isPRed = pClose < pOpen;
    if (isPRed && isLGreen && lClose > pOpen && lOpen < pClose) return "Bullish Engulfing 🟢";
    if (isPGreen && isLRed && lClose < pOpen && lOpen > pClose) return "Bearish Engulfing 🔴";
    const lBody = Math.abs(lClose - lOpen);
    const lLowerWick = isLGreen ? lOpen - lLow : lClose - lLow;
    const lUpperWick = isLGreen ? lHigh - lClose : lHigh - lOpen;
    if (lLowerWick > lBody * 2 && lUpperWick < lBody * 0.5) return "Hammer 🟢";
    if (lUpperWick > lBody * 2 && lLowerWick < lBody * 0.5) return "Shooting Star 🔴";
    return "Neutral";
}

function calculatePOC(candles) {
    if (candles.length < 10) return "Unknown";
    let bins = 20;
    let maxPrice = Math.max(...candles.map(c => parseFloat(c[2])));
    let minPrice = Math.min(...candles.map(c => parseFloat(c[3])));
    let binSize = (maxPrice - minPrice) / bins;
    if (binSize === 0) return maxPrice.toFixed(2);
    let volumeProfile = new Array(bins).fill(0);
    for (let c of candles) {
        let typicalPrice = (parseFloat(c[2]) + parseFloat(c[3]) + parseFloat(c[4])) / 3;
        let volume = parseFloat(c[5]);
        let binIndex = Math.floor((typicalPrice - minPrice) / binSize);
        if (binIndex >= bins) binIndex = bins - 1;
        volumeProfile[binIndex] += volume;
    }
    let maxVolIndex = volumeProfile.indexOf(Math.max(...volumeProfile));
    return (minPrice + (maxVolIndex * binSize) + (binSize / 2)).toFixed(2);
}

function calculateMACD(candles) {
    if (candles.length < 35) return "Unknown";
    // Both EMAs on same full dataset (correct MACD calculation)
    const fastP   = _p('MACD_FAST',   12);
    const slowP   = _p('MACD_SLOW',   26);
    const signalP = _p('MACD_SIGNAL',  9);
    const ema12Arr = calculateEMA(candles, fastP, true);
    const ema26Arr = calculateEMA(candles, slowP, true);
    if (!ema12Arr.length || !ema26Arr.length) return "Unknown";
    
    // MACD line = EMA12 - EMA26 (latest values)
    const macdLine = ema12Arr[ema12Arr.length - 1] - ema26Arr[ema26Arr.length - 1];
    const prevMacdLine = ema12Arr.length > 1 && ema26Arr.length > 1
        ? ema12Arr[ema12Arr.length - 2] - ema26Arr[ema26Arr.length - 2]
        : macdLine;
    
    // ✅ FIXED: Signal line = proper 9-period EMA of MACD line (not simple average)
    const macdHistory = ema12Arr.slice(-(ema26Arr.length)).map((v, i) => v - ema26Arr[i]);
    let signalLine = macdLine;
    if (macdHistory.length >= signalP) {
        const sigK = 2 / (signalP + 1);
        let sig = macdHistory.slice(0, signalP).reduce((a, b) => a + b, 0) / signalP; // seed
        for (let i = signalP; i < macdHistory.length; i++) {
            sig = (macdHistory[i] - sig) * sigK + sig;
        }
        signalLine = sig;
    }
    
    const histogram = macdLine - signalLine;
    const isBullCross = macdLine > signalLine && prevMacdLine <= signalLine;
    const isBearCross = macdLine < signalLine && prevMacdLine >= signalLine;
    
    if (isBullCross) return `Bullish Cross 🟢 (${macdLine.toFixed(4)})`;
    if (isBearCross) return `Bearish Cross 🔴 (${macdLine.toFixed(4)})`;
    return macdLine > 0 ? `Bullish 🟢 (${macdLine.toFixed(4)})` : `Bearish 🔴 (${macdLine.toFixed(4)})`;
}

function calculateVWAP(candles) {
    if (candles.length < 5) return "Unknown";
    const lastCandleTime = parseInt(candles[candles.length - 1][0]);
    const dayStart = new Date(new Date(lastCandleTime).setUTCHours(0, 0, 0, 0)).getTime();
    let dailyCandles = candles.filter(c => parseInt(c[0]) >= dayStart);
    if (dailyCandles.length < 3) dailyCandles = candles.slice(-20);
    let cumTypPriceVol = 0, cumVol = 0;
    for (let c of dailyCandles) {
        let typicalPrice = (parseFloat(c[2]) + parseFloat(c[3]) + parseFloat(c[4])) / 3;
        let volume = parseFloat(c[5]);
        cumTypPriceVol += typicalPrice * volume;
        cumVol += volume;
    }
    if (cumVol === 0) return "Unknown";
    let vwap = cumTypPriceVol / cumVol;
    let lastClose = parseFloat(candles[candles.length - 1][4]);
    return lastClose > vwap ? `Above VWAP 🟢 ($${vwap.toFixed(2)})` : `Below VWAP 🔴 ($${vwap.toFixed(2)})`;
}

function checkVolumeBreakout(candles) {
    if (candles.length < 25) return "Consolidating";
    let vols = candles.map(c => parseFloat(c[5]));
    let avgVol = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    let lastVol = vols[vols.length - 1];
    let lastClose = parseFloat(candles[candles.length - 1][4]);
    let prevHigh = Math.max(...candles.slice(-21, -1).map(c => parseFloat(c[2])));
    let prevLow = Math.min(...candles.slice(-21, -1).map(c => parseFloat(c[3])));
    if (lastClose > prevHigh && lastVol > avgVol * 1.5) return "Bullish Breakout 🚀 (High Volume)";
    if (lastClose < prevLow && lastVol > avgVol * 1.5) return "Bearish Breakout 🩸 (High Volume)";
    if (lastClose > prevHigh || lastClose < prevLow) return "Fakeout Warning ⚠️ (Low Volume Breakout)";
    return "Consolidating ⏳";
}

function validateEntryPoint(entryPrice, currentPrice, direction) {
    const entry = parseFloat(entryPrice), current = parseFloat(currentPrice);
    const diff = Math.abs(entry - current) / current * 100;
    if (direction === 'LONG') {
        if (entry > current * 1.005) return { valid: false, warning: `⚠️ *ENTRY WARNING:* Signal Entry ($${entry}) current price ($${current}) ට ${diff.toFixed(2)}% ඉහළයි! Market Order ගන්න එපා.` };
        if (entry < current * 0.97) return { valid: true, warning: `⏳ *ENTRY NOTE:* Entry ($${parseFloat(entry).toFixed(4)}) current price ($${parseFloat(current).toFixed(4)}) ට ${diff.toFixed(2)}% පහළයි. Limit Order set කරන්න.` };
    }
    if (direction === 'SHORT') {
        if (entry < current * 0.995) return { valid: false, warning: `⚠️ *ENTRY WARNING:* Signal Entry ($${entry}) current price ($${current}) ට ${diff.toFixed(2)}% පහළයි! Market Order ගන්න එපා.` };
        if (entry > current * 1.03) return { valid: true, warning: `⏳ *ENTRY NOTE:* Entry ($${parseFloat(entry).toFixed(4)}) current price ($${parseFloat(current).toFixed(4)}) ට ${diff.toFixed(2)}% ඉහළයි.` };
    }
    return { valid: true, warning: "" };
}

function confirmEntry5m(candles5m, direction) {
    if (!candles5m || candles5m.length < 20) return { confirmed: false, score: 0, reason: "5m data insufficient" };
    const rsi5m = calculateRSI(candles5m.slice(-20), 14);
    const ema21_5m = parseFloat(calculateEMA(candles5m.slice(-25), 21));
    const pattern5m = checkCandlePattern(candles5m.slice(-5));
    const lastClose = parseFloat(candles5m[candles5m.length - 1][4]);
    const lastOpen = parseFloat(candles5m[candles5m.length - 1][1]);
    const prevClose = parseFloat(candles5m[candles5m.length - 2][4]);

    let score = 0, reasons = [], warnings = [];
    if (direction === 'LONG') {
        if (lastClose > ema21_5m) { score++; reasons.push("5m above EMA21"); } else warnings.push("5m below EMA21 ⚠️");
        if (rsi5m > 25 && rsi5m < 60) { score++; reasons.push(`5m RSI ok (${rsi5m})`); } else warnings.push(`5m RSI warning (${rsi5m})`);
        if (lastClose > lastOpen) { score++; reasons.push("5m bullish candle"); } else warnings.push("5m bearish candle");
        if (pattern5m.includes('🟢')) { score++; reasons.push(`5m ${pattern5m}`); }
        if (lastClose > prevClose) { score++; reasons.push("5m momentum up"); }
    } else { 
        if (lastClose < ema21_5m) { score++; reasons.push("5m below EMA21"); } else warnings.push("5m above EMA21 ⚠️");
        if (rsi5m > 40 && rsi5m < 75) { score++; reasons.push(`5m RSI ok (${rsi5m})`); } else warnings.push(`5m RSI warning (${rsi5m})`);
        if (lastClose < lastOpen) { score++; reasons.push("5m bearish candle"); } else warnings.push("5m bullish candle");
        if (pattern5m.includes('🔴')) { score++; reasons.push(`5m ${pattern5m}`); }
        if (lastClose < prevClose) { score++; reasons.push("5m momentum down"); }
    }
    const confirmed = score >= 3;
    const status = confirmed ? `✅ 5m ALIGNED (${score}/5) - Entry confirmed!\n   ✔️ ${reasons.join(' | ')}` : `⚠️ 5m NOT ALIGNED (${score}/5) - Wait for 5m confirmation\n   ❌ ${warnings.join(' | ')}`;
    return { confirmed, score, maxScore: 5, reasons, warnings, status };
}

function checkRRR(entryPrice, tpPrice, slPrice, minRRR = 1.5) {
    const entry = parseFloat(entryPrice), tp = parseFloat(tpPrice), sl = parseFloat(slPrice);
    const reward = Math.abs(tp - entry), risk = Math.abs(entry - sl);
    if (risk === 0) return { pass: false, rrr: 0, reason: "SL = Entry! Risk is 0." };
    const rrr = reward / risk;
    const pass = rrr >= minRRR;
    return {
        pass, rrr: rrr.toFixed(2), reward: reward.toFixed(2), risk: risk.toFixed(2),
        reason: pass ? `✅ RRR 1:${rrr.toFixed(2)} ≥ minimum 1:${minRRR} - Trade valid` : `❌ RRR 1:${rrr.toFixed(2)} < minimum 1:${minRRR} - Trade rejected! TP extend කරන්න හෝ SL tight කරන්න.`
    };
}

function calculateADX(candles, period) {
    period = period !== undefined ? period : _p('ADX_PERIOD', 14);
    // ✅ FIXED: Proper Wilder's smoothed ADX (matches TradingView)
    if (candles.length < period * 2 + 1) return { adx: 20, isStrong: false, status: "Weak Trend ⚠️ (20.0)", plusDI: 0, minusDI: 0 };

    let trArr = [], plusDMArr = [], minusDMArr = [];
    for (let i = 1; i < candles.length; i++) {
        const high = parseFloat(candles[i][2]), low = parseFloat(candles[i][3]);
        const prevHigh = parseFloat(candles[i-1][2]), prevLow = parseFloat(candles[i-1][3]), prevClose = parseFloat(candles[i-1][4]);
        const upMove = high - prevHigh, downMove = prevLow - low;
        trArr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
        plusDMArr.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDMArr.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }
    if (trArr.length < period) return { adx: 20, isStrong: false, status: "Weak Trend ⚠️ (20.0)" };

    // Wilder's smoothed sums (seed = sum of first 'period' values)
    let smTR    = trArr.slice(0, period).reduce((a, b) => a + b, 0);
    let smPlus  = plusDMArr.slice(0, period).reduce((a, b) => a + b, 0);
    let smMinus = minusDMArr.slice(0, period).reduce((a, b) => a + b, 0);

    let dxArr = [];
    for (let i = period; i < trArr.length; i++) {
        smTR    = smTR - (smTR / period) + trArr[i];
        smPlus  = smPlus - (smPlus / period) + plusDMArr[i];
        smMinus = smMinus - (smMinus / period) + minusDMArr[i];
        const pDI = smTR > 0 ? (smPlus / smTR) * 100 : 0;
        const mDI = smTR > 0 ? (smMinus / smTR) * 100 : 0;
        const diSum = pDI + mDI;
        dxArr.push(diSum > 0 ? (Math.abs(pDI - mDI) / diSum) * 100 : 0);
    }

    // ADX = smoothed DX (Wilder's)
    let adx = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < dxArr.length; i++) {
        adx = (adx * (period - 1) + dxArr[i]) / period;
    }
    if (isNaN(adx) || !isFinite(adx)) adx = 20;

    // Final +DI / -DI for display
    const lastPDI = smTR > 0 ? (smPlus / smTR) * 100 : 0;
    const lastMDI = smTR > 0 ? (smMinus / smTR) * 100 : 0;

    return {
        value: parseFloat(adx.toFixed(2)),
        isStrong: adx >= 25,
        plusDI: parseFloat(lastPDI.toFixed(2)),
        minusDI: parseFloat(lastMDI.toFixed(2)),
        status: adx >= 40 ? `Strong Trend 🔥 (${adx.toFixed(1)})` :
                adx >= 25 ? `Trending 📈 (${adx.toFixed(1)})` :
                adx >= 15 ? `Weak Trend ⚠️ (${adx.toFixed(1)})` : `Choppy/Ranging 🔄 (${adx.toFixed(1)})`
    };
}

// ============================================================
// ✅ NEW FEATURE 1: Harmonic Pattern Scanner (Gartley & Bat)
// ============================================================
function checkHarmonicPattern(candles) {
    // ✅ FIXED: Proper 5-point harmonic structure (X, A, B, C, D)
    // Gartley: XA retracement B=0.618, D=0.786 of XA
    // Bat:     XA retracement B=0.382-0.5, D=0.886 of XA
    // Butterfly: B=0.786 of XA, D=1.272+ of XA (extension)
    if (candles.length < 40) return "None";

    const highs  = candles.map(c => parseFloat(c[2]));
    const lows   = candles.map(c => parseFloat(c[3]));
    const closes = candles.map(c => parseFloat(c[4]));
    const n      = closes.length;
    const currentPrice = closes[n - 1];

    // Find swing pivots (local highs & lows)
    const swingHighIdx = [], swingLowIdx = [];
    for (let i = 2; i < n - 2; i++) {
        if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2]) swingHighIdx.push(i);
        if (lows[i]  < lows[i-1]  && lows[i]  < lows[i-2]  && lows[i]  < lows[i+1]  && lows[i]  < lows[i+2])  swingLowIdx.push(i);
    }
    if (swingHighIdx.length < 2 || swingLowIdx.length < 2) return "None";

    const tolerance = 0.03; // 3% tolerance on fib ratios

    function fibMatch(ratio, target, tol = tolerance) {
        return Math.abs(ratio - target) <= tol;
    }

    // Check Bullish patterns (price near recent swing low = D point)
    const recentLows = swingLowIdx.slice(-3);
    const recentHighs = swingHighIdx.slice(-3);

    for (let xi = 0; xi < recentHighs.length - 1; xi++) {
        for (let ai = 0; ai < recentLows.length; ai++) {
            const X = highs[recentHighs[xi]];
            const A = lows[recentLows[ai]];
            if (recentLows[ai] <= recentHighs[xi]) continue; // A must come after X
            const XA = X - A;
            if (XA <= 0) continue;

            // B retracement of XA
            for (let bi = 0; bi < recentHighs.length; bi++) {
                if (recentHighs[bi] <= recentLows[ai]) continue;
                const B = highs[recentHighs[bi]];
                const XB = (X - B) / XA;

                // Gartley B = 0.618
                if (fibMatch(XB, 0.618, 0.05)) {
                    // D should be at 0.786 of XA from X (below A)
                    const dGartley = X - XA * 0.786;
                    if (currentPrice >= dGartley * 0.985 && currentPrice <= dGartley * 1.015) {
                        return "Bullish Gartley 🦋 PRZ";
                    }
                }
                // Bat B = 0.382-0.50
                if (XB >= 0.35 && XB <= 0.55) {
                    const dBat = X - XA * 0.886;
                    if (currentPrice >= dBat * 0.985 && currentPrice <= dBat * 1.015) {
                        return "Bullish Bat 🦇 PRZ";
                    }
                }
                // Butterfly B = 0.786 → D extends beyond X (1.272-1.618 of XA)
                if (fibMatch(XB, 0.786, 0.05)) {
                    const dButterfly = X - XA * 1.272;
                    if (currentPrice >= dButterfly * 0.985 && currentPrice <= dButterfly * 1.015) {
                        return "Bullish Butterfly 🦋 PRZ";
                    }
                }
            }
        }
    }

    // Check Bearish patterns (price near recent swing high = D point)
    for (let xi = 0; xi < recentLows.length - 1; xi++) {
        for (let ai = 0; ai < recentHighs.length; ai++) {
            const X = lows[recentLows[xi]];
            const A = highs[recentHighs[ai]];
            if (recentHighs[ai] <= recentLows[xi]) continue;
            const XA = A - X;
            if (XA <= 0) continue;

            for (let bi = 0; bi < recentLows.length; bi++) {
                if (recentLows[bi] <= recentHighs[ai]) continue;
                const B = lows[recentLows[bi]];
                const XB = (B - X) / XA;

                if (fibMatch(XB, 0.618, 0.05)) {
                    const dGartley = X + XA * 0.786;
                    if (currentPrice >= dGartley * 0.985 && currentPrice <= dGartley * 1.015) {
                        return "Bearish Gartley 🦋 PRZ";
                    }
                }
                if (XB >= 0.35 && XB <= 0.55) {
                    const dBat = X + XA * 0.886;
                    if (currentPrice >= dBat * 0.985 && currentPrice <= dBat * 1.015) {
                        return "Bearish Bat 🦇 PRZ";
                    }
                }
                if (fibMatch(XB, 0.786, 0.05)) {
                    const dButterfly = X + XA * 1.272;
                    if (currentPrice >= dButterfly * 0.985 && currentPrice <= dButterfly * 1.015) {
                        return "Bearish Butterfly 🦋 PRZ";
                    }
                }
            }
        }
    }
    return "None";
}

// ============================================================
// ✅ NEW FEATURE 2: ICT Silver Bullet Time & FVG Checker
// ============================================================
function checkICTSilverBullet(candles) {
    if (candles.length < 5) return "None";
    
    // ✅ FIXED: DST-aware EST/EDT conversion
    // US DST: 2nd Sunday March → 1st Sunday November (UTC-4)
    // US Standard: rest of year (UTC-5)
    const now = new Date();
    const year = now.getUTCFullYear();

    // 2nd Sunday of March
    const marchStart = new Date(Date.UTC(year, 2, 1));
    const marchDay = marchStart.getUTCDay(); // 0=Sun
    const dstStart = new Date(Date.UTC(year, 2, (14 - marchDay) % 7 + 8)); // 2nd Sunday

    // 1st Sunday of November
    const novStart = new Date(Date.UTC(year, 10, 1));
    const novDay = novStart.getUTCDay();
    const dstEnd = new Date(Date.UTC(year, 10, (7 - novDay) % 7 + 1)); // 1st Sunday

    const isDST = now >= dstStart && now < dstEnd;
    const estOffset = isDST ? 4 : 5; // EDT = UTC-4, EST = UTC-5

    const estHour = (now.getUTCHours() - estOffset + 24) % 24;
    const estMin  = now.getUTCMinutes();

    // Silver Bullet windows: 10:00-11:00 AM EST & 2:00-3:00 PM EST
    const isSilverBulletTime =
        (estHour === 10) ||
        (estHour === 14);

    if (!isSilverBulletTime) return "None";

    // Silver Bullet වෙලාව ඇතුළේ FVG (Fair Value Gap) එකක් හැදිලා තියෙනවද බලනවා
    let fvg = "None";
    for (let i = candles.length - 4; i < candles.length - 1; i++) {
        let c1High = parseFloat(candles[i-2][2]), c3Low = parseFloat(candles[i][3]);
        let c1Low = parseFloat(candles[i-2][3]), c3High = parseFloat(candles[i][2]);
        if (c1High < c3Low) fvg = "Bullish FVG";
        if (c1Low > c3High) fvg = "Bearish FVG";
    }

    if (fvg === "Bullish FVG") return "Bullish Silver Bullet 🎯";
    if (fvg === "Bearish FVG") return "Bearish Silver Bullet 🎯";

    return "Active Time (No FVG)";
}


// ============================================================
// ✅ NEW: Stochastic RSI - RSI ට වඩා sensitive signal
// Returns: { k, d, signal } — overbought > 80, oversold < 20
// ============================================================
function calculateStochRSI(candles, rsiPeriod = 14, stochPeriod = 14, smoothK = 3, smoothD = 3) {
    if (candles.length < rsiPeriod + stochPeriod + smoothK + 5) return { k: 50, d: 50, signal: "Neutral" };
    
    // Calculate RSI array
    const rsiArr = [];
    for (let i = rsiPeriod; i <= candles.length; i++) {
        rsiArr.push(calculateRSI(candles.slice(0, i), rsiPeriod));
    }
    
    if (rsiArr.length < stochPeriod) return { k: 50, d: 50, signal: "Neutral" };
    
    // Stochastic of RSI
    const rawK = [];
    for (let i = stochPeriod - 1; i < rsiArr.length; i++) {
        const slice = rsiArr.slice(i - stochPeriod + 1, i + 1);
        const highest = Math.max(...slice);
        const lowest = Math.min(...slice);
        const range = highest - lowest;
        rawK.push(range === 0 ? 50 : ((rsiArr[i] - lowest) / range) * 100);
    }
    
    // Smooth K
    const smoothedK = [];
    for (let i = smoothK - 1; i < rawK.length; i++) {
        smoothedK.push(rawK.slice(i - smoothK + 1, i + 1).reduce((a, b) => a + b, 0) / smoothK);
    }
    
    // Smooth D (of smoothedK)
    const smoothedD = [];
    for (let i = smoothD - 1; i < smoothedK.length; i++) {
        smoothedD.push(smoothedK.slice(i - smoothD + 1, i + 1).reduce((a, b) => a + b, 0) / smoothD);
    }
    
    const k = smoothedK.length > 0 ? smoothedK[smoothedK.length - 1] : 50;
    const d = smoothedD.length > 0 ? smoothedD[smoothedD.length - 1] : 50;
    const prevK = smoothedK.length > 1 ? smoothedK[smoothedK.length - 2] : k;
    const prevD = smoothedD.length > 1 ? smoothedD[smoothedD.length - 2] : d;
    
    // Signal logic
    let signal = "Neutral";
    if (k < 20 && d < 20) signal = "Oversold 🟢";
    if (k > 80 && d > 80) signal = "Overbought 🔴";
    if (k < 20 && prevK <= prevD && k > d) signal = "Bullish Cross 🚀"; // K crosses above D from oversold
    if (k > 80 && prevK >= prevD && k < d) signal = "Bearish Cross 💀"; // K crosses below D from overbought
    
    return { 
        k: parseFloat(k.toFixed(2)), 
        d: parseFloat(d.toFixed(2)), 
        signal,
        isBull: k < 20 || signal.includes("Bullish"),
        isBear: k > 80 || signal.includes("Bearish")
    };
}

// ============================================================
// ✅ NEW: Bollinger Bands - Volatility + Mean Reversion signals
// Entry near lower band = statistically favorable for LONG
// ============================================================
function calculateBollingerBands(candles, period, stdDev) {
    period = period !== undefined ? period : _p('BB_PERIOD', 20);
    stdDev = stdDev !== undefined ? stdDev : _p('BB_STDDEV', 2);
    const squeezeThresh = _p('BB_SQUEEZE_THRESH', 0.02);
    if (candles.length < period) return { upper: 0, middle: 0, lower: 0, signal: "Neutral", width: 0, percentB: 50 };
    
    const closes = candles.slice(-period).map(c => parseFloat(c[4]));
    const mean = closes.reduce((a, b) => a + b, 0) / period;
    const variance = closes.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / period;
    const std = Math.sqrt(variance);
    
    const upper = mean + stdDev * std;
    const lower = mean - stdDev * std;
    const currentPrice = parseFloat(candles[candles.length - 1][4]);
    
    // %B = (price - lower) / (upper - lower) → 0=at lower, 1=at upper, 0.5=at middle
    const width = upper - lower;
    const percentB = width > 0 ? ((currentPrice - lower) / width) * 100 : 50;
    const squeeze = (width / mean) < squeezeThresh; // Bandwidth < thresh% = squeeze
    
    let signal = "Neutral";
    if (percentB < 5) signal = "At Lower Band 🟢 (Oversold zone)";
    else if (percentB > 95) signal = "At Upper Band 🔴 (Overbought zone)";
    else if (percentB < 20) signal = "Near Lower Band 🟡";
    else if (percentB > 80) signal = "Near Upper Band 🟡";
    else if (squeeze) signal = "BB Squeeze ⚡ (Breakout expected!)";
    
    return {
        upper: upper.toFixed(4), middle: mean.toFixed(4), lower: lower.toFixed(4),
        percentB: percentB.toFixed(1), width: width.toFixed(4), squeeze,
        signal, currentPrice,
        isBull: percentB < 20, // Near lower band = bullish setup
        isBear: percentB > 80  // Near upper band = bearish setup
    };
}

// ============================================================
// ✅ NEW: Multi-timeframe OB Detector 
// 1H OB + 15m OB overlap = 2x stronger zone
// ============================================================
function detectMTFOrderBlocks(candles15m, candles1H) {
    // 15m OBs
    const ob15 = detectMTFOBs(candles15m);
    // 1H OBs  
    const ob1H = detectMTFOBs(candles1H);
    const currentPrice = parseFloat(candles15m[candles15m.length-1][4]);
    
    // Check overlap
    let confluenceZone = null;
    
    if (ob15.bullish && ob1H.bullish) {
        const b15 = { low: parseFloat(ob15.bullish.bottom), high: parseFloat(ob15.bullish.top) };
        const b1H = { low: parseFloat(ob1H.bullish.bottom), high: parseFloat(ob1H.bullish.top) };
        // Overlap check
        const overlapLow = Math.max(b15.low, b1H.low);
        const overlapHigh = Math.min(b15.high, b1H.high);
        if (overlapLow < overlapHigh) {
            confluenceZone = { 
                type: 'BULLISH', bottom: overlapLow.toFixed(4), top: overlapHigh.toFixed(4),
                display: `🔥 MTF OB Confluence: $${overlapLow.toFixed(4)} - $${overlapHigh.toFixed(4)}`,
                strength: 'DOUBLE'
            };
        }
    }
    
    if (ob15.bearish && ob1H.bearish) {
        const s15 = { low: parseFloat(ob15.bearish.bottom), high: parseFloat(ob15.bearish.top) };
        const s1H = { low: parseFloat(ob1H.bearish.bottom), high: parseFloat(ob1H.bearish.top) };
        const overlapLow = Math.max(s15.low, s1H.low);
        const overlapHigh = Math.min(s1H.high, s15.high);
        if (overlapLow < overlapHigh) {
            confluenceZone = {
                type: 'BEARISH', bottom: overlapLow.toFixed(4), top: overlapHigh.toFixed(4),
                display: `🔥 MTF OB Confluence: $${overlapLow.toFixed(4)} - $${overlapHigh.toFixed(4)}`,
                strength: 'DOUBLE'
            };
        }
    }
    
    return { ob15, ob1H, confluenceZone };
}

function detectMTFOBs(candles) {
    let bullish = null, bearish = null;
    // ✅ FIX: Check last 40 candles (OBs form 10-40 bars before current price)
    const start = Math.max(0, candles.length - 40);
    const avgBody = candles.slice(-20).reduce((s, c) => s + Math.abs(parseFloat(c[4]) - parseFloat(c[1])), 0) / 20;
    for (let i = start; i < candles.length - 2; i++) {
        if (i < 0) continue;
        const o = parseFloat(candles[i][1]), h = parseFloat(candles[i][2]);
        const l = parseFloat(candles[i][3]), c = parseFloat(candles[i][4]);
        const body = Math.abs(c - o);
        // ✅ FIX: OB must have meaningful body (not doji) — at least 30% of avg body
        if (body < avgBody * 0.3) continue;
        const isRed = c < o;
        const isGrn = c > o;
        // ✅ FIX: Require STRONG move after OB (not just any next candle)
        if (isRed && i+2 < candles.length) {
            const next2Close = parseFloat(candles[i+2][4]);
            const impulse = next2Close - o; // move beyond OB open
            if (next2Close > o && impulse > body * 0.8) {  // clear impulse above OB
                bullish = { bottom: l.toFixed(4), top: o.toFixed(4) };
            }
        }
        if (isGrn && i+2 < candles.length) {
            const next2Close = parseFloat(candles[i+2][4]);
            const impulse = o - next2Close;
            if (next2Close < o && impulse > body * 0.8) {
                bearish = { bottom: o.toFixed(4), top: h.toFixed(4) };
            }
        }
    }
    return { bullish, bearish };
}

// ============================================================
// ✅ NEW: Smart TP Calculator using Fib Extensions + HTF S/R
// Returns: tp1 (conservative), tp2 (normal), tp3 (extension)
// ============================================================
function calculateSmartTPs(entryPrice, sl, direction, candles, whaleSellWall = null, whaleBuyWall = null) {
    const entry = parseFloat(entryPrice);
    const slPrice = parseFloat(sl);
    const risk = Math.abs(entry - slPrice);

    // Pro Mode: use config RRR multipliers; defaults = 2/3/5
    const rrr1 = _tgt('TP1_RRR', 2.0);
    const rrr2m = _tgt('TP2_RRR', 3.0);
    const rrr3m = _tgt('TP3_RRR', 5.0);
    const fib1Thresh = _tgt('FIB_TP1_THRESH', 0.25);
    const fib2Thresh = _tgt('FIB_TP2_THRESH', 0.50);

    // ✅ FIX: Use 60-candle swing for realistic Fib extension targets
    const recentCandles = candles.slice(-60);
    const highs = recentCandles.map(c => parseFloat(c[2]));
    const lows  = recentCandles.map(c => parseFloat(c[3]));
    const swingHigh = Math.max(...highs);
    const swingLow  = Math.min(...lows);
    const swingRange = swingHigh - swingLow;

    let tp1, tp2, tp3, tp1Label, tp2Label, tp3Label;

    if (direction === 'LONG') {
        const rrr2 = entry + (risk * rrr1);
        const rrr3 = entry + (risk * rrr2m);
        const rrr5 = entry + (risk * rrr3m);

        const fib1618 = swingLow + (swingRange * 1.618);
        const fib2618 = swingLow + (swingRange * 2.618);
        const useFib1618 = fib1618 > entry && fib1618 < entry * (1 + fib1Thresh);
        const useFib2618 = fib2618 > entry && fib2618 < entry * (1 + fib2Thresh);

        const whaleWall = whaleSellWall ? parseFloat(whaleSellWall) : null;
        const whaleTP = whaleWall && whaleWall > entry && whaleWall < entry * 1.15 ? whaleWall * 0.998 : null;

        const tp1All = [rrr2, useFib1618 ? fib1618 : null, whaleTP].filter(p => p && p > entry);
        tp1 = tp1All.length > 0 ? Math.min(...tp1All) : rrr2;
        tp1Label = tp1 === rrr2 ? `1:${rrr1} RRR` : whaleTP && Math.abs(tp1 - whaleTP) < 0.0001 ? "Whale Wall" : "Fib 1.618";

        const tp2All = [rrr3, useFib2618 ? fib2618 : null].filter(p => p && p > tp1);
        tp2 = tp2All.length > 0 ? Math.min(...tp2All) : rrr3;
        tp2Label = tp2 === rrr3 ? `1:${rrr2m} RRR` : "Fib 2.618";

        tp3 = rrr5;
        tp3Label = `1:${rrr3m} RRR 🚀`;

    } else {
        const rrr2 = entry - (risk * rrr1);
        const rrr3 = entry - (risk * rrr2m);
        const rrr5 = entry - (risk * rrr3m);

        const fib1618 = swingHigh - (swingRange * 1.618);
        const fib2618 = swingHigh - (swingRange * 2.618);
        const useFib1618 = fib1618 < entry && fib1618 > entry * (1 - fib1Thresh) && fib1618 > 0;
        const useFib2618 = fib2618 < entry && fib2618 > entry * (1 - fib2Thresh) && fib2618 > 0;

        const whaleWall = whaleBuyWall ? parseFloat(whaleBuyWall) : null;
        const whaleTP = whaleWall && whaleWall < entry && whaleWall > entry * 0.85 ? whaleWall * 1.002 : null;

        const tp1All = [rrr2, useFib1618 ? fib1618 : null, whaleTP].filter(p => p && p < entry);
        tp1 = tp1All.length > 0 ? Math.max(...tp1All) : rrr2;
        tp1Label = tp1 === rrr2 ? `1:${rrr1} RRR` : whaleTP && Math.abs(tp1 - whaleTP) < 0.0001 ? "Whale Wall" : "Fib 1.618";

        const tp2All = [rrr3, useFib2618 ? fib2618 : null].filter(p => p && p < tp1);
        tp2 = tp2All.length > 0 ? Math.max(...tp2All) : rrr3;
        tp2Label = tp2 === rrr3 ? `1:${rrr2m} RRR` : "Fib 2.618";

        tp3 = rrr5;
        tp3Label = `1:${rrr3m} RRR 🎯`;
    }

    // ✅ SAFETY NET
    if (!isFinite(tp1) || isNaN(tp1)) { tp1 = direction === 'LONG' ? entry + risk*rrr1 : entry - risk*rrr1; tp1Label = `1:${rrr1} RRR`; }
    if (!isFinite(tp2) || isNaN(tp2)) { tp2 = direction === 'LONG' ? entry + risk*rrr2m : entry - risk*rrr2m; tp2Label = `1:${rrr2m} RRR`; }
    if (!isFinite(tp3) || isNaN(tp3)) { tp3 = direction === 'LONG' ? entry + risk*rrr3m : entry - risk*rrr3m; tp3Label = `1:${rrr3m} RRR`; }

    return {
        tp1: parseFloat(tp1).toFixed(4), tp1Label,
        tp2: parseFloat(tp2).toFixed(4), tp2Label,
        tp3: parseFloat(tp3).toFixed(4), tp3Label
    };
}

// ============================================================
// ✅ NEW: Smart SL Calculator using Swing + ATR + OB
// Tighter and smarter than pure ATR-based SL
// ============================================================
function calculateSmartSL(entryPrice, direction, candles, ob = null, atrVal = null) {
    const entry = parseFloat(entryPrice);
    const atr = atrVal ? parseFloat(atrVal) : 
        parseFloat(calculateATR(candles.slice(-20), 14));
    
    const highs = candles.slice(-15).map(c => parseFloat(c[2]));
    const lows = candles.slice(-15).map(c => parseFloat(c[3]));
    
    let sl, slLabel;
    
    if (direction === 'LONG') {
        // Option 1: Recent swing low - 0.3% buffer
        const recentSwingLow = Math.min(...lows);
        const swingBasedSL = recentSwingLow * 0.997; // 0.3% below wick
        
        // Option 2: OB bottom - 0.2% buffer
        const obBasedSL = ob ? parseFloat(ob.bottom) * 0.998 : null;
        
        // Option 3: ATR-based (configurable multiplier, default 1.5x ATR below entry)
        const atrMult = _tgt('ATR_SL_MULTIPLIER', 1.5);
        const atrMaxMult = _p('ATR_MAX_SL_MULT', 4);
        const atrBasedSL = entry - (atr * atrMult);
        
        // Choose SL: must be below entry, not too tight (<0.8x ATR), not too wide (>4x ATR)
        const minSLDist = atr * 0.8;  // minimum distance to avoid noise stops
        const candidates = [swingBasedSL, obBasedSL, atrBasedSL]
            .filter(s => s !== null && !isNaN(s) && s < entry
                && (entry - s) >= minSLDist           // not too tight
                && (entry - s) < atr * atrMaxMult);   // not too wide
        
        // Prefer: OB-based > swing-based > ATR-based (priority order)
        if (obBasedSL && candidates.includes(obBasedSL)) sl = obBasedSL;
        else if (candidates.includes(swingBasedSL)) sl = swingBasedSL;
        else if (candidates.length > 0) sl = Math.min(...candidates); // widest valid
        else sl = atrBasedSL; // final fallback
        if (isNaN(sl) || sl <= 0) sl = entry - atr * 1.5; // safety net
        const slDiff1 = Math.abs(sl - swingBasedSL); const slDiff2 = obBasedSL ? Math.abs(sl - obBasedSL) : Infinity;
        slLabel = slDiff1 < 0.000001 ? "Swing Low" : slDiff2 < 0.000001 ? "OB Bottom" : `ATR ${atrMult}x`;
    } else {
        const recentSwingHigh = Math.max(...highs);
        const swingBasedSL = recentSwingHigh * 1.003;
        const obBasedSL = ob ? parseFloat(ob.top) * 1.002 : null;
        const atrMult = _tgt('ATR_SL_MULTIPLIER', 1.5);
        const atrMaxMult = _p('ATR_MAX_SL_MULT', 4);
        const atrBasedSL = entry + (atr * atrMult);
        
        const candidates = [swingBasedSL, obBasedSL, atrBasedSL]
            .filter(s => s !== null && !isNaN(s) && s > entry && (s - entry) < atr * atrMaxMult);
        
        // SHORT: SL must be ABOVE entry, not too tight, not too wide
        const minDistS = atr * 0.8;
        const validS = candidates.filter(s => s > entry && (s-entry) >= minDistS && (s-entry) < atr*atrMaxMult);
        // Prefer OB > swing > widest valid
        if (obBasedSL && validS.includes(obBasedSL)) sl = obBasedSL;
        else if (validS.includes(swingBasedSL)) sl = swingBasedSL;
        else if (validS.length > 0) sl = Math.max(...validS);
        else sl = atrBasedSL;
        if (isNaN(sl) || sl <= 0) sl = entry + atr * 1.5;
        const slDiff1s = Math.abs(sl - swingBasedSL); const slDiff2s = obBasedSL ? Math.abs(sl - obBasedSL) : Infinity;
        slLabel = slDiff1s < 0.000001 ? "Swing High" : slDiff2s < 0.000001 ? "OB Top" : `ATR ${atrMult}x`;
    }
    
    return { 
        sl: parseFloat(sl).toFixed(4), 
        slLabel,
        slDistance: Math.abs(entry - sl).toFixed(4),
        slPct: (Math.abs(entry - sl) / entry * 100).toFixed(2)
    };
}


// ============================================================
// ✅ NEW: Multi-Timeframe RSI Confluence
// RSI oversold on BOTH 15m + 1H = 2x stronger entry signal
// ============================================================
function checkMTFRSIConfluence(candles15m, candles1H) {
    const rsi15 = calculateRSI(candles15m.slice(-50), 14);
    const rsi1H = calculateRSI(candles1H.slice(-50), 14);
    
    const is15mOversold  = rsi15 < 35;
    const is15mOverbought= rsi15 > 65;
    const is1HOversold   = rsi1H < 40;
    const is1HOverbought = rsi1H > 60;
    
    if (is15mOversold && is1HOversold) {
        return { signal: 'STRONG_BULL', isBull: true, isBear: false, 
                 display: `🟢🟢 MTF RSI Oversold (15m:${rsi15.toFixed(0)} + 1H:${rsi1H.toFixed(0)})` };
    }
    if (is15mOverbought && is1HOverbought) {
        return { signal: 'STRONG_BEAR', isBull: false, isBear: true,
                 display: `🔴🔴 MTF RSI Overbought (15m:${rsi15.toFixed(0)} + 1H:${rsi1H.toFixed(0)})` };
    }
    if (is15mOversold) {
        return { signal: 'MILD_BULL', isBull: true, isBear: false,
                 display: `🟡 RSI Oversold 15m (${rsi15.toFixed(0)})` };
    }
    if (is15mOverbought) {
        return { signal: 'MILD_BEAR', isBull: false, isBear: true,
                 display: `🟡 RSI Overbought 15m (${rsi15.toFixed(0)})` };
    }
    return { signal: 'NEUTRAL', isBull: false, isBear: false,
             display: `⚪ RSI Neutral (15m:${rsi15.toFixed(0)} / 1H:${rsi1H.toFixed(0)})` };
}

// ============================================================
// ✅ NEW: Volume Profile Node (High Volume Node = magnetic price)
// Entries AT a high-volume node = better fills, less slippage
// ============================================================
function detectVolumeNodes(candles, numBuckets = 20) {
    if (candles.length < 20) return { nearHVN: false, hvnPrice: null, lvnZone: null };

    const highs  = candles.map(c => parseFloat(c[2]));
    const lows   = candles.map(c => parseFloat(c[3]));
    const vols   = candles.map(c => parseFloat(c[5]));
    const minP   = Math.min(...lows);
    const maxP   = Math.max(...highs);
    const bucket = (maxP - minP) / numBuckets;
    if (bucket === 0) return { nearHVN: false, hvnPrice: null };

    // Build volume profile buckets
    const profile = Array(numBuckets).fill(0);
    candles.forEach((c, i) => {
        const midP = (parseFloat(c[2]) + parseFloat(c[3])) / 2;
        const idx  = Math.min(Math.floor((midP - minP) / bucket), numBuckets - 1);
        profile[idx] += vols[i];
    });

    const maxVol = Math.max(...profile);
    const currentPrice = parseFloat(candles[candles.length-1][4]);

    // Find HVN (highest volume bucket) and LVN (lowest volume - fast moves)
    let hvnIdx = profile.indexOf(maxVol);
    const hvnPrice = minP + (hvnIdx + 0.5) * bucket;

    // Check if current price is near HVN (within 0.5%)
    const nearHVN = Math.abs(currentPrice - hvnPrice) / currentPrice < 0.005;

    // Find LVN zones (gaps in volume = fast price movement expected)
    const avgVol = profile.reduce((a,b)=>a+b,0) / numBuckets;
    const lvnZones = profile
        .map((v, i) => ({ vol: v, price: minP + (i+0.5)*bucket }))
        .filter(b => b.vol < avgVol * 0.3 && Math.abs(b.price - currentPrice)/currentPrice < 0.03);

    return {
        nearHVN,
        hvnPrice: hvnPrice.toFixed(4),
        hvnVol: maxVol.toFixed(0),
        lvnZones: lvnZones.slice(0, 2).map(z => z.price.toFixed(4)),
        display: nearHVN
            ? `🔥 HVN Zone: $${hvnPrice.toFixed(4)} (High liquidity - good entry!)`
            : lvnZones.length > 0
                ? `⚡ In LVN Zone → Fast move expected`
                : `⚪ Normal volume distribution`
    };
}

// ============================================================
// ✅ NEW: Session Filter (Trading Session Detector)
// London+NY overlap = highest volume = best for futures entries
// Asian session = low volume = fakeout risk
// ============================================================
function getSessionQuality() {
    const now = new Date();
    const utcH = now.getUTCHours();
    const utcM = now.getUTCMinutes();
    const utcTime = utcH + utcM / 60;

    // Session times (UTC)
    // Asian:   00:00 - 09:00
    // London:  08:00 - 17:00
    // NY:      13:00 - 22:00
    // Overlap: 13:00 - 17:00 (London+NY - BEST)
    // Pre-NY:  08:00 - 13:00 (London only - good)

    const inAsian  = utcTime >= 0   && utcTime < 8;
    const inLondon = utcTime >= 8   && utcTime < 17;
    const inNY     = utcTime >= 13  && utcTime < 22;
    const inOverlap= utcTime >= 13  && utcTime < 17;

    let session, quality, emoji, advice;

    if (inOverlap) {
        session = 'London + NY Overlap';
        quality = 'BEST'; emoji = '🔥';
        advice  = 'Highest volume session - Best for entries!';
    } else if (inNY && !inOverlap) {
        session = 'New York';
        quality = 'GOOD'; emoji = '🟢';
        advice  = 'Good liquidity - OK for entries';
    } else if (inLondon && !inOverlap) {
        session = 'London';
        quality = 'GOOD'; emoji = '🟢';
        advice  = 'Good liquidity - OK for entries';
    } else if (inAsian) {
        session = 'Asian';
        quality = 'CAUTION'; emoji = '⚠️';
        advice  = 'Low volume - Fakeout risk high, wait for London';
    } else {
        // 22:00 - 00:00 UTC
        session = 'Off-Hours';
        quality = 'AVOID'; emoji = '🔴';
        advice  = 'Very low volume - avoid new entries';
    }

    return {
        session, quality, emoji, advice,
        utcTime: `${String(utcH).padStart(2,'0')}:${String(utcM).padStart(2,'0')} UTC`,
        isBestSession: quality === 'BEST' || quality === 'GOOD',
        display: `${emoji} ${session} Session (${String(utcH).padStart(2,'0')}:${String(utcM).padStart(2,'0')} UTC) — ${advice}`
    };
}

// ============================================================
// ✅ NEW: Candle Close Confirmation
// Entry only AFTER candle closes above/below key level
// Reduces false breakout entries significantly
// ============================================================
function checkCandleCloseConfirmation(candles, direction, keyLevel) {
    if (!candles || candles.length < 3) return { confirmed: false, display: 'Insufficient data' };

    const lastClosed = candles[candles.length - 2]; // last CLOSED candle (not current)
    const closePrice = parseFloat(lastClosed[4]);
    const openPrice  = parseFloat(lastClosed[1]);
    const high       = parseFloat(lastClosed[2]);
    const low        = parseFloat(lastClosed[3]);
    const isBullish  = closePrice > openPrice;
    const bodySize   = Math.abs(closePrice - openPrice);
    const totalRange = high - low;
    const bodyRatio  = totalRange > 0 ? bodySize / totalRange : 0;

    // Strong close = body > 60% of total range (not a doji/spinning top)
    const isStrongClose = bodyRatio > 0.6;

    let confirmed = false;
    let display = '';

    if (direction === 'LONG') {
        const closedAboveLevel = keyLevel ? closePrice > parseFloat(keyLevel) : isBullish;
        confirmed = closedAboveLevel && isBullish && isStrongClose;
        display = confirmed
            ? `✅ Strong Bull Candle Close (Body: ${(bodyRatio*100).toFixed(0)}%)`
            : `⏳ Waiting for bullish candle close above $${keyLevel || 'zone'}`;
    } else {
        const closedBelowLevel = keyLevel ? closePrice < parseFloat(keyLevel) : !isBullish;
        confirmed = closedBelowLevel && !isBullish && isStrongClose;
        display = confirmed
            ? `✅ Strong Bear Candle Close (Body: ${(bodyRatio*100).toFixed(0)}%)`
            : `⏳ Waiting for bearish candle close below $${keyLevel || 'zone'}`;
    }

    return { confirmed, isStrongClose, bodyRatio: (bodyRatio*100).toFixed(0), closePrice, display };
}

    // ... ඉහළ ඇති සියලුම functions වලට පසුව අවසානයට මෙය එක් කරන්න ...


// ============================================================
// ✅ NEW: Key Support/Resistance Levels from swing pivots
// Much better than min/max of 50 candles
// ============================================================
function getKeyLevels(candles, numLevels = 3) {
    if (candles.length < 20) return { supports: [], resistances: [], nearest: null };

    const highs  = candles.map(c => parseFloat(c[2]));
    const lows   = candles.map(c => parseFloat(c[3]));
    const current = parseFloat(candles[candles.length - 1][4]);

    const swingHighs = [], swingLows = [];
    for (let i = 2; i < candles.length - 2; i++) {
        // Pivot high: higher than 2 bars each side
        if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2]) {
            swingHighs.push(highs[i]);
        }
        // Pivot low
        if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2]) {
            swingLows.push(lows[i]);
        }
    }

    // Cluster nearby levels (within 0.5%)
    function cluster(levels) {
        if (!levels.length) return [];
        levels.sort((a, b) => a - b);
        const result = [levels[0]];
        for (let i = 1; i < levels.length; i++) {
            if (Math.abs(levels[i] - result[result.length-1]) / result[result.length-1] > 0.005) {
                result.push(levels[i]);
            } else {
                // Average the cluster
                result[result.length-1] = (result[result.length-1] + levels[i]) / 2;
            }
        }
        return result;
    }

    const supports    = cluster(swingLows).filter(l => l < current).slice(-numLevels).reverse();
    const resistances = cluster(swingHighs).filter(l => l > current).slice(0, numLevels);

    const nearestSupport    = supports[0] || null;
    const nearestResistance = resistances[0] || null;
    const suppDist = nearestSupport    ? ((current - nearestSupport) / current * 100).toFixed(2)    : null;
    const resDist  = nearestResistance ? ((nearestResistance - current) / current * 100).toFixed(2) : null;

    return {
        supports:    supports.map(s => parseFloat(s.toFixed(4))),
        resistances: resistances.map(r => parseFloat(r.toFixed(4))),
        nearestSupport:    nearestSupport    ? parseFloat(nearestSupport.toFixed(4))    : null,
        nearestResistance: nearestResistance ? parseFloat(nearestResistance.toFixed(4)) : null,
        suppDistPct: suppDist, resDist,
        display: `🟢 S: $${nearestSupport?.toFixed(4) || 'N/A'} (${suppDist}%) | 🔴 R: $${nearestResistance?.toFixed(4) || 'N/A'} (${resDist}%)`
    };
}

// ============================================================
// ✅ NEW: EMA Ribbon (9, 21, 55, 200) — multi-confluence entry
// Price above all EMAs in order = strong bull zone
// Price pulling back to EMA21 in bull trend = ideal entry
// ============================================================
function getEMARibbon(candles) {
    if (candles.length < 210) return null;
    const current = parseFloat(candles[candles.length - 1][4]);
    const ema9   = parseFloat(calculateEMA(candles, 9));
    const ema21  = parseFloat(calculateEMA(candles, 21));
    const ema55  = parseFloat(calculateEMA(candles, 55));
    const ema200 = parseFloat(calculateEMA(candles, 200));

    const bullOrder = current > ema9 && ema9 > ema21 && ema21 > ema55 && ema55 > ema200;
    const bearOrder = current < ema9 && ema9 < ema21 && ema21 < ema55 && ema55 < ema200;
    const pullback21Bull = !bullOrder && current > ema55 && Math.abs(current - ema21) / current < 0.008; // within 0.8% of EMA21
    const pullback21Bear = !bearOrder && current < ema55 && Math.abs(current - ema21) / current < 0.008;

    let signal, quality;
    if (bullOrder)       { signal = "STRONG_BULL"; quality = "🟢🟢 Full Bull Ribbon"; }
    else if (bearOrder)  { signal = "STRONG_BEAR"; quality = "🔴🔴 Full Bear Ribbon"; }
    else if (pullback21Bull) { signal = "BULL_PULLBACK"; quality = "🟡 Bull Pullback to EMA21 (buy zone)"; }
    else if (pullback21Bear) { signal = "BEAR_PULLBACK"; quality = "🟡 Bear Pullback to EMA21 (sell zone)"; }
    else if (current > ema200) { signal = "BULL_MIXED"; quality = "⚪ Above EMA200 (mixed)"; }
    else { signal = "BEAR_MIXED"; quality = "⚪ Below EMA200 (mixed)"; }

    return {
        ema9: ema9.toFixed(4), ema21: ema21.toFixed(4),
        ema55: ema55.toFixed(4), ema200: ema200.toFixed(4),
        signal, quality,
        isBull: signal.startsWith("STRONG_BULL") || signal === "BULL_PULLBACK",
        isBear: signal.startsWith("STRONG_BEAR") || signal === "BEAR_PULLBACK",
        display: quality
    };
}

// ============================================================
// ✅ NEW: FVG (Fair Value Gap) Scanner — for TP targets
// FVGs are unfilled price imbalances that price usually revisits
// Bullish FVG = gap up (candle 1 high < candle 3 low) = support zone
// Bearish FVG = gap down (candle 1 low > candle 3 high) = resistance zone
// ============================================================
function scanFairValueGaps(candles) {
    if (candles.length < 5) return { bullFVGs: [], bearFVGs: [], nearest: null };
    const current = parseFloat(candles[candles.length - 1][4]);
    const bullFVGs = [], bearFVGs = [];

    for (let i = 2; i < candles.length - 1; i++) {
        const c1H = parseFloat(candles[i-2][2]), c1L = parseFloat(candles[i-2][3]);
        const c3H = parseFloat(candles[i][2]),   c3L = parseFloat(candles[i][3]);

        // Bullish FVG: gap between C1 high and C3 low (price gapped up)
        if (c1H < c3L) {
            const gapSize = c3L - c1H;
            const midpoint = (c1H + c3L) / 2;
            if (gapSize / midpoint > 0.001) { // at least 0.1% gap
                bullFVGs.push({ top: c3L.toFixed(4), bottom: c1H.toFixed(4), mid: midpoint.toFixed(4), filled: current < c3L });
            }
        }
        // Bearish FVG: gap between C1 low and C3 high (price gapped down)
        if (c1L > c3H) {
            const gapSize = c1L - c3H;
            const midpoint = (c1L + c3H) / 2;
            if (gapSize / midpoint > 0.001) {
                bearFVGs.push({ top: c1L.toFixed(4), bottom: c3H.toFixed(4), mid: midpoint.toFixed(4), filled: current > c1L });
            }
        }
    }

    // Find nearest unfilled FVG (potential TP target)
    const unfilledBull = bullFVGs.filter(f => !f.filled && parseFloat(f.mid) > current);
    const unfilledBear = bearFVGs.filter(f => !f.filled && parseFloat(f.mid) < current);
    const nearest = unfilledBull.length > 0
        ? { ...unfilledBull[unfilledBull.length - 1], type: 'BULL', direction: 'above' }
        : unfilledBear.length > 0
            ? { ...unfilledBear[unfilledBear.length - 1], type: 'BEAR', direction: 'below' }
            : null;

    return { bullFVGs, bearFVGs, nearest };
}


// ============================================================
// ✅ NEW: Supertrend Indicator (ATR-based dynamic trend line)
// ============================================================
function calculateSupertrend(candles, period = 10, multiplier = 3.0) {
    if (candles.length < period + 5) return { signal: 'NEUTRAL', isBull: false, isBear: false, justFlipUp: false, justFlipDown: false, supertrendLevel: '0', display: '⚪ Supertrend N/A' };

    // Build TR array
    const trArr = [];
    for (let i = 1; i < candles.length; i++) {
        const h = parseFloat(candles[i][2]), l = parseFloat(candles[i][3]), pc = parseFloat(candles[i-1][4]);
        trArr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }

    // Wilder's smoothed ATR
    let atr = trArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const atrArr = [atr];
    for (let i = period; i < trArr.length; i++) {
        atr = (atr * (period - 1) + trArr[i]) / period;
        atrArr.push(atr);
    }

    // Calculate upper/lower bands
    let prevUp = 0, prevDown = 0, prevST = 0, prevDir = 1;
    const stArr = [], dirArr = [];

    for (let i = 0; i < atrArr.length; i++) {
        const ci = i + 1;
        if (ci >= candles.length) break;
        const hl2 = (parseFloat(candles[ci][2]) + parseFloat(candles[ci][3])) / 2;
        const rawUp   = hl2 + multiplier * atrArr[i];
        const rawDown = hl2 - multiplier * atrArr[i];

        const prevClose = ci > 1 ? parseFloat(candles[ci-1][4]) : hl2;
        const finalUp   = (rawUp < prevUp || prevClose < prevUp) ? rawUp : prevUp;
        const finalDown = (rawDown > prevDown || prevClose > prevDown) ? rawDown : prevDown;

        const close = parseFloat(candles[ci][4]);
        let dir;
        if (prevST === prevUp)     dir = close > finalUp   ? 1 : -1;
        else                        dir = close < finalDown ? -1 : 1;

        const st = dir === 1 ? finalDown : finalUp;
        stArr.push(st); dirArr.push(dir);
        prevUp = finalUp; prevDown = finalDown; prevST = st; prevDir = dir;
    }

    if (stArr.length < 2) return { signal: 'NEUTRAL', isBull: false, isBear: false, justFlipUp: false, justFlipDown: false, supertrendLevel: '0', display: '⚪ Supertrend N/A' };

    const lastDir  = dirArr[dirArr.length - 1];
    const prevDirV = dirArr[dirArr.length - 2];
    const lastST   = stArr[stArr.length - 1];

    const isBull       = lastDir === 1;
    const isBear       = lastDir === -1;
    const justFlipUp   = lastDir === 1  && prevDirV === -1;
    const justFlipDown = lastDir === -1 && prevDirV === 1;

    const signal = isBull ? 'BULL' : 'BEAR';
    let display;
    if (justFlipUp)        display = `🟢🟢 *SUPERTREND FLIP UP* ⚡ Strong Buy! ($${lastST.toFixed(4)})`;
    else if (justFlipDown) display = `🔴🔴 *SUPERTREND FLIP DOWN* ⚡ Strong Sell! ($${lastST.toFixed(4)})`;
    else if (isBull)       display = `🟢 Supertrend Bull (Support: $${lastST.toFixed(4)})`;
    else                   display = `🔴 Supertrend Bear (Resistance: $${lastST.toFixed(4)})`;

    return { signal, isBull, isBear, justFlipUp, justFlipDown, supertrendLevel: lastST.toFixed(4), display };
}

// ============================================================
// ✅ NEW: RVOL - Relative Volume
// ============================================================
function calculateRVOL(candles) {
    if (candles.length < 22) return { rvol: 1.0, signal: 'NORMAL', isTrustworthy: false, display: '⚪ RVOL N/A' };

    const vols = candles.map(c => parseFloat(c[5]));
    const avgVol20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    const currentVol = vols[vols.length - 1];
    const rvol = avgVol20 > 0 ? currentVol / avgVol20 : 1.0;

    let signal, display;
    if (rvol >= 3.0)      { signal = 'EXTREME'; display = `🔥🔥 RVOL ${rvol.toFixed(1)}x (Extreme! Institutional move)`; }
    else if (rvol >= 2.0) { signal = 'HIGH';    display = `🔥 RVOL ${rvol.toFixed(1)}x (High — trust the move)`; }
    else if (rvol >= 1.3) { signal = 'ABOVE';   display = `🟢 RVOL ${rvol.toFixed(1)}x (Above average)`; }
    else if (rvol >= 0.7) { signal = 'NORMAL';  display = `⚪ RVOL ${rvol.toFixed(1)}x (Normal)`; }
    else                  { signal = 'LOW';     display = `⚠️ RVOL ${rvol.toFixed(1)}x (Low — wait for volume)`; }

    return { rvol: parseFloat(rvol.toFixed(2)), signal, isTrustworthy: rvol >= 1.3, display };
}

// ============================================================
// ✅ NEW: MTF MACD Confluence (15m + 1H aligned)
// ============================================================
function checkMTFMACD(candles15m, candles1H) {
    if (!candles15m || !candles1H || candles15m.length < 35 || candles1H.length < 35) {
        return { signal: 'NEUTRAL', isBull: false, isBear: false, display: '⚪ MTF MACD N/A' };
    }

    function getMACDDir(candles) {
        const k12 = 2/13, k26 = 2/27;
        const prices = candles.map(c => parseFloat(c[4]));
        let e12 = prices[0], e26 = prices[0];
        for (let i = 1; i < prices.length; i++) {
            e12 = prices[i] * k12 + e12 * (1 - k12);
            e26 = prices[i] * k26 + e26 * (1 - k26);
        }
        return (e12 - e26) > 0 ? 'BULL' : 'BEAR';
    }

    const dir15m = getMACDDir(candles15m);
    const dir1H  = getMACDDir(candles1H);

    if (dir15m === 'BULL' && dir1H === 'BULL')
        return { signal: 'STRONG_BULL', isBull: true, isBear: false, display: '🟢🟢 MTF MACD Both Bull (15m+1H aligned)' };
    if (dir15m === 'BEAR' && dir1H === 'BEAR')
        return { signal: 'STRONG_BEAR', isBull: false, isBear: true, display: '🔴🔴 MTF MACD Both Bear (15m+1H aligned)' };
    return { signal: 'NEUTRAL', isBull: false, isBear: false,
             display: `⚪ MTF MACD Mixed (15m:${dir15m} | 1H:${dir1H})` };
}

// ============================================================
// 🆕 v5 UPGRADE: Wyckoff Phase Detector
// World's top hedge funds use Wyckoff to identify accumulation
// Spring = highest probability LONG setup in existence
// UTAD  = highest probability SHORT setup in existence
// ============================================================
function detectWyckoffPhase(candles) {
    if (candles.length < 50) return { phase: 'UNKNOWN', signal: 'NEUTRAL', isLong: false, isShort: false, display: '⚪ Wyckoff N/A' };

    const closes = candles.map(c => parseFloat(c[4]));
    const highs  = candles.map(c => parseFloat(c[2]));
    const lows   = candles.map(c => parseFloat(c[3]));
    const vols   = candles.map(c => parseFloat(c[5]));
    const n = candles.length;

    const recentHigh = Math.max(...highs.slice(-25));
    const recentLow  = Math.min(...lows.slice(-25));
    const priorHigh  = Math.max(...highs.slice(-50, -25));
    const priorLow   = Math.min(...lows.slice(-50, -25));

    const recentVolAvg = vols.slice(-25).reduce((a,b)=>a+b,0) / 25;
    const priorVolAvg  = vols.slice(-50,-25).reduce((a,b)=>a+b,0) / 25;
    const volDrying    = recentVolAvg < priorVolAvg * 0.85;
    const volClimaxing = vols[n-1] > recentVolAvg * 2.5;

    const supportLevel    = priorLow;
    const resistanceLevel = priorHigh;

    // Spring: wick dips below prior support but CLOSES back above it
    const last5Lows   = lows.slice(-5);
    const last5Closes = closes.slice(-5);
    // ✅ FIX: 0.2% below support (crypto springs are typically 0.1-0.5% sweeps)
    const spring = last5Lows.some((l,i) => l < supportLevel * 0.998 && last5Closes[i] > supportLevel * 0.999);

    // UTAD: wick pops above prior resistance but CLOSES back below it
    const last5Highs = highs.slice(-5);
    // ✅ FIX: 0.2% above resistance for UTAD sweep
    const utad = last5Highs.some((h,i) => h > resistanceLevel * 1.002 && last5Closes[i] < resistanceLevel * 1.001);

    const isAccum  = Math.abs(recentLow - priorLow) / priorLow < 0.03 && volDrying;
    const isDist   = Math.abs(recentHigh - priorHigh) / priorHigh < 0.03 && volDrying;
    const isMarkup = recentHigh > priorHigh * 1.02 && closes[n-1] > closes[n-11];
    const isMarkdn = recentLow  < priorLow  * 0.98 && closes[n-1] < closes[n-11];

    if (spring && isAccum) return { phase:'SPRING', signal:'STRONG_BULL', isLong:true, isShort:false, display:'🌱 *Wyckoff SPRING!* Accumulation bottom — Ultra-high probability LONG 🚀🚀' };
    if (utad   && isDist)  return { phase:'UTAD',   signal:'STRONG_BEAR', isLong:false, isShort:true,  display:'⚡ *Wyckoff UTAD!* Distribution top — Ultra-high probability SHORT 📉📉' };
    if (isMarkup)          return { phase:'MARKUP',   signal:'BULL', isLong:true, isShort:false, display:'📈 Wyckoff Markup Phase (Trend continuation — LONG)' };
    if (isMarkdn)          return { phase:'MARKDOWN',  signal:'BEAR', isLong:false, isShort:true,  display:'📉 Wyckoff Markdown Phase (Trend continuation — SHORT)' };
    if (isAccum)           return { phase:'ACCUMULATION', signal:'MILD_BULL', isLong:true, isShort:false, display:'🔄 Wyckoff Accumulation (Basing — wait for Spring confirmation)' };
    if (isDist)            return { phase:'DISTRIBUTION', signal:'MILD_BEAR', isLong:false, isShort:true,  display:'🔄 Wyckoff Distribution (Topping — wait for UTAD confirmation)' };
    return { phase:'UNKNOWN', signal:'NEUTRAL', isLong:false, isShort:false, display:'⚪ Wyckoff: No clear phase' };
}

// ============================================================
// 🆕 v5: Breaker Block Detector
// Failed OB that gets swept = flips to opposite direction
// Stronger than regular OBs — institutions use these as reentry
// ============================================================
function detectBreakerBlocks(candles) {
    if (candles.length < 25) return { bullishBreaker:null, bearishBreaker:null, display:'None' };
    const n = candles.length;
    const highs  = candles.map(c => parseFloat(c[2]));
    const lows   = candles.map(c => parseFloat(c[3]));
    const closes = candles.map(c => parseFloat(c[4]));
    const opens  = candles.map(c => parseFloat(c[1]));
    const current = closes[n-1];

    let bullBreaker = null, bearBreaker = null;

    for (let i = 3; i < n - 5; i++) {
        const isGreen = closes[i] > opens[i];
        const isRed   = closes[i] < opens[i];
        const obLow   = Math.min(opens[i], closes[i]);
        const obHigh  = Math.max(opens[i], closes[i]);

        if (isGreen) {
            // Green candle → impulse down after → price later sweeps below obLow → reverses UP = Bullish Breaker
            const minAfter = Math.min(...lows.slice(i+1, Math.min(i+5, n)));
            if (minAfter < obLow * 0.9985) {
                const closesPost = closes.slice(i+4, n);
                if (closesPost.some(c => c > obHigh) && current > obLow) {
                    bullBreaker = { bottom: obLow.toFixed(4), top: obHigh.toFixed(4), display: `🔲 Bull Breaker $${obLow.toFixed(4)}–$${obHigh.toFixed(4)}` };
                }
            }
        }
        if (isRed) {
            // Red candle → impulse up after → price later sweeps above obHigh → reverses DOWN = Bearish Breaker
            const maxAfter = Math.max(...highs.slice(i+1, Math.min(i+5, n)));
            if (maxAfter > obHigh * 1.0015) {
                const closesPost = closes.slice(i+4, n);
                if (closesPost.some(c => c < obLow) && current < obHigh) {
                    bearBreaker = { bottom: obLow.toFixed(4), top: obHigh.toFixed(4), display: `🔲 Bear Breaker $${obLow.toFixed(4)}–$${obHigh.toFixed(4)}` };
                }
            }
        }
    }

    const display = [bullBreaker?.display, bearBreaker?.display].filter(Boolean).join(' | ') || 'None';
    return { bullishBreaker: bullBreaker, bearishBreaker: bearBreaker, display };
}

// ============================================================
// 🆕 v5: Equal Highs / Equal Lows (EQH / EQL)
// Smart money targets liquidity pools before reversals
// EQH above = target for short squeeze → then reversal DOWN
// EQL below = target for stop hunt → then reversal UP
// ============================================================
function detectEqualHighsLows(candles) {
    if (candles.length < 20) return { eqh:null, eql:null, display:'None' };
    const n = candles.length;
    const highs   = candles.map(c => parseFloat(c[2]));
    const lows    = candles.map(c => parseFloat(c[3]));
    const current = parseFloat(candles[n-1][4]);
    const tol = 0.0022; // 0.22% tolerance

    // Find swing pivots
    const sH = [], sL = [];
    for (let i = 2; i < n-2; i++) {
        if (highs[i]>highs[i-1] && highs[i]>highs[i-2] && highs[i]>highs[i+1] && highs[i]>highs[i+2]) sH.push(highs[i]);
        if (lows[i] <lows[i-1]  && lows[i] <lows[i-2]  && lows[i] <lows[i+1]  && lows[i] <lows[i+2])  sL.push(lows[i]);
    }

    let eqh = null, eql = null;

    // EQH: 2+ swing highs within tolerance, above current price
    for (let i = 0; i < sH.length-1; i++) {
        for (let j = i+1; j < sH.length; j++) {
            if (Math.abs(sH[i]-sH[j])/sH[i] < tol && sH[i] > current) {
                const lvl = (sH[i]+sH[j])/2;
                if (!eqh || lvl < parseFloat(eqh.level)) {
                    eqh = { level: lvl.toFixed(4), dist: ((lvl-current)/current*100).toFixed(2), display:`💧 EQH $${lvl.toFixed(4)} (+${((lvl-current)/current*100).toFixed(1)}%) Liquidity Pool ↑` };
                }
            }
        }
    }
    // EQL: 2+ swing lows within tolerance, below current price
    for (let i = 0; i < sL.length-1; i++) {
        for (let j = i+1; j < sL.length; j++) {
            if (Math.abs(sL[i]-sL[j])/sL[i] < tol && sL[i] < current) {
                const lvl = (sL[i]+sL[j])/2;
                if (!eql || lvl > parseFloat(eql.level)) {
                    eql = { level: lvl.toFixed(4), dist: ((current-lvl)/current*100).toFixed(2), display:`💧 EQL $${lvl.toFixed(4)} (-${((current-lvl)/current*100).toFixed(1)}%) Liquidity Pool ↓` };
                }
            }
        }
    }

    const display = [eqh?.display, eql?.display].filter(Boolean).join(' | ') || 'None';
    return { eqh, eql, display };
}

// ============================================================
// 🆕 v5: Premium / Discount Zone + OTE (Optimal Trade Entry)
// Smart money: BUY in DISCOUNT, SELL in PREMIUM
// OTE = 0.618–0.786 Fib retracement = institutional sweet spot
// ============================================================
function checkPremiumDiscount(candles, direction) {
    if (candles.length < 20) return { zone:'UNKNOWN', position:50, isOptimal:false, tradeMatch:false, display:'⚪ Zone N/A' };
    const n = candles.length;
    const highs   = candles.map(c => parseFloat(c[2]));
    const lows    = candles.map(c => parseFloat(c[3]));
    const current = parseFloat(candles[n-1][4]);

    const swingHigh = Math.max(...highs.slice(-50));
    const swingLow  = Math.min(...lows.slice(-50));
    const range = swingHigh - swingLow;
    if (range === 0) return { zone:'UNKNOWN', position:50, isOptimal:false, tradeMatch:false, display:'⚪ Zone N/A' };

    const pos = (current - swingLow) / range * 100; // 0%=low, 100%=high
    // OTE for LONG: 62–79% from low side = 0.618–0.786 retracement from high
    // Which means position between (100-78.6)=21.4% and (100-61.8)=38.2% from low
    const inOTE_Long  = pos >= 21 && pos <= 39;
    // OTE for SHORT: 62–79% from high side = position between 61.8% and 78.6% from low
    const inOTE_Short = pos >= 62 && pos <= 79;

    let zone, tradeMatch = false;
    if      (pos < 38)  zone = 'DISCOUNT';
    else if (pos > 62)  zone = 'PREMIUM';
    else                zone = 'EQUILIBRIUM';

    const isOptimal = (direction === 'LONG' && inOTE_Long) || (direction === 'SHORT' && inOTE_Short);
    if (isOptimal) zone = 'OTE';
    if (direction === 'LONG'  && (zone === 'DISCOUNT' || zone === 'OTE')) tradeMatch = true;
    if (direction === 'SHORT' && (zone === 'PREMIUM'  || zone === 'OTE')) tradeMatch = true;

    let display;
    if (zone === 'OTE')          display = `🎯 *OTE Zone!* ${pos.toFixed(0)}% — Institutional entry zone ✅`;
    else if (zone === 'DISCOUNT') display = `🟢 Discount Zone ${pos.toFixed(0)}% ${direction==='LONG'?'✅ Aligned':'⚠️ Against SHORT'}`;
    else if (zone === 'PREMIUM')  display = `🔴 Premium Zone ${pos.toFixed(0)}% ${direction==='SHORT'?'✅ Aligned':'⚠️ Against LONG'}`;
    else                          display = `⚪ Equilibrium (${pos.toFixed(0)}%) — wait for direction`;

    return { zone, position: parseFloat(pos.toFixed(1)), isOptimal, tradeMatch, display };
}

// ============================================================
// 🆕 v5: Williams %R  (Larry Williams / top hedge fund staple)
// Oversold < -80 → LONG signal | Overbought > -20 → SHORT signal
// ============================================================
function calculateWilliamsR(candles, period = 14) {
    if (candles.length < period+1) return { value:-50, signal:'Neutral', isBull:false, isBear:false, display:'⚪ W%R N/A' };
    const slice  = candles.slice(-period);
    const hH     = Math.max(...slice.map(c => parseFloat(c[2])));
    const lL     = Math.min(...slice.map(c => parseFloat(c[3])));
    const close  = parseFloat(candles[candles.length-1][4]);
    if (hH === lL) return { value:-50, signal:'Neutral', isBull:false, isBear:false, display:'⚪ W%R: -50' };

    const wr = ((hH - close) / (hH - lL)) * -100;

    const prevSlice = candles.slice(-period-1, -1);
    const pHH   = Math.max(...prevSlice.map(c => parseFloat(c[2])));
    const pLL   = Math.min(...prevSlice.map(c => parseFloat(c[3])));
    const pClose= parseFloat(candles[candles.length-2][4]);
    const prevWr= pHH!==pLL ? ((pHH-pClose)/(pHH-pLL))*-100 : -50;

    let signal, isBull=false, isBear=false;
    if (wr < -80)                          { signal='Oversold 🟢';      isBull=true; }
    else if (wr > -20)                     { signal='Overbought 🔴';    isBear=true; }
    else if (wr > -50 && prevWr <= -50)    { signal='Bullish Cross ⬆️'; isBull=true; }
    else if (wr < -50 && prevWr >= -50)    { signal='Bearish Cross ⬇️'; isBear=true; }
    else signal = 'Neutral';

    return { value:parseFloat(wr.toFixed(1)), signal, isBull, isBear,
             display:`${isBull?'🟢':isBear?'🔴':'⚪'} W%R: ${wr.toFixed(1)} — ${signal}` };
}

// ============================================================
// 🆕 v5: Ichimoku Cloud  (Japanese institutional standard)
// TK Cross above cloud = strongest bull signal
// TK Cross below cloud = strongest bear signal
// Price inside cloud = avoid (choppy zone)
// ============================================================
function calculateIchimoku(candles) {
    if (candles.length < 54) return { signal:'NEUTRAL', isBull:false, isBear:false, tkCross:'None', display:'⚪ Ichimoku N/A (need 54+ candles)' };
    const n      = candles.length;
    const highs  = candles.map(c => parseFloat(c[2]));
    const lows   = candles.map(c => parseFloat(c[3]));
    const closes = candles.map(c => parseFloat(c[4]));

    const hl2 = (h, l, from, to) => (Math.max(...h.slice(from,to)) + Math.min(...l.slice(from,to))) / 2;

    const tenkan  = hl2(highs, lows, n-9,  n);
    const kijun   = hl2(highs, lows, n-26, n);
    const senkouA = (tenkan + kijun) / 2;
    const senkouB = hl2(highs, lows, n-52, n);

    const tenkanP = hl2(highs, lows, n-10, n-1);
    const kijunP  = hl2(highs, lows, n-27, n-1);

    const price      = closes[n-1];
    const cloudTop   = Math.max(senkouA, senkouB);
    const cloudBot   = Math.min(senkouA, senkouB);
    const aboveCloud = price > cloudTop;
    const belowCloud = price < cloudBot;
    const inCloud    = !aboveCloud && !belowCloud;

    const tkBullNow  = tenkan > kijun;
    const tkBullPrev = tenkanP > kijunP;
    const tkBullCross= tkBullNow && !tkBullPrev;
    const tkBearCross= !tkBullNow && tkBullPrev;

    let signal, isBull=false, isBear=false, display;
    if      (aboveCloud && tkBullCross) { signal='STRONG_BULL'; isBull=true; display='☁️ *Ichimoku BULL CROSS above cloud!* 🚀 (Strongest buy signal)'; }
    else if (belowCloud && tkBearCross) { signal='STRONG_BEAR'; isBear=true; display='☁️ *Ichimoku BEAR CROSS below cloud!* 📉 (Strongest sell signal)'; }
    else if (aboveCloud && tkBullNow)   { signal='BULL';        isBull=true; display=`☁️ Ichimoku: Above cloud 🟢 (Tenkan > Kijun — Bull trend)`; }
    else if (belowCloud && !tkBullNow)  { signal='BEAR';        isBear=true; display=`☁️ Ichimoku: Below cloud 🔴 (Tenkan < Kijun — Bear trend)`; }
    else if (inCloud)                   { signal='NEUTRAL';              display=`☁️ Ichimoku: Inside cloud ⚠️ (Avoid — choppy zone)`; }
    else if (aboveCloud)                { signal='MILD_BULL';  isBull=true; display=`☁️ Ichimoku: Above cloud 🟡 (Wait for TK cross)`; }
    else                                { signal='MILD_BEAR';  isBear=true; display=`☁️ Ichimoku: Below cloud 🟡 (Wait for TK cross)`; }

    return { tenkan:tenkan.toFixed(4), kijun:kijun.toFixed(4), cloudTop:cloudTop.toFixed(4), cloudBot:cloudBot.toFixed(4),
             aboveCloud, belowCloud, inCloud, tkBullCross, tkBearCross, signal, isBull, isBear, display };
}

// ============================================================
// 🆕 v5: Heikin Ashi Trend (noise-filtered momentum)
// 3+ consecutive HA candles with no wick = momentum candle
// Used by professional swing traders for trend confirmation
// ============================================================
function getHeikinAshiTrend(candles) {
    if (candles.length < 10) return { signal:'NEUTRAL', consecutive:0, isBull:false, isBear:false, isStrong:false, display:'⚪ HA N/A' };

    // Build HA array
    const ha = [];
    for (let i = 0; i < candles.length; i++) {
        const o=parseFloat(candles[i][1]), h=parseFloat(candles[i][2]);
        const l=parseFloat(candles[i][3]), c=parseFloat(candles[i][4]);
        const haC = (o+h+l+c)/4;
        const haO = i===0 ? (o+c)/2 : (ha[i-1].o + ha[i-1].c)/2;
        const haH = Math.max(h, haO, haC);
        const haL = Math.min(l, haO, haC);
        ha.push({o:haO, h:haH, l:haL, c:haC});
    }

    // Count consecutive same-direction candles from most recent
    let streak=0, dir=null;
    for (let i=ha.length-1; i>=Math.max(0,ha.length-10); i--) {
        const bull = ha[i].c > ha[i].o;
        if (dir===null) { dir=bull?'BULL':'BEAR'; streak=1; }
        else if ((dir==='BULL'&&bull)||(dir==='BEAR'&&!bull)) streak++;
        else break;
    }

    const last = ha[ha.length-1];
    const range = last.h - last.l;
    const noLower = range>0 && (Math.min(last.o,last.c) - last.l) / range < 0.05;
    const noUpper = range>0 && (last.h - Math.max(last.o,last.c)) / range < 0.05;
    const isBull = dir==='BULL', isBear = dir==='BEAR';
    const isStrong = streak>=3;
    const momentum = (isBull&&noLower)||(isBear&&noUpper);

    let display;
    if (isStrong && momentum && isBull) display=`🕯️ Heikin Ashi: ${streak}× Bull 🚀 (Strong — no lower shadow)`;
    else if (isStrong && momentum && isBear) display=`🕯️ Heikin Ashi: ${streak}× Bear 📉 (Strong — no upper shadow)`;
    else if (isStrong && isBull) display=`🕯️ Heikin Ashi: ${streak}× Bull 🟢`;
    else if (isStrong && isBear) display=`🕯️ Heikin Ashi: ${streak}× Bear 🔴`;
    else display=`🕯️ Heikin Ashi: ${streak} candle ${isBull?'Bull 🟡':'Bear 🟡'}`;

    return { signal:dir||'NEUTRAL', consecutive:streak, isStrong, isBull, isBear, momentum, display };
}

// ============================================================
// 🆕 v5: CVD Approximation (Cumulative Volume Delta)
// Estimates institutional buy/sell pressure from OHLCV
// CVD rising + price falling = smart money accumulating
// CVD falling + price rising = smart money distributing
// ============================================================
function approximateCVD(candles) {
    if (candles.length < 20) return { trend:'NEUTRAL', isBull:false, isBear:false, bullDiv:false, bearDiv:false, display:'⚪ CVD N/A' };

    // (Close-Low)/(High-Low) = fraction of bar that was "bought"
    const deltas = candles.map(c => {
        const h=parseFloat(c[2]), l=parseFloat(c[3]), cl=parseFloat(c[4]), v=parseFloat(c[5]);
        if (h===l) return 0;
        return ((cl-l)/(h-l)*2 - 1) * v; // +v = pure buy, -v = pure sell
    });

    // Cumulative sum
    let cum=0; const cvd=deltas.map(d=>(cum+=d));

    const recent5 = cvd.slice(-5).reduce((a,b)=>a+b,0)/5;
    const prior5  = cvd.slice(-10,-5).reduce((a,b)=>a+b,0)/5;
    const rising  = recent5 > prior5*1.01;
    const falling = recent5 < prior5*0.99;

    const prices = candles.map(c=>parseFloat(c[4]));
    const priceUp = prices[prices.length-1] > prices[prices.length-6];

    const bullDiv = !priceUp && rising;  // hidden accumulation
    const bearDiv = priceUp  && falling; // hidden distribution

    let trend, isBull=false, isBear=false, display;
    if      (bullDiv)           { trend='BULL_DIV'; isBull=true; display='📊 CVD: Bullish Divergence 🚀 (Smart money accumulating on dip)'; }
    else if (bearDiv)           { trend='BEAR_DIV'; isBear=true; display='📊 CVD: Bearish Divergence ⚠️ (Smart money distributing into rally)'; }
    else if (rising && priceUp) { trend='BULL';     isBull=true; display='📊 CVD: Rising ↑ 🟢 (Buy pressure confirmed)'; }
    else if (falling && !priceUp){ trend='BEAR';    isBear=true; display='📊 CVD: Falling ↓ 🔴 (Sell pressure confirmed)'; }
    else                        { trend='NEUTRAL';               display='📊 CVD: Neutral ⚪'; }

    return { trend, isBull, isBear, bullDiv, bearDiv, display };
}

// ============================================================
// 🆕 v5: Daily Pivot Points (Institutional Price Magnets)
// Floor traders / banks use P, R1/R2/R3, S1/S2/S3 every day
// ============================================================
function calculatePivotPoints(dailyCandles) {
    if (!dailyCandles || dailyCandles.length < 2) return null;
    const prev = dailyCandles[dailyCandles.length-2];
    const H=parseFloat(prev[2]), L=parseFloat(prev[3]), C=parseFloat(prev[4]);
    const P  = (H+L+C)/3;
    const R1 = 2*P-L,  R2 = P+(H-L),  R3 = H+2*(P-L);
    const S1 = 2*P-H,  S2 = P-(H-L),  S3 = L-2*(H-P);
    return { P:P.toFixed(4), R1:R1.toFixed(4), R2:R2.toFixed(4), R3:R3.toFixed(4),
             S1:S1.toFixed(4), S2:S2.toFixed(4), S3:S3.toFixed(4) };
}

function getPivotSignal(currentPrice, pivots, direction) {
    if (!pivots) return { signal:'NEUTRAL', isBull:false, isBear:false, nearLevel:null, display:'⚪ Pivots N/A' };
    const price=parseFloat(currentPrice);
    const levels=[
        {name:'S3',value:parseFloat(pivots.S3),type:'support'},
        {name:'S2',value:parseFloat(pivots.S2),type:'support'},
        {name:'S1',value:parseFloat(pivots.S1),type:'support'},
        {name:'P', value:parseFloat(pivots.P), type:'pivot'},
        {name:'R1',value:parseFloat(pivots.R1),type:'resist'},
        {name:'R2',value:parseFloat(pivots.R2),type:'resist'},
        {name:'R3',value:parseFloat(pivots.R3),type:'resist'}
    ];

    let near=null, minD=Infinity;
    for (const lv of levels) {
        const d=Math.abs(price-lv.value)/price;
        if (d<0.006 && d<minD) { minD=d; near=lv; }
    }

    const below=levels.filter(l=>l.value<price).pop();
    const above=levels.filter(l=>l.value>price)[0];

    if (!near) return { signal:'BETWEEN', isBull:false, isBear:false, nearLevel:null,
        display:`📌 Pivots: ${below?.name||'?'} $${below?.value.toFixed(4)||'?'} ↔ ${above?.name||'?'} $${above?.value.toFixed(4)||'?'}` };

    const isBull = near.type==='support' && direction==='LONG';
    const isBear = near.type==='resist'  && direction==='SHORT';
    const isPiv  = near.type==='pivot';
    return { signal:isBull?'SUPPORT':isBear?'RESIST':'PIVOT', isBull, isBear, nearLevel:near,
        display:`📌 At ${near.name} $${near.value.toFixed(4)} ${isBull?'✅ Support for LONG':isBear?'✅ Resist for SHORT':isPiv?'(Pivot)':''}` };
}

// ============================================================
// 🆕 v5: Fibonacci Confluence Zone
// 3+ fib levels from multiple swing measurements clustering
// = very high probability reversal or continuation zone
// ============================================================
function checkFibConfluence(candles, direction) {
    if (candles.length < 30) return { hasConfluence:false, count:0, zone:null, display:'⚪ Fib Confluence N/A' };
    const n=candles.length;
    const highs  = candles.map(c=>parseFloat(c[2]));
    const lows   = candles.map(c=>parseFloat(c[3]));
    const current= parseFloat(candles[n-1][4]);

    // Collect swing highs/lows
    const sH=[],sL=[];
    for (let i=3;i<n-3;i++) {
        if (highs[i]>highs[i-1]&&highs[i]>highs[i-2]&&highs[i]>highs[i-3]&&highs[i]>highs[i+1]&&highs[i]>highs[i+2]&&highs[i]>highs[i+3]) sH.push(highs[i]);
        if (lows[i] <lows[i-1] &&lows[i] <lows[i-2] &&lows[i] <lows[i-3] &&lows[i] <lows[i+1] &&lows[i] <lows[i+2] &&lows[i] <lows[i+3])  sL.push(lows[i]);
    }
    if (!sH.length||!sL.length) return { hasConfluence:false, count:0, zone:null, display:'⚪ Fib: insufficient swings' };

    // Generate fib levels from top-3 swings
    const topH=sH.slice(-3), topL=sL.slice(-3);
    const fibLevels=[];
    const ratios=[0.236,0.382,0.5,0.618,0.786];
    for (const h of topH) {
        for (const l of topL) {
            if (h<=l) continue;
            const rng=h-l;
            for (const r of ratios) {
                fibLevels.push(h - rng*r);          // retracement from high
                fibLevels.push(l + rng*r);          // retracement from low
            }
            fibLevels.push(h + rng*0.618);          // 1.618 extension
            fibLevels.push(l - rng*0.618);
        }
    }

    // Count levels within 0.8% of current price
    const near = fibLevels.filter(fl => Math.abs(fl-current)/current < 0.008);
    const hasConfluence = near.length >= 3;
    const zone = hasConfluence ? (near.reduce((a,b)=>a+b,0)/near.length).toFixed(4) : null;
    const display = hasConfluence
        ? `🔢 *Fib Confluence Zone!* ${near.length} levels at $${zone} ✅`
        : `⚪ Fib: No confluence (${near.length} level${near.length!==1?'s':''} near price)`;

    return { hasConfluence, count:near.length, zone, display };
}


// ═══════════════════════════════════════════════════════════════
//  v6 NEW INDICATORS — Big Profit Entry & Quality Upgrades
// ═══════════════════════════════════════════════════════════════

/**
 * BB SQUEEZE EXPLOSION — Energy builds during squeeze, releases in big move.
 * Squeeze (width < 65% avg) → Explosion (rapid width expansion) = best entry.
 */
function detectBBSqueezeExplosion(candles, period = 20) {
    if (candles.length < period + 15) return { isSqueezing: false, exploding: false, explosionDir: 'NONE', squeezeDuration: 0, display: '📊 BB Normal' };

    const widths = [];
    for (let i = Math.max(period, candles.length - 22); i < candles.length; i++) {
        const slice  = candles.slice(i - period, i);
        const closes = slice.map(c => parseFloat(c[4]));
        const sma    = closes.reduce((s, v) => s + v, 0) / closes.length;
        const std    = Math.sqrt(closes.reduce((s, v) => s + Math.pow(v - sma, 2), 0) / closes.length);
        widths.push(std * 4 / sma * 100);
    }
    if (widths.length < 6) return { isSqueezing: false, exploding: false, explosionDir: 'NONE', squeezeDuration: 0, display: '📊 BB Normal' };

    const avgW     = widths.reduce((s, v) => s + v, 0) / widths.length;
    const currW    = widths[widths.length - 1];
    const prevW    = widths[widths.length - 2];
    const sqzThres = avgW * 0.65;

    const isSqueezing    = currW < sqzThres;
    let squeezeDuration  = 0;
    for (let i = widths.length - 1; i >= 0; i--) { if (widths[i] < sqzThres) squeezeDuration++; else break; }

    const wasSqz   = widths.slice(-5, -1).some(w => w < sqzThres);
    const nowExp   = currW > prevW * 1.25;
    const exploding = wasSqz && nowExp && !isSqueezing;

    const lastClose = parseFloat(candles[candles.length - 1][4]);
    const closes20  = candles.slice(-period).map(c => parseFloat(c[4]));
    const midline   = closes20.reduce((s, v) => s + v, 0) / closes20.length;
    const explosionDir = lastClose > midline ? 'BULL' : 'BEAR';

    let display;
    if      (exploding)    display = `💥 *BB EXPLOSION ${explosionDir}!* Width: ${currW.toFixed(2)}% ← Was: ${prevW.toFixed(2)}% — Big move NOW!`;
    else if (isSqueezing)  display = `⚡ *BB SQUEEZE! (${squeezeDuration} bars)* Width: ${currW.toFixed(2)}% vs avg ${avgW.toFixed(2)}% — Breakout imminent!`;
    else                   display = `📊 BB Normal: Width ${currW.toFixed(2)}%`;

    return { isSqueezing, exploding, explosionDir, squeezeDuration, currentWidth: currW.toFixed(2), avgWidth: avgW.toFixed(2), display };
}

/**
 * VOLATILITY EXPANSION — ADX surging rapidly = trend JUST started = best entry timing.
 * justStarted (+3 pts) = ADX was weak (<20), now crossed 25 = EARLIEST possible entry.
 */
function detectVolatilityExpansion(candles) {
    if (candles.length < 62) return { expanding: false, justStarted: false, strong: false, display: '' };
    try {
        const adxNow = calculateADX(candles.slice(-30)).value;
        const adxOld = calculateADX(candles.slice(-36, -6)).value;
        const change = adxNow - adxOld;
        const expanding   = change >= 8  && adxNow >= 22;
        const justStarted = adxOld < 20  && adxNow >= 25 && change >= 8;
        const strong      = adxNow >= 30 && change >= 12;
        return {
            expanding, justStarted, strong,
            adxNow: adxNow.toFixed(1), adxOld: adxOld.toFixed(1), adxChange: change.toFixed(1),
            display: justStarted
                ? `⚡ *TREND JUST STARTED!* ADX ${adxOld.toFixed(0)}→${adxNow.toFixed(0)} (+${change.toFixed(0)}) — Ride the wave! 🌊`
                : expanding ? `📈 Volatility Expanding: ADX ${adxOld.toFixed(0)}→${adxNow.toFixed(0)} (+${change.toFixed(0)})`
                : '',
        };
    } catch(e) { return { expanding: false, justStarted: false, strong: false, display: '' }; }
}

/**
 * MARKET MAKER TRAP DETECTOR — False breakout above resistance / below support.
 * Institutions hunt stop-losses then reverse. Best counter-trap entries.
 * Bull Trap → short entry; Bear Trap → long entry.
 */
function detectMarketMakerTrap(candles) {
    if (candles.length < 22) return { bullTrap: false, bearTrap: false, signal: 'None', display: 'None' };

    const prior   = candles.slice(-22, -1);
    const last    = candles[candles.length - 1];
    const lastH   = parseFloat(last[2]), lastL = parseFloat(last[3]);
    const lastC   = parseFloat(last[4]), lastO = parseFloat(last[1]);
    const range   = lastH - lastL;
    if (range === 0) return { bullTrap: false, bearTrap: false, signal: 'None', display: 'None' };

    let swingH = 0, swingL = Infinity;
    prior.forEach(c => {
        const h = parseFloat(c[2]), l = parseFloat(c[3]);
        if (h > swingH) swingH = h;
        if (l < swingL) swingL = l;
    });

    const bullTrap = lastH > swingH * 1.001 && lastC < swingH && lastC < lastO && (lastH - lastC) / range > 0.45;
    const bearTrap = lastL < swingL * 0.999 && lastC > swingL && lastC > lastO && (lastC - lastL) / range > 0.45;
    const trapLevel = bullTrap ? swingH.toFixed(4) : bearTrap ? swingL.toFixed(4) : null;
    const signal    = bullTrap ? `🪤 Bull Trap @ $${trapLevel} → SHORT`
                    : bearTrap ? `🪤 Bear Trap @ $${trapLevel} → LONG` : 'None';

    return { bullTrap, bearTrap, trapLevel, signal, display: signal };
}

/**
 * WEEKLY & MONTHLY TARGET CALCULATOR
 * Derives extended TP targets from weekly/monthly institutional levels.
 * These are price magnets — institutions target these levels for liquidity hunts.
 * @param {Array} dailyCandles — 30+ daily candles recommended
 */
function getWeeklyMonthlyTargets(dailyCandles, direction, currentPrice) {
    if (!dailyCandles || dailyCandles.length < 7) return null;

    const thisWeek   = dailyCandles.slice(-7);
    const weekHigh   = Math.max(...thisWeek.map(c => parseFloat(c[2])));
    const weekLow    = Math.min(...thisWeek.map(c => parseFloat(c[3])));
    let prevWeekHigh = null, prevWeekLow = null;
    if (dailyCandles.length >= 14) {
        const prevWeek = dailyCandles.slice(-14, -7);
        prevWeekHigh = Math.max(...prevWeek.map(c => parseFloat(c[2])));
        prevWeekLow  = Math.min(...prevWeek.map(c => parseFloat(c[3])));
    }
    const monthHigh = Math.max(...dailyCandles.map(c => parseFloat(c[2])));
    const monthLow  = Math.min(...dailyCandles.map(c => parseFloat(c[3])));

    const longCands  = [prevWeekHigh, weekHigh, monthHigh].filter(v => v && v > currentPrice * 1.003).sort((a, b) => a - b);
    const shortCands = [prevWeekLow,  weekLow,  monthLow ].filter(v => v && v < currentPrice * 0.997).sort((a, b) => b - a);

    const nearT = direction === 'LONG' ? longCands[0]  : shortCands[0];
    const bigT  = direction === 'LONG' ? longCands[longCands.length  - 1] : shortCands[shortCands.length - 1];
    if (!nearT) return null;

    const nearPct = ((Math.abs(nearT - currentPrice) / currentPrice) * 100).toFixed(2);
    const bigPct  = bigT && bigT !== nearT ? ((Math.abs(bigT - currentPrice) / currentPrice) * 100).toFixed(2) : null;
    const display = direction === 'LONG'
        ? `🗓️ Week High: $${nearT.toFixed(4)} (+${nearPct}%)${bigT && bigT !== nearT ? ' | Month High: $' + bigT.toFixed(4) + ' (+' + bigPct + '%)' : ''}`
        : `🗓️ Week Low: $${nearT.toFixed(4)} (-${nearPct}%)${bigT && bigT !== nearT ? ' | Month Low: $' + bigT.toFixed(4) + ' (-' + bigPct + '%)' : ''}`;

    return { weekHigh, weekLow, prevWeekHigh, prevWeekLow, monthHigh, monthLow, nearTarget: nearT, bigTarget: bigT || nearT, nearPct, bigPct, display };
}

/**
 * CME GAP DETECTOR
 * Daily candle gaps (≥0.4%) have high fill probability (~85-90% for BTC).
 * Unfilled gap above → upside TP target; gap below → downside TP target.
 */
function detectCMEGap(dailyCandles, currentPrice) {
    if (!dailyCandles || dailyCandles.length < 3) return { hasGap: false, display: '⚪ No CME Gap' };
    const search = dailyCandles.slice(-14);
    for (let i = search.length - 1; i >= 1; i--) {
        const prevClose = parseFloat(search[i - 1][4]);
        const currOpen  = parseFloat(search[i][1]);
        const gapPct    = Math.abs(currOpen - prevClose) / prevClose * 100;
        if (gapPct >= 0.4) {
            const gapAbove  = currOpen > prevClose;
            const gapTop    = Math.max(prevClose, currOpen);
            const gapBottom = Math.min(prevClose, currOpen);
            const fillTarget = gapAbove ? gapBottom : gapTop;
            const filled    = currentPrice >= gapBottom && currentPrice <= gapTop;
            const fillPct   = ((Math.abs(currentPrice - fillTarget) / currentPrice) * 100).toFixed(2);
            let display;
            if      (filled)                      display = `✅ CME Gap Being Filled @ $${((gapTop + gapBottom) / 2).toFixed(4)}`;
            else if (currentPrice > gapTop)       display = `🎯 *CME Gap Below: $${gapBottom.toFixed(4)}–$${gapTop.toFixed(4)}* (${fillPct}% away, ${gapPct.toFixed(2)}% gap) — ~85% fill probability!`;
            else if (currentPrice < gapBottom)    display = `🎯 *CME Gap Above: $${gapBottom.toFixed(4)}–$${gapTop.toFixed(4)}* (${fillPct}% away, ${gapPct.toFixed(2)}% gap) — ~85% fill probability!`;
            else                                  display = `⚠️ Inside CME Gap $${gapBottom.toFixed(4)}–$${gapTop.toFixed(4)}`;
            return { hasGap: true, gapAbove, gapTop: gapTop.toFixed(4), gapBottom: gapBottom.toFixed(4), fillTarget: fillTarget.toFixed(4), fillPct, filled, gapPct: gapPct.toFixed(2), display };
        }
    }
    return { hasGap: false, display: '⚪ No CME gap detected' };
}

/**
 * 3-TIMEFRAME STRICT ALIGNMENT
 * Only signals where 5m + primary TF + 1H all agree = highest accuracy.
 */
function check3TFAlignment(trend5m, trendPrimary, trend1H) {
    const b5  = trend5m      ? (trend5m.includes('Bullish')      || trend5m.includes('🟢'))  : false;
    const b15 = trendPrimary ? (trendPrimary.includes('Bullish') || trendPrimary.includes('🟢')) : false;
    const b1H = trend1H      ? (trend1H.includes('Bullish')      || trend1H.includes('🟢'))  : false;
    const allBull = b5 && b15 && b1H;
    const allBear = !b5 && !b15 && !b1H;
    const aligned   = allBull || allBear;
    const direction = allBull ? 'LONG' : allBear ? 'SHORT' : 'MIXED';
    const count = (b5 === b15 ? 1 : 0) + (b15 === b1H ? 1 : 0) + (b5 === b1H ? 1 : 0);
    return {
        aligned, allBull, allBear, direction,
        score: aligned ? 2 : (count >= 2 ? 1 : 0),
        display: aligned
            ? `✅ *3TF ALIGNED ${direction}* — 5m + ${trendPrimary?.includes('15') ? '15m' : 'TF'} + 1H ALL ${direction} 🎯`
            : `⚠️ 3TF Mixed: 5m=${b5?'🟢':'🔴'} | PrimaryTF=${b15?'🟢':'🔴'} | 1H=${b1H?'🟢':'🔴'}`,
    };
}

module.exports = {
    calculateRSI, 
    calculateEMA, 
    calculateATR, 
    checkDivergence, 
    checkCandlePattern, 
    calculatePOC, 
    calculateMACD, 
    calculateVWAP, 
    checkVolumeBreakout, 
    validateEntryPoint,
    confirmEntry5m, 
    checkRRR, 
    calculateADX, 
    checkHarmonicPattern, 
    checkICTSilverBullet,
    calculateStochRSI, 
    calculateBollingerBands,
    detectMTFOrderBlocks,
    detectMTFOBs, 
    calculateSmartTPs, 
    calculateSmartSL,
    checkMTFRSIConfluence, 
    detectVolumeNodes, 
    getSessionQuality, 
    checkCandleCloseConfirmation,
    getKeyLevels,
    getEMARibbon,
    scanFairValueGaps,
    calculateSupertrend,
    calculateRVOL,
    checkMTFMACD,
    // 🆕 v5 NEW indicators
    detectWyckoffPhase,
    detectBreakerBlocks,
    detectEqualHighsLows,
    checkPremiumDiscount,
    calculateWilliamsR,
    calculateIchimoku,
    getHeikinAshiTrend,
    approximateCVD,
    calculatePivotPoints,
    getPivotSignal,
    checkFibConfluence,
    // 🆕 v6 BIG PROFIT indicators
    detectBBSqueezeExplosion,
    detectVolatilityExpansion,
    detectMarketMakerTrap,
    getWeeklyMonthlyTargets,
    detectCMEGap,
    check3TFAlignment,
    // 🆕 v7 PRO VVIP indicators
    calculateGannAngles,
    calculateRenko,
    getMoonCycle,
    getDynamicSR,
    detectBOS,
    scanAdvancedCandlePatterns,
    getFibonacciLevels,
    calculateMFI,
    calculateROC,
    calculateCCI,
    detectMomentumShift,
};

// ============================================================
// 🆕 v7 PRO VVIP — Gann Angle Calculator
// W.D. Gann: price & time have geometric relationships.
// 1x1 angle (45°) = most important: price moves 1 unit per time unit.
// If price is ABOVE 1x1 from a major low → uptrend intact.
// If price BREAKS below 1x1 → significant sell signal.
// ============================================================
function calculateGannAngles(candles) {
    if (candles.length < 30) return { signal: 'NEUTRAL', isBull: false, isBear: false, display: '⚪ Gann N/A (need 30+ candles)' };

    const n      = candles.length;
    const closes = candles.map(c => parseFloat(c[4]));
    const highs  = candles.map(c => parseFloat(c[2]));
    const lows   = candles.map(c => parseFloat(c[3]));

    // Find the most recent significant swing low & high (pivot anchors)
    let swingLowIdx = 0, swingHighIdx = 0;
    for (let i = 2; i < n - 2; i++) {
        if (lows[i] < lows[swingLowIdx])   swingLowIdx  = i;
        if (highs[i] > highs[swingHighIdx]) swingHighIdx = i;
    }

    const swingLow  = lows[swingLowIdx];
    const swingHigh = highs[swingHighIdx];
    const current   = closes[n - 1];

    // Gann Box: price range / time range = price-per-bar unit
    const priceRange = swingHigh - swingLow;
    const timeBars   = swingHighIdx > swingLowIdx
        ? (swingHighIdx - swingLowIdx)
        : (swingLowIdx - swingHighIdx);
    if (timeBars === 0 || priceRange === 0) return { signal: 'NEUTRAL', isBull: false, isBear: false, display: '⚪ Gann: insufficient range' };

    const pricePerBar = priceRange / timeBars; // 1x1 unit

    // Project Gann angles from swing low
    const barsFromLow = n - 1 - swingLowIdx;
    const gann1x1  = swingLow + pricePerBar * barsFromLow;          // 45°
    const gann2x1  = swingLow + (pricePerBar * 2) * barsFromLow;   // 63.75° (steep)
    const gann1x2  = swingLow + (pricePerBar / 2) * barsFromLow;   // 26.25° (shallow)
    const gann4x1  = swingLow + (pricePerBar * 4) * barsFromLow;   // 75° (very steep)
    const gann1x4  = swingLow + (pricePerBar / 4) * barsFromLow;   // 15° (very shallow)

    // Determine which angle price is currently between (support/resistance)
    let signal = 'NEUTRAL', isBull = false, isBear = false, zone = '';

    if (current >= gann2x1) {
        signal = 'STRONG_BULL'; isBull = true; zone = 'Above 2x1 🔥';
    } else if (current >= gann1x1) {
        signal = 'BULL'; isBull = true; zone = `Between 1x1 & 2x1 🟢 ($${gann1x1.toFixed(4)})`;
    } else if (current >= gann1x2) {
        signal = 'NEUTRAL'; zone = `Between 1x2 & 1x1 ⚠️ — Watch $${gann1x1.toFixed(4)}`;
    } else if (current >= gann1x4) {
        signal = 'BEAR'; isBear = true; zone = `Below 1x1 🔴 — Fallen to 1x4 angle`;
    } else {
        signal = 'STRONG_BEAR'; isBear = true; zone = 'Below all angles 📉';
    }

    const display = `📐 Gann: 1x1=$${gann1x1.toFixed(4)} | 2x1=$${gann2x1.toFixed(4)} | Price ${zone}`;
    return {
        signal, isBull, isBear,
        gann1x1: gann1x1.toFixed(4), gann2x1: gann2x1.toFixed(4),
        gann1x2: gann1x2.toFixed(4), gann4x1: gann4x1.toFixed(4), gann1x4: gann1x4.toFixed(4),
        swingLow: swingLow.toFixed(4), swingHigh: swingHigh.toFixed(4),
        display,
    };
}

// ============================================================
// 🆕 v7 PRO VVIP — Renko Chart Analysis
// Renko bricks ignore time, only react to price movement.
// Filters noise better than candlesticks.
// Rising bricks = uptrend; Falling bricks = downtrend.
// Reversal (3+ bricks opposite) = high-probability signal.
// ============================================================
function calculateRenko(candles, brickSizeMultiplier = 1.0) {
    if (candles.length < 20) return { trend: 'NEUTRAL', brickCount: 0, reversal: false, isBull: false, isBear: false, display: '⚪ Renko N/A' };

    const closes = candles.map(c => parseFloat(c[4]));
    const atrRaw = parseFloat(calculateATR(candles, 14));
    const brickSize = atrRaw * brickSizeMultiplier;
    if (!brickSize || brickSize <= 0) return { trend: 'NEUTRAL', brickCount: 0, reversal: false, isBull: false, isBear: false, display: '⚪ Renko: ATR=0' };

    const bricks = [];
    let lastClose = closes[0];

    for (let i = 1; i < closes.length; i++) {
        const diff = closes[i] - lastClose;
        if (Math.abs(diff) >= brickSize) {
            const numBricks = Math.floor(Math.abs(diff) / brickSize);
            const dir = diff > 0 ? 'UP' : 'DOWN';
            for (let b = 0; b < numBricks; b++) {
                bricks.push(dir);
                lastClose += (dir === 'UP' ? brickSize : -brickSize);
            }
        }
    }

    if (bricks.length === 0) return { trend: 'NEUTRAL', brickCount: 0, reversal: false, isBull: false, isBear: false, display: `⚪ Renko: No bricks (ATR brick=$${brickSize.toFixed(4)})` };

    // Count consecutive same-direction bricks from most recent
    let streak = 1, lastDir = bricks[bricks.length - 1];
    for (let i = bricks.length - 2; i >= Math.max(0, bricks.length - 10); i--) {
        if (bricks[i] === lastDir) streak++;
        else break;
    }

    // Reversal: last direction changed from previous streak
    const prevDir = bricks.length > streak ? bricks[bricks.length - streak - 1] : null;
    const reversal = prevDir !== null && prevDir !== lastDir && streak >= 2;
    const isBull = lastDir === 'UP';
    const isBear = lastDir === 'DOWN';
    const trend = isBull ? 'BULL' : 'BEAR';

    let display;
    if (reversal && isBull)  display = `🧱 *Renko BULLISH REVERSAL!* ${streak} UP bricks (Brick size: $${brickSize.toFixed(4)}) 🚀`;
    else if (reversal && isBear) display = `🧱 *Renko BEARISH REVERSAL!* ${streak} DOWN bricks (Brick size: $${brickSize.toFixed(4)}) 📉`;
    else if (isBull)         display = `🧱 Renko: ${streak}x UP 🟢 (Strong bull momentum)`;
    else                     display = `🧱 Renko: ${streak}x DOWN 🔴 (Strong bear momentum)`;

    return { trend, isBull, isBear, brickCount: bricks.length, streak, reversal, brickSize: brickSize.toFixed(4), lastDir, display };
}

// ============================================================
// 🆕 v7 PRO VVIP — Moon Cycle Detector
// Historically BTC peaks near Full Moon (~30% correlation).
// New Moon = accumulation zone; Full Moon = distribution/reversal.
// Used by: hedge funds, institutional quant desks.
// ============================================================
function getMoonCycle() {
    // Known new moon reference: Jan 11 2024 11:57 UTC
    const refNewMoon  = new Date('2024-01-11T11:57:00Z').getTime();
    const lunarPeriod = 29.53058867 * 24 * 60 * 60 * 1000; // ms
    const now         = Date.now();
    const elapsed     = now - refNewMoon;
    const cyclePos    = ((elapsed % lunarPeriod) + lunarPeriod) % lunarPeriod;
    const dayInCycle  = cyclePos / (24 * 60 * 60 * 1000);
    const phasePct    = (dayInCycle / 29.53) * 100;

    // Phase classification
    let phase, emoji, tradingBias, display;
    if (phasePct < 3.4 || phasePct >= 96.6) {
        phase = 'New Moon'; emoji = '🌑';
        tradingBias = 'ACCUMULATE 🟢 — Historically BTC bottoms near new moon';
    } else if (phasePct < 22.7) {
        phase = 'Waxing Crescent'; emoji = '🌒';
        tradingBias = 'MILD BULL 🟡 — Rising momentum building';
    } else if (phasePct < 26.1) {
        phase = 'First Quarter'; emoji = '🌓';
        tradingBias = 'BULL 🟢 — Strong buying pressure historically';
    } else if (phasePct < 45.5) {
        phase = 'Waxing Gibbous'; emoji = '🌔';
        tradingBias = 'BULL BUT CAUTIOUS 🟡 — Full moon approaching';
    } else if (phasePct < 54.5) {
        phase = 'Full Moon'; emoji = '🌕';
        tradingBias = 'CAUTION / DISTRIBUTE 🔴 — Historically BTC peaks near full moon';
    } else if (phasePct < 73.9) {
        phase = 'Waning Gibbous'; emoji = '🌖';
        tradingBias = 'MILD BEAR ⚠️ — Post-full moon distribution';
    } else if (phasePct < 77.3) {
        phase = 'Last Quarter'; emoji = '🌗';
        tradingBias = 'NEUTRAL ⚪ — Transition phase';
    } else {
        phase = 'Waning Crescent'; emoji = '🌘';
        tradingBias = 'ACCUMULATE 🟢 — Approaching new moon bottom';
    }

    const daysToNewMoon  = ((29.53 - dayInCycle) % 29.53).toFixed(1);
    const daysToFullMoon = ((14.77 - dayInCycle + 29.53) % 29.53).toFixed(1);

    display = `${emoji} Moon: *${phase}* (Day ${dayInCycle.toFixed(1)}/29.5) — ${tradingBias}\n   📅 Next Full Moon: ${daysToFullMoon}d | Next New Moon: ${daysToNewMoon}d`;

    const isFullMoon = phase === 'Full Moon';
    const isNewMoon  = phase === 'New Moon';
    const isBull     = tradingBias.includes('🟢');
    const isBear     = tradingBias.includes('🔴');

    return { phase, emoji, dayInCycle: dayInCycle.toFixed(1), phasePct: phasePct.toFixed(1), tradingBias, isFullMoon, isNewMoon, isBull, isBear, daysToNewMoon, daysToFullMoon, display };
}

// ============================================================
// 🆕 v7 PRO VVIP — Dynamic Support & Resistance
// ATR-adjusted fractal-based levels that MOVE with volatility.
// Unlike static S/R from swing points, Dynamic S/R shifts
// relative to current ATR — tighter in low-vol, wider in high-vol.
// ============================================================
function getDynamicSR(candles, period = 20) {
    if (candles.length < period + 5) return { support: null, resistance: null, display: '⚪ Dynamic S/R N/A' };

    const n      = candles.length;
    const closes = candles.map(c => parseFloat(c[4]));
    const highs  = candles.map(c => parseFloat(c[2]));
    const lows   = candles.map(c => parseFloat(c[3]));
    const current = closes[n - 1];
    const atr     = parseFloat(calculateATR(candles.slice(-period - 5), 14));

    // Dynamic levels from EMA(period) ± ATR bands
    const emaSlice = candles.slice(-period);
    const emaMid   = emaSlice.reduce((s, c) => s + parseFloat(c[4]), 0) / period;

    // ATR-based dynamic bands (Keltner-style)
    const dynR1 = emaMid + atr * 1.0;
    const dynR2 = emaMid + atr * 2.0;
    const dynS1 = emaMid - atr * 1.0;
    const dynS2 = emaMid - atr * 2.0;

    // Fractal-based significant levels (Williams Fractal)
    const fractalHighs = [], fractalLows = [];
    for (let i = 2; i < n - 2; i++) {
        if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2]) {
            fractalHighs.push(highs[i]);
        }
        if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2]) {
            fractalLows.push(lows[i]);
        }
    }

    // Nearest fractal above/below price
    const nearFractalR = fractalHighs.filter(h => h > current).sort((a, b) => a - b)[0];
    const nearFractalS = fractalLows.filter(l => l < current).sort((a, b) => b - a)[0];

    // Pick the NEAREST level (fractal wins if within 2x ATR, else use EMA-based)
    const dynamicResist = nearFractalR && Math.abs(nearFractalR - current) < atr * 2
        ? nearFractalR : dynR1;
    const dynamicSupport = nearFractalS && Math.abs(nearFractalS - current) < atr * 2
        ? nearFractalS : dynS1;

    const rDist = ((dynamicResist - current) / current * 100).toFixed(2);
    const sDist = ((current - dynamicSupport) / current * 100).toFixed(2);

    const nearResist = Math.abs(dynamicResist - current) / current < 0.008;
    const nearSupport = Math.abs(dynamicSupport - current) / current < 0.008;

    let display = `📊 Dynamic S/R: Support $${dynamicSupport.toFixed(4)} (-${sDist}%) | Resistance $${dynamicResist.toFixed(4)} (+${rDist}%)`;
    if (nearResist) display += `\n   ⚠️ Near Dynamic Resistance — Caution for LONG`;
    if (nearSupport) display += `\n   ✅ At Dynamic Support — Good LONG zone`;

    return {
        support: dynamicSupport.toFixed(4), resistance: dynamicResist.toFixed(4),
        dynR1: dynR1.toFixed(4), dynR2: dynR2.toFixed(4), dynS1: dynS1.toFixed(4), dynS2: dynS2.toFixed(4),
        emaMid: emaMid.toFixed(4), atr: atr.toFixed(4),
        nearResist, nearSupport, rDist, sDist, display,
        isBull: nearSupport, isBear: nearResist,
    };
}

// ============================================================
// 🆕 v7 PRO VVIP — Break of Structure (BOS) Detector
// BOS = price breaks beyond the LAST swing high/low in the SAME direction.
// Weaker than ChoCH (doesn't need opposite trend first).
// BOS confirms trend CONTINUATION (vs ChoCH which is REVERSAL).
// ============================================================
function detectBOS(candles) {
    if (candles.length < 20) return { bullBOS: false, bearBOS: false, display: 'None' };

    const n      = candles.length;
    const highs  = candles.map(c => parseFloat(c[2]));
    const lows   = candles.map(c => parseFloat(c[3]));
    const closes = candles.map(c => parseFloat(c[4]));
    const current = closes[n - 1];
    const prevClose = closes[n - 2];

    // Find last swing high and low from last 30 bars
    const lookback = Math.min(n - 3, 30);
    let lastSwingHigh = -Infinity, lastSwingLow = Infinity;

    for (let i = n - lookback; i < n - 2; i++) {
        if (highs[i] > highs[i - 1] && highs[i] > highs[i + 1]) lastSwingHigh = Math.max(lastSwingHigh, highs[i]);
        if (lows[i]  < lows[i - 1]  && lows[i]  < lows[i + 1])  lastSwingLow  = Math.min(lastSwingLow, lows[i]);
    }

    // ✅ FIX: BOS requires 2 consecutive closes beyond swing (filters wick false signals)
    const prev2Close = closes.length > 2 ? closes[n-3] : prevClose;
    const bullBOS = current > lastSwingHigh && prevClose > lastSwingHigh && prev2Close <= lastSwingHigh && lastSwingHigh > -Infinity;
    const bearBOS = current < lastSwingLow  && prevClose < lastSwingLow  && prev2Close >= lastSwingLow  && lastSwingLow  < Infinity;

    let display = 'None';
    if (bullBOS) display = `🔺 *Bullish BOS!* Broke above $${lastSwingHigh.toFixed(4)} — Trend continuation UP 📈`;
    if (bearBOS) display = `🔻 *Bearish BOS!* Broke below $${lastSwingLow.toFixed(4)} — Trend continuation DOWN 📉`;

    return { bullBOS, bearBOS, swingHigh: lastSwingHigh.toFixed(4), swingLow: lastSwingLow.toFixed(4), display };
}

// ============================================================
// 🆕 v7 PRO VVIP — Advanced Candlestick Pattern Scanner
// 15 professional candlestick patterns beyond basic engulfing/hammer.
// Used by institutional traders for high-probability reversals.
// ============================================================
function scanAdvancedCandlePatterns(candles) {
    if (candles.length < 5) return { pattern: 'None', isBull: false, isBear: false, display: '⚪ Candles N/A' };

    const n = candles.length;
    const get = (i) => ({
        o: parseFloat(candles[n - i][1]), h: parseFloat(candles[n - i][2]),
        l: parseFloat(candles[n - i][3]), c: parseFloat(candles[n - i][4]),
    });

    const c1 = get(1); // most recent
    const c2 = get(2); // 1 back
    const c3 = get(3); // 2 back

    const body1 = Math.abs(c1.c - c1.o), range1 = c1.h - c1.l;
    const body2 = Math.abs(c2.c - c2.o), range2 = c2.h - c2.l;
    const body3 = Math.abs(c3.c - c3.o);
    const upperWick1 = c1.h - Math.max(c1.o, c1.c);
    const lowerWick1 = Math.min(c1.o, c1.c) - c1.l;
    const isBull1 = c1.c > c1.o, isBear1 = c1.c < c1.o;
    const isBull2 = c2.c > c2.o, isBear2 = c2.c < c2.o;
    const isBull3 = c3.c > c3.o, isBear3 = c3.c < c3.o;
    const bodyRatio1 = range1 > 0 ? body1 / range1 : 0;

    // 1. Doji — indecision, potential reversal
    if (body1 < range1 * 0.1 && range1 > 0)
        return { pattern: 'Doji', isBull: false, isBear: false, neutral: true, display: '⚪ Doji — Indecision (wait for next candle direction)' };

    // 2. Dragonfly Doji — bullish reversal
    if (body1 < range1 * 0.1 && lowerWick1 > range1 * 0.6 && upperWick1 < range1 * 0.1)
        return { pattern: 'Dragonfly Doji', isBull: true, isBear: false, display: '🐉 Dragonfly Doji 🟢 — Strong bullish reversal signal' };

    // 3. Gravestone Doji — bearish reversal
    if (body1 < range1 * 0.1 && upperWick1 > range1 * 0.6 && lowerWick1 < range1 * 0.1)
        return { pattern: 'Gravestone Doji', isBull: false, isBear: true, display: '⛩️ Gravestone Doji 🔴 — Strong bearish reversal signal' };

    // 4. Morning Star — 3-candle bullish reversal
    if (isBear3 && body3 > range2 * 0.6 && body2 < body3 * 0.4 && isBull1 && c1.c > (c3.o + c3.c) / 2)
        return { pattern: 'Morning Star', isBull: true, isBear: false, display: '🌅 Morning Star 🟢🟢 — 3-candle bullish reversal (HIGH probability)' };

    // 5. Evening Star — 3-candle bearish reversal
    if (isBull3 && body3 > range2 * 0.6 && body2 < body3 * 0.4 && isBear1 && c1.c < (c3.o + c3.c) / 2)
        return { pattern: 'Evening Star', isBull: false, isBear: true, display: '🌆 Evening Star 🔴🔴 — 3-candle bearish reversal (HIGH probability)' };

    // 6. Three White Soldiers — strong bull continuation
    if (isBull1 && isBull2 && isBull3 && c1.c > c2.c && c2.c > c3.c && body1 > range1 * 0.6 && body2 > range2 * 0.6)
        return { pattern: 'Three White Soldiers', isBull: true, isBear: false, display: '🪖🪖🪖 Three White Soldiers 🟢 — Strong bullish momentum' };

    // 7. Three Black Crows — strong bear continuation
    if (isBear1 && isBear2 && isBear3 && c1.c < c2.c && c2.c < c3.c && body1 > range1 * 0.6 && body2 > range2 * 0.6)
        return { pattern: 'Three Black Crows', isBull: false, isBear: true, display: '🐦‍⬛🐦‍⬛🐦‍⬛ Three Black Crows 🔴 — Strong bearish momentum' };

    // 8. Bullish Engulfing (moved from basic to here with body-size check)
    if (isBear2 && isBull1 && c1.c > c2.o && c1.o < c2.c && body1 > body2 * 1.1)
        return { pattern: 'Bullish Engulfing', isBull: true, isBear: false, display: '🟢 Bullish Engulfing — Reversal UP confirmed' };

    // 9. Bearish Engulfing
    if (isBull2 && isBear1 && c1.c < c2.o && c1.o > c2.c && body1 > body2 * 1.1)
        return { pattern: 'Bearish Engulfing', isBull: false, isBear: true, display: '🔴 Bearish Engulfing — Reversal DOWN confirmed' };

    // 10. Piercing Line (bullish 2-candle)
    if (isBear2 && isBull1 && c1.o < c2.l && c1.c > (c2.o + c2.c) / 2 && c1.c < c2.o)
        return { pattern: 'Piercing Line', isBull: true, isBear: false, display: '🟢 Piercing Line — Partial bullish reversal (watch for follow-through)' };

    // 11. Dark Cloud Cover (bearish 2-candle)
    if (isBull2 && isBear1 && c1.o > c2.h && c1.c < (c2.o + c2.c) / 2 && c1.c > c2.o)
        return { pattern: 'Dark Cloud Cover', isBull: false, isBear: true, display: '🔴 Dark Cloud Cover — Partial bearish reversal (watch for follow-through)' };

    // 12. Hammer (bottom reversal)
    if (lowerWick1 > body1 * 2.5 && upperWick1 < body1 * 0.5 && body1 > 0)
        return { pattern: 'Hammer', isBull: true, isBear: false, display: '🔨 Hammer 🟢 — Strong bottom reversal (buy on next confirmation)' };

    // 13. Shooting Star (top reversal)
    if (upperWick1 > body1 * 2.5 && lowerWick1 < body1 * 0.5 && body1 > 0)
        return { pattern: 'Shooting Star', isBull: false, isBear: true, display: '⭐ Shooting Star 🔴 — Strong top reversal (sell on next confirmation)' };

    // 14. Inverted Hammer (bottom, needs bullish follow-through)
    if (upperWick1 > body1 * 2 && lowerWick1 < body1 * 0.3 && isBear2)
        return { pattern: 'Inverted Hammer', isBull: true, isBear: false, display: '🔄 Inverted Hammer 🟡 — Potential bottom (wait for next green candle)' };

    // 15. Hanging Man (top reversal in uptrend — bearish despite bottom-reversal shape)
    if (lowerWick1 > body1 * 2.5 && upperWick1 < body1 * 0.5 && isBull2 && isBull3)
        return { pattern: 'Hanging Man', isBull: false, isBear: true, display: '🎭 Hanging Man 🔴 — Bearish reversal in uptrend (take caution)' };

    return { pattern: 'None', isBull: false, isBear: false, display: '⚪ No pattern' };
}

// ============================================================
// 🆕 v7 PRO VVIP — Enhanced Multi-Swing Fibonacci Levels
// Professional Fib retracements + extensions from multiple swings.
// Levels: 0, 23.6, 38.2, 50, 61.8, 78.6, 88.6, 100, 127.2, 161.8, 200, 261.8
// Extension beyond 100% = expansion targets (institutional price targets)
// ============================================================
function getFibonacciLevels(candles, direction) {
    if (candles.length < 20) return { levels: {}, display: '⚪ Fib N/A' };

    const n      = candles.length;
    const highs  = candles.map(c => parseFloat(c[2]));
    const lows   = candles.map(c => parseFloat(c[3]));
    const closes = candles.map(c => parseFloat(c[4]));
    const current = closes[n - 1];

    // Find most recent significant swing (last 50 bars, min 10 apart)
    let swingHigh = -Infinity, swingHighI = -1;
    let swingLow  =  Infinity, swingLowI  = -1;

    for (let i = Math.max(0, n - 50); i < n - 2; i++) {
        if (highs[i] > swingHigh)  { swingHigh = highs[i]; swingHighI = i; }
        if (lows[i]  < swingLow)   { swingLow  = lows[i];  swingLowI  = i; }
    }

    const range  = swingHigh - swingLow;
    if (range <= 0) return { levels: {}, display: '⚪ Fib: no valid swing' };

    const ratios = {
        '0%':    0,      '23.6%': 0.236,  '38.2%': 0.382,
        '50%':   0.5,    '61.8%': 0.618,  '78.6%': 0.786,
        '88.6%': 0.886,  '100%':  1.0,
        '127.2%':1.272,  '161.8%':1.618,  '200%':  2.0,    '261.8%':2.618,
    };

    const levels = {};
    let nearestLevel = null, minDist = Infinity;

    for (const [label, ratio] of Object.entries(ratios)) {
        // Retracement from high (for LONG setups — pullback BUY zones)
        const retLevel  = swingHigh - range * ratio;
        // Extension from low (for LONG setups — TP targets above swing high)
        const extLevel  = swingLow  + range * ratio;

        levels[label] = {
            retracement: retLevel.toFixed(4),
            extension:   extLevel.toFixed(4),
        };

        // Find nearest retracement to current price
        const dist = Math.abs(retLevel - current);
        if (dist < minDist) {
            minDist = dist;
            nearestLevel = { label, price: retLevel.toFixed(4), ratio };
        }
    }

    const distPct = (minDist / current * 100).toFixed(2);
    const key618  = levels['61.8%']?.retracement || 'N/A';
    const key786  = levels['78.6%']?.retracement || 'N/A';
    const key1618 = levels['161.8%']?.extension  || 'N/A';

    const isAtOTE = nearestLevel && (nearestLevel.label === '61.8%' || nearestLevel.label === '78.6%' || nearestLevel.label === '50%');

    const display =
        `📐 *Fibonacci Levels* (Swing: $${swingLow.toFixed(4)} → $${swingHigh.toFixed(4)})\n` +
        `   🟢 61.8% Ret: $${key618} | 78.6% Ret: $${key786}\n` +
        `   🎯 1.618 Ext: $${key1618}\n` +
        `   📍 Nearest: ${nearestLevel?.label || '?'} @ $${nearestLevel?.price || '?'} (${distPct}% away)` +
        (isAtOTE ? '\n   ✅ *AT OTE ZONE!* — Institutional entry zone' : '');

    return {
        levels, swingHigh: swingHigh.toFixed(4), swingLow: swingLow.toFixed(4),
        range: range.toFixed(4), nearestLevel, isAtOTE,
        key618: key618, key786: key786, key50: levels['50%']?.retracement,
        key382: levels['38.2%']?.retracement, key236: levels['23.6%']?.retracement,
        ext1272: levels['127.2%']?.extension, ext1618: key1618, ext2618: levels['261.8%']?.extension,
        display,
    };
}

// ============================================================
// 🆕 v7 PRO VVIP — MFI (Money Flow Index)
// Volume-weighted RSI — divergence between MFI and price
// reveals institutional accumulation/distribution.
// MFI < 20 = oversold; MFI > 80 = overbought.
// ============================================================
function calculateMFI(candles, period = 14) {
    if (candles.length < period + 2) return { value: 50, signal: 'Neutral', isBull: false, isBear: false, display: '⚪ MFI N/A' };

    const slice = candles.slice(-period - 1);
    let posFlow = 0, negFlow = 0;

    for (let i = 1; i < slice.length; i++) {
        const typNow  = (parseFloat(slice[i][2])   + parseFloat(slice[i][3])   + parseFloat(slice[i][4]))   / 3;
        const typPrev = (parseFloat(slice[i-1][2]) + parseFloat(slice[i-1][3]) + parseFloat(slice[i-1][4])) / 3;
        const vol     = parseFloat(slice[i][5]);
        const rawFlow = typNow * vol;
        if (typNow > typPrev) posFlow += rawFlow;
        else                  negFlow += rawFlow;
    }

    if (negFlow === 0) return { value: 100, signal: 'Overbought 🔴', isBull: false, isBear: true, display: '💰 MFI: 100 — Extreme overbought' };
    const mfi = 100 - (100 / (1 + posFlow / negFlow));

    let signal, isBull = false, isBear = false;
    if (mfi < 20)       { signal = 'Oversold 🟢 (Smart money buying)'; isBull = true; }
    else if (mfi < 30)  { signal = 'Near Oversold 🟡'; isBull = true; }
    else if (mfi > 80)  { signal = 'Overbought 🔴 (Smart money selling)'; isBear = true; }
    else if (mfi > 70)  { signal = 'Near Overbought 🟡'; isBear = true; }
    else                  signal = 'Neutral ⚪';

    const display = `💰 MFI(${period}): ${mfi.toFixed(1)} — ${signal}`;
    return { value: parseFloat(mfi.toFixed(2)), signal, isBull, isBear, display };
}

// ============================================================
// 🆕 v7 PRO VVIP — ROC (Rate of Change) Momentum
// Measures the speed of price change over N periods.
// ROC > 0 = bullish momentum; ROC < 0 = bearish momentum.
// ROC crossing 0 from below = momentum turning bull.
// ============================================================
function calculateROC(candles, period = 10) {
    if (candles.length < period + 2) return { value: 0, signal: 'Neutral', isBull: false, isBear: false, display: '⚪ ROC N/A' };

    const closes  = candles.map(c => parseFloat(c[4]));
    const n       = closes.length;
    const current = closes[n - 1];
    const past    = closes[n - 1 - period];
    if (past === 0) return { value: 0, signal: 'Neutral', isBull: false, isBear: false, display: '⚪ ROC: div/0' };

    const roc     = ((current - past) / past) * 100;
    const prevRoc = closes.length > period + 2
        ? ((closes[n - 2] - closes[n - 2 - period]) / closes[n - 2 - period]) * 100
        : roc;

    const zeroCrossBull = roc > 0 && prevRoc <= 0;
    const zeroCrossBear = roc < 0 && prevRoc >= 0;

    let signal, isBull = false, isBear = false;
    if (zeroCrossBull)      { signal = 'Bullish Cross ⬆️ (Momentum turning positive)'; isBull = true; }
    else if (zeroCrossBear) { signal = 'Bearish Cross ⬇️ (Momentum turning negative)'; isBear = true; }
    else if (roc > 5)       { signal = 'Strong Bull 🟢'; isBull = true; }
    else if (roc > 0)       { signal = 'Mild Bull 🟡'; isBull = true; }
    else if (roc < -5)      { signal = 'Strong Bear 🔴'; isBear = true; }
    else                    { signal = 'Mild Bear 🟡'; isBear = true; }

    const display = `⚡ ROC(${period}): ${roc.toFixed(2)}% — ${signal}`;
    return { value: parseFloat(roc.toFixed(2)), signal, isBull, isBear, display };
}

// ============================================================
// 🆕 v7 PRO VVIP — CCI (Commodity Channel Index)
// Measures deviation from statistical mean.
// CCI > +100 = overbought/strong bull trend starting.
// CCI < -100 = oversold/strong bear trend starting.
// Zero-line cross = momentum shift.
// ============================================================
function calculateCCI(candles, period = 20) {
    if (candles.length < period) return { value: 0, signal: 'Neutral', isBull: false, isBear: false, display: '⚪ CCI N/A' };

    const slice   = candles.slice(-period);
    const typical = slice.map(c => (parseFloat(c[2]) + parseFloat(c[3]) + parseFloat(c[4])) / 3);
    const mean    = typical.reduce((s, v) => s + v, 0) / period;
    const meanDev = typical.reduce((s, v) => s + Math.abs(v - mean), 0) / period;
    if (meanDev === 0) return { value: 0, signal: 'Neutral', isBull: false, isBear: false, display: '⚪ CCI: flat' };

    const cci = (typical[typical.length - 1] - mean) / (0.015 * meanDev);

    let signal, isBull = false, isBear = false;
    if (cci > 200)       { signal = 'Extreme Overbought 🔴🔴'; isBear = true; }
    else if (cci > 100)  { signal = 'Overbought 🔴 (Trend in motion — potential reversal zone)'; isBear = true; }
    else if (cci > 0)    { signal = 'Mild Bull 🟡'; isBull = true; }
    else if (cci > -100) { signal = 'Mild Bear 🟡'; isBear = true; }
    else if (cci > -200) { signal = 'Oversold 🟢 (Trend in motion — potential reversal zone)'; isBull = true; }
    else                 { signal = 'Extreme Oversold 🟢🟢 — High-probability bounce!'; isBull = true; }

    const display = `📊 CCI(${period}): ${cci.toFixed(1)} — ${signal}`;
    return { value: parseFloat(cci.toFixed(2)), signal, isBull, isBear, display };
}

// ============================================================
// 🆕 v7 PRO VVIP — Momentum Shift Detector
// Combines ROC + MFI + StochRSI + CCI into one unified
// "momentum shift" reading. The best entries happen when
// ALL momentum indicators align and JUST flip direction.
// ============================================================
function detectMomentumShift(candles) {
    if (candles.length < 30) return { direction: 'NEUTRAL', strength: 0, display: '⚪ Momentum N/A' };

    const roc   = calculateROC(candles, 10);
    const mfi   = calculateMFI(candles, 14);
    const srsi  = calculateStochRSI(candles, 14, 14, 3, 3);
    const cci   = calculateCCI(candles, 20);
    const rsi   = calculateRSI(candles.slice(-50), 14);

    const closes  = candles.map(c => parseFloat(c[4]));
    const n       = closes.length;
    const priceUp = closes[n - 1] > closes[n - 4];

    // Bull signals
    const bullSignals = [
        roc.isBull,
        mfi.isBull,
        srsi.isBull,
        cci.isBull,
        rsi < 45,
        priceUp,
    ].filter(Boolean).length;

    // Bear signals
    const bearSignals = [
        roc.isBear,
        mfi.isBear,
        srsi.isBear,
        cci.isBear,
        rsi > 55,
        !priceUp,
    ].filter(Boolean).length;

    const isBull   = bullSignals >= 4;
    const isBear   = bearSignals >= 4;
    const strength = isBull ? bullSignals : isBear ? bearSignals : Math.max(bullSignals, bearSignals);
    const direction = isBull ? 'BULL' : isBear ? 'BEAR' : 'NEUTRAL';

    let display;
    if (isBull)
        display = `⚡ *Momentum BULL* (${bullSignals}/6 signals): ROC${roc.isBull?'✅':'❌'} MFI${mfi.isBull?'✅':'❌'} StochRSI${srsi.isBull?'✅':'❌'} CCI${cci.isBull?'✅':'❌'}`;
    else if (isBear)
        display = `⚡ *Momentum BEAR* (${bearSignals}/6 signals): ROC${roc.isBear?'✅':'❌'} MFI${mfi.isBear?'✅':'❌'} StochRSI${srsi.isBear?'✅':'❌'} CCI${cci.isBear?'✅':'❌'}`;
    else
        display = `⚡ Momentum Mixed (Bull:${bullSignals}/6 Bear:${bearSignals}/6) — Wait for alignment`;

    return { direction, strength, isBull, isBear, bullSignals, bearSignals, roc, mfi, srsi, cci, display };
}

