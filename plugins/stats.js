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
// ═══════════════════════════════════════════════════════
// ✅ NEW: .analytics - Deep Trade Performance Analytics
// ═══════════════════════════════════════════════════════
cmd({
    pattern: 'analytics',
    alias: ['deepstats', 'coinanalysis', 'tradeanalytics'],
    desc: 'Deep trade analytics — per-coin win rate, time analysis, streaks',
    category: 'crypto',
    react: '🧬',
    filename: __filename,
},
async (conn, mek, m, { reply }) => {
    try {
        await m.react('⏳');

        const trades = await db.Trade.find({
            userJid: m.sender,
            status:  'closed',
            result:  { $in: ['WIN', 'LOSS', 'BREAK-EVEN'] },
        }).sort({ closedAt: -1 }).lean();

        if (!trades || trades.length < 3) {
            return await reply(
                `🧬 *TRADE ANALYTICS*\n\n` +
                `⚠️ Minimum 3 closed trades ඕනෑ.\n` +
                `Currently: ${trades ? trades.length : 0} trades.\n\n` +
                `More signals trade කර analytics unlock කරන්න!`
            );
        }

        // ── Per-coin analysis ─────────────────────────────────
        const coinMap = {};
        for (const t of trades) {
            const c = t.coin || 'UNKNOWN';
            if (!coinMap[c]) coinMap[c] = { wins: 0, losses: 0, be: 0, pnl: 0 };
            if (t.result === 'WIN')         { coinMap[c].wins++;   coinMap[c].pnl += (t.pnlPct || 0); }
            else if (t.result === 'LOSS')   { coinMap[c].losses++; coinMap[c].pnl += (t.pnlPct || 0); }
            else                            { coinMap[c].be++; }
        }
        const coinStats = Object.entries(coinMap)
            .map(([coin, s]) => {
                const total = s.wins + s.losses + s.be;
                return { coin, ...s, total, wr: total > 0 ? ((s.wins / total) * 100).toFixed(0) : 0 };
            })
            .sort((a, b) => b.total - a.total)
            .slice(0, 8);

        // ── Hour-of-day analysis (best trading hours) ─────────
        const hourMap = {};
        for (const t of trades) {
            if (!t.openTime) continue;
            const h = new Date(t.openTime).getUTCHours();
            if (!hourMap[h]) hourMap[h] = { wins: 0, losses: 0 };
            if (t.result === 'WIN') hourMap[h].wins++;
            if (t.result === 'LOSS') hourMap[h].losses++;
        }
        const hourStats = Object.entries(hourMap)
            .map(([h, s]) => {
                const total = s.wins + s.losses;
                return { hour: parseInt(h), ...s, total, wr: total > 0 ? ((s.wins / total) * 100).toFixed(0) : 0 };
            })
            .sort((a, b) => b.wr - a.wr)
            .slice(0, 3);

        // ── Direction breakdown ───────────────────────────────
        const longTrades  = trades.filter(t => t.direction === 'LONG');
        const shortTrades = trades.filter(t => t.direction === 'SHORT');
        const longWR  = longTrades.length  ? ((longTrades.filter(t=>t.result==='WIN').length  / longTrades.length)  * 100).toFixed(0) : 'N/A';
        const shortWR = shortTrades.length ? ((shortTrades.filter(t=>t.result==='WIN').length / shortTrades.length) * 100).toFixed(0) : 'N/A';

        // ── Average hold time ─────────────────────────────────
        const withTime = trades.filter(t => t.openTime && t.closedAt);
        const avgHoldMs = withTime.length
            ? withTime.reduce((s, t) => s + (new Date(t.closedAt) - new Date(t.openTime)), 0) / withTime.length
            : 0;
        const avgHoldH = (avgHoldMs / 3600000).toFixed(1);

        // ── Consecutive streak analysis ───────────────────────
        let maxWin = 0, maxLoss = 0, curW = 0, curL = 0;
        for (const t of [...trades].reverse()) {
            if (t.result === 'WIN')  { curW++; curL = 0; maxWin  = Math.max(maxWin,  curW); }
            else if (t.result === 'LOSS') { curL++; curW = 0; maxLoss = Math.max(maxLoss, curL); }
        }

        // ── OHLCV Cache stats ─────────────────────────────────
        let cacheInfo = '';
        try {
            const ohlcvCache = require('../lib/ohlcv-cache');
            const cs = await ohlcvCache.getCacheStats();
            cacheInfo = `\n━━━━━━━━━━━━━━━━━━\n*💾 OHLCV CACHE (API Saver)*\n📦 Entries: ${cs.totalEntries} | Coins: ${cs.uniqueCoins}\n✅ Hit Rate: ${cs.hitRate} (${cs.hits} hits / ${cs.misses} misses)`;
        } catch (_) {}

        // ── Build message ─────────────────────────────────────
        let msg = `╔═══════════════════════════╗\n║  🧬 *DEEP ANALYTICS v2*   ║\n╚═══════════════════════════╝\n\n`;
        msg += `*📊 OVERVIEW (${trades.length} closed trades)*\n`;
        msg += `🟢 LONG:  ${longTrades.length} trades | WR: ${longWR}%\n`;
        msg += `🔴 SHORT: ${shortTrades.length} trades | WR: ${shortWR}%\n`;
        msg += `⏱️ Avg Hold: ${avgHoldH}h\n`;
        msg += `🏆 Max Win Streak: ${maxWin}  |  💀 Max Loss Streak: ${maxLoss}\n\n`;

        msg += `━━━━━━━━━━━━━━━━━━\n*🪙 PER-COIN PERFORMANCE (Top 8)*\n`;
        for (const s of coinStats) {
            const wrEmoji = parseInt(s.wr) >= 60 ? '🟢' : parseInt(s.wr) >= 50 ? '🟡' : '🔴';
            const pnlSign = s.pnl >= 0 ? '+' : '';
            msg += `${wrEmoji} *${s.coin.replace('USDT','')}* — WR: ${s.wr}% (${s.wins}W/${s.losses}L) | PnL: ${pnlSign}${s.pnl.toFixed(1)}%\n`;
        }

        if (hourStats.length) {
            msg += `\n━━━━━━━━━━━━━━━━━━\n*⏰ BEST TRADING HOURS (UTC)*\n`;
            hourStats.forEach((h, i) => {
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
                msg += `${medal} ${String(h.hour).padStart(2,'0')}:00 UTC — WR: ${h.wr}% (${h.total} trades)\n`;
            });
        }

        msg += cacheInfo;
        msg += `\n\n_💡 .stats — ළඟා ළඟ summary | .analytics — deep dive_`;

        await reply(msg.trim());
        await m.react('✅');
    } catch (e) { await reply('❌ Error: ' + e.message); }
});

// ═══════════════════════════════════════════════════════
// ✅ NEW: .cachestats - Show OHLCV cache performance
// ═══════════════════════════════════════════════════════
cmd({
    pattern: 'cachestats',
    alias: ['cacheinfo', 'apistats'],
    desc: 'Show OHLCV MongoDB cache performance stats',
    category: 'crypto',
    react: '💾',
    filename: __filename,
},
async (conn, mek, m, { reply }) => {
    try {
        const ohlcvCache = require('../lib/ohlcv-cache');
        const cs = await ohlcvCache.getCacheStats();

        const msg =
            `💾 *OHLCV CACHE STATS*\n━━━━━━━━━━━━━━━━━━\n\n` +
            `📦 Cached Entries:  ${cs.totalEntries}\n` +
            `🪙 Unique Coins:    ${cs.uniqueCoins}\n` +
            `✅ Cache Hit Rate:  ${cs.hitRate}\n` +
            `🎯 Total Hits:      ${cs.hits}\n` +
            `❌ Total Misses:    ${cs.misses}\n\n` +
            `_Hits = Binance API call saved_\n` +
            `_Misses = Fresh fetch from Binance_\n\n` +
            `> *.cacheclear* — cache clear කිරීමට`;

        await reply(msg);
        await m.react('✅');
    } catch (e) { await reply('❌ Error: ' + e.message); }
});

cmd({
    pattern: 'cacheclear',
    alias: ['clearcache'],
    desc: 'Clear OHLCV MongoDB cache',
    category: 'crypto',
    react: '🗑️',
    filename: __filename,
},
async (conn, mek, m, { reply }) => {
    try {
        const ohlcvCache = require('../lib/ohlcv-cache');
        const count = await ohlcvCache.clearCache();
        await reply(`✅ OHLCV cache cleared — ${count} entries removed.`);
        await m.react('✅');
    } catch (e) { await reply('❌ Error: ' + e.message); }
});
