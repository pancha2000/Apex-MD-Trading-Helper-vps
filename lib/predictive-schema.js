'use strict';
/**
 * ApexIQ · lib/predictive-schema.js
 * ══════════════════════════════════════════════════════════════════════════
 *  DATABASE SCHEMA: Personalized Watchlist & Predictive Brain Settings
 *
 *  This module exports Mongoose sub-schemas and the migration helper that
 *  PATCHES the existing SaasUser document in-place.  Import this once in
 *  database.js and call  patchSaasUserSchema(SaasUserSchema)  before the
 *  model is compiled.
 *
 *  Design decisions:
 *  • Watchlist stored as a sub-document array ON the SaasUser document
 *    (avoids an extra collection round-trip for every dashboard load).
 *  • Predictive fields (current_price, ai_predicted_target_price, etc.) are
 *    persisted so the UI can render instantly on page load without waiting
 *    for a fresh Binance call.  They are refreshed by the cron job.
 *  • auto_pilot_enabled is the master switch per coin.
 *    └─ OFF  → manual_strategy_selected  (user picks from STRATEGY_REGISTRY)
 *    └─ ON   → ai_active_strategy        (written by autopilot-cron.js)
 * ══════════════════════════════════════════════════════════════════════════
 */

const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────
//  CONSTANTS — shared with frontend & cron job
// ─────────────────────────────────────────────────────────────────

/**
 * Central registry of all selectable strategies.
 * Each entry:  { id, label, description, risk }
 *
 * The autopilot cron simulates a "Tournament" by scoring these
 * strategies against recent candle data for each coin and writing
 * the winner's `id` into ai_active_strategy.
 */
const STRATEGY_REGISTRY = [
  { id: 'smc_breakout',      label: 'SMC Breakout',         description: 'Break-of-structure + order block confluence',  risk: 'medium' },
  { id: 'fvg_fill',          label: 'FVG Fill',             description: 'Fair-value gap magnet — mean reversion entry', risk: 'low'    },
  { id: 'ob_bounce',         label: 'OB Bounce',            description: 'Premium/discount order-block reversal',        risk: 'low'    },
  { id: 'trend_continuation',label: 'Trend Continuation',   description: 'EMA ribbon + ADX momentum filter',             risk: 'medium' },
  { id: 'liquidity_sweep',   label: 'Liquidity Sweep',      description: 'Stop-hunt reversal above/below swing high/low',risk: 'high'   },
  { id: 'range_scalp',       label: 'Range Scalp',          description: 'High-probability range-bound mean reversion',  risk: 'low'    },
  { id: 'news_momentum',     label: 'News Momentum',        description: 'Catalyst-driven breakout with tight SL',       risk: 'high'   },
];

const TREND_OPTIONS   = ['Strongly Bullish', 'Bullish', 'Neutral', 'Bearish', 'Strongly Bearish'];
const REGIME_OPTIONS  = ['Trending', 'Ranging', 'Choppy'];
const STRATEGY_IDS    = STRATEGY_REGISTRY.map(s => s.id);

// ─────────────────────────────────────────────────────────────────
//  1. WATCHLIST COIN  sub-document schema
// ─────────────────────────────────────────────────────────────────

const WatchlistCoinSchema = new mongoose.Schema({

  // ── Identity ────────────────────────────────────────────────
  coin_pair: {
    type:      String,
    required:  true,
    uppercase: true,
    trim:      true,
    // e.g. "BTCUSDT", "ETHUSDT"
  },

  added_at: { type: Date, default: Date.now },

  // ── Auto-Pilot Switch ────────────────────────────────────────
  auto_pilot_enabled: {
    type:    Boolean,
    default: false,
    // When TRUE  → ai_active_strategy is used (written by cron).
    // When FALSE → manual_strategy_selected is used (written by user).
  },

  // ── Strategy Fields ──────────────────────────────────────────
  manual_strategy_selected: {
    type:    String,
    enum:    [...STRATEGY_IDS, null],
    default: null,
    // Shown as a <select> dropdown when auto_pilot_enabled === false.
  },

  ai_active_strategy: {
    type:    String,
    enum:    [...STRATEGY_IDS, null],
    default: null,
    // Written weekly by the Strategy Tournament cron (autopilot-cron.js).
    // Read-only badge shown when auto_pilot_enabled === true.
  },

  ai_strategy_confidence: {
    type:    Number,   // 0–100 — win-rate simulation score from tournament
    default: null,
  },

  ai_strategy_updated_at: {
    type:    Date,
    default: null,
    // Lets the UI show "AI picked this 3 days ago".
  },

  // ── Predictive Display Fields ────────────────────────────────
  // These are refreshed by the cron / live-price endpoint.
  // Storing them allows instant render on page load.

  current_price: {
    type:    Number,
    default: null,
  },

  ai_predicted_target_price: {
    type:    Number,
    default: null,
    // Derived by predictive-brain.js using SMC / FVG projections.
    // Represents the most probable price 4–12 hours out.
  },

  predicted_upside_pct: {
    type:    Number,   // positive = bullish target, negative = bearish
    default: null,
  },

  future_trend_4h: {
    type:    String,
    enum:    [...TREND_OPTIONS, null],
    default: null,
    // Leading indicator — evaluated from SMC structure, not lagging MAs.
    // "Bullish" even if price is currently falling, if an OB is directly below.
  },

  market_regime: {
    type:    String,
    enum:    [...REGIME_OPTIONS, null],
    default: null,
    // Populated by Hurst Exponent computation in predictive-brain.js.
    // 'Choppy' → breakout signals blocked for this coin.
  },

  hurst_exponent: {
    type:    Number,   // 0.0 – 1.0  (H < 0.45 = mean-reverting / choppy)
    default: null,
  },

  signal_blocked: {
    type:    Boolean,
    default: false,
    // true when market_regime === 'Choppy' and strategy is breakout-based.
    // Frontend renders a ⚠️ Chop Filter badge.
  },

  last_refreshed_at: {
    type:    Date,
    default: null,
  },

}, { _id: false }); // no extra _id per coin — coin_pair is the key


// ─────────────────────────────────────────────────────────────────
//  2. STRATEGY TOURNAMENT HISTORY  sub-document
//     Stored per-user for audit / debugging
// ─────────────────────────────────────────────────────────────────

const TournamentResultSchema = new mongoose.Schema({
  run_at:       { type: Date,   default: Date.now },
  coin_pair:    { type: String },
  winner:       { type: String },   // strategy id
  win_rate:     { type: Number },   // 0–100
  scores:       { type: mongoose.Schema.Types.Mixed },  // { smc_breakout: 72, fvg_fill: 68, … }
}, { _id: false });


// ─────────────────────────────────────────────────────────────────
//  3. PATCH FUNCTION — adds predictive fields to existing SaasUser
//     Call this BEFORE mongoose.model('SaasUser', SaasUserSchema).
// ─────────────────────────────────────────────────────────────────

function patchSaasUserSchema(SaasUserSchema) {
  SaasUserSchema.add({

    // ── Personalised Watchlist (max 50 coins per user) ──────────
    watchlist_coins: {
      type:    [WatchlistCoinSchema],
      default: [],
      validate: {
        validator: arr => arr.length <= 50,
        message:  'Watchlist limited to 50 coins.',
      },
    },

    // ── Tournament audit log (last 100 runs) ────────────────────
    tournament_history: {
      type:    [TournamentResultSchema],
      default: [],
    },

    // ── User-level autopilot preference ─────────────────────────
    autopilot_global: {
      type:    Boolean,
      default: false,
      // Master switch: if false, per-coin auto_pilot_enabled is used.
      // If true, ALL coins get autopilot regardless of per-coin setting.
    },

    predictive_brain_version: {
      type:    String,
      default: 'v1',
      // Allows rolling schema migrations without breaking old docs.
    },

  });
}


// ─────────────────────────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────────────────────────

module.exports = {
  WatchlistCoinSchema,
  TournamentResultSchema,
  STRATEGY_REGISTRY,
  STRATEGY_IDS,
  TREND_OPTIONS,
  REGIME_OPTIONS,
  patchSaasUserSchema,
};
