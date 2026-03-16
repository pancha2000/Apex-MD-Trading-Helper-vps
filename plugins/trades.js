const { cmd } = require('../lib/commands');
const db = require('../lib/database');

// ================= VIEW TRADES =================
cmd({
        pattern: "mytrades",
        desc: "View active tracked trades",
        category: "crypto",
        react: "📊",
        filename: __filename
    },
    async (conn, mek, m, { reply }) => {
        try {
            const trades = await db.getActiveTrades(m.sender);
            // ✅ FIX 6: Paper trades ද ගැනීම
            const paperTrades = await db.getActivePaperTrades(m.sender);
            
            if ((!trades || trades.length === 0) && (!paperTrades || paperTrades.length === 0)) {
                return await reply('❌ ඔබට දැනට Track වන Active Trades කිසිවක් නොමැත.');
            }
            
            let msg = `📊 *ඔබගේ Active Trades*\n\n`;
            
            // Real trades
            const allTrades = [...(trades || [])];
            if (paperTrades && paperTrades.length > 0) {
                msg += `📋 *Real Trades (${trades.length}):*\n`;
            }
            allTrades.forEach((t, i) => {
                // ✅ FIX 3: database එකේ save වූ direction field use කරනවා (guess කරන්නේ නැහැ)
                const tradeType = t.direction || (t.tp > t.entry ? 'LONG' : 'SHORT');
                const dirEmoji = tradeType === 'LONG' ? '🟢' : '🔴';
                const statusEmoji = t.status === 'pending' ? '⏳' : '🟢';
                msg += `*${i+1}. ${t.coin}* (${t.type.toUpperCase()} | ${dirEmoji} ${tradeType}) ${statusEmoji}
`;
                msg += `🎯 Entry: $${t.entry}
💰 TP: $${t.tp}
🛑 SL: $${t.sl}
`;
                if (t.rrr && t.rrr !== 'N/A') msg += `⚖️ RRR: ${t.rrr}
`;
                msg += `🆔 ID: ${t._id}

`;
            });
            // ✅ FIX 6: Paper trades section
            if (paperTrades && paperTrades.length > 0) {
                msg += `\n🤖 *Paper Trades (${paperTrades.length}):*\n`;
                paperTrades.forEach((t, i) => {
                    const tradeType = t.direction || (t.tp > t.entry ? 'LONG' : 'SHORT');
                    const dirEmoji = tradeType === 'LONG' ? '🟢' : '🔴';
                    msg += `*P${i+1}. ${t.coin}* (${dirEmoji} ${tradeType}) 🤖\n`;
                    msg += `🎯 Entry: $${t.entry}\n💰 TP: $${t.tp}\n🛑 SL: $${t.sl}\n`;
                    msg += `🆔 ID: ${t._id}\n\n`;
                });
            }
            
            msg += `> Trade එකක් මකා දැමීමට *.deltrade <ID>* භාවිතා කරන්න.`;
            
            await reply(msg);
            await m.react('✅');
        } catch (e) {
            await reply('❌ Error: ' + e.message);
        }
    });

// ================= DELETE TRADE =================
cmd({
        pattern: "deltrade",
        desc: "Delete a tracked trade",
        category: "crypto",
        react: "🗑️",
        filename: __filename
    },
    async (conn, mek, m, { reply, args }) => {
        try {
            if (!args[0]) return await reply('❌ කරුණාකර Trade ID එක ලබා දෙන්න!\n*උදා:* .deltrade 64abc123...');
            
            const id = args[0];
            const deleted = await db.deleteTrade(id);
            
            if (deleted) {
                await reply('✅ Trade එක සාර්ථකව මකා දමන ලදී. මින් පසු ඒ පිළිබඳ දැනුම්දීම් නොලැබේ.');
                await m.react('✅');
            } else {
                await reply('❌ Trade එක සොයාගත නොහැක. ID එක නිවැරදිදැයි පරීක්ෂා කරන්න.');
                await m.react('❌');
            }
        } catch (e) {
            await reply('❌ Error: ' + e.message);
        }
    });