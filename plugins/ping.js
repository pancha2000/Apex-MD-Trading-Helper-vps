const { cmd } = require('../lib/commands');

cmd({
        pattern: "ping",
        alias: ["speed", "test"],
        desc: "Check bot's response speed",
        category: "main",
        react: "⚡",
        filename: __filename
    },
    async (conn, mek, m, { reply }) => {
        try {
            const start = Date.now();
            await reply('Testing speed...');
            const end = Date.now();
            const speed = end - start;
            
            await reply(`⚡ *PONG!*\n\n📊 Speed: *${speed}ms*`);
        } catch (e) {
            await reply('❌ Error: ' + e.message);
        }
    });