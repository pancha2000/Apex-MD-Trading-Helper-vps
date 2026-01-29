const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');

const helpers = require('./lib/functions');
const fs = require('fs');
const P = require('pino');
const config = require('./config');
const { sms } = require('./lib/msg');
const { File } = require('megajs');
const path = require('path');
const { getBotSettings, readEnv, connectDB } = require('./lib/mongodb');
const events = require('./command');
const express = require("express");

const app = express();
const port = process.env.PORT || 8000;
const authPath = path.join(__dirname, 'auth_info_baileys');

// බොට් පණගැන්වීමේ තත්ත්වය පාලනයට
let isBotStarting = false;

async function startBot() {
    // එකම වෙලාවේ දෙපාරක් රන් වීම වැළැක්වීමට
    if (isBotStarting) return;
    isBotStarting = true;

    console.log("🚀 Initializing APEX-MD...");

    // 1. සෙෂන් එක නැත්නම් පමණක් ඩවුන්ලෝඩ් කිරීම
    if (!fs.existsSync(path.join(authPath, 'creds.json')) && config.SESSION_ID) {
        console.log("📥 Syncing Session from Mega...");
        try {
            const sessUrl = config.SESSION_ID.includes("https://mega.nz") 
                ? config.SESSION_ID 
                : `https://mega.nz/file/${config.SESSION_ID.trim()}`;
            
            const file = File.fromURL(sessUrl);
            const data = await new Promise((resolve, reject) => {
                file.download((err, data) => err ? reject(err) : resolve(data));
            });

            if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });
            fs.writeFileSync(path.join(authPath, 'creds.json'), data);
            console.log("✅ Session Ready.");
        } catch (e) {
            console.log("❌ Mega Sync Fail:", e.message);
            isBotStarting = false;
            return;
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const conn = makeWASocket({
        logger: P({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.macOS("Desktop"),
        auth: state,
        version,
        // සෙෂන් එක ස්ථාවරව තබා ගැනීමට පහත සෙටින්ග්ස් එක් කළා
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            isBotStarting = false;
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`📡 Disconnected. Reason: ${reason}`);

            // සෙෂන් එක වැඩ කරන්නේ නැත්නම් ෆයිල් එක මකන්න (එවිට ඊළඟ වතාවේ අලුතින් බාගත වේ)
            if (reason === 401 || reason === 428) {
                console.log("⚠️ Session Invalid. Clearing cache...");
                if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
            }

            if (reason !== DisconnectReason.loggedOut) {
                console.log("🔄 Reconnecting in 10s...");
                setTimeout(() => startBot(), 10000);
            }
        } else if (connection === 'open') {
            isBotStarting = false;
            console.log('✅ APEX-MD IS CONNECTED');
            
            // Plugins load කිරීම
            const pDir = path.join(__dirname, 'plugins');
            if (fs.existsSync(pDir)) {
                fs.readdirSync(pDir).forEach(file => {
                    if (file.endsWith('.js')) {
                        try { require(path.join(pDir, file)); } catch (e) {}
                    }
                });
            }
        }
    });

    conn.ev.on('messages.upsert', async (mEvent) => {
        try {
            const mek = mEvent.messages[0];
            if (!mek || !mek.message) return;
            
            const m = sms(conn, mek);
            const body = m.body || '';
            const from = m.chat;

            if (config.DEBUG_MODE === 'true' && body) {
                console.log(`📩 [MSG] ${m.sender.split('@')[0]}: ${body}`);
            }

            const prefix = config.PREFIX || ".";
            if (!body.startsWith(prefix)) return;

            const commandName = body.slice(prefix.length).trim().split(' ')[0].toLowerCase();
            const cmd = events.commands.find(c => c.pattern === commandName) || 
                        events.commands.find(c => c.alias && c.alias.includes(commandName));

            if (cmd) {
                const args = body.trim().split(/ +/).slice(1);
                const q = args.join(' ');
                const isOwner = config.OWNER_CONTACT.includes(m.sender.split('@')[0]);

                await cmd.function(conn, mek, m, {
                    from, prefix, q, args, isOwner, 
                    reply: (text) => conn.sendMessage(from, { text }, { quoted: mek }),
                    getBuffer: helpers.getBuffer,
                    getGroupAdmins: helpers.getGroupAdmins,
                    getRandom: helpers.getRandom,
                    h2k: helpers.h2k,
                    isUrl: helpers.isUrl,
                    Json: helpers.Json,
                    runtime: helpers.runtime,
                    sleep: helpers.sleep,
                    fetchJson: helpers.fetchJson
                });
            }
        } catch (e) {
            console.error("Handler Error:", e.message);
        }
    });
}

async function runSystem() {
    try {
        await connectDB();
        await readEnv();
        app.get("/", (req, res) => res.send("APEX-MD Active ✅"));
        app.listen(port, () => {
            console.log(`🌐 Web Server on port ${port}`);
            startBot();
        });
    } catch (e) {
        console.error("Boot Error:", e);
    }
}

runSystem();

// Crash නොවී තබා ගැනීමට
process.on('uncaughtException', (err) => console.log('Runtime Error:', err.message));
process.on('unhandledRejection', (err) => console.log('Rejection:', err.message));
