/**
 * ╔════════════════════════════════════════════╗
 * ║   APEX-MD v7.1 PRO VVIP  ·  index.js      ║
 * ║   ✅ FIXES:                                ║
 * ║    - Session only re-downloads if creds    ║
 * ║      are missing or invalid (not every     ║
 * ║      restart) — prevents MEGA rate limits  ║
 * ║    - PORT conflict guard added             ║
 * ╚════════════════════════════════════════════╝
 */

'use strict';

// ── WhatsApp command mode (admin can toggle OFF via dashboard) ──
global._waCommandsEnabled = true;

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
const serialize = require('./lib/functions').serialize;

// ─── Load all plugins ─────────────────────────────────────────
fs.readdirSync('./plugins/').forEach(plugin => {
    if (path.extname(plugin).toLowerCase() === '.js') {
        require('./plugins/' + plugin);
    }
});

// ─── WhatsApp keep-alive Express server ──────────────────────
// ✅ FIX: PORT conflict guard — keep-alive uses PORT (default 8000).
// Dashboard uses DASHBOARD_PORT (default 3000). If both are set to
// the same value by the hosting env, keep-alive falls back to PORT+1.
const app      = express();
let keepAlivePort = config.PORT;
if (keepAlivePort === config.DASHBOARD_PORT) {
    keepAlivePort = keepAlivePort + 1;
    console.warn(`⚠️ PORT conflict: keep-alive port changed to ${keepAlivePort}`);
}

app.get('/', (req, res) => {
    res.send(`🚀 ${config.BOT_NAME} is Running! | Dashboard → port ${config.DASHBOARD_PORT}`);
});

app.listen(keepAlivePort, () => {
    console.log(`🌐 Keep-alive server running on port ${keepAlivePort}`);
});

// ─── Session download ─────────────────────────────────────────
/**
 * ✅ FIX: Only re-download session from MEGA if:
 *   1. auth_info folder doesn't exist, OR
 *   2. creds.json is missing inside it, OR
 *   3. creds.json is empty/corrupt
 *
 * Previously this deleted and re-downloaded on EVERY restart,
 * which caused MEGA rate limiting and unnecessary delays.
 */
async function downloadSession() {
    const authDir   = path.join(__dirname, 'auth_info');
    const credsFile = path.join(authDir, 'creds.json');

    // Check if valid session already exists
    if (fs.existsSync(credsFile)) {
        try {
            const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
            if (creds && creds.me) {
                console.log('✅ Existing session found — skipping MEGA download.');
                return;
            }
        } catch (_) {
            console.log('⚠️ creds.json corrupt — re-downloading...');
        }
    }

    if (!config.SESSION_ID) {
        console.log('⚠️ No SESSION_ID configured — skipping session download.');
        return;
    }

    console.log('📥 Downloading Fresh Session from Mega...');
    try {
        // Clear old broken session
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
        }
        const file = File.fromURL(`https://mega.nz/file/${config.SESSION_ID}`);
        const data = await file.downloadBuffer();
        fs.mkdirSync(authDir, { recursive: true });
        fs.writeFileSync(credsFile, data);
        console.log('✅ Session Downloaded Successfully!');
    } catch (e) {
        console.error('❌ Error downloading session:', e.message);
    }
}

// ─── Bot Core ─────────────────────────────────────────────────
let isFirstStart    = true;
let reconnectCount  = 0;

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
        logger:            pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser:           ['Ubuntu', 'Chrome', '20.0.04'],
        auth:              state,
        getMessage:        async () => ({ conversation: 'Apex Crypto Bot' }),
    });

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            setBotConnected(false);
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Connection Closed. Reason: ${reason}`);

            if (reason === DisconnectReason.loggedOut || reason === 440 || reason === 401) {
                console.log('❌ Session Invalid! Generate a NEW Session ID.');
                // ✅ Clear corrupt session so next start forces fresh download
                const credsFile = path.join(__dirname, 'auth_info', 'creds.json');
                if (fs.existsSync(credsFile)) fs.unlinkSync(credsFile);
                process.exit(1);
            } else {
                reconnectCount++;
                const delay = Math.min(5000 * reconnectCount, 60000); // cap at 60s
                console.log(`🔄 Reconnecting in ${delay / 1000}s... (attempt ${reconnectCount})`);
                conn.ev.removeAllListeners();
                setTimeout(startBot, delay);
            }
        } else if (connection === 'open') {
            setBotConnected(true);
            reconnectCount = 0;
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

            // Auto-start daily report scheduler
            try {
                const { startDailyReport } = require('./plugins/scanner');
                if (typeof startDailyReport === 'function') {
                    startDailyReport(conn);
                }
            } catch (_) {}
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

            // ── WA Commands mode gate ─────────────────────────────
            // Always allow: link/unlink/linkstatus + owner commands
            const _alwaysAllow = ['link','connectweb','linkweb','unlink','linkstatus'];
            if (isCmd && global._waCommandsEnabled === false && !_alwaysAllow.includes(command)) {
                await conn.sendMessage(from, {
                    text: '🔴 *Bot commands are temporarily offline.*\nTrading signals, TP/SL notifications and account linking are still active.'
                }, { quoted: msg });
                return;
            }

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
