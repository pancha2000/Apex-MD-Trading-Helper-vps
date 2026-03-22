'use strict';
/**
 * ═══════════════════════════════════════════════════════════════
 *  APEX-MD  ·  lib/protection.js
 *  Protection System — Cooldown, Daily Loss Gate, Win Rate Alert
 * ═══════════════════════════════════════════════════════════════
 */
const db = require('./database');

// ── In-memory cooldown map: coin → timestamp of last signal ──
const _cooldownMap = {};
// ── Daily loss tracking: date → { lossCount, totalPnl } ──
const _dailyLoss   = {};

// ── Config (defaults — admin can override via DB settings) ──
const DEFAULTS = {
    cooldownHours:      2,      // min hours between signals for same coin
    maxDailyLossPct:    10,     // pause if daily paper P&L drops below -X%
    lowWinRateThreshold: 40,    // warn if last N trades win rate < X%
    lowWinRateLookback:  10,    // last N trades to check
    enabled:            true,
};

let _cfg = { ...DEFAULTS };

function updateConfig(cfg) {
    _cfg = { ...DEFAULTS, ...cfg };
}

// ─────────────────────────────────────────────────────────────
//  COOLDOWN
// ─────────────────────────────────────────────────────────────
function isOnCooldown(coin) {
    if (!_cfg.enabled || _cfg.cooldownHours <= 0) return false;
    const last = _cooldownMap[coin];
    if (!last) return false;
    const hours = (Date.now() - last) / 3600000;
    return hours < _cfg.cooldownHours;
}

function markSignalSent(coin) {
    _cooldownMap[coin] = Date.now();
}

function getCooldownRemaining(coin) {
    const last = _cooldownMap[coin];
    if (!last) return 0;
    const elapsed = (Date.now() - last) / 3600000;
    const remaining = _cfg.cooldownHours - elapsed;
    return Math.max(0, remaining);
}

function getCooldownStatus() {
    const now = Date.now();
    return Object.entries(_cooldownMap)
        .filter(([, ts]) => (now - ts) / 3600000 < _cfg.cooldownHours)
        .map(([coin, ts]) => ({
            coin,
            remainingHours: (_cfg.cooldownHours - (now - ts) / 3600000).toFixed(1),
            sentAt: new Date(ts).toISOString(),
        }));
}

// ─────────────────────────────────────────────────────────────
//  DAILY LOSS GATE
// ─────────────────────────────────────────────────────────────
function _todayKey() {
    return new Date().toISOString().slice(0, 10);
}

function recordTradeResult(pnlPct) {
    const key = _todayKey();
    if (!_dailyLoss[key]) _dailyLoss[key] = { count: 0, totalPnl: 0 };
    _dailyLoss[key].count++;
    _dailyLoss[key].totalPnl += pnlPct;
}

function isDailyLossGateTriggered() {
    if (!_cfg.enabled || _cfg.maxDailyLossPct <= 0) return false;
    const today = _dailyLoss[_todayKey()];
    if (!today) return false;
    return today.totalPnl <= -Math.abs(_cfg.maxDailyLossPct);
}

function getDailyLossStatus() {
    const key   = _todayKey();
    const today = _dailyLoss[key] || { count: 0, totalPnl: 0 };
    return {
        date:          key,
        tradesCount:   today.count,
        totalPnlPct:   today.totalPnl.toFixed(2),
        gateTriggered: isDailyLossGateTriggered(),
        threshold:     -Math.abs(_cfg.maxDailyLossPct),
    };
}

// ─────────────────────────────────────────────────────────────
//  LOW WIN RATE ALERT
// ─────────────────────────────────────────────────────────────
async function checkWinRateAlert(userId) {
    try {
        const trades = await db.Trade.find({
            userId, isPaper: true, status: 'closed',
        }).sort({ closedAt: -1 }).limit(_cfg.lowWinRateLookback).lean();

        if (trades.length < _cfg.lowWinRateLookback) return { alert: false, winRate: null, count: trades.length };

        const wins    = trades.filter(t => t.result === 'win' || (t.pnlPct && t.pnlPct > 0)).length;
        const winRate = (wins / trades.length) * 100;
        const alert   = winRate < _cfg.lowWinRateThreshold;

        return {
            alert,
            winRate:   winRate.toFixed(1),
            wins,
            losses:    trades.length - wins,
            count:     trades.length,
            threshold: _cfg.lowWinRateThreshold,
            message:   alert
                ? `⚠️ Win rate ${winRate.toFixed(0)}% — last ${trades.length} trades below ${_cfg.lowWinRateThreshold}% threshold`
                : null,
        };
    } catch (e) {
        return { alert: false, winRate: null, error: e.message };
    }
}

// ─────────────────────────────────────────────────────────────
//  MASTER GATE — call before showing signal
// ─────────────────────────────────────────────────────────────
function checkGate(coin) {
    if (!_cfg.enabled) return { pass: true };
    if (isOnCooldown(coin)) {
        return {
            pass:    false,
            reason:  'cooldown',
            message: `⏳ ${coin} cooldown — ${getCooldownRemaining(coin).toFixed(1)}h remaining`,
        };
    }
    if (isDailyLossGateTriggered()) {
        return {
            pass:    false,
            reason:  'daily_loss',
            message: `🛑 Daily loss gate triggered (${getDailyLossStatus().totalPnlPct}% today) — trading paused`,
        };
    }
    return { pass: true };
}

// ─────────────────────────────────────────────────────────────
//  FULL STATUS (for admin dashboard)
// ─────────────────────────────────────────────────────────────
function getStatus() {
    return {
        enabled:         _cfg.enabled,
        config:          _cfg,
        cooldowns:       getCooldownStatus(),
        dailyLoss:       getDailyLossStatus(),
        gateActive:      isDailyLossGateTriggered(),
    };
}

module.exports = {
    updateConfig, checkGate,
    isOnCooldown, markSignalSent, getCooldownRemaining, getCooldownStatus,
    isDailyLossGateTriggered, recordTradeResult, getDailyLossStatus,
    checkWinRateAlert, getStatus,
};
