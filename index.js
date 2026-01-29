// අවශ්‍ය වන module එකතු කර ගැනීම
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');

// මුල් කේතයේ තිබූ functions සහ අනෙකුත් අවශ්‍යතා
const { getBuffer, getGroupAdmins, getRandom, h2k, isUrl, Json, runtime, sleep, fetchJson } = require('./lib/functions');
const fs = require('fs');
const P = require('pino');
const appConfig = require('./config');
const qrcode = require('qrcode-terminal');
const { sms } = require('./lib/msg');
const axios = require('axios');
const { File } = require('megajs');
const path = require('path');
const { getBotSettings, readEnv, connectDB } = require('./lib/mongodb');

const ownerNumber = ['94701391585']; 
const express = require("express");
const app = express();
const port = process.env.PORT || 8000;

let botSettings = getBotSettings();
let prefix = botSettings.PREFIX;

// WhatsApp සමඟ සම්බන්ධ වීම ආරම්භ කරන ශ්‍රිතය
async function connectToWA() {
    // MongoDB සම්බන්ධ කිරීම සහ settings ලබා ගැනීම
    await connectDB();

    try {
        await readEnv();
        botSettings = getBotSettings();
        prefix = botSettings.PREFIX || ".";
        console.log("Bot settings loaded. Prefix:", prefix, "Mode:", botSettings.MODE);
    } catch (error) {
        console.log("Settings Load Error:", error.message);
    }

    console.log("Connecting APEX-MD Wa-BOT 🧬...");

    const authPath = path.join(__dirname, '/auth_info_baileys/');
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const conn = makeWASocket({
        logger: P({ level: 'silent' }),
        printQRInTerminal: true,
        browser: Browsers.ubuntu("Chrome"),
        syncFullHistory: true,
        auth: state,
        version
    });

    // Creds update කිරීම (සෙෂන් එක පවත්වා ගැනීමට)
    conn.ev.on('creds.update', saveCreds);

    // සම්බන්ධතාවයේ තත්ත්වය පරීක්ෂා කිරීම
    conn.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            let reason = lastDisconnect.error?.output?.statusCode;
            console.log("Connection Closed. Reason:", reason);
            if (reason !== DisconnectReason.loggedOut) {
                connectToWA(); // නැවත සම්බන්ධ වීම
            }
        } else if (connection === 'open') {
            console.log('✅ APEX-MD IS ONLINE');
            
            // Plugins ෆෝල්ඩරයේ ඇති විධානයන් ලෝඩ් කිරීම
            const pluginDir = path.join(__dirname, 'plugins');
            if (fs.existsSync(pluginDir)) {
                fs.readdirSync(pluginDir).forEach(file => {
                    if (file.endsWith('.js')) {
                        require(path.join(pluginDir, file));
                        // DEBUG_MODE ඔන් නම් ලෝඩ් වන Plugins විස්තර පෙන්වයි
                        if (appConfig.DEBUG_MODE === 'true') console.log(`[PLUGIN] Loaded: ${file}`);
                    }
                });
            }
        }
    });

    // මැසේජ් ලැබෙන විට ක්‍රියාත්මක වන කොටස
    conn.ev.on('messages.upsert', async (mekEvent) => {
        try {
            const mek = mekEvent.messages[0];
            if (!mek.message) return;
            
            const m = sms(conn, mek);
            const from = m.chat;
            const body = m.body || '';

            // DEBUG_MODE පාලනය (config.js මගින්)
            if (appConfig.DEBUG_MODE === 'true' && body) {
                console.log(`📩 [MSG] From: ${m.sender.split('@')[0]} | Text: ${body}`);
            }

            const isCmd = body.startsWith(prefix);
            const command = isCmd ? body.slice(prefix.length).trim().split(' ')[0].toLowerCase() : '';
            const args = body.trim().split(/ +/).slice(1);
            const q = args.join(' ');
            const isOwner = ownerNumber.includes(m.sender.split('@')[0]) || m.isMe;

            if (isCmd) {
                const events = require('./command');
                const cmd = events.commands.find((c) => c.pattern === command) || 
                            events.commands.find((c) => c.alias && c.alias.includes(command));

                if (cmd) {
                    if (appConfig.DEBUG_MODE === 'true') console.log(`⚡ [CMD] Executing: ${command}`);
                    
                    await cmd.function(conn, mek, m, {
                        from, prefix, q, args, isOwner, 
                        reply: (text) => conn.sendMessage(from, { text }, { quoted: mek })
                    });
                }
            }
        } catch (e) {
            console.error("Handler Error:", e);
        }
    });
}

// බොට් ආරම්භ කිරීම සහ සෙෂන් ඩවුන්ලෝඩ් කිරීම
async function startBot() {
    const authPath = path.join(__dirname, 'auth_info_baileys', 'creds.json');
    
    if (fs.existsSync(authPath)) {
        console.log("Session file found. Connecting...");
        connectToWA().catch(err => console.log("Connection Fail"));
    } else if (appConfig.SESSION_ID) {
        console.log("Downloading session from Mega...");
        const sessdata = appConfig.SESSION_ID.trim();
        // Mega URL එක සකස් කිරීම
        const sessionUrl = sessdata.startsWith("https") ? sessdata : `https://mega.nz/file/${sessdata}`;
        
        try {
            const filer = File.fromURL(sessionUrl);
            filer.download((err, data) => {
                if (err) {
                    console.error("Session download failed. Starting QR Scan.");
                    connectToWA();
                    return;
                }
                if (!fs.existsSync(path.dirname(authPath))) fs.mkdirSync(path.dirname(authPath), { recursive: true });
                fs.writeFile(authPath, data, () => {
                    console.log("Session downloaded ✅");
                    connectToWA();
                });
            });
        } catch (e) {
            console.error("MegaJS Error:", e);
            connectToWA();
        }
    } else {
        console.log("No Session ID. Starting QR Scan...");
        connectToWA();
    }
}

// සර්වර් එක සැකසීම
app.get("/", (req, res) => {
    res.send("APEX-MD Bot is Running ✅");
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
    startBot();
});

// Anti-Crash (වැරදි නිසා බොට් නැවතීම වැළැක්වීමට)
process.on('uncaughtException', (err) => console.log('Caught exception: ', err));
process.on('unhandledRejection', (reason) => console.log('Unhandled Rejection: ', reason));
