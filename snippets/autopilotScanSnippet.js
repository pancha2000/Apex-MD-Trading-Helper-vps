'use strict';
/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD  ·  snippets/autopilotScanSnippet.js
 *  ──────────────────────────────────────────────────────────────
 *  Real autopilot scan loop — drop this into autopilot-cron.js
 *  to replace the fake/placeholder top-coin logic.
 *
 *  Uses runInBatches (5 coins at a time, 1.5s between batches)
 *  so Binance never sees a 15-concurrent-request spike.
 *
 *  HOW TO INTEGRATE:
 *    Copy the `scanTopCoins` function into autopilot-cron.js,
 *    or call it from wherever your autopilot trigger lives.
 * ════════════════════════════════════════════════════════════════
 */

const { run14FactorAnalysis } = require('./analyzer');
const { runInBatches, getSuccessful } = require('./asyncBatcher');

// ── Top 15 liquid coins to scan ───────────────────────────────────
const TOP_15_COINS = [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'ADAUSDT', 'AVAXUSDT', 'DOGEUSDT', 'LINKUSDT', 'DOTUSDT',
    'MATICUSDT', 'ATOMUSDT', 'NEARUSDT', 'APTUSDT', 'ARBUSDT',
];

const SCAN_TIMEFRAME  = '15m';
const BATCH_SIZE      = 5;      // 5 concurrent → safe for Binance
const BATCH_DELAY_MS  = 1_500;  // 1.5s between batches
const MIN_SCORE       = 20;     // ignore noise signals below this

/**
 * scanTopCoins()
 *
 * Scans TOP_15_COINS using run14FactorAnalysis in safe batches.
 * Returns the single coin with the highest score (and its full result).
 *
 * @returns {Promise<{ coin: string, score: number, result: object } | null>}
 */
async function scanTopCoins() {
    const TAG = '[AutoPilot-Scan]';
    console.log(`${TAG} Starting scan of ${TOP_15_COINS.length} coins (${SCAN_TIMEFRAME})…`);

    // ── Run analysis in rate-limit-safe batches ──────────────────
    const batchResults = await runInBatches(
        TOP_15_COINS,
        BATCH_SIZE,
        BATCH_DELAY_MS,
        async (coin) => {
            const result = await run14FactorAnalysis(coin, SCAN_TIMEFRAME);
            return { coin, score: result.score ?? 0, result };
        }
    );

    // ── Log any failures ─────────────────────────────────────────
    batchResults
        .filter(r => r.status === 'rejected')
        .forEach(r => console.warn(`${TAG} ⚠ ${r.item} failed: ${r.reason?.message}`));

    // ── Filter to successful results above minimum score ─────────
    const candidates = getSuccessful(batchResults)
        .filter(r => r.score >= MIN_SCORE);

    if (!candidates.length) {
        console.log(`${TAG} No coins passed min score (${MIN_SCORE}) this run.`);
        return null;
    }

    // ── Find the single highest-scoring coin ────────────────────
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    // ── Log top 5 for visibility ─────────────────────────────────
    console.log(`${TAG} Top results:`);
    candidates.slice(0, 5).forEach((r, i) =>
        console.log(
            `  ${i + 1}. ${r.coin.padEnd(12)} ` +
            `score=${String(r.score).padStart(3)}  ` +
            `dir=${r.result.direction}  ` +
            `grade=${r.result.signalGrade ?? '—'}`
        )
    );

    console.log(
        `${TAG} ✅ Best coin: ${best.coin}  ` +
        `score=${best.score}  direction=${best.result.direction}  ` +
        `grade=${best.result.signalGradeEmoji ?? ''}`
    );

    return best;
}

module.exports = { scanTopCoins, TOP_15_COINS };


/* ════════════════════════════════════════════════════════════════
   HOW TO PLUG INTO autopilot-cron.js
   ════════════════════════════════════════════════════════════════

   In autopilot-cron.js, replace the fake scan block with:

     const { scanTopCoins } = require('./snippets/autopilotScanSnippet');
     // (or move the function body directly into autopilot-cron.js)

     // Inside runStrategyTournamentCron or your cron handler:
     const best = await scanTopCoins();
     if (best) {
         // best.coin     → e.g. 'SOLUSDT'
         // best.score    → e.g. 72
         // best.result   → full run14FactorAnalysis return object
         //                 (entry, tp1, tp2, sl, direction, reasons…)

         // Example: write winner to DB (your existing logic here)
         await db.updateSomething(best.coin, best.score, best.result);
     }

   ════════════════════════════════════════════════════════════════ */
