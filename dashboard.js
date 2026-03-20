'use strict';
/**
 * APEX-MD · dashboard.js — Minimal shim
 * ════════════════════════════════════════
 * index.js calls:
 *   initDashboard()         → starts web/server.js
 *   setBotConnected(bool)   → forwarded to web/server.js
 *   log(msg)                → forwarded to web/server.js
 *   pushSignal(setup)       → forwarded to web/server.js
 *
 * All real logic is in web/server.js
 * Delete dashboard-app.js and dashboard-scanner.js — no longer needed.
 */

let _ws = null;

function initDashboard() {
    try {
        _ws = require('./web/server');
        _ws.start();
    } catch (e) {
        console.error('[Dashboard] ❌ web/server.js start failed:', e.message);
    }
}

function setBotConnected(v) { _ws?.setBotConnected(v); }
function log(msg) { _ws?.log(msg); }
function pushSignal(s) { try { _ws?.pushSignal(s); } catch(_) {} }

module.exports = { initDashboard, setBotConnected, log, pushSignal };
