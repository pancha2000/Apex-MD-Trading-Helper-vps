const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');

// සියලුම පරණ functions එලෙසම ඇත
const { getBuffer, getGroupAdmins, getRandom, h2k, isUrl, Json, runtime, sleep, fetchJson } = require('./lib/functions');
const fs = require('fs');
const P = require('pino');
const config = require('./config');
const { sms } = require('./lib/msg');
const axios = require('axios');
const { File } = require('megajs');
const path = require('path');
const { getBotSettings, readEnv, connectDB } = require('./lib/mongodb');
const events = require('./command');

const express = require("express");
const app = express();
const port = process.env.PORT || 8000;

const authPath = path.join(__dirname, 'auth_info_baileys');

// WhatsApp සම්බන්ධතාවය හසුරුවන ප්‍රධාන ශ්‍රිතය
async function startBot() {
    console.log("🚀 Starting APEX-MD Connection...");

    // සෙෂන් එක නැත්නම් Mega එකෙන් බාගත කිරීම
    if (!fs.existsSync(authPath) && config.SESSION_ID) {
        console.log("📥 Downloading Session...");
        try {
            const sessdata = config.SESSION_ID.replace("https://mega.nz/file/", "").trim();
            const file = File.fromURL(`https://mega.nz/file/${sessdata}`);
            await new Promise((resolve, reject) => {
                file.download((err, data) => {
                    if (err) reject(err);
                    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });
                    fs.writeFileSync(path.join(authPath, 'creds.json'), data);
                    resolve();
                });
            });
            console.log("✅ Session Downloaded");
        } catch (e) { console.log("❌ Mega Download Error"); }
    }

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const conn = makeWASocket({
        logger: P({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu("Chrome"),
        auth: state
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot(); // සම්බන්ධතාවය බිඳ වැටුණොත් නැවත උත්සාහ කරයි
        } else if (connection === 'open') {
            console.log('✅ APEX-MD IS ONLINE');
            
            // ප්ලගින්ස් ලෝඩ් කිරීම
            const pDir = path.join(__dirname, 'plugins');
            if (fs.existsSync(pDir)) {
                fs.readdirSync(pDir).forEach(file => {
                    if (file.endsWith('.js')) {
                        require(path.join(pDir, file));
                        if (config.DEBUG_MODE === 'true') console.log(`[PLUGIN] ${file} loaded`);
                    }
                });
            }
        }
    });

    conn.ev.on('messages.upsert', async (mekEvent) => {
        try {
            const mek = mekEvent.messages[0];
            if (!mek.message) return;
            
            const m = sms(conn, mek);
            const body = m.body || '';
            const from = m.chat;

            if (config.DEBUG_MODE === 'true' && body) {
                console.log(`📩 [${m.sender.split('@')[0]}]: ${body}`);
            }

            const prefix = config.PREFIX || ".";
            const isCmd = body.startsWith(prefix);
            const command = isCmd ? body.slice(prefix.length).trim().split(' ')[0].toLowerCase() : '';

            if (isCmd) {
                const cmd = events.commands.find((c) => c.pattern === command) || 
                            events.commands.find((c) => c.alias && c.alias.includes(command));

                if (cmd) {
                    const args = body.trim().split(/ +/).slice(1);
                    const q = args.join(' ');
                    const isOwner = config.OWNER_CONTACT.includes(m.sender.split('@')[0]);

                    await cmd.function(conn, mek, m, {
                        from, prefix, q, args, isOwner, 
                        reply: (text) => conn.sendMessage(from, { text }, { quoted: mek }),
                        getBuffer, getGroupAdmins, getRandom, h2k, isUrl, Json, runtime, sleep, fetchJson
                    });
                }
            }
        } catch (e) { console.log("Handler Error:", e); }
    });
}

// මුලින්ම DB එකට සම්බන්ධ වී පසුව සර්වර් එක සහ බොට් පණගන්වයි
async function initApp() {
    await connectDB(); // එක පාරක් පමණක් DB එකට සම්බන්ධ වේ
    await readEnv();
    
    app.get("/", (req, res) => res.send("APEX-MD Online"));
    app.listen(port, () => {
        console.log(`Server running on port ${port}`);
        startBot();
    });
}

initApp();

process.on('uncaughtException', (err) => console.error('Exception:', err));
process.on('unhandledRejection', (err) => console.error('Rejection:', err));
