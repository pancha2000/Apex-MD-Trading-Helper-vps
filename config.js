'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD v7 PRO VVIP  ·  config.js  v7.1
 *  ──────────────────────────────────────────────────────────────
 *  ✅ FIXES:
 *    - BINANCE_SECRET added (required for order placement)
 *    - setIndicatorParam() added (dashboard /api/indicators)
 *    - setSMCParam()       added (dashboard /api/smc)
 *    - setTargetParam()    added (dashboard /api/targets)
 *    - indicatorParams / smcParams / targetParams stores added
 *    - Daily report config added
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
    BOT_NAME:   process.env.BOT_NAME   || 'Apex-MD v7 PRO VVIP',
    PREFIX:     process.env.PREFIX     || '.',
    MODE:       process.env.MODE       || 'public',
    VERSION:    '7.1.0',

    // ─── Owner / Auth ────────────────────────────────────────
    OWNER_NAME:   process.env.OWNER_NAME   || 'Owner',
    OWNER_NUMBER: process.env.OWNER_NUMBER || '',
    SUDO:         process.env.SUDO         || '',

    // ─── Database ─────────────────────────────────────────────
    MONGODB: process.env.MONGODB || '',

    // ─── External API Keys ────────────────────────────────────
    GEMINI_API:     process.env.GEMINI_API     || '',
    BINANCE_API:    process.env.BINANCE_API    || '',
    BINANCE_SECRET: process.env.BINANCE_SECRET || '',   // ✅ FIX: needed for signed endpoints
    GROQ_API:       process.env.GROQ_API       || '',
    LUNAR_API:      process.env.LUNAR_API      || null,

    // ─── Web Dashboard ────────────────────────────────────────
    DASHBOARD_PORT:     num(process.env.DASHBOARD_PORT, 3000),
    DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD || 'apex2024',
    DASHBOARD_SECRET:   process.env.DASHBOARD_SECRET   || 'apex-md-fallback-secret-change-me',

    // ─── Module Toggles (runtime-mutable) ────────────────────
    modules: {
        AI_MODEL:        bool(process.env.ENABLE_AI_MODEL,        true),
        BYBIT:           bool(process.env.ENABLE_BYBIT,           true),
        DYNAMIC_WEIGHTS: bool(process.env.ENABLE_DYNAMIC_WEIGHTS, true),
        SMC:             bool(process.env.ENABLE_SMC,             true),
        PRO_MODE:        bool(process.env.PRO_MODE,               false),
        PAPER_TRADING:   bool(process.env.PAPER_TRADING,          false),
    },

    // ─── Pro Mode Custom Parameters (runtime-mutable) ────────
    proParams: {
        RSI_PERIOD:      num(process.env.PRO_RSI_PERIOD,      14),
        FAST_EMA:        num(process.env.PRO_FAST_EMA,        50),
        SLOW_EMA:        num(process.env.PRO_SLOW_EMA,        200),
        ADX_CHOPPY:      num(process.env.PRO_ADX_CHOPPY,      20),
        ADX_TRENDING:    num(process.env.PRO_ADX_TRENDING,    25),
        MANUAL_MARGIN:   num(process.env.PRO_MANUAL_MARGIN,   0),
        MANUAL_LEVERAGE: num(process.env.PRO_MANUAL_LEVERAGE, 10),
    },

    // ✅ FIX: indicator / SMC / target stores for dashboard API routes
    indicatorParams: {
        RSI_PERIOD:   num(process.env.PRO_RSI_PERIOD,   14),
        FAST_EMA:     num(process.env.PRO_FAST_EMA,     50),
        SLOW_EMA:     num(process.env.PRO_SLOW_EMA,     200),
        ADX_CHOPPY:   num(process.env.PRO_ADX_CHOPPY,   20),
        ADX_TRENDING: num(process.env.PRO_ADX_TRENDING, 25),
    },

    smcParams: {
        OB_LOOKBACK:  num(process.env.SMC_OB_LOOKBACK,  10),
        FVG_MIN_PCT:  num(process.env.SMC_FVG_MIN_PCT,  0.1),
        SWEEP_BUFFER: num(process.env.SMC_SWEEP_BUFFER, 0.5),
    },

    targetParams: {
        TP1_MULT:  num(process.env.TP1_MULT,  1.0),
        TP2_MULT:  num(process.env.TP2_MULT,  2.0),
        TP3_MULT:  num(process.env.TP3_MULT,  3.0),
        SL_BUFFER: num(process.env.SL_BUFFER, 0.5),
    },

    // ─── AI Model (Python FastAPI) ────────────────────────────
    AI: {
        URL:                  process.env.AI_MODEL_URL          || 'http://localhost:5000',
        TIMEOUT_MS:           num(process.env.AI_MODEL_TIMEOUT,        6000),
        CONFIDENCE_THRESHOLD: num(process.env.AI_CONFIDENCE_THRESHOLD, 60),
        BLOCK_THRESHOLD:      num(process.env.AI_BLOCK_THRESHOLD,      80),
    },

    // ─── Bybit Settings ───────────────────────────────────────
    BYBIT: {
        TIMEOUT_MS: num(process.env.BYBIT_TIMEOUT,  5000),
        OB_DEPTH:   num(process.env.BYBIT_OB_DEPTH, 20),
    },

    // ─── Trading Parameters (runtime-mutable) ────────────────
    trading: {
        DEFAULT_RISK_PCT:      num(process.env.DEFAULT_RISK_PCT,      2),
        MAX_OPEN_TRADES:       num(process.env.MAX_OPEN_TRADES,       5),
        MIN_SCORE_THRESHOLD:   num(process.env.MIN_SCORE_THRESHOLD,   20),
        DEFAULT_LEVERAGE:      num(process.env.DEFAULT_LEVERAGE,      10),
        SIGNAL_COOLDOWN_HOURS: num(process.env.SIGNAL_COOLDOWN_HOURS, 4),
        WS_WATCH_COUNT:        num(process.env.WS_WATCH_COUNT,        30),
    },

    // ─── Daily P&L Report ─────────────────────────────────────
    dailyReport: {
        ENABLED:  bool(process.env.DAILY_REPORT,          true),
        HOUR_UTC: num(process.env.DAILY_REPORT_HOUR_UTC,  0),   // 0 = midnight UTC
    },

    // ─── Auto Updater ─────────────────────────────────────────
    updater: {
        ENABLED:        bool(process.env.ENABLE_AUTO_UPDATE, false),
        PM2_APP_NAME:   process.env.PM2_APP_NAME            || 'ApexBot',
        WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET   || '',
    },

    PORT: num(process.env.PORT, 8000),

    isOwner(sender) {
        const senderNum = (sender || '').split('@')[0];
        const ownerNum  = (process.env.OWNER_NUMBER || '').trim();
        const sudoNums  = (process.env.SUDO || '').split(',').map(s => s.trim()).filter(Boolean);
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

config.setProMode = function(enabled) {
    this.modules.PRO_MODE = Boolean(enabled);
    console.log(`[config] Pro Mode → ${enabled ? 'ON 🔬 (Custom)' : 'OFF 🤖 (Auto AI)'}`);
};

config.setPaperTrading = function(enabled) {
    this.modules.PAPER_TRADING = Boolean(enabled);
    console.log(`[config] Paper Trading → ${enabled ? 'ON 📄' : 'OFF 💰 (Live)'}`);
};

config.setProParam = function(key, value) {
    if (!(key in this.proParams)) throw new Error(`Unknown pro param: ${key}`);
    this.proParams[key] = parseFloat(value);
    if (key in this.indicatorParams) this.indicatorParams[key] = parseFloat(value);
    console.log(`[config] Pro param ${key} → ${value}`);
};

// ✅ FIX: Dashboard calls these — they were undefined before
config.setIndicatorParam = function(key, value) {
    const v = parseFloat(value);
    if (isNaN(v)) throw new Error(`Invalid value for indicator param ${key}`);
    this.indicatorParams[key] = v;
    if (key in this.proParams) this.proParams[key] = v;
    console.log(`[config] Indicator param ${key} → ${v}`);
};

config.setSMCParam = function(key, value) {
    const v = parseFloat(value);
    if (isNaN(v)) throw new Error(`Invalid value for SMC param ${key}`);
    this.smcParams[key] = v;
    console.log(`[config] SMC param ${key} → ${v}`);
};

config.setTargetParam = function(key, value) {
    const v = parseFloat(value);
    if (isNaN(v)) throw new Error(`Invalid value for target param ${key}`);
    this.targetParams[key] = v;
    console.log(`[config] Target param ${key} → ${v}`);
};

config.getSnapshot = function() {
    return {
        version:          this.VERSION,
        botName:          this.BOT_NAME,
        modules:          { ...this.modules },
        trading:          { ...this.trading },
        proParams:        { ...this.proParams },
        indicatorParams:  { ...this.indicatorParams },
        smcParams:        { ...this.smcParams },
        targetParams:     { ...this.targetParams },
        updater:          { enabled: this.updater.ENABLED, pm2App: this.updater.PM2_APP_NAME },
        ai:               { url: this.AI.URL, confThreshold: this.AI.CONFIDENCE_THRESHOLD, blockThreshold: this.AI.BLOCK_THRESHOLD },
        hasBinanceSecret: Boolean(this.BINANCE_SECRET),
    };
};

module.exports = config;
