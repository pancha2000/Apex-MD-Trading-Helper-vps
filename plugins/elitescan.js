/**
 * ═══════════════════════════════════════════════════════════════
 *  APEX-MD  ·  plugins/elitescan.js  ·  ELITE SCAN v1.0
 * ─────────────────────────────────────────────────────────────
 *  .elitescan — Scan ALL coins → Score ↓ sort → Auto deep-dive top 3
 *
 *  HOW IT WORKS:
 *   1. Full watchlist scan (same as .scan)
 *   2. Score ↓ sorted — highest confluence coin first
 *   3. Overview table: ALL coins ranked with RR / MTF / Grade
 *   4. Auto deep-analysis of TOP 3 — no need to type .future manually
 *   5. NEW indicators added: Trendline Break, Volume Profile, Divergence Rank
 *
 *  INSTALL:
 *   → Copy this file to your /plugins/ folder
 *   → Restart bot
 *   → Usage: .elitescan  OR  .es  OR  .topscan
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const { cmd }    = require('../lib/commands');
const config     = require('../config');
const db         = require('../lib/database');
const binance    = require('../lib/binance');
const analyzer   = require('../lib/analyzer');
const confirmations = require('../lib/confirmations_lib');

// ─── Sentiment Cache (reuse if fresh) ─────────────────────────
let _sentCache = null, _sentCacheTime = 0;
async function getSentiment() {
    if (_sentCache && Date.now() - _sentCacheTime < 5 * 60 * 1000) return _sentCache;
    try {
        _sentCache = await binance.getMarketSentiment('BTCUSDT');
        _sentCacheTime = Date.now();
        return _sentCache;
    } catch (_) {
        return { overallSentiment: '⚪ N/A', fngEmoji: '⚪', fngValue: '50', totalBias: '0', tradingBias: 'Neutral' };
    }
}

// ─── RR Ratio Helper ──────────────────────────────────────────
function calcRR(entry, sl, tp, direction) {
    const e = parseFloat(entry), s = parseFloat(sl), t = parseFloat(tp);
    if (!e || !s || !t) return 0;
    const slDist = Math.abs(e - s);
    if (slDist <= 0) return 0;
    return direction === 'LONG' ? (t - e) / slDist : (e - t) / slDist;
}

// ─── New indicator: Score bonus from extra signals ─────────────
// Adds bonus points for rare high-quality setups not in base score
function calcEliteBonus(aData) {
    let bonus = 0;
    const reasons = [];

    // 1. Trendline Break Confirmation (BOS + ChoCH both present)
    if (aData.bos?.bullBOS && aData.choch?.includes('Bullish') && aData.direction === 'LONG') {
        bonus += 4; reasons.push('BOS+ChoCH Confluence 🔺');
    }
    if (aData.bos?.bearBOS && aData.choch?.includes('Bearish') && aData.direction === 'SHORT') {
        bonus += 4; reasons.push('BOS+ChoCH Confluence 🔻');
    }

    // 2. Triple Confluence: OB + Fib + VWAP aligned
    const hasOB   = aData.confirmation?.confirmed;
    const hasFib  = aData.fibConf?.hasConfluence;
    const hasVWAP = aData.vwap?.includes(aData.direction === 'LONG' ? '🟢' : '🔴');
    if (hasOB && hasFib && hasVWAP) {
        bonus += 3; reasons.push('OB+Fib+VWAP Triple ✅');
    }

    // 3. Wyckoff Spring/UTAD (highest accuracy reversal)
    if (aData.wyckoff?.phase === 'SPRING' && aData.direction === 'LONG') {
        bonus += 5; reasons.push('Wyckoff SPRING 🌱🌱🌱');
    }
    if (aData.wyckoff?.phase === 'UTAD' && aData.direction === 'SHORT') {
        bonus += 5; reasons.push('Wyckoff UTAD ⚡⚡⚡');
    }

    // 4. MTF OB Confluence (multi-timeframe agreement = institutional)
    if (aData.mtfOB?.confluenceZone) {
        bonus += 3; reasons.push('MTF OB Institutional 🏦');
    }

    // 5. Market Maker Trap detected
    if (aData.mmTrap?.bearTrap && aData.direction === 'LONG')  { bonus += 4; reasons.push('Bear Trap Squeeze 🪤'); }
    if (aData.mmTrap?.bullTrap && aData.direction === 'SHORT') { bonus += 4; reasons.push('Bull Trap Squeeze 🪤'); }

    // 6. MTF RSI Divergence (multi-timeframe = strongest)
    if (aData.mtfRSIDiv?.mtfBull && aData.direction === 'LONG')  { bonus += 4; reasons.push('MTF RSI Bull Div 💪'); }
    if (aData.mtfRSIDiv?.mtfBear && aData.direction === 'SHORT') { bonus += 4; reasons.push('MTF RSI Bear Div 💪'); }

    // 7. Cypher Pattern (highest-accuracy harmonic ~78% win rate)
    if (aData.cypherPat?.bull && aData.direction === 'LONG')  { bonus += 5; reasons.push('Cypher PRZ LONG 🎯'); }
    if (aData.cypherPat?.bear && aData.direction === 'SHORT') { bonus += 5; reasons.push('Cypher PRZ SHORT 🎯'); }

    // 8. Head & Shoulders
    if (aData.headShould?.bull && aData.direction === 'LONG')  { bonus += 4; reasons.push('Inv H&S Breakout 🚀'); }
    if (aData.headShould?.bear && aData.direction === 'SHORT') { bonus += 4; reasons.push('H&S Top Breakdown ⚠️'); }

    // 9. BB Explosion (momentum burst)
    if (aData.bbSqueeze?.exploding) {
        const explosionAligned = (aData.direction === 'LONG' && aData.bbSqueeze.explosionDir === 'BULL') ||
                                 (aData.direction === 'SHORT' && aData.bbSqueeze.explosionDir === 'BEAR');
        if (explosionAligned) { bonus += 5; reasons.push('BB Explosion 💥'); }
    }

    // 10. Renko Reversal (trend confirmation)
    if (aData.renko?.reversal && aData.renko.isBull && aData.direction === 'LONG')  { bonus += 3; reasons.push('Renko Bull Reversal 🧱'); }
    if (aData.renko?.reversal && aData.renko.isBear && aData.direction === 'SHORT') { bonus += 3; reasons.push('Renko Bear Reversal 🧱'); }

    // 11. Volume Divergence (CVD confirming direction)
    if (aData.cvd?.bullDiv && aData.direction === 'LONG')  { bonus += 3; reasons.push('CVD Hidden Accum 📊🚀'); }
    if (aData.cvd?.bearDiv && aData.direction === 'SHORT') { bonus += 3; reasons.push('CVD Hidden Dist 📊⚠️'); }

    // 12. 3-Drive Pattern
    if (aData.threeDrives?.bull && aData.direction === 'LONG')  { bonus += 3; reasons.push('Three Drives Bottom 🔄'); }
    if (aData.threeDrives?.bear && aData.direction === 'SHORT') { bonus += 3; reasons.push('Three Drives Top 🔄'); }

    // 13. Perfect 4/4 MTF Alignment
    if ((aData.mtfAlignCount || 0) === 4) { bonus += 3; reasons.push('PERFECT MTF 4/4 ✅✅✅'); }

    // 14. BTC Context aligned (strong macro tailwind)
    if (aData.btcContext?.trend === 'BULL' && aData.direction === 'LONG')  { bonus += 2; reasons.push('₿ BTC Macro BULL'); }
    if (aData.btcContext?.trend === 'BEAR' && aData.direction === 'SHORT') { bonus += 2; reasons.push('₿ BTC Macro BEAR'); }

    // 15. Hurst trending + low choppiness
    if (aData.dynRegime?.isTrending && !aData.dynRegime?.isChoppy) { bonus += 2; reasons.push('Hurst Trending ✅'); }

    return { bonus, reasons };
}

// ─── Elite Score: base score + bonus ──────────────────────────
function calcEliteScore(aData, sentBonus) {
    const base = (aData.score || 0) + sentBonus;
    const { bonus, reasons } = calcEliteBonus(aData);
    return { eliteScore: base + bonus, bonusPoints: bonus, bonusReasons: reasons };
}

// ══════════════════════════════════════════════════════════════
//  MAIN COMMAND: .elitescan
// ══════════════════════════════════════════════════════════════
cmd({
    pattern: 'elitescan',
    alias: ['es', 'topscan', 'bestscan', 'elite'],
    desc: '🏆 Scan all coins → rank by Elite Score → auto deep-analyze top 3',
    category: 'crypto',
    react: '🏆',
    filename: __filename
},
async (conn, mek, m, { reply, args }) => {
    try {
        await m.react('⏳');

        // Optional: user can pass top N count  (.elitescan 5)
        const topN = Math.min(parseInt(args[0]) || 3, 5);

        await reply(
            `🔭 *ELITE SCAN v1.0 starting...*\n` +
            `Scanning all coins → ranking by Elite Score...\n` +
            `Auto deep-analyzing Top ${topN} 🔬`
        );

        // ── Step 1: Scan all coins ────────────────────────────
        const coinsToScan = binance.isReady()
            ? binance.getWatchedCoins()
            : await binance.getTopTrendingCoins(30);

        const sent = await getSentiment();
        const sentBias = parseFloat(sent?.totalBias) || 0;

        const allSetups = [];

        for (const coin of coinsToScan) {
            try {
                const aData = await analyzer.run14FactorAnalysis(coin, '15m');
                if (!aData || (aData.score || 0) < 22) continue;  // pre-filter weak signals

                const sentBonus =
                    (aData.direction === 'LONG'  && sentBias >= 1)  ?  1 :
                    (aData.direction === 'SHORT' && sentBias <= -1) ?  1 :
                    (aData.direction === 'LONG'  && sentBias <= -1) ? -1 :
                    (aData.direction === 'SHORT' && sentBias >= 1)  ? -1 : 0;

                // ── RR ratio check ──────────────────────────
                const rr1 = calcRR(aData.entryPrice, aData.sl, aData.tp1, aData.direction);
                const rr2 = calcRR(aData.entryPrice, aData.sl, aData.tp2, aData.direction);
                if (rr1 < 1.0 || !isFinite(rr1)) continue;  // skip bad RR

                // ── Elite Score (base + bonuses) ─────────────
                const { eliteScore, bonusPoints, bonusReasons } = calcEliteScore(aData, sentBonus);

                allSetups.push({
                    coin,
                    coinLabel:        coin.replace('USDT', ''),
                    direction:        aData.direction,
                    type:             aData.direction === 'LONG' ? 'LONG 🟢' : 'SHORT 🔴',
                    baseScore:        (aData.score || 0) + sentBonus,
                    eliteScore,
                    bonusPoints,
                    bonusReasons,
                    scoreStr:         `${aData.score + sentBonus}/${aData.maxScore}`,
                    signalGrade:      aData.signalGrade || 'C',
                    signalGradeEmoji: aData.signalGradeEmoji || '📊',
                    signalGradeLabel: aData.signalGradeLabel || '',
                    price:            aData.priceStr,
                    entry:            aData.entryPrice,
                    tp1:              aData.tp1,
                    tp2:              aData.tp2,
                    tp3:              aData.tp3,
                    sl:               aData.sl,
                    rr1:              rr1.toFixed(2),
                    rr2:              rr2.toFixed(2),
                    mtfAlignCount:    aData.mtfAlignCount || 0,
                    confScore:        aData.confScore || 0,
                    dailyAligned:     aData.dailyAligned,
                    dailyTrend:       aData.dailyTrend || '',
                    orderType:        aData.orderSuggestion?.type || '',
                    reasons:          aData.reasons,
                    sentEmoji:        sentBonus > 0 ? '📰✅' : sentBonus < 0 ? '📰⚠️' : '',
                    aData,            // full data kept for deep analysis
                });
            } catch (_e) { /* skip failed coin */ }
        }

        if (allSetups.length === 0) {
            await m.react('⚪');
            return await reply(
                `⚪ *ELITE SCAN — No Results*\n\n` +
                `Score 22+ qualifying setups නොමැත.\n` +
                `Market consolidating / choppy. ටිකකට පසු retry කරන්න.`
            );
        }

        // ── Step 2: Sort by Elite Score ↓ ─────────────────────
        allSetups.sort((a, b) => b.eliteScore - a.eliteScore);

        // ── Step 3: Build overview ranking message ─────────────
        let overviewMsg =
            `╔══════════════════════════════╗\n` +
            `║  🏆 *ELITE SCAN — ALL RANKED*  ║\n` +
            `╚══════════════════════════════╝\n\n` +
            `🧠 *Market:* ${sent.overallSentiment} | ${sent.fngEmoji} F&G: ${sent.fngValue}\n` +
            `📊 *Qualifying setups:* ${allSetups.length} / ${coinsToScan.length} coins\n` +
            `🔬 *Auto deep-analyzing Top ${topN}*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `*📊 RANKED BY ELITE SCORE ↓*\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

        allSetups.forEach((s, i) => {
            const rrEmoji  = parseFloat(s.rr2) >= 3  ? '💎💎' :
                             parseFloat(s.rr2) >= 2  ? '💎'   :
                             parseFloat(s.rr2) >= 1.5 ? '✅'  : '⚠️';
            const dayTag   = s.dailyAligned ? '✅D' : '⚠️D';
            const orderTag = s.orderType.includes('MARKET') ? '⚡M' :
                             s.orderType.includes('LIMIT')  ? '⏳L' : '';
            const topTag   = i < topN ? ' 🔬*' : '';
            const bonusTag = s.bonusPoints > 0 ? ` +${s.bonusPoints}🎁` : '';

            overviewMsg +=
                `*${i+1}.* ${s.signalGradeEmoji} *${s.coinLabel}* ${s.type}${topTag}\n` +
                `   Elite: *${s.eliteScore}* (Base:${s.baseScore}${bonusTag}) | ${s.scoreStr}⭐${s.sentEmoji}\n` +
                `   MTF ${s.mtfAlignCount}/4 | Conf ${s.confScore} | RR ${s.rr2}${rrEmoji} | ${dayTag} ${orderTag}\n`;

            if (s.bonusReasons.length > 0) {
                overviewMsg += `   🏅 ${s.bonusReasons.slice(0,3).join(' · ')}\n`;
            }
            overviewMsg += `\n`;
        });

        overviewMsg +=
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `💡 Top ${topN} marked with 🔬 — deep analysis below`;

        await reply(overviewMsg.trim());

        // ── Step 4: Deep analysis — Top N ─────────────────────
        const topCoins = allSetups.slice(0, topN);

        for (let idx = 0; idx < topCoins.length; idx++) {
            const s    = topCoins[idx];
            const a    = s.aData;

            // ─── Position Size Calculation ─────────────────────
            const userMargin  = await db.getMargin(m.sender) || 0;
            let levText = 'Set .margin first', marginText = '—', qtyText = '—', riskText = '—';

            if (userMargin > 0) {
                const entryNum  = parseFloat(a.entryPrice);
                const slNum     = parseFloat(a.sl);
                const slDist    = Math.abs(entryNum - slNum);
                const slDistPct = slDist / entryNum;
                const riskAmt   = userMargin * 0.02;
                let   qty       = slDist > 0 ? riskAmt / slDist : 0;
                const rawLev    = slDistPct > 0 ? (riskAmt / slDistPct) / (userMargin * 0.10) : 10;
                const lev       = Math.min(Math.ceil(rawLev), 100);
                let   marginUsed = qty > 0 ? (qty * entryNum) / lev : 0;
                const maxMargin = userMargin * 0.20;
                if (marginUsed > maxMargin) { qty *= maxMargin / marginUsed; marginUsed = maxMargin; }

                if (qty > 0 && marginUsed <= userMargin) {
                    const qtyFmt   = qty < 1 ? qty.toFixed(4) : Math.round(qty).toString();
                    levText        = `${lev}x (Isolated)`;
                    marginText     = `$${marginUsed.toFixed(2)}`;
                    qtyText        = `${qtyFmt} ${s.coinLabel}`;
                    riskText       = `$${(Math.abs(entryNum - slNum) * qty).toFixed(2)}`;
                }
            }

            // ─── RR & Confidence ───────────────────────────────
            const rr2Val   = parseFloat(s.rr2);
            const rrEmoji  = rr2Val >= 3 ? '💎💎' : rr2Val >= 2 ? '💎' : rr2Val >= 1.5 ? '✅' : '⚠️';
            const confPct  = Math.min(95, Math.round(45 + (s.eliteScore / 100) * 50));

            // ─── Confirmation fetch (parallel, 15s timeout) ────
            const withTimeout = (p, ms, fb) => Promise.race([p, new Promise(r => setTimeout(() => r(fb), ms))]);
            const entryConf   = await withTimeout(
                confirmations.runAllConfirmations(s.coin, a.direction, config.LUNAR_API || null),
                15000,
                { totalScore: 0, confirmationStrength: 'N/A', display: '⚪ Confirmation timeout' }
            );

            // ─── Candle Pattern at Zone (new check) ───────────
            const lastCandle  = (a.currentCandles || []).slice(-1)[0];
            const lo = lastCandle ? parseFloat(lastCandle[3]) : 0;
            const hi = lastCandle ? parseFloat(lastCandle[2]) : 0;
            const cl = lastCandle ? parseFloat(lastCandle[4]) : 0;
            const op = lastCandle ? parseFloat(lastCandle[1]) : 0;
            const body    = Math.abs(cl - op);
            const range   = hi - lo;
            const lWick   = Math.min(op, cl) - lo;
            const uWick   = hi - Math.max(op, cl);
            const isPinBarBull  = lWick >= body * 2 && cl > lo + range * 0.6 && a.direction === 'LONG';
            const isPinBarBear  = uWick >= body * 2 && cl < hi - range * 0.6 && a.direction === 'SHORT';
            const candlePatternStr = isPinBarBull ? '📍 Pin Bar BULL at zone ✅' :
                                     isPinBarBear ? '📍 Pin Bar BEAR at zone ✅' :
                                     '⚪ No pin bar at zone';

            // ─── Liquidity Sweep Gate ──────────────────────────
            const sweepConfirmed = a.direction === 'LONG'
                ? (a.liquiditySweep?.includes('Bullish') || a.choch?.includes('Bullish') || a.choch5m?.includes('Bullish'))
                : (a.liquiditySweep?.includes('Bearish') || a.choch?.includes('Bearish') || a.choch5m?.includes('Bearish'));

            // ─── Volume Profile analysis ───────────────────────
            const hvnStr  = a.volNodes?.nearHVN  ? '🔥 Price at HVN (high volume node = strong support/resist)' :
                            a.volNodes?.nearLVN  ? '⚡ Price at LVN (low volume = price moves fast through here)' :
                            '⚪ Not at notable volume node';

            // ─── Top 3 Zones from deepEntry ───────────────────
            let zonesStr = '';
            if (a.deepEntry?.topZones?.length > 0) {
                zonesStr = `\n*🎯 Entry Zones (Confluence):*\n`;
                a.deepEntry.topZones.forEach((z, zi) => {
                    zonesStr += `   ${zi+1}. $${z.price} — ${z.label} (conf: ${z.confluence}, dist: ${z.distPct}%)\n`;
                });
            }

            // ─── Build deep analysis message ──────────────────
            let deep =
                `\n${'═'.repeat(32)}\n` +
                `🔬 *DEEP ANALYSIS #${idx+1} — ${s.coinLabel}* ${s.signalGradeEmoji}\n` +
                `${'═'.repeat(32)}\n\n` +
                `${s.signalGradeEmoji} *Grade: ${s.signalGrade}* | ${s.signalGradeLabel}\n` +
                `🏆 *Elite Score: ${s.eliteScore}* (Base: ${s.baseScore} + Bonus: +${s.bonusPoints})\n` +
                `📊 MTF: ${s.mtfAlignCount}/4 | Conf: ${s.confScore}/21\n` +
                `💹 Direction: *${s.type}*\n\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `📍 *Entry:*  $${a.entryPrice}  _(${a.bestEntry?.name || ''})_\n` +
                `🛡️ *SL:*     $${a.sl}  _(${a.slLabel || 'ATR'})_\n` +
                `🎯 *TP1:*   $${a.tp1}  _(${a.tp1Label || ''})_  RR: ${s.rr1}${parseFloat(s.rr1) >= 1.5 ? '✅' : '⚠️'}\n` +
                `🎯 *TP2:*   $${a.tp2}  _(${a.tp2Label || ''})_  RR: ${s.rr2}${rrEmoji}\n` +
                `🎯 *TP3:*   $${a.tp3}  _(${a.tp3Label || ''})_\n` +
                `📋 *Order:* ${s.orderType}\n` +
                `${a.deepEntry ? `⏱️ *Zone ETA:* ${a.deepEntry.eta || 'At zone'}\n` : ''}` +
                `\n`;

            // Position size
            if (userMargin > 0) {
                deep +=
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `*💼 POSITION SIZE*\n` +
                    `⚙️ Leverage:  ${levText}\n` +
                    `💰 Margin:    ${marginText}\n` +
                    `📦 Qty:       ${qtyText}\n` +
                    `🛡️ Risk:       ${riskText}\n` +
                    `🔥 Confidence: ${confPct}%\n\n`;
            }

            // Elite bonus reasons
            if (s.bonusReasons.length > 0) {
                deep +=
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `*🏅 ELITE BONUS SIGNALS:*\n` +
                    s.bonusReasons.map(r => `   ✅ ${r}`).join('\n') + `\n\n`;
            }

            // Key reasons
            deep +=
                `━━━━━━━━━━━━━━━━━━\n` +
                `*🔑 Confluence Factors:*\n${s.reasons}\n\n`;

            // SMC zones
            deep += `━━━━━━━━━━━━━━━━━━\n*📐 SMC Structure:*\n`;
            if (a.liquiditySweep !== 'None') deep += `   💧 Liq Sweep: ${a.liquiditySweep}\n`;
            if (a.choch !== 'None')          deep += `   🔄 ChoCH: ${a.choch}\n`;
            if (a.choch5m !== 'None')         deep += `   🔄 5m ChoCH: ${a.choch5m}\n`;
            if (a.sweep5m !== 'None')         deep += `   💧 5m Sweep: ${a.sweep5m}\n`;
            if (a.marketSMC?.bullishOBDisplay !== 'None') deep += `   🟢 Bull OB: ${a.marketSMC.bullishOBDisplay}\n`;
            if (a.marketSMC?.bearishOBDisplay !== 'None') deep += `   🔴 Bear OB: ${a.marketSMC.bearishOBDisplay}\n`;
            deep +=
                `   🔒 Sweep Confirmed: ${sweepConfirmed ? '✅ YES' : '⚪ Not yet'}\n` +
                `   ${candlePatternStr}\n\n`;

            // Entry confluence zones
            if (zonesStr) deep += zonesStr + '\n';

            // MTF
            deep +=
                `━━━━━━━━━━━━━━━━━━\n` +
                `*⏱️ Multi-Timeframe:*\n` +
                `   Daily: ${a.dailyTrend || '?'} ${a.dailyAligned ? '✅' : '⚠️'}\n` +
                `   4H:    ${a.trend4H || '?'}\n` +
                `   1H:    ${a.trend1H || '?'}\n` +
                `   15m:   ${a.mainTrend || '?'}\n` +
                `   5m:    ${a.trend5m || '?'}\n\n`;

            // Volume
            deep +=
                `━━━━━━━━━━━━━━━━━━\n` +
                `*📊 Volume & Market:*\n` +
                `   ${hvnStr}\n` +
                `   RVOL: ${a.rvol?.display || 'N/A'}\n` +
                `   CVD: ${a.cvd?.display || 'N/A'}\n` +
                `   ${a.bbSqueeze?.display || ''}\n\n`;

            // Advanced signals
            deep +=
                `━━━━━━━━━━━━━━━━━━\n` +
                `*🧠 Advanced Intelligence:*\n` +
                `   Wyckoff: ${a.wyckoff?.display || 'N/A'}\n` +
                `   Ichimoku: ${a.ichimoku?.display || 'N/A'}\n` +
                `   Heikin Ashi: ${a.heikinAshi?.display || 'N/A'}\n` +
                `   Supertrend: ${a.supertrend?.display || 'N/A'}\n` +
                `   ${a.momentumShift?.display || ''}\n`;

            if (a.mtfRSIDiv?.mtfConfirmed) deep += `   MTF RSI Div: ${a.mtfRSIDiv.display}\n`;
            if (a.cypherPat?.display !== 'None' && a.cypherPat?.display) deep += `   Cypher: ${a.cypherPat.display}\n`;
            if (a.headShould?.display !== 'None' && a.headShould?.display) deep += `   H&S: ${a.headShould.display}\n`;
            deep += '\n';

            // 8-factor confirmation
            deep +=
                `━━━━━━━━━━━━━━━━━━\n` +
                `*🔒 Entry Confirmation:*\n` +
                `${entryConf.display}\n\n`;

            // Final verdict
            const gradeLabel =
                s.signalGrade === 'A+' ? '🏆 ELITE — Take this trade with confidence' :
                s.signalGrade === 'A'  ? '🥇 HIGH QUALITY — Strong setup, good risk/reward' :
                s.signalGrade === 'B'  ? '🥈 STANDARD — Proceed with caution, wait for sweep' :
                '⚠️ Below standard — skip or paper trade only';

            deep +=
                `━━━━━━━━━━━━━━━━━━\n` +
                `*🎯 VERDICT: ${gradeLabel}*\n\n` +
                `📌 Track: .track reply\n` +
                `[TARGETS|ENTRY:${a.entryPrice}|TP1:${a.tp1}|TP2:${a.tp2}|TP3:${a.tp3}|SL:${a.sl}]\n` +
                `🖼️ .chart ${s.coin} 15m | 🔍 .future ${s.coin} 15m`;

            await reply(deep.trim());

            // Small delay between messages to avoid rate limiting
            await new Promise(r => setTimeout(r, 800));
        }

        await m.react('✅');

    } catch (e) {
        console.error('[elitescan] Error:', e.stack || e.message);
        await m.react('❌');
        await reply(`❌ *Elite Scan Error:* ${e.message}\n\nRetry කරන්න: .elitescan`);
    }
});


// ══════════════════════════════════════════════════════════════
//  QUICK COMMAND: .quickscan — Fast 30-second scan, top 5 only
//  No deep analysis — just ranked overview (faster than elitescan)
// ══════════════════════════════════════════════════════════════
cmd({
    pattern: 'quickscan',
    alias: ['qs', 'fastscan'],
    desc: '⚡ Quick scan → top 5 ranked (no deep analysis, faster)',
    category: 'crypto',
    react: '⚡',
    filename: __filename
},
async (conn, mek, m, { reply }) => {
    try {
        await m.react('⏳');
        await reply('⚡ *QUICK SCAN starting...*');

        const coinsToScan = binance.isReady()
            ? binance.getWatchedCoins()
            : await binance.getTopTrendingCoins(20);

        const sent    = await getSentiment();
        const sentBias = parseFloat(sent?.totalBias) || 0;
        const results  = [];

        for (const coin of coinsToScan) {
            try {
                const aData = await analyzer.run14FactorAnalysis(coin, '15m');
                if (!aData || aData.score < 20) continue;
                const sb = (aData.direction === 'LONG' && sentBias >= 1) ? 1 :
                           (aData.direction === 'SHORT' && sentBias <= -1) ? 1 :
                           (aData.direction === 'LONG' && sentBias <= -1) ? -1 :
                           (aData.direction === 'SHORT' && sentBias >= 1) ? -1 : 0;
                const { eliteScore } = calcEliteScore(aData, sb);
                const rr = calcRR(aData.entryPrice, aData.sl, aData.tp2, aData.direction);
                if (rr < 1.0) continue;
                results.push({
                    coinLabel: coin.replace('USDT', ''), coin,
                    direction: aData.direction,
                    type: aData.direction === 'LONG' ? 'LONG 🟢' : 'SHORT 🔴',
                    eliteScore, baseScore: (aData.score || 0) + sb,
                    scoreStr: `${aData.score+sb}/${aData.maxScore}`,
                    signalGrade: aData.signalGrade || 'C',
                    signalGradeEmoji: aData.signalGradeEmoji || '📊',
                    price: aData.priceStr, entry: aData.entryPrice,
                    tp1: aData.tp1, tp2: aData.tp2, sl: aData.sl,
                    rr: rr.toFixed(2),
                    mtfAlignCount: aData.mtfAlignCount || 0,
                    confScore: aData.confScore || 0,
                    dailyAligned: aData.dailyAligned,
                    sentEmoji: sb > 0 ? '✅' : sb < 0 ? '⚠️' : '',
                });
            } catch (_) {}
        }

        results.sort((a, b) => b.eliteScore - a.eliteScore);
        const top5 = results.slice(0, 5);

        if (top5.length === 0) {
            await m.react('⚪');
            return await reply('⚪ No qualifying setups found. Market choppy.');
        }

        let out =
            `╔══════════════════════════╗\n` +
            `║  ⚡ *QUICK SCAN — TOP 5*  ║\n` +
            `╚══════════════════════════╝\n\n` +
            `🧠 ${sent.overallSentiment} | ${sent.fngEmoji} F&G: ${sent.fngValue}\n\n`;

        top5.forEach((s, i) => {
            const rrEmoji = parseFloat(s.rr) >= 2 ? '💎' : parseFloat(s.rr) >= 1.5 ? '✅' : '⚠️';
            out +=
                `*${i+1}.* ${s.signalGradeEmoji} *${s.coinLabel}* ${s.type}\n` +
                `   Score: *${s.eliteScore}* | ${s.scoreStr}⭐${s.sentEmoji}\n` +
                `   📍$${s.price} | SL:$${s.sl} | TP2:$${s.tp2}\n` +
                `   MTF ${s.mtfAlignCount}/4 | Conf ${s.confScore} | RR ${s.rr}${rrEmoji} ${s.dailyAligned?'✅D':'⚠️D'}\n` +
                `   🔍 *.future ${s.coinLabel} 15m*\n\n`;
        });

        out += `━━━━━━━━━━━━━━━━━━\n📊 Total: ${results.length}/${coinsToScan.length} qualifying`;

        await reply(out.trim());
        await m.react('✅');

    } catch (e) {
        await m.react('❌');
        await reply(`❌ Quick scan error: ${e.message}`);
    }
});
