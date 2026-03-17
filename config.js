'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD v7 PRO VVIP  ·  config.js
 *  ──────────────────────────────────────────────────────────────
 *  Single source of truth for ALL bot settings.
 *  Every hardcoded value in the codebase should live here.
 *
 *  Runtime overrides:
 *    • Toggle functions (toggleModule, setTradingParam) allow the
 *      Web Dashboard to change settings without a restart.
 *    • Persistent changes should also call db.updateSettings().
 * ════════════════════════════════════════════════════════════════
 */

const fs = require('fs');

// Load .env file first
if (fs.existsSync('./config.env')) {
    require('dotenv').config({ path: './config.env' });
} else if (fs.existsSync('./.env')) {
    require('dotenv').config({ path: './.env' });
}

// ─── Helper: parse boolean env vars robustly ──────────────────
function bool(val, fallback = true) {
    if (val === undefined || val === null || val === '') return fallback;
    return String(val).toLowerCase() !== 'false' && String(val) !== '0';
}

function num(val, fallback) {
    const n = parseFloat(val);
    return isNaN(n) ? fallback : n;
}

// ════════════════════════════════════════════════════════════════
//  MASTER CONFIGURATION OBJECT
// ════════════════════════════════════════════════════════════════
const config = {

    // ─── Bot Identity ────────────────────────────────────────
    SESSION_ID:   process.env.SESSION_ID   || '',
    BOT_NAME:     process.env.BOT_NAME     || 'Apex-MD v7 PRO VVIP',
    PREFIX:       process.env.PREFIX       || '.',
    MODE:         process.env.MODE         || 'public',
    VERSION:      '7.0.0',

    // ─── Owner / Auth ────────────────────────────────────────
    OWNER_NAME:   process.env.OWNER_NAME   || 'Owner',
    OWNER_NUMBER: process.env.OWNER_NUMBER || '',
    SUDO:         process.env.SUDO         || '',

    // ─── Database ─────────────────────────────────────────────
    MONGODB: process.env.MONGODB || '',

    // ─── External API Keys ────────────────────────────────────
    GEMINI_API:   process.env.GEMINI_API   || '',
    BINANCE_API:  process.env.BINANCE_API  || '',
    GROQ_API:     process.env.GROQ_API     || '',
    LUNAR_API:    process.env.LUNAR_API    || null,

    // ─── Web Dashboard ────────────────────────────────────────
    DASHBOARD_PORT:     num(process.env.DASHBOARD_PORT, 3000),
    DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD || 'apex2024',
    DASHBOARD_SECRET:   process.env.DASHBOARD_SECRET   || 'apex-md-fallback-secret-change-me',

    // ─── Module Toggles (runtime-mutable) ────────────────────
    // These are the master on/off switches for each subsystem.
    // The dashboard Settings page writes directly to these properties.
    modules: {
        AI_MODEL:        bool(process.env.ENABLE_AI_MODEL,       true),
        BYBIT:           bool(process.env.ENABLE_BYBIT,          true),
        DYNAMIC_WEIGHTS: bool(process.env.ENABLE_DYNAMIC_WEIGHTS, true),
        SMC:             bool(process.env.ENABLE_SMC,            true),
    },

    // ─── AI Model (Python FastAPI) ────────────────────────────
    AI: {
        URL:                 process.env.AI_MODEL_URL        || 'http://localhost:5000',
        TIMEOUT_MS:          num(process.env.AI_MODEL_TIMEOUT, 6000),
        CONFIDENCE_THRESHOLD: num(process.env.AI_CONFIDENCE_THRESHOLD, 60),
        BLOCK_THRESHOLD:     num(process.env.AI_BLOCK_THRESHOLD, 80),
    },

    // ─── Bybit Settings ───────────────────────────────────────
    BYBIT: {
        TIMEOUT_MS: num(process.env.BYBIT_TIMEOUT, 5000),
        OB_DEPTH:   num(process.env.BYBIT_OB_DEPTH, 20),
    },

    // ─── Trading Parameters (runtime-mutable) ────────────────
    trading: {
        DEFAULT_RISK_PCT:     num(process.env.DEFAULT_RISK_PCT,      2),
        MAX_OPEN_TRADES:      num(process.env.MAX_OPEN_TRADES,        5),
        MIN_SCORE_THRESHOLD:  num(process.env.MIN_SCORE_THRESHOLD,   20),
        DEFAULT_LEVERAGE:     num(process.env.DEFAULT_LEVERAGE,      10),
        SIGNAL_COOLDOWN_HOURS: num(process.env.SIGNAL_COOLDOWN_HOURS, 4),
        WS_WATCH_COUNT:       num(process.env.WS_WATCH_COUNT,        30),
    },

    // ─── Auto Updater ─────────────────────────────────────────
    updater: {
        ENABLED:         bool(process.env.ENABLE_AUTO_UPDATE,  false),
        PM2_APP_NAME:    process.env.PM2_APP_NAME || 'ApexBot',
        WEBHOOK_SECRET:  process.env.GITHUB_WEBHOOK_SECRET || '',
    },

    // ─── Ports ────────────────────────────────────────────────
    // Port 8000 = WhatsApp keep-alive express server (in index.js)
    // Port 3000 = Web dashboard (in dashboard.js)
    PORT:       num(process.env.PORT, 8000),

    // ─── Helper: owner check ──────────────────────────────────
    isOwner(sender) {
        const senderNum = (sender || '').split('@')[0];
        const ownerNum  = (process.env.OWNER_NUMBER || '').trim();
        const sudoNums  = (process.env.SUDO || '').split(',').map(s => s.trim());
        return senderNum === ownerNum || sudoNums.includes(senderNum);
    },
};

// ════════════════════════════════════════════════════════════════
//  RUNTIME TOGGLE API
//  Used by dashboard.js to change settings without restart.
// ════════════════════════════════════════════════════════════════

/**
 * Toggle a module on/off at runtime.
 * @param {'AI_MODEL'|'BYBIT'|'DYNAMIC_WEIGHTS'|'SMC'} moduleName
 * @param {boolean} enabled
 */
config.toggleModule = function(moduleName, enabled) {
    if (!(moduleName in this.modules)) {
        throw new Error(`Unknown module: ${moduleName}`);
    }
    this.modules[moduleName] = Boolean(enabled);
    console.log(`[config] Module ${moduleName} → ${enabled ? 'ON ✅' : 'OFF ❌'}`);
};

/**
 * Update a trading parameter at runtime.
 * @param {'DEFAULT_RISK_PCT'|'MAX_OPEN_TRADES'|'MIN_SCORE_THRESHOLD'|'DEFAULT_LEVERAGE'} key
 * @param {number} value
 */
config.setTradingParam = function(key, value) {
    if (!(key in this.trading)) {
        throw new Error(`Unknown trading param: ${key}`);
    }
    this.trading[key] = parseFloat(value);
    console.log(`[config] Trading param ${key} → ${value}`);
};

/**
 * Enable/disable the auto-updater at runtime.
 */
config.setAutoUpdate = function(enabled) {
    this.updater.ENABLED = Boolean(enabled);
    console.log(`[config] Auto-update → ${enabled ? 'ON ✅' : 'OFF ❌'}`);
};

/**
 * Get a flat snapshot of all current config for the dashboard API.
 */
config.getSnapshot = function() {
    return {
        version:  this.VERSION,
        botName:  this.BOT_NAME,
        modules:  { ...this.modules },
        trading:  { ...this.trading },
        updater:  { enabled: this.updater.ENABLED, pm2App: this.updater.PM2_APP_NAME },
        ai:       { url: this.AI.URL, confThreshold: this.AI.CONFIDENCE_THRESHOLD, blockThreshold: this.AI.BLOCK_THRESHOLD },
    };
};

module.exports = config;
