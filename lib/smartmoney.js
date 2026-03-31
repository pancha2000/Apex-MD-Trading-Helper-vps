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

// ══════════════════════════════════════════════════════════════════
//  🎯 DEEP ENTRY DECISION ENGINE
//  Collects ALL indicator levels across every TF, scores each by
//  multi-factor confluence, clusters nearby zones, and outputs:
//    MARKET  → enter at current price NOW (zone = here)
//    LIMIT_NEAR → set limit order, price expected soon (<2% + high conf)
//    LIMIT_FAR  → set limit, may take time (2-5%, medium conf)
//    SKIP    → zone too far or weak — re-scan when price approaches
//
//  Replaces the simplistic getOrderTypeSuggestion() distance-only logic.
// ══════════════════════════════════════════════════════════════════
function getDeepEntryDecision({
    currentPrice, direction, atrVal, timeframe = '15m',
    // SMC levels
    obForDir, fib618, fib786, poc, vwapPrice,
    // Multi-TF OBs
    ob4H, ob1H, ob15m, mtfOB,
    // Fib systems
    mtfFibEntry, fibLevels,
    // Support / Resistance
    dynamicSR, pivots, volNodes, equalHL,
    // Oscillator-based levels
    ichimoku, bbands, supertrend, breakers,
    // FVG
    fvgData,
    // Confirmation
    confirmation, entryQuality,
}) {
    const cp  = parseFloat(currentPrice);
    const atr = parseFloat(atrVal) || cp * 0.002;
    const isL = direction === 'LONG';

    // ── GRADE INVALIDATED GATE (RRR too poor — 70%+ to TP1) ─────────────────
    // Only skip when entryQuality explicitly blocks (real bypass, near TP1).
    // Normal continuation trades (price between zone and TP, < 70%) still proceed.
    if (entryQuality?.blockEntry === true && entryQuality?.grade === 'INVALIDATED') {
        return {
            decision: 'SKIP',
            action: '⏳ *WAIT — Near TP1 Zone*',
            optimalEntry: cp,
            entryLabel: 'Near TP1 — Poor RRR',
            confluence: 0, confluenceSources: [], distPct: 0, eta: null, topZones: [],
            skipReason: 'Price is 70%+ of the way to TP1. RRR too poor for new entry. Wait for pullback to Fib OTE zone.',
            entryConfScore: 0,
        };
    }

    // ── 1. Collect ALL candidate entry levels ──────────────────
    // raw[]: { price, label, weight }
    // weight reflects authority of the source (OB=5, Fib=3, etc.)
    const raw = [];

    const add = (price, label, weight = 1) => {
        const p = parseFloat(price);
        if (!p || !isFinite(p) || isNaN(p) || p <= 0) return;
        // LONG: entry zone must be AT or BELOW current price (within 12%)
        // SHORT: entry zone must be AT or ABOVE current price (within 12%)
        if (isL  && p > cp * 1.008) return;
        if (!isL && p < cp * 0.992) return;
        const dist = Math.abs(p - cp) / cp * 100;
        if (dist > 12) return;
        raw.push({ price: p, label, weight, dist });
    };

    // ── Order Blocks (highest institutional authority) ──────────
    // 4H OB — strongest HTF zone
    if (ob4H?.bullish && isL)  add(parseFloat(ob4H.bullish.bottom) * 1.001, '4H Bullish OB 🏦', 6);
    if (ob4H?.bearish && !isL) add(parseFloat(ob4H.bearish.top)   * 0.999, '4H Bearish OB 🏦', 6);
    // 1H OB
    if (ob1H?.bullish && isL)  add(parseFloat(ob1H.bullish.bottom) * 1.001, '1H Bullish OB', 5);
    if (ob1H?.bearish && !isL) add(parseFloat(ob1H.bearish.top)   * 0.999, '1H Bearish OB', 5);
    // 15m OB (primary TF from analyzeSMC)
    if (obForDir) {
        if (isL)  add(parseFloat(obForDir.bottom) * 1.001, '15m Bullish OB', 4);
        else      add(parseFloat(obForDir.top)   * 0.999, '15m Bearish OB', 4);
    }
    // MTF OB Confluence Zone (highest priority — multi-TF agreement)
    if (mtfOB?.confluenceZone) {
        const cz = mtfOB.confluenceZone;
        if (isL  && cz.type === 'BULLISH') add(parseFloat(cz.bottom) * 1.001, 'MTF OB Zone 🔥🔥', 7);
        if (!isL && cz.type === 'BEARISH') add(parseFloat(cz.top)   * 0.999, 'MTF OB Zone 🔥🔥', 7);
    }

    // ── Fibonacci Retracement / OTE Zones ──────────────────────
    if (fib618) add(parseFloat(fib618), 'SMC Fib 61.8%', 3);
    if (fib786) add(parseFloat(fib786), 'SMC Fib 78.6%', 3);
    if (mtfFibEntry?.zones) {
        for (const z of mtfFibEntry.zones) {
            add(z.price, z.label, z.strength === 'STRONG' ? 5 : 3);
        }
    }
    if (fibLevels?.key618) add(parseFloat(fibLevels.key618), 'Fib 61.8% OTE',  4);
    if (fibLevels?.key786) add(parseFloat(fibLevels.key786), 'Fib 78.6% OTE',  4);
    if (fibLevels?.key50)  add(parseFloat(fibLevels.key50),  'Fib 50% Eq',     2);
    if (fibLevels?.key382) add(parseFloat(fibLevels.key382), 'Fib 38.2%',      2);

    // ── Volume-Based Levels ─────────────────────────────────────
    if (poc) add(parseFloat(poc), 'POC (Volume Node)', 3);
    if (vwapPrice && vwapPrice > 0) add(vwapPrice, 'VWAP', 3);
    if (volNodes?.hvnPrice) add(parseFloat(volNodes.hvnPrice), 'HVN Magnet 🔥', 4);
    if (volNodes?.lvnZones) {
        for (const z of (volNodes.lvnZones || [])) {
            const p = parseFloat(z);
            if (isL && p < cp) add(p, 'LVN (Thin Air)', 1);
            if (!isL && p > cp) add(p, 'LVN (Thin Air)', 1);
        }
    }

    // ── Structure & Dynamic S/R ─────────────────────────────────
    if (isL  && dynamicSR?.support)    add(parseFloat(dynamicSR.support),    'Dynamic Support',    3);
    if (!isL && dynamicSR?.resistance) add(parseFloat(dynamicSR.resistance), 'Dynamic Resistance', 3);
    if (isL  && dynamicSR?.dynS1)      add(parseFloat(dynamicSR.dynS1),      'Keltner S1',         2);
    if (!isL && dynamicSR?.dynR1)      add(parseFloat(dynamicSR.dynR1),      'Keltner R1',         2);

    // ── Ichimoku Cloud Levels ───────────────────────────────────
    if (ichimoku?.kijun)  add(parseFloat(ichimoku.kijun),  'Kijun Sen', 3);
    if (ichimoku?.tenkan) add(parseFloat(ichimoku.tenkan), 'Tenkan Sen', 2);
    if (isL  && ichimoku?.cloudTop)  add(parseFloat(ichimoku.cloudTop),  'Kumo Top',    2);
    if (!isL && ichimoku?.cloudBot)  add(parseFloat(ichimoku.cloudBot),  'Kumo Bottom', 2);

    // ── Pivot Points ────────────────────────────────────────────
    if (pivots) {
        if (isL) {
            if (pivots.S1) add(parseFloat(pivots.S1), 'Pivot S1 📌', 3);
            if (pivots.S2) add(parseFloat(pivots.S2), 'Pivot S2 📌', 3);
            if (pivots.PP) add(parseFloat(pivots.PP), 'Pivot Point',  2);
        } else {
            if (pivots.R1) add(parseFloat(pivots.R1), 'Pivot R1 📌', 3);
            if (pivots.R2) add(parseFloat(pivots.R2), 'Pivot R2 📌', 3);
            if (pivots.PP) add(parseFloat(pivots.PP), 'Pivot Point',  2);
        }
    }

    // ── Bollinger Bands ─────────────────────────────────────────
    if (isL  && bbands?.lower) add(parseFloat(bbands.lower), 'BB Lower Band', 2);
    if (!isL && bbands?.upper) add(parseFloat(bbands.upper), 'BB Upper Band', 2);
    if (bbands?.mid)           add(parseFloat(bbands.mid),   'BB Mid',        1);

    // ── Supertrend ──────────────────────────────────────────────
    if (supertrend?.supertrendLevel) {
        const st = parseFloat(supertrend.supertrendLevel);
        if (isL  && supertrend.isBull) add(st, 'Supertrend Support', 3);
        if (!isL && supertrend.isBear) add(st, 'Supertrend Resist',  3);
    }

    // ── Fair Value Gaps ─────────────────────────────────────────
    if (fvgData) {
        const fvgs = isL ? (fvgData.bullFVGs || []) : (fvgData.bearFVGs || []);
        for (const g of fvgs.filter(g => !g.filled)) {
            add(parseFloat(g.mid), 'FVG Midpoint ⚡', 3);
            add(parseFloat(g.low || g.mid), 'FVG Bottom', 2);
        }
    }

    // ── Breaker Blocks ──────────────────────────────────────────
    if (isL  && breakers?.bullishBreaker) add(parseFloat(breakers.bullishBreaker.top),    'Bull Breaker 🔲', 4);
    if (!isL && breakers?.bearishBreaker) add(parseFloat(breakers.bearishBreaker.bottom), 'Bear Breaker 🔲', 4);

    // ── Equal Highs/Lows (Liquidity Pools) ─────────────────────
    if (isL  && equalHL?.eql) add(parseFloat(equalHL.eql.level), 'EQL Pool 💧', 3);
    if (!isL && equalHL?.eqh) add(parseFloat(equalHL.eqh.level), 'EQH Pool 💧', 3);

    // ── Market Price anchor ─────────────────────────────────────
    add(cp, 'Market Price', 1);

    if (raw.length === 0) {
        return {
            decision: 'SKIP', action: '🚫 No valid entry zones found',
            optimalEntry: cp, entryLabel: 'No Zone', confluence: 0,
            confluenceSources: [], distPct: 0, eta: null, topZones: [],
            skipReason: 'No indicator confluence zones within range', entryConfScore: 0,
        };
    }

    // ── 2. Score each candidate by multi-level confluence ───────
    // Confluence = sum of weights of all other levels within 0.6% radius
    const CONF_RADIUS = 0.004; // 0.4% — tighter confluence radius = more precise zone matching

    const scored = raw.map(candidate => {
        let confScore   = candidate.weight;
        const confSrcs  = [candidate.label];
        for (const other of raw) {
            if (other === candidate) continue;
            const prox = Math.abs(other.price - candidate.price) / candidate.price;
            if (prox <= CONF_RADIUS) {
                confScore += other.weight;
                confSrcs.push(other.label);
            }
        }
        return { ...candidate, confScore, confSrcs: [...new Set(confSrcs)] };
    });

    // ── 3. Cluster nearby candidates (merge within 0.4%) ────────
    scored.sort((a, b) => b.confScore - a.confScore);
    const clusters = [];
    const used     = new Set();

    for (const s of scored) {
        const key = `${s.label}_${s.price.toFixed(6)}`;
        if (used.has(key)) continue;

        const members = scored.filter(o => {
            const k2 = `${o.label}_${o.price.toFixed(6)}`;
            return !used.has(k2) && Math.abs(o.price - s.price) / s.price <= 0.004;
        });

        const totalW  = members.reduce((sum, m) => sum + m.weight, 0);
        const avgP    = members.reduce((sum, m) => sum + m.price * m.weight, 0) / totalW;
        const allSrcs = [...new Set(members.flatMap(m => m.confSrcs))];
        const maxConf = Math.max(...members.map(m => m.confScore));

        clusters.push({
            price:      avgP,
            label:      allSrcs.slice(0, 3).join(' + '),
            confluence: maxConf,
            sources:    allSrcs,
            dist:       Math.abs(avgP - cp) / cp * 100,
        });
        members.forEach(m => used.add(`${m.label}_${m.price.toFixed(6)}`));
    }

    // ── 4. Rank: high confluence + close proximity wins ─────────
    // rank score = (confluence × 8) - (distance × 2.5)
    // dist weight raised 1.5→2.5: strongly prefer nearby zones over distant ones
    clusters.sort((a, b) =>
        (b.confluence * 8 - b.dist * 2.5) - (a.confluence * 8 - a.dist * 2.5)
    );

    const topZones = clusters.slice(0, 3);
    const best     = topZones[0];

    if (!best) {
        return {
            decision: 'SKIP', action: '🚫 No confluent entry zone found',
            optimalEntry: cp, entryLabel: 'No Zone', confluence: 0,
            confluenceSources: [], distPct: 0, eta: null, topZones: [],
            skipReason: 'Analysis found no high-confluence zones in range', entryConfScore: 0,
        };
    }

    // ── 5. ATR-based time estimate ───────────────────────────────
    const atrPct         = atr / cp * 100 || 0.3;
    const candlesToZone  = atrPct > 0 ? Math.round(best.dist / atrPct) : 99;
    const tfMins         = { '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
    const minsPerCandle  = tfMins[timeframe] || 15;
    const totalMins      = candlesToZone * minsPerCandle;
    const etaStr         = totalMins < 60
        ? `~${candlesToZone} candles (~${totalMins}min)`
        : totalMins < 1440
            ? `~${candlesToZone} candles (~${(totalMins/60).toFixed(1)}h)`
            : `~${candlesToZone} candles (~${(totalMins/1440).toFixed(1)} days)`;

    // ── 6. Normalized confluence strength (0–10) ────────────────
    const confNorm = Math.min(10, Math.round(best.confluence / 3));

    // ── 7. Entry confidence score (composite 0–10) ──────────────
    let entryConfScore = confNorm;
    if (confirmation?.confirmed)                    entryConfScore = Math.min(10, entryConfScore + 2);
    if (entryQuality?.grade?.startsWith('A'))        entryConfScore = Math.min(10, entryConfScore + 2);
    if (entryQuality?.grade === 'A+ SNIPER')         entryConfScore = Math.min(10, entryConfScore + 1);
    if (best.dist < 0.5)                             entryConfScore = Math.min(10, entryConfScore + 1);
    if (best.sources.some(s => s.includes('4H')))    entryConfScore = Math.min(10, entryConfScore + 1);
    if (best.sources.some(s => s.includes('MTF')))   entryConfScore = Math.min(10, entryConfScore + 1);

    // ── 8. Entry Decision ────────────────────────────────────────
    let decision, action, skipReason = null;

    if (best.dist < 0.3) {
        // Price is essentially AT the zone now
        decision = 'MARKET';
        action   = `✅ *ENTER MARKET NOW* — Price at zone (${best.dist.toFixed(2)}% away)`;
    } else if (best.dist <= 0.8 && confNorm >= 2) {
        // Very close + decent confluence — enter near market
        decision = 'MARKET';
        action   = `✅ *ENTER MARKET* — Near zone ${best.dist.toFixed(2)}% (${best.label})`;
    } else if (best.dist <= 2.5 && confNorm >= 5 && entryConfScore >= 5) {
        // Classic limit zone — near, highly confluent, minimum entry confidence met
        decision = 'LIMIT_NEAR';
        action   = `⏳ *LIMIT @ $${best.price.toFixed(4)}* — ${best.dist.toFixed(2)}% away | ETA: ${etaStr}`;
    } else if (best.dist <= 5.0 && confNorm >= 2) {
        // Worth setting a limit — medium distance
        decision = 'LIMIT_FAR';
        action   = `📌 *LIMIT @ $${best.price.toFixed(4)}* — ${best.dist.toFixed(2)}% away | ETA: ${etaStr}`;
    } else if (best.dist <= 8.0 && confNorm >= 4) {
        // Far but extremely high confluence — worth setting, but risky
        decision = 'LIMIT_FAR';
        action   = `📌 *LIMIT @ $${best.price.toFixed(4)}* — ${best.dist.toFixed(2)}% (High Conf Zone) | ETA: ${etaStr}`;
    } else {
        // Too far or too weak — skip, re-scan when price approaches
        decision    = 'SKIP';
        action      = `🚫 *SKIP TRADE* — Best zone ${best.dist.toFixed(1)}% away, insufficient setup`;
        skipReason  = `Best zone is ${best.dist.toFixed(1)}% away (${etaStr}). Set a price alert at $${(isL ? best.price * 1.03 : best.price * 0.97).toFixed(4)} and re-analyze when price approaches.`;
        entryConfScore = Math.max(0, entryConfScore - 3);
    }

    // ── 9. Build output ─────────────────────────────────────────
    return {
        decision,
        action,
        optimalEntry:      parseFloat(best.price.toFixed(6)),
        entryLabel:        best.label,
        confluence:        Math.round(best.confluence),
        confluenceSources: best.sources,
        distPct:           parseFloat(best.dist.toFixed(2)),
        eta:               etaStr,
        topZones:          topZones.map(z => ({
            price:      parseFloat(z.price.toFixed(4)),
            label:      z.label,
            confluence: Math.round(z.confluence),
            distPct:    parseFloat(z.dist.toFixed(2)),
            sources:    z.sources,
        })),
        skipReason,
        entryConfScore,
    };
}

module.exports = { analyzeSMC, detectOrderBlocks, checkOBConfirmation, selectBestEntry, getOrderTypeSuggestion, getDeepEntryDecision, checkLiquiditySweep, checkChoCH };
// Note: detectBOS() is in lib/indicators.js (v7 upgrade)

