'use strict';
/**
 * ╔══════════════════════════════════════════════════╗
 * ║  APEX-MD · web-server.js                        ║
 * ║  Dashboard standalone entry — runs SEPARATELY   ║
 * ║  from index.js (bot process).                   ║
 * ║                                                  ║
 * ║  PM2 හදිලා run කරන්න:                           ║
 * ║    pm2 start web-server.js --name ApexDash      ║
 * ║                                                  ║
 * ║  Bot crash වුනත් Dashboard ජීවත්ව ඉන්නවා.       ║
 * ╚══════════════════════════════════════════════════╝
 */

// ── Bot connection bridge (IPC from bot process via file) ──────────────
// Bot process writes status to a temp file; dashboard reads it.
// This lets two processes share basic state without complex IPC.
const fs   = require('fs');
const path = require('path');

const STATUS_FILE = path.join(__dirname, 'auth_info', '_bot_status.json');

function readBotStatus() {
    try {
        if (!fs.existsSync(STATUS_FILE)) return { connected: false, ts: 0 };
        return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    } catch (_) {
        return { connected: false, ts: 0 };
    }
}

// Inject global so web/server.js can call setBotConnected / pushSignal
// even when running standalone — they just update in-memory state.
global._standaloneMode = true;

// ── Start dashboard ────────────────────────────────────────────────────
try {
    const server = require('./web/server');
    server.start();

    // Poll bot status file every 5 seconds
    setInterval(() => {
        const status = readBotStatus();
        const isConnected = status.connected && (Date.now() - status.ts < 30000);
        server.setBotConnected(isConnected);
    }, 5000);

    console.log('✅ [web-server] Dashboard started in standalone mode.');
    console.log('ℹ️  [web-server] Bot logs/signals will appear when bot process is running.');
} catch (e) {
    console.error('❌ [web-server] Failed to start dashboard:', e.message);
    process.exit(1);
}
