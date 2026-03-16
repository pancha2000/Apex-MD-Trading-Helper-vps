const { cmd } = require('../lib/commands');
const axios = require('axios');
const db = require('../lib/database');
const mongoose = require('mongoose');

// ─── Watchlist Schema ───
const WatchlistSchema = new mongoose.Schema({
    userJid: { type: String, required: true, unique: true },
    coins:   { type: [String], default: [] }
});
const Watchlist = mongoose.models.Watchlist || mongoose.model('Watchlist', WatchlistSchema);

// ═══════════════════════════════════════════════════════
// CMD 1: .watch - Add coins to watchlist
// Usage: .watch BTC ETH SOL
// ═══════════════════════════════════════════════════════
cmd({
    pattern: "watch",
    alias: ["watchlist", "addwatch"],
    desc: "Add coins to your personal watchlist",
    category: "crypto",
    react: "👀",
    filename: __filename
},
async (conn, mek, m, { reply, args }) => {
    try {
        if (!args[0]) {
            // Show current watchlist with prices
            const wl = await Watchlist.findOne({ userJid: m.sender });
            if (!wl || wl.coins.length === 0) {
                return await reply(`👀 *ඔබගේ Watchlist හිස්ව ඇත.*\n\n*Coins add කිරීමට:*\n.watch BTC ETH SOL\n\n*Watchlist prices:*\n.wlcheck`);
            }

            // Fetch live prices
            await m.react('⏳');
            let msg = `👀 *ඔබගේ Watchlist (${wl.coins.length} coins)*\n\n`;
            for (const coin of wl.coins) {
                try {
                    const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}`, { timeout: 5000 });
                    const d = res.data;
                    const price = parseFloat(d.lastPrice);
                    const chg = parseFloat(d.priceChangePercent);
                    const emoji = chg >= 2 ? '🚀' : chg >= 0 ? '🟢' : chg >= -2 ? '🔴' : '💀';
                    msg += `${emoji} *${coin.replace('USDT','')}*: $${price.toFixed(4)} (${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%)\n`;
                } catch (e) {
                    msg += `⚪ *${coin.replace('USDT','')}*: N/A\n`;
                }
            }
            msg += `\n> Remove: *.unwatch BTC*\n> Clear all: *.clearwatch*`;
            await reply(msg);
            await m.react('✅');
            return;
        }

        // Add coins
        const newCoins = args.map(c => {
            c = c.toUpperCase();
            return c.endsWith('USDT') ? c : c + 'USDT';
        });

        // Validate coins exist on Binance
        const validCoins = [];
        const invalidCoins = [];
        for (const coin of newCoins) {
            try {
                await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${coin}`, { timeout: 5000 });
                validCoins.push(coin);
            } catch (e) {
                invalidCoins.push(coin);
            }
        }

        if (validCoins.length === 0) {
            return await reply('❌ ලබාදුන් coins Binance හි නොමැත. නම් check කරන්න.');
        }

        // Upsert watchlist (max 15 coins)
        let wl = await Watchlist.findOne({ userJid: m.sender });
        if (!wl) wl = new Watchlist({ userJid: m.sender, coins: [] });

        const existing = wl.coins;
        const toAdd = validCoins.filter(c => !existing.includes(c));
        const alreadyIn = validCoins.filter(c => existing.includes(c));

        if (existing.length + toAdd.length > 15) {
            return await reply(`❌ Watchlist limit 15 coins. දැනට ${existing.length} ඇත. ${15 - existing.length}ක් add කළ හැකිය.`);
        }

        wl.coins = [...existing, ...toAdd];
        await wl.save();

        let replyMsg = `✅ *Watchlist Updated!*\n\n`;
        if (toAdd.length > 0) replyMsg += `🟢 Added: ${toAdd.map(c => c.replace('USDT','')).join(', ')}\n`;
        if (alreadyIn.length > 0) replyMsg += `⚪ Already in watchlist: ${alreadyIn.map(c => c.replace('USDT','')).join(', ')}\n`;
        if (invalidCoins.length > 0) replyMsg += `❌ Not found: ${invalidCoins.join(', ')}\n`;
        replyMsg += `\n📋 Total: ${wl.coins.length}/15 coins`;

        await reply(replyMsg);
        await m.react('✅');
    } catch (e) {
        await reply('❌ Error: ' + e.message);
    }
});

// ═══════════════════════════════════════════════════════
// CMD 2: .unwatch - Remove coin from watchlist
// ═══════════════════════════════════════════════════════
cmd({
    pattern: "unwatch",
    alias: ["removewatch"],
    desc: "Remove a coin from watchlist",
    category: "crypto",
    react: "🗑️",
    filename: __filename
},
async (conn, mek, m, { reply, args }) => {
    try {
        if (!args[0]) return await reply('❌ Coin නම ලබා දෙන්න!\nඋදා: *.unwatch BTC*');

        const coin = args[0].toUpperCase().replace('USDT','') + 'USDT';
        const wl = await Watchlist.findOne({ userJid: m.sender });

        if (!wl || !wl.coins.includes(coin)) {
            return await reply(`❌ ${coin.replace('USDT','')} ඔබගේ watchlist හි නොමැත.`);
        }

        wl.coins = wl.coins.filter(c => c !== coin);
        await wl.save();

        await reply(`✅ ${coin.replace('USDT','')} watchlist එකෙන් ඉවත් කරන ලදී.\n📋 දැන් watchlist: ${wl.coins.length} coins`);
        await m.react('✅');
    } catch (e) {
        await reply('❌ Error: ' + e.message);
    }
});

// ═══════════════════════════════════════════════════════
// CMD 3: .clearwatch - Clear entire watchlist
// ═══════════════════════════════════════════════════════
cmd({
    pattern: "clearwatch",
    desc: "Clear entire watchlist",
    category: "crypto",
    react: "🗑️",
    filename: __filename
},
async (conn, mek, m, { reply }) => {
    try {
        await Watchlist.findOneAndUpdate({ userJid: m.sender }, { coins: [] }, { upsert: true });
        await reply('✅ Watchlist clear කරන ලදී.');
        await m.react('✅');
    } catch (e) {
        await reply('❌ Error: ' + e.message);
    }
});

// ═══════════════════════════════════════════════════════
// CMD 4: .wlcheck - Quick price check for watchlist
// ═══════════════════════════════════════════════════════
cmd({
    pattern: "wlcheck",
    alias: ["wl", "prices"],
    desc: "Quick price check for all watchlist coins",
    category: "crypto",
    react: "📊",
    filename: __filename
},
async (conn, mek, m, { reply }) => {
    try {
        const wl = await Watchlist.findOne({ userJid: m.sender });
        if (!wl || wl.coins.length === 0) {
            return await reply('👀 Watchlist හිස්ව ඇත. *.watch BTC ETH SOL* ලෙස add කරන්න.');
        }

        await m.react('⏳');

        // Batch fetch all prices at once
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr`, { timeout: 10000 });
        const allTickers = res.data;
        const tickerMap = {};
        allTickers.forEach(t => tickerMap[t.symbol] = t);

        let msg = `📊 *Watchlist Live Prices*\n_${new Date().toUTCString().slice(0,25)}_\n\n`;

        for (const coin of wl.coins) {
            const d = tickerMap[coin];
            if (d) {
                const price = parseFloat(d.lastPrice);
                const chg = parseFloat(d.priceChangePercent);
                const vol = (parseFloat(d.quoteVolume) / 1000000).toFixed(1);
                const emoji = chg >= 5 ? '🚀' : chg >= 1 ? '🟢' : chg >= -1 ? '⚪' : chg >= -5 ? '🔴' : '💀';
                const bar = chg >= 0 ? '▲' : '▼';
                msg += `${emoji} *${coin.replace('USDT','')}*\n`;
                msg += `   💵 $${price.toFixed(4)}  ${bar}${Math.abs(chg).toFixed(2)}%  📊 Vol: $${vol}M\n\n`;
            } else {
                msg += `⚪ *${coin.replace('USDT','')}*: N/A\n\n`;
            }
        }

        msg += `> AI Analysis: *.future BTC 15m*`;
        await reply(msg.trim());
        await m.react('✅');
    } catch (e) {
        await reply('❌ Error: ' + e.message);
    }
});

// ═══════════════════════════════════════════════════════
// CMD 5: .papercapital - Set paper trading starting balance
// Usage: .papercapital 500
// ═══════════════════════════════════════════════════════
cmd({
    pattern: "papercapital",
    alias: ["paperbalance", "setpaper"],
    desc: "Set paper trading starting balance",
    category: "crypto",
    react: "💰",
    filename: __filename
},
async (conn, mek, m, { reply, args }) => {
    try {
        if (!args[0]) {
            const user = await db.getUser(m.sender);
            const startBal = user.paperStartBalance || 100;
            return await reply(`🤖 *Paper Trading Balance*\n\n💰 Starting Capital: $${startBal}\n📊 Current Balance: $${user.paperBalance.toFixed(2)}\n📈 P&L: ${user.paperBalance >= startBal ? '+' : ''}$${(user.paperBalance - startBal).toFixed(2)}\n\n> *.papercapital 500* ලෙස reset කරන්න (history ද clear වේ)`);
        }

        const amount = parseFloat(args[0]);
        if (isNaN(amount) || amount < 10 || amount > 1000000) {
            return await reply('❌ $10 - $1,000,000 අතර amount ලෙස ලබා දෙන්න!');
        }

        await db.setPaperCapital(m.sender, amount);
        await reply(`✅ *Paper Trading Reset!*\n\n💰 Starting Capital: $${amount}\n📊 Virtual Balance: $${amount}\n🔄 Trade history ද clear කරන ලදී.\n\n_Auto Paper Trading *.scanstart* ලෙස ආරම්භ කරන්න._`);
        await m.react('✅');
    } catch (e) {
        await reply('❌ Error: ' + e.message);
    }
});