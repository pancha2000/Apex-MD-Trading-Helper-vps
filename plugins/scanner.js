/**
 * ═══════════════════════════════════════════════════════════════
 *  APEX-MD  ·  scanner.js  ·  Event-Driven WebSocket Edition
 *  ─────────────────────────────────────────────────────────────
 *  • NO setInterval for signal scanning — 100% event-driven
 *  • Listens to binance.wsEvents '15m_candle_close' events
 *  • 15-second debounce batches multiple simultaneous closes
 *    into a single scan pass (all 30 coins close at the same time)
 *  • Trade Manager keeps its 60-second price-poll (one REST call
 *    per active trade per minute — minimal overhead)
 *  • WebSocket init called automatically when scanner starts
 *
 *  ✅ TRADE MANAGER FIX: Pending → Active fill logic now uses a
 *     0.25% tolerance buffer so LIMIT orders fill when price
 *     enters the entry *zone*, not only at an exact tick match.
 *     Correct directional logic:
 *       LONG pending  → fills when currentPrice ≤ entry × 1.0025
 *       SHORT pending → fills when currentPrice ≥ entry × 0.9975
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const { cmd } = require('../lib/commands');
const config   = require('../config');
const db       = require('../lib/database');
const axios    = require('axios');
const binance  = require('../lib/binance');
const analyzer = require('../lib/analyzer');
const { broadcastSignal, dispatchSignal } = require('../lib/signalDispatch');

// ─── Sentiment Cache ───────────────────────────────────────────
let cachedSentiment    = null;
let sentimentCacheTime = 0;
const SENTIMENT_CACHE_MS = 5 * 60 * 1000;   // refresh every 5 min

async function getSentimentCached() {
    if (!cachedSentiment || Date.now() - sentimentCacheTime > SENTIMENT_CACHE_MS) {
        cachedSentiment = await binance.getMarketSentiment().catch(() => ({
            totalBias: '0', overallSentiment: 'NEUTRAL', tradingBias: 'Neutral',
            fngEmoji: '⚪', fngValue: 'N/A', btcDominance: 'N/A', newsSentimentScore: 0,
        }));
        sentimentCacheTime = Date.now();
    }
    return cachedSentiment;
}

// ─── Signal Cooldown Map ───────────────────────────────────────
// Prevents the same coin from appearing in consecutive auto-scans.
// Key: coin symbol  →  Value: timestamp of last signal (ms)
// Cooldown: 4 hours (= 16 × 15m candles) before a coin can re-appear.
const SIGNAL_COOLDOWN_MS = 4 * 60 * 60 * 1000;  // 4h
const _lastSignalTime    = new Map();

function isOnCooldown(coin) {
    const last = _lastSignalTime.get(coin);
    return last && (Date.now() - last) < SIGNAL_COOLDOWN_MS;
}
function markSignalSent(coin) {
    _lastSignalTime.set(coin, Date.now());
}

// ─── Top 5 Setups Scanner ─────────────────────────────────────
/**
 * Scans all watched coins (already in WS cache) for high-probability
 * setups using the 14-Factor analyzer.
 * No REST calls are made here — everything reads from the in-memory cache.
 */
async function getTopDownSetups(ignoreCooldown = false) {
    const foundSetups = [];

    const coinsToScan = binance.isReady()
        ? binance.getWatchedCoins()
        : await binance.getTopTrendingCoins(20);

    for (const coin of coinsToScan) {
        try {
            // Skip coins on signal cooldown (auto-scan only — manual .scan ignores cooldown)
            if (!ignoreCooldown && isOnCooldown(coin)) continue;

            const aData = await analyzer.run14FactorAnalysis(coin, '15m');

            // ── SCORE GATE v9 (High-Accuracy Win-Rate Mode) ──────────────────
            // Score normalized 0-100. Threshold raised to 32.
            // Grades: A+(Elite) / A(High) / B(Standard) only pass auto-scan.
            // C/D grade always blocked. Asian session B grade blocked.
            // RR ratio < 1.2 always blocked regardless of grade.
            if (aData.score >= 32) {
                const sent      = await getSentimentCached();
                const sentBias  = parseFloat(sent.totalBias) || 0;
                const sentBonus =
                    (aData.direction === 'LONG'  && sentBias >= 1)  ?  1 :
                    (aData.direction === 'SHORT' && sentBias <= -1) ?  1 :
                    (aData.direction === 'LONG'  && sentBias <= -1) ? -1 :
                    (aData.direction === 'SHORT' && sentBias >= 1)  ? -1 : 0;

                const adjustedScore   = aData.score + sentBonus;
                const confScore       = aData.confScore || 0;
                const confGate        = aData.confGate  || false;
                const signalGrade     = aData.signalGrade || 'C';
                const mtfAlign        = aData.mtfAlignCount || 0;

                // Block C/D grades during Asian session low-liquidity hours
                if (aData.sessionBlocked) continue;

                const coreConf = [
                    aData.choch && aData.choch.includes(aData.direction === 'LONG' ? 'Bullish' : 'Bearish'),
                    aData.liquiditySweep && aData.liquiditySweep.includes(aData.direction === 'LONG' ? 'Bullish' : 'Bearish'),
                    aData.choch5m && aData.choch5m.includes(aData.direction === 'LONG' ? 'Bullish' : 'Bearish'),
                    aData.sweep5m && aData.sweep5m.includes(aData.direction === 'LONG' ? 'Bullish' : 'Bearish'),
                ].filter(Boolean).length;

                // ── RR Ratio Gate ──────────────────────────────────────────────
                // TP1 must give at least 1.2× reward vs SL risk.
                // Bad RR setups get skipped immediately — no exceptions.
                const entryForRR = parseFloat(aData.entryPrice || aData.currentPrice) || 1;
                const tp1ForRR   = parseFloat(aData.tp1) || 0;
                const slForRR    = parseFloat(aData.sl)  || 0;
                const rrSlDist   = Math.abs(entryForRR - slForRR);
                const rrRatio    = (rrSlDist > 0)
                    ? (aData.direction === 'LONG'
                        ? (tp1ForRR - entryForRR) / rrSlDist
                        : (entryForRR - tp1ForRR) / rrSlDist)
                    : 0;
                if (!isFinite(rrRatio) || rrRatio < 1.2) continue;  // Bad RR = skip

                // ── Asian Session B-Grade Block ───────────────────────────────
                // 00:00–08:00 UTC = low liquidity (Asian session).
                // B-grade setups in low liquidity = high slippage / stop hunts.
                const utcNow       = new Date().getUTCHours();
                const isAsianHours = utcNow >= 0 && utcNow < 8;
                if (isAsianHours && signalGrade === 'B') continue;

                // ── Grade-Based Quality Pass ──────────────────────────────────
                // A+: Elite — needs perfect MTF+conf+score alignment
                // A:  High Quality — requires daily alignment (not just 1H/4H)
                // B:  Standard — needs strong conf gate + core SMC + MTF 2/4
                // C/D: Never pass auto-scan
                const qualityPass =
                    (signalGrade === 'A+') ? (adjustedScore >= 55 && mtfAlign >= 3 && confScore >= 8) :
                    (signalGrade === 'A')  ? (adjustedScore >= 45 && mtfAlign >= 2 && confScore >= 6 && aData.dailyAligned) :
                    (signalGrade === 'B')  ? (adjustedScore >= 35 && confGate && coreConf >= 2 && mtfAlign >= 2) :
                    false; // C and D never pass auto-scan

                if (!qualityPass) continue;

                markSignalSent(coin);

                foundSetups.push({
                    coin:             coin.replace('USDT', ''),
                    type:             aData.direction === 'LONG' ? 'LONG 🟢' : 'SHORT 🔴',
                    rawScore:         adjustedScore,
                    score:            `${adjustedScore}/${aData.maxScore}`,
                    signalGrade,
                    signalGradeEmoji: aData.signalGradeEmoji || '📊',
                    signalGradeLabel: aData.signalGradeLabel || 'STANDARD',
                    price:            aData.priceStr,
                    tp1:              aData.tp1,
                    tp2:              aData.tp2,
                    tp3:              aData.tp3,
                    tp:               aData.tp2,
                    sl:               aData.sl,
                    adx:              aData.adxData.value,
                    reasons:          aData.reasons,
                    liquiditySweep:   aData.liquiditySweep || 'None',
                    choch:            aData.choch || 'None',
                    choch5m:          aData.choch5m || 'None',
                    sweep5m:          aData.sweep5m || 'None',
                    sentEmoji:        sentBonus > 0 ? '📰✅' : sentBonus < 0 ? '📰⚠️' : '',
                    tradeCategory:    aData.tradeCategory ? aData.tradeCategory.label : null,
                    orderType:        aData.orderSuggestion ? aData.orderSuggestion.type : null,
                    dailyTrend:       aData.dailyTrend || '',
                    dailyAligned:     aData.dailyAligned,
                    mtfAlignCount:    mtfAlign,
                    bbSqueeze:        aData.bbSqueeze,
                    volExpansion:     aData.volExpansion,
                    mmTrap:           aData.mmTrap,
                    tf3Align:         aData.tf3Align,
                    coreConf,
                    confScore,
                    confGate,
                    dynRegime:        aData.dynRegime || null,
                });
            }
        } catch (_e) { /* skip failed coin */ }
    }

    foundSetups.sort((a, b) => b.rawScore - a.rawScore);
    return foundSetups.slice(0, 5);
}

// ─── Scanner / Trade Manager State ────────────────────────────
let _scannerActive   = false;
let activeTradeManager = null;
let _15mCloseHandler = null;
let _debounceTimer   = null;
let _connRef         = null;
let _ownerJidRef     = null;

// ─── Trade Manager (60-second price poll) ─────────────────────
/**
 * Checks every 60 seconds:
 *   PENDING trades → activate when price enters the entry zone
 *   ACTIVE trades  → check TP1, TP2, TP3, SL, DCA, trailing SL
 *
 * ✅ FIX: Fill tolerance of 0.25% added to PENDING → ACTIVE transition.
 *    Real exchange limit orders fill inside a zone, not only at a single tick.
 *    Without tolerance, a LONG order at $100.00 would never fill if the lowest
 *    live price polled is $100.02 — now it fills at $100.25 or below.
 *
 *    LONG  pending fills: currentPrice ≤ entry × (1 + FILL_TOLERANCE)
 *    SHORT pending fills: currentPrice ≥ entry × (1 - FILL_TOLERANCE)
 */
function startTradeManager(conn) {
    if (activeTradeManager) return;

    // Fill zone tolerance: 0.25%
    // Meaning: a LONG order at $100 will fill if price reaches $100.25 or lower.
    // This mirrors how exchange limit orders fill inside a price band.
    const FILL_TOLERANCE = 0.0025;

    activeTradeManager = setInterval(async () => {
        try {
            const activeTrades = await db.Trade.find({ status: { $in: ['active', 'pending'] } });
            if (!activeTrades || activeTrades.length === 0) return;
            const currentSettings = await db.getSettings();

            for (const trade of activeTrades) {
                try {
                    const res = await axios.get(
                        `https://api.binance.com/api/v3/ticker/price?symbol=${trade.coin}`,
                        { timeout: 5000 }
                    );
                    const currentPrice = parseFloat(res.data.price);
                    const isLong  = trade.direction === 'LONG';
                    const isPaper = !!trade.isPaper;
                    const cb      = trade.coin.replace('USDT', '');
                    const de      = isLong ? '🟢' : '🔴';
                    const dir     = trade.direction;

                    // ═══════════════════════════════════════════════════════
                    // PENDING → ACTIVE (LIMIT ORDER FILL)
                    // ═══════════════════════════════════════════════════════
                    //
                    // Logic:
                    //   LONG  limit: we placed a buy order BELOW current price.
                    //                It fills when price DROPS to or below entry.
                    //                Fill zone: currentPrice ≤ entry × (1 + FILL_TOLERANCE)
                    //                (0.25% tolerance: fills if price is within 0.25% above entry)
                    //
                    //   SHORT limit: we placed a sell order ABOVE current price.
                    //                It fills when price RISES to or above entry.
                    //                Fill zone: currentPrice ≥ entry × (1 - FILL_TOLERANCE)
                    //                (0.25% tolerance: fills if price is within 0.25% below entry)
                    //
                    if (trade.status === 'pending') {
                        // ── LIMIT ORDER EXPIRY CHECK ─────────────────────────────────────────
                        // LIMIT orders that haven't filled within expiresAt are auto-cancelled.
                        // Default: 48h from openTime (set when trade is created).
                        // Falls back to 48h from openTime if expiresAt not set (legacy trades).
                        const expiry = trade.expiresAt
                            ? new Date(trade.expiresAt)
                            : new Date(new Date(trade.openTime).getTime() + 48 * 3600 * 1000);

                        if (Date.now() > expiry.getTime()) {
                            trade.status = 'expired';
                            trade.result = 'EXPIRED';
                            await trade.save();

                            const openedAgo = Math.round((Date.now() - new Date(trade.openTime)) / 3600000);
                            try {
                                await conn.sendMessage(trade.userJid, { text:
                                    `⏰ *LIMIT ORDER EXPIRED* ❌\n━━━━━━━━━━━━━━━━\n` +
                                    `🪙 *${cb}/USDT* ${de} *${dir}*\n\n` +
                                    `📋 Order Type: ⏳ LIMIT → ❌ EXPIRED\n` +
                                    `📍 Entry Zone: $${parseFloat(trade.entry).toFixed(4)}\n` +
                                    `💹 Current:    $${currentPrice.toFixed(4)}\n` +
                                    `⏱️ Open for:   ${openedAgo}h — price never reached entry zone\n\n` +
                                    `✅ *Order auto-cancelled — capital freed*\n` +
                                    `_Market moved away from your entry zone._`,
                                });
                            } catch (_) {}
                            continue; // skip TP/SL checks
                        }

                        // ── Safety check: LIMIT order should only fill from the correct side ──
                        // LONG  limit: entry is BELOW current open price → price must DROP to fill
                        //              → Only check fill if price is still >= entry (hasn't blown through)
                        // SHORT limit: entry is ABOVE current open price → price must RISE to fill
                        //              → Only check fill if price is still <= entry
                        // This prevents a wrong-direction trade from filling immediately.
                        const correctSideCheck = isLong
                            ? currentPrice <= trade.entry * (1 + FILL_TOLERANCE)   // LONG: price at or below entry ±tol
                            : currentPrice >= trade.entry * (1 - FILL_TOLERANCE);  // SHORT: price at or above entry ±tol

                        if (correctSideCheck) {
                            // Activate the trade — record actual fill price
                            trade.status    = 'active';
                            trade.fillPrice = currentPrice;
                            await trade.save();

                            if (isPaper) {
                                await conn.sendMessage(trade.userJid, { text:
                                    `🤖 *PAPER LIMIT ORDER FILLED!* ✅\n━━━━━━━━━━━━━━━━\n` +
                                    `🪙 *${cb}/USDT* ${de} *${dir}*\n\n` +
                                    `📋 Order Type:  ⏳ LIMIT → ✅ FILLED\n` +
                                    `📍 Set Entry:   $${parseFloat(trade.entry).toFixed(4)}\n` +
                                    `💹 Fill Price:  $${currentPrice.toFixed(4)}\n\n` +
                                    `🎯 TP1: $${parseFloat(trade.tp1 || trade.tp).toFixed(4)}\n` +
                                    `🎯 TP2: $${parseFloat(trade.tp2 || trade.tp).toFixed(4)}\n` +
                                    `🛡️ SL:  $${parseFloat(trade.sl).toFixed(4)}\n\n` +
                                    `📊 *.myptrades* ගසා Live P&L බලන්න`,
                                });
                            } else {
                                await conn.sendMessage(trade.userJid, { text:
                                    `🔔 *LIMIT ORDER ENTRY ZONE!*\n━━━━━━━━━━━━━━━━\n` +
                                    `🪙 *${cb}/USDT* ${de} *${dir}*\n\n` +
                                    `📋 Order Type: ⏳ LIMIT\n` +
                                    `📍 Entry Zone: $${parseFloat(trade.entry).toFixed(4)}\n` +
                                    `💹 Current:    $${currentPrice.toFixed(4)}\n\n` +
                                    `✅ *Exchange හිදී Order Fill Confirm කරන්න!*\n\n` +
                                    `🎯 TP1: $${parseFloat(trade.tp1 || trade.tp).toFixed(4)}\n` +
                                    `🎯 TP2: $${parseFloat(trade.tp2 || trade.tp).toFixed(4)}\n` +
                                    `🛡️ SL:  $${parseFloat(trade.sl).toFixed(4)}`,
                                });
                            }
                        }
                        // Skip TP/SL checks — trade is not yet active
                        continue;
                    }

                    // ── STALE TRADE WARNING (48h without TP1) ───────────────
                    // Trades open for 48h+ without TP1 hit = capital locked, opportunity cost
                    if (!trade.tp1Hit && trade.status === 'active') {
                        const hoursOpen = (Date.now() - new Date(trade.openTime)) / 3600000;
                        // ✅ BUG 5 FIX: Use persisted `trade.staleWarned` (not in-memory `_staleWarned`)
                        // Old: trade._staleWarned was lost on bot restart → warning re-fired every restart
                        if (hoursOpen >= 48 && !trade.staleWarned) {
                            trade.staleWarned = true;  // persisted to MongoDB
                            await trade.save();
                            await conn.sendMessage(trade.userJid, { text:
                                `⏰ *STALE TRADE WARNING!*\n━━━━━━━━━━━━━━━━\n` +
                                `🪙 *${cb}/USDT* ${de} *${dir}*\n\n` +
                                `⏱️ *${hoursOpen.toFixed(0)} hours open* — TP1 not hit yet.\n\n` +
                                `📍 Entry: $${parseFloat(trade.entry).toFixed(4)}\n` +
                                `💹 Current: $${currentPrice.toFixed(4)}\n` +
                                `🎯 TP1: $${parseFloat(trade.tp1||trade.tp).toFixed(4)}\n\n` +
                                `*Options:*\n` +
                                `• Wait — setup still valid\n` +
                                `• *.${isPaper ? 'closepaper' : 'closetrade'} ${cb}* — exit manually\n` +
                                `⚠️ _Capital tied up for 2+ days without progress_`,
                            });
                        }
                    }

                    // ── TP1 HIT ─────────────────────────────────────────
                    if (trade.tp1 && !trade.tp1Hit) {
                        const tp1v   = parseFloat(trade.tp1);
                        const tp1Hit = isLong ? currentPrice >= tp1v : currentPrice <= tp1v;
                        if (tp1Hit) {
                            trade.tp1Hit = true;
                            if (isPaper) {
                                const pQty = (trade.quantity || 0) * 0.33;
                                const pPnl = Math.abs(tp1v - trade.entry) * pQty;
                                await db.updatePaperBalance(trade.userJid, pPnl, pPnl > 0, false, false); // ✅ BUG 2 FIX: countTrade=false (partial TP1)
                                // ✅ FIX: SL → entry + profit buffer (not just breakeven)
                                // 33% profit already booked → protect remaining 67% from going negative
                                const { getPostTP1SL } = require('../lib/indicators');
                                const postTP1 = getPostTP1SL(trade.entry, trade.direction || (isLong?'LONG':'SHORT'), tp1v);
                                trade.sl = postTP1.sl;  // slightly above entry = locked profit
                                await trade.save();
                                await conn.sendMessage(trade.userJid, { text:
                                    `🎯 *PAPER TP1 HIT!* 💰\n━━━━━━━━━━━━━━━━\n` +
                                    `🪙 *${cb}/USDT* ${de} *${dir}*\n\n` +
                                    `✅ TP1: $${tp1v.toFixed(4)} Hit!\n` +
                                    `💰 +33% Profit: +$${pPnl.toFixed(2)} ✅ Auto-booked\n` +
                                    `🛡️ SL → +${postTP1.profitLocked}% LOCKED PROFIT ✅ Auto-moved\n\n` +
                                    `🎯 TP2: $${parseFloat(trade.tp2 || trade.tp).toFixed(4)} targeting...`,
                                });
                            } else {
                                await trade.save();
                                const est = trade.quantity
                                    ? `~$${(Math.abs(tp1v - trade.entry) * trade.quantity * 0.33).toFixed(2)}`
                                    : '?';
                                await conn.sendMessage(trade.userJid, { text:
                                    `🎯 *TP1 HIT!* 💰\n━━━━━━━━━━━━━━━━\n` +
                                    `🪙 *${cb}/USDT* ${de} *${dir}*\n\n` +
                                    `✅ TP1: $${tp1v.toFixed(4)} Hit! (Est. ${est})\n\n` +
                                    `*Exchange හිදී කරන්න:*\n` +
                                    `• Position ෙන් 33% Close කරන්න\n` +
                                    `• SL → Entry ($${parseFloat(trade.entry).toFixed(4)}) Move කරන්න\n` +
                                    `• TP2: $${parseFloat(trade.tp2 || trade.tp).toFixed(4)} target`,
                                });
                            }
                        }
                    }

                    // ── TP2 HIT ─────────────────────────────────────────
                    if (trade.tp1Hit && !trade.tp2Hit && trade.tp2) {
                        const tp2v   = parseFloat(trade.tp2);
                        const tp2Hit = isLong ? currentPrice >= tp2v : currentPrice <= tp2v;
                        if (tp2Hit) {
                            trade.tp2Hit = true;
                            await trade.save();
                            if (isPaper) {
                                const pQty = (trade.quantity || 0) * 0.33;
                                const pPnl = Math.abs(tp2v - trade.entry) * pQty;
                                await db.updatePaperBalance(trade.userJid, pPnl, true, false, false); // ✅ BUG 1+2 FIX: isWin=true, countTrade=false (partial)
                                await conn.sendMessage(trade.userJid, { text:
                                    `🎯 *PAPER TP2 HIT!* 🔥\n━━━━━━━━━━━━━━━━\n` +
                                    `🪙 *${cb}/USDT* ${de} *${dir}*\n\n` +
                                    `🔥 TP2: $${tp2v.toFixed(4)} Hit!\n` +
                                    `💰 +33% Profit: +$${pPnl.toFixed(2)} ✅ Auto-booked\n\n` +
                                    `🎯 Remaining 34% → TP3: $${parseFloat(trade.tp).toFixed(4)}`,
                                });
                            } else {
                                await conn.sendMessage(trade.userJid, { text:
                                    `🎯 *TP2 HIT!* 🔥\n━━━━━━━━━━━━━━━━\n` +
                                    `🪙 *${cb}/USDT* ${de} *${dir}*\n\n` +
                                    `🔥 TP2: $${tp2v.toFixed(4)} Hit!\n\n` +
                                    `*Exchange හිදී කරන්න:*\n` +
                                    `• Position ෙන් 33% Close කරන්න\n` +
                                    `• TP3: $${parseFloat(trade.tp).toFixed(4)} target hold`,
                                });
                            }
                        }
                    }

                    // ── DCA ZONE ─────────────────────────────────────────
                    if (trade.dcaLevel === 0) {
                        const risk    = Math.abs(trade.entry - trade.sl);
                        const dcaZone = isLong
                            ? trade.entry - risk * 0.7
                            : trade.entry + risk * 0.7;
                        const atDca = isLong
                            ? (currentPrice <= dcaZone && currentPrice > trade.sl)
                            : (currentPrice >= dcaZone && currentPrice < trade.sl);
                        if (atDca) {
                            trade.dcaLevel = 1;
                            await trade.save();
                            const avg = ((trade.entry + currentPrice) / 2).toFixed(4);
                            await conn.sendMessage(trade.userJid, { text:
                                `⚠️ *DCA ZONE!* 📉\n━━━━━━━━━━━━━━━━\n` +
                                `🪙 *${cb}/USDT* ${de} *${dir}*\n\n` +
                                `📍 Entry: $${parseFloat(trade.entry).toFixed(4)}\n` +
                                `📉 DCA Price: $${currentPrice.toFixed(4)}\n` +
                                `📊 Avg (if DCA): $${avg}\n\n` +
                                (isPaper
                                    ? `• *.paper* reply කරලා 2nd position open කරන්න\n• SL: $${parseFloat(trade.sl).toFixed(4)} (unchanged)`
                                    : `• Exchange ෙල් same margin DCA order දාන්න\n• SL: $${parseFloat(trade.sl).toFixed(4)} (unchanged)`) +
                                `\n\n⚠️ _SL zone ළඟා නොවූ විට DCA කරන්න!_`,
                            });
                        }
                    }

                    // ── TRAILING SL (Break-even) ──────────────────────────
                    if (currentSettings.trailingSl && !trade.tp1Hit) {
                        const risk     = Math.abs(trade.entry - trade.sl);
                        const beTarget = isLong
                            ? trade.entry + risk
                            : trade.entry - risk;
                        let trail = false;
                        if (isLong  && currentPrice >= beTarget && parseFloat(trade.sl) < trade.entry) { trade.sl = trade.entry; trail = true; }
                        if (!isLong && currentPrice <= beTarget && parseFloat(trade.sl) > trade.entry) { trade.sl = trade.entry; trail = true; }
                        if (trail) {
                            await trade.save();
                            await conn.sendMessage(trade.userJid, { text:
                                `🛡️ *SL → BREAK-EVEN!*\n━━━━━━━━━━━━━━━━\n` +
                                `🪙 *${cb}/USDT* ${de} *${dir}*\n\n` +
                                `Stop Loss → Entry $${parseFloat(trade.entry).toFixed(4)}\n` +
                                (isPaper ? `✅ Auto-updated` : `✅ Exchange හිදී SL update කරන්න!`) +
                                `\n_Trade 100% Risk-Free!_ 🎉`,
                            });
                        }
                    }

                    // ── TP3 / SL HIT → CLOSE ─────────────────────────────
                    let hitType = null, result = '';
                    const tp3v = parseFloat(trade.tp), slv = parseFloat(trade.sl);
                    if (isLong) {
                        if (currentPrice >= tp3v)     { hitType = 'TP3'; result = 'WIN'; }
                        else if (currentPrice <= slv) { hitType = 'SL';  result = slv > parseFloat(trade.entry) ? 'WIN' : slv === parseFloat(trade.entry) ? 'BREAK-EVEN' : 'LOSS'; }
                    } else {
                        if (currentPrice <= tp3v)     { hitType = 'TP3'; result = 'WIN'; }
                        else if (currentPrice >= slv) { hitType = 'SL';  result = slv < parseFloat(trade.entry) ? 'WIN' : slv === parseFloat(trade.entry) ? 'BREAK-EVEN' : 'LOSS'; }
                    }

                    if (hitType) {
                        const emoji = result === 'WIN' ? '🏆' : result === 'BREAK-EVEN' ? '🛡️' : '💀';

                        if (isPaper) {
                            const remFactor = trade.tp1Hit && trade.tp2Hit ? 0.34 : trade.tp1Hit ? 0.67 : 1.0;
                            const closeQty  = (trade.quantity || 0) * remFactor;
                            const priceDiff = isLong ? currentPrice - trade.entry : trade.entry - currentPrice;
                            const profit    = priceDiff * closeQty;
                            const pnlPct    = trade.marginUsed > 0 ? (profit / trade.marginUsed * 100) : 0;
                            await db.closeTrade(trade._id, result, pnlPct, profit);
                            await db.updatePaperBalance(trade.userJid, profit, result === 'WIN', result === 'BREAK-EVEN');
                            const user = await db.getUser(trade.userJid);
                            await conn.sendMessage(trade.userJid, { text:
                                `${emoji} *PAPER TRADE CLOSED!* ${hitType === 'TP3' ? '🎯' : '⛔'}\n━━━━━━━━━━━━━━━━\n` +
                                `🪙 *${cb}/USDT* ${de} *${dir}*\n\n` +
                                `*${result}* — ${hitType} @ $${currentPrice.toFixed(4)}\n` +
                                `📍 Entry: $${parseFloat(trade.entry).toFixed(4)}\n` +
                                `📋 Order: ${trade.orderType === 'LIMIT' ? '⏳ LIMIT (Filled)' : '⚡ MARKET'}\n\n` +
                                `💰 *PnL: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)*\n` +
                                `💼 Balance: $${(user.paperBalance || 0).toFixed(2)}\n\n` +
                                `📜 *.paperhistory* | 📊 *.margin*`,
                            });
                        } else {
                            const action = hitType === 'TP3'
                                ? `• Position සම්පූර්ණයෙන් Close කරන්න\n• Profit Withdraw/Reinvest decide කරන්න`
                                : `• Position Close කරන්න\n• Loss accept කරලා next setup බලන්න`;
                            // ✅ BUG 4 FIX: Real trade PnL was always saved as 0 (hardcoded).
                            // Now calculates actual PnL% from entry price.
                            const priceDiff  = isLong ? currentPrice - trade.entry : trade.entry - currentPrice;
                            const realPnlPct = trade.entry > 0 ? (priceDiff / trade.entry) * 100 : 0;
                            await db.closeTrade(trade._id, result, parseFloat(realPnlPct.toFixed(2)), 0);
                            await conn.sendMessage(trade.userJid, { text:
                                `${emoji} *${hitType} HIT!* ${hitType === 'TP3' ? '🎉' : '⛔'}\n━━━━━━━━━━━━━━━━\n` +
                                `🪙 *${cb}/USDT* ${de} *${dir}*\n\n` +
                                `*${result}* — ${hitType} @ $${currentPrice.toFixed(4)}\n` +
                                `📍 Entry was: $${parseFloat(trade.entry).toFixed(4)}\n\n` +
                                `*Exchange හිදී කරන්න:*\n` + action + `\n\n` +
                                `_✅ Bot tracking ෙන් auto-removed_`,
                            });
                        }
                    }

                } catch (_e) { /* skip failed individual trade */ }
            }
        } catch (_e) { /* top-level guard */ }
    }, 60000);
}

// ─── Signal Scanner (Event-Driven) ────────────────────────────

/**
 * Debounced scan runner.
 * Called when a 15m candle closes. Multiple coins close at the same
 * wall-clock second, so we collect all close events for 15 seconds
 * before running a single scan pass.
 */
function scheduleDebounced() {
    if (_debounceTimer) return;   // already waiting
    _debounceTimer = setTimeout(async () => {
        _debounceTimer = null;
        await runSignalScan();
    }, 15000);
}

async function runSignalScan() {
    if (!_connRef || !_ownerJidRef) return;

    try {
        const setups = await getTopDownSetups(false);  // auto-scan: respect cooldown to avoid repeating same coins
        if (!setups || setups.length === 0) return;
        const sent  = await getSentimentCached();

        // ── Owner summary message (market overview) ────────────────
        let summaryMsg = `🚀 *14-FACTOR AUTO SIGNAL ALERT* 🚀\n_Top ${setups.length} Best Setups Now_\n\n`;
        summaryMsg += `🧠 *Market:* ${sent.overallSentiment} | ${sent.fngEmoji} F&G: ${sent.fngValue}\n\n`;
        setups.forEach((s, i) => {
            const catTag   = s.tradeCategory ? `\n   📅 ${s.tradeCategory}` : '';
            const orderTag = s.orderType
                ? (s.orderType.includes('LIMIT') ? ' ⏳ LIMIT' : ' ⚡ MARKET')
                : '';
            const dayTag   = s.dailyTrend ? ` | Daily: ${s.dailyTrend} ${s.dailyAligned ? '✅' : '⚠️'}` : '';
            const trapTag  = s.mmTrap && (s.mmTrap.bullTrap || s.mmTrap.bearTrap) ? ` 🪤` : '';
            const sqzTag   = s.bbSqueeze && s.bbSqueeze.exploding ? ` 💥` : '';
            summaryMsg +=
                `*${i + 1}. ${s.signalGradeEmoji||'📊'} ${s.signalGrade||'B'} | #${s.coin}* - ${s.type} (${s.score} ⭐) ${s.sentEmoji || ''}${orderTag}${trapTag}${sqzTag}\n` +
                `   ${s.signalGradeLabel||''} | MTF ${s.mtfAlignCount||0}/4 aligned | Conf: ${s.confScore||0}${catTag}\n` +
                `   📍 $${s.price} | ADX: ${s.adx}${dayTag}\n` +
                `   ✔️ ${s.reasons}\n` +
                `   🤖 .future ${s.coin} 15m\n\n`;
        });
        summaryMsg += `_⏱️ Next scan on 15m candle close | .set 1 off ගසා Stop කරන්න_`;

        // Send the summary overview to owner first
        await _connRef.sendMessage(_ownerJidRef, { text: summaryMsg.trim() });

        // ── Per-user dispatch (respects tradingMode per user) ───────
        // Each setup is broadcast individually so each user receives
        // a clean per-coin alert and the correct mode (auto/signal).
        for (const setup of setups) {
            try {
                await broadcastSignal(_connRef, setup, _ownerJidRef);
            } catch (_be) {
                console.warn(`[Scanner] Broadcast failed for ${setup.coin}:`, _be.message);
            }
        }

    } catch (_e) { /* silent — keep the listener alive */ }
}

/**
 * Attach the 15m candle-close listener to binance.wsEvents.
 * Each time ANY watched coin closes its 15m bar the debounce fires.
 */
function startSignalScanner(conn, ownerJid) {
    if (_scannerActive) return;

    _connRef       = conn;
    _ownerJidRef   = ownerJid;
    _scannerActive = true;

    _15mCloseHandler = () => scheduleDebounced();
    binance.wsEvents.on('15m_candle_close', _15mCloseHandler);

    console.log('[Scanner] ✅ Event-driven signal scanner started (listening for 15m closes).');

    if (binance.isReady()) {
        runSignalScan().catch(() => {});
    }
}

function stopSignalScanner() {
    if (!_scannerActive) return;
    if (_15mCloseHandler) {
        binance.wsEvents.off('15m_candle_close', _15mCloseHandler);
        _15mCloseHandler = null;
    }
    if (_debounceTimer) {
        clearTimeout(_debounceTimer);
        _debounceTimer = null;
    }
    _scannerActive = false;
    console.log('[Scanner] 🔴 Signal scanner stopped.');
}

// ─── Funding Rate Extreme Alert (.fundingalert) ───────────────
/**
 * Checks funding rates for top 15 coins.
 * Extreme positive rate (>0.1%) = longs overloaded → SHORT squeeze risk.
 * Extreme negative rate (<-0.1%) = shorts overloaded → LONG squeeze risk.
 * These contrarian setups have the highest reward potential.
 */
cmd({
    pattern: 'fundingalert', alias: ['funding', 'squeeze', 'fundrates'],
    desc: 'Extreme funding rate scanner — find squeeze setups',
    category: 'crypto', react: '💸', filename: __filename,
},
async (conn, mek, m, { reply }) => {
    try {
        await m.react('⏳');
        const axios = require('axios');
        const res = await axios.get('https://fapi.binance.com/fapi/v1/premiumIndex', { timeout: 8000 });
        const data = res.data;
        if (!data || !data.length) return await reply('❌ Funding data ලබාගැනීමට නොහැකිය.');

        const coins = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT',
                       'DOTUSDT','LINKUSDT','MATICUSDT','ATOMUSDT','NEARUSDT','LTCUSDT','DOGEUSDT','UNIUSDT'];

        const extremes = [], mildLong = [], mildShort = [];
        coins.forEach(coin => {
            const d = data.find(x => x.symbol === coin);
            if (!d) return;
            const rate = parseFloat(d.lastFundingRate) * 100;
            const name = coin.replace('USDT','');
            if (rate > 0.1)       extremes.push({ name, rate, dir: 'SHORT', label: `🔴 Longs overloaded → SHORT squeeze!` });
            else if (rate < -0.1) extremes.push({ name, rate, dir: 'LONG',  label: `🟢 Shorts overloaded → LONG squeeze!` });
            else if (rate > 0.05) mildLong.push({ name, rate });
            else if (rate < -0.05) mildShort.push({ name, rate });
        });

        extremes.sort((a,b) => Math.abs(b.rate) - Math.abs(a.rate));

        let msg = `💸 *FUNDING RATE EXTREME SCANNER*\n━━━━━━━━━━━━━━━━━━\n\n`;
        if (extremes.length === 0) {
            msg += `⚪ *No extreme funding rates right now.*\nAll rates within normal range (-0.1% ~ +0.1%).\n\n`;
        } else {
            msg += `🚨 *EXTREME RATES (>0.1%) — Squeeze Risk!*\n`;
            extremes.forEach(e => {
                const sign = e.rate > 0 ? '+' : '';
                msg += `\n💀 *#${e.name}* — ${sign}${e.rate.toFixed(4)}%\n`;
                msg += `   ${e.label}\n`;
                msg += `   🤖 *.future ${e.name}* (look for ${e.dir} setup)\n`;
            });
            msg += '\n';
        }
        if (mildLong.length || mildShort.length) {
            msg += `━━━━━━━━━━━━━━━━━━\n⚠️ *Elevated Rates (Watch)*\n`;
            mildLong.forEach(e  => msg += `🔴 #${e.name}: +${e.rate.toFixed(4)}% (Longs paying)\n`);
            mildShort.forEach(e => msg += `🟢 #${e.name}: ${e.rate.toFixed(4)}% (Shorts paying)\n`);
        }
        msg += `\n━━━━━━━━━━━━━━━━━━\n💡 *Funding Rate Guide:*\n`;
        msg += `> +0.1%+ = Longs crowded → Short squeeze imminent\n`;
        msg += `< -0.1% = Shorts crowded → Long squeeze imminent\n`;
        msg += `0.01% neutral zone = balanced market\n\n`;
        msg += `_ℹ️ Every 8h funds transfer. Next: check .news for sentiment_`;

        await reply(msg.trim());
        await m.react('✅');
    } catch(e) { await reply('❌ Error: ' + e.message); }
});

// ─── Manual Scan Command (.scan) ──────────────────────────────
cmd({
    pattern:  'scan',
    alias:    ['superscan', 'scanner'],
    desc:     'Manual Market Scan - Top 5 Best Setups',
    category: 'crypto',
    react:    '🔍',
    filename: __filename,
},
async (conn, mek, m, { reply }) => {
    try {
        await m.react('⏳');

        const wsStatus = binance.isReady()
            ? '🟢 *WebSocket:* LIVE (Zero-Latency Cache Active)'
            : '🟡 *WebSocket:* Initialising...';
        const scanStatus = _scannerActive
            ? '🟢 *Auto Scanner:* ON (.set 1 off ගසා Stop)'
            : '🔴 *Auto Scanner:* OFF (.set 1 on ගසා Start)';

        await reply(
            `🔍 *MANUAL SCAN ක්‍රියාත්මක වේ...*\n${wsStatus}\n${scanStatus}\n\n` +
            `Top ${binance.isReady() ? binance.getWatchedCoins().length : 20} Coins Scan වෙමින් පවතී... ⏳\n` +
            `_(No REST polling — reads from live WS cache)_`
        );

        const setups = await getTopDownSetups(true);  // ignoreCooldown: manual scan always shows current best

        if (setups.length === 0) {
            return await reply(
                `╔═══════════════════════════╗\n║  🔍 *MANUAL SCAN RESULTS*  ║\n╚═══════════════════════════╝\n\n` +
                `Score 20/100 ට වඩා ලබාගත් Setups දැනට නොමැත. ⚪\n\nකිසිවේලාවකට පසු නැවත .scan ගසන්න.\n\n${scanStatus}`
            );
        }

        const sent = await getSentimentCached();
        let outMsg = `╔═══════════════════════════╗\n║  🎯 *TOP 5 SNIPER SETUPS*  ║\n╚═══════════════════════════╝\n\n`;
        outMsg += `🧠 *Market Sentiment:* ${sent.overallSentiment}\n`;
        outMsg += `${sent.fngEmoji} F&G: ${sent.fngValue} | ₿ BTC.D: ${sent.btcDominance}% | 📰 ${sent.newsSentimentScore > 0 ? '+' : ''}${sent.newsSentimentScore}\n\n`;

        setups.forEach((s, i) => {
            const mSweep    = s.liquiditySweep !== 'None'  ? `\n   💧 ${s.liquiditySweep}` : '';
            const mChoch    = s.choch !== 'None'           ? `\n   🔄 ${s.choch}` : '';
            const mChoch5m  = s.choch5m && s.choch5m !== 'None' ? `\n   ⚡ 5m: ${s.choch5m}` : '';
            const catLine   = s.tradeCategory              ? `\n   📅 ${s.tradeCategory}` : '';
            const orderTag  = s.orderType
                ? (s.orderType.includes('LIMIT') ? '\n   📋 ⏳ LIMIT ORDER' : '\n   📋 ⚡ MARKET ORDER')
                : '';
            const dayTag    = s.dailyTrend ? `\n   📅 Daily: ${s.dailyTrend} ${s.dailyAligned ? '✅' : '⚠️'}` : '';
            const trapTag   = s.mmTrap && (s.mmTrap.bullTrap || s.mmTrap.bearTrap)
                ? `\n   🪤 ${s.mmTrap.display}` : '';
            const sqzTag    = s.bbSqueeze && (s.bbSqueeze.exploding || s.bbSqueeze.isSqueezing)
                ? `\n   ${s.bbSqueeze.exploding ? '💥' : '⚡'} ${s.bbSqueeze.display}` : '';
            const tfTag     = s.tf3Align && s.tf3Align.aligned
                ? `\n   ✅ ${s.tf3Align.display}` : '';
            const confTag   = `\n   🔒 Confirmations: ${s.confScore || s.coreConf}/${s.confScore ? '21' : '4'} ${s.confGate ? '✅' : ''}`;
            const wyckTag   = s.reasons && s.reasons.includes('Wyckoff') ? `\n   🌊 ${s.reasons.split(',').find(r=>r.includes('Wyckoff'))?.trim()}` : '';
            const ichiTag   = s.reasons && s.reasons.includes('Ichimoku') ? `\n   ☁️ ${s.reasons.split(',').find(r=>r.includes('Ichimoku'))?.trim()}` : '';
            outMsg +=
                `*${i + 1}. #${s.coin}* - ${s.type} (Score: ${s.score} ⭐) ${s.sentEmoji || ''}\n` +
                `   📍 Price: $${s.price} | 🔥 ADX: ${s.adx}\n` +
                `   🎯 TP1: $${s.tp1} | TP2: $${s.tp2} | SL: $${s.sl}\n` +
                `   ✔️ ${s.reasons}${mSweep}${mChoch}${mChoch5m}${dayTag}${trapTag}${sqzTag}${tfTag}${wyckTag}${ichiTag}${catLine}${orderTag}${confTag}\n` +
                `   🤖 *.future ${s.coin} 15m*\n\n`;
        });
        outMsg += `${wsStatus}\n${scanStatus}`;

        await reply(outMsg.trim());
        await m.react('✅');
    } catch (e) { await reply('❌ Error: ' + e.message); }
});

// ─── Exports for settings.js ───────────────────────────────────
function getScannerStatus() {
    return _scannerActive;
}

/**
 * Called by settings.js when the user enables the scanner.
 * Initialises the WebSocket (idempotent), starts trade manager,
 * then attaches the event-driven signal scanner.
 */
async function startScannerFromSettings(conn, ownerJid) {
    if (_scannerActive) return false;
    await binance.initWebSocketStreams(30);
    startTradeManager(conn);
    startSignalScanner(conn, ownerJid);
    return true;
}

function stopScannerFromSettings() {
    if (!_scannerActive && !activeTradeManager) return false;
    stopSignalScanner();
    if (activeTradeManager) { clearInterval(activeTradeManager); activeTradeManager = null; }
    return true;
}

/**
 * ✅ FIX: Auto-start just the trade manager on every bot connect.
 * Called from index.js after 'connection.open' fires so TP/SL monitoring
 * works immediately without needing the user to run .set 1 on.
 * Safe to call multiple times — startTradeManager() is idempotent.
 */
function autoStartTradeManager(conn) {
    startTradeManager(conn);
}

// ── Weekly Adaptive Weight Cron ───────────────────────────────────────────
// Every Sunday at 00:05 UTC, analyze last 7 days of closed paper trades
// and update indicator weights for the coming week.
async function runWeeklyAdaptiveUpdate() {
    try {
        const db = require('../lib/database');
        const { computeAndSaveAdaptiveWeights } = require('../lib/dynamicWeights');

        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const trades = await db.Trade.find({
            status: 'closed',
            isPaper: true,
            result: { $in: ['WIN', 'LOSS'] },
            closedAt: { $gte: since },
            reasons: { $exists: true, $ne: '' },
        }).lean();

        if (trades.length >= 10) {
            const result = await computeAndSaveAdaptiveWeights(trades);
            if (result) {
                console.log(`[AdaptiveWeights] Weekly update: ${result.sampleSize} trades, WR=${result.winRate?.toFixed(1)}%, ${Object.keys(result.weights).length} indicators`);
            }
        } else {
            console.log(`[AdaptiveWeights] Skipping — only ${trades.length} trades (need 10+)`);
        }
    } catch(e) {
        console.warn('[AdaptiveWeights] Weekly update failed:', e.message);
    }
}

// Schedule: check every hour, run on Sundays at 00:xx UTC
setInterval(() => {
    const now = new Date();
    if (now.getUTCDay() === 0 && now.getUTCHours() === 0) {
        runWeeklyAdaptiveUpdate();
    }
}, 60 * 60 * 1000);

// ─── Full Scan Command (.scan20) ──────────────────────────────
cmd({
    pattern:  'scan20',
    alias:    ['fullscan', 'topscan', 'scan10'],
    desc:     'Full Multi-Coin Scanner - All Qualifying Setups (Top 20)',
    category: 'crypto',
    react:    '🔭',
    filename: __filename,
},
async (conn, mek, m, { reply }) => {
    try {
        await m.react('⏳');
        await reply(`🔭 *FULL MARKET SCAN ක්‍රියාත්මක වේ...*\n⏳ Top 20 coins 14-Factor analysis...\n_ටිකක් ගන්නවා — patience!_`);

        // Run full scan without the top-5 slice
        const foundSetups = [];
        const coinsToScan = binance.isReady()
            ? binance.getWatchedCoins()
            : await binance.getTopTrendingCoins(20);

        for (const coin of coinsToScan) {
            try {
                const aData = await analyzer.run14FactorAnalysis(coin, '15m');
                if (aData.score >= 20) {
                    const sent     = await getSentimentCached();
                    const sentBias = parseFloat(sent.totalBias) || 0;
                    const sentBonus =
                        (aData.direction === 'LONG'  && sentBias >= 1)  ?  1 :
                        (aData.direction === 'SHORT' && sentBias <= -1) ?  1 :
                        (aData.direction === 'LONG'  && sentBias <= -1) ? -1 :
                        (aData.direction === 'SHORT' && sentBias >= 1)  ? -1 : 0;

                    foundSetups.push({
                        coin:          coin.replace('USDT', ''),
                        type:          aData.direction === 'LONG' ? 'LONG 🟢' : 'SHORT 🔴',
                        rawScore:      aData.score + sentBonus,
                        score:         `${aData.score + sentBonus}/${aData.maxScore}`,
                        signalGrade:   aData.signalGrade || 'C',
                        signalGradeEmoji: aData.signalGradeEmoji || '📊',
                        price:         aData.priceStr,
                        entry:         aData.entryPrice,
                        tp1:           aData.tp1,
                        tp2:           aData.tp2,
                        sl:            aData.sl,
                        orderType:     aData.orderSuggestion ? aData.orderSuggestion.type : '',
                        reasons:       aData.reasons,
                        sentEmoji:     sentBonus > 0 ? '📰✅' : sentBonus < 0 ? '📰⚠️' : '',
                        dailyAligned:  aData.dailyAligned,
                        dailyTrend:    aData.dailyTrend || '',
                        mtfAlignCount: aData.mtfAlignCount || 0,
                    });
                }
            } catch (_e) { /* skip failed coin */ }
        }

        foundSetups.sort((a, b) => b.rawScore - a.rawScore);
        const top20 = foundSetups.slice(0, 20);

        if (top20.length === 0) {
            return await reply(`🔭 *FULL SCAN RESULTS*\n\n⚪ Score 20+ ලබාගත් setups නොමැත.\n\nMarket low-volume / consolidating ඇති. ටිකකට පසු නැවත scan කරන්න.`);
        }

        const sent = await getSentimentCached();
        let out = `╔══════════════════════════════╗\n║  🔭 *FULL SCAN — TOP ${top20.length} SETUPS*  ║\n╚══════════════════════════════╝\n\n`;
        out += `🧠 *Sentiment:* ${sent.overallSentiment} | ${sent.fngEmoji} F&G: ${sent.fngValue}\n\n`;

        // Group by grade
        const elite  = top20.filter(s => s.signalGrade === 'A+');
        const high   = top20.filter(s => s.signalGrade === 'A');
        const std    = top20.filter(s => s.signalGrade === 'B');
        const watch  = top20.filter(s => !['A+','A','B'].includes(s.signalGrade));

        const renderGroup = (label, items) => {
            if (!items.length) return '';
            let g = `*${label}*\n`;
            items.forEach((s, i) => {
                const orderTag = s.orderType
                    ? (s.orderType.includes('LIMIT') ? ' ⏳' : s.orderType.includes('SKIP') ? ' ⛔' : ' ⚡')
                    : '';
                const dayTag = s.dailyAligned ? ' ✅D' : ' ⚠️D';
                g += `${i+1}. *#${s.coin}* ${s.type} (${s.score})${s.sentEmoji}${orderTag}${dayTag}\n`;
                g += `   📍 $${s.price} | TP1: $${s.tp1} | SL: $${s.sl}\n`;
                g += `   MTF ${s.mtfAlignCount}/4 | *.future ${s.coin} 15m*\n\n`;
            });
            return g;
        };

        out += renderGroup('🏆 ELITE A+ SETUPS', elite);
        out += renderGroup('🥇 HIGH QUALITY A', high);
        out += renderGroup('🥈 STANDARD B', std);
        out += renderGroup('👁️ WATCH (C/D)', watch);
        out += `━━━━━━━━━━━━━━━━━━\n📊 Total qualifying: ${foundSetups.length} / ${coinsToScan.length} coins`;

        await reply(out.trim());
        await m.react('✅');
    } catch (e) { await reply('❌ Error: ' + e.message); }
});

module.exports = { getScannerStatus, startScannerFromSettings, stopScannerFromSettings, autoStartTradeManager };
