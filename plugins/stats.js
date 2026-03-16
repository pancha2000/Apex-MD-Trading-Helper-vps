const { cmd } = require('../lib/commands');
const db = require('../lib/database');
const config = require('../config');

// ═══════════════════════════════════════════════════════
// ✅ NEW: .stats - Trade Journal & Performance Stats
// ═══════════════════════════════════════════════════════
cmd({
        pattern: "stats",
        alias: ["journal", "performance", "paperstats"], // ✅ වෙනස්කම: paperstats alias එක එකතු කළා
        desc: "Trade Journal & Performance Statistics",
        category: "crypto",
        react: "📊",
        filename: __filename
    },
    async (conn, mek, m, { reply }) => {
        try {
            await m.react('⏳');
            const stats = await db.getTradeStats(m.sender);
            const user = await db.getUser(m.sender); // ✅ අලුතින්: Paper data ගැනීම
            
            if (!stats) return await reply('❌ Stats ලබාගැනීමේ දෝෂයක් ඇත.');
            
            // පරණ early return එක (Paper trades වත් නැත්නම් විතරක් return වෙන්න හැදුවා)
            if (stats.total === 0 && stats.active === 0 && user.paperTrades === 0) {
                return await reply(`📊 *TRADE JOURNAL*\n\nTrades නොමැත. ${config.PREFIX}future හෝ ${config.PREFIX}spot ලෙ signal ගෙන .track ලෙස track කරන්න.`);
            }
            
            const winEmoji = stats.winRate >= 60 ? '🏆' : stats.winRate >= 50 ? '✅' : '⚠️';
            const pnlEmoji = parseFloat(stats.totalPnl) >= 0 ? '📈' : '📉';
            const streakMsg = stats.currentStreak === 'WIN' ?
                `🔥 Current streak: WIN` :
                stats.currentStreak === 'LOSS' ?
                `❄️ Current streak: LOSS` :
                `➖ No streak`;
            
            // Win rate progress bar
            const barFilled = Math.round(stats.winRate / 10);
            const bar = '█'.repeat(barFilled) + '░'.repeat(10 - barFilled);
            
            let recentMsg = stats.recent.length > 0 ?
                stats.recent.join('\n   ') :
                'කිසිදු closed trade නොමැත.';
            
            const bestCoin = stats.best?.coin ? `${stats.best.coin} (+${(stats.best.pnlPct || 0).toFixed(1)}%)` : 'N/A';
            const worstCoin = stats.worst?.coin ? `${stats.worst.coin} (${(stats.worst.pnlPct || 0).toFixed(1)}%)` : 'N/A';
            
            // ✅ අලුත්: Paper Trades Math
            const pWinRate = user.paperTrades > 0 ? ((user.paperWins / user.paperTrades) * 100).toFixed(2) : 0;
            // ✅ BUG FIX 2: hardcoded 100 නොව paperStartBalance use කරනවා
            const startBal = user.paperStartBalance || 100;
            const balanceProfit = user.paperBalance - startBal;
            const pProfitEmoji = balanceProfit >= 0 ? "📈" : "📉";
            const pProfitSign = balanceProfit >= 0 ? "+" : "";
            
            // ඔයාගේ පරණ Message Design එකමයි, උඩින් Paper info එකතු කරලා තියෙනවා
            const msg = `
╔═══════════════════════════╗
║  📊 *TRADE JOURNAL STATS* ║
╚═══════════════════════════╝

*🤖 AUTO PAPER TRADING:*
💰 Virtual Balance: $${user.paperBalance.toFixed(2)}
${pProfitEmoji} Net Profit: ${pProfitSign}$${balanceProfit.toFixed(2)}
🎯 Trades: ${user.paperTrades} (🟢 ${user.paperWins} | 🔴 ${user.paperLosses})
🏆 Win Rate: ${pWinRate}%

───────────────────────────

*👤 ඔබේ Trading Performance:*

📌 Active Trades: ${stats.active}
📁 Closed Trades: ${stats.total}
🟢 Wins:  ${stats.wins}   🔴 Losses: ${stats.losses}

${winEmoji} *Win Rate: ${stats.winRate}%*
[${bar}] ${stats.winRate}%

${pnlEmoji} *Total P&L: ${parseFloat(stats.totalPnl) >= 0 ? '+' : ''}${stats.totalPnl}%*
🏅 Best Trade:  ${bestCoin}
💀 Worst Trade: ${worstCoin}
🔥 Max Win Streak: ${stats.maxStreak}
${streakMsg}

*📋 Recent 5 Trades:*
   ${recentMsg}

> _${config.PREFIX}trades - Active trades ගැන_
> _${config.PREFIX}future BTC 15m - නව signal_`;
            
            await reply(msg.trim());
            await m.react('✅');
        } catch (e) { await reply('❌ Error: ' + e.message); }
    });

// ═══════════════════════════════════════════════════════
// ✅ NEW: .resetstats - Clear trade history (Owner only)
// ═══════════════════════════════════════════════════════
cmd({
        pattern: "resetstats",
        desc: "Reset your trade journal history",
        category: "crypto",
        react: "🗑️",
        filename: __filename
    },
    async (conn, mek, m, { reply }) => {
        try {
            await db.connect();
            // 1. ඔයාගේ පරණ Real Trades මකන කෑල්ල
            await db.Trade.deleteMany({ userJid: m.sender });
            
            // 2. අලුත් Paper Balance Reset කරන කෑල්ල
            const user = await db.User.findOne({ jid: m.sender });
            if (user) {
                user.paperBalance = 100;
                user.paperTrades = 0;
                user.paperWins = 0;
                user.paperLosses = 0;
                await user.save();
            }
            
            await reply('✅ Trade journal history සහ Paper Balance සාර්ථකව clear කරන ලදී!');
            await m.react('✅');
        } catch (e) { await reply('❌ Error: ' + e.message); }
    });