// ============================================================
// ✅ UPGRADED smartmoney.js - 4 Decimal Precision Update
// Added: Harmonic Pattern Entry Support (VIP Priority)
// ============================================================

function checkLiquiditySweep(candles) {
    if (candles.length < 10) return "None";
    const last = candles[candles.length - 1];
    const lOpen = parseFloat(last[1]), lHigh = parseFloat(last[2]), lLow = parseFloat(last[3]), lClose = parseFloat(last[4]);
    // ✅ FIX: Use 50 candles for meaningful liquidity pools (not 10)
    const lookback = candles.slice(-50, -1);
    const prevLow  = Math.min(...lookback.map(c => parseFloat(c[3])));
    const prevHigh = Math.max(...lookback.map(c => parseFloat(c[2])));
    // Must be a real sweep: wick breaks level but BODY closes back above/below
    const bodyLow  = Math.min(lOpen, lClose);
    const bodyHigh = Math.max(lOpen, lClose);
    if (lLow < prevLow * 0.9998 && bodyLow > prevLow) return "Bullish Sweep 🟢 (Sell-side Liquidity Taken)";
    if (lHigh > prevHigh * 1.0002 && bodyHigh < prevHigh) return "Bearish Sweep 🔴 (Buy-side Liquidity Taken)";
    return "None";
}

function checkChoCH(candles) {
    // ✅ FIXED: Proper market structure ChoCH
    // Bullish ChoCH: was making LLs and LHs (downtrend) → now breaks ABOVE a recent LH
    // Bearish ChoCH: was making HHs and HLs (uptrend) → now breaks BELOW a recent HL
    if (candles.length < 30) return "None";  // ✅ need enough for swing structure

    const n = candles.length;
    const highs  = candles.map(c => parseFloat(c[2]));
    const lows   = candles.map(c => parseFloat(c[3]));
    const closes = candles.map(c => parseFloat(c[4]));
    const currentClose = closes[n - 1];

    // Detect swing structure over last 20 candles
    // ✅ FIX: Require 3-bar swing confirmation (not just 1 bar each side)
    const swingHighs = [], swingLows = [];
    const start = Math.max(2, n - 50); // look back up to 50 candles for structure
    for (let i = start; i < n - 2; i++) {
        // Swing high: higher than 2 bars on each side (stronger confirmation)
        if (highs[i] > highs[i-1] && highs[i] > highs[i+1] &&
            (i < 2 || highs[i] >= highs[i-2]) && highs[i] >= highs[i+2])
            swingHighs.push({ idx: i, val: highs[i] });
        if (lows[i] < lows[i-1] && lows[i] < lows[i+1] &&
            (i < 2 || lows[i] <= lows[i-2]) && lows[i] <= lows[i+2])
            swingLows.push({ idx: i, val: lows[i] });
    }
    if (swingHighs.length < 2 || swingLows.length < 2) return "None";

    const lastSH = swingHighs[swingHighs.length - 1];
    const prevSH = swingHighs[swingHighs.length - 2];
    const lastSL = swingLows[swingLows.length - 1];
    const prevSL = swingLows[swingLows.length - 2];

    // Bearish structure: HH→LH pattern then price breaks below last HL
    const wasUptrend  = lastSH.val > prevSH.val && lastSL.val > prevSL.val; // HH + HL
    // Bullish structure: LL→HL pattern then price breaks above last LH
    const wasDowntrend = lastSH.val < prevSH.val && lastSL.val < prevSL.val; // LH + LL

    // Bullish ChoCH: downtrend AND current close breaks above last LH
    if (wasDowntrend && currentClose > lastSH.val) {
        return "Bullish ChoCH 🟢 (Structure Reversal Up)";
    }
    // Bearish ChoCH: uptrend AND current close breaks below last HL
    if (wasUptrend && currentClose < lastSL.val) {
        return "Bearish ChoCH 🔴 (Structure Reversal Down)";
    }
    // BOS (Break of Structure) - continuation, less significant than ChoCH
    if (!wasDowntrend && !wasUptrend) return "None";

    return "None";
}

function getKillZone() {
    const utcHour = new Date().getUTCHours();
    if (utcHour >= 7 && utcHour < 10) return "London Open 🇬🇧 (High Volatility)";
    if (utcHour >= 13 && utcHour < 16) return "New York Open 🇺🇸 (Max Volatility)";
    if (utcHour >= 0 && utcHour < 6) return "Asian Session 🇯🇵 (Consolidation/Fakeouts)";
    return "Off-Peak Hours 🕰️ (Medium Volatility)";
}

function detectOrderBlocks(candles) {
    // ✅ FIXED: OB detection with impulse size filter
    // A valid OB must be followed by a STRONG (impulsive) move, not just any 2 candles
    // Also avoids tiny doji candles being flagged as OBs
    let bullishOB = null, bearishOB = null;

    const avgBody = candles.slice(-15).reduce((sum, c) => {
        return sum + Math.abs(parseFloat(c[4]) - parseFloat(c[1]));
    }, 0) / 15;

    // ✅ FIX: Check last 50 candles for OBs (institutions leave OBs 20-50 bars old)
    for (let i = Math.max(0, candles.length - 50); i < candles.length - 2; i++) {
        if (i < 0) continue;
        const o = parseFloat(candles[i][1]), h = parseFloat(candles[i][2]);
        const l = parseFloat(candles[i][3]), c = parseFloat(candles[i][4]);
        const body = Math.abs(c - o);
        const isRed   = c < o;
        const isGreen = c > o;

        // Filter: OB candle must have a meaningful body (not a doji)
        if (body < avgBody * 0.3) continue;

        // ✅ Bullish OB: last red candle before impulsive up move
        // Confirmation: next 2 candles close progressively higher
        if (isRed && i + 2 < candles.length) {
            const c1 = parseFloat(candles[i+1][4]), c2 = parseFloat(candles[i+2][4]);
            const impulse = c2 - c; // total move after OB
            // Impulse must be at least 1.5x the OB candle body
            if (c1 > o && c2 > candles[i+1][2] && impulse > body * 1.5) {
                const bottom = l, top = o, mid = (bottom + top) / 2;
                bullishOB = {
                    bottom: bottom.toFixed(4), top: top.toFixed(4), mid: mid.toFixed(4),
                    display: `$${bottom.toFixed(4)} - $${top.toFixed(4)}`,
                    sl: (bottom * 0.997).toFixed(4) // 0.3% below OB low
                };
            }
        }
        // ✅ Bearish OB: last green candle before impulsive down move
        if (isGreen && i + 2 < candles.length) {
            const c1 = parseFloat(candles[i+1][4]), c2 = parseFloat(candles[i+2][4]);
            const impulse = c - c2;
            if (c1 < o && c2 < candles[i+1][3] && impulse > body * 1.5) {
                const bottom = o, top = h, mid = (bottom + top) / 2;
                bearishOB = {
                    bottom: bottom.toFixed(4), top: top.toFixed(4), mid: mid.toFixed(4),
                    display: `$${bottom.toFixed(4)} - $${top.toFixed(4)}`,
                    sl: (top * 1.003).toFixed(4)
                };
            }
        }
    }
    return { bullishOB, bearishOB };
}

function checkOBConfirmation(candles, ob, direction) {
    if (!ob) return { confirmed: false, status: "No OB Zone" };
    const last = candles[candles.length - 1], prev = candles[candles.length - 2];
    const lastClose = parseFloat(last[4]), lastLow = parseFloat(last[3]), lastHigh = parseFloat(last[2]), lastOpen = parseFloat(last[1]);
    const prevClose = parseFloat(prev[4]), prevOpen = parseFloat(prev[1]);
    const obBottom = parseFloat(ob.bottom), obTop = parseFloat(ob.top);

    if (direction === 'LONG') {
        const inZone = lastLow <= obTop && lastLow >= obBottom * 0.998;
        if (!inZone) return { confirmed: false, status: `⏳ PENDING - Limit Order set කරන්න.`, orderType: "LIMIT" };
        if (lastClose > lastOpen && lastClose > prevClose) return { confirmed: true, status: `✅ CONFIRMED - OB touch + Bullish close`, orderType: "MARKET" };
        return { confirmed: false, status: `⚠️ ZONE TOUCHED - Wait for confirmation`, orderType: "WAIT_CONFIRM" };
    } else {
        const inZone = lastHigh >= obBottom && lastHigh <= obTop * 1.002;
        if (!inZone) return { confirmed: false, status: `⏳ PENDING - Limit Order set කරන්න.`, orderType: "LIMIT" };
        if (lastClose < lastOpen && lastClose < prevClose) return { confirmed: true, status: `✅ CONFIRMED - OB touch + Bearish close`, orderType: "MARKET" };
        return { confirmed: false, status: `⚠️ ZONE TOUCHED - Wait for confirmation`, orderType: "WAIT_CONFIRM" };
    }
}

// ✅ FIX: Added 'harmonic' parameter to Best Entry Selection
function selectBestEntry(currentPrice, ob, fib618, poc, vwapPrice, direction, atr, harmonic = "None") {
    const price = parseFloat(currentPrice), atrVal = parseFloat(atr) || 0;
    let candidates = [];
    
    if (direction === 'LONG') {
        // 🔥 VIP Priority 0: Harmonic Pattern PRZ (Potential Reversal Zone)
        if (harmonic !== "None" && harmonic.includes("Bullish")) {
            candidates.push({ name: `${harmonic} PRZ Zone 🔥`, price: price, zoneBottom: price - atrVal * 0.5, zoneTop: price + atrVal * 0.2, sl: price - atrVal * 1.5, priority: 0 });
        }
        
        if (ob) candidates.push({ name: "Bullish OB", price: parseFloat(ob.bottom) * 1.001, zoneBottom: parseFloat(ob.bottom), zoneTop: parseFloat(ob.top), sl: parseFloat(ob.sl), priority: 1 }); // ✅ FIX: entry near bottom for better RR, not mid
        const fib618Num = parseFloat(fib618); if (fib618 && fib618Num < price && fib618Num > price * 0.95) candidates.push({ name: "Fib 61.8%", price: fib618Num, zoneBottom: fib618Num - atrVal * 0.3, zoneTop: fib618Num + atrVal * 0.3, sl: fib618Num - atrVal * 1.5, priority: 2 }); // ✅ FIX: only use if within 5% of price
        if (poc && parseFloat(poc) < price * 1.01) candidates.push({ name: "POC", price: parseFloat(poc), zoneBottom: parseFloat(poc) - atrVal * 0.3, zoneTop: parseFloat(poc) + atrVal * 0.3, sl: (parseFloat(poc) - atrVal * 1.5), priority: 3 });
        
        if (candidates.length === 0) return { name: "Current Price", price: price, zoneBottom: price - atrVal * 0.5, zoneTop: price, sl: price - atrVal * 1.5, priority: 5, warning: "⚠️ Strong zone නොමැත." };
        
        const best = candidates.sort((a, b) => a.priority - b.priority)[0];
        return best;
    } else {
        // 🔥 VIP Priority 0: Harmonic Pattern PRZ
        if (harmonic !== "None" && harmonic.includes("Bearish")) {
            candidates.push({ name: `${harmonic} PRZ Zone 🔥`, price: price, zoneBottom: price - atrVal * 0.2, zoneTop: price + atrVal * 0.5, sl: price + atrVal * 1.5, priority: 0 });
        }
        
        if (ob) candidates.push({ name: "Bearish OB", price: parseFloat(ob.top) * 0.999, zoneBottom: parseFloat(ob.bottom), zoneTop: parseFloat(ob.top), sl: parseFloat(ob.sl), priority: 1 }); // ✅ FIX: entry near top for better RR, not mid
        const fib618NumS = parseFloat(fib618); if (fib618 && fib618NumS > price && fib618NumS < price * 1.05) candidates.push({ name: "Fib 61.8%", price: fib618NumS, zoneBottom: fib618NumS - atrVal * 0.3, zoneTop: fib618NumS + atrVal * 0.3, sl: fib618NumS + atrVal * 1.5, priority: 2 }); // ✅ FIX: only use if within 5% of price
        if (poc && parseFloat(poc) > price * 0.99) candidates.push({ name: "POC", price: parseFloat(poc), zoneBottom: parseFloat(poc) - atrVal * 0.3, zoneTop: parseFloat(poc) + atrVal * 0.3, sl: (parseFloat(poc) + atrVal * 1.5), priority: 3 });
        
        if (candidates.length === 0) return { name: "Current Price", price: price, zoneBottom: price, zoneTop: price + atrVal * 0.5, sl: price + atrVal * 1.5, priority: 5, warning: "⚠️ Strong zone නොමැත." };
        
        const best = candidates.sort((a, b) => a.priority - b.priority)[0];
        return best;
    }
}

