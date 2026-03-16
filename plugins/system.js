const { cmd } = require('../lib/commands');
const { runtime, formatNumber } = require('../lib/functions');
const config = require('../config');
const os = require('os');

cmd({
        pattern: "system",
        alias: ["status", "info", "botinfo"],
        desc: "Show system information",
        category: "main",
        react: "💻",
        filename: __filename
    },
    async (conn, mek, m, { reply }) => {
        try {
            const uptime = runtime(process.uptime());
            const totalMem = formatNumber(os.totalmem() / 1024 / 1024);
            const freeMem = formatNumber(os.freemem() / 1024 / 1024);
            const usedMem = formatNumber((os.totalmem() - os.freemem()) / 1024 / 1024);
            
            const systemInfo = `
╔════════════════════════════╗
║     SYSTEM INFORMATION     ║
╚════════════════════════════╝

┏━━━ *BOT INFO* ━━━
┃ 🤖 *Name:* ${config.BOT_NAME}
┃ 📌 *Version:* 2.0.0
┃ ⏱️ *Uptime:* ${uptime}
┃ 👤 *Owner:* ${config.OWNER_NAME}
┗━━━━━━━━━━━━━━━

┏━━━ *SERVER INFO* ━━━
┃ 🖥️ *Platform:* ${os.platform()}
┃ 💾 *Total RAM:* ${totalMem} MB
┃ 📊 *Used RAM:* ${usedMem} MB
┃ 🆓 *Free RAM:* ${freeMem} MB
┃ 🔢 *CPU Cores:* ${os.cpus().length}
┗━━━━━━━━━━━━━━━

> *APEX-MD V2* 🚀
`;
            
            await reply(systemInfo);
        } catch (e) {
            await reply('❌ Error: ' + e.message);
        }
    });