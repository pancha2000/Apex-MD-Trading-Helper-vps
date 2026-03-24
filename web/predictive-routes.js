'use strict';
/**
 * ApexIQ · web/predictive-routes.js
 * ══════════════════════════════════════════════════════════════════════════
 *  EXPRESS ROUTES: Predictive Trading Brain & Auto-Pilot Dashboard
 *
 *  Registered routes:
 *  ─────────────────
 *  GET  /app/brain             → render the Brain dashboard page
 *  GET  /app/api/brain/watchlist       → fetch user's watchlist (with live prices)
 *  POST /app/api/brain/watchlist/add   → add a coin to watchlist
 *  POST /app/api/brain/watchlist/remove→ remove a coin from watchlist
 *  POST /app/api/brain/autopilot       → toggle auto_pilot_enabled for a coin
 *  POST /app/api/brain/strategy        → set manual_strategy_selected for a coin
 *  POST /app/api/brain/refresh         → force-refresh predictive data for one coin
 *  GET  /app/api/brain/strategies      → return STRATEGY_REGISTRY for the dropdown
 *  POST /admin/api/brain/tournament    → (admin) manually trigger a tournament run
 * ══════════════════════════════════════════════════════════════════════════
 */

const { STRATEGY_REGISTRY, STRATEGY_IDS } = require('../lib/predictive-schema');
const { runPredictiveBrain }               = require('../lib/predictive-brain');

// ─────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────

function cleanPair(raw = '') {
  let p = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!p.endsWith('USDT')) p += 'USDT';
  return p;
}

function jsonError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

// Fetch latest price + 4h candles from Binance module
async function fetchCandleData(binance, coinPair, logger) {
  try {
    // Try to get candles via the binance lib's getKlines
    const candles = await binance.getKlines(coinPair, '4h', 100);
    if (!candles || candles.length < 35) return null;
    const currentPrice = candles[candles.length - 1].close;
    return { candles, currentPrice };
  } catch (err) {
    logger.warn(`[predictive-routes] Candle fetch failed for ${coinPair}: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  ROUTE REGISTRATION
// ─────────────────────────────────────────────────────────────────────────

module.exports = function registerPredictiveRoutes(
  { saasAuth, db, binance, renderView, logger = console },
  app
) {

  // ══════════════════════════════════════════════════════════════════════
  //  PAGE ROUTE
  // ══════════════════════════════════════════════════════════════════════

  app.get('/app/brain', saasAuth.requireUserAuth, async (req, res) => {
    try {
      const user = await db.getSaasUserById(req.saasUser.userId);
      res.send(renderView('app/brain', {
        username:        req.saasUser.username,
        watchlistCount:  user?.watchlist_coins?.length ?? 0,
        strategies:      STRATEGY_REGISTRY,
      }, req.url));
    } catch (err) {
      logger.error('[predictive-routes] Page render error:', err.message);
      res.status(500).send('Internal error');
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  //  GET /app/api/brain/watchlist
  //  Returns user's watchlist with freshest predictive data available.
  //  Does NOT wait for a full re-analysis (that's done on /refresh).
  // ══════════════════════════════════════════════════════════════════════

  app.get('/app/api/brain/watchlist', saasAuth.requireUserAuth, async (req, res) => {
    try {
      const user = await db.getSaasUserById(req.saasUser.userId);
      if (!user) return jsonError(res, 404, 'User not found');

      // Fetch current prices in bulk for fast UI update
      const coins = user.watchlist_coins || [];
      const priceMap = {};

      // Batch price fetch (best-effort; failure just means stale price shown)
      try {
        if (typeof binance.getPrices === 'function') {
          const symbols = coins.map(c => c.coin_pair);
          const prices  = await binance.getPrices(symbols);
          Object.assign(priceMap, prices);
        }
      } catch (_) { /* non-fatal */ }

      // Merge live price into each coin's data
      const enriched = coins.map(c => {
        const raw = c.toObject ? c.toObject() : { ...c };
        if (priceMap[c.coin_pair]) {
          raw.current_price = parseFloat(priceMap[c.coin_pair]);
        }
        return raw;
      });

      return res.json({ ok: true, coins: enriched, strategies: STRATEGY_REGISTRY });

    } catch (err) {
      logger.error('[predictive-routes] GET watchlist error:', err.message);
      return jsonError(res, 500, 'Failed to load watchlist');
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  //  POST /app/api/brain/watchlist/add
  //  Body: { coin_pair: "ETHUSDT" }
  // ══════════════════════════════════════════════════════════════════════

  app.post('/app/api/brain/watchlist/add', saasAuth.requireUserAuth, async (req, res) => {
    try {
      const { coin_pair } = req.body || {};
      if (!coin_pair) return jsonError(res, 400, 'coin_pair is required');

      const pair = cleanPair(coin_pair);
      const user = await db.getSaasUserById(req.saasUser.userId);
      if (!user) return jsonError(res, 404, 'User not found');

      // Validate pair exists on Binance (best-effort)
      try {
        const info = await binance.getSymbolInfo?.(pair);
        if (info === null) return jsonError(res, 400, `${pair} not found on Binance`);
      } catch (_) { /* skip validation if binance.getSymbolInfo unavailable */ }

      // Check watchlist size limit
      if ((user.watchlist_coins || []).length >= 50) {
        return jsonError(res, 400, 'Watchlist limit reached (50 coins max)');
      }

      // Check for duplicates
      const exists = (user.watchlist_coins || []).some(c => c.coin_pair === pair);
      if (exists) return jsonError(res, 409, `${pair} is already in your watchlist`);

      // Add the coin with default values
      await db.addWatchlistCoin(user._id, {
        coin_pair:               pair,
        auto_pilot_enabled:      false,
        manual_strategy_selected: null,
        ai_active_strategy:      null,
      });

      // Kick off an async background refresh (non-blocking)
      triggerBackgroundRefresh(user._id, pair, { db, binance, logger });

      return res.json({ ok: true, coin_pair: pair, message: `${pair} added to watchlist` });

    } catch (err) {
      logger.error('[predictive-routes] Add coin error:', err.message);
      return jsonError(res, 500, 'Failed to add coin');
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  //  POST /app/api/brain/watchlist/remove
  //  Body: { coin_pair: "ETHUSDT" }
  // ══════════════════════════════════════════════════════════════════════

  app.post('/app/api/brain/watchlist/remove', saasAuth.requireUserAuth, async (req, res) => {
    try {
      const { coin_pair } = req.body || {};
      if (!coin_pair) return jsonError(res, 400, 'coin_pair is required');

      const pair = cleanPair(coin_pair);
      const user = await db.getSaasUserById(req.saasUser.userId);
      if (!user) return jsonError(res, 404, 'User not found');

      await db.removeWatchlistCoin(user._id, pair);
      return res.json({ ok: true, message: `${pair} removed from watchlist` });

    } catch (err) {
      logger.error('[predictive-routes] Remove coin error:', err.message);
      return jsonError(res, 500, 'Failed to remove coin');
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  //  POST /app/api/brain/autopilot
  //  Toggle auto_pilot_enabled for a specific coin.
  //  Body: { coin_pair: "BTCUSDT", enabled: true }
  // ══════════════════════════════════════════════════════════════════════

  app.post('/app/api/brain/autopilot', saasAuth.requireUserAuth, async (req, res) => {
    try {
      const { coin_pair, enabled } = req.body || {};
      if (!coin_pair || enabled === undefined) {
        return jsonError(res, 400, 'coin_pair and enabled are required');
      }

      const pair    = cleanPair(coin_pair);
      const enabledBool = Boolean(enabled);

      await db.updateWatchlistCoin(req.saasUser.userId, pair, {
        auto_pilot_enabled: enabledBool,
      });

      return res.json({
        ok:                 true,
        coin_pair:          pair,
        auto_pilot_enabled: enabledBool,
        message: enabledBool
          ? `🤖 Auto-Pilot ON for ${pair} — AI will pick the best strategy`
          : `🎛 Manual mode ON for ${pair}`,
      });

    } catch (err) {
      logger.error('[predictive-routes] Autopilot toggle error:', err.message);
      return jsonError(res, 500, 'Failed to update auto-pilot setting');
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  //  POST /app/api/brain/strategy
  //  Set manual strategy for a coin (auto_pilot must be OFF).
  //  Body: { coin_pair: "BTCUSDT", strategy_id: "smc_breakout" }
  // ══════════════════════════════════════════════════════════════════════

  app.post('/app/api/brain/strategy', saasAuth.requireUserAuth, async (req, res) => {
    try {
      const { coin_pair, strategy_id } = req.body || {};
      if (!coin_pair || !strategy_id) {
        return jsonError(res, 400, 'coin_pair and strategy_id are required');
      }
      if (!STRATEGY_IDS.includes(strategy_id)) {
        return jsonError(res, 400, `Unknown strategy: ${strategy_id}`);
      }

      const pair = cleanPair(coin_pair);
      const user = await db.getSaasUserById(req.saasUser.userId);
      if (!user) return jsonError(res, 404, 'User not found');

      const wc = (user.watchlist_coins || []).find(c => c.coin_pair === pair);
      if (!wc) return jsonError(res, 404, `${pair} not in watchlist`);

      if (wc.auto_pilot_enabled) {
        return jsonError(res, 409, 'Disable Auto-Pilot first to set a manual strategy');
      }

      await db.updateWatchlistCoin(user._id, pair, {
        manual_strategy_selected: strategy_id,
      });

      const strat = STRATEGY_REGISTRY.find(s => s.id === strategy_id);
      return res.json({
        ok:        true,
        coin_pair: pair,
        strategy:  strat,
        message:   `Strategy set: ${strat?.label}`,
      });

    } catch (err) {
      logger.error('[predictive-routes] Strategy set error:', err.message);
      return jsonError(res, 500, 'Failed to set strategy');
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  //  POST /app/api/brain/refresh
  //  Force-refresh the predictive data for one coin (runs Brain analysis).
  //  Body: { coin_pair: "SOLUSDT" }
  // ══════════════════════════════════════════════════════════════════════

  app.post('/app/api/brain/refresh', saasAuth.requireUserAuth, async (req, res) => {
    try {
      const { coin_pair } = req.body || {};
      if (!coin_pair) return jsonError(res, 400, 'coin_pair is required');

      const pair = cleanPair(coin_pair);
      const user = await db.getSaasUserById(req.saasUser.userId);
      if (!user) return jsonError(res, 404, 'User not found');

      const wc = (user.watchlist_coins || []).find(c => c.coin_pair === pair);
      if (!wc) return jsonError(res, 404, `${pair} not in watchlist`);

      // Fetch candle data
      const data = await fetchCandleData(binance, pair, logger);
      if (!data) return jsonError(res, 503, `Could not fetch candle data for ${pair}`);

      // Run Predictive Brain
      const result = runPredictiveBrain({
        coinPair:       pair,
        currentPrice:   data.currentPrice,
        candles4h:      data.candles,
        activeStrategy: wc.auto_pilot_enabled
          ? wc.ai_active_strategy
          : wc.manual_strategy_selected,
      });

      if (!result.ok) return jsonError(res, 500, result.error);

      // Persist result to DB
      await db.updateWatchlistCoin(user._id, pair, {
        current_price:             result.current_price,
        ai_predicted_target_price: result.ai_predicted_target_price,
        predicted_upside_pct:      result.predicted_upside_pct,
        future_trend_4h:           result.future_trend_4h,
        market_regime:             result.market_regime,
        hurst_exponent:            result.hurst_exponent,
        signal_blocked:            result.signal_blocked,
        last_refreshed_at:         new Date(),
      });

      return res.json({ ok: true, analysis: result });

    } catch (err) {
      logger.error('[predictive-routes] Refresh error:', err.message);
      return jsonError(res, 500, 'Analysis failed');
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  //  GET /app/api/brain/strategies
  //  Returns the STRATEGY_REGISTRY for populating the frontend dropdown.
  // ══════════════════════════════════════════════════════════════════════

  app.get('/app/api/brain/strategies', saasAuth.requireUserAuth, (req, res) => {
    return res.json({ ok: true, strategies: STRATEGY_REGISTRY });
  });

  // ══════════════════════════════════════════════════════════════════════
  //  ADMIN: POST /admin/api/brain/tournament
  //  Manually trigger the Strategy Tournament for all users.
  // ══════════════════════════════════════════════════════════════════════

  app.post('/admin/api/brain/tournament', saasAuth.requireAdminAuth, async (req, res) => {
    try {
      const { runStrategyTournamentCron } = require('../lib/autopilot-cron');
      // Run asynchronously — respond immediately with 202 Accepted
      res.status(202).json({ ok: true, message: 'Tournament started in background' });
      runStrategyTournamentCron({ db, binance, logger }).catch(e =>
        logger.error('[predictive-routes] Tournament error:', e.message)
      );
    } catch (err) {
      return jsonError(res, 500, 'Failed to start tournament');
    }
  });

};

// ─────────────────────────────────────────────────────────────────────────
//  BACKGROUND REFRESH HELPER (fire-and-forget)
// ─────────────────────────────────────────────────────────────────────────

async function triggerBackgroundRefresh(userId, coinPair, { db, binance, logger }) {
  try {
    await new Promise(r => setTimeout(r, 500));  // tiny delay so ADD response goes first
    const data = await fetchCandleData(binance, coinPair, logger);
    if (!data) return;

    const result = runPredictiveBrain({
      coinPair,
      currentPrice: data.currentPrice,
      candles4h:    data.candles,
    });
    if (!result.ok) return;

    await db.updateWatchlistCoin(userId, coinPair, {
      current_price:             result.current_price,
      ai_predicted_target_price: result.ai_predicted_target_price,
      predicted_upside_pct:      result.predicted_upside_pct,
      future_trend_4h:           result.future_trend_4h,
      market_regime:             result.market_regime,
      hurst_exponent:            result.hurst_exponent,
      signal_blocked:            result.signal_blocked,
      last_refreshed_at:         new Date(),
    });
  } catch (_) { /* non-fatal */ }
}

async function fetchCandleData(binance, coinPair, logger) {
  try {
    const candles = await binance.getKlines(coinPair, '4h', 100);
    if (!candles || candles.length < 35) return null;
    const currentPrice = candles[candles.length - 1].close;
    return { candles, currentPrice };
  } catch (err) {
    logger.warn(`[predictive-routes] Candle fetch failed for ${coinPair}: ${err.message}`);
    return null;
  }
}
