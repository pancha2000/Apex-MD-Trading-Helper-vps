const { cmd } = require('../lib/commands');

cmd({
        pattern: "restart",
        alias: ["reboot"],
        desc: "Restart the bot (Owner only)",
        category: "owner",
        react: "🔄",
        isOwner: true,
        filename: __filename
    },
    async (conn, mek, m, { reply }) => {
        try {
            await reply('🔄 Restarting APEX-MD...');
            
            setTimeout(() => {
                process.exit(0);
            }, 2000);
            
        } catch (e) {
            await reply('❌ Error: ' + e.message);
        }
    });