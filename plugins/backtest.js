/**
 * ═══════════════════════════════════════════════════════════════
 *  APEX-MD  ·  backtest.js  ·  v6 FULL-SPECTRUM Backtest Engine
 *  ─────────────────────────────────────────────────────────────
 *  Uses ALL 70+ indicators identical to live analyzer:
 *  v4: StochRSI, BB, MTF OB, EMA Ribbon, FVG, Supertrend, RVOL, MTF MACD
 *  v5: Wyckoff, Breakers, EQH/EQL, Premium/Discount, Williams %R,
 *      Ichimoku, CVD, Pivot Points, Fib Confluence, Heikin Ashi
 *  v6: BB Explosion, Trend Start, MM Trap, 3TF Align, Daily Gate
 * ═══════════════════════════════════════════════════════════════
 */
'use strict';

const { cmd }    = require('../lib/commands');
const config     = require('../config');
const binance    = require('../lib/binance');
const indicators = require('../lib/indicators');
const smc        = require('../lib/smartmoney');

// ─── ALL INDICATORS ──────────────────────────────────────────
const {
    calculateRSI, calculateEMA, calculateATR, checkDivergence,
    checkCandlePattern, calculateMACD, calculateVWAP, checkVolumeBreakout,
    calculateADX, checkHarmonicPattern, checkICTSilverBullet,
    calculateStochRSI, calculateBollingerBands, detectMTFOrderBlocks,
    detectMTFOBs, checkMTFRSIConfluence, detectVolumeNodes,
    getEMARibbon, calculateSupertrend, calculateRVOL, checkMTFMACD,
    // v5
    detectWyckoffPhase, detectBreakerBlocks, detectEqualHighsLows,
    checkPremiumDiscount, calculateWilliamsR, calculateIchimoku,
    getHeikinAshiTrend, approximateCVD, calculatePivotPoints,
    getPivotSignal, checkFibConfluence,
    // v6
    detectBBSqueezeExplosion, detectVolatilityExpansion, detectMarketMakerTrap,
} = require('../lib/indicators');

// ─── FULL SPECTRUM scoring (mirrors live analyzer) ───────────
function backtestScore(candles, i, candles1H) {
    const slice  = candles.slice(Math.max(0, i - 100), i);
    const slice1H = candles1H ? candles1H.slice(Math.max(0, Math.floor(i / 4) - 60), Math.floor(i / 4)) : slice;
    if (slice.length < 50) return { longScore: 0, shortScore: 0, atr: 0, adx: { value: 0 } };

    const cp    = parseFloat(slice[slice.length - 1][4]);

    // ── Core indicators ──
    const ema200 = parseFloat(calculateEMA(candles.slice(Math.max(0, i - 200), i), 200));
    const ema50  = parseFloat(calculateEMA(slice, 50));
    const rsi    = calculateRSI(slice.slice(-50), 14);
    const atr    = parseFloat(calculateATR(slice.slice(-50), 14));
    const adx    = calculateADX(slice.slice(-50));
    const macd   = calculateMACD(slice.slice(-50));
    const vwap   = calculateVWAP(slice);
    const mSMC   = smc.analyzeSMC(slice.slice(-50));
    const volBrk = checkVolumeBreakout(slice.slice(-50));
    const harm   = checkHarmonicPattern(slice);
    const ict    = checkICTSilverBullet(slice.slice(-10));
    const diverg = checkDivergence(slice.slice(-50));
    const patt   = checkCandlePattern(slice.slice(-10));

    // ── v4 precision ──
    let stoch  = { isBull: false, isBear: false, signal: '' };
    let bb     = { isBull: false, isBear: false, squeeze: false };
    let mtfRSI = { isBull: false, isBear: false, signal: '' };
    let volN   = { nearHVN: false };
    let mtfOB  = { confluenceZone: null };
    let mtfOBe = { bullish: null, bearish: null };
    let liqS   = 'None', choch = 'None';
    let superT = { isBull: false, isBear: false, justFlipUp: false, justFlipDown: false };
    let rvol   = { signal: 'NORMAL' };
    let mtfMac = { signal: '' };
    let emaRib = null;

    try { stoch  = calculateStochRSI(slice.slice(-60)); } catch(e) {}
    try { bb     = calculateBollingerBands(slice.slice(-30)); } catch(e) {}
    try { mtfRSI = checkMTFRSIConfluence(slice.slice(-50), slice1H.slice(-50)); } catch(e) {}
    try { volN   = detectVolumeNodes(slice.slice(-100)); } catch(e) {}
    try { mtfOB  = detectMTFOrderBlocks(slice.slice(-30), slice1H.slice(-20)); } catch(e) {}
    try { mtfOBe = detectMTFOBs(slice.slice(-15)); } catch(e) {}
    try { liqS   = smc.checkLiquiditySweep(slice.slice(-15)); } catch(e) {}
    try { choch  = smc.checkChoCH(slice.slice(-20)); } catch(e) {}
    try { superT = calculateSupertrend(slice.slice(-60)); } catch(e) {}
    try { rvol   = calculateRVOL(slice.slice(-30)); } catch(e) {}
    try { mtfMac = checkMTFMACD(slice.slice(-60), slice1H.slice(-60)); } catch(e) {}
    try { emaRib = getEMARibbon(slice); } catch(e) {}

    // ── v5 world-class ──
    let wyckoff = { phase: 'UNKNOWN' };
    let breakers = { bullishBreaker: false, bearishBreaker: false };
    let equalHL  = { eqh: false, eql: false };
    let pdZone   = { zone: 'EQUILIBRIUM', tradeMatch: false };
    let willR    = { isBull: false, isBear: false };
    let ichi     = { signal: 'NEUTRAL', inCloud: false };
    let ha       = { isStrong: false, isBull: false, isBear: false, consecutive: 0 };
    let cvd      = { bullDiv: false, bearDiv: false, trend: 'NEUTRAL' };
    let pivSig   = { isBull: false, isBear: false };
    let fib      = { hasConfluence: false };

    try { wyckoff  = detectWyckoffPhase(slice.slice(-55)); } catch(e) {}
    try { breakers = detectBreakerBlocks(slice.slice(-40)); } catch(e) {}
    try { equalHL  = detectEqualHighsLows(slice.slice(-60)); } catch(e) {}
    try {
        const dir = cp > ema200 ? 'LONG' : 'SHORT';
        pdZone = checkPremiumDiscount(slice.slice(-60), dir);
    } catch(e) {}
    try { willR   = calculateWilliamsR(slice.slice(-20)); } catch(e) {}
    try { ichi    = calculateIchimoku(slice.slice(-60)); } catch(e) {}
    try { ha      = getHeikinAshiTrend(slice.slice(-15)); } catch(e) {}
    try { cvd     = approximateCVD(slice.slice(-30)); } catch(e) {}
    try {
        const piv = calculatePivotPoints(slice.slice(-14));
        pivSig    = getPivotSignal(cp, piv, cp > ema200 ? 'LONG' : 'SHORT');
    } catch(e) {}
    try { fib = checkFibConfluence(slice.slice(-60), cp > ema200 ? 'LONG' : 'SHORT'); } catch(e) {}

    // ── v6 big-profit ──
    let bbSqz = { exploding: false, isSqueezing: false, explosionDir: 'NONE', squeezeDuration: 0 };
    let volExp = { expanding: false, justStarted: false };
    let trap   = { bullTrap: false, bearTrap: false };

    try { bbSqz = detectBBSqueezeExplosion(slice.slice(-60)); } catch(e) {}
    try { volExp = detectVolatilityExpansion(slice.slice(-70)); } catch(e) {}
    try { trap  = detectMarketMakerTrap(slice.slice(-25)); } catch(e) {}

    // ── SCORING ──
    let ls = 0, ss = 0;

    // Core trend
    const ema1H_approx = parseFloat(calculateEMA(slice.slice(-30), 30));
    const tr1H = cp > ema1H_approx ? 'Bullish' : 'Bearish';
    const tr4H_approx = parseFloat(calculateEMA(slice.slice(-60), 60));
    const tr4H = cp > tr4H_approx ? 'Bullish' : 'Bearish';
    if (tr1H === 'Bullish' && tr4H === 'Bullish') ls++;
    if (tr1H === 'Bearish' && tr4H === 'Bearish') ss++;
    if (cp > ema200) ls++; else ss++;
    if (Math.abs(cp - ema50) / ema50 < 0.005) { if (cp > ema200) ls++; else ss++; }

    // SMC
    if (mSMC.bullishOB) ls++; if (mSMC.bearishOB) ss++;
    if (rsi < 45) ls++; if (rsi > 55) ss++;
    if (vwap.includes('🟢')) ls++; if (vwap.includes('🔴')) ss++;
    if (volBrk.includes('Bullish')) ls++; if (volBrk.includes('Bearish')) ss++;
    if (macd.includes('Bullish')) ls++; if (macd.includes('Bearish')) ss++;
    if (mSMC.sweep.includes('Bullish') || mSMC.choch.includes('Bullish')) ls++;
    if (mSMC.sweep.includes('Bearish') || mSMC.choch.includes('Bearish')) ss++;
    if (harm.includes('Bullish')) ls += 2; if (harm.includes('Bearish')) ss += 2;
    if (ict.includes('Bullish'))  ls++;    if (ict.includes('Bearish'))  ss++;
    if (diverg.includes('Bullish')) ls++;  if (diverg.includes('Bearish')) ss++;
    if (patt.includes('🟢')) ls++;         if (patt.includes('🔴')) ss++;
    if (liqS.includes('Bullish')) ls += 2; if (liqS.includes('Bearish')) ss += 2;
    if (choch.includes('Bullish')) ls += 2; if (choch.includes('Bearish')) ss += 2;
    if (mtfOBe.bullish) ls++; if (mtfOBe.bearish) ss++;

    // v4 precision
    if (stoch.isBull) ls++;  if (stoch.isBear) ss++;
    if (bb.isBull)    ls++;  if (bb.isBear)    ss++;
    if (bb.squeeze)  { ls += 0.5; ss += 0.5; }
    if (mtfRSI.signal === 'STRONG_BULL') ls += 2;  if (mtfRSI.signal === 'STRONG_BEAR') ss += 2;
    if (mtfRSI.isBull && mtfRSI.signal !== 'STRONG_BULL') ls++;
    if (mtfRSI.isBear && mtfRSI.signal !== 'STRONG_BEAR') ss++;
    if (volN.nearHVN) { ls += 0.5; ss += 0.5; }
    if (mtfOB.confluenceZone) {
        if (mtfOB.confluenceZone.type === 'BULLISH') ls += 2;
        if (mtfOB.confluenceZone.type === 'BEARISH') ss += 2;
    }
    if (superT.justFlipUp)    ls += 2; else if (superT.isBull) ls++;
    if (superT.justFlipDown)  ss += 2; else if (superT.isBear) ss++;
    if (rvol.signal === 'EXTREME' || rvol.signal === 'HIGH') { ls += 0.5; ss += 0.5; }
    if (mtfMac.signal === 'STRONG_BULL') ls += 2; if (mtfMac.signal === 'STRONG_BEAR') ss += 2;
    if (emaRib) {
        if (emaRib.signal === 'STRONG_BULL')   ls += 2;  if (emaRib.signal === 'STRONG_BEAR')   ss += 2;
        if (emaRib.signal === 'BULL_PULLBACK') ls++;      if (emaRib.signal === 'BEAR_PULLBACK') ss++;
    }

    // v5 world-class
    if      (wyckoff.phase === 'SPRING')       ls  += 3;
    else if (wyckoff.phase === 'MARKUP')       ls++;
    else if (wyckoff.phase === 'ACCUMULATION') ls  += 0.5;
    if      (wyckoff.phase === 'UTAD')         ss  += 3;
    else if (wyckoff.phase === 'MARKDOWN')     ss++;
    else if (wyckoff.phase === 'DISTRIBUTION') ss  += 0.5;

    if (breakers.bullishBreaker) ls += 2; if (breakers.bearishBreaker) ss += 2;
    if (equalHL.eql) ls++;  if (equalHL.eqh) ss++;

    if (pdZone.zone === 'OTE') { ls += 2; ss += 2; }
    else if (pdZone.tradeMatch) { if (cp > ema200) ls++; else ss++; }

    if (willR.isBull) ls++; if (willR.isBear) ss++;
    if      (ichi.signal === 'STRONG_BULL') ls += 2;
    else if (ichi.signal === 'BULL')        ls++;
    if      (ichi.signal === 'STRONG_BEAR') ss += 2;
    else if (ichi.signal === 'BEAR')        ss++;
    if (ichi.inCloud) { ls = Math.max(0, ls - 1); ss = Math.max(0, ss - 1); }

    if      (cvd.bullDiv)          ls += 2; else if (cvd.trend === 'BULL') ls++;
    if      (cvd.bearDiv)          ss += 2; else if (cvd.trend === 'BEAR') ss++;
    if (ha.isStrong && ha.isBull)  ls++;    if (ha.isStrong && ha.isBear)  ss++;
    if (pivSig.isBull) ls++;  if (pivSig.isBear) ss++;
    if (fib.hasConfluence) { if (cp > ema200) ls += 2; else ss += 2; }

    // v6
    if (bbSqz.exploding && bbSqz.explosionDir === 'BULL') ls += 3;
    if (bbSqz.exploding && bbSqz.explosionDir === 'BEAR') ss += 3;
    if (bbSqz.isSqueezing && bbSqz.squeezeDuration >= 3) { ls += 1; ss += 1; }
    if (volExp.justStarted) { ls += 3; ss += 3; }
    else if (volExp.expanding) { ls += 1; ss += 1; }
    if (trap.bearTrap) ls += 3; if (trap.bullTrap) ss += 3;

    // Smart direction
    const bestDir = ls >= ss ? 'LONG' : 'SHORT';

    return { longScore: ls, shortScore: ss, bestDir, atr, adx, currentPrice: cp };
}

// ─── Simulate one trade with partial TPs ──────────────────────
function simTrade(candles, idx, entry, sl, tp1, tp2, tp3, isLong, opts = {}) {
    const slD = Math.abs(entry - sl);
    if (slD === 0) return { result: 'SKIP', pnlR: 0, pnlPct: 0 };
    const feePct      = opts.fee      ?? 0.0004;
    const slippagePct = opts.slippage ?? 0.0005;
    const totalCost   = (feePct + slippagePct) * 2;
    const effEntry    = isLong ? entry * (1 + slippagePct) : entry * (1 - slippagePct);
    let tp1Hit = false, tp2Hit = false, pnlR = 0, pnlPct = 0;
    for (let j = idx; j < Math.min(idx + 200, candles.length); j++) {
        const hi = parseFloat(candles[j][2]), lo = parseFloat(candles[j][3]);
        if (isLong) {
            if (lo <= sl) {
                const p = tp1Hit ? 0.67 : 1.0;
                pnlPct += ((sl - effEntry) / effEntry) * p - totalCost * p;
                pnlR   += p * -1;
                return { result: 'LOSS', pnlR: pnlR + (tp1Hit?0.33*1.5:0) + (tp2Hit?0.33*3:0), pnlPct: parseFloat((pnlPct*100).toFixed(2)) };
            }
            if (!tp1Hit && hi >= tp1)  { tp1Hit=true;  pnlR+=0.33*1.5; pnlPct+=((tp1-effEntry)/effEntry)*0.33-totalCost*0.33; }
            if (tp1Hit && !tp2Hit && hi >= tp2) { tp2Hit=true; pnlR+=0.33*3; pnlPct+=((tp2-effEntry)/effEntry)*0.33-totalCost*0.33; }
            if (tp2Hit && hi >= tp3) { pnlR+=0.34*5; pnlPct+=((tp3-effEntry)/effEntry)*0.34-totalCost*0.34; return { result:'WIN', pnlR, pnlPct:parseFloat((pnlPct*100).toFixed(2)) }; }
        } else {
            if (hi >= sl) {
                const p = tp1Hit ? 0.67 : 1.0;
                pnlPct += ((effEntry - sl) / effEntry) * p - totalCost * p;
                pnlR   += p * -1;
                return { result: 'LOSS', pnlR: pnlR + (tp1Hit?0.33*1.5:0) + (tp2Hit?0.33*3:0), pnlPct: parseFloat((pnlPct*100).toFixed(2)) };
            }
            if (!tp1Hit && lo <= tp1)  { tp1Hit=true;  pnlR+=0.33*1.5; pnlPct+=((effEntry-tp1)/effEntry)*0.33-totalCost*0.33; }
            if (tp1Hit && !tp2Hit && lo <= tp2) { tp2Hit=true; pnlR+=0.33*3; pnlPct+=((effEntry-tp2)/effEntry)*0.33-totalCost*0.33; }
            if (tp2Hit && lo <= tp3) { pnlR+=0.34*5; pnlPct+=((effEntry-tp3)/effEntry)*0.34-totalCost*0.34; return { result:'WIN', pnlR, pnlPct:parseFloat((pnlPct*100).toFixed(2)) }; }
        }
    }
    const lastP  = parseFloat(candles[Math.min(idx+199, candles.length-1)][4]);
    const openR  = isLong ? (lastP-effEntry)/slD : (effEntry-lastP)/slD;
    const openPct= isLong ? (lastP-effEntry)/effEntry : (effEntry-lastP)/effEntry;
    const p      = tp2Hit?0.34:tp1Hit?0.67:1.0;
    return { result:'OPEN', pnlR:pnlR+openR*p, pnlPct:parseFloat(((pnlPct+openPct*p)*100).toFixed(2)) };
}

// ─── Full backtest run ────────────────────────────────────────
function runBacktest(candles, minScore, candles1H, opts = {}) {
    const MIN_SCORE = minScore || 12;
    let trades = [], equity = 0, maxEq = 0, maxDD = 0;
    let wins = 0, losses = 0, longT = 0, shortT = 0;
    let capital = 100, peakCap = 100, maxCapDD = 0;
    let i = 200;
    while (i < candles.length - 25) {
        const { longScore, shortScore, bestDir, atr, adx, currentPrice } = backtestScore(candles, i, candles1H);
        if (atr === 0) { i++; continue; }

        const ok  = (adx.value || adx) > 18;  // slightly more permissive
        const score = bestDir === 'LONG' ? longScore : shortScore;
        if (!ok || score < MIN_SCORE) { i++; continue; }

        const isLong = bestDir === 'LONG';
        const entry  = currentPrice;
        const sl     = isLong ? entry - atr * 2   : entry + atr * 2;
        const tp1    = isLong ? entry + atr * 1.5 : entry - atr * 1.5;
        const tp2    = isLong ? entry + atr * 3   : entry - atr * 3;
        const tp3    = isLong ? entry + atr * 5   : entry - atr * 5;

        const simOpts = { fee: opts.fee??0.0004, slippage: opts.slippage??0.0005 };
        const { result, pnlR, pnlPct } = simTrade(candles, i, entry, sl, tp1, tp2, tp3, isLong, simOpts);
        trades.push({ dir: isLong?'L':'S', entry, result, pnlR, pnlPct:pnlPct||0, score, idx:i });
        equity += pnlR;
        capital *= (1 + (pnlPct||0)/100);
        if (equity > maxEq) maxEq = equity;
        if (capital > peakCap) peakCap = capital;
        const dd = maxEq - equity;
        const capDD = (peakCap-capital)/peakCap*100;
        if (dd > maxDD) maxDD = dd;
        if (capDD > maxCapDD) maxCapDD = capDD;
        if (result === 'WIN')  wins++;
        if (result === 'LOSS') losses++;
        if (isLong) longT++; else shortT++;
        i += 20;
    }
    const total = wins + losses;
    const winRate = total > 0 ? (wins/total*100).toFixed(1) : '0.0';
    const gW  = trades.filter(t=>t.pnlR>0).reduce((s,t)=>s+t.pnlR,0);
    const gL  = Math.abs(trades.filter(t=>t.pnlR<0).reduce((s,t)=>s+t.pnlR,0));
    const pf  = gL > 0 ? (gW/gL).toFixed(2) : '∞';
    let conL=0, maxCL=0, conW=0, maxCW=0;
    [...trades].sort((a,b)=>a.idx-b.idx).forEach(t=>{
        if(t.result==='LOSS'){conL++;if(conL>maxCL)maxCL=conL;conW=0;}
        else{conW++;if(conW>maxCW)maxCW=conW;conL=0;}
    });
    const sortedByPnl = [...trades].sort((a,b)=>b.pnlR-a.pnlR);
    const pnlPcts = trades.map(t=>t.pnlPct||0);
    const meanP = pnlPcts.length ? pnlPcts.reduce((s,v)=>s+v,0)/pnlPcts.length : 0;
    const stdP  = pnlPcts.length>1 ? Math.sqrt(pnlPcts.reduce((s,v)=>s+Math.pow(v-meanP,2),0)/pnlPcts.length) : 0;
    const sharpe = stdP>0 ? parseFloat((meanP/stdP*Math.sqrt(252)).toFixed(2)) : 0;
    const totalReturn = capital-100;
    const calmar = maxCapDD>0 ? parseFloat((totalReturn/maxCapDD).toFixed(2)) : 0;
    const wPnls  = trades.filter(t=>t.pnlPct>0).map(t=>t.pnlPct);
    const lPnls  = trades.filter(t=>t.pnlPct<0).map(t=>t.pnlPct);
    const avgWin  = wPnls.length ? wPnls.reduce((s,v)=>s+v,0)/wPnls.length : 0;
    const avgLoss = lPnls.length ? Math.abs(lPnls.reduce((s,v)=>s+v,0)/lPnls.length) : 0;
    const wr = total>0?wins/total:0;
    const expectancy = parseFloat(((wr*avgWin)-((1-wr)*avgLoss)).toFixed(2));
    return {
        trades, wins, losses, longT, shortT, total, winRate, pf,
        gW: gW.toFixed(2), gL: gL.toFixed(2), maxDD: maxDD.toFixed(2),
        netR: equity.toFixed(2), maxCL, maxCW,
        best: sortedByPnl[0], worst: sortedByPnl[sortedByPnl.length-1],
        sharpe, calmar, expectancy: expectancy,
        finalCapital: parseFloat(capital.toFixed(2)),
        maxCapDD: parseFloat(maxCapDD.toFixed(2)),
        totalReturnPct: parseFloat(totalReturn.toFixed(2)),
        avgWinPct: parseFloat(avgWin.toFixed(2)), avgLossPct: parseFloat(avgLoss.toFixed(2)),
    };
}

// ═══════════════════════════════════════════════════════════════
// CMD 1: .backtest — Single coin deep backtest (ALL indicators)
// ═══════════════════════════════════════════════════════════════
cmd({
    pattern: 'backtest', alias: ['bt', 'test'],
    desc: 'FULL-SPECTRUM backtest — ALL 70 indicators, TP1/TP2/TP3 simulation',
    category: 'crypto', react: '⏪', filename: __filename,
}, async (conn, mek, m, { reply, args }) => {
    try {
        if (!args[0]) return await reply(`❌ Coin ලබා දෙන්න!\n*උදා:* ${config.PREFIX}backtest BTC 15m`);
        let coin = args[0].toUpperCase();
        if (!coin.endsWith('USDT')) coin += 'USDT';
        const tf = (args[1] || '15m').toLowerCase();
        await m.react('⏳');
        await reply(`⏳ *${coin} Full-Spectrum Backtest*\n1000 candles | ALL 70 indicators | TP1+TP2+TP3 partial close`);

        let candles, candles1H;
        try {
            [candles, candles1H] = await Promise.all([
                binance.getKlineData(coin, tf, 1000),
                binance.getKlineData(coin, '1h', 250).catch(() => null),
            ]);
        } catch(e) { return await reply(`❌ ${coin} data error: ${e.message}`); }
        if (!candles || candles.length < 500) return await reply('❌ Insufficient data (need 500+).');

        const r = runBacktest(candles, 12, candles1H);
        const pf = parseFloat(r.pf);
        const wr = parseFloat(r.winRate);
        const emoji  = wr >= 60 ? '🏆' : wr >= 50 ? '✅' : '⚠️';
        const grade  = pf >= 2.0 ? 'Excellent 🏆' : pf >= 1.5 ? 'Good ✅' : pf >= 1.0 ? 'Marginal ⚠️' : 'Poor ❌';
        const rec    = pf >= 1.5
            ? `✅ Trade this coin! Use .future ${coin.replace('USDT','')} ${tf}`
            : pf >= 1.0 ? `⚠️ Marginal. Use strict filters (score ≥ 18)`
            : `❌ Avoid. Try .scanbacktest to find better coins.`;

        const out = [
            `╔════════════════════════════╗`,
            `║ 📊 *FULL-SPECTRUM BACKTEST* ║`,
            `╚════════════════════════════╝`,
            ``,
            `🪙 *${coin.replace('USDT','')}* | ⏱️ ${tf} | 📊 ${candles.length} candles`,
            ``,
            `━━━━━━━━━━━━━━━━━━`,
            `*🎯 Strategy (v6 Full)*`,
            `━━━━━━━━━━━━━━━━━━`,
            `▫️ ALL 70 indicators: v4+v5+v6`,
            `▫️ Wyckoff + Ichimoku + CVD + Breakers + Fib`,
            `▫️ BB Explosion + MM Trap + Trend Start`,
            `▫️ Score ≥ 12/70 + ADX > 18`,
            `▫️ 33% @ TP1 (1.5×) | 33% @ TP2 (3×) | 34% @ TP3 (5×)`,
            ``,
            `━━━━━━━━━━━━━━━━━━`,
            `*📈 Performance*`,
            `━━━━━━━━━━━━━━━━━━`,
            `${emoji} *Win Rate: ${r.winRate}%* (${r.wins}W/${r.losses}L)`,
            `📊 Signals: ${r.total} (Long: ${r.longT} | Short: ${r.shortT})`,
            `💰 *Net: ${parseFloat(r.netR)>0?'+':''}${r.netR}R* (1R = your risk per trade)`,
            `📈 Profit Factor: *${r.pf}* → Grade: *${grade}*`,
            `💸 Gross Win: +${r.gW}R | Gross Loss: -${r.gL}R`,
            `📉 Max Drawdown: ${r.maxDD}R`,
            `⚠️ Max Consecutive Losses: ${r.maxCL}`,
            r.best  ? `\n🥇 Best: +${r.best.pnlR.toFixed(2)}R (${r.best.dir==='L'?'LONG':'SHORT'} @ $${r.best.entry.toFixed(4)})` : '',
            r.worst ? `💀 Worst: ${r.worst.pnlR.toFixed(2)}R` : '',
            ``,
            `━━━━━━━━━━━━━━━━━━`,
            `*📋 Verdict*`,
            `━━━━━━━━━━━━━━━━━━`,
            rec,
            ``,
            `💡 *.scanbacktest ${tf}* — compare all coins`,
        ].filter(l => l !== '').join('\n');

        await reply(out.trim());
        await m.react('✅');
    } catch(e) { await reply('❌ Error: ' + e.message); }
});

