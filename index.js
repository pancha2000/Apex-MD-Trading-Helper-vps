/**
 * ╔════════════════════════════════════════════╗
 * ║   APEX-MD v7 PRO VVIP  ·  index.js        ║
 * ║   SaaS-Grade Bot Entry Point               ║
 * ╚════════════════════════════════════════════╝
 */

'use strict';

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino    = require('pino');
const express = require('express');
const { File } = require('megajs');
const fs      = require('fs');
const path    = require('path');

const config       = require('./config');
const { connectDB }  = require('./lib/database');
const { handler }    = require('./lib/commands');

// ─── Dashboard — init BEFORE plugins so console.log is intercepted ──
const { initDashboard, setBotConnected, log: dashLog } = require('./dashboard');
initDashboard();

// ─── Serialize helper ─────────────────────────────────────────
let serialize;
if (fs.existsSync('./lib/functions.js')) {
    serialize = require('./lib/functions').serialize;
} else {
    serialize = require('./lib/functions').serialize;
}

// ─── Load all plugins ─────────────────────────────────────────
fs.readdirSync('./plugins/').forEach(plugin => {
    if (path.extname(plugin).toLowerCase() === '.js') {
        require('./plugins/' + plugin);
    }
});

// ─── WhatsApp keep-alive Express server (port 8000) ──────────
// NOTE: The web dashboard runs on DASHBOARD_PORT (default 3000).
// This server only serves the Heroku/railway keep-alive endpoint.
const app  = express();
const PORT = config.PORT;

app.get('/', (req, res) => {
    res.send(`🚀 ${config.BOT_NAME} is Running! | Dashboard → port ${config.DASHBOARD_PORT}`);
});

app.listen(PORT, () => {
    console.log(`🌐 Keep-alive server running on port ${PORT}`);
});

// ─── Session download ─────────────────────────────────────────
async function downloadSession() {
    if (fs.existsSync(path.join(__dirname, 'auth_info'))) {
        console.log('🗑️ Clearing old session files...');
        fs.rmSync(path.join(__dirname, 'auth_info'), { recursive: true, force: true });
    }

    if (config.SESSION_ID) {
        console.log('📥 Downloading Fresh Session from Mega...');
        try {
            const file = File.fromURL(`https://mega.nz/file/${config.SESSION_ID}`);
            const data = await file.downloadBuffer();
            fs.mkdirSync(path.join(__dirname, 'auth_info'), { recursive: true });
            fs.writeFileSync(path.join(__dirname, 'auth_info', 'creds.json'), data);
            console.log('✅ Session Downloaded Successfully!');
        } catch (e) {
            console.error('❌ Error downloading session:', e.message);
        }
    }
}

// ─── Bot Core ─────────────────────────────────────────────────
let isFirstStart = true;

async function startBot() {
    if (isFirstStart) {
        await downloadSession();
        isFirstStart = false;
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`🔄 Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const conn = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        auth:    state,
        getMessage: async () => ({ conversation: 'Apex Crypto Bot' }),
    });

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            setBotConnected(false);
            let reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Connection Closed. Reason: ${reason}`);

            if (reason === DisconnectReason.loggedOut || reason === 440 || reason === 401) {
                console.log('❌ Session Invalid! Generate a NEW Session ID.');
                process.exit(1);
            } else {
                console.log('🔄 Reconnecting in 5 seconds...');
                conn.ev.removeAllListeners();
                setTimeout(startBot, 5000);
            }
        } else if (connection === 'open') {
            setBotConnected(true);
            console.log('✅ Bot Connected to WhatsApp Successfully!');
            console.log(`💡 Type ${config.PREFIX}scanstart in your WhatsApp to activate the Auto-Scanner!`);
            dashLog(`WhatsApp connected successfully`);

            // Auto-start trade manager on every connect
            try {
                const scanner = require('./plugins/scanner');
                scanner.autoStartTradeManager(conn);
                console.log('✅ Trade Manager auto-started (TP/SL monitoring active)');
            } catch (e) {
                console.log('⚠️ Trade Manager auto-start skipped:', e.message);
            }
        }
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message) return;

        try {
            let mek;
            try { mek = await serialize(msg, conn); } catch (_) { mek = null; }
            if (!mek) return;

            const body    = mek.body || '';
            const prefix  = config.PREFIX || '.';
            const isCmd   = body.startsWith(prefix);
            const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '';
            const args    = body.trim().split(/ +/).slice(1);
            const text    = args.join(' ');
            const from    = mek.from;

            mek.react = async (emoji) => {
                try { await conn.sendMessage(from, { react: { text: emoji, key: msg.key } }); } catch (_) {}
            };

            if (isCmd) {
                console.log(`\n💬 Command: ${command}`);
                const cmd = handler.findCommand(command);
                if (cmd) {
                    if (cmd.isOwner && !config.isOwner(mek.sender)) {
                        return await conn.sendMessage(from, { text: '❌ This command is for the owner only.' }, { quoted: msg });
                    }
                    await cmd.function(conn, mek, mek, {
                        reply: async (t) => await conn.sendMessage(from, { text: t }, { quoted: msg }),
                        text, args, body, command, from, q: text,
                    });
                    console.log(`✅ Command '${command}' executed`);
                }
            }
        } catch (e) {
            console.error('❌ Message Error:', e.message);
        }
    });
}

// ─── Bootstrap ────────────────────────────────────────────────
if (config.MONGODB) {
    connectDB().catch(err => console.error('DB Error:', err));
}
startBot();
