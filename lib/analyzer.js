/**
 * ═══════════════════════════════════════════════════════════════
 *  APEX-MD  ·  lib/analyzer.js  ·  v7 PRO VVIP — SaaS Edition
 *  ─────────────────────────────────────────────────────────────
 *  UPGRADES IN THIS VERSION:
 *
 *  1. 🔧 CENTRALIZED CONFIG (config.js)
 *     All hardcoded values replaced with config.* references.
 *     Module enable/disable controlled via config.modules.* flags.
 *
 *  2. 🤖 FUTURE OBJECT (highest-priority AI metric)
 *     _callAIModel now parses { prediction, confidence, targetPrice,
 *     targetHigh, targetLow } from the upgraded Python API.
 *     Builds a `future` object attached to every analysis result.
 *     If confidence ≥ AI_BLOCK_THRESHOLD and direction OPPOSES
 *     indicators → trade is BLOCKED (future.blockTrade = true).
 *
 *  3. 🧩 RUNTIME MODULE GATES
 *     config.modules.AI_MODEL        → gates _callAIModel()
 *     config.modules.BYBIT           → gates getBybitConfluence()
 *     config.modules.DYNAMIC_WEIGHTS → gates getDynamicWeights()
 *     config.modules.SMC             → gates SMC scoring lines
 *
 *  All original return fields preserved. New fields added at end.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const axios      = require('axios');
const config     = require('../config');       // ← NEW: central config
const binance    = require('./binance');
const { getKlinesFromLake } = require('./dataLakeService');
const indicators = require('./indicators');
const smc        = require('./smartmoney');

// ── NEW: Institutional-grade upgrade modules ──────────────────
const { getDynamicWeights, w, getAdaptiveMultiplier } = require('./dynamicWeights');
const { getBybitConfluence }     = require('./multiExchange');

// v4 precision tools
const {
    calculateStochRSI, calculateBollingerBands,
    detectMTFOrderBlocks, detectMTFOBs, validateEntryPoint,
    calculateSmartTPs, calculateSmartSL,
    checkMTFRSIConfluence, detectVolumeNodes, getSessionQuality,
    checkCandleCloseConfirmation, getKeyLevels, getEMARibbon,
    scanFairValueGaps, calculateSupertrend, calculateRVOL, checkMTFMACD,
} = require('./indicators');

// v5 world-class indicators
const {
    detectWyckoffPhase, detectBreakerBlocks, detectEqualHighsLows,
    checkPremiumDiscount, calculateWilliamsR, calculateIchimoku,
    getHeikinAshiTrend, approximateCVD, calculatePivotPoints,
    getPivotSignal, checkFibConfluence,
} = require('./indicators');

// v6 big-profit indicators
const {
    detectBBSqueezeExplosion, detectVolatilityExpansion, detectMarketMakerTrap,
    getWeeklyMonthlyTargets, detectCMEGap, check3TFAlignment,
} = require('./indicators');

// v7 PRO VVIP indicators
const {
    calculateGannAngles, calculateRenko, getMoonCycle,
    getDynamicSR, detectBOS, scanAdvancedCandlePatterns,
    getFibonacciLevels, calculateMFI, calculateROC, calculateCCI,
    detectMomentumShift,
    // ✅ NEW: Enhanced entry intelligence
    checkHiddenDivergence, getMTFFibEntrySystem, getEntryQualityGate,
    getPostTP1SL, getBTCContext,
    // 🆕 v8 — new patterns & MTF divergence
    checkMTFRSIDivergence, checkCypherPattern, checkABCDPattern,
    checkHeadShoulders, checkTrianglePattern, checkThreeDrives,
    checkFibTimeZone,
} = require('./indicators');

// ══════════════════════════════════════════════════════════════
//  MTF TRADE CLASSIFICATION ENGINE
// ══════════════════════════════════════════════════════════════

function isPriceAtOB(ob, price, tolerance = 0.003) {
    if (!ob) return false;
    const bottom = parseFloat(ob.bottom);
    const top    = parseFloat(ob.top);
    return price >= bottom * (1 - tolerance) && price <= top * (1 + tolerance);
}

function classifyTrade({
    currentPrice, direction,
    ob4H, ob1H, ob15m, ob5m,
    choch5m, choch15m, sweep5m, sweep15m,
}) {
    const isLong   = direction === 'LONG';
    const dirOB4H  = isLong ? ob4H.bullish  : ob4H.bearish;
    const dirOB1H  = isLong ? ob1H.bullish  : ob1H.bearish;
    const dirOB15m = isLong ? ob15m.bullish : ob15m.bearish;
    const dirOB5m  = isLong ? ob5m.bullish  : ob5m.bearish;

    const at4HOB  = isPriceAtOB(dirOB4H,  currentPrice);
    const at1HOB  = isPriceAtOB(dirOB1H,  currentPrice);
    const at15mOB = isPriceAtOB(dirOB15m, currentPrice);

    const choch5mAligned  = isLong ? choch5m.includes('Bullish')  : choch5m.includes('Bearish');
    const sweep5mAligned  = isLong ? sweep5m.includes('Bullish')  : sweep5m.includes('Bearish');
    const ob5mAligned     = !!dirOB5m;
    const confirmed5m     = choch5mAligned || sweep5mAligned || ob5mAligned;
    const choch15mAligned = isLong ? choch15m.includes('Bullish') : choch15m.includes('Bearish');
    const sweep15mAligned = isLong ? sweep15m.includes('Bullish') : sweep15m.includes('Bearish');
    const ob15mAligned    = !!dirOB15m;
    const confirmed15m    = choch15mAligned || sweep15mAligned || ob15mAligned;

    function buildConfirmStr(tf, c, sw, ob) {
        const parts = [];
        if (c)  parts.push(`${tf} ChoCH ✅`);
        if (sw) parts.push(`${tf} Sweep ✅`);
        if (ob) parts.push(`${tf} OB ✅`);
        return parts.length ? parts.join(' + ') : `${tf} Pending ⏳`;
    }

    if (at4HOB && (confirmed5m || confirmed15m)) {
        const confStr = confirmed5m
            ? buildConfirmStr('5m', choch5mAligned, sweep5mAligned, ob5mAligned)
            : buildConfirmStr('15m', choch15mAligned, sweep15mAligned, ob15mAligned);
        return { label: '📅 SWING TRADE (Sniper Entry)', htfZone: `4H OB: $${dirOB4H.bottom} – $${dirOB4H.top}`,
                 confirmTF: confStr, holdTime: '2–7 Days', riskNote: 'Hold for full TP3. Wide SL. Scale in on 5m dips.', emoji: '📅' };
    }
    if (at1HOB && (confirmed15m || confirmed5m)) {
        const confStr = confirmed5m
            ? buildConfirmStr('5m', choch5mAligned, sweep5mAligned, ob5mAligned)
            : buildConfirmStr('15m', choch15mAligned, sweep15mAligned, ob15mAligned);
        return { label: '🌅 INTRADAY TRADE (Sniper)', htfZone: `1H OB: $${dirOB1H.bottom} – $${dirOB1H.top}`,
                 confirmTF: confStr, holdTime: '4–24 Hours', riskNote: 'Target TP1/TP2. Move SL to break-even at TP1.', emoji: '🌅' };
    }
    if (at15mOB && confirmed5m) {
        return { label: '⚡ HIGH-PROB SCALP', htfZone: `15m OB: $${dirOB15m.bottom} – $${dirOB15m.top}`,
                 confirmTF: buildConfirmStr('5m', choch5mAligned, sweep5mAligned, ob5mAligned),
                 holdTime: '30–240 Minutes', riskNote: 'Tight SL. Target TP1 only. Exit quickly.', emoji: '⚡' };
    }
    return { label: '📊 STANDARD SETUP', htfZone: 'No HTF OB Confluence',
             confirmTF: confirmed5m ? buildConfirmStr('5m', choch5mAligned, sweep5mAligned, ob5mAligned) : 'Score-Based Entry',
             holdTime: 'Flexible', riskNote: 'Follow 14-Factor score. Wait for cleaner structure.', emoji: '📊' };
}

// ══════════════════════════════════════════════════════════════
//  TRADE PARAMETER REFINEMENT ENGINE (Full Spectrum v3)
// ══════════════════════════════════════════════════════════════
function refineTradeParameters({
    entry, sl, slLabel, tp1, tp1Label, tp2, tp2Label, tp3, tp3Label,
    direction, atrVal, currentPrice,
    ichimoku, supertrend, wyckoff, pivots, equalHL, breakers, fibConf,
    mtfOB, fvgData, volNodes, bbands, rvol, adxData, session,
    dynamicSR, fibLevels, mfi, williamsR, advCandles, gannAngles, bos,
    weeklyTgts, cmeGap, heikinAshi,
}) {
    const isLong = direction === 'LONG';
    let rEntry = parseFloat(entry);
    let rSL = parseFloat(sl),    rSLLabel  = slLabel  || 'ATR';
    let rTP1 = parseFloat(tp1),  rTP1Label = tp1Label || '1:2 RRR';
    let rTP2 = parseFloat(tp2),  rTP2Label = tp2Label || '1:3 RRR';
    let rTP3 = parseFloat(tp3),  rTP3Label = tp3Label || '1:5 RRR';
    const atr = parseFloat(atrVal) || 0;
    const cp  = parseFloat(currentPrice);
    const refinements = [];

    // Section A: Entry refinements
    if (williamsR) { const ok = isLong ? williamsR.isBull : williamsR.isBear; if (ok && Math.abs(rEntry-cp)/cp < 0.002) { rEntry = isLong ? cp*1.0005 : cp*0.9995; refinements.push(`Entry: W%R $${rEntry.toFixed(4)}`); } }
    if (mfi) {
        if (isLong && mfi.isBull && mfi.value < 25 && Math.abs(rEntry-cp)/cp < 0.003) { rEntry = cp*1.001; refinements.push(`Entry: MFI Oversold $${rEntry.toFixed(4)}`); }
        if (!isLong && mfi.isBear && mfi.value > 75 && Math.abs(rEntry-cp)/cp < 0.003) { rEntry = cp*0.999; refinements.push(`Entry: MFI Overbought $${rEntry.toFixed(4)}`); }
    }
    if (gannAngles) { const ok = isLong ? gannAngles.isBull : gannAngles.isBear; if (ok && Math.abs(rEntry-cp)/cp < 0.004) { rEntry = isLong ? cp*1.001 : cp*0.999; refinements.push(`Entry: Gann $${rEntry.toFixed(4)}`); } }
    if (advCandles && advCandles.pattern !== 'None') {
        const bp = ['Three White Soldiers','Morning Star','Tweezer Bottom','Bullish Harami','Piercing Line'];
        const brp = ['Three Black Crows','Evening Star','Tweezer Top','Bearish Harami','Dark Cloud Cover'];
        if ((isLong && bp.some(p => advCandles.pattern?.includes(p))) || (!isLong && brp.some(p => advCandles.pattern?.includes(p)))) { rEntry = isLong ? cp*1.001 : cp*0.999; refinements.push(`Entry: ${advCandles.pattern} $${rEntry.toFixed(4)}`); }
    }
    if (bos) {
        if (isLong && bos.bullBOS && Math.abs(rEntry-cp)/cp < 0.005) { rEntry = cp*1.001; refinements.push(`Entry: Bull BOS $${rEntry.toFixed(4)}`); }
        if (!isLong && bos.bearBOS && Math.abs(rEntry-cp)/cp < 0.005) { rEntry = cp*0.999; refinements.push(`Entry: Bear BOS $${rEntry.toFixed(4)}`); }
    }
    if (dynamicSR) {
        if (isLong && dynamicSR.nearSupport && dynamicSR.support) { const s = parseFloat(dynamicSR.support); if (Math.abs(s-cp)/cp < 0.004) { rEntry = s*1.001; refinements.push(`Entry: Dynamic Support $${rEntry.toFixed(4)}`); } }
        if (!isLong && dynamicSR.nearResist && dynamicSR.resistance) { const r = parseFloat(dynamicSR.resistance); if (Math.abs(r-cp)/cp < 0.004) { rEntry = r*0.999; refinements.push(`Entry: Dynamic Resist $${rEntry.toFixed(4)}`); } }
    }
    if (fvgData) { const fvgs = isLong ? (fvgData.bullFVGs||[]) : (fvgData.bearFVGs||[]); const n = fvgs.find(g => Math.abs(parseFloat(g.mid)-cp)/cp < 0.004 && !g.filled); if (n) { rEntry = parseFloat(n.mid); refinements.push(`Entry: FVG mid $${rEntry.toFixed(4)}`); } }
    if (mtfOB?.confluenceZone) { const cz = mtfOB.confluenceZone, cb = parseFloat(cz.bottom), ct = parseFloat(cz.top); if (isLong && cz.type==='BULLISH' && cp>=cb*0.998 && cp<=ct*1.002) { rEntry=cb*1.001; refinements.push(`Entry: MTF OB Conf $${rEntry.toFixed(4)} 🔥`); } if (!isLong && cz.type==='BEARISH' && cp>=cb*0.998 && cp<=ct*1.002) { rEntry=ct*0.999; refinements.push(`Entry: MTF OB Conf $${rEntry.toFixed(4)} 🔥`); } }
    if (fibLevels?.isAtOTE) { const o6 = parseFloat(fibLevels.key618), o7 = parseFloat(fibLevels.key786), d6 = Math.abs(cp-o6)/cp, d7 = Math.abs(cp-o7)/cp; if (isLong) { if (d6 < 0.005) { rEntry = o6*1.001; refinements.push(`Entry: OTE 61.8% $${rEntry.toFixed(4)}`); } else if (d7 < 0.005) { rEntry = o7*1.001; refinements.push(`Entry: OTE 78.6% $${rEntry.toFixed(4)}`); } } else { if (d6 < 0.005) { rEntry = o6*0.999; refinements.push(`Entry: OTE 61.8% SHORT $${rEntry.toFixed(4)}`); } else if (d7 < 0.005) { rEntry = o7*0.999; refinements.push(`Entry: OTE 78.6% SHORT $${rEntry.toFixed(4)}`); } } }
    if (fibConf?.hasConfluence && fibConf.zone) { const fz = parseFloat(fibConf.zone); if (Math.abs(fz-cp)/cp < 0.005) { rEntry = fz; refinements.push(`Entry: Fib Conf $${rEntry.toFixed(4)} (${fibConf.count}×)`); } }
    if (ichimoku?.kijun) { const k = parseFloat(ichimoku.kijun); if (Math.abs(k-cp)/cp < 0.003) { rEntry = isLong ? k*1.001 : k*0.999; refinements.push(`Entry: Kijun $${rEntry.toFixed(4)}`); } }
    if (isLong  && breakers?.bullishBreaker) { const t = parseFloat(breakers.bullishBreaker.top);    if (atr > 0 && Math.abs(t-cp) < atr*1.2) { rEntry = t*1.001; refinements.push(`Entry: Bull Breaker $${rEntry.toFixed(4)} 🔥`); } }
    if (!isLong && breakers?.bearishBreaker) { const b = parseFloat(breakers.bearishBreaker.bottom); if (atr > 0 && Math.abs(b-cp) < atr*1.2) { rEntry = b*0.999; refinements.push(`Entry: Bear Breaker $${rEntry.toFixed(4)} 🔥`); } }

    // Section B: SL refinements
    const slT = (newSL, lb) => {
        if (isLong  && newSL < rEntry && newSL > rSL) { rSL = newSL; rSLLabel = lb; refinements.push(`SL → ${lb} $${rSL.toFixed(4)}`); }
        if (!isLong && newSL > rEntry && newSL < rSL) { rSL = newSL; rSLLabel = lb; refinements.push(`SL → ${lb} $${rSL.toFixed(4)}`); }
    };
    const slW = (newSL, lb) => {
        if (isLong  && newSL < rEntry) { rSL = newSL; rSLLabel = lb; refinements.push(`SL widened → ${lb} $${rSL.toFixed(4)}`); }
        if (!isLong && newSL > rEntry) { rSL = newSL; rSLLabel = lb; refinements.push(`SL widened → ${lb} $${rSL.toFixed(4)}`); }
    };
    if (supertrend?.supertrendLevel && parseFloat(supertrend.supertrendLevel) > 0) { const sl = parseFloat(supertrend.supertrendLevel); if (isLong && supertrend.isBull) slT(sl*0.998,'Supertrend'); if (!isLong && supertrend.isBear) slT(sl*1.002,'Supertrend'); }
    if (ichimoku?.kijun) { const k = parseFloat(ichimoku.kijun); slT(isLong ? k*0.997 : k*1.003, 'Kijun SL'); }
    if (ichimoku && !ichimoku.inCloud) { if (isLong && ichimoku.cloudTop) slT(parseFloat(ichimoku.cloudTop)*0.997,'Cloud SL'); if (!isLong && ichimoku.cloudBot) slT(parseFloat(ichimoku.cloudBot)*1.003,'Cloud SL'); }
    if (dynamicSR) { if (isLong && dynamicSR.support) slT(parseFloat(dynamicSR.support)*0.997,'Fractal S/R SL'); if (!isLong && dynamicSR.resistance) slT(parseFloat(dynamicSR.resistance)*1.003,'Fractal S/R SL'); }
    if (isLong && breakers?.bullishBreaker) slT(parseFloat(breakers.bullishBreaker.bottom)*0.997,'Breaker SL');
    if (!isLong && breakers?.bearishBreaker) slT(parseFloat(breakers.bearishBreaker.top)*1.003,'Breaker SL');
    if (volNodes?.lvnZones?.length > 0) { const lvns = volNodes.lvnZones.map(z => parseFloat(z)).filter(isFinite); if (isLong) { const lb = lvns.filter(z => z < rEntry).sort((a,b) => b-a)[0]; if (lb) slT(lb*0.997,'LVN SL'); } else { const la = lvns.filter(z => z > rEntry).sort((a,b) => a-b)[0]; if (la) slT(la*1.003,'LVN SL'); } }
    if (equalHL) { if (isLong && equalHL.eql) slT(parseFloat(equalHL.eql.level)*0.995,'EQL Guard SL'); if (!isLong && equalHL.eqh) slT(parseFloat(equalHL.eqh.level)*1.005,'EQH Guard SL'); }
    if (bbands) { const bs = isLong ? parseFloat(bbands.lower) : parseFloat(bbands.upper); if (bs && isFinite(bs)) slT(isLong ? bs*0.998 : bs*1.002,'BB Band SL'); }
    if (ichimoku?.tenkan) { const t = parseFloat(ichimoku.tenkan); if (isLong && t < rEntry*0.995) slT(t*0.997,'Tenkan SL'); if (!isLong && t > rEntry*1.005) slT(t*1.003,'Tenkan SL'); }
    if (adxData) { const av = parseFloat(adxData.adx || adxData.value || 0); if (av > 35 && rvol?.signal === 'EXTREME') slW(isLong ? rSL*0.993 : rSL*1.007,'High Vol SL'); else if (av < 18) slT(isLong ? rSL*1.004 : rSL*0.996,'Low Vol SL'); }
    if (session?.quality === 'CAUTION') slW(isLong ? rSL*0.996 : rSL*1.004,'Asian Session SL');
    if (wyckoff?.phase === 'SPRING'  && isLong)  slW(rSL*0.996,'Spring SL');
    if (wyckoff?.phase === 'UTAD'   && !isLong)  slW(rSL*1.004,'UTAD SL');
    if (mfi && ((isLong && mfi.isBear) || (!isLong && mfi.isBull))) slW(isLong ? rSL*0.996 : rSL*1.004,'MFI Conflict SL');
    if (rvol?.signal === 'EXTREME') slW(isLong ? rSL*0.994 : rSL*1.006,'RVOL Extreme SL');

    // Section C: TP refinements
    const risk = Math.abs(rEntry - rSL) || atr * 1.5;
    const sTP1 = (lv, lb, tol=0.04) => { if (!lv||!isFinite(lv)) return; if (isLong && lv > rEntry && Math.abs(lv-rTP1)/rTP1 < tol) { rTP1=lv; rTP1Label=lb; refinements.push(`TP1 → ${lb} $${rTP1.toFixed(4)}`); } if (!isLong && lv < rEntry && Math.abs(lv-rTP1)/rTP1 < tol) { rTP1=lv; rTP1Label=lb; refinements.push(`TP1 → ${lb} $${rTP1.toFixed(4)}`); } };
    const sTP2 = (lv, lb, tol=0.07) => { if (!lv||!isFinite(lv)) return; if (isLong && lv > rTP1 && Math.abs(lv-rTP2)/rTP2 < tol) { rTP2=lv; rTP2Label=lb; refinements.push(`TP2 → ${lb} $${rTP2.toFixed(4)}`); } if (!isLong && lv < rTP1 && Math.abs(lv-rTP2)/rTP2 < tol) { rTP2=lv; rTP2Label=lb; refinements.push(`TP2 → ${lb} $${rTP2.toFixed(4)}`); } };
    const sTP3 = (lv, lb) => { if (!lv||!isFinite(lv)) return; if (isLong && lv > rTP2 && lv < rTP3) { rTP3=lv; rTP3Label=lb; refinements.push(`TP3 → ${lb} $${rTP3.toFixed(4)}`); } if (!isLong && lv < rTP2 && lv > rTP3) { rTP3=lv; rTP3Label=lb; refinements.push(`TP3 → ${lb} $${rTP3.toFixed(4)}`); } };
    if (pivots) { if (isLong) { sTP1(parseFloat(pivots.R1)*0.999,'Pivot R1'); sTP2(parseFloat(pivots.R2)*0.999,'Pivot R2'); sTP3(parseFloat(pivots.R3),'Pivot R3 🎯'); } else { sTP1(parseFloat(pivots.S1)*1.001,'Pivot S1'); sTP2(parseFloat(pivots.S2)*1.001,'Pivot S2'); sTP3(parseFloat(pivots.S3),'Pivot S3 🎯'); } }
    if (ichimoku?.kijun) { sTP1(isLong ? parseFloat(ichimoku.kijun)*0.999 : parseFloat(ichimoku.kijun)*1.001,'Kijun TP'); }
    if (ichimoku?.tenkan) { const t = parseFloat(ichimoku.tenkan); if (isLong && t > rEntry*1.003) sTP1(t*0.999,'Tenkan TP1'); if (!isLong && t < rEntry*0.997) sTP1(t*1.001,'Tenkan TP1'); }
    if (ichimoku && !ichimoku.inCloud) { if (isLong && ichimoku.cloudBot) sTP1(parseFloat(ichimoku.cloudBot)*0.999,'Cloud Bot TP'); if (!isLong && ichimoku.cloudTop) sTP1(parseFloat(ichimoku.cloudTop)*1.001,'Cloud Top TP'); }
    if (fvgData) { const bf = (fvgData.bullFVGs||[]).filter(g=>!g.filled), rf = (fvgData.bearFVGs||[]).filter(g=>!g.filled); if (isLong) { const a = bf.filter(g=>parseFloat(g.mid)>rEntry).sort((a,b)=>parseFloat(a.mid)-parseFloat(b.mid)); if(a[0]) sTP1(parseFloat(a[0].mid),'FVG Fill TP1'); if(a[1]) sTP2(parseFloat(a[1].mid),'FVG Fill TP2'); } else { const b = rf.filter(g=>parseFloat(g.mid)<rEntry).sort((a,b)=>parseFloat(b.mid)-parseFloat(a.mid)); if(b[0]) sTP1(parseFloat(b[0].mid),'FVG Fill TP1'); if(b[1]) sTP2(parseFloat(b[1].mid),'FVG Fill TP2'); } }
    if (equalHL) { if (isLong && equalHL.eqh) { const p = parseFloat(equalHL.eqh.level)*0.997; if(p>rEntry){if(p<rTP1*1.03){rTP1=p;rTP1Label='EQH TP1';refinements.push(`TP1 → EQH $${rTP1.toFixed(4)}`);}else sTP2(p,'EQH Pool TP2');} } if (!isLong && equalHL.eql) { const p = parseFloat(equalHL.eql.level)*1.003; if(p<rEntry){if(p>rTP1*0.97){rTP1=p;rTP1Label='EQL TP1';refinements.push(`TP1 → EQL $${rTP1.toFixed(4)}`);}else sTP2(p,'EQL Pool TP2');} } }
    if (dynamicSR) { if (isLong && dynamicSR.resistance) sTP1(parseFloat(dynamicSR.resistance)*0.998,'Dynamic Resist TP'); if (!isLong && dynamicSR.support) sTP1(parseFloat(dynamicSR.support)*1.002,'Dynamic Support TP'); }
    if (volNodes?.hvnPrice && volNodes.hvnPrice !== '0.0000') { const h = parseFloat(volNodes.hvnPrice); if (isLong && h>rEntry) sTP1(h,'HVN Magnet TP'); if (!isLong && h<rEntry) sTP1(h,'HVN Magnet TP'); }
    if (bbands) { if (isLong && bbands.upper) sTP1(parseFloat(bbands.upper)*0.998,'BB Upper TP'); if (!isLong && bbands.lower) sTP1(parseFloat(bbands.lower)*1.002,'BB Lower TP'); }
    if (fibLevels?.levels) { if (isLong) { const e1=parseFloat(fibLevels.ext1272),e2=parseFloat(fibLevels.ext1618),e3=parseFloat(fibLevels.ext2618); if(e1>rEntry) sTP1(e1,'Fib 1.272 TP1'); if(e2>rTP1) sTP2(e2,'Fib 1.618 TP2 🎯'); if(e3>rTP2) sTP3(e3,'Fib 2.618 TP3 🚀'); } else { const r1=parseFloat(fibLevels.key618),r2=parseFloat(fibLevels.key382); if(r1<rEntry) sTP1(r1,'Fib 61.8% TP1'); if(r2<rTP1) sTP2(r2,'Fib 38.2% TP2'); } }
    if (breakers) { if (isLong && breakers.bearishBreaker) { const b = parseFloat(breakers.bearishBreaker.bottom); if(b>rEntry) sTP2(b*0.997,'Breaker Barrier TP'); } if (!isLong && breakers.bullishBreaker) { const t = parseFloat(breakers.bullishBreaker.top); if(t<rEntry) sTP2(t*1.003,'Breaker Barrier TP'); } }
    if (mtfOB?.confluenceZone) { const cz=mtfOB.confluenceZone, cb=parseFloat(cz.bottom), ct=parseFloat(cz.top); if (isLong && cb>rEntry) sTP2(cb,'MTF OB Conf TP 🔥'); if (!isLong && ct<rEntry) sTP2(ct,'MTF OB Conf TP 🔥'); }
    if (cmeGap?.hasGap && cmeGap.gapMid) { const gm = parseFloat(cmeGap.gapMid); if (isLong && gm>rEntry) sTP3(gm,'CME Gap Fill 🎯'); if (!isLong && gm<rEntry) sTP3(gm,'CME Gap Fill 🎯'); }
    if (weeklyTgts) { const wt = isLong ? parseFloat(weeklyTgts.weeklyHigh) : parseFloat(weeklyTgts.weeklyLow); if (wt && isFinite(wt)) sTP3(wt,'Weekly Target TP3 📅'); }
    if (gannAngles?.targetAbove && isLong)  sTP3(parseFloat(gannAngles.targetAbove),'Gann Ext TP3');
    if (gannAngles?.targetBelow && !isLong) sTP3(parseFloat(gannAngles.targetBelow),'Gann Ext TP3');
    if (dynamicSR) { if (isLong && dynamicSR.dynR2) sTP3(parseFloat(dynamicSR.dynR2),'Keltner 2ATR TP3'); if (!isLong && dynamicSR.dynS2) sTP3(parseFloat(dynamicSR.dynS2),'Keltner 2ATR TP3'); }

    // Section D: Safety validation
    if (isLong)  { if (!isFinite(rSL)||isNaN(rSL)||rSL>=rEntry) rSL=rEntry-risk; if (!isFinite(rTP1)||isNaN(rTP1)||rTP1<=rEntry) rTP1=rEntry+risk*2; if (!isFinite(rTP2)||isNaN(rTP2)||rTP2<=rTP1) rTP2=rTP1+risk; if (!isFinite(rTP3)||isNaN(rTP3)||rTP3<=rTP2) rTP3=rTP2+risk*2; }
    else         { if (!isFinite(rSL)||isNaN(rSL)||rSL<=rEntry) rSL=rEntry+risk; if (!isFinite(rTP1)||isNaN(rTP1)||rTP1>=rEntry) rTP1=rEntry-risk*2; if (!isFinite(rTP2)||isNaN(rTP2)||rTP2>=rTP1) rTP2=rTP1-risk; if (!isFinite(rTP3)||isNaN(rTP3)||rTP3>=rTP2) rTP3=rTP2-risk*2; }

    return {
        entry: rEntry.toFixed(4), sl: rSL.toFixed(4), slLabel: rSLLabel,
        tp1: rTP1.toFixed(4), tp1Label: rTP1Label, tp2: rTP2.toFixed(4), tp2Label: rTP2Label,
        tp3: rTP3.toFixed(4), tp3Label: rTP3Label, refinements,
        wasRefined: refinements.length > 0,
        refinementNote: refinements.length > 0
            ? `🔧 ${refinements.length} refinements: ${refinements.slice(0,3).join(' | ')}${refinements.length>3?` (+${refinements.length-3} more)`:''}`
            : null,
    };
}

// ══════════════════════════════════════════════════════════════
//  🤖 AI MODEL CALL — LOCAL PYTHON LSTM SERVER
//  Uses config.AI settings for URL, timeout, and thresholds.
//  Returns null if server is offline (safe fallback).
// ══════════════════════════════════════════════════════════════
async function _callAIModel(coin, candles) {
    if (!config.modules.AI_MODEL) return null;  // gated by module toggle

    try {
        const payload = {
            symbol:  coin,
            candles: candles.slice(-120).map(k => ({
                open:   parseFloat(k[1]), high: parseFloat(k[2]),
                low:    parseFloat(k[3]), close: parseFloat(k[4]),
                volume: parseFloat(k[5]),
            })),
        };
        const response = await axios.post(
            `${config.AI.URL}/predict`,
            payload,
            { timeout: config.AI.TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } }
        );

        const { prediction, confidence, targetPrice, targetHigh, targetLow, source } = response.data;
        if (!prediction || typeof confidence !== 'number') return null;

        return {
            prediction,
            confidence,
            targetPrice: targetPrice || null,
            targetHigh:  targetHigh  || null,
            targetLow:   targetLow   || null,
            source:      source || 'lstm',
        };
    } catch (err) {
        if (err.code !== 'ECONNREFUSED' && err.code !== 'ETIMEDOUT') {
            console.warn(`[analyzer] AI model error: ${err.message}`);
        }
        return null;
    }
}

// ══════════════════════════════════════════════════════════════
//  🤖 BUILD FUTURE OBJECT + SCORE MODIFIER
//  This is now the HIGHEST-PRIORITY metric in the scoring system.
//
//  Scoring rules:
//    Confidence ≥ BLOCK_THRESHOLD (80%) + opposes direction → BLOCK TRADE
//    Confidence ≥ 80% + aligns with direction               → +2
//    Confidence ≥ 60% + aligns with direction               → +1
//    Confidence ≥ 80% + opposes direction                   → -2
//    Confidence ≥ 60% + opposes direction                   → -1
//    Confidence < 60% or AI offline                         → 0 (neutral)
//
//  blockTrade:
//    true = AI is highly confident in the OPPOSITE direction.
//    Caller (future.js) should show a warning and refuse entry.
// ══════════════════════════════════════════════════════════════
function _buildFuture(aiResult, direction) {
    /** @type {{
     *   prediction: string, confidence: number|null, targetPrice: number|null,
     *   targetHigh: number|null, targetLow: number|null, source: string,
     *   modifier: number, label: string, blockTrade: boolean, available: boolean
     * }} */
    const OFFLINE = {
        prediction: null, confidence: null, targetPrice: null,
        targetHigh: null, targetLow: null, source: 'offline',
        modifier: 0, label: 'AI_OFFLINE ⚪', blockTrade: false, available: false,
    };

    if (!aiResult || aiResult.confidence < config.AI.CONFIDENCE_THRESHOLD) return OFFLINE;

    const aligns = (direction === 'LONG'  && aiResult.prediction === 'Bullish') ||
                   (direction === 'SHORT' && aiResult.prediction === 'Bearish');
    const highConf = aiResult.confidence >= config.AI.BLOCK_THRESHOLD;

    // Block trade if high-confidence AI opposes the direction
    const blockTrade = !aligns && highConf;

    let modifier;
    if (blockTrade)          modifier = -3;  // hard veto signal
    else if (aligns && highConf) modifier = 2;
    else if (aligns)         modifier = 1;
    else if (highConf)       modifier = -2;
    else                     modifier = -1;

    const dirEmoji  = aligns ? '✅' : '❌';
    const blockTag  = blockTrade ? ' 🚫BLOCK' : '';
    const tpStr     = aiResult.targetPrice ? ` → $${parseFloat(aiResult.targetPrice).toFixed(2)}` : '';
    const label = `🤖 AI ${aiResult.prediction} ${aiResult.confidence.toFixed(0)}%${tpStr} [${modifier >= 0 ? '+' : ''}${modifier}] ${dirEmoji}${blockTag}`;

    return {
        prediction:  aiResult.prediction,
        confidence:  aiResult.confidence,
        targetPrice: aiResult.targetPrice,
        targetHigh:  aiResult.targetHigh,
        targetLow:   aiResult.targetLow,
        source:      aiResult.source,
        modifier,
        label,
        blockTrade,
        available: true,
    };
}

// ══════════════════════════════════════════════════════════════
//  PUBLIC ENTRY POINT
// ══════════════════════════════════════════════════════════════
async function run14FactorAnalysis(coin, timeframe = '15m') {
    return await Promise.race([
        _run14FactorAnalysisImpl(coin, timeframe),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Analysis timeout (30s) — Binance API slow or unreachable. Try again.`)), 30000)
        ),
    ]);
}

// ── Adaptive score helper ─────────────────────────────────────────────────
// wA(pts, weight, indicatorKey) = pts * weight * adaptiveMultiplier
// Falls back to w() if adaptive system not loaded yet.
function wA(pts, weight, key) {
    const aMulti = getAdaptiveMultiplier(key);
    return Math.round(pts * weight * aMulti * 100) / 100;
}

async function _run14FactorAnalysisImpl(coin, timeframe = '15m') {

    // ── 1. Data Fetching ──────────────────────────────────────
    const [currentCandles, candles5m, candles1H, candles4H, candlesDaily, fundingRaw, btcCandles1H, btcCandles4H] = await Promise.all([
        getKlinesFromLake(coin, timeframe, 500),
        getKlinesFromLake(coin, '5m',     500).catch(() => null),
        getKlinesFromLake(coin, '1h',     60).catch(() => null),
        getKlinesFromLake(coin, '4h',     80).catch(() => null),
        getKlinesFromLake(coin, '1d',     60).catch(() => null),
        // ✅ NEW: BTC candles for context (only for non-BTC coins)
        coin !== 'BTCUSDT' ? getKlinesFromLake('BTCUSDT', '1h', 60).catch(() => null) : Promise.resolve(null),
        coin !== 'BTCUSDT' ? getKlinesFromLake('BTCUSDT', '4h', 60).catch(() => null) : Promise.resolve(null),
        // Funding rate — fetch raw number directly (getFundingRate returns string, we need float)
        axios.get(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${coin}&limit=1`, { timeout: 4000 })
             .then(r => r.data?.[0] ? parseFloat(r.data[0].fundingRate) * 100 : null)
             .catch(() => null),
    ]);

    const fundingRate = (typeof fundingRaw === 'number' && !isNaN(fundingRaw)) ? fundingRaw : null;

    if (!currentCandles || currentCandles.length < 10) {
        throw new Error(`${coin} ${timeframe} candle data unavailable — Binance API unreachable or coin invalid`);
    }

    const currentPrice = parseFloat(currentCandles[currentCandles.length - 1][4]);
    const priceStr     = currentPrice.toFixed(4);

    // ── 2. Core Indicators ────────────────────────────────────
    // Pro Mode: use user-defined periods. Auto AI: use proven defaults.
    const _proMode   = config.modules.PRO_MODE;
    const _rsiPeriod = _proMode ? config.proParams.RSI_PERIOD : 14;
    const _fastEMA   = _proMode ? config.proParams.FAST_EMA   : 50;
    const _slowEMA   = _proMode ? config.proParams.SLOW_EMA   : 200;

    const ema200 = parseFloat(indicators.calculateEMA(currentCandles, _slowEMA));
    const ema50  = parseFloat(indicators.calculateEMA(currentCandles.slice(-100), _fastEMA));
    const ema1H  = candles1H ? parseFloat(indicators.calculateEMA(candles1H, _fastEMA)) : ema200;
    const ema4H  = candles4H ? parseFloat(indicators.calculateEMA(candles4H, _fastEMA)) : ema200;

    const trend1H   = candles1H?.length > 0 ? (parseFloat(candles1H[candles1H.length-1][4]) > ema1H ? 'Bullish 🟢' : 'Bearish 🔴') : (currentPrice > ema200 ? 'Bullish 🟢' : 'Bearish 🔴');
    const trend4H   = candles4H?.length > 0 ? (parseFloat(candles4H[candles4H.length-1][4]) > ema4H ? 'Bullish 🟢' : 'Bearish 🔴') : trend1H;
    // ✅ FIX: mainTrend from 15m EMA50+EMA200 confluence (more reliable than EMA21 alone)
    const ema50_15m = currentCandles?.length >= 50 ? parseFloat(indicators.calculateEMA(currentCandles.slice(-50), 50)) : ema200;
    const mainTrend = (currentPrice > ema200 && currentPrice > ema50_15m) ? 'Bullish 🟢'
                    : (currentPrice < ema200 && currentPrice < ema50_15m) ? 'Bearish 🔴'
                    : currentPrice > ema200 ? 'Mild Bullish 🟡' : 'Mild Bearish 🟡';
    const direction = mainTrend.includes('Bullish') ? 'LONG' : 'SHORT';

    // ── 3. Market State ───────────────────────────────────────
    const adxData       = indicators.calculateADX(currentCandles.slice(-50));
    const isHTFAligned  = (trend1H.includes('Bullish') && trend4H.includes('Bullish')) || (trend1H.includes('Bearish') && trend4H.includes('Bearish'));
    let marketState     = 'TRENDING 🚀';
    let isTrueChoppy    = false;
    if (!adxData.isStrong) {
        if (isHTFAligned) marketState = `CONSOLIDATION ⏳ (${trend4H.includes('Bullish') ? 'Bull Flag' : 'Bear Flag'})`;
        else              { marketState = 'TRUE CHOPPY ⚖️ (Grid Mode Active)'; isTrueChoppy = true; }
    }

    // ── 🧠 DYNAMIC WEIGHTS (config-gated) ────────────────────
    let weights = { trend: 1.0, oscillator: 1.0, volume: 1.0, priceAction: 1.0 };
    let dynResult = null;
    if (config.modules.DYNAMIC_WEIGHTS) {
        dynResult = getDynamicWeights(currentCandles.slice(-100));
        weights   = dynResult.weights;
    }

    // ── 4. All Indicators ─────────────────────────────────────
    const rsi             = indicators.calculateRSI(currentCandles.slice(-50), _rsiPeriod);
    const atr             = indicators.calculateATR(currentCandles.slice(-50));
    const atrVal          = parseFloat(atr);
    const macd            = indicators.calculateMACD(currentCandles.slice(-50));
    const vwap            = indicators.calculateVWAP(currentCandles);
    const poc             = indicators.calculatePOC(currentCandles.slice(-50));
    const pattern         = indicators.checkCandlePattern(currentCandles.slice(-10));
    const volBreak        = indicators.checkVolumeBreakout(currentCandles.slice(-50));
    const divergence      = indicators.checkDivergence(currentCandles.slice(-50));
    const hiddenDivergence = checkHiddenDivergence(currentCandles.slice(-60));
    // 🆕 v8 patterns — all wrapped in try/catch to prevent any crash
    const _none = { bull:false, bear:false, display:'None' };
    let mtfRSIDiv  = { bull:false,bear:false,hbull:false,hbear:false,mtfBull:false,mtfBear:false,mtfHBull:false,mtfHBear:false,mtfConfirmed:false,display:'None' };
    let cypherPat  = _none, abcdPat = _none, headShould = { bull:false, bear:false, neckline:null, display:'None' };
    let trianglePat = { type:'NONE', bull:false, bear:false, apex:null, display:'None' };
    let threeDrives = _none;
    let fibTimeZone = { atZone:false, zoneNum:0, display:'None' };
    try { mtfRSIDiv  = checkMTFRSIDivergence(currentCandles.slice(-60), candles1H?.slice(-60)); } catch(_e) {}
    try { cypherPat  = checkCypherPattern(currentCandles.slice(-80));   } catch(_e) {}
    try { abcdPat    = checkABCDPattern(currentCandles.slice(-60));     } catch(_e) {}
    try { headShould = checkHeadShoulders(currentCandles.slice(-80));   } catch(_e) {}
    try { trianglePat = checkTrianglePattern(currentCandles.slice(-40));} catch(_e) {}
    try { threeDrives = checkThreeDrives(currentCandles.slice(-80));    } catch(_e) {}
    try { fibTimeZone = checkFibTimeZone(currentCandles.slice(-30));    } catch(_e) {}
    // ✅ NEW: BTC real context
    const btcContext   = await getBTCContext(btcCandles1H, btcCandles4H);
    // ✅ NEW: Multi-timeframe Fibonacci entry system
    const mtfFibEntry  = getMTFFibEntrySystem(currentCandles.slice(-100), candles1H, candles4H, direction === 'LONG' ? 'LONG' : 'SHORT');
    const harmonicPattern = indicators.checkHarmonicPattern(currentCandles.slice(-100));
    const ictSilverBullet = indicators.checkICTSilverBullet(currentCandles.slice(-10));
    const marketSMC       = smc.analyzeSMC(currentCandles.slice(-50));

    // ── 4c. HTF OBs — must be declared before confirmEntry5m ──
    const ob4H   = detectMTFOBs((candles4H || currentCandles).slice(-20));
    const ob1H   = detectMTFOBs((candles1H || currentCandles).slice(-20));
    const ob15m  = detectMTFOBs(currentCandles.slice(-20));
    const choch15m = smc.checkChoCH(currentCandles.slice(-20));
    const sweep15m = smc.checkLiquiditySweep(currentCandles.slice(-15));

    const mtf5m           = indicators.confirmEntry5m(candles5m, direction, candles4H, candlesDaily, ob4H);
    const liquiditySweep  = smc.checkLiquiditySweep(currentCandles.slice(-15));
    const choch           = smc.checkChoCH(currentCandles.slice(-20));
    const mtfOBsExtra     = detectMTFOBs(currentCandles.slice(-15));
    const stochRSI        = calculateStochRSI(currentCandles.slice(-60));
    const bbands          = calculateBollingerBands(currentCandles.slice(-30));
    const mtfOB           = detectMTFOrderBlocks(currentCandles.slice(-30), (candles1H || currentCandles).slice(-20), (candles4H || null)?.slice(-20));
    const mtfRSI          = checkMTFRSIConfluence(currentCandles.slice(-50), (candles1H || currentCandles).slice(-50));
    const volNodes        = detectVolumeNodes(currentCandles.slice(-100));
    const session         = getSessionQuality();
    const candleConf      = checkCandleCloseConfirmation(currentCandles.slice(-5), direction, null);
    const keyLevels       = getKeyLevels(currentCandles.slice(-100));
    const emaRibbon       = getEMARibbon(currentCandles);
    const fvgData         = scanFairValueGaps(currentCandles.slice(-50));
    const supertrend      = calculateSupertrend(currentCandles.slice(-60));
    const rvol            = calculateRVOL(currentCandles.slice(-30));
    const mtfMACD         = checkMTFMACD(currentCandles.slice(-60), (candles1H || currentCandles).slice(-60));
    const wyckoff         = detectWyckoffPhase(currentCandles.slice(-55));
    const breakers        = detectBreakerBlocks(currentCandles.slice(-40));
    const equalHL         = detectEqualHighsLows(currentCandles.slice(-60));
    const pdZone          = checkPremiumDiscount(currentCandles.slice(-60), direction);
    const williamsR       = calculateWilliamsR(currentCandles.slice(-20));
    const ichimoku        = calculateIchimoku(currentCandles.slice(-60));
    const heikinAshi      = getHeikinAshiTrend(currentCandles.slice(-15));
    const cvd             = approximateCVD(currentCandles.slice(-30));
    const pivots          = calculatePivotPoints(candlesDaily);
    const pivotSignal     = getPivotSignal(currentPrice, pivots, direction);
    const fibConf         = checkFibConfluence(currentCandles.slice(-60), direction);

    // ── 4b. 5m Sniper Layer ───────────────────────────────────
    // ✅ FIX: Only use 5m candles if we have enough (30+), else skip 5m layer
    const safe5m       = candles5m?.length >= 30 ? candles5m : null;
    // ✅ FIX: null-safe 5m layer — if insufficient 5m candles, use 15m as fallback
    const _5m = safe5m || currentCandles;
    const ob5m         = detectMTFOBs(_5m.slice(-20));
    const choch5m      = safe5m ? smc.checkChoCH(safe5m.slice(-30)) : "None";
    const sweep5m      = safe5m ? smc.checkLiquiditySweep(safe5m.slice(-20)) : "None";
    const fvg5m        = scanFairValueGaps(_5m.slice(-60));
    const smc5m        = safe5m ? smc.analyzeSMC(safe5m.slice(-50)) : smc.analyzeSMC(currentCandles.slice(-50));
    const ema21_5m     = parseFloat(indicators.calculateEMA(_5m.slice(-30), 21));
    const price5mClose = safe5m?.length > 0 ? parseFloat(safe5m[safe5m.length-1][4]) : currentPrice;
    const trend5m      = price5mClose > ema21_5m ? 'Bullish 🟢' : 'Bearish 🔴';

    // ── 4c. HTF OBs — declared above before confirmEntry5m ────

    // ── v6 Big Profit ─────────────────────────────────────────
    const bbSqueeze    = detectBBSqueezeExplosion(currentCandles.slice(-60));
    const volExpansion = detectVolatilityExpansion(currentCandles.slice(-70));
    const mmTrap       = detectMarketMakerTrap(currentCandles.slice(-25));
    const weeklyTgts   = getWeeklyMonthlyTargets(candlesDaily, direction, currentPrice);
    const cmeGap       = detectCMEGap(candlesDaily, currentPrice);
    const tf3Align     = check3TFAlignment(trend5m, mainTrend, trend1H);
    const dailyClose   = candlesDaily?.length >= 2 ? parseFloat(candlesDaily[candlesDaily.length-1][4]) : currentPrice;
    const dailyEma50   = candlesDaily?.length >= 50 ? parseFloat(indicators.calculateEMA(candlesDaily, 50)) : null;
    const dailyTrend   = dailyEma50 ? (dailyClose > dailyEma50 ? 'Bullish 🟢' : 'Bearish 🔴') : 'Unknown ⚪';
    const dailyAligned = dailyTrend !== 'Unknown ⚪' && ((direction === 'LONG' && dailyTrend.includes('Bullish')) || (direction === 'SHORT' && dailyTrend.includes('Bearish')));
    // Daily trend penalty — trading against daily = lower score
    // Daily penalty applied after longScore declared below

    // ── v7 PRO VVIP ───────────────────────────────────────────
    const gannAngles    = calculateGannAngles(currentCandles.slice(-60));
    const renko         = calculateRenko(currentCandles.slice(-80));
    const moonCycle     = getMoonCycle();
    const dynamicSR     = getDynamicSR(currentCandles.slice(-60));
    const bos           = detectBOS(currentCandles.slice(-30));
    const advCandles    = scanAdvancedCandlePatterns(currentCandles.slice(-5));
    const fibLevels     = getFibonacciLevels(currentCandles.slice(-100), direction);
    const mfi           = calculateMFI(currentCandles.slice(-20));
    const roc           = calculateROC(currentCandles.slice(-20));
    const cci           = calculateCCI(currentCandles.slice(-25));
    const momentumShift = detectMomentumShift(currentCandles.slice(-40));

    // ── MTF Trade Classification ──────────────────────────────
    const tradeCategory = classifyTrade({ currentPrice, direction, ob4H, ob1H, ob15m, ob5m, choch5m, choch15m, sweep5m, sweep15m });

    // ── 5. Entry & Order Types ────────────────────────────────
    const vwapMatch    = vwap.match(/\$([0-9.]+)/);
    const vwapPrice    = vwapMatch ? parseFloat(vwapMatch[1]) : 0;
    const obForDir     = direction === 'LONG' ? marketSMC.bullishOB : marketSMC.bearishOB;
    const bestEntry    = smc.selectBestEntry(priceStr, obForDir, marketSMC.fib618, poc, vwapPrice, direction, atrVal, harmonicPattern);
    const entryValidation = validateEntryPoint(bestEntry.price, currentPrice, direction);
    // ✅ FIX: confirmation declared BEFORE entryQuality (was causing TDZ crash)
    const confirmation    = smc.checkOBConfirmation(currentCandles.slice(-5), obForDir, direction);
    const entryQuality = getEntryQualityGate(currentPrice, mtfFibEntry, obForDir, direction, confirmation, 0);
    const orderSuggestion = smc.getOrderTypeSuggestion(bestEntry.price, currentPrice, direction);

    // ── 🎯 DEEP ENTRY DECISION ENGINE ────────────────────────────
    // Replaces simplistic distance-only order suggestion with a full
    // multi-TF, multi-indicator confluence-weighted entry decision.
    const deepEntry = smc.getDeepEntryDecision({
        currentPrice, direction, atrVal: atrVal, timeframe,
        obForDir,
        fib618:     marketSMC.fib618,
        fib786:     marketSMC.fib786,
        poc, vwapPrice,
        ob4H, ob1H, ob15m, mtfOB,
        mtfFibEntry, fibLevels,
        dynamicSR, pivots, volNodes, equalHL,
        ichimoku, bbands, supertrend, breakers,
        fvgData,
        confirmation, entryQuality,
    });

    // ── 6. Smart SL / TP ─────────────────────────────────────
    const entryPrice  = parseFloat(bestEntry.price);
    const smartSLData = calculateSmartSL(entryPrice, direction, currentCandles.slice(-30), obForDir, atrVal);
    const sl          = parseFloat(smartSLData.sl);
    const slLabel     = smartSLData.slLabel;
    const smartTPData = calculateSmartTPs(entryPrice, sl, direction, currentCandles.slice(-50));
    const tp1 = parseFloat(smartTPData.tp1), tp2 = parseFloat(smartTPData.tp2), tp3 = parseFloat(smartTPData.tp3);

    // ✅ SL-BLOWN PROTECTION — price already beyond SL = instant loss if market order
    if (direction === 'LONG' && currentPrice < sl) {
        orderSuggestion.type   = '⛔ SKIP — Price Below SL';
        orderSuggestion.reason = 'Market is BELOW SL. Market order = instant loss. Wait for SL zone retest.';
    } else if (direction === 'SHORT' && currentPrice > sl) {
        orderSuggestion.type   = '⛔ SKIP — Price Above SL';
        orderSuggestion.reason = 'Market is ABOVE SL. Market order = instant loss. Wait for SL zone retest.';
    }

    const refined = refineTradeParameters({
        entry: entryPrice, sl, slLabel,
        tp1, tp1Label: smartTPData.tp1Label, tp2, tp2Label: smartTPData.tp2Label, tp3, tp3Label: smartTPData.tp3Label,
        direction, atrVal, currentPrice,
        ichimoku, supertrend, wyckoff, pivots, equalHL, breakers, fibConf,
        mtfOB, fvgData, volNodes, bbands, rvol, adxData, session,
        weeklyTgts, cmeGap, heikinAshi,
        dynamicSR, fibLevels, mfi, williamsR, advCandles, gannAngles, bos,
    });

    // ══════════════════════════════════════════════════════════
    //  🤖 AI MODEL CALL (HIGHEST PRIORITY — runs before scoring)
    //  Gated by config.modules.AI_MODEL
    // ══════════════════════════════════════════════════════════
    let aiRaw    = null;
    let future   = _buildFuture(null, direction);  // default = offline/neutral

    try {
        aiRaw  = await _callAIModel(coin, currentCandles);
        future = _buildFuture(aiRaw, direction);
    } catch (err) {
        console.warn(`[analyzer] AI future build failed: ${err.message}`);
    }

    // ══════════════════════════════════════════════════════════
    //  7. 14-FACTOR + 5m SNIPER SCORING SYSTEM
    //
    //  🚫 AI BLOCK GATE — checked BEFORE accumulating any score.
    //     If future.blockTrade = true, the trade is immediately
    //     flagged as blocked. Score is still calculated for display,
    //     but future.blockTrade = true tells future.js to reject entry.
    // ══════════════════════════════════════════════════════════

    let longScore = 0, shortScore = 0, longR = [], shortR = [];
    const smcEnabled = config.modules.SMC;

    // ─── Trend confluence ─────────────────────────────────────
    if (trend4H.includes('Bullish') && trend1H.includes('Bullish'))  { longScore  += w(1, weights.trend); longR.push('MTF Bull'); }
    if (trend4H.includes('Bearish') && trend1H.includes('Bearish'))  { shortScore += w(1, weights.trend); shortR.push('MTF Bear'); }
    if (currentPrice > ema200 && Math.abs(currentPrice-ema50)/ema50 < 0.003) { longScore  += w(1, weights.trend); longR.push('EMA Pullback'); }
    if (currentPrice < ema200 && Math.abs(currentPrice-ema50)/ema50 < 0.003) { shortScore += w(1, weights.trend); shortR.push('EMA Pullback'); }

    // ─── SMC Order Blocks ─────────────────────────────────────
    if (smcEnabled) {
        if (marketSMC.bullishOB) { longScore  += w(1, weights.priceAction); longR.push('Bull OB'); }
        if (marketSMC.bearishOB) { shortScore += w(1, weights.priceAction); shortR.push('Bear OB'); }
    }

    // ─── RSI ──────────────────────────────────────────────────
    if (rsi < 45) { longScore  += w(1, weights.oscillator); longR.push('RSI Oversold'); }
    if (rsi > 55) { shortScore += w(1, weights.oscillator); shortR.push('RSI Overbought'); }

    // ─── VWAP ─────────────────────────────────────────────────
    if (vwap.includes('🟢')) { longScore  += w(1, weights.priceAction); longR.push('Above VWAP'); }
    if (vwap.includes('🔴')) { shortScore += w(1, weights.priceAction); shortR.push('Below VWAP'); }

    // ─── Candle Pattern ───────────────────────────────────────
    if (pattern.includes('🟢')) { longScore  += w(1, weights.priceAction); longR.push(pattern.split(' ')[0]); }
    if (pattern.includes('🔴')) { shortScore += w(1, weights.priceAction); shortR.push(pattern.split(' ')[0]); }

    // ─── Volume ───────────────────────────────────────────────
    if (volBreak.includes('Bullish Breakout')) { longScore  += w(1, weights.volume); longR.push('Vol Spike'); }
    if (volBreak.includes('Bearish Breakout')) { shortScore += w(1, weights.volume); shortR.push('Vol Spike'); }

    // ─── Divergence ───────────────────────────────────────────
    if (divergence.includes('Bullish')) { longScore  += w(1, weights.oscillator); longR.push('Regular Bull Div'); }
    if (divergence.includes('Bearish')) { shortScore += w(1, weights.oscillator); shortR.push('Regular Bear Div'); }
    // ✅ Hidden divergence — trend continuation, stronger signal
    if (hiddenDivergence.bull) { longScore  += w(2, weights.oscillator); longR.push('Hidden Bull Div 🔥 (Continuation)'); }
    if (hiddenDivergence.bear) { shortScore += w(2, weights.oscillator); shortR.push('Hidden Bear Div 🔥 (Continuation)'); }
    // ✅ BTC context scoring
    if (coin !== 'BTCUSDT') {
        if (btcContext.trend === 'BULL' && direction === 'LONG')  { longScore  += 3; longR.push('₿ BTC Macro Bullish ✅'); }
        if (btcContext.trend === 'BEAR' && direction === 'SHORT') { shortScore += 3; shortR.push('₿ BTC Macro Bearish ✅'); }
        if (btcContext.trend === 'BULL' && direction === 'SHORT') { shortScore = Math.max(0, shortScore - 5); shortR.push('₿ BTC Conflict SHORT ⚠️'); }
        if (btcContext.trend === 'BEAR' && direction === 'LONG')  { longScore  = Math.max(0, longScore  - 5); longR.push('₿ BTC Conflict LONG ⚠️'); }
    }
    // ✅ MTF Fibonacci entry zone bonus/penalty
    if (mtfFibEntry?.atZone && mtfFibEntry.nearestZone?.strength === 'STRONG') {
        if (direction === 'LONG')  { longScore  += w(3, weights.priceAction); longR.push(`4H Fib OTE Zone 🎯 (${mtfFibEntry.nearestZone.label})`); }
        else                       { shortScore += w(3, weights.priceAction); shortR.push(`4H Fib OTE Zone 🎯 (${mtfFibEntry.nearestZone.label})`); }
    } else if (mtfFibEntry?.zoneBypassed) {
        if (direction === 'LONG')  { longScore  = Math.max(0, longScore  - 8); longR.push('⚠️ Zone Bypassed — Risky Re-entry'); }
        else                       { shortScore = Math.max(0, shortScore - 8); shortR.push('⚠️ Zone Bypassed — Risky Re-entry'); }
    }

    // ─── MACD ─────────────────────────────────────────────────
    if (macd.includes('Bullish')) { longScore  += w(1, weights.trend); longR.push('MACD Bull'); }
    if (macd.includes('Bearish')) { shortScore += w(1, weights.trend); shortR.push('MACD Bear'); }

    // ─── SMC Sweep / ChoCH ────────────────────────────────────
    if (smcEnabled) {
        if (marketSMC.sweep.includes('Bullish') || marketSMC.choch.includes('Bullish')) { longScore  += w(1, weights.priceAction); longR.push('Sweep/ChoCH'); }
        if (marketSMC.sweep.includes('Bearish') || marketSMC.choch.includes('Bearish')) { shortScore += w(1, weights.priceAction); shortR.push('Sweep/ChoCH'); }
    }

    // ─── OB Confirmation ──────────────────────────────────────
    if (confirmation.confirmed) {
        if (direction === 'LONG') { longScore  += w(1, weights.priceAction); longR.push('OB Touch ✅'); }
        else                      { shortScore += w(1, weights.priceAction); shortR.push('OB Touch ✅'); }
    }

    // ─── 5m Alignment ─────────────────────────────────────────
    if (mtf5m.confirmed) {
        if (direction === 'LONG') { longScore  += w(1, weights.trend); longR.push('5m Aligned ✅'); }
        else                      { shortScore += w(1, weights.trend); shortR.push('5m Aligned ✅'); }
    }

    // ─── Harmonic / ICT ───────────────────────────────────────
    if (harmonicPattern.includes('Bullish')) { longScore  += w(1, weights.priceAction); longR.push(harmonicPattern.split(' ')[1]); }
    if (harmonicPattern.includes('Bearish')) { shortScore += w(1, weights.priceAction); shortR.push(harmonicPattern.split(' ')[1]); }
    if (ictSilverBullet.includes('Bullish')) { longScore  += w(1, weights.priceAction); longR.push('ICT Time 🎯'); }
    if (ictSilverBullet.includes('Bearish')) { shortScore += w(1, weights.priceAction); shortR.push('ICT Time 🎯'); }

    // ─── StochRSI ─────────────────────────────────────────────
    if (stochRSI.isBull) { longScore  += w(1, weights.oscillator); longR.push(`StochRSI ${stochRSI.signal}`); }
    if (stochRSI.isBear) { shortScore += w(1, weights.oscillator); shortR.push(`StochRSI ${stochRSI.signal}`); }

    // ─── Bollinger Bands ──────────────────────────────────────
    if (bbands.isBull)  { longScore  += w(1, weights.oscillator); longR.push('BB Lower Zone'); }
    if (bbands.isBear)  { shortScore += w(1, weights.oscillator); shortR.push('BB Upper Zone'); }
    if (bbands.squeeze) { longScore  += w(0.5, weights.volume); shortScore += w(0.5, weights.volume); }

    // ─── MTF OB Confluence ────────────────────────────────────
    if (mtfOB.confluenceZone) {
        if (mtfOB.confluenceZone.type === 'BULLISH') { longScore  += w(2, weights.priceAction); longR.push('MTF OB Confluence 🔥'); }
        if (mtfOB.confluenceZone.type === 'BEARISH') { shortScore += w(2, weights.priceAction); shortR.push('MTF OB Confluence 🔥'); }
    }

    // ─── EMA Ribbon ───────────────────────────────────────────
    if (emaRibbon) {
        if (emaRibbon.signal === 'STRONG_BULL')   { longScore  += w(2, weights.trend); longR.push('EMA Ribbon Bull 🟢🟢'); }
        if (emaRibbon.signal === 'STRONG_BEAR')   { shortScore += w(2, weights.trend); shortR.push('EMA Ribbon Bear 🔴🔴'); }
        if (emaRibbon.signal === 'BULL_PULLBACK') { longScore  += w(1, weights.trend); longR.push('EMA21 Pullback 🟡'); }
        if (emaRibbon.signal === 'BEAR_PULLBACK') { shortScore += w(1, weights.trend); shortR.push('EMA21 Pullback 🟡'); }
    }

    // ─── MTF RSI ──────────────────────────────────────────────
    if (mtfRSI.isBull) { longScore  += w(mtfRSI.signal === 'STRONG_BULL' ? 2 : 1, weights.oscillator); longR.push('MTF RSI Bull'); }
    if (mtfRSI.isBear) { shortScore += w(mtfRSI.signal === 'STRONG_BEAR' ? 2 : 1, weights.oscillator); shortR.push('MTF RSI Bear'); }

    // ─── HVN ──────────────────────────────────────────────────
    if (volNodes.nearHVN) {
        if (direction === 'LONG') { longScore  += w(1, weights.volume); longR.push('HVN Zone 🔥'); }
        else                      { shortScore += w(1, weights.volume); shortR.push('HVN Zone 🔥'); }
    }

    // ─── Session Quality ──────────────────────────────────────
    if (session.isBestSession) {
        if (direction === 'LONG') { longScore  += w(0.5, weights.priceAction); longR.push(`${session.emoji} ${session.session}`); }
        else                      { shortScore += w(0.5, weights.priceAction); shortR.push(`${session.emoji} ${session.session}`); }
    }

    // ─── Candle Close Conf ────────────────────────────────────
    if (candleConf.confirmed) {
        if (direction === 'LONG') { longScore  += w(1, weights.priceAction); longR.push('Candle Close ✅'); }
        else                      { shortScore += w(1, weights.priceAction); shortR.push('Candle Close ✅'); }
    }

    // ─── SMC Liquidity Sweep + ChoCH (primary TF) ────────────
    if (smcEnabled) {
        if (liquiditySweep.includes('Bullish')) { longScore  += w(2, weights.priceAction); longR.push('Liq Sweep 🟢'); }
        if (liquiditySweep.includes('Bearish')) { shortScore += w(2, weights.priceAction); shortR.push('Liq Sweep 🔴'); }
        if (choch.includes('Bullish'))           { longScore  += w(2, weights.priceAction); longR.push('ChoCH 🔄🟢'); }
        if (choch.includes('Bearish'))           { shortScore += w(2, weights.priceAction); shortR.push('ChoCH 🔄🔴'); }
    }

    // ─── Supertrend ───────────────────────────────────────────
    if (supertrend.justFlipUp)   { longScore  += w(2, weights.trend); longR.push('Supertrend Flip 🟢🟢'); }
    else if (supertrend.isBull)  { longScore  += w(1, weights.trend); longR.push('Supertrend Bull 🟢'); }
    if (supertrend.justFlipDown) { shortScore += w(2, weights.trend); shortR.push('Supertrend Flip 🔴🔴'); }
    else if (supertrend.isBear)  { shortScore += w(1, weights.trend); shortR.push('Supertrend Bear 🔴'); }

    // ─── RVOL ─────────────────────────────────────────────────
    if (rvol.signal === 'EXTREME' || rvol.signal === 'HIGH') {
        longScore += w(0.5, weights.volume); shortScore += w(0.5, weights.volume);
        longR.push('RVOL High 🔥'); shortR.push('RVOL High 🔥');
    }

    // ─── MTF MACD ─────────────────────────────────────────────
    if (mtfMACD.signal === 'STRONG_BULL') { longScore  += w(2, weights.trend); longR.push('MTF MACD Bull 🟢🟢'); }
    if (mtfMACD.signal === 'STRONG_BEAR') { shortScore += w(2, weights.trend); shortR.push('MTF MACD Bear 🔴🔴'); }

    // ─── Extra MTF OBs ────────────────────────────────────────
    if (mtfOBsExtra.bullish && direction === 'LONG')  { longScore  += w(1, weights.priceAction); longR.push('Short OB 🟢'); }
    if (mtfOBsExtra.bearish && direction === 'SHORT') { shortScore += w(1, weights.priceAction); shortR.push('Short OB 🔴'); }

    // ─── v5 World-Class ───────────────────────────────────────
    // Wyckoff
    if (smcEnabled) {
        if      (wyckoff.phase === 'SPRING')       { longScore  += w(3, weights.priceAction); longR.push('Wyckoff Spring 🌱🌱🌱'); }
        else if (wyckoff.phase === 'MARKUP')       { longScore  += w(1, weights.priceAction); longR.push('Wyckoff Markup 📈'); }
        else if (wyckoff.phase === 'ACCUMULATION') { longScore  += w(0.5, weights.priceAction); longR.push('Wyckoff Accum 🔄'); }
        if      (wyckoff.phase === 'UTAD')         { shortScore += w(3, weights.priceAction); shortR.push('Wyckoff UTAD ⚡⚡⚡'); }
        else if (wyckoff.phase === 'MARKDOWN')     { shortScore += w(1, weights.priceAction); shortR.push('Wyckoff Markdown 📉'); }
        else if (wyckoff.phase === 'DISTRIBUTION') { shortScore += w(0.5, weights.priceAction); shortR.push('Wyckoff Dist 🔄'); }
        // Breaker Blocks
        if (breakers.bullishBreaker && direction === 'LONG')  { longScore  += w(2, weights.priceAction); longR.push('Bull Breaker 🔲'); }
        if (breakers.bearishBreaker && direction === 'SHORT') { shortScore += w(2, weights.priceAction); shortR.push('Bear Breaker 🔲'); }
        // EQH/EQL
        if (equalHL.eql && direction === 'LONG')  { longScore  += w(1, weights.priceAction); longR.push('EQL Below 💧'); }
        if (equalHL.eqh && direction === 'SHORT') { shortScore += w(1, weights.priceAction); shortR.push('EQH Above 💧'); }
    }

    // Premium / Discount Zone
    if (pdZone.zone === 'OTE') {
        longScore += w(2, weights.priceAction); shortScore += w(2, weights.priceAction);
        longR.push('OTE Zone 🎯'); shortR.push('OTE Zone 🎯');
    } else if (pdZone.tradeMatch) {
        if (direction === 'LONG') { longScore  += w(1, weights.priceAction); longR.push('Discount Zone 🟢'); }
        else                      { shortScore += w(1, weights.priceAction); shortR.push('Premium Zone 🔴'); }
    } else if (!pdZone.tradeMatch && pdZone.zone !== 'EQUILIBRIUM' && pdZone.zone !== 'UNKNOWN') {
        if (direction === 'LONG')  longScore  = Math.max(0, longScore  - w(1, weights.priceAction));
        if (direction === 'SHORT') shortScore = Math.max(0, shortScore - w(1, weights.priceAction));
    }

    // Fibonacci Confluence
    if (fibConf.hasConfluence) {
        if (direction === 'LONG') { longScore  += w(2, weights.priceAction); longR.push(`Fib Confluence ${fibConf.count}× 🔢`); }
        else                      { shortScore += w(2, weights.priceAction); shortR.push(`Fib Confluence ${fibConf.count}× 🔢`); }
    }

    // Daily Pivot
    if (pivotSignal.isBull) { longScore  += w(1, weights.priceAction); longR.push(`Pivot ${pivotSignal.nearLevel?.name||''} Support 📌`); }
    if (pivotSignal.isBear) { shortScore += w(1, weights.priceAction); shortR.push(`Pivot ${pivotSignal.nearLevel?.name||''} Resist 📌`); }

    // Ichimoku
    if      (ichimoku.signal === 'STRONG_BULL') { longScore  += w(2, weights.trend); longR.push('Ichimoku Bull Cross ☁️🚀'); }
    else if (ichimoku.signal === 'BULL')        { longScore  += w(1, weights.trend); longR.push('Ichimoku Bull ☁️🟢'); }
    else if (ichimoku.signal === 'MILD_BULL')   { longScore  += w(0.5, weights.trend); }
    if      (ichimoku.signal === 'STRONG_BEAR') { shortScore += w(2, weights.trend); shortR.push('Ichimoku Bear Cross ☁️📉'); }
    else if (ichimoku.signal === 'BEAR')        { shortScore += w(1, weights.trend); shortR.push('Ichimoku Bear ☁️🔴'); }
    else if (ichimoku.signal === 'MILD_BEAR')   { shortScore += w(0.5, weights.trend); }
    if (ichimoku.inCloud) { longScore = Math.max(0, longScore - 1); shortScore = Math.max(0, shortScore - 1); }

    // CVD
    if (cvd.bullDiv)          { longScore  += w(2, weights.volume); longR.push('CVD Bull Div 📊🚀'); }
    else if (cvd.trend === 'BULL') { longScore += w(1, weights.volume); longR.push('CVD Rising 📊🟢'); }
    if (cvd.bearDiv)          { shortScore += w(2, weights.volume); shortR.push('CVD Bear Div 📊⚠️'); }
    else if (cvd.trend === 'BEAR') { shortScore += w(1, weights.volume); shortR.push('CVD Falling 📊🔴'); }

    // Heikin Ashi / Williams %R
    if (heikinAshi.isStrong && heikinAshi.isBull) { longScore  += w(1, weights.trend); longR.push(`HA ${heikinAshi.consecutive}× Bull 🕯️`); }
    if (heikinAshi.isStrong && heikinAshi.isBear) { shortScore += w(1, weights.trend); shortR.push(`HA ${heikinAshi.consecutive}× Bear 🕯️`); }
    if (williamsR.isBull) { longScore  += w(1, weights.oscillator); longR.push(`W%R ${williamsR.value} 🟢`); }
    if (williamsR.isBear) { shortScore += w(1, weights.oscillator); shortR.push(`W%R ${williamsR.value} 🔴`); }

    // ─── v6 Big-Profit ────────────────────────────────────────
    if (bbSqueeze.exploding) {
        if (bbSqueeze.explosionDir === 'BULL') { longScore  += w(3, weights.volume); longR.push('BB Explosion 💥🟢'); }
        else                                   { shortScore += w(3, weights.volume); shortR.push('BB Explosion 💥🔴'); }
    } else if (bbSqueeze.isSqueezing && bbSqueeze.squeezeDuration >= 3) {
        longScore += w(1, weights.volume); shortScore += w(1, weights.volume);
        longR.push('BB Squeeze ⚡'); shortR.push('BB Squeeze ⚡');
    }
    if (volExpansion.justStarted) {
        if (direction === 'LONG') { longScore  += w(3, weights.trend); longR.push('Trend Start! ADX⚡'); }
        else                      { shortScore += w(3, weights.trend); shortR.push('Trend Start! ADX⚡'); }
    } else if (volExpansion.expanding) {
        if (direction === 'LONG') { longScore  += w(1, weights.trend); longR.push('Volatility Expanding 📈'); }
        else                      { shortScore += w(1, weights.trend); shortR.push('Volatility Expanding 📉'); }
    }
    if (mmTrap.bearTrap && direction === 'LONG')  { longScore  += w(3, weights.priceAction); longR.push('Bear Trap! LONG 🪤'); }
    if (mmTrap.bullTrap && direction === 'SHORT') { shortScore += w(3, weights.priceAction); shortR.push('Bull Trap! SHORT 🪤'); }
    if (tf3Align.aligned) {
        if (tf3Align.allBull) { longScore  += w(2, weights.trend); longR.push('3TF Aligned 🟢🟢🟢'); }
        if (tf3Align.allBear) { shortScore += w(2, weights.trend); shortR.push('3TF Aligned 🔴🔴🔴'); }
    }
    if (dailyAligned) {
        if (direction === 'LONG') { longScore  += w(2, weights.trend); longR.push('Daily Trend ✅'); }
        else                      { shortScore += w(2, weights.trend); shortR.push('Daily Trend ✅'); }
    } else if (dailyTrend !== 'Unknown ⚪') {
        // Against daily trend = heavy penalty (was -2, now -5 to make it meaningful)
        if (direction === 'LONG')  longScore  = Math.max(0, longScore  - 5);
        if (direction === 'SHORT') shortScore = Math.max(0, shortScore - 5);
        if (direction === 'LONG')  longR.push('⚠️ Against Daily Trend');
        if (direction === 'SHORT') shortR.push('⚠️ Against Daily Trend');
    }
    if (cmeGap.hasGap && !cmeGap.filled) {
        const gapDir = cmeGap.gapAbove ? 'LONG' : 'SHORT';
        if (gapDir === direction) {
            if (direction === 'LONG') { longScore  += w(1, weights.priceAction); longR.push('CME Gap Target 🎯'); }
            else                      { shortScore += w(1, weights.priceAction); shortR.push('CME Gap Target 🎯'); }
        }
    }
    if (weeklyTgts?.nearTarget) {
        const tpDist = Math.abs(tp2 - currentPrice) / currentPrice;
        const wkDist = Math.abs(weeklyTgts.nearTarget - currentPrice) / currentPrice;
        if (wkDist <= tpDist * 1.5) {
            if (direction === 'LONG') { longScore  += w(1, weights.priceAction); longR.push('Weekly Level TP 🗓️'); }
            else                      { shortScore += w(1, weights.priceAction); shortR.push('Weekly Level TP 🗓️'); }
        }
    }

    // ─── v7 PRO VVIP ──────────────────────────────────────────
    if (gannAngles.signal === 'STRONG_BULL') { longScore  += w(2, weights.trend); longR.push('Gann Strong Bull 📐🟢'); }
    else if (gannAngles.isBull)              { longScore  += w(1, weights.trend); longR.push('Gann Bull 📐'); }
    if (gannAngles.signal === 'STRONG_BEAR') { shortScore += w(2, weights.trend); shortR.push('Gann Strong Bear 📐🔴'); }
    else if (gannAngles.isBear)              { shortScore += w(1, weights.trend); shortR.push('Gann Bear 📐'); }
    if (renko.reversal && renko.isBull)          { longScore  += w(3, weights.trend); longR.push('Renko Bull Reversal 🧱🚀'); }
    else if (renko.isBull && renko.streak >= 3)  { longScore  += w(1, weights.trend); longR.push(`Renko ${renko.streak}× Bull 🧱`); }
    if (renko.reversal && renko.isBear)          { shortScore += w(3, weights.trend); shortR.push('Renko Bear Reversal 🧱📉'); }
    else if (renko.isBear && renko.streak >= 3)  { shortScore += w(1, weights.trend); shortR.push(`Renko ${renko.streak}× Bear 🧱`); }
    if (moonCycle.isBull && direction === 'LONG')   { longScore  += w(0.5, weights.priceAction); longR.push(`${moonCycle.emoji} Moon Bull`); }
    if (moonCycle.isBear && direction === 'SHORT')  { shortScore += w(0.5, weights.priceAction); shortR.push(`${moonCycle.emoji} Moon Bear`); }
    if (moonCycle.isFullMoon && direction === 'LONG') longScore = Math.max(0, longScore - 0.5);
    if (dynamicSR.nearSupport && direction === 'LONG')  { longScore  += w(1, weights.priceAction); longR.push('Dynamic Support 📊'); }
    if (dynamicSR.nearResist  && direction === 'SHORT') { shortScore += w(1, weights.priceAction); shortR.push('Dynamic Resist 📊'); }
    if (dynamicSR.nearResist  && direction === 'LONG')  longScore  = Math.max(0, longScore  - w(1, weights.priceAction));
    if (dynamicSR.nearSupport && direction === 'SHORT') shortScore = Math.max(0, shortScore - w(1, weights.priceAction));
    if (smcEnabled) {
        if (bos.bullBOS) { longScore  += w(2, weights.priceAction); longR.push('Bull BOS 🔺'); }
        if (bos.bearBOS) { shortScore += w(2, weights.priceAction); shortR.push('Bear BOS 🔻'); }
    }
    if (advCandles.isBull) {
        const pts = ['Morning Star','Three White Soldiers','Dragonfly Doji'].some(p => advCandles.pattern?.includes(p)) ? 2 : 1;
        longScore  += w(pts, weights.priceAction); longR.push(`${advCandles.pattern} 🕯️`);
    }
    if (advCandles.isBear) {
        const pts = ['Evening Star','Three Black Crows','Gravestone Doji'].some(p => advCandles.pattern?.includes(p)) ? 2 : 1;
        shortScore += w(pts, weights.priceAction); shortR.push(`${advCandles.pattern} 🕯️`);
    }
    if (fibLevels.isAtOTE) {
        if (direction === 'LONG') { longScore  += w(2, weights.priceAction); longR.push('At OTE Fib Zone 🎯'); }
        else                      { shortScore += w(2, weights.priceAction); shortR.push('At OTE Fib Zone 🎯'); }
    }
    if (mfi.value < 20 && mfi.isBull) { longScore  += w(2, weights.oscillator); longR.push('MFI Oversold 💰🟢'); }
    else if (mfi.isBull)              { longScore  += w(1, weights.oscillator); longR.push('MFI Bull 💰'); }
    if (mfi.value > 80 && mfi.isBear) { shortScore += w(2, weights.oscillator); shortR.push('MFI Overbought 💰🔴'); }
    else if (mfi.isBear)              { shortScore += w(1, weights.oscillator); shortR.push('MFI Bear 💰'); }
    if (roc.isBull && roc.value > 0)          { longScore  += w(1, weights.trend); longR.push(`ROC +${roc.value.toFixed(1)}% ⚡`); }
    if (roc.isBear && roc.value < 0)          { shortScore += w(1, weights.trend); shortR.push(`ROC ${roc.value.toFixed(1)}% ⚡`); }
    if (roc.signal?.includes('Bullish Cross')) { longScore  += w(1, weights.trend); longR.push('ROC Zero Cross 🟢'); }
    if (roc.signal?.includes('Bearish Cross')) { shortScore += w(1, weights.trend); shortR.push('ROC Zero Cross 🔴'); }
    if (cci.value < -200)      { longScore  += w(2, weights.oscillator); longR.push('CCI Extreme Oversold 📊🟢🟢'); }
    else if (cci.value < -100) { longScore  += w(1, weights.oscillator); longR.push('CCI Oversold 📊🟢'); }
    else if (cci.isBull)       { longScore  += w(0.5, weights.oscillator); }
    if (cci.value > 200)       { shortScore += w(2, weights.oscillator); shortR.push('CCI Extreme Overbought 📊🔴🔴'); }
    else if (cci.value > 100)  { shortScore += w(1, weights.oscillator); shortR.push('CCI Overbought 📊🔴'); }
    else if (cci.isBear)       { shortScore += w(0.5, weights.oscillator); }
    if (momentumShift.isBull) { const pts = momentumShift.bullSignals >= 6 ? 3 : momentumShift.bullSignals >= 5 ? 2 : 1; longScore  += w(pts, weights.oscillator); longR.push(`Momentum BULL ${momentumShift.bullSignals}/6 ⚡🟢`); }

    // ── v8: New Patterns ──────────────────────────────────────────
    // MTF RSI Divergence (stronger than single-TF)
    if (mtfRSIDiv.mtfBull)  { longScore  += w(3, weights.oscillator); longR.push('MTF Bull Divergence 💪🚀'); }
    if (mtfRSIDiv.mtfBear)  { shortScore += w(3, weights.oscillator); shortR.push('MTF Bear Divergence 💪📉'); }
    if (mtfRSIDiv.mtfHBull) { longScore  += w(2, weights.oscillator); longR.push('MTF Hidden Bull Div ↗️'); }
    if (mtfRSIDiv.mtfHBear) { shortScore += w(2, weights.oscillator); shortR.push('MTF Hidden Bear Div ↘️'); }
    else if (mtfRSIDiv.bull  && !mtfRSIDiv.mtfBull)  { longScore  += w(1, weights.oscillator); longR.push('15m Bull Div'); }
    else if (mtfRSIDiv.bear  && !mtfRSIDiv.mtfBear)  { shortScore += w(1, weights.oscillator); shortR.push('15m Bear Div'); }

    // Cypher Pattern (highest accuracy harmonic)
    if (cypherPat.bull)  { longScore  += w(3, weights.priceAction); longR.push('Cypher PRZ 🎯🟢'); }
    if (cypherPat.bear)  { shortScore += w(3, weights.priceAction); shortR.push('Cypher PRZ 🎯🔴'); }

    // ABCD Pattern
    if (abcdPat.bull)    { longScore  += w(2, weights.priceAction); longR.push('ABCD Pattern 🟢'); }
    if (abcdPat.bear)    { shortScore += w(2, weights.priceAction); shortR.push('ABCD Pattern 🔴'); }

    // Head & Shoulders
    if (headShould.bull) { longScore  += w(3, weights.priceAction); longR.push('Inv H&S 🚀'); }
    if (headShould.bear) { shortScore += w(3, weights.priceAction); shortR.push('H&S TOP ⚠️'); }

    // Triangle Pattern
    if (trianglePat.bull)  { longScore  += w(1, weights.priceAction); longR.push(`${trianglePat.display}`); }
    if (trianglePat.bear)  { shortScore += w(1, weights.priceAction); shortR.push(`${trianglePat.display}`); }

    // Three Drives
    if (threeDrives.bull)  { longScore  += w(2, weights.priceAction); longR.push('Three Drives BOTTOM 🚀'); }
    if (threeDrives.bear)  { shortScore += w(2, weights.priceAction); shortR.push('Three Drives TOP ⚠️'); }

    // Fibonacci Time Zone
    if (fibTimeZone.atZone) {
        longScore  += w(0.5, weights.priceAction);
        shortScore += w(0.5, weights.priceAction);
        longR.push(`⏱️ FibTime ${fibTimeZone.zoneNum}`);
    }
    if (momentumShift.isBear) { const pts = momentumShift.bearSignals >= 6 ? 3 : momentumShift.bearSignals >= 5 ? 2 : 1; shortScore += w(pts, weights.oscillator); shortR.push(`Momentum BEAR ${momentumShift.bearSignals}/6 ⚡🔴`); }

    // ─── 5m Sniper Layer ──────────────────────────────────────
    if (smcEnabled) {
        if (choch5m.includes('Bullish')) { longScore  += w(2, weights.priceAction); longR.push('5m ChoCH 🔄🟢⚡'); }
        if (choch5m.includes('Bearish')) { shortScore += w(2, weights.priceAction); shortR.push('5m ChoCH 🔄🔴⚡'); }
        if (sweep5m.includes('Bullish')) { longScore  += w(2, weights.priceAction); longR.push('5m Liq Sweep 🟢⚡'); }
        if (sweep5m.includes('Bearish')) { shortScore += w(2, weights.priceAction); shortR.push('5m Liq Sweep 🔴⚡'); }
        if (ob5m.bullish && direction === 'LONG')  { longScore  += w(1, weights.priceAction); longR.push('5m OB 🟢'); }
        if (ob5m.bearish && direction === 'SHORT') { shortScore += w(1, weights.priceAction); shortR.push('5m OB 🔴'); }
    }
    if (trend5m.includes('Bullish') && direction === 'LONG')  { longScore  += w(0.5, weights.trend); longR.push('5m EMA Trend 🟢'); }
    if (trend5m.includes('Bearish') && direction === 'SHORT') { shortScore += w(0.5, weights.trend); shortR.push('5m EMA Trend 🔴'); }
    if (tradeCategory.label.includes('SWING')) {
        if (direction === 'LONG') { longScore  += w(1, weights.priceAction); longR.push('4H OB Sniper 📅'); }
        else                      { shortScore += w(1, weights.priceAction); shortR.push('4H OB Sniper 📅'); }
    }
    if (tradeCategory.label.includes('SCALP')) {
        if (direction === 'LONG') { longScore  += w(1, weights.priceAction); longR.push('15m OB Scalp ⚡'); }
        else                      { shortScore += w(1, weights.priceAction); shortR.push('15m OB Scalp ⚡'); }
    }

    // ══════════════════════════════════════════════════════════
    //  🐳 BYBIT CROSS-EXCHANGE CONFLUENCE (config-gated)
    // ══════════════════════════════════════════════════════════
    let bybitResult = { modifier: 0, regime: 'BYBIT_DISABLED', reasons: [], available: false };

    if (config.modules.BYBIT) {
        try {
            const smartDir0 = longScore >= shortScore ? 'LONG' : 'SHORT';
            bybitResult = await getBybitConfluence(coin, smartDir0);
            if (bybitResult.modifier !== 0) {
                if (smartDir0 === 'LONG') {
                    longScore += bybitResult.modifier;
                    if (bybitResult.modifier > 0) longR.push(`Bybit Confluence ${bybitResult.regime}`);
                    else                           longR.push(`Bybit Warning ${bybitResult.regime}`);
                } else {
                    shortScore += bybitResult.modifier;
                    if (bybitResult.modifier > 0) shortR.push(`Bybit Confluence ${bybitResult.regime}`);
                    else                           shortR.push(`Bybit Warning ${bybitResult.regime}`);
                }
            }
        } catch (err) {
            console.warn(`[analyzer] Bybit confluence failed: ${err.message}`);
        }
    }

    // ══════════════════════════════════════════════════════════
    //  🤖 APPLY AI MODIFIER (HIGHEST PRIORITY — added last)
    //  The `future` object was built before scoring started.
    //  Now we apply its modifier and annotate reasons.
    // ══════════════════════════════════════════════════════════
    if (future.available && future.modifier !== 0) {
        const smartDir1 = longScore >= shortScore ? 'LONG' : 'SHORT';
        if (smartDir1 === 'LONG') {
            longScore += future.modifier;
            longR.push(future.label);
        } else {
            shortScore += future.modifier;
            shortR.push(future.label);
        }
    }

    // ══════════════════════════════════════════════════════════
    //  8. SMART DIRECTION OVERRIDE + FINAL SCORING
    //  High-Accuracy Gates — target 80-90% Win Rate
    // ══════════════════════════════════════════════════════════

    // ── Gate A: Funding Rate ───────────────────────────────────
    if (fundingRate !== null) {
        if (fundingRate > 0.1)  { longScore  = Math.max(0, longScore  - 3); longR.push(`⚠️ High Funding ${fundingRate.toFixed(3)}%`); }
        if (fundingRate > 0.2)  { longScore  = Math.max(0, longScore  - 5); }
        if (fundingRate < -0.1) { shortScore = Math.max(0, shortScore - 3); shortR.push(`⚠️ Neg Funding ${fundingRate.toFixed(3)}%`); }
        if (fundingRate < -0.2) { shortScore = Math.max(0, shortScore - 5); }
        if (fundingRate > 0.15 && direction === 'SHORT') { shortScore += w(2, weights.priceAction); shortR.push('Funding Squeeze SHORT 🔥'); }
        if (fundingRate < -0.15 && direction === 'LONG')  { longScore  += w(2, weights.priceAction); longR.push('Funding Squeeze LONG 🔥'); }
    }

    // ── Gate B: Hurst + Choppiness — block breakout signals in choppy market ──
    const isHurstChoppy = dynResult && (dynResult.isChoppy || dynResult.chop > 61.8);
    if (isHurstChoppy) {
        longScore  = Math.max(0, longScore  - 6);
        shortScore = Math.max(0, shortScore - 6);
        longR.push('⚠️ CHOP MARKET — Breakout signals filtered (CHOP=' + (dynResult?.chop?.toFixed(1)||'?') + ' H=' + (dynResult?.hurst?.toFixed(2)||'?') + ')');
        shortR.push('⚠️ CHOP MARKET — Breakout signals filtered');
    } else if (dynResult?.isTrending) {
        longScore  += w(1.5, weights.trend);
        shortScore += w(1.5, weights.trend);
        longR.push('✅ Trend Confirmed (Hurst=' + (dynResult?.hurst?.toFixed(2)||'?') + ')');
    }

    // ── Gate C: Strict MTF Alignment (5m + 1H + 4H + Daily) ──────────────
    const testDir = longScore >= shortScore ? 'LONG' : 'SHORT';
    const mtfAligned5m    = testDir === 'LONG' ? trend5m.includes('Bullish')    : trend5m.includes('Bearish');
    const mtfAligned1H    = testDir === 'LONG' ? trend1H.includes('Bullish')    : trend1H.includes('Bearish');
    const mtfAligned4H    = testDir === 'LONG' ? trend4H.includes('Bullish')    : trend4H.includes('Bearish');
    const mtfAlignedDaily = dailyAligned;
    const mtfAlignCount   = [mtfAligned5m, mtfAligned1H, mtfAligned4H, mtfAlignedDaily].filter(Boolean).length;

    if (mtfAlignCount === 4) {
        if (testDir === 'LONG') { longScore  += 5; longR.push('🎯 PERFECT MTF 5m+1H+4H+D ✅✅✅'); }
        else                    { shortScore += 5; shortR.push('🎯 PERFECT MTF 5m+1H+4H+D ✅✅✅'); }
    } else if (mtfAlignCount === 3) {
        if (testDir === 'LONG') { longScore  += 2; longR.push('✅ MTF 3/4 Aligned'); }
        else                    { shortScore += 2; shortR.push('✅ MTF 3/4 Aligned'); }
    } else if (mtfAlignCount <= 1) {
        if (testDir === 'LONG') { longScore  = Math.max(0, longScore  - 10); longR.push('⛔ MTF CONFLICT — Only ' + mtfAlignCount + '/4 aligned'); }
        else                    { shortScore = Math.max(0, shortScore - 10); shortR.push('⛔ MTF CONFLICT — Only ' + mtfAlignCount + '/4 aligned'); }
    }

    // ── Gate D: CVD vs Price — OBI Spoof Detection ────────────────────────
    if (cvd && typeof cvd.trend === 'string') {
        const prevClose4   = parseFloat(currentCandles[currentCandles.length - 4]?.[4] || currentPrice);
        const priceRising  = currentPrice > prevClose4;
        const priceFalling = currentPrice < prevClose4;
        const cvdFalling   = cvd.trend === 'BEAR' || cvd.bearDiv;
        const cvdRising    = cvd.trend === 'BULL' || cvd.bullDiv;
        if      (priceRising  && cvdFalling) { longScore  = Math.max(0, longScore  - 4); longR.push('⚠️ BULL TRAP — CVD diverging 🐻'); }
        else if (priceFalling && cvdRising)  { shortScore = Math.max(0, shortScore - 4); shortR.push('⚠️ BEAR TRAP — CVD diverging 🐂'); }
        else if (priceRising  && cvdRising)  { longScore  += w(2, weights.volume); longR.push('✅ CVD Confirms buy pressure 🟢'); }
        else if (priceFalling && cvdFalling) { shortScore += w(2, weights.volume); shortR.push('✅ CVD Confirms sell pressure 🔴'); }
    }

    const smartDir      = longScore >= shortScore ? 'LONG' : 'SHORT';
    const scoreDiff     = Math.abs(longScore - shortScore);
    const bestDirection = scoreDiff >= 5 ? smartDir : direction;
    const rawBestScore  = bestDirection === 'LONG' ? Math.floor(longScore) : Math.floor(shortScore);

    // ── Score Normalization ────────────────────────────────────
    // Theoretical max with all weights can exceed 100. Normalize to 0-100.
    const RAW_MAX_POSSIBLE = 75; // realistic empirical max (measured from scoring branches)
    const bestScore = Math.min(100, Math.round((rawBestScore / RAW_MAX_POSSIBLE) * 100));

    // ── Confirmation Checks (must be declared BEFORE gradeConfBonus) ──
    const isL = bestDirection === 'LONG';
    const confChecks = {
        htfAligned:    (trend1H.includes('Bullish') && trend4H.includes('Bullish')) || (trend1H.includes('Bearish') && trend4H.includes('Bearish')),
        mtfAlignStrong: mtfAlignCount >= 3,
        chochPrimary:  choch.includes(isL ? 'Bullish' : 'Bearish'),
        sweepPrimary:  liquiditySweep.includes(isL ? 'Bullish' : 'Bearish'),
        choch5mConf:   choch5m.includes(isL ? 'Bullish' : 'Bearish'),
        sweep5mConf:   sweep5m.includes(isL ? 'Bullish' : 'Bearish'),
        volumeConf:    volBreak.includes(isL ? 'Bullish' : 'Bearish') || rvol.signal === 'HIGH' || rvol.signal === 'EXTREME',
        dailyGate:     dailyAligned,
        wyckoffConf:   (isL && (wyckoff.phase === 'SPRING' || wyckoff.phase === 'MARKUP')) || (!isL && (wyckoff.phase === 'UTAD' || wyckoff.phase === 'MARKDOWN')),
        ichimokuConf:  (isL && (ichimoku.signal === 'STRONG_BULL' || ichimoku.signal === 'BULL')) || (!isL && (ichimoku.signal === 'STRONG_BEAR' || ichimoku.signal === 'BEAR')),
        supTrendConf:  (isL && (supertrend.isBull || supertrend.justFlipUp)) || (!isL && (supertrend.isBear || supertrend.justFlipDown)),
        fibZoneConf:   fibConf.hasConfluence,
        bbExplosion:   bbSqueeze.exploding && ((isL && bbSqueeze.explosionDir === 'BULL') || (!isL && bbSqueeze.explosionDir === 'BEAR')),
        mmTrapConf:    (isL && mmTrap.bearTrap) || (!isL && mmTrap.bullTrap),
        bosConf:       isL ? bos.bullBOS : bos.bearBOS,
        renkoConf:     isL ? (renko.isBull && renko.streak >= 2) : (renko.isBear && renko.streak >= 2),
        momentumConf:  isL ? momentumShift.isBull : momentumShift.isBear,
        mfiConf:       isL ? (mfi.isBull && mfi.value < 35) : (mfi.isBear && mfi.value > 65),
        gannConf:      isL ? gannAngles.isBull : gannAngles.isBear,
        advCandleConf: isL ? advCandles.isBull : advCandles.isBear,
        dynamicSRConf: isL ? dynamicSR.nearSupport : dynamicSR.nearResist,
        oteFibConf:    fibLevels.isAtOTE,
        hurstTrend:    dynResult?.isTrending || false,
        chopClear:     !isHurstChoppy,
        cvdConfirm:    isL ? (cvd?.trend === 'BULL' || cvd?.bullDiv) : (cvd?.trend === 'BEAR' || cvd?.bearDiv),
        aiConf:        future.available && future.modifier > 0,
        bybitConf:     bybitResult.available && bybitResult.modifier > 0,
    };
    const confScore = Object.values(confChecks).filter(Boolean).length;
    const confGate  = confScore >= 5;  // 27 checks ගෙන් 5+ required for gate to open

    // ── Signal Grade (A+/A/B/C/D) ────────────────────────────
    // Combines normalized score + confScore + MTF alignment + Hurst
    const gradeConfBonus = confScore >= 15 ? 2 : confScore >= 10 ? 1 : 0;
    const gradeMtfBonus  = mtfAlignCount === 4 ? 2 : mtfAlignCount === 3 ? 1 : 0;
    const gradeHurstBonus = dynResult?.isTrending ? 1 : 0;
    const gradeRaw = bestScore + gradeConfBonus + gradeMtfBonus + gradeHurstBonus;

    let signalGrade, signalGradeEmoji, signalGradeLabel;
    if      (gradeRaw >= 65 && mtfAlignCount >= 3 && confScore >= 10) {
        signalGrade = 'A+'; signalGradeEmoji = '🏆'; signalGradeLabel = 'ELITE SETUP';
    } else if (gradeRaw >= 52 && mtfAlignCount >= 2 && confScore >= 6) {
        signalGrade = 'A';  signalGradeEmoji = '🥇'; signalGradeLabel = 'HIGH QUALITY';
    } else if (gradeRaw >= 38) {
        signalGrade = 'B';  signalGradeEmoji = '🥈'; signalGradeLabel = 'STANDARD';
    } else if (gradeRaw >= 22) {
        signalGrade = 'C';  signalGradeEmoji = '🥉'; signalGradeLabel = 'LOW QUALITY';
    } else {
        signalGrade = 'D';  signalGradeEmoji = '⚠️'; signalGradeLabel = 'AVOID';
    }

    // ── Session Quality Hard Filter ───────────────────────────
    // Asian session (00:00-08:00 UTC): low liquidity = block C/D grades
    const utcHour = new Date().getUTCHours();
    const isAsianSession = utcHour >= 0 && utcHour < 8;
    const sessionBlocked = isAsianSession && (signalGrade === 'C' || signalGrade === 'D');
    const bestReasons   = (bestDirection === 'LONG' ? longR : shortR).join(', ') || 'None';

    // ── Gate E: HTF 1H+4H conflict penalty ────────────────────
    if (!(trend1H.includes('Bullish') && trend4H.includes('Bullish')) &&
        !(trend1H.includes('Bearish') && trend4H.includes('Bearish'))) {
        longScore  = Math.max(0, longScore  - 8);
        shortScore = Math.max(0, shortScore - 8);
        longR.push('⚠️ HTF Conflict (1H vs 4H)');
        shortR.push('⚠️ HTF Conflict (1H vs 4H)');
    }

    // ── 9. Return Master Object ───────────────────────────────
    return {
        // ── Core ──
        priceStr, currentPrice, currentCandles,
        direction, mainTrend, trend1H, trend4H, marketState, isTrueChoppy,
        adxData, rsi, vwap, macd, harmonicPattern, ictSilverBullet,
        marketSMC, mtf5m,

        // ── Entry / Order Management ──
        bestEntry, confirmation, orderSuggestion,
        entryQuality, mtfFibEntry, hiddenDivergence, btcContext,
        deepEntry,
        entryPrice: refined.entry, sl: refined.sl, slLabel: refined.slLabel || 'ATR',
        tp1: refined.tp1, tp1Label: refined.tp1Label,
        tp2: refined.tp2, tp2Label: refined.tp2Label,
        tp3: refined.tp3, tp3Label: refined.tp3Label,
        refinements: refined.refinements, refinementNote: refined.refinementNote, wasRefined: refined.wasRefined,

        // ── v4 ──
        stochRSI, bbands, mtfOB, mtfOBsExtra,
        liquiditySweep, choch, entryValidation,

        // ── Scoring ──
        score: bestScore, maxScore: 100, rawScore: rawBestScore, reasons: bestReasons,
        signalGrade, signalGradeEmoji, signalGradeLabel, gradeRaw,
        mtfAlignCount, sessionBlocked, isAsianSession,
        direction: bestDirection, emaDirection: direction,
        longScore: Math.floor(longScore), shortScore: Math.floor(shortScore),

        // ── Confirmation Gate ──
        confScore, confGate, confChecks,

        // ── v4 confirmation ──
        mtfRSI, volNodes, session, candleConf,
        keyLevels, emaRibbon, fvgData, supertrend, rvol, mtfMACD,

        // ── v5 world-class ──
        wyckoff, breakers, equalHL, pdZone,
        williamsR, ichimoku, heikinAshi, cvd,
        pivots, pivotSignal, fibConf,

        // ── 5m Sniper ──
        tradeCategory,
        ob5m, choch5m, sweep5m, fvg5m, smc5m, trend5m, ema21_5m,
        ob4H, ob1H, ob15m, choch15m, sweep15m,

        // ── v6 BIG-PROFIT ──
        bbSqueeze, volExpansion, mmTrap,
        weeklyTgts, cmeGap, tf3Align, dailyTrend, dailyAligned, fundingRate,

        // ── v7 PRO VVIP ──
        gannAngles, renko, moonCycle, dynamicSR,
        bos, advCandles, fibLevels, mfi, roc, cci, momentumShift,
        hiddenDivergence, btcContext, mtfFibEntry, entryQuality,
        // 🆕 v8 patterns
        mtfRSIDiv, cypherPat, abcdPat, headShould, trianglePat, threeDrives, fibTimeZone,

        // ── 🧠 DYNAMIC WEIGHTS (new) ──
        weights,
        dynRegime: dynResult ? {
            trendRegime: dynResult.trendRegime, volRegime: dynResult.volRegime,
            adx: dynResult.adx, atrPct: dynResult.atrPct, regimeLabel: dynResult.regimeLabel,
            hurst: dynResult.hurst, chop: dynResult.chop,
            isChoppy: dynResult.isChoppy, isTrending: dynResult.isTrending,
        } : { trendRegime: 'neutral', volRegime: 'normal', adx: 0, atrPct: 0, regimeLabel: 'DISABLED', hurst: 0.5, chop: 50, isChoppy: false, isTrending: false },

        // ── 🐳 BYBIT (new) ──
        bybitResult: { modifier: bybitResult.modifier, regime: bybitResult.regime, reasons: bybitResult.reasons, available: bybitResult.available },

        // ── 🤖 FUTURE OBJECT (new — HIGHEST PRIORITY) ─────────
        // future.blockTrade = true means AI vetoed the trade.
        // Consumed by future.js to refuse entry or show warning.
        future,
    };
}

module.exports = { run14FactorAnalysis };
