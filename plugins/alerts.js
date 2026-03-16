const { cmd } = require('../lib/commands');
const axios = require('axios');
const mongoose = require('mongoose');

// ─── Alert Schema (Database) ───
const AlertSchema = new mongoose.Schema({
    userJid:    { type: String, required: true },
    coin:       { type: String, required: true },
    targetPrice:{ type: Number, required: true },
    condition:  { type: String, enum: ['above', 'below'], required: true }, // above / below
    triggered:  { type: Boolean, default: false },
    createdAt:  { type: Date, default: Date.now }
});

const Alert = mongoose.models.Alert || mongoose.model('Alert', AlertSchema);

// ─── Global Alert Checker (scan every 30s) ───
let alertCheckerStarted = false;

async function startAlertChecker(conn) {
    if (alertCheckerStarted) return;
    alertCheckerStarted = true;

    setInterval(async () => {
        try {
            const activeAlerts = await Alert.find({ triggered: false });
            if (!activeAlerts || activeAlerts.length === 0) return;

            // Group alerts by coin to minimize API calls
            const coinMap = {};
            for (const a of activeAlerts) {
                if (!coinMap[a.coin]) coinMap[a.coin] = [];
                coinMap[a.coin].push(a);
            }

            for (const coin of Object.keys(coinMap)) {
                try {
                    const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${coin}`, { timeout: 5000 });
                    const currentPrice = parseFloat(res.data.price);

                    for (const alert of coinMap[coin]) {
                        let triggered = false;
                        if (alert.condition === 'above' && currentPrice >= alert.targetPrice) triggered = true;
                        if (alert.condition === 'below' && currentPrice <= alert.targetPrice) triggered = true;

                        if (triggered) {
                            // Mark as triggered
                            await Alert.findByIdAndUpdate(alert._id, { triggered: true });

                            const dirEmoji = alert.condition === 'above' ? '🚀' : '📉';
                            const msg = `
🔔 *PRICE ALERT TRIGGERED!* ${dirEmoji}

🪙 ${coin.replace('USDT', '')} / USDT
💵 Current Price: $${currentPrice.toFixed(4)}
🎯 Your Target:  $${alert.targetPrice}
📌 Condition: Price went ${alert.condition.toUpperCase()} target!

> .alert delete කිරීමට .myalerts බලන්න.`;
                            await conn.sendMessage(alert.userJid, { text: msg.trim() });
                        }
                    }
                } catch (e) { /* skip this coin */ }
            }
        } catch (e) { /* silent fail */ }
    }, 30000); // Every 30 seconds
}

// ═══════════════════════════════════════════════════════
// CMD 1: .alert - Set a price alert
// Usage: .alert BTC 100000
//        .alert BTC above 100000  OR  .alert BTC below 90000
// ═══════════════════════════════════════════════════════
cmd({
    pattern: "alert",
    alias: ["setalert", "pricealert"],
    desc: "Set a price alert for any coin",
    category: "crypto",
    react: "🔔",
    filename: __filename
},
async (conn, mek, m, { reply, args }) => {
    try {
        // ─── Start checker if not started ───
        await startAlertChecker(conn);

        if (!args[0]) {
            return await reply(`❌ නිවැරදිව ලබා දෙන්න!\n\n*📌 Usage:*\n.alert BTC 100000\n.alert BTC above 100000\n.alert BTC below 90000\n\n*📋 Alerts බැලීමට:* .myalerts\n*🗑️ Delete කිරීමට:* .delalert <ID>`);
        }

        let coin = args[0].toUpperCase();
        if (!coin.endsWith('USDT')) coin += 'USDT';

        // Parse condition and price
        let condition = 'above';
        let targetPrice = 0;

        if (args[1] && (args[1].toLowerCase() === 'above' || args[1].toLowerCase() === 'below')) {
            condition = args[1].toLowerCase();
            targetPrice = parseFloat(args[2]);
        } else {
            targetPrice = parseFloat(args[1]);
        }

        if (isNaN(targetPrice) || targetPrice <= 0) {
            return await reply('❌ නිවැරදි price එකක් ලබා දෙන්න!\nඋදා: *.alert BTC 100000*');
        }

        // Get current price to auto-detect condition if not specified
        try {
            const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${coin}`, { timeout: 5000 });
            const currentPrice = parseFloat(res.data.price);

            // Auto-detect condition
            if (!args[1] || (!['above', 'below'].includes(args[1].toLowerCase()))) {
                condition = targetPrice > currentPrice ? 'above' : 'below';
            }

            const dirEmoji = condition === 'above' ? '🚀' : '📉';

            await Alert.create({
                userJid: m.sender,
                coin,
                targetPrice,
                condition
            });

            await reply(`✅ *Price Alert Set!* 🔔\n\n🪙 ${coin.replace('USDT', '')} / USDT\n💵 Current Price: $${currentPrice.toFixed(4)}\n🎯 Alert Price: $${targetPrice}\n${dirEmoji} Condition: Price goes ${condition.toUpperCase()} $${targetPrice}\n\n_Price hit වෙද්දී WhatsApp message ලැබෙනු ඇත._`);
            await m.react('✅');
        } catch (e) {
            return await reply(`❌ ${coin} coin validate කිරීමට නොහැකි විය. Coin නම නිවැරදිදැ?`);
        }
    } catch (e) {
        await reply('❌ Error: ' + e.message);
    }
});

// ═══════════════════════════════════════════════════════
// CMD 2: .myalerts - View all active alerts
// ═══════════════════════════════════════════════════════
cmd({
    pattern: "myalerts",
    alias: ["alerts", "alertlist"],
    desc: "View your active price alerts",
    category: "crypto",
    react: "📋",
    filename: __filename
},
async (conn, mek, m, { reply }) => {
    try {
        const alerts = await Alert.find({ userJid: m.sender, triggered: false }).sort({ createdAt: -1 });

        if (!alerts || alerts.length === 0) {
            return await reply('📋 ඔබට active alerts කිසිවක් නොමැත.\n\n*.alert BTC 100000* ලෙස alert set කරන්න.');
        }

        let msg = `🔔 *ඔබගේ Active Price Alerts (${alerts.length})*\n\n`;
        alerts.forEach((a, i) => {
            const dirEmoji = a.condition === 'above' ? '🚀' : '📉';
            msg += `*${i+1}. ${a.coin.replace('USDT','')}* ${dirEmoji}\n`;
            msg += `   🎯 $${a.targetPrice} (${a.condition.toUpperCase()})\n`;
            msg += `   🆔 ID: \`${a._id}\`\n\n`;
        });
        msg += `> Delete කිරීමට: *.delalert <ID>*\n> සියල්ල delete: *.clearalerts*`;

        await reply(msg);
        await m.react('✅');
    } catch (e) {
        await reply('❌ Error: ' + e.message);
    }
});

// ═══════════════════════════════════════════════════════
// CMD 3: .delalert - Delete specific alert
// ═══════════════════════════════════════════════════════
cmd({
    pattern: "delalert",
    alias: ["deletealert", "removealert"],
    desc: "Delete a specific price alert",
    category: "crypto",
    react: "🗑️",
    filename: __filename
},
async (conn, mek, m, { reply, args }) => {
    try {
        if (!args[0]) return await reply('❌ Alert ID ලබා දෙන්න!\nඋදා: *.delalert 64abc123...*');

        const deleted = await Alert.findOneAndDelete({ _id: args[0], userJid: m.sender });
        if (deleted) {
            await reply(`✅ Alert (${deleted.coin} @ $${deleted.targetPrice}) සාර්ථකව delete කරන ලදී.`);
            await m.react('✅');
        } else {
            await reply('❌ Alert සොයාගත නොහැක. ID නිවැරදිදැ?');
        }
    } catch (e) {
        await reply('❌ Error: ' + e.message);
    }
});

// ═══════════════════════════════════════════════════════
// CMD 4: .clearalerts - Clear all alerts
// ═══════════════════════════════════════════════════════
cmd({
    pattern: "clearalerts",
    desc: "Clear all your active price alerts",
    category: "crypto",
    react: "🗑️",
    filename: __filename
},
async (conn, mek, m, { reply }) => {
    try {
        const result = await Alert.deleteMany({ userJid: m.sender, triggered: false });
        await reply(`✅ Alerts ${result.deletedCount}ක් clear කරන ලදී.`);
        await m.react('✅');
    } catch (e) {
        await reply('❌ Error: ' + e.message);
    }
});