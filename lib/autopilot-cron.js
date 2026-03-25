'use strict';
/**
 * ApexIQ · lib/autopilot-cron.js
 * ══════════════════════════════════════════════════════════════════════════
 *  AUTO-PILOT STRATEGY TOURNAMENT  ·  Weekly Cron Job
 *
 *  Runs once per week (Sunday 00:00 UTC by default via node-cron).
 *  For every user that has at least one coin with auto_pilot_enabled === true,
 *  this job simulates a "Strategy Tournament":
 *
 *  Tournament Algorithm (per coin):
 *  ─────────────────────────────────
 *  1. Fetch the last 200 × 4h candles for the coin.
 *  2. For each strategy in STRATEGY_REGISTRY, run a vectorised back-simulation
 *     that measures:
 *       • Win rate       (% of triggered signals that hit TP before SL)
 *       • Avg RRR        (average risk/reward on winners)
 *       • Regime fitness (does this strategy suit the current Hurst regime?)
 *  3. Compute a composite score = (winRate * 0.50) + (avgRRR * 15) + (regimeFit * 0.35)
 *  4. Pick the strategy with the highest composite score.
 *  5. Write the winner + score back to the user's watchlist_coins subdoc.
 *  6. Store a slim audit record in tournament_history (last 100 kept).
 *
 *  Rate limiting: one coin processed every 800 ms to respect Binance rate limits.
 *  Error isolation: a failure for one coin/user never aborts the rest.
 * ══════════════════════════════════════════════════════════════════════════
 */

const { STRATEGY_REGISTRY, STRATEGY_IDS } = require('./predictive-schema');
const { calcHurstExponent, isSignalBlockedByChopFilter } = require('./predictive-brain');

// ─────────────────────────────────────────────────────────────────────────
//  SIMULATION PARAMETERS
// ─────────────────────────────────────────────────────────────────────────

const CANDLE_LOOKBACK   = 200;  // 4h candles (~33 days)
const SIM_RRR_TARGET    = 2.0;  // we simulate TP at 2× the risk
const SIM_ATR_SL_MULT   = 1.5;  // SL placed at 1.5× ATR from entry
const RATE_LIMIT_MS     = 800;  // ms between Binance fetches
const MAX_HISTORY_ROWS  = 100;  // trim tournament_history to last N rows

// Per-strategy regime fitness scores (0–100)
// Higher = better suited to the given Hurst regime
const REGIME_FITNESS = {
  Trending: {
    smc_breakout:       90,
    fvg_fill:           55,
    ob_bounce:          60,
    trend_continuation: 95,
    liquidity_sweep:    80,
    range_scalp:        20,
    news_momentum:      75,
  },
  Ranging: {
    smc_breakout:       40,
    fvg_fill:           85,
    ob_bounce:          90,
    trend_continuation: 30,
    liquidity_sweep:    50,
    range_scalp:        95,
    news_momentum:      35,
  },
  Choppy: {
    smc_breakout:       10,  // blocked by Chop Filter
    fvg_fill:           60,
    ob_bounce:          65,
    trend_continuation: 10,  // blocked
    liquidity_sweep:    15,  // blocked
    range_scalp:        80,
    news_momentum:      10,  // blocked
  },
};

// sleep helper
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────
//  BACK-SIMULATION ENGINE
// ─────────────────────────────────────────────────────────────────────────

/**
 * Simulate a strategy on historical candle data.
 *
 * For each candle we check a simplified entry condition specific to each
 * strategy category, then project forward to see if TP or SL was hit first.
 *
 * Returns { winRate, avgRRR, tradeCount, wins }
 */
function simulateStrategy(strategyId, candles, regime) {
  // Strategies blocked by chop filter get a near-zero score
  if (isSignalBlockedByChopFilter(strategyId, regime)) {
    return { winRate: 5, avgRRR: 0.5, tradeCount: 0, wins: 0 };
  }

  if (!candles || candles.length < 20) {
    return { winRate: 0, avgRRR: 0, tradeCount: 0, wins: 0 };
  }

  let wins = 0, losses = 0, totalRRR = 0;
  const n = candles.length;

  for (let i = 14; i < n - 5; i++) {
    const c = candles[i];

    // ── ATR for this window (used for SL sizing) ────────────────────────
    const slice = candles.slice(Math.max(0, i - 14), i + 1);
    let atr = 0;
    for (let j = 1; j < slice.length; j++) {
      const curr = slice[j], prev = slice[j - 1];
      atr += Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prev.close),
        Math.abs(curr.low  - prev.close)
      );
    }
    atr /= (slice.length - 1);
    if (atr <= 0) continue;

    // ── Entry condition (simplified per strategy) ──────────────────────
    let entryPrice = 0;
    let direction  = 'LONG';

    switch (strategyId) {

      case 'smc_breakout': {
        // Entry: breakout above the high of the previous 5 candles
        const prevHigh = Math.max(...candles.slice(i - 5, i).map(x => x.high));
        if (c.close > prevHigh && c.volume > 0) {
          entryPrice = c.close;
          direction  = 'LONG';
        }
        break;
      }

      case 'fvg_fill': {
        // Entry: close below a prior FVG lower boundary (mean reversion buy)
        const prevLow2 = candles[i - 2]?.low;
        if (prevLow2 && c.low <= prevLow2 * 1.002 && c.close > c.open) {
          entryPrice = c.close;
          direction  = 'LONG';
        }
        break;
      }

      case 'ob_bounce': {
        // Entry: bullish engulfing after price touched a recent low
        const recentLow = Math.min(...candles.slice(i - 8, i).map(x => x.low));
        if (c.low <= recentLow * 1.003 && c.close > candles[i - 1].high) {
          entryPrice = c.close;
          direction  = 'LONG';
        }
        break;
      }

      case 'trend_continuation': {
        // Entry: close above EMA20 after a 3-candle pullback
        const ema20 = candles.slice(i - 20, i).reduce((s, x) => s + x.close, 0) / 20;
        const prev3 = candles.slice(i - 3, i);
        const wasBelowEMA = prev3.some(x => x.close < ema20);
        if (wasBelowEMA && c.close > ema20 * 1.001) {
          entryPrice = c.close;
          direction  = 'LONG';
        }
        break;
      }

      case 'liquidity_sweep': {
        // Entry: wick below recent low then close back above (stop hunt)
        const prevLow5 = Math.min(...candles.slice(i - 5, i).map(x => x.low));
        if (c.low < prevLow5 * 0.999 && c.close > prevLow5) {
          entryPrice = c.close;
          direction  = 'LONG';
        }
        break;
      }

      case 'range_scalp': {
        // Entry: bounce off lower range boundary (mean reversion)
        const rangeHigh = Math.max(...candles.slice(i - 20, i).map(x => x.high));
        const rangeLow  = Math.min(...candles.slice(i - 20, i).map(x => x.low));
        const rangeSize = rangeHigh - rangeLow;
        if (rangeSize > 0 && c.close <= rangeLow + rangeSize * 0.2 && c.close > c.open) {
          entryPrice = c.close;
          direction  = 'LONG';
        }
        break;
      }

      case 'news_momentum': {
        // Entry: strong close with high volume spike (proxy for news)
        const avgVol = candles.slice(i - 10, i).reduce((s, x) => s + x.volume, 0) / 10;
        if (c.volume > avgVol * 2.5 && c.close > c.open && c.close > candles[i - 1].high) {
          entryPrice = c.close;
          direction  = 'LONG';
        }
        break;
      }

      default:
        continue;
    }

    if (!entryPrice) continue;  // no signal this candle

    // ── Project forward up to 5 candles ──────────────────────────────────
    const sl = direction === 'LONG'
      ? entryPrice - atr * SIM_ATR_SL_MULT
      : entryPrice + atr * SIM_ATR_SL_MULT;

    const tp = direction === 'LONG'
      ? entryPrice + Math.abs(entryPrice - sl) * SIM_RRR_TARGET
      : entryPrice - Math.abs(entryPrice - sl) * SIM_RRR_TARGET;

    let outcome = null;
    for (let j = i + 1; j <= Math.min(i + 5, n - 1); j++) {
      const fc = candles[j];
      if (direction === 'LONG') {
        if (fc.high >= tp)  { outcome = 'WIN';  break; }
        if (fc.low  <= sl)  { outcome = 'LOSS'; break; }
      } else {
        if (fc.low  <= tp)  { outcome = 'WIN';  break; }
        if (fc.high >= sl)  { outcome = 'LOSS'; break; }
      }
    }

    if (outcome === 'WIN')  { wins++;  totalRRR += SIM_RRR_TARGET; }
    if (outcome === 'LOSS') { losses++; }
  }

  const tradeCount = wins + losses;
  const winRate    = tradeCount > 0 ? (wins / tradeCount) * 100 : 0;
  const avgRRR     = wins > 0 ? totalRRR / wins : 0;

  return {
    winRate:    parseFloat(winRate.toFixed(2)),
    avgRRR:     parseFloat(avgRRR.toFixed(2)),
    tradeCount,
    wins,
  };
}

/**
 * Run the full tournament for a single coin.
 * Returns { winner: strategyId, scores: {…}, winnerConf: 0-100 }
 */
function runTournament(candles) {
  if (!candles || candles.length < 30) {
    return { winner: 'ob_bounce', scores: {}, winnerConf: 30 };
  }

  // Determine market regime for regime-fitness weighting
  const closes      = candles.map(c => c.close);
  const { regime }  = calcHurstExponent(closes);
  const regimeFitMap = REGIME_FITNESS[regime] || REGIME_FITNESS.Ranging;

  const scores = {};
  let bestId    = null;
  let bestScore = -Infinity;

  for (const strat of STRATEGY_REGISTRY) {
    const sim = simulateStrategy(strat.id, candles, regime);

    // Composite score:
    //   50% win rate + 15pt×RRR + 35% regime fitness
    const composite = (sim.winRate * 0.50)
      + (sim.avgRRR * 15)
      + ((regimeFitMap[strat.id] || 50) * 0.35);

    scores[strat.id] = {
      composite:  parseFloat(composite.toFixed(2)),
      winRate:    sim.winRate,
      avgRRR:     sim.avgRRR,
      tradeCount: sim.tradeCount,
      regime,
    };

    if (composite > bestScore) {
      bestScore = composite;
      bestId    = strat.id;
    }
  }

  // Normalize winner confidence to 0–100 range
  const maxPossible = 50 + (SIM_RRR_TARGET * 15) + 35;  // theoretical max
  const winnerConf  = Math.round(Math.min((bestScore / maxPossible) * 100, 99));

  return { winner: bestId, scores, winnerConf, regime };
}

// ─────────────────────────────────────────────────────────────────────────
//  CRON JOB MAIN FUNCTION
// ─────────────────────────────────────────────────────────────────────────

/**
 * runStrategyTournamentCron
 *
 * Call this from your cron scheduler (node-cron / setInterval).
 * Signature matches the dependency-injection pattern used in app-routes.js:
 *   const cron = require('./lib/autopilot-cron');
 *   cron.start({ db, binance, logger });
 *
 * @param {object} deps
 * @param {object}   deps.db       — database module (lib/database.js)
 * @param {object}   deps.binance  — binance module  (lib/binance.js)
 * @param {object}   [deps.logger] — optional logger (defaults to console)
 */
async function runStrategyTournamentCron({ db, binance, logger = console }) {
  const tag = '[AutoPilot-Cron]';
  logger.log(`${tag} Strategy Tournament started at ${new Date().toISOString()}`);

  let usersProcessed = 0, coinsUpdated = 0, errors = 0;

  try {
    // ── Step 1: Load all users (paginate if large user base) ──────────────
    const PAGE_SIZE = 100;
    let page = 1, hasMore = true;

    while (hasMore) {
      const { users } = await db.listSaasUsers(page, PAGE_SIZE);
      hasMore = users.length === PAGE_SIZE;
      page++;

      for (const userSummary of users) {
        try {
          // Full user doc needed for watchlist_coins
          const user = await db.getSaasUserById(userSummary._id);
          if (!user?.watchlist_coins?.length) continue;

          // Collect coins that need autopilot update
          const autoPilotCoins = user.watchlist_coins.filter(
            wc => wc.auto_pilot_enabled === true
          );
          if (!autoPilotCoins.length) continue;

          usersProcessed++;
          const newTournamentRows = [];

          // ── Step 2: Per-coin tournament ────────────────────────────────
          for (const wc of autoPilotCoins) {
            await sleep(RATE_LIMIT_MS);  // respect Binance rate limit

            let candles = null;
            try {
              // Fetch 200 × 4h candles
              const rawC = await binance.getKlineData(wc.coin_pair, '4h', CANDLE_LOOKBACK);
              candles = (rawC||[]).map(c=>({time:parseInt(c[0]),open:parseFloat(c[1]),high:parseFloat(c[2]),low:parseFloat(c[3]),close:parseFloat(c[4]),volume:parseFloat(c[5])}));
            } catch (fetchErr) {
              logger.warn(`${tag} [${wc.coin_pair}] Candle fetch failed: ${fetchErr.message}`);
              errors++;
              continue;
            }

            if (!candles || candles.length < 30) {
              logger.warn(`${tag} [${wc.coin_pair}] Insufficient candles (${candles?.length ?? 0})`);
              continue;
            }

            // ── Step 3: Run tournament ──────────────────────────────────
            const result = runTournament(candles);

            // ── Step 4: Write winner back to watchlist sub-doc ──────────
            await db.updateWatchlistCoinStrategy(
              user._id,
              wc.coin_pair,
              {
                ai_active_strategy:       result.winner,
                ai_strategy_confidence:   result.winnerConf,
                ai_strategy_updated_at:   new Date(),
              }
            );

            coinsUpdated++;

            // Collect audit row
            newTournamentRows.push({
              run_at:    new Date(),
              coin_pair: wc.coin_pair,
              winner:    result.winner,
              win_rate:  result.scores[result.winner]?.winRate ?? 0,
              scores:    result.scores,
            });

            logger.log(
              `${tag} [${wc.coin_pair}] Winner: ${result.winner} ` +
              `(conf: ${result.winnerConf}%, regime: ${result.scores[result.winner]?.regime})`
            );
          }

          // ── Step 5: Append audit rows & trim to last MAX_HISTORY_ROWS ──
          if (newTournamentRows.length > 0) {
            const existingHistory = user.tournament_history || [];
            const merged = [...existingHistory, ...newTournamentRows]
              .slice(-MAX_HISTORY_ROWS);

            await db.updateSaasUser(user._id, { tournament_history: merged });
          }

        } catch (userErr) {
          logger.error(`${tag} Error processing user ${userSummary._id}: ${userErr.message}`);
          errors++;
        }
      }
    }

  } catch (globalErr) {
    logger.error(`${tag} Fatal cron error: ${globalErr.message}`);
    errors++;
  }

  logger.log(
    `${tag} Tournament complete — ` +
    `${usersProcessed} users, ${coinsUpdated} coins updated, ${errors} errors`
  );

  return { usersProcessed, coinsUpdated, errors };
}

// ─────────────────────────────────────────────────────────────────────────
//  SCHEDULER SETUP
// ─────────────────────────────────────────────────────────────────────────

/**
 * start() — registers the cron schedule.
 * Call once from web/server.js or index.js after DB is connected.
 *
 * Schedule: every Sunday at 00:05 UTC
 * Fallback: pass `runNow: true` to run immediately on startup (dev mode).
 */
function start({ db, binance, logger = console, runNow = false }) {
  let cron;
  try {
    cron = require('node-cron');
  } catch (_) {
    logger.warn('[AutoPilot-Cron] node-cron not installed — cron not scheduled. Run: npm i node-cron');
    if (runNow) runStrategyTournamentCron({ db, binance, logger });
    return;
  }

  // Every Sunday at 00:05 UTC: '5 0 * * 0'
  cron.schedule('5 0 * * 0', () => {
    runStrategyTournamentCron({ db, binance, logger }).catch(e =>
      logger.error('[AutoPilot-Cron] Unhandled rejection:', e)
    );
  }, { timezone: 'UTC' });

  logger.log('[AutoPilot-Cron] Scheduled: every Sunday 00:05 UTC');

  if (runNow) {
    logger.log('[AutoPilot-Cron] runNow=true — firing immediately');
    runStrategyTournamentCron({ db, binance, logger }).catch(e =>
      logger.error('[AutoPilot-Cron] Immediate run error:', e)
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────────────────────────────────

module.exports = {
  start,
  runStrategyTournamentCron,
  runTournament,        // exported for unit tests
  simulateStrategy,     // exported for unit tests
};
