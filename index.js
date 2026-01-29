const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const fs = require('fs');
const P = require('pino');
const path = require('path');
const config = require('./config');
const { sms } = require('./lib/msg');
const { connectDB, getBotSettings, readEnv } = require('./lib/mongodb');
const express = require("express");
const app = express();
const port = process.env.PORT || 8000;
const { File } = require('megajs');

const authFile = 'auth_info_baileys';
const authPath = path.join(__dirname, authFile);

async function startBot() {
    console.log("🚀 Starting APEX-MD...");
    await connectDB();
    await readEnv();

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
                    console.log("✅ Session Downloaded!");
                    resolve();
                });
            });
        } catch (e) {
            console.log("❌ Session Download Failed.");
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const conn = makeWASocket({
        logger: P({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu("Chrome"),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, P({ level: "silent" })),
        },
        version
    });

    conn.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = lastDisconnect.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        } else if (connection === 'open') {
            console.log('✅ APEX-MD IS ONLINE');
            const pluginDir = path.join(__dirname, 'plugins');
            if (fs.existsSync(pluginDir)) {
                fs.readdirSync(pluginDir).forEach(file => {
                    if (file.endsWith('.js')) require(path.join(pluginDir, file));
                });
            }
        }
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('messages.upsert', async (mekEvent) => {
        try {
            const mek = mekEvent.messages[0];
            if (!mek.message) return;
            const m = sms(conn, mek);
            const from = m.chat;
            const body = m.body || '';
            
            const prefix = config.PREFIX || ".";
            const isCmd = body.startsWith(prefix);
            const command = isCmd ? body.slice(prefix.length).trim().split(' ')[0].toLowerCase() : '';
            const args = body.trim().split(/ +/).slice(1);
            const q = args.join(' ');
            const isOwner = config.OWNER_CONTACT.includes(m.sender.split('@')[0]);

            // ===== DEBUG MODE CONTROL =====
            if (config.DEBUG_MODE === 'true' && body) {
                console.log(`[MSG] From: ${m.sender.split('@')[0]} | Text: ${body}`);
            }
            // ==============================

            if (isCmd) {
                const events = require('./command');
                const cmd = events.commands.find((c) => c.pattern === command) || events.commands.find((c) => c.alias && c.alias.includes(command));

                if (cmd) {
                    if (config.DEBUG_MODE === 'true') console.log(`[CMD] Executing: ${command}`);
                    
                    await cmd.function(conn, mek, m, {
                        from, prefix, q, args, isOwner, 
                        reply: (text) => conn.sendMessage(from, { text }, { quoted: mek })
                    });
                }
            }
        } catch (e) {
            console.error(e);
        }
    });
}

app.get("/", (req, res) => res.send("APEX-MD Running"));
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    startBot();
});
