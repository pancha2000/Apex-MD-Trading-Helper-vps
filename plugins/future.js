const { cmd } = require('../lib/commands');
const config = require('../config');
const axios = require('axios');
const db = require('../lib/database');
const binance = require('../lib/binance');
const analyzer = require('../lib/analyzer'); // ✅ අලුත් මොළය සම්බන්ධ කළා
const { checkRRR } = require('../lib/indicators');
const confirmations = require('../lib/confirmations_lib');

cmd({
    pattern: "future",
    alias: ["futures"],
    desc: "Ultimate Futures AI - 14-Factor MTF + Harmonic + ICT + Whale Walls + Grid",
    category: "crypto",
    react: "🔴",
    filename: __filename
},
async (conn, mek, m, { reply, args }) => {
    try {
        if (!args[0]) return await reply(`❌ Coin ලබා දෙන්න!\n*උදා:* ${config.PREFIX}future BTC 15m`);
        if (!config.GROQ_API) return await reply('❌ GROQ_API key නැහැ!');

        let coin = args[0].toUpperCase();
        if (!coin.endsWith('USDT')) coin += 'USDT';
        let timeframe = args[1] ? args[1].toLowerCase() : '15m';

        // ✅ Stablecoin filter — no trading on pegged assets
        const STABLECOINS = ['USDCUSDT','BUSDUSDT','DAIUSDT','TUSDUSDT','USDPUSDT','FRAXUSDT','LUSDUSDT','USTCUSDT','EURUSDT','GBPUSDT'];
        if (STABLECOINS.includes(coin)) {
            return await reply(`❌ *${coin.replace('USDT','')} Stablecoin!*\n\nStablecoins trade කරන්න බෑ — price $1 ලඟ peg වෙලා.\nReal crypto coin ලබා දෙන්න (BTC, ETH, SOL, ...)`);
        }

        await m.react('⏳');
        await reply(`⏳ *${coin} Full 14-Factor Analysis...*\n(MTF + Whale Walls + Harmonic + True Choppy Detection ⚙️)`);

        // 🧠 1. Analyzer එකෙන් Data ගැනීම (කලින් පේළි 100ක වැඩේ එක පේළියෙන්)
        const aData = await analyzer.run14FactorAnalysis(coin, timeframe);
        // 🌐 Parallel fetch - all external data at once, each with 12s timeout
        // ✅ FIX: Individual .catch() — one API fail won't abort the entire analysis
        const withTimeout = (p, ms, fallback) =>
            Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);

        const [liqData, whaleWalls, fundingRate, sentiment] = await Promise.all([
            withTimeout(binance.getLiquidationData(coin),  12000, { sentiment: 'N/A', liqLevel: 'N/A' }),
            withTimeout(binance.getLiquidityWalls(coin),   12000, { supportWall: 'N/A', resistWall: 'N/A', supportVol: 'N/A', resistVol: 'N/A' }),
            withTimeout(binance.getFundingRate(coin),      10000, 'N/A'),
            withTimeout(binance.getMarketSentiment(coin),  12000, {
                fngValue: 50, fngLabel: 'Neutral', fngEmoji: '⚪',
                btcDominance: '50.0', newsSentimentScore: 0, coinNewsHits: 0,
                newsHeadlines: [], overallSentiment: '⚪ NEUTRAL',
                tradingBias: 'Neutral', totalBias: '0',
                summary: 'Market data unavailable'
            }),
        ]);

        // 🔬 8-Factor Entry Confirmation with 20s timeout
        // ✅ FIX: Timeout prevents 8 external APIs from hanging the analysis
        const confFallback = {
            totalScore: 0, confirmationStrength: 'N/A',
            display: '⚪ Confirmation data unavailable (timeout)',
            usdtDom: { signal: 'N/A' }, oiChange: { signal: 'N/A' },
            cvd: { signal: 'N/A' }, btcCorr: { signal: 'N/A' },
            pcr: { signal: 'N/A' }, netflow: { signal: 'N/A' }
        };
        const entryConf = await Promise.race([
            confirmations.runAllConfirmations(coin, aData.direction, config.LUNAR_API || null),
            new Promise(r => setTimeout(() => r(confFallback), 20000))
        ]);

        // ⚙️ 2. Settings & RRR Filter
        const settings = await db.getSettings();
        const rrrCheck = checkRRR(aData.entryPrice, aData.tp2, aData.sl, settings.minRRR || 1.5);
        
        const riskAmount = Math.abs(parseFloat(aData.entryPrice) - parseFloat(aData.sl));
        const rrrVal = riskAmount > 0 ? (Math.abs(parseFloat(aData.tp2) - parseFloat(aData.entryPrice)) / riskAmount) : 0;
        const rrrStr = rrrVal.toFixed(2);

        if (settings.strictMode && aData.score < 5 && !aData.isTrueChoppy) {
            return await reply(`⛔ *TRADE REJECTED - Strict Mode* ⛔\n🪙 ${coin} | ${aData.direction}\n⭐ Score: ${aData.score}/${aData.maxScore}\n❌ *හේතුව:* Confluence Score එක ඉතා අඩුයි.`);
        }

        if (!rrrCheck.pass && settings.strictMode && !aData.isTrueChoppy) {
            return await reply(`⛔ *TRADE REJECTED - RRR Filter*\n\n🪙 ${coin} | ${aData.direction}\n📍 Entry: $${aData.entryPrice} | TP: $${aData.tp2} | SL: $${aData.sl}\n\n${rrrCheck.reason}\n💡 Setup දුර්වලයි. TP zone වෙනස් වෙනකල් wait කරන්න.`);
        }

        // 💰 3. Position Sizing — Binance Risk-Based Formula
        const userMargin = await db.getMargin(m.sender) || 0;
        let levText = "Set .margin first", riskText = "—", marginText = "—", qtyText = "—";
        let calcLeverage = 10, calcQty = 0, calcMarginUsed = 0, calcRiskAmt = 0;
        let marginWarning = "";

        // ── Pro Mode: check for manual margin/leverage override ──────
        const _proOn        = config.modules.PRO_MODE;
        const _manualMargin = _proOn ? config.proParams.MANUAL_MARGIN   : 0;
        const _manualLev    = _proOn ? config.proParams.MANUAL_LEVERAGE : 0;
        // Use manual margin if set, otherwise fall back to wallet margin
        const _baseMargin   = (_proOn && _manualMargin > 0) ? _manualMargin : userMargin;
        const _proModeTag   = _proOn
            ? `\n🔬 _Pro Custom Mode — RSI:${config.proParams.RSI_PERIOD} EMA:${config.proParams.FAST_EMA}/${config.proParams.SLOW_EMA}${_manualMargin > 0 ? ' | Manual Margin: $' + _manualMargin : ''}${_manualLev > 0 ? ' | Lev: ' + _manualLev + 'x' : ''}_`
            : '';

        if (_baseMargin > 0) {
            const entryNum  = parseFloat(aData.entryPrice);
            const slNum     = parseFloat(aData.sl);
            const slDist    = Math.abs(entryNum - slNum);
            const slDistPct = slDist / entryNum;

            calcRiskAmt = _baseMargin * 0.02;
            calcQty     = slDist > 0 ? calcRiskAmt / slDist : 0;

            if (_proOn && _manualLev > 0) {
                // Pro Mode: use manually-set leverage
                calcLeverage   = _manualLev;
                calcMarginUsed = calcQty > 0 ? (calcQty * entryNum) / calcLeverage : 0;
            } else {
                // Auto AI Mode: derive optimal leverage from SL distance
                const rawLev   = slDistPct > 0 ? (calcRiskAmt / slDistPct) / (_baseMargin * 0.10) : 10;
                calcLeverage   = Math.min(Math.ceil(rawLev), 100);
                calcMarginUsed = calcQty > 0 ? (calcQty * entryNum) / calcLeverage : 0;
            }

            // Cap marginUsed to 20% of capital per trade (5 slots max)
            const maxMarginPerTrade = _baseMargin * 0.20;
            if (calcMarginUsed > maxMarginPerTrade) {
                const scale    = maxMarginPerTrade / calcMarginUsed;
                calcQty       *= scale;
                calcMarginUsed = maxMarginPerTrade;
                calcRiskAmt    = slDist * calcQty;
                marginWarning  = "\n⚠️ *Position capped to 20% of capital* (SL ඉතා ළඟ - " + (slDistPct*100).toFixed(3) + "%)";
            }

            if (calcMarginUsed > _baseMargin) {
                marginWarning = "\n❌ *Margin Insufficient!* Balance: $" + _baseMargin.toFixed(2) + " | Needed: $" + calcMarginUsed.toFixed(2);
                calcQty = 0; calcMarginUsed = 0;
            }

            if (calcQty > 0) {
                const qtyFmt = calcQty < 1 ? calcQty.toFixed(4) : Math.round(calcQty).toString();
                riskText   = "$" + calcRiskAmt.toFixed(2);
                marginText = "$" + calcMarginUsed.toFixed(2) + (_proOn && _manualMargin > 0 ? ' 🔬' : '');
                levText    = calcLeverage + "x (Iso)" + (_proOn && _manualLev > 0 ? ' 🔬' : '');
                qtyText    = qtyFmt + " " + coin.replace('USDT','');
            } else {
                qtyText = "Insufficient balance";
            }
        }

        // ✅ Sentiment Confirmation
        const sentimentBoost = parseFloat(sentiment.totalBias) > 1 ? '✅ CONFIRMED (Sentiment aligned)' :
                               parseFloat(sentiment.totalBias) < -1 ? '⛔ CONFLICTING (Sentiment against)' : '⚠️ NEUTRAL';
        const sentimentAligned = 
            (aData.direction === 'LONG' && parseFloat(sentiment.totalBias) >= 0.5) ||
            (aData.direction === 'SHORT' && parseFloat(sentiment.totalBias) <= -0.5);

        // 🤖 4. Enhanced AI Prompt (Sentiment + Technical combined)
        const headlineStr = (sentiment.newsHeadlines || []).slice(0,3).join(' | ');
        const prompt = `Analyze ${coin} FUTURES trade signal. Current: $${aData.priceStr}

=== TECHNICAL (${aData.maxScore}-FACTOR SCORE: ${aData.score}/${aData.maxScore}) ===
Confluences: ${aData.reasons}
Market: ${aData.marketState} | Trend: ${aData.mainTrend} | MTF: 4H=${aData.trend4H} 1H=${aData.trend1H}
ADX: ${aData.adxData.status} | RSI: ${aData.rsi} | VWAP: ${aData.vwap}
OB Bull: ${aData.marketSMC.bullishOBDisplay} | OB Bear: ${aData.marketSMC.bearishOBDisplay}
Kill Zone: ${aData.marketSMC.killzone} | Liquidation: ${liqData.sentiment}
Entry Zone: ${aData.bestEntry.name} | OB Confirmation: ${aData.confirmation.status}
Deep Entry: ${aData.deepEntry ? aData.deepEntry.action + ' | Conf:' + aData.deepEntry.confluence + ' sources: ' + (aData.deepEntry.confluenceSources||[]).slice(0,4).join(',') : 'N/A'}
StochRSI: ${aData.stochRSI.signal} (K:${aData.stochRSI.k}) | BB: ${aData.bbands.signal} | MTF OB: ${aData.mtfOB.confluenceZone ? aData.mtfOB.confluenceZone.display : 'None'}
Smart SL Method: ${aData.slLabel} | TP Methods: ${aData.tp1Label}, ${aData.tp2Label}, ${aData.tp3Label}
MTF RSI: ${aData.mtfRSI.signal} | Volume Node: ${aData.volNodes.nearHVN ? 'At HVN (good entry)' : 'Not at HVN'} 
Session: ${aData.session.quality} (${aData.session.session}) | Candle Close: ${aData.candleConf.confirmed ? 'CONFIRMED' : 'Pending'}
EMA Ribbon: ${aData.emaRibbon ? aData.emaRibbon.signal : 'N/A'} | Key S/R: ${aData.keyLevels.display}
Nearest FVG target: ${aData.fvgData.nearest ? '$' + aData.fvgData.nearest.mid + ' ' + aData.fvgData.nearest.direction : 'None'}
Supertrend: ${aData.supertrend.signal} (${aData.supertrend.supertrendLevel}) ${aData.supertrend.justFlipUp ? '⚡FLIP UP' : aData.supertrend.justFlipDown ? '⚡FLIP DOWN' : ''}
RVOL: ${aData.rvol.rvol}x (${aData.rvol.signal}) — ${aData.rvol.isTrustworthy ? 'Volume confirms move' : 'Low volume - wait'}
MTF MACD: ${aData.mtfMACD.signal}
Wyckoff Phase: ${aData.wyckoff.phase} (${aData.wyckoff.signal})
Breaker Block: ${aData.breakers.display}
EQH/EQL: ${aData.equalHL.display}
Zone: ${aData.pdZone.zone} (${aData.pdZone.position}%) — ${aData.pdZone.tradeMatch ? 'ALIGNED ✅' : 'NOT ALIGNED ⚠️'}
Ichimoku: ${aData.ichimoku.signal} | TK Cross: ${aData.ichimoku.tkBullCross ? 'BULL' : aData.ichimoku.tkBearCross ? 'BEAR' : 'None'}
CVD: ${aData.cvd.trend} ${aData.cvd.bullDiv ? '(Hidden Accumulation!)' : aData.cvd.bearDiv ? '(Hidden Distribution!)' : ''}
Heikin Ashi: ${aData.heikinAshi.consecutive}× ${aData.heikinAshi.signal} ${aData.heikinAshi.isStrong ? '(Strong)' : ''}
Williams %R: ${aData.williamsR.value} (${aData.williamsR.signal})
Pivot Signal: ${aData.pivotSignal.display}
Fib Confluence: ${aData.fibConf.hasConfluence ? aData.fibConf.count + ' levels at $' + aData.fibConf.zone : 'None'}
Liquidity Sweep: ${aData.liquiditySweep} | ChoCH: ${aData.choch}
Short-Term OBs: Bull=${ aData.mtfOBsExtra.bullish ? aData.mtfOBsExtra.bullish.bottom+'-'+aData.mtfOBsExtra.bullish.top : 'None'} | Bear=${aData.mtfOBsExtra.bearish ? aData.mtfOBsExtra.bearish.bottom+'-'+aData.mtfOBsExtra.bearish.top : 'None'}
Entry Validation: ${aData.entryValidation.warning || 'Entry OK ✅'}
Funding Rate: ${fundingRate} | Whale Buy Wall: $${whaleWalls.supportWall} | Sell: $${whaleWalls.resistWall}

=== SENTIMENT LAYER (USE THIS TO CONFIRM/REJECT) ===
Fear & Greed: ${sentiment.fngValue}/100 (${sentiment.fngLabel})
BTC Dominance: ${sentiment.btcDominance}% (>55% alts suffer, <45% altseason)
News Sentiment Score: ${sentiment.newsSentimentScore} (-5 bearish to +5 bullish)
Coin-specific news hits: ${sentiment.coinNewsHits}
Latest Headlines: ${headlineStr}
Overall Market Bias: ${sentiment.overallSentiment}
Sentiment vs Technical Signal: ${sentimentBoost}

=== ENTRY CONFIRMATION SCORE ===
Advanced 8-Factor Score: ${entryConf.totalScore >= 0 ? '+' : ''}${entryConf.totalScore} (${entryConf.confirmationStrength})
Stablecoin Flow: ${entryConf.usdtDom.signal} | OI Change: ${entryConf.oiChange.signal}
CVD: ${entryConf.cvd.signal} | BTC Correlation: ${entryConf.btcCorr.signal}
Put/Call Ratio: ${entryConf.pcr.signal} | Netflow: ${entryConf.netflow.signal}

=== AI DECISION RULES ===
1. If sentiment CONFLICTS with tech direction, lower confidence by 20% and warn
2. If sentiment CONFIRMS tech direction, boost confidence by 10%
3. Funding >0.1% + LONG = caution (longs getting squeezed)
4. Funding <-0.1% + SHORT = caution (shorts getting squeezed)
5. F&G >80 (Extreme Greed) + LONG = risky, mention
6. F&G <20 (Extreme Fear) + SHORT = risky, mention
7. Liquidity Sweep CONFIRMS direction = strong signal (smart money move)
8. ChoCH present = trend reversal confirmed, high confidence
9. If entryValidation has WARNING = reduce confidence, mention in trend field
10. Wyckoff SPRING or UTAD = boost confidence +20% (highest probability setup)
11. CVD Divergence = hidden smart money move — boost confidence +15%
12. OTE Zone + Ichimoku aligned = institutional setup, boost +10%
13. Price in Premium for LONG or Discount for SHORT = reduce confidence -15%

STRICT OUTPUT RULES:
- Return ONLY a single JSON object, nothing else
- NO markdown, NO backticks, NO explanation text before or after
- All string values: NO newlines, NO unescaped quotes inside strings
- trend/smc_summary/sentiment_note: write in Sinhala but keep it SHORT (max 80 chars each), NO line breaks

EXACT JSON (copy this structure, fill values):
{"direction":"${aData.direction}","emoji":"🟢","entry":"${aData.entryPrice}","tp1":"${aData.tp1}","tp2":"${aData.tp2}","sl":"${aData.sl}","rrr":"1:${rrrStr}","leverage":"${levText}","margin":"${marginText}","qty":"${qtyText}","risk":"${riskText}","confidence":"65%","trend":"Bullish trend short description","smc_summary":"SMC summary one line","sentiment_note":"Sentiment impact one line"}`;
        // ✅ FIX: Added 25s timeout — GROQ was hanging indefinitely without it
        let aiRes;
        try {
            aiRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                model: "llama-3.3-70b-versatile",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 500,
                temperature: 0.3
            }, {
                headers: { Authorization: `Bearer ${config.GROQ_API}`, 'Content-Type': 'application/json' },
                timeout: 25000
            });
        } catch (groqErr) {
            console.error('[GROQ] Failed:', groqErr.message);
            // Fallback: skip AI, use analyzer data directly
            aiRes = null;
        }

        // ─── Ultra-Robust AI JSON Parser ───
        // ✅ FIX: Declare data BEFORE if/else so it's accessible after the block
        let data;
        if (!aiRes) {
            data = {
                direction: aData.direction,
                emoji: aData.direction === 'LONG' ? '🟢' : '🔴',
                confidence: `${Math.round(50 + aData.score * 5)}%`,
                trend: aData.mainTrend + ' | ' + aData.marketState,
                smc_summary: 'AI unavailable — technical data used',
                sentiment_note: sentiment.tradingBias || 'Neutral',
                entry: aData.entryPrice, tp1: aData.tp1, tp2: aData.tp2,
                sl: aData.sl, rrr: `1:${rrrStr}`,
                leverage: levText, margin: marginText, qty: qtyText, risk: riskText
            };
        } else {
        const rawContent = aiRes.data.choices[0].message.content;

        // Step 1: Strip markdown fences
        let raw = rawContent.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

        // Step 2: Extract the outermost { ... } block (greedy - gets the full JSON)
        const braceStart = raw.indexOf('{');
        const braceEnd = raw.lastIndexOf('}');
        if (braceStart === -1 || braceEnd === -1 || braceEnd <= braceStart) {
            console.error('AI raw (no JSON):', rawContent.slice(0, 400));
            throw new Error('AI JSON parse failed - no JSON found');
        }
        let jm = raw.slice(braceStart, braceEnd + 1);

        // Step 3: Try direct parse (uses outer-scoped `data` variable)
        try {
            data = JSON.parse(jm);
        } catch(e1) {
            // Step 4: Deep clean - fix common AI JSON mistakes
            let cleaned = jm
                .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":')          // unquoted keys
                .replace(/:\s*'([^']*)'/g, ': "$1"')                   // single-quoted values
                .replace(/,\s*([}\]])/g, '$1')                        // trailing commas
                .replace(/[\u0000-\u001F\u007F]/g, ' ')              // control chars
                .replace(/\n/g, ' ').replace(/\r/g, '');              // literal newlines in strings

            // Step 5: Fix broken string values (unescaped quotes inside JSON strings)
            // Rebuild string values field by field using regex
            cleaned = cleaned.replace(/("(?:trend|smc_summary|sentiment_note|confidence|direction|emoji)"\s*:\s*")(.*?)("(?:\s*[,}]))/gs,
                (match, before, val, after) => {
                    const fixedVal = val.replace(/(?<!\\)"/g, '\\"').replace(/\n/g, ' ');
                    return before + fixedVal + after;
                }
            );

            try {
                data = JSON.parse(cleaned);
            } catch(e2) {
                // Step 6: Last resort — extract individual fields with regex
                console.error('AI JSON fallback parsing:', jm.slice(0, 300));
                const extract = (key) => {
                    const m = jm.match(new RegExp('"' + key + '"\\s*:\\s*"([^"\\n]*)"'));
                    return m ? m[1] : null;
                };
                data = {
                    direction: extract('direction') || aData.direction,
                    emoji: extract('emoji') || (aData.direction === 'LONG' ? '🟢' : '🔴'),
                    confidence: extract('confidence') || '60%',
                    trend: extract('trend') || 'AI analysis unavailable',
                    smc_summary: extract('smc_summary') || '',
                    sentiment_note: extract('sentiment_note') || (sentiment && sentiment.tradingBias) || 'Neutral'
                };
            }
        }
        } // end if(!aiRes) else block
        const sentimentNote = (data && data.sentiment_note) || (sentiment && sentiment.tradingBias) || 'Neutral';

        // ✅ FIX: Always use analyzer values for trade params — AI only provides direction/confidence/text
        data.entry     = aData.entryPrice;
        data.tp1       = aData.tp1;
        data.tp2       = aData.tp2;
        data.sl        = aData.sl;
        data.rrr       = `1:${rrrStr}`;
        data.leverage  = levText;
        data.margin    = marginText;
        data.qty       = qtyText;
        data.risk      = riskText;

        // 🕸️ 5. Grid Generation
        let gridStr = "";
        if (aData.isTrueChoppy) {
            let highs = aData.currentCandles.slice(-50).map(c => parseFloat(c[2]));
            let lows = aData.currentCandles.slice(-50).map(c => parseFloat(c[3]));
            let res = Math.max(...highs), sup = Math.min(...lows);
            let step = (res - sup) / 5;
            gridStr = `\n\n*🕸️ GRID SCALPING ZONES (True Choppy):*\n🔴 Resistance: $${(sup+step*5).toFixed(4)} (Sell Zone)\n🟠 Grid 4: $${(sup+step*4).toFixed(4)}\n🟡 Grid 3: $${(sup+step*3).toFixed(4)} (Neutral)\n🟢 Grid 2: $${(sup+step*2).toFixed(4)}\n🟢 Support: $${sup.toFixed(4)} (Buy Zone)\n_💡 මෙම වෙළඳපොළේ දිශාවක් නොමැති බැවින් Support/Resistance Scalping පමණක් කරන්න._`;
        }

        let extraInfo = gridStr;
        if (aData.harmonicPattern !== "None") extraInfo += `\n📐 *Harmonic PRZ:* ${aData.harmonicPattern}`;
        if (aData.ictSilverBullet !== "Active Time (No FVG)" && aData.ictSilverBullet !== "None") extraInfo += `\n🕒 *ICT Strategy:* ${aData.ictSilverBullet}`;

        const zoneWarn = aData.bestEntry.warning ? `\n\n${aData.bestEntry.warning}` : "";
        const trackMsg = data.direction !== "WAIT" && !aData.isTrueChoppy ? `\n📌 Track: .track reply\n[TARGETS|ENTRY:${data.entry}|TP1:${data.tp1}|TP2:${data.tp2}|TP3:${aData.tp3}|SL:${data.sl}]` : "";
        // ✅ FIX: Only show warning if killzone is ALSO not London/NY (avoid contradiction)
        const killzoneIsActive = aData.marketSMC.killzone.includes('London') || aData.marketSMC.killzone.includes('New York');
        const sessionWarn = killzoneIsActive ? "" :
            aData.session.quality === 'AVOID' 
                ? "\n🔴 *OFF-HOURS* - Very low volume. Avoid new entries."
                : aData.session.quality === 'CAUTION'
                    ? "\n⚠️ *ASIAN SESSION* - Low volume, fakeout risk. Wait for London open."
                    : "";
        const asianWarning = sessionWarn;
        
        let dangerWarning = "";
        if (!settings.strictMode && (aData.score < 5 || !rrrCheck.pass)) { dangerWarning = `\n\n🚨 *AI WARNING: DO NOT TAKE THIS TRADE!*`; }

        // 🖨️ 6. Output Message
        const _paperBanner = config.modules.PAPER_TRADING
            ? '\n📄 *PAPER TRADING MODE* — Signal auto-logged. No real order placed.\n'
            : '';

        const out = `
╔═══════════════════════════╗
║ 🎯 *PRO SNIPER ANALYSIS* ║
╚═══════════════════════════╝
${dangerWarning}${_paperBanner}${_proModeTag}
${aData.signalGrade === 'A+' ? '🏆 *ELITE A+ SETUP* 🏆' : aData.signalGrade === 'A' ? '🥇 *HIGH QUALITY A SETUP*' : aData.signalGrade === 'B' ? '🥈 *STANDARD B SETUP*' : ''}
🪙 *${coin.replace('USDT','')} / USDT*  ${data.emoji} *${data.direction}*  💵 $${aData.priceStr}
📌 *Market:* ${aData.marketState} | *ADX:* ${aData.adxData.status}
${aData.dynRegime ? `🌊 *Regime:* CHOP=${aData.dynRegime.chop?.toFixed(1)||'?'} H=${aData.dynRegime.hurst?.toFixed(2)||'?'} MTF=${aData.mtfAlignCount||0}/4` : ''}
⏱️ ${aData.marketSMC.killzone}${asianWarning}

━━━━━━━━━━━━━━━━━━
*🎯 TRADE SETUP*
━━━━━━━━━━━━━━━━━━
📍 *Entry:*    $${data.entry}  (${aData.bestEntry.name})
🎯 *TP1:*      $${data.tp1}  _(${aData.tp1Label})_
🎯 *TP2:*      $${data.tp2}  _(${aData.tp2Label})_
🎯 *TP3:*      $${aData.tp3}  _(${aData.tp3Label})_
🛡️ *SL:*       $${data.sl}  _(${aData.slLabel})_
⚖️ *RRR:*      ${data.rrr} ${rrrCheck.pass ? '✅' : '⚠️'}
📋 *Order:*    ${aData.deepEntry ? aData.deepEntry.action : aData.orderSuggestion.type + ' — ' + aData.orderSuggestion.reason}
${aData.deepEntry && aData.deepEntry.decision !== 'MARKET' && aData.deepEntry.decision !== 'SKIP' ? `🎯 *Best Zone:* $${aData.deepEntry.optimalEntry} (${aData.deepEntry.distPct}% | ${aData.deepEntry.eta})
🔗 *Confluence:* ${aData.deepEntry.confluenceSources.slice(0,4).join(' · ')}` : ''}${aData.deepEntry && aData.deepEntry.decision === 'SKIP' ? `\n⛔ *${aData.deepEntry.skipReason}*` : ''}
🔔 ${aData.confirmation.status}${zoneWarn}
${aData.refinementNote ? `🔧 _${aData.refinementNote}_` : ''}
${aData.weeklyTgts ? `🗓️ *Extended TP:* ${aData.weeklyTgts.display}` : ''}
${aData.cmeGap && aData.cmeGap.hasGap ? aData.cmeGap.display : ''}

━━━━━━━━━━━━━━━━━━
*💼 POSITION SIZE*
━━━━━━━━━━━━━━━━━━
⚙️ Leverage:  ${data.leverage}
💰 Margin:    ${data.margin}${marginWarning}
📦 Quantity:  ${data.qty}
🛡️ Risk:       ${data.risk}
🔥 Confidence: ${data.confidence}${extraInfo}

━━━━━━━━━━━━━━━━━━
*📊 TECHNICAL (Score: ${aData.score}/${aData.maxScore}) ${aData.signalGradeEmoji||''} ${aData.signalGrade||''} ${aData.signalGradeLabel||''}*
━━━━━━━━━━━━━━━━━━
✔️ ${aData.reasons}

*MTF Trend:*  4H=${aData.trend4H} | 1H=${aData.trend1H}
📊 StochRSI:  ${aData.stochRSI.signal} (K:${aData.stochRSI.k})
📉 Bollinger: ${aData.bbands.signal} | %B: ${aData.bbands.percentB}%${aData.bbands.squeeze ? '\n⚡ *BB SQUEEZE* - Breakout imminent!' : ''}
📈 MTF RSI:   ${aData.mtfRSI.display}
📦 Volume:    ${aData.volNodes.display}
🕯️ Candle:    ${aData.candleConf.display}${aData.mtfOB.confluenceZone ? '\n🔥 *MTF OB:* ' + aData.mtfOB.confluenceZone.display : ''}${aData.liquiditySweep !== 'None' ? '\n💧 *Liq Sweep:* ' + aData.liquiditySweep : ''}${aData.choch !== 'None' ? '\n🔄 *ChoCH:* ' + aData.choch : ''}${aData.entryValidation && aData.entryValidation.warning ? '\n' + aData.entryValidation.warning.replace(/\(\$[\d.]+\)/g, m => '($' + parseFloat(m.slice(2,-1)).toFixed(4) + ')') : ''}
${aData.emaRibbon ? '📊 *EMA Ribbon:* ' + aData.emaRibbon.display : ''}
📍 *Key S/R:* ${aData.keyLevels.display}${aData.fvgData.nearest ? '\n🎯 *Nearest FVG:* $' + aData.fvgData.nearest.mid + ' (' + aData.fvgData.nearest.direction + ')' : ''}
⚡ *Supertrend:* ${aData.supertrend.display}
📊 *RVOL:* ${aData.rvol.display}
📈 *MTF MACD:* ${aData.mtfMACD.display}

━━━━━━━━━━━━━━━━━━
*🧠 ADVANCED INTELLIGENCE (v5)*
━━━━━━━━━━━━━━━━━━
🌊 *Wyckoff:* ${aData.wyckoff.display}
${aData.breakers.display !== 'None' ? '🔲 *Breaker:* ' + aData.breakers.display + '\n' : ''}${aData.equalHL.display !== 'None' ? '💧 *Liquidity:* ' + aData.equalHL.display + '\n' : ''}🎯 *Zone:* ${aData.pdZone.display}
${aData.ichimoku.display}
${aData.cvd.display}
${aData.heikinAshi.display}
🅡 ${aData.williamsR.display}
${aData.pivotSignal.display}
${aData.fibConf.display}

━━━━━━━━━━━━━━━━━━
*⚡ v6 BIG PROFIT SIGNALS*
━━━━━━━━━━━━━━━━━━
${aData.bbSqueeze.display}
${aData.volExpansion.display || '📊 ADX Stable'}
${aData.mmTrap.display !== 'None' ? '🪤 *MM Trap:* ' + aData.mmTrap.display : '🪤 MM Trap: None'}
${aData.tf3Align.display}
📅 *Daily Trend:* ${aData.dailyTrend} ${aData.dailyAligned ? '✅ Aligned' : '⚠️ Against daily'}
${aData.weeklyTgts ? aData.weeklyTgts.display : '🗓️ Weekly targets: N/A'}
${aData.cmeGap.display}

━━━━━━━━━━━━━━━━━━
*🔮 v7 PRO VVIP SIGNALS*
━━━━━━━━━━━━━━━━━━
${aData.momentumShift.display}
${aData.bos.display !== 'None' ? '🔺 *BOS:* ' + aData.bos.display : ''}
${aData.advCandles.display !== '⚪ No pattern' ? '🕯️ *Pattern:* ' + aData.advCandles.display : ''}
${aData.mfi.display}
${aData.roc.display}
${aData.cci.display}
${aData.gannAngles.display}
${aData.renko.display}
${aData.dynamicSR.display}
${aData.fibLevels.display}
${aData.moonCycle.display}

*🔬 5m MTF:*
${aData.mtf5m.status}

━━━━━━━━━━━━━━━━━━
*🌊 MARKET CONTEXT*
━━━━━━━━━━━━━━━━━━
🐋 Buy Wall:  $${whaleWalls.supportWall} (${whaleWalls.supportVol} USDT)
🔴 Sell Wall: $${whaleWalls.resistWall} (${whaleWalls.resistVol} USDT)
💸 Funding:   ${fundingRate}
${sentiment.fngEmoji} F&G: ${sentiment.fngValue} (${sentiment.fngLabel}) | ₿ BTC.D: ${sentiment.btcDominance}%
📰 News: ${sentiment.newsSentimentScore > 0 ? '+' : ''}${sentiment.newsSentimentScore} | ${sentimentAligned ? '✅' : '⚠️'} ${sentimentBoost}
💬 ${sentimentNote}

*💡 AI Analysis:*
${data.trend}
${data.smc_summary}

${entryConf.display}

🖼️ .chart ${coin} ${timeframe}${trackMsg}`;

        await reply(out.trim());
        await m.react('✅');

        // ── Auto Paper Trade Logger ────────────────────────────────────
        // When PAPER_TRADING mode is ON every .future signal is automatically
        // saved as a paper trade — no need to manually type .paper
        if (config.modules.PAPER_TRADING) {
            try {
                const _liveP  = parseFloat(aData.currentPrice);
                const _entryN = parseFloat(aData.entryPrice);
                // Avoid duplicating if user already has an open paper trade for this coin
                const _already = await db.Trade.findOne({
                    coin, isPaper: true, status: { $in: ['active', 'pending'] }
                });
                if (!_already && calcQty > 0) {
                    const _diffPct = Math.abs(_liveP - _entryN) / _entryN * 100;
                    const _oType   = _diffPct <= 0.3 ? 'MARKET' : 'LIMIT';
                    const _status  = _oType === 'MARKET' ? 'active' : 'pending';
                    await db.saveTrade({
                        userJid: m.sender, coin, type: 'future',
                        direction: aData.direction,
                        entry: _entryN,
                        tp: aData.tp3 || aData.tp2,
                        tp1: aData.tp1, tp2: aData.tp2, sl: aData.sl,
                        rrr: `1:${(Math.abs((aData.tp3||aData.tp2) - _entryN) / Math.abs(_entryN - aData.sl)).toFixed(2)}`,
                        status: _status, orderType: _oType,
                        fillPrice: _status === 'active' ? _liveP : 0,
                        isPaper: true, source: 'PAPER_AUTO',
                        leverage: calcLeverage, quantity: calcQty,
                        marginUsed: calcMarginUsed,
                        score: aData.score, timeframe,
                    });
                    console.log(`[PAPER_AUTO] 📄 Auto-logged: ${coin} ${aData.direction} @ $${_entryN}`);
                }
            } catch (_pe) {
                console.warn('[PAPER_AUTO] Save failed:', _pe.message);
            }
        }
    } catch (e) {
        console.error('[future.js] CRASH:', e.stack || e.message);
        const errMsg = e.message || String(e) || 'Unknown error';
        await reply(`❌ *Analysis Failed*

${errMsg}

💡 Try again or check server logs.`).catch(() => {});
        try { await m.react('❌'); } catch(_) {}
    }
});
