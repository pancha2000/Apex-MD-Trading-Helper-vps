// සියලුම පරණ modules සහ imports එලෙසම පවතී
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');

// මුල් කේතයේ තිබූ සියලුම functions (කිසිවක් අඩු කර නැත)
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

async function startBot() {
    // 1. ඩේටාබේස් සම්බන්ධ කිරීම (Auto Reset පාලනය මෙහි ඇත)
    await connectDB();
    await readEnv();
    let botSettings = getBotSettings();

    console.log("🚀 Starting APEX-MD Core...");

    const authPath = path.join(__dirname, 'auth_info_baileys');

    // 2. සෙෂන් ඩවුන්ලෝඩ් කිරීමේ ශ්‍රිතය
    if (!fs.existsSync(authPath) && config.SESSION_ID) {
        console.log("📥 Downloading Session...");
        try {
            const sessdata = config.SESSION_ID.replace("https://mega.nz/file/", "").trim();
            const file = File.fromURL(`https://mega.nz/file/${sessdata}`);
            await new Promise((resolve, reject) => {
                file.download((err, data) => {
                    if (err) reject(err);
                    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath);
                    fs.writeFileSync(path.join(authPath, 'creds.json'), data);
                    resolve();
                });
            });
            console.log("✅ Session Loaded");
        } catch (e) { console.log("❌ Mega Session Error"); }
    }

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const conn = makeWASocket({
        logger: P({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu("Chrome"),
        auth: state
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            if (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut) startBot();
        } else if (connection === 'open') {
            console.log('✅ APEX-MD IS ONLINE');
            
            // Plugins ලෝඩ් කිරීම
            const pDir = path.join(__dirname, 'plugins');
            if (fs.existsSync(pDir)) {
                fs.readdirSync(pDir).forEach(file => {
                    if (file.endsWith('.js')) {
                        require(path.join(pDir, file));
                        if (config.DEBUG_MODE === 'true') console.log(`[OK] ${file} loaded`);
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

            // DEBUG_MODE ලොග්ස් පාලනය
            if (config.DEBUG_MODE === 'true' && body) {
                console.log(`📩 [LOG] ${m.sender.split('@')[0]}: ${body}`);
            }

            const prefix = config.PREFIX || ".";
            const isCmd = body.startsWith(prefix);
            const command = isCmd ? body.slice(prefix.length).trim().split(' ')[0].toLowerCase() : '';

            if (isCmd) {
                const cmd = events.commands.find((c) => c.pattern === command) || 
                            events.commands.find((c) => c.alias && c.alias.includes(command));

                if (cmd) {
                    if (config.DEBUG_MODE === 'true') console.log(`⚡ Executing: ${command}`);
                    
                    const args = body.trim().split(/ +/).slice(1);
                    const q = args.join(' ');
                    const isOwner = config.OWNER_CONTACT.includes(m.sender.split('@')[0]);

                    // විධානය ක්‍රියාත්මක කිරීම (පරණ සියලුම params එලෙසම ඇත)
                    await cmd.function(conn, mek, m, {
                        from, prefix, q, args, isOwner, 
                        reply: (text) => conn.sendMessage(from, { text }, { quoted: mek }),
                        getBuffer, getGroupAdmins, getRandom, h2k, isUrl, Json, runtime, sleep, fetchJson
                    });
                }
            }
        } catch (e) { console.log(e); }
    });
}

// Keep alive server
app.get("/", (req, res) => res.send("Bot is Alive"));
app.listen(port, () => startBot());

// Anti-crash logic
process.on('uncaughtException', (err) => console.error(err));
process.on('unhandledRejection', (err) => console.error(err));
