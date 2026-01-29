const { cmd } = require('../command');

cmd({
    pattern: "ping",
    desc: "Check bot's response time.",
    category: "main",
    react: "⚡",
    filename: __filename
},
async (conn, mek, m, { from, reply }) => {
    try {
        const start = new Date().getTime();
        const end = new Date().getTime();
        const ping = end - start;
        await reply(`*Pong!* ⚡\nSpeed: ${ping}ms`);
    } catch (e) {
        console.log(e);
        reply(`Error: ${e}`);
    }
});
