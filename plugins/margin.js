const { cmd } = require('../lib/commands');
const db = require('../lib/database');

// ================== MARGIN COMMAND ==================
cmd({
        pattern: "margin",
        desc: "Set or view your paper trading capital",
        category: "crypto",
        react: "💰",
        filename: __filename
    },
    async (conn, mek, m, { reply, args }) => {
        try {
            const userJid = m.sender;
            
            if (!args[0]) {
                const user = await db.getUser(userJid);
                const startBal = user.paperStartBalance || user.paperBalance || 0;
                const balance = user.paperBalance || 0;
                const change = balance - startBal;
                const pct = startBal > 0 ? ((change / startBal) * 100).toFixed(2) : '0.00';
                const pWinRate = user.paperTrades > 0 ? ((user.paperWins / user.paperTrades) * 100).toFixed(1) : '0.0';
                const changeEmoji = change >= 0 ? '📈' : '📉';
                const changeStr = (change >= 0 ? '+' : '') + '$' + change.toFixed(2) + ' (' + (change >= 0 ? '+' : '') + pct + '%)';
                
                // Get open positions + unrealized PnL
                const axios = require('axios');
                const openTrades = await db.Trade.find({ userJid, isPaper: true, status: { $in: ['active', 'pending'] } });
                let lockedMargin = 0,
                    unrealizedPnL = 0;
                for (const t of openTrades) {
                    lockedMargin += (t.marginUsed || 0);
                    if (t.status === 'active' && t.quantity) {
                        try {
                            const res = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=' + t.coin, { timeout: 3000 });
                            const lp = parseFloat(res.data.price);
                            const diff = t.direction === 'LONG' ? lp - t.entry : t.entry - lp;
                            unrealizedPnL += diff * t.quantity;
                        } catch {}
                    }
                }
                const freeBalance = balance - lockedMargin;
                const unrealStr = unrealizedPnL >= 0 ? '+$' + unrealizedPnL.toFixed(2) : '-$' + Math.abs(unrealizedPnL).toFixed(2);
                
                const msg = '💼 *Paper Trading Account*\n' +
                    '━━━━━━━━━━━━━━━━\n' +
                    '💰 Total Balance:   $' + balance.toFixed(2) + '\n' +
                    '🔒 Locked Margin:   $' + lockedMargin.toFixed(2) + ' (' + openTrades.length + ' positions)\n' +
                    '💵 Free Balance:    $' + freeBalance.toFixed(2) + '\n' +
                    '📊 Unrealized PnL:  ' + unrealStr + '\n' +
                    '━━━━━━━━━━━━━━━━\n' +
                    '📊 Start Capital:   $' + startBal.toFixed(2) + '\n' +
                    changeEmoji + ' Net Profit/Loss: ' + changeStr + '\n' +
                    '━━━━━━━━━━━━━━━━\n' +
                    '🎯 Total Trades: ' + user.paperTrades + ' | Win Rate: ' + pWinRate + '%\n' +
                    '🟢 Wins: ' + user.paperWins + ' | 🔴 Losses: ' + user.paperLosses + '\n' +
                    '━━━━━━━━━━━━━━━━\n' +
                    '💡 *.margin 1000* — capital reset කරන්න\n' +
                    '📜 *.paperhistory* — closed trades + PnL\n' +
                    '📊 *.myptrades* — active positions';
                return await reply(msg);
            }
            
            const newMargin = parseFloat(args[0]);
            if (isNaN(newMargin) || newMargin <= 0) {
                return await reply('❌ නිවැරදි ගාණක් දෙන්න.\nඋදා: .margin 1000');
            }
            
            // setMargin now also resets paperBalance + paperStartBalance
            await db.setMargin(userJid, newMargin);
            
            const msg = '✅ *Paper Capital Set!*\n' +
                '━━━━━━━━━━━━━━━━\n' +
                '💰 Capital: $' + newMargin.toFixed(2) + '\n\n' +
                '🤖 Paper trades: margin ෙන් 10% deploy\n' +
                '🛡️ Risk per trade: 2% of capital\n' +
                '📊 *.future BTC* → analysis ෙල leverage/qty ගණනය\n' +
                '📈 Wins → capital ↑ | Losses → capital ↓\n\n' +
                '💡 *.mytrades* — active trades + live PnL\n' +
                '💡 *.stats* — full performance history';
            await reply(msg);
            await m.react('✅');
            
        } catch (e) {
            await reply('❌ Error: ' + e.message);
        }
    });