const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');

// සියලුම පරණ හෙල්පර් ෆන්ක්ෂන්ස් (කිසිවක් අඩු කර නැත)
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

async function startBot() {
    console.log("🚀 Starting APEX-MD Connection...");

    // 1. සෙෂන් ෆයිල් එක පරීක්ෂාව සහ බාගත කිරීම
    if (!fs.existsSync(path.join(authPath, 'creds.json')) && config.SESSION_ID) {
        console.log("📥 Downloading Session from Mega...");
        try {
            const sessdata = config.SESSION_ID.replace("https://mega.nz/file/", "").trim();
            const file = File.fromURL(`https://mega.nz/file/${sessdata}`);
            await new Promise((resolve, reject) => {
                file.download((err, data) => {
                    if (err) return reject(err);
                    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });
                    fs.writeFileSync(path.join(authPath, 'creds.json'), data);
                    resolve();
                });
            });
            console.log("✅ Session Downloaded & Saved.");
        } catch (e) {
            console.log("❌ Mega Download Failed:", e.message);
        }
    }

    // 2. Auth State එක ලබා ගැනීම
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    // 3. Socket එක සැකසීම
    const conn = makeWASocket({
        logger: P({ level: 'silent' }),
        printQRInTerminal: false, // QR පෙන්වීම අවශ්‍ය නැත (Session පාවිච්චි කරන නිසා)
        browser: Browsers.ubuntu("Chrome"),
        auth: state,
        version
    });

    // Creds යාවත්කාලීන කිරීම
    conn.ev.on('creds.update', saveCreds);

    // 4. සම්බන්ධතාවයේ තත්ත්වය පරීක්ෂා කිරීම (Loop වීම වැළැක්වීමට නිවැරදි ලොජික් එක)
    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`📡 Connection closed. Status Code: ${statusCode}. Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                // සැනෙකින් රීස්ටාර්ට් නොවී තත්පර 5ක් ඉන්න (Loop Guard)
                setTimeout(() => startBot(), 5000);
            }
        } else if (connection === 'open') {
            console.log('✅ APEX-MD IS ONLINE');
            
            // Plugins ලෝඩ් කිරීම
            const pDir = path.join(__dirname, 'plugins');
            if (fs.existsSync(pDir)) {
                fs.readdirSync(pDir).forEach(file => {
                    if (file.endsWith('.js')) {
                        try {
                            require(path.join(pDir, file));
                            if (config.DEBUG_MODE === 'true') console.log(`[OK] Plugin Loaded: ${file}`);
                        } catch (e) {
                            console.error(`❌ Error loading plugin ${file}:`, e);
                        }
                    }
                });
            }
        }
    });

    // 5. මැසේජ් ලැබෙන විට ක්‍රියාවලිය
    conn.ev.on('messages.upsert', async (mekEvent) => {
        try {
            const mek = mekEvent.messages[0];
            if (!mek || !mek.message) return;
            
            const m = sms(conn, mek);
            const body = m.body || '';
            const from = m.chat;

            if (config.DEBUG_MODE === 'true' && body) {
                console.log(`📩 [MSG] ${m.sender.split('@')[0]}: ${body}`);
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

                    // සියලුම පරණ arguments එලෙසම ලබා දීම
                    await cmd.function(conn, mek, m, {
                        from, prefix, q, args, isOwner, 
                        reply: (text) => conn.sendMessage(from, { text }, { quoted: mek }),
                        getBuffer, getGroupAdmins, getRandom, h2k, isUrl, Json, runtime, sleep, fetchJson
                    });
                }
            }
        } catch (e) { 
            if (config.DEBUG_MODE === 'true') console.error("Handler Error:", e);
        }
    });
}

// 6. ඇප් එක ආරම්භ කිරීමේ ප්‍රධාන ශ්‍රිතය
async function initApp() {
    try {
        await connectDB(); // MongoDB සම්බන්ධ කිරීම
        await readEnv();   // Settings කියවීම
        
        app.get("/", (req, res) => res.send("APEX-MD Online ✅"));
        app.listen(port, () => {
            console.log(`🌐 Server running on port ${port}`);
            startBot();
        });
    } catch (e) {
        console.error("Initialization Failed:", e);
    }
}

initApp();

// බොට් මැරෙන්නේ නැතුව තබා ගැනීමට
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err));
