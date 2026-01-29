/**
 * APEX-MD WhatsApp Bot - Stable Core
 * Created by Shehan Vimukthi
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const fs = require('fs-extra');
const P = require('pino');
const path = require('path');
const express = require("express");
const axios = require('axios');
const { File } = require('megajs');

// Config සහ Libraries
const config = require('./config');
const { sms } = require('./lib/msg');
const { getBuffer, getGroupAdmins } = require('./lib/functions');
const { connectDB, getBotSettings, readEnv } = require('./lib/mongodb');

const app = express();
const port = process.env.PORT || 8000;

// ලෝකල් එකේ සෙෂන් ෆෝල්ඩර් එක
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

async function startBot() {
    console.log("🚀 Starting APEX-MD Fresh Initialization...");
    
    // Database එකට සම්බන්ධ වීම
    await connectDB();
    await readEnv();
    const botSettings = getBotSettings();

    // සෙෂන් ෆෝල්ඩර් එක නැත්නම් හදනවා
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    // MEGA හරහා සෙෂන් එක ලබා ගැනීම
    const credsFile = path.join(AUTH_DIR, 'creds.json');
    if (!fs.existsSync(credsFile) && config.SESSION_ID) {
        console.log("📥 Downloading fresh session from MEGA...");
        try {
            const megaFile = File.fromURL(`https://mega.nz/file/${config.SESSION_ID.trim()}`);
            const data = await new Promise((resolve, reject) => {
                megaFile.download((err, result) => err ? reject(err) : resolve(result));
            });
            fs.writeFileSync(credsFile, data);
            console.log("✅ Session downloaded successfully.");
        } catch (e) {
            console.error("❌ Mega download failed. Please check your SESSION_ID.");
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const conn = makeWASocket({
        logger: P({ level: 'silent' }),
        printQRInTerminal: true,
        browser: Browsers.ubuntu("Chrome"),
        version,
        // සෙෂන් එකේ ස්ථාවරභාවය තහවුරු කරන කොටස
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, P({ level: "silent" })),
        },
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
    });

    // සම්බන්ධතාවය පරීක්ෂා කිරීම
    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`📡 Connection lost. Reason: ${reason}`);

            if (reason !== DisconnectReason.loggedOut) {
                console.log("♻️ Attempting to reconnect...");
                startBot();
            } else {
                console.log("❌ Logged out. Please clear auth folder and scan again.");
                fs.removeSync(AUTH_DIR);
            }
        } else if (connection === 'open') {
            console.log('✅ APEX-MD is now ONLINE');
            
            // Plugins Load කිරීම
            const pluginDir = path.join(__dirname, 'plugins');
            if (fs.existsSync(pluginDir)) {
                fs.readdirSync(pluginDir).forEach(file => {
                    if (file.endsWith('.js')) require(path.join(pluginDir, file));
                });
            }

            // අයිතිකරුට දැනුම් දීම
            const statusMsg = `*APEX-MD CONNECTED SUCCESSFULLY* ✅\n\n*Prefix:* ${config.PREFIX}\n*Mode:* ${config.MODE}\n*Owner:* ${config.OWNER_NAME}`;
            await conn.sendMessage(config.OWNER_CONTACT + "@s.whatsapp.net", { text: statusMsg });
        }
    });

    conn.ev.on('creds.update', saveCreds);

    // මැසේජ් හැසිරවීම
    conn.ev.on('messages.upsert', async (mekEvent) => {
        const mek = mekEvent.messages[0];
        if (!mek.message || mek.key.remoteJid === 'status@broadcast') return;

        const m = sms(conn, mek);
        const from = m.chat;
        const body = m.body || '';
        const isCmd = body.startsWith(config.PREFIX);
        const command = isCmd ? body.slice(config.PREFIX.length).trim().split(' ')[0].toLowerCase() : '';
        
        const sender = m.sender;
        const isOwner = config.OWNER_CONTACT.includes(sender.split('@')[0]);

        // වැඩ කරන රටාව (Work Modes)
        if (config.MODE === 'private' && !isOwner) return;
        if (config.MODE === 'inbox' && !isOwner && m.isGroup) return;

        // Commands ලෝඩ් කිරීම
        const events = require('./command');
        const cmd = events.commands.find((c) => c.pattern === command) || events.commands.find((c) => c.alias && c.alias.includes(command));

        if (cmd) {
            try {
                if (cmd.react) conn.sendMessage(from, { react: { text: cmd.react, key: mek.key } });
                await cmd.function(conn, mek, m, { 
                    from, isOwner, reply: (text) => conn.sendMessage(from, { text }, { quoted: mek }) 
                });
            } catch (err) {
                console.error("Command Error:", err);
            }
        }
    });
}

// වෙබ් සර්වර් එක
app.get("/", (req, res) => res.send("APEX-MD Stable Engine is running..."));
app.listen(port, () => {
    console.log(`🌐 Server active on port ${port}`);
    startBot();
});

// වැරදි නිසා බොට් නතර වීම වැළැක්වීමට
process.on('uncaughtException', (err) => console.error('Caught Exception:', err));
process.on('unhandledRejection', (res) => console.error('Unhandled Rejection:', res));
