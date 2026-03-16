const { cmd } = require('../lib/commands');
const config = require('../config');
const axios = require('axios');
const db = require('../lib/database');
const binance = require('../lib/binance');
const analyzer = require('../lib/analyzer'); // ✅ අලුත් මොළය සම්බන්ධ කළා
const confirmations = require('../lib/confirmations_lib');
const { checkRRR } = require('../lib/indicators');

cmd({
        pattern: "spot",
        desc: "Ultimate Spot AI - Smart Entry + MTF + RRR Filter",
        category: "crypto",
        react: "🟢",
        filename: __filename
    },
    async (conn, mek, m, { reply, args }) => {
        try {
            if (!args[0]) return await reply(`❌ Coin ලබා දෙන්න!\n*උදා:* ${config.PREFIX}spot BTC 1d`);
            if (!config.GROQ_API) return await reply('❌ GROQ_API key නැහැ!');
            
            let coin = args[0].toUpperCase();
            if (!coin.endsWith('USDT')) coin += 'USDT';
            let timeframe = args[1] ? args[1].toLowerCase() : '1d';
            
            // ✅ Trade Type තීරණය කිරීම
            let tradeCategory = "⚡ Scalp Trade";
            if (timeframe === '30m' || timeframe === '1h' || timeframe === '4h') tradeCategory = "🌅 Intraday Trade";
            if (timeframe === '1d' || timeframe === '1w') tradeCategory = "📅 Swing Trade";
            
            await m.react('⏳');
            await reply(`⏳ *${coin} Smart Spot Analysis...*`);
            
            // 🧠 1. Analyzer එකෙන් Data ගැනීම (කලින් පේළි ගාණක වැඩේ දැන් එක පේළියයි!)
            const [aData, fng, spotSentiment] = await Promise.all([
                analyzer.run14FactorAnalysis(coin, timeframe),
                binance.getFearAndGreed(),
                binance.getMarketSentiment(coin),
            ]);
            // 🔬 Entry Confirmations
            const entryConf = await confirmations.runAllConfirmations(coin, 'LONG', null);
            
            // 🎯 2. Custom Spot TPs (Fibonacci & Resistance මත පදනම්ව)
            const tp1 = parseFloat(aData.marketSMC.resistance).toFixed(4);
            const tp2 = parseFloat(aData.marketSMC.ext1618).toFixed(4);
            const tp3 = parseFloat(aData.marketSMC.ext2618).toFixed(4);
            
            const entryPrice = parseFloat(aData.entryPrice);
            const slPrice = parseFloat(aData.sl);
            
            const risk = Math.abs(entryPrice - slPrice);
            const reward = Math.abs(parseFloat(tp2) - entryPrice);
            const rrrVal = risk > 0 ? reward / risk : 0;
            const rrrStr = rrrVal.toFixed(2);
            
            const settings = await db.getSettings();
            const rrrCheck = checkRRR(aData.entryPrice, tp2, aData.sl, settings.minRRR || 1.5);
            
            if (!rrrCheck.pass && settings.strictMode) {
                return await reply(`⛔ *SPOT TRADE REJECTED - RRR Filter*\n\n🪙 ${coin} | BUY\n📍 Entry: $${aData.entryPrice} | TP: $${tp2} | SL: $${aData.sl}\n\n${rrrCheck.reason}\n💡 Better entry zone එකක් එනකල් wait කරන්න.`);
            }
            
            // 💰 3. Risk Sizing for Spot (Leverage නැතිව)
            const userMargin = await db.getMargin(m.sender) || 0;
            let allocText = "Set .margin",
                riskText = "Set .margin";
            if (userMargin > 0) {
                const riskMon = userMargin * 0.02; // 2% Capital Risk
                const slPct = risk / entryPrice;
                const posSize = slPct > 0 ? riskMon / slPct : 0;
                
                allocText = posSize > userMargin ? `Max $${userMargin.toFixed(2)}` : `$${posSize.toFixed(2)}`;
                riskText = `$${riskMon.toFixed(2)}`;
            }
            
            const asianWarn = aData.marketSMC.killzone.includes("Asian") ? "\n⚠️ *ASIAN SESSION* - London Open වෙනකල් wait recommended." : "";
            
            // 🤖 4. AI Prompt Generation
            const prompt = `Analyze ${coin} SPOT trading. Current: $${aData.priceStr}
1H MTF: ${aData.mtf5m.status}
RRR: ${rrrCheck.reason}
Session: ${aData.marketSMC.killzone}

DATA: RSI=${aData.rsi} | VWAP=${aData.vwap}
OB Bull: ${aData.marketSMC.bullishOBDisplay} | ChoCH: ${aData.marketSMC.choch}
Entry Zone: ${aData.bestEntry.name} | Order: ${aData.orderSuggestion.type}
Confirmation: ${aData.confirmation.status}

EXACT MATH: entry:"${aData.entryPrice}", tp1:"${tp1}", tp2:"${tp2}", tp3:"${tp3}", sl:"${aData.sl}", rrr:"1:${rrrStr}", allocation:"${allocText}", riskAmt:"${riskText}"

${settings.strictMode ? 'Output WAIT if low confidence or bad setup.' : 'Output signal with warnings if needed.'}
Sinhala explanation. Keep RSI/VWAP/OB in English.

JSON only:
{"direction":"BUY or WAIT","emoji":"🟢 or ⚪","entry":"${aData.entryPrice}","tp1":"${tp1}","tp2":"${tp2}","tp3":"${tp3}","sl":"${aData.sl}","rrr":"1:${rrrStr}","allocation":"${allocText}","riskAmt":"${riskText}","confidence":"XX%","trend":"sinhala","smc_summary":"sinhala"}`;
            
            const aiRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                model: "llama-3.3-70b-versatile",
                messages: [{ role: "user", content: prompt }]
            }, { headers: { Authorization: `Bearer ${config.GROQ_API}`, 'Content-Type': 'application/json' } });
            
            // ─── Ultra-Robust AI JSON Parser ───
            const rawContent = aiRes.data.choices[0].message.content;
            let raw = rawContent.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
            const braceStart = raw.indexOf('{');
            const braceEnd = raw.lastIndexOf('}');
            if (braceStart === -1 || braceEnd <= braceStart) {
                console.error('AI raw (no JSON):', rawContent.slice(0, 400));
                throw new Error('AI JSON parse failed - no JSON found');
            }
            let jm = raw.slice(braceStart, braceEnd + 1);
            let data;
            try {
                data = JSON.parse(jm);
            } catch (e1) {
                let cleaned = jm
                    .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":')
                    .replace(/:\s*'([^']*)'/g, ': "$1"')
                    .replace(/,\s*([}\]])/g, '$1')
                    .replace(/[\u0000-\u001F\u007F]/g, ' ')
                    .replace(/\n/g, ' ').replace(/\r/g, '');
                cleaned = cleaned.replace(/("(?:trend|smc_summary|confidence|direction)"\s*:\s*")(.*?)("(?:\s*[,}]))/gs,
                    (match, before, val, after) => before + val.replace(/(?<!\\)"/g, '\\"') + after
                );
                try {
                    data = JSON.parse(cleaned);
                } catch (e2) {
                    console.error('Spot AI JSON fallback:', jm.slice(0, 300));
                    const extract = (key) => { const m = jm.match(new RegExp('"' + key + '"\\s*:\\s*"([^"\\n]*)"')); return m ? m[1] : null; };
                    data = {
                        direction: extract('direction') || 'BUY',
                        emoji: extract('emoji') || '🟢',
                        entry: extract('entry') || aData.entryPrice,
                        tp1: extract('tp1') || tp1,
                        tp2: extract('tp2') || tp2,
                        tp3: extract('tp3') || tp3,
                        sl: extract('sl') || aData.sl,
                        rrr: extract('rrr') || ('1:' + rrrStr),
                        allocation: extract('allocation') || allocText,
                        riskAmt: extract('riskAmt') || riskText,
                        confidence: extract('confidence') || '60%',
                        trend: extract('trend') || 'Analysis unavailable',
                        smc_summary: extract('smc_summary') || ''
                    };
                }
            }
            
            const zoneWarn = aData.bestEntry.warning ? `\n\n${aData.bestEntry.warning}` : "";
            const rrrWarnMsg = !rrrCheck.pass ? `\n\n⚠️ *RRR WARNING:* ${rrrCheck.reason}` : "";
            const trackMsg = data.direction !== "WAIT" ? `\n📌 Track: .track reply\n[TARGETS|ENTRY:${data.entry}|TP1:${data.tp1}|TP2:${data.tp2}|TP3:${data.tp3}|SL:${data.sl}](${coin})` : "";
            
            // 🖨️ 5. Final Output Message
            const out = `
╔═══════════════════════════╗
║  🟢 *PRO SPOT ANALYSIS* ║
╚═══════════════════════════╝

🪙 ${coin.replace('USDT','')} / USDT  💵 $${aData.priceStr}
📌 *Trade Style:* ${tradeCategory}
⏱️ ${aData.marketSMC.killzone}${asianWarn}

*🔬 1H MTF Confirmation:*
${aData.mtf5m.status}

*🎯 Smart Entry* ${data.emoji} ${data.direction}
🏹 Zone: ${aData.bestEntry.name}
📍 Entry: $${data.entry}
📋 Order: ${aData.orderSuggestion.type}
   ${aData.orderSuggestion.reason}
🔔 ${aData.confirmation.status}

🎯 *Take Profits:*
   ▪️ TP1 (33% - ${aData.tp1Label}): $${data.tp1}
   ▪️ TP2 (33% - ${aData.tp2Label}): $${data.tp2}
   ▪️ TP3 (34% - ${aData.tp3Label}): $${aData.tp3}
🛡️ SL (${aData.slLabel}): $${data.sl}

*⚖️ Risk Management (2% Rule)*
RRR: ${data.rrr} ${rrrCheck.pass ? '✅' : '⚠️'}
💰 Investment: ${data.allocation}
🛡️ Max Risk:   ${data.riskAmt}
🔥 Confidence: ${data.confidence}

*📊 Analysis:*
${data.trend}
${data.smc_summary}${zoneWarn}${rrrWarnMsg}

${entryConf.display}

🖼️ Chart: .chart ${coin} ${timeframe}
⚡ _.margin_ මගින් capital set කරන්න.${trackMsg}`;
            
            await reply(out.trim());
            await m.react('✅');
        } catch (e) {
            console.error('Spot Error:', e.message);
            await reply(`❌ Error: ${e.message}`);
        }
    });