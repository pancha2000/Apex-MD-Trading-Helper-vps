const { cmd } = require('../lib/commands');
const db = require('../lib/database');
const config = require('../config');
const scanner = require('./scanner');

cmd({
    pattern: "settings",
    alias: ["botsettings", "control", "panel"],
    desc: "Master Bot Control Panel (Owner Only)",
    category: "owner",
    isOwner: true,
    react: "⚙️",
    filename: __filename
},
async (conn, mek, m, { reply }) => {
    try {
        const s = await db.getSettings();
        const msg = `
╔═══════════════════════════╗
║ ⚙️ *APEX-MD MASTER PANEL* ║
╚═══════════════════════════╝

*--- 🚀 Core Engine Settings ---*
*1. Auto Signals:* ${scanner.getScannerStatus() ? '✅ ON' : '❌ OFF'}
*2. Trailing SL:* ${s.trailingSl ? '✅ ON' : '❌ OFF'}
*3. Strict Mode:* ${s.strictMode ? '✅ ON' : '❌ OFF'}
*4. Partial TP:* ${s.partialTp ? '✅ ON' : '❌ OFF'}
*5. Min RRR:* ${s.minRRR}x


📌 *වෙනස් කිරීමට පහත කමාන්ඩ්ස් භාවිතා කරන්න:*
${config.PREFIX}set 1 on/off  → Auto Signals
${config.PREFIX}set 2 on/off  → Trailing SL
${config.PREFIX}set 3 on/off  → Strict Mode
${config.PREFIX}set 4 on/off  → Partial TP Alerts
${config.PREFIX}set 5 1.5     → Min RRR value`;

        await reply(msg.trim());
    } catch (e) { await reply('❌ Error: ' + e.message); }
});

cmd({
    pattern: "set",
    desc: "Change bot settings",
    category: "owner",
    isOwner: true,
    react: "🔄",
    filename: __filename
},
async (conn, mek, m, { reply, args }) => {
    try {
        if (!args[0] || !args[1]) return await reply(`❌ නිවැරදිව ලබා දෙන්න.\n*උදා:* ${config.PREFIX}set 3 off`);

        const num   = args[0];
        const value = args[1].toLowerCase();
        const state = value === 'on';

        let updateData = {}, featureName = "";

        if (num === '1') {
            updateData.autoSignal = state;
            featureName = "Auto Signals";
            if (state) {
                const ownerJid = m.sender || mek.sender;
                const started = await scanner.startScannerFromSettings(conn, ownerJid);
                if (!started) return await reply('⚠️ Auto Scanner දැනටමත් ක්‍රියාත්මකයි!');
            } else {
                scanner.stopScannerFromSettings();
            }
        }
        else if (num === '2') { updateData.trailingSl = state;  featureName = "Trailing SL"; }
        else if (num === '3') { updateData.strictMode = state;  featureName = "Strict Mode"; }
        else if (num === '4') { updateData.partialTp = state;   featureName = "Partial TP"; }
        else if (num === '5') {
            const rrrVal = parseFloat(value);
            if (isNaN(rrrVal) || rrrVal < 1.0 || rrrVal > 5.0) return await reply(`❌ Min RRR 1.0 - 5.0 අතර විය යුතුය.`);
            updateData.minRRR = rrrVal; featureName = `Min RRR → ${rrrVal}x`;
        }
        else return await reply('❌ 1-5 අතර අංකයක් භාවිතා කරන්න.');

        await db.updateSettings(updateData);
        await reply(`✅ *${featureName}* යාවත්කාලීන කරන ලදී!`);
        await m.react('✅');
    } catch (e) { await reply('❌ Error: ' + e.message); }
});
