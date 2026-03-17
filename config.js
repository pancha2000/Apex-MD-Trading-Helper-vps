'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD v7 PRO VVIP  ·  config.js
 *  ──────────────────────────────────────────────────────────────
 *  Single source of truth for ALL bot settings.
 *
 *  Runtime toggle API:
 *    config.toggleModule(name, bool)   — module on/off
 *    config.setTradingParam(key, num)  — trading numbers
 *    config.setProMode(bool)           — Pro Custom Mode
 *    config.setPaperTrading(bool)      — Paper Trading mode
 *    config.setProParam(key, num)      — indicator/exec overrides
 *    config.setAutoUpdate(bool)        — auto-updater
 *    config.getSnapshot()              — full state for dashboard API
 * ════════════════════════════════════════════════════════════════
 */

const fs = require('fs');

if (fs.existsSync('./config.env')) {
    require('dotenv').config({ path: './config.env' });
} else if (fs.existsSync('./.env')) {
    require('dotenv').config({ path: './.env' });
}

function bool(val, fallback = true) {
    if (val === undefined || val === null || val === '') return fallback;
    return String(val).toLowerCase() !== 'false' && String(val) !== '0';
}

function num(val, fallback) {
    const n = parseFloat(val);
    return isNaN(n) ? fallback : n;
}

const config = {
    
    // ─── Bot Identity ────────────────────────────────────────
    SESSION_ID: process.env.SESSION_ID || '',
    BOT_NAME: process.env.BOT_NAME || 'Apex-MD v7 PRO VVIP',
    PREFIX: process.env.PREFIX || '.',
    MODE: process.env.MODE || 'public',
    VERSION: '7.0.0',
    
    // ─── Owner / Auth ────────────────────────────────────────
    OWNER_NAME: process.env.OWNER_NAME || 'Owner',
    OWNER_NUMBER: process.env.OWNER_NUMBER || '',
    SUDO: process.env.SUDO || '',
    
    // ─── Database ─────────────────────────────────────────────
    MONGODB: process.env.MONGODB || '',
    
    // ─── External API Keys ────────────────────────────────────
    GEMINI_API: process.env.GEMINI_API || '',
    BINANCE_API: process.env.BINANCE_API || '',
    GROQ_API: process.env.GROQ_API || '',
    LUNAR_API: process.env.LUNAR_API || null,
    
    // ─── Web Dashboard ────────────────────────────────────────
    DASHBOARD_PORT: num(process.env.DASHBOARD_PORT, 3000),
    DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD || 'apex2024',
    DASHBOARD_SECRET: process.env.DASHBOARD_SECRET || 'apex-md-fallback-secret-change-me',
    
    // ─── Module Toggles (runtime-mutable) ────────────────────
    modules: {
        AI_MODEL: bool(process.env.ENABLE_AI_MODEL, true),
        BYBIT: bool(process.env.ENABLE_BYBIT, true),
        DYNAMIC_WEIGHTS: bool(process.env.ENABLE_DYNAMIC_WEIGHTS, true),
        SMC: bool(process.env.ENABLE_SMC, true),
        // ── Master Pro Mode & Paper Trading ───────────────────
        // PRO_MODE=false  → Auto AI Mode: bot uses built-in dynamic logic
        // PRO_MODE=true   → Pro Custom Mode: bot uses proParams below
        PRO_MODE: bool(process.env.PRO_MODE, false),
        PAPER_TRADING: bool(process.env.PAPER_TRADING, false),
    },
    
    // ─── Pro Mode Custom Parameters (runtime-mutable) ────────
    // Only applied by analyzer.js / dynamicWeights.js when
    // config.modules.PRO_MODE === true.
    // In Auto AI mode (PRO_MODE=false) every field here is IGNORED.
    proParams: {
        // Indicator periods
        RSI_PERIOD: num(process.env.PRO_RSI_PERIOD, 14),
        FAST_EMA: num(process.env.PRO_FAST_EMA, 50),
        SLOW_EMA: num(process.env.PRO_SLOW_EMA, 200),
        ADX_CHOPPY: num(process.env.PRO_ADX_CHOPPY, 20),
        ADX_TRENDING: num(process.env.PRO_ADX_TRENDING, 25),
        // Manual trade execution
        // MANUAL_MARGIN=0  → keep 2% auto-risk formula
        // MANUAL_MARGIN>0  → use this exact USDT amount as margin
        MANUAL_MARGIN: num(process.env.PRO_MANUAL_MARGIN, 0),
        MANUAL_LEVERAGE: num(process.env.PRO_MANUAL_LEVERAGE, 10),
    },
    
    // ─── AI Model (Python FastAPI) ────────────────────────────
    AI: {
        URL: process.env.AI_MODEL_URL || 'http://localhost:5000',
        TIMEOUT_MS: num(process.env.AI_MODEL_TIMEOUT, 6000),
        CONFIDENCE_THRESHOLD: num(process.env.AI_CONFIDENCE_THRESHOLD, 60),
        BLOCK_THRESHOLD: num(process.env.AI_BLOCK_THRESHOLD, 80),
    },
    
    // ─── Bybit Settings ───────────────────────────────────────
    BYBIT: {
        TIMEOUT_MS: num(process.env.BYBIT_TIMEOUT, 5000),
        OB_DEPTH: num(process.env.BYBIT_OB_DEPTH, 20),
    },
    
    // ─── Trading Parameters (runtime-mutable) ────────────────
    trading: {
        DEFAULT_RISK_PCT: num(process.env.DEFAULT_RISK_PCT, 2),
        MAX_OPEN_TRADES: num(process.env.MAX_OPEN_TRADES, 5),
        MIN_SCORE_THRESHOLD: num(process.env.MIN_SCORE_THRESHOLD, 20),
        DEFAULT_LEVERAGE: num(process.env.DEFAULT_LEVERAGE, 10),
        SIGNAL_COOLDOWN_HOURS: num(process.env.SIGNAL_COOLDOWN_HOURS, 4),
        WS_WATCH_COUNT: num(process.env.WS_WATCH_COUNT, 30),
    },
    
    // ─── Auto Updater ─────────────────────────────────────────
    updater: {
        ENABLED: bool(process.env.ENABLE_AUTO_UPDATE, false),
        PM2_APP_NAME: process.env.PM2_APP_NAME || 'ApexBot',
        WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET || '',
    },
    
    PORT: num(process.env.PORT, 8000),
    
    isOwner(sender) {
        const senderNum = (sender || '').split('@')[0];
        const ownerNum = (process.env.OWNER_NUMBER || '').trim();
        const sudoNums = (process.env.SUDO || '').split(',').map(s => s.trim());
        return senderNum === ownerNum || sudoNums.includes(senderNum);
    },
};

// ════════════════════════════════════════════════════════════════
//  RUNTIME TOGGLE API
// ════════════════════════════════════════════════════════════════

config.toggleModule = function(moduleName, enabled) {
    if (!(moduleName in this.modules)) throw new Error(`Unknown module: ${moduleName}`);
    this.modules[moduleName] = Boolean(enabled);
    console.log(`[config] Module ${moduleName} → ${enabled ? 'ON ✅' : 'OFF ❌'}`);
};

config.setTradingParam = function(key, value) {
    if (!(key in this.trading)) throw new Error(`Unknown trading param: ${key}`);
    this.trading[key] = parseFloat(value);
    console.log(`[config] Trading param ${key} → ${value}`);
};

config.setAutoUpdate = function(enabled) {
    this.updater.ENABLED = Boolean(enabled);
    console.log(`[config] Auto-update → ${enabled ? 'ON ✅' : 'OFF ❌'}`);
};

/**
 * Switch Pro Custom Mode on/off.
 * true  = analyst uses proParams (RSI period, EMA lengths, manual sizing)
 * false = analyst uses built-in defaults + auto 2% risk sizing
 */
config.setProMode = function(enabled) {
    this.modules.PRO_MODE = Boolean(enabled);
    console.log(`[config] Pro Mode → ${enabled ? 'ON 🔬 (Custom)' : 'OFF 🤖 (Auto AI)'}`);
};

/**
 * Switch Paper Trading mode on/off.
 * true  = .future signals auto-saved as paper trades, no real orders
 * false = live trading (default)
 */
config.setPaperTrading = function(enabled) {
    this.modules.PAPER_TRADING = Boolean(enabled);
    console.log(`[config] Paper Trading → ${enabled ? 'ON 📄' : 'OFF 💰 (Live)'}`);
};

/**
 * Update a single Pro Mode indicator / execution parameter.
 * @param {'RSI_PERIOD'|'FAST_EMA'|'SLOW_EMA'|'ADX_CHOPPY'|'ADX_TRENDING'|'MANUAL_MARGIN'|'MANUAL_LEVERAGE'} key
 * @param {number} value
 */
config.setProParam = function(key, value) {
    if (!(key in this.proParams)) throw new Error(`Unknown pro param: ${key}`);
    this.proParams[key] = parseFloat(value);
    console.log(`[config] Pro param ${key} → ${value}`);
};

config.getSnapshot = function() {
    return {
        version: this.VERSION,
        botName: this.BOT_NAME,
        modules: { ...this.modules },
        trading: { ...this.trading },
        proParams: { ...this.proParams },
        updater: { enabled: this.updater.ENABLED, pm2App: this.updater.PM2_APP_NAME },
        ai: { url: this.AI.URL, confThreshold: this.AI.CONFIDENCE_THRESHOLD, blockThreshold: this.AI.BLOCK_THRESHOLD },
    };
};

module.exports = config;