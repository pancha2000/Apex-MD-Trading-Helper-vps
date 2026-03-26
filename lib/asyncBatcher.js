'use strict';
/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD  ·  lib/asyncBatcher.js
 *  ──────────────────────────────────────────────────────────────
 *  Reusable rate-limit-safe batch processor.
 *
 *  Replaces bare Promise.all([80 items]) → IP bans.
 *  Processes in chunks of `batchSize` with `delayMs` sleep
 *  between batches. Returns all results in original order.
 *
 *  Usage:
 *    const { runInBatches } = require('./asyncBatcher');
 *    const results = await runInBatches(coins, 5, 1000, async (coin) => {
 *        return run14FactorAnalysis(coin, '15m');
 *    });
 * ════════════════════════════════════════════════════════════════
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * runInBatches
 *
 * @param {Array}    items        Full list to process
 * @param {number}   batchSize    Items per concurrent chunk  (e.g. 5)
 * @param {number}   delayMs      Sleep between chunks in ms  (e.g. 1000)
 * @param {Function} asyncTaskFn  async (item, index) => result
 *
 * @returns {Promise<Array<{ status:'fulfilled'|'rejected', value?, reason?, item }>}
 *   Results in original order. Failures are isolated — one bad item
 *   never aborts the rest. Check .status to filter.
 */
async function runInBatches(items, batchSize, delayMs, asyncTaskFn) {
    const results   = new Array(items.length);
    const batchCount = Math.ceil(items.length / batchSize);

    for (let b = 0; b < batchCount; b++) {
        const start = b * batchSize;
        const chunk = items.slice(start, start + batchSize);

        // Run this chunk concurrently — Promise.allSettled so one failure
        // never kills the rest of the batch
        const settled = await Promise.allSettled(
            chunk.map((item, i) => asyncTaskFn(item, start + i))
        );

        // Store results at their original index positions
        settled.forEach((outcome, i) => {
            results[start + i] = {
                ...outcome,
                item: chunk[i],
            };
        });

        // Sleep between batches (not after the last one)
        if (b < batchCount - 1 && delayMs > 0) {
            await sleep(delayMs);
        }
    }

    return results;
}

/**
 * getSuccessful — convenience filter for runInBatches results.
 * Returns only the fulfilled values as a plain array.
 *
 * @param {Array} batchResults   return value of runInBatches
 * @returns {Array}
 */
function getSuccessful(batchResults) {
    return batchResults
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);
}

module.exports = { runInBatches, getSuccessful };