// ═══════════════════════════════════════════════════════════════
// CMD 2: .scanbacktest — Multi-coin, find best performers
// ═══════════════════════════════════════════════════════════════
cmd({
    pattern: 'scanbacktest', alias: ['sbt', 'bestcoins', 'topcoins'],
    desc: 'Scanner backtest ALL top 20 coins with full 70-factor scoring',
    category: 'crypto', react: '🔬', filename: __filename,
}, async (conn, mek, m, { reply, args }) => {
    try {
        await m.react('⏳');
        const tf = args[0] && ['5m','15m','1h','4h'].includes(args[0]) ? args[0] : '15m';
        await reply(`🔬 *SCANNER BACKTEST (Full-Spectrum)*\n⏱️ ${tf} | Top 20 coins | ALL 70 indicators\n⏳ ~2 minutes...`);

        let coins;
        try { coins = binance.isReady() ? binance.getWatchedCoins() : await binance.getTopTrendingCoins(20); }
        catch(e) { coins = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT','NEARUSDT']; }

        const results = [];
        for (const coin of coins.slice(0, 20)) {
            try {
                await new Promise(r => setTimeout(r, 500));
                const [c, c1h] = await Promise.all([
                    binance.getKlineData(coin, tf, 500),
                    binance.getKlineData(coin, '1h', 150).catch(() => null),
                ]);
                if (!c || c.length < 300) continue;
                const r = runBacktest(c, 12, c1h);
                if (r.total < 3) continue;
                results.push({
                    coin: coin.replace('USDT',''),
                    wr: parseFloat(r.winRate),
                    netR: parseFloat(r.netR),
                    pf: parseFloat(r.pf) || 0,
                    total: r.total, wins: r.wins, losses: r.losses,
                    maxDD: parseFloat(r.maxDD),
                });
            } catch(e) {}
        }

        if (!results.length) return await reply('❌ Test failed. Retry later.');

        results.sort((a,b) => {
            const sa = a.wr * a.pf / (1 + a.maxDD);
            const sb = b.wr * b.pf / (1 + b.maxDD);
            return sb - sa;
        });

        const top5  = results.slice(0, 5);
        const worst = results.slice(-3).filter(r => r.pf < 1.0);
        const avgWR = (results.reduce((s,r)=>s+r.wr,0)/results.length).toFixed(1);
        const good  = results.filter(r=>r.pf>=1.5).length;

        let msg = `╔══════════════════════════════╗\n║ 🔬 *SCANNER BACKTEST (v6 Full)* ║\n╚══════════════════════════════╝\n\n`;
        msg += `⏱️ *${tf}* | 📊 ${results.length} coins | ALL 70 indicators\n\n`;
        msg += `━━━━━━━━━━━━━━━━━━\n🏆 *BEST COINS TO TRADE*\n━━━━━━━━━━━━━━━━━━\n`;
        top5.forEach((r, i) => {
            const m2 = ['🥇','🥈','🥉','4️⃣','5️⃣'][i];
            const q  = r.wr >= 60 && r.pf >= 1.8 ? '🔥🔥' : r.wr >= 55 ? '🔥' : '✅';
            msg += `${m2} *#${r.coin}* ${q}\n`;
            msg += `   📈 Win: *${r.wr}%* (${r.wins}W/${r.losses}L/${r.total})\n`;
            msg += `   💰 Net: ${r.netR>0?'+':''}${r.netR.toFixed(1)}R | PF: ${r.pf.toFixed(2)} | DD: ${r.maxDD.toFixed(1)}R\n`;
            msg += `   🤖 *.future ${r.coin} ${tf}*\n\n`;
        });

        if (worst.length) {
            msg += `━━━━━━━━━━━━━━━━━━\n❌ *AVOID*\n━━━━━━━━━━━━━━━━━━\n`;
            worst.forEach(r => msg += `• *#${r.coin}* WR:${r.wr}% PF:${r.pf.toFixed(2)} ← Skip\n`);
            msg += '\n';
        }
        msg += `━━━━━━━━━━━━━━━━━━\n📊 *Summary*\n━━━━━━━━━━━━━━━━━━\n`;
        msg += `Avg Win Rate: ${avgWR}% | Good coins: ${good}/${results.length}\n\n`;
        msg += `💡 *.backtest ${top5[0]?.coin||'BTC'} ${tf}* — full analysis\n`;
        msg += `⚠️ _Past results ≠ future. Guidance only._`;

        await reply(msg.trim());
        await m.react('✅');
    } catch(e) { await reply('❌ Error: ' + e.message); }
});


// ─── Web API Exports ──────────────────────────────────────────
module.exports = {
    async runBacktest(coin, timeframe='15m', days=30) {
        const binance = require('../lib/binance');
        days = Math.max(5, Math.min(parseInt(days)||30, 90));
        // 1 day ≈ 96 candles on 15m
        const candleCount = Math.min(days * 96 + 200, 1500);
        const [candles, candles1H] = await Promise.all([
            binance.getKlineData(coin, timeframe, candleCount),
            binance.getKlineData(coin, '1h', 250).catch(()=>null),
        ]);
        if (!candles || candles.length < 300) throw new Error('Insufficient data — need 300+ candles');
        const r = runBacktest(candles, 12, candles1H);
        // Format for web UI
        const tradeLog = (r.trades||[]).slice(0,30).map(t => ({
            direction: t.dir==='L'?'LONG':'SHORT',
            entry:     parseFloat(t.entry||0).toFixed(4),
            result:    t.result,
            pnlPct:    parseFloat(t.pnlR||0).toFixed(2),
        }));
        return {
            coin: coin.replace('USDT',''), timeframe, days,
            total: r.total, wins: r.wins, losses: r.losses,
            winRate: parseFloat(r.winRate), totalPnl: parseFloat(r.netR),
            avgPnl: r.total>0?(parseFloat(r.netR)/r.total).toFixed(2):'0.00',
            maxDrawdown: parseFloat(r.maxDD),
            bestTrade:  r.best  ? parseFloat(r.best.pnlR).toFixed(2)  : null,
            worstTrade: r.worst ? parseFloat(r.worst.pnlR).toFixed(2) : null,
            profitFactor: r.pf, maxConsecLoss: r.maxCL, maxConsecWins: r.maxCW,
            sharpeRatio: r.sharpe, calmarRatio: r.calmar, expectancy: r.expectancy,
            finalCapital: r.finalCapital, maxCapDrawdown: r.maxCapDD,
            totalReturnPct: r.totalReturnPct,
            avgWinPct: r.avgWinPct, avgLossPct: r.avgLossPct,
            feeIncluded: true, slippageIncluded: true,
            trades: tradeLog,
        };
    }
};
