const { cmd } = require('../lib/commands');
const config = require('../config');

cmd({
        pattern: "owner",
        alias: ["creator", "dev"],
        desc: "Show owner contact",
        category: "main",
        react: "👤",
        filename: __filename
    },
    async (conn, mek, m, { reply }) => {
        try {
            const vcard = `BEGIN:VCARD
VERSION:3.0
FN:${config.OWNER_NAME}
ORG:APEX-MD;
TEL;type=CELL;type=VOICE;waid=${config.OWNER_NUMBER}:+${config.OWNER_NUMBER}
END:VCARD`;
            
            await conn.sendMessage(m.from, {
                contacts: {
                    displayName: config.OWNER_NAME,
                    contacts: [{ vcard }]
                }
            }, { quoted: mek });
            
            await reply(`👤 *Owner:* ${config.OWNER_NAME}\n📱 *Number:* +${config.OWNER_NUMBER}`);
        } catch (e) {
            await reply('❌ Error: ' + e.message);
        }
    });