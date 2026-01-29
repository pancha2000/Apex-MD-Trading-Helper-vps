// plugins/alive.js
const { readEnv } = require('../lib/database');
const { cmd } = require('../command'); // Removed 'commands' as it's not used here

cmd({
    pattern: "alive",
    desc: "Check bot online or no.",
    category: "main",
    filename: __filename
},
async (conn, mek, m, { from, reply }) => { // Only include needed params
    try {
        const config = await readEnv(); // config from DB
        const aliveMsg = config.ALIVE_MSG || "I am alive!"; // Fallback
        const aliveImg = config.ALIVE_IMG; // Optional image

        if (aliveImg) {
            return await conn.sendMessage(from, { image: { url: aliveImg }, caption: aliveMsg }, { quoted: mek });
        } else {
            return await reply(aliveMsg);
        }
    } catch (e) {
        console.error("Error in alive command:", e);
        reply("😥 (Sorry, an error occurred)."); // User-friendly error
    }
});