'use strict';
/**
 * ApexIQ · lib/database-brain-patch.js
 * ══════════════════════════════════════════════════════════════════════════
 *  DATABASE HELPERS — Watchlist CRUD functions to add to database.js
 *
 *  HOW TO INTEGRATE:
 *  ─────────────────
 *  1. In lib/database.js, add near the top:
 *       const { patchSaasUserSchema } = require('./predictive-schema');
 *       // then BEFORE the line:  mongoose.model('SaasUser', SaasUserSchema)
 *       patchSaasUserSchema(SaasUserSchema);
 *
 *  2. Copy the functions below into database.js (inside the module, before
 *     the final module.exports = { … } block).  Then add each function name
 *     to the exports object.
 *
 *  3. In web/server.js (or wherever routes are registered), add:
 *       const predictiveRoutes = require('./predictive-routes');
 *       predictiveRoutes({ saasAuth, db, binance, renderView, logger }, app);
 *
 *  4. In lib/autopilot-cron.js's start() call (from server.js):
 *       const autopilotCron = require('./lib/autopilot-cron');
 *       autopilotCron.start({ db, binance, logger: console });
 *
 *  5. Add the nav link to /js/user.js renderUserNav array:
 *       { href: '/app/brain', label: '🧠 Brain', key: 'brain' }
 *
 *  6. In web/render.js PAGE_META, add:
 *       'app/brain': { title: 'Predictive Brain · ApexIQ', description: 'AI-powered predictive trading signals with SMC and FVG analysis.' },
 * ══════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────
//  WATCHLIST CRUD HELPERS
//  These functions use atomic MongoDB $push / $pull / $set operators
//  to update only the watchlist sub-document, not the whole user doc.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Add a new coin to a user's watchlist.
 * @param {string|ObjectId} userId
 * @param {object} coinData — must include coin_pair
 */
async function addWatchlistCoin(userId, coinData) {
  return SaasUser.findByIdAndUpdate(
    userId,
    { $push: { watchlist_coins: coinData } },
    { new: true, runValidators: true }
  );
}

/**
 * Remove a coin from a user's watchlist by coin_pair.
 * @param {string|ObjectId} userId
 * @param {string} coinPair — e.g. 'BTCUSDT'
 */
async function removeWatchlistCoin(userId, coinPair) {
  return SaasUser.findByIdAndUpdate(
    userId,
    { $pull: { watchlist_coins: { coin_pair: coinPair } } },
    { new: true }
  );
}

/**
 * Update specific fields on a watchlist coin sub-document.
 * Uses MongoDB positional operator ($) for atomic sub-doc update.
 *
 * @param {string|ObjectId} userId
 * @param {string} coinPair
 * @param {object} fields — key/value pairs to update on the sub-doc
 */
async function updateWatchlistCoin(userId, coinPair, fields) {
  // Build $set payload with positional operator path
  const setPayload = {};
  for (const [key, val] of Object.entries(fields)) {
    setPayload[`watchlist_coins.$.${key}`] = val;
  }
  return SaasUser.findOneAndUpdate(
    { _id: userId, 'watchlist_coins.coin_pair': coinPair },
    { $set: setPayload },
    { new: true, runValidators: true }
  );
}

/**
 * Convenience alias — updates strategy fields specifically.
 * Used by the autopilot cron.
 *
 * @param {string|ObjectId} userId
 * @param {string} coinPair
 * @param {object} strategyFields — e.g. { ai_active_strategy, ai_strategy_confidence, ai_strategy_updated_at }
 */
async function updateWatchlistCoinStrategy(userId, coinPair, strategyFields) {
  return updateWatchlistCoin(userId, coinPair, strategyFields);
}

/**
 * Generic SaasUser field updater.
 * Used by the cron to write back tournament_history.
 *
 * @param {string|ObjectId} userId
 * @param {object} fields
 */
async function updateSaasUser(userId, fields) {
  return SaasUser.findByIdAndUpdate(
    userId,
    { $set: fields },
    { new: true }
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  EXAMPLE module.exports ADDITIONS  (merge into existing exports object)
// ─────────────────────────────────────────────────────────────────────────

/*
  Add these to your existing module.exports in database.js:

  module.exports = {
    // … existing exports …
    addWatchlistCoin,
    removeWatchlistCoin,
    updateWatchlistCoin,
    updateWatchlistCoinStrategy,
    updateSaasUser,           // ← if not already exported
  };
*/

module.exports = {
  addWatchlistCoin,
  removeWatchlistCoin,
  updateWatchlistCoin,
  updateWatchlistCoinStrategy,
  updateSaasUser,
};


/* ══════════════════════════════════════════════════════════════════════════
   INTEGRATION SNIPPET  —  paste into web/server.js
   ══════════════════════════════════════════════════════════════════════════

// --- After existing route registrations ---

// 🧠 Predictive Brain & Auto-Pilot Dashboard
const predictiveRoutes = require('./predictive-routes');
predictiveRoutes(
  { saasAuth, db, binance, renderView, logger: console },
  app
);

// 🏆 Strategy Tournament Cron (weekly auto-pilot updates)
const autopilotCron = require('../lib/autopilot-cron');
autopilotCron.start({
  db,
  binance,
  logger:  console,
  runNow:  process.env.NODE_ENV === 'development',  // run immediately in dev
});

══════════════════════════════════════════════════════════════════════════ */


/* ══════════════════════════════════════════════════════════════════════════
   INTEGRATION SNIPPET  —  add to lib/database.js (top of file)
   ══════════════════════════════════════════════════════════════════════════

// Add near the top of database.js, BEFORE the SaasUser model is compiled:
const { patchSaasUserSchema } = require('./predictive-schema');

// Then, BEFORE the line:
//   const SaasUser = mongoose.models.SaasUser || mongoose.model('SaasUser', SaasUserSchema);
// add:
patchSaasUserSchema(SaasUserSchema);

══════════════════════════════════════════════════════════════════════════ */