function getOrderTypeSuggestion(entryPrice, currentPrice, direction) {
    const entry = parseFloat(entryPrice), current = parseFloat(currentPrice);
    const diffPct = Math.abs(entry - current) / current * 100;
    if (direction === 'LONG') {
        if (entry >= current * 0.999) return { type: "MARKET ORDER 🟢", reason: "Market Order use කළ හැකිය." };
        else if (diffPct <= 2) return { type: "LIMIT ORDER ⏳", reason: `Limit Order set කරන්න.` };
        else return { type: "LIMIT ORDER ⏳", reason: `OB zone retest වෙනකල් wait කරන්න.` };
    } else {
        if (entry <= current * 1.001) return { type: "MARKET ORDER 🔴", reason: "Market Order use කළ හැකිය." };
        else if (diffPct <= 2) return { type: "LIMIT ORDER ⏳", reason: `Limit Order set කරන්න.` };
        else return { type: "LIMIT ORDER ⏳", reason: `OB zone retest වෙනකල් wait කරන්න.` };
    }
}

function analyzeSMC(candles) {
    let highs = candles.map(c => parseFloat(c[2])), lows = candles.map(c => parseFloat(c[3]));
    let resistance = Math.max(...highs), support = Math.min(...lows), diff = resistance - support;
    let bullishFVG = "None", bearishFVG = "None";
    for (let i = candles.length - 20; i < candles.length - 1; i++) {
        if (i < 2) continue;
        let c1High = parseFloat(candles[i-2][2]), c3Low = parseFloat(candles[i][3]);
        let c1Low = parseFloat(candles[i-2][3]), c3High = parseFloat(candles[i][2]);
        if (c1High < c3Low) bullishFVG = `$${c1High.toFixed(4)} - $${c3Low.toFixed(4)}`;
        if (c1Low > c3High) bearishFVG = `$${c3High.toFixed(4)} - $${c1Low.toFixed(4)}`;
    }
    const { bullishOB, bearishOB } = detectOrderBlocks(candles);
    return {
        support: support.toFixed(4), resistance: resistance.toFixed(4),
        bullishFVG, bearishFVG, bullishOB, bearishOB,
        bullishOBDisplay: bullishOB ? bullishOB.display : "None",
        bearishOBDisplay: bearishOB ? bearishOB.display : "None",
        fib618: (resistance - (diff * 0.618)).toFixed(4),
        fib786: (resistance - (diff * 0.786)).toFixed(4),
        ext1618: (resistance + (diff * 0.618)).toFixed(4),
        ext2618: (resistance + (diff * 1.618)).toFixed(4),
        extMinus1618: (support - (diff * 0.618)).toFixed(4),
        swingHigh: Math.max(...candles.slice(-15).map(c => parseFloat(c[2]))).toFixed(4),
        swingLow: Math.min(...candles.slice(-15).map(c => parseFloat(c[3]))).toFixed(4),
        sweep: checkLiquiditySweep(candles), choch: checkChoCH(candles), killzone: getKillZone()
    };
}

module.exports = { analyzeSMC, detectOrderBlocks, checkOBConfirmation, selectBestEntry, getOrderTypeSuggestion, checkLiquiditySweep, checkChoCH };
// Note: detectBOS() is in lib/indicators.js (v7 upgrade)

