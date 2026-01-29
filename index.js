const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    Browsers, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs');
const path = require('path');
const express = require("express");
const { File } = require('megajs');
const config = require('./config');
const { sms } = require('./lib/msg');
const { connectDB, readEnv } = require('./lib/mongodb');

const app = express();
const port = process.env.PORT || 8000;
const authPath = path.join(__dirname, 'auth_info_baileys');

// බොට්ව 24/7 පණගන්වා තැබීමට සර්වර් එකක් සෑදීම
app.get("/", (req, res) => res.send("APEX-MD is Running ✅"));

async function startBot() {
    console.log("🚀 Initializing APEX-MD...");

    // 1. ඩේටාබේස් එකට සම්බන්ධ වීම (Auto Reset මෙහිදී සිදුවේ)
    await connectDB();
    await readEnv();

    // 2. සෙෂන් එක නැත්නම් Mega එකෙන් ඩවුන්ලෝඩ් කිරීම
    if (!fs.existsSync(authPath) && config.SESSION_ID) {
        console.log("📥 Downloading Session from Mega...");
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
            console.log("✅ Session Downloaded!");
        } catch (e) {
            console.log("❌ Session Error:", e.message);
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    // 3. WhatsApp සම්බන්ධතාවය ගොඩනැගීම
    const conn = makeWASocket({
        logger: P({ level: 'silent' }),
        printQRInTerminal: true,
        browser: Browsers.ubuntu("Chrome"),
        auth: state,
        version
    });

    // සම්බන්ධතාවයේ යාවත්කාලීන කිරීම් පරීක්ෂාව
    conn.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot(); // නැවත සම්බන්ධ වීම
        } else if (connection === 'open') {
            console.log('✅ APEX-MD ONLINE');
            
            // Plugins ලෝඩ් කිරීම
            const pDir = path.join(__dirname, 'plugins');
            if (fs.existsSync(pDir)) {
                fs.readdirSync(pDir).forEach(f => {
                    if (f.endsWith('.js')) {
                        require(path.join(pDir, f));
                        if (config.DEBUG_MODE === 'true') console.log(`Loaded: ${f}`);
                    }
                });
            }
        }
    });

    conn.ev.on('creds.update', saveCreds);

    // 4. මැසේජ් ලැබෙන විට ක්‍රියාත්මක වන කොටස
    conn.ev.on('messages.upsert', async (mEvent) => {
        try {
            const mek = mEvent.messages[0];
            if (!mek.message) return;
            
            const m = sms(conn, mek); // මැසේජ් එක කියවිය හැකි ලෙස සකස් කිරීම
            const body = m.body || '';
            const from = m.chat;

            // Debug Mode එක ON නම් පණිවිඩ Log කිරීම
            if (config.DEBUG_MODE === 'true' && body) {
                console.log(`📩 [${m.sender.split('@')[0]}]: ${body}`);
            }

            // කමාන්ඩ් එකක්දැයි පරීක්ෂා කිරීම
            const prefix = config.PREFIX || ".";
            const isCmd = body.startsWith(prefix);
            
            if (isCmd) {
                const commandName = body.slice(prefix.length).trim().split(' ')[0].toLowerCase();
                const events = require('./command');
                const cmd = events.commands.find(c => c.pattern === commandName) || 
                            events.commands.find(c => c.alias && c.alias.includes(commandName));

                if (cmd) {
                    if (config.DEBUG_MODE === 'true') console.log(`⚡ Executing: ${commandName}`);
                    
                    // කමාන්ඩ් එකට අදාළ දත්ත යැවීම
                    await cmd.function(conn, mek, m, {
                        from, prefix, body, isOwner: config.OWNER_CONTACT.includes(m.sender.split('@')[0]),
                        reply: (text) => conn.sendMessage(from, { text }, { quoted: mek })
                    });
                }
            }
        } catch (e) {
            console.error("Handler Error:", e);
        }
    });
}

// සර්වර් එක සහ බොට් පණගැන්වීම
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    startBot();
});

// බොට් ක්‍රෑෂ් වීම වැළැක්වීමේ කේතය (Anti-Crash)
process.on('uncaughtException', (err) => console.log('Caught exception: ', err));
process.on('unhandledRejection', (reason) => console.log('Unhandled Rejection: ', reason));
