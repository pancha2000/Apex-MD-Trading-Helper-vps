'use strict';
/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD  ·  lib/botStatusManager.js
 *  ──────────────────────────────────────────────────────────────
 *  Drop-in replacement for the _bot_status.json file IPC.
 *
 *  Both processes (ApexBot + ApexDash) call these same helpers.
 *  MongoDB gives atomic reads/writes — zero race conditions,
 *  zero file locks.
 *
 *  Integration (see bottom of file for exact code snippets):
 *    index.js     → replace _writeBotStatus() calls
 *    web-server.js → replace readBotStatus() + setInterval
 * ════════════════════════════════════════════════════════════════
 */

const mongoose  = require('mongoose');
const BotStatus = require('../models/BotStatus');

// ── Safety: max age before we consider the bot "stale/offline" ───
const STALE_THRESHOLD_MS = 30_000;   // 30 seconds (matches original logic)

/**
 * setBotOnline(isOnline)
 *
 * Called by index.js (bot process) whenever WhatsApp connects or disconnects.
 * Replaces: fs.writeFileSync(_statusFile, JSON.stringify({ connected, ts }))
 *
 * @param {boolean} isOnline
 */
async function setBotOnline(isOnline) {
    // Silently skip if MongoDB isn't connected — never crash the bot
    if (mongoose.connection.readyState !== 1) return;
    try {
        await BotStatus.findByIdAndUpdate(
            'singleton',
            { $set: { online: Boolean(isOnline), updatedAt: new Date() } },
            { upsert: true, new: true }
        );
    } catch (_) {
        // Silent — status update failure must never abort bot operation
    }
}

/**
 * isBotOnline()
 *
 * Called by web-server.js (dashboard process) to check if the bot is alive.
 * Replaces: readBotStatus() — no file I/O, no race condition.
 *
 * Returns false if:
 *   - DB is not connected
 *   - Document doesn't exist yet
 *   - Last update was more than STALE_THRESHOLD_MS ago (bot crashed silently)
 *
 * @returns {Promise<boolean>}
 */
async function isBotOnline() {
    if (mongoose.connection.readyState !== 1) return false;
    try {
        const doc = await BotStatus.findById('singleton').lean();
        if (!doc) return false;
        const age = Date.now() - new Date(doc.updatedAt).getTime();
        return doc.online === true && age < STALE_THRESHOLD_MS;
    } catch (_) {
        return false;
    }
}

module.exports = { setBotOnline, isBotOnline };

/* ════════════════════════════════════════════════════════════════
   INTEGRATION SNIPPETS  (exact lines to change — copy-paste ready)
   ════════════════════════════════════════════════════════════════

── index.js  ───────────────────────────────────────────────────────

   ADD near top (after existing requires):
     const botStatus = require('./lib/botStatusManager');

   REPLACE line 40  (_writeBotStatus(false)):
     botStatus.setBotOnline(false).catch(() => {});

   REPLACE line 155  (_writeBotStatus(false)):
     botStatus.setBotOnline(false).catch(() => {});

   REPLACE line 174  (_writeBotStatus(true)):
     botStatus.setBotOnline(true).catch(() => {});

   You can keep the old _writeBotStatus() function as a no-op
   fallback or delete it entirely — your choice.

── web-server.js  ──────────────────────────────────────────────────

   ADD near top (after existing requires):
     const botStatus = require('./lib/botStatusManager');
     // Also connect to MongoDB so isBotOnline() works in this process
     require('./lib/database').connect().catch(() => {});

   REPLACE the entire setInterval block:

     // OLD (file-based, race conditions):
     // setInterval(() => {
     //     const status = readBotStatus();
     //     const isConnected = status.connected && (Date.now() - status.ts < 30000);
     //     server.setBotConnected(isConnected);
     // }, 5000);

     // NEW (MongoDB-backed, race-condition-free):
     setInterval(async () => {
         const online = await botStatus.isBotOnline().catch(() => false);
         server.setBotConnected(online);
     }, 5000);

   ════════════════════════════════════════════════════════════════ */
