const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    getContentType
} = require('@whiskeysockets/baileys');

// සියලුම පරණ හෙල්පර් ෆන්ක්ෂන්ස් (කිසිවක් අඩු කර නැත)
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

let isBotStarted = false;

async function startBot() {
    if (isBotStarted) return;
    isBotStarted = true;

    console.log("🚀 Initializing APEX-MD Core...");

    // 1. සෙෂන් බාගත කිරීම
    if (!fs.existsSync(path.join(authPath, 'creds.json')) && config.SESSION_ID) {
        console.log("📥 Syncing Session...");
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
            console.log("✅ Session Synced Successfully!");
        } catch (e) {
            console.log("❌ Session Sync Fail:", e.message);
            isBotStarted = false;
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const conn = makeWASocket({
        logger: P({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.macOS("Desktop"),
        auth: state,
        version
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            isBotStarted = false;
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                setTimeout(() => startBot(), 5000);
            }
        } else if (connection === 'open') {
            console.log('✅ APEX-MD IS CONNECTED');
            
            // Plugins load කිරීම
            const pDir = path.join(__dirname, 'plugins');
            if (fs.existsSync(pDir)) {
                fs.readdirSync(pDir).forEach(file => {
                    if (file.endsWith('.js')) {
                        try {
                            require(path.join(pDir, file));
                        } catch (e) {
                            console.log(`Plugin Load Error [${file}]:`, e.message);
                        }
                    }
                });
                console.log("📂 All Plugins Loaded.");
            }
        }
    });

    conn.ev.on('messages.upsert', async (mEvent) => {
        try {
            const mek = mEvent.messages[0];
            if (!mek || !mek.message) return;
            
            // මැසේජ් එක කියවිය හැකි ලෙස සකස් කිරීම
            const m = sms(conn, mek);
            const body = m.body || '';
            const from = m.chat;

            if (config.DEBUG_MODE === 'true' && body) {
                console.log(`📩 [MSG] ${m.sender.split('@')[0]}: ${body}`);
            }

            const prefix = config.PREFIX || ".";
            const isCmd = body.startsWith(prefix);
            
            if (isCmd) {
                const commandName = body.slice(prefix.length).trim().split(' ')[0].toLowerCase();
                const cmd = events.commands.find(c => c.pattern === commandName) || 
                            events.commands.find(c => c.alias && c.alias.includes(commandName));

                if (cmd) {
                    if (config.DEBUG_MODE === 'true') console.log(`⚡ [EXEC] ${commandName}`);
                    
                    const args = body.trim().split(/ +/).slice(1);
                    const q = args.join(' ');
                    const isOwner = config.OWNER_CONTACT.includes(m.sender.split('@')[0]);

                    // විධානයට අදාළ සියලුම functions ලබා දීම
                    await cmd.function(conn, mek, m, {
                        from, 
                        prefix, 
                        q, 
                        args, 
                        isOwner, 
                        reply: (text) => conn.sendMessage(from, { text }, { quoted: mek }),
                        // පරණ සියලුම හෙල්පර්ස් මෙහි ඇත
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
            }
        } catch (e) {
            console.error("Critical Handler Error:", e);
        }
    });
}

async function runSystem() {
    try {
        await connectDB();
        await readEnv();
        app.get("/", (req, res) => res.send("APEX-MD Running ✅"));
        app.listen(port, () => {
            console.log(`🌐 Web Server on port ${port}`);
            startBot();
        });
    } catch (e) {
        console.error("Boot Error:", e);
    }
}

runSystem();

process.on('uncaughtException', (err) => console.log('Runtime Error:', err.message));
process.on('unhandledRejection', (err) => console.log('Promise Rejection:', err.message));
