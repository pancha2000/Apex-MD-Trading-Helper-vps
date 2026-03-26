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
// CMD 5: .zonealert - Alert when price enters an SL/TP/Support/Resistance zone
// Usage: .zonealert BTC 95000 98000  (zone between two prices)
// ═══════════════════════════════════════════════════════
cmd({
    pattern: 'zonealert',
    alias: ['zAlert', 'priceZone', 'rangeAlert'],
    desc: 'Set an alert when price enters a price zone (range)',
    category: 'crypto',
    react: '🎯',
    filename: __filename,
},
async (conn, mek, m, { reply, args }) => {
    try {
        await startAlertChecker(conn);

        if (!args[0] || !args[1] || !args[2]) {
            return await reply(
                `❌ නිවැරදිව ලබා දෙන්න!\n\n*📌 Usage:*\n.zonealert BTC 95000 98000\n\n*ලෙස:* Price $95,000 - $98,000 zone එකට ඇතුල් වූ විට alert.\n\n_SL zone, TP zone, Support/Resistance zone ගානට දාන්න!_`
            );
        }

        let coin = args[0].toUpperCase();
        if (!coin.endsWith('USDT')) coin += 'USDT';

        const zoneBot = parseFloat(args[1]);
        const zoneTop = parseFloat(args[2]);

        if (isNaN(zoneBot) || isNaN(zoneTop) || zoneBot <= 0 || zoneTop <= 0) {
            return await reply('❌ නිවැරදි prices ලබා දෙන්න!');
        }
        const [low, high] = zoneBot < zoneTop ? [zoneBot, zoneTop] : [zoneTop, zoneBot];

        // Save two alerts: above low AND below high (= inside zone)
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${coin}`, { timeout: 5000 });
        const currentPrice = parseFloat(res.data.price);

        await Alert.create([
            { userJid: m.sender, coin, targetPrice: low,  condition: 'above', meta: `ZONE_ENTRY:${low}:${high}` },
            { userJid: m.sender, coin, targetPrice: high, condition: 'below', meta: `ZONE_ENTRY:${low}:${high}` },
        ]);

        await reply(
            `✅ *Zone Alert Set!* 🎯\n\n` +
            `🪙 ${coin.replace('USDT','')} / USDT\n` +
            `💵 Current: $${currentPrice.toFixed(4)}\n` +
            `📦 Zone: $${low} — $${high}\n\n` +
            `_Price zone ඇතුල් වූ විට WhatsApp alert ලැබෙනවා!_\n` +
            `> SL zones, TP zones, OB zones ගානට දාන්න 💡`
        );
        await m.react('✅');
    } catch (e) { await reply('❌ Error: ' + e.message); }
});

// ═══════════════════════════════════════════════════════
// CMD 6: .trackalert - Enhanced multi-target alert (Entry + TP1 + TP2 + SL)
// Usage: .trackalert BTC 97000 105000 110000 92000
//        coin        entry  tp1    tp2    sl
// ═══════════════════════════════════════════════════════
cmd({
    pattern: 'trackalert',
    alias: ['tpalert', 'slalert', 'levelAlert'],
    desc: 'Set Entry/TP/SL level alerts for a trade setup',
    category: 'crypto',
    react: '📐',
    filename: __filename,
},
async (conn, mek, m, { reply, args }) => {
    try {
        await startAlertChecker(conn);

        if (!args[0] || !args[1] || !args[2] || !args[3] || !args[4]) {
            return await reply(
                `❌ නිවැරදිව ලබා දෙන්න!\n\n*📌 Usage:*\n.trackalert BTC 97000 105000 110000 92000\n\n` +
                `Format: *.trackalert <COIN> <ENTRY> <TP1> <TP2> <SL>*\n\n` +
                `_Entry, TP1, TP2, SL hit වූ විට WhatsApp alert!_`
            );
        }

        let coin = args[0].toUpperCase();
        if (!coin.endsWith('USDT')) coin += 'USDT';

        const entry = parseFloat(args[1]);
        const tp1   = parseFloat(args[2]);
        const tp2   = parseFloat(args[3]);
        const sl    = parseFloat(args[4]);

        if ([entry,tp1,tp2,sl].some(v => isNaN(v) || v <= 0)) {
            return await reply('❌ නිවැරදි prices ලබා දෙන්න!');
        }

        const isLong = tp1 > entry;
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${coin}`, { timeout: 5000 });
        const currentPrice = parseFloat(res.data.price);

        // Create alerts for all levels
        const alertsToCreate = [
            { userJid: m.sender, coin, targetPrice: entry, condition: isLong ? 'below' : 'above' },
            { userJid: m.sender, coin, targetPrice: tp1,   condition: isLong ? 'above' : 'below' },
            { userJid: m.sender, coin, targetPrice: tp2,   condition: isLong ? 'above' : 'below' },
            { userJid: m.sender, coin, targetPrice: sl,    condition: isLong ? 'below' : 'above' },
        ];
        await Alert.insertMany(alertsToCreate);

        await reply(
            `✅ *Trade Alerts Set!* 📐\n\n` +
            `🪙 ${coin.replace('USDT','')} / USDT  ${isLong ? '🟢 LONG' : '🔴 SHORT'}\n` +
            `💵 Current: $${currentPrice.toFixed(4)}\n\n` +
            `📍 Entry:  $${entry} → alert\n` +
            `🎯 TP1:    $${tp1}  → alert\n` +
            `🎯 TP2:    $${tp2}  → alert\n` +
            `🛡️ SL:     $${sl}   → alert\n\n` +
            `_සියලු levels hit වූ විට WhatsApp notification!_`
        );
        await m.react('✅');
    } catch (e) { await reply('❌ Error: ' + e.message); }
});
// ═══════════════════════════════════════════════════════
// CMD 4: .clearalerts - Clear all alerts (restored)
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
