'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ApexIQ  ·  lib/backtestEngine.js  ·  Pro-Level Backtesting Engine
 * ─────────────────────────────────────────────────────────────────────────
 *  Upgrades the existing v6 backtest with three Wall Street-grade layers:
 *
 *  LAYER 1 — REALISTIC COST MODEL
 *  ───────────────────────────────
 *  Every simulated trade is adjusted for:
 *   • Maker/Taker fees   (default 0.04% per leg = 0.08% round-trip)
 *   • Market slippage    (default 0.10% on entry + 0.05% on exit)
 *  These two costs alone can turn a "70% win-rate" strategy into a loser.
 *  Real institutional desks model them on every single trade.
 *
 *  LAYER 2 — MONTE CARLO SIMULATION  (1 000 runs)
 *  ─────────────────────────────────────────────────
 *  Problem: Historical backtest results are PATH-DEPENDENT.  If your first
 *  three trades happened to be winners, your equity curve looks great.
 *  But what if they had been losers?
 *
 *  Solution: Resample.
 *   1. Take the N historical trade results (each a % PnL).
 *   2. Draw N random samples WITH REPLACEMENT from this population 1 000 ×.
 *      (Bootstrap resampling — standard in quantitative finance.)
 *   3. For each of the 1 000 synthetic equity curves, compute:
 *        • Max Drawdown  (peak-to-trough)
 *        • Final PnL
 *   4. Report the distribution:
 *        • Worst-case Max Drawdown (95th percentile of drawdowns)
 *        • 95% Confidence Interval on final PnL (2.5th–97.5th percentile)
 *        • Median final PnL
 *        • Probability of ruin (final equity < 50% of starting capital)
 *
 *  LAYER 3 — KELLY CRITERION (Optimal Position Sizing)
 *  ─────────────────────────────────────────────────────
 *  Kelly fraction = (p × (b+1) − 1) / b
 *  where p = win probability, b = average win / average loss ratio.
 *  We output half-Kelly (recommended for live trading) to account for
 *  model uncertainty.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────
//  COST MODEL DEFAULTS  (can be overridden per call)
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_FEE_PCT       = 0.04;   // % per leg (Binance futures maker/taker)
const DEFAULT_SLIP_ENTRY    = 0.10;   // % slippage on entry (market order)
const DEFAULT_SLIP_EXIT     = 0.05;   // % slippage on exit  (limit TP, market SL)
const DEFAULT_CAPITAL       = 10_000; // $ starting capital for equity curve
const DEFAULT_RISK_PER_TRADE= 1.0;   // % of capital risked per trade (1R unit)
const MONTE_CARLO_RUNS      = 1_000;  // number of resampled simulations
const KELLY_FRACTION_CAP    = 0.25;   // never size more than 25% even if Kelly says so

// ─────────────────────────────────────────────────────────────────────────
//  SECTION 1 — COST ADJUSTMENTS
// ─────────────────────────────────────────────────────────────────────────

/**
 * adjustEntryForCosts
 *
 * Given a raw entry price and direction, return the EFFECTIVE entry price
 * after applying slippage and the fee on the opening leg.
 *
 * Math:
 *   LONG  entry: price increases (you buy at a slightly higher price)
 *     effectiveEntry = rawEntry × (1 + slippage% + fee%)
 *   SHORT entry: price decreases (you sell at a slightly lower price)
 *     effectiveEntry = rawEntry × (1 − slippage% − fee%)
 *
 * @param {number}  rawPrice   — ideal entry from signal
 * @param {string}  direction  — 'LONG' | 'SHORT'
 * @param {object}  [costs]    — { feePct, slippagePct }
 * @returns {number}
 */
function adjustEntryForCosts(rawPrice, direction, costs = {}) {
    const fee  = (costs.feePct      ?? DEFAULT_FEE_PCT)    / 100;
    const slip = (costs.slippagePct ?? DEFAULT_SLIP_ENTRY) / 100;
    const mult = direction === 'LONG'
        ? (1 + slip + fee)
        : (1 - slip - fee);
    return rawPrice * mult;
}

/**
 * adjustExitForCosts
 *
 * Given a raw exit price (TP or SL), return the EFFECTIVE exit price
 * after slippage and fee on the closing leg.
 *
 * LONG  exit: you receive less (price moves against you on fill + fee)
 *   effectiveExit = rawExit × (1 − exitSlippage% − fee%)
 * SHORT exit: you pay more to close
 *   effectiveExit = rawExit × (1 + exitSlippage% + fee%)
 *
 * @param {number}  rawPrice
 * @param {string}  direction  — 'LONG' | 'SHORT'
 * @param {object}  [costs]
 * @returns {number}
 */
function adjustExitForCosts(rawPrice, direction, costs = {}) {
    const fee  = (costs.feePct     ?? DEFAULT_FEE_PCT)  / 100;
    const slip = (costs.slipPctExit ?? DEFAULT_SLIP_EXIT) / 100;
    const mult = direction === 'LONG'
        ? (1 - slip - fee)
        : (1 + slip + fee);
    return rawPrice * mult;
}

/**
 * calcTradePnL
 *
 * Calculate the net % PnL for a single completed trade after all costs.
 *
 * @param {object}  trade     — { direction, entry, exitPrice, leverage? }
 * @param {object}  [costs]   — { feePct, slippagePct, slipPctExit }
 * @returns {object}  { rawPnlPct, netPnlPct, effectiveEntry, effectiveExit, costPct }
 */
function calcTradePnL(trade, costs = {}) {
    const { direction, entry, exitPrice, leverage = 1 } = trade;
    const lev = Math.max(1, leverage);

    const effectiveEntry = adjustEntryForCosts(entry, direction, costs);
    const effectiveExit  = adjustExitForCosts(exitPrice, direction, costs);

    // Raw % move (before costs, at 1× leverage)
    const rawPct = direction === 'LONG'
        ? (exitPrice    - entry)         / entry         * 100
        : (entry         - exitPrice)    / entry         * 100;

    // Net % move at the effective (cost-adjusted) prices, then apply leverage
    const netPct = (direction === 'LONG'
        ? (effectiveExit - effectiveEntry) / effectiveEntry
        : (effectiveEntry - effectiveExit) / effectiveEntry) * 100 * lev;

    const costPct = rawPct * lev - netPct;

    return {
        rawPnlPct:      parseFloat(rawPct.toFixed(4)),
        netPnlPct:      parseFloat(netPct.toFixed(4)),
        effectiveEntry: parseFloat(effectiveEntry.toFixed(8)),
        effectiveExit:  parseFloat(effectiveExit.toFixed(8)),
        costPct:        parseFloat(costPct.toFixed(4)),   // total drag from fees + slippage
    };
}

// ─────────────────────────────────────────────────────────────────────────
//  SECTION 2 — EQUITY CURVE STATISTICS
// ─────────────────────────────────────────────────────────────────────────

/**
 * buildEquityCurve
 *
 * Given an ordered sequence of net PnL percentages, build a capital equity
 * curve starting from `startCapital`.
 *
 * Each trade risks `riskPct` of current capital.  The trade PnL is expressed
 * as a multiple of that risk (R-multiple), so a 2% net PnL on a 1% risk trade
 * = +2R.  This fixed-fractional position sizing is the industry standard.
 *
 * @param {number[]} netPnlArr    — array of net % PnL values per trade
 * @param {number}   startCapital — starting $ equity
 * @param {number}   riskPct      — % of capital risked per trade
 * @returns {{ curve: number[], finalCapital: number }}
 */
function buildEquityCurve(netPnlArr, startCapital = DEFAULT_CAPITAL, riskPct = DEFAULT_RISK_PER_TRADE) {
    let equity = startCapital;
    const curve = [equity];
    const risk  = riskPct / 100;

    for (const pnlPct of netPnlArr) {
        // Dollar value at risk this trade
        const dollarRisk = equity * risk;
        // Dollar gain/loss = riskAmt × (pnlPct / riskPct)  → R-multiples
        // Simplified: just apply pnlPct directly as a % of risked amount
        const dollarPnl  = dollarRisk * (pnlPct / riskPct);
        equity           = Math.max(0, equity + dollarPnl);
        curve.push(equity);
    }

    return { curve, finalCapital: equity };
}

/**
 * calcMaxDrawdown
 *
 * Maximum peak-to-trough decline in an equity curve, expressed as %.
 *
 * Algorithm:
 *   Track the running maximum (peak).
 *   At each point, drawdown = (current − peak) / peak × 100.
 *   The maximum drawdown is the most negative value observed.
 *
 * @param {number[]} curve  — equity curve from buildEquityCurve
 * @returns {number}  e.g. -23.5  (negative percentage)
 */
function calcMaxDrawdown(curve) {
    let peak     = curve[0];
    let maxDD    = 0;

    for (const equity of curve) {
        if (equity > peak) peak = equity;
        const dd = ((equity - peak) / peak) * 100;
        if (dd < maxDD) maxDD = dd;
    }

    return parseFloat(maxDD.toFixed(4));
}

// ─────────────────────────────────────────────────────────────────────────
//  SECTION 3 — KELLY CRITERION
// ─────────────────────────────────────────────────────────────────────────

/**
 * calcKelly
 *
 * The Kelly Criterion answers: "What fraction of capital should I risk
 * per trade to maximise long-run geometric growth?"
 *
 * Formula (simplified for binary outcomes):
 *   K = (p × (b + 1) − 1) / b
 *   where:
 *     p = probability of winning (e.g. 0.60)
 *     b = average win / average loss ratio (reward/risk)
 *
 * We output half-Kelly to reduce variance and account for model error.
 *
 * @param {number[]} netPnlArr  — array of net % PnL values
 * @returns {{ fullKelly: number, halfKelly: number, winRate: number, payoffRatio: number }}
 */
function calcKelly(netPnlArr) {
    if (!netPnlArr.length) return { fullKelly: 0, halfKelly: 0, winRate: 0, payoffRatio: 0 };

    const wins   = netPnlArr.filter(p => p > 0);
    const losses = netPnlArr.filter(p => p < 0);
    if (!wins.length || !losses.length) {
        return { fullKelly: wins.length ? 1 : 0, halfKelly: wins.length ? 0.5 : 0, winRate: wins.length / netPnlArr.length, payoffRatio: 0 };
    }

    const p            = wins.length / netPnlArr.length;
    const avgWin       = wins.reduce((s, v) => s + v, 0) / wins.length;
    const avgLoss      = Math.abs(losses.reduce((s, v) => s + v, 0) / losses.length);
    const b            = avgWin / avgLoss;   // payoff ratio

    // Kelly fraction
    const k            = (p * (b + 1) - 1) / b;
    const fullKelly    = Math.min(Math.max(k, 0), KELLY_FRACTION_CAP);
    const halfKelly    = fullKelly * 0.5;

    return {
        fullKelly:    parseFloat((fullKelly * 100).toFixed(2)),  // as %
        halfKelly:    parseFloat((halfKelly  * 100).toFixed(2)),
        winRate:      parseFloat((p * 100).toFixed(2)),
        payoffRatio:  parseFloat(b.toFixed(3)),
        avgWinPct:    parseFloat(avgWin.toFixed(4)),
        avgLossPct:   parseFloat((-avgLoss).toFixed(4)),
    };
}

// ─────────────────────────────────────────────────────────────────────────
//  SECTION 4 — MONTE CARLO ENGINE
// ─────────────────────────────────────────────────────────────────────────

/**
 * Cryptographically-seeded Fisher-Yates shuffle (in-place).
 * Uses Math.random() which is not crypto-secure but is sufficient for
 * financial simulation (we're not doing cryptography).
 */
function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/**
 * bootstrapSample
 *
 * Draw `n` samples WITH REPLACEMENT from `population`.
 * This is the Bootstrap resampling method — the gold standard for
 * estimating the sampling distribution of a statistic without
 * assuming a parametric distribution.
 *
 * @param {number[]} population  — original trade PnL array
 * @param {number}   n           — sample size (usually = population.length)
 * @returns {number[]}
 */
function bootstrapSample(population, n) {
    const sample = new Array(n);
    for (let i = 0; i < n; i++) {
        sample[i] = population[Math.floor(Math.random() * population.length)];
    }
    return sample;
}

/**
 * percentile
 *
 * Calculate the p-th percentile of a sorted array.
 * Uses linear interpolation (type 7 — NumPy default).
 *
 * @param {number[]} sortedArr  — array sorted ascending
 * @param {number}   p          — 0..100
 * @returns {number}
 */
function percentile(sortedArr, p) {
    if (!sortedArr.length) return 0;
    if (sortedArr.length === 1) return sortedArr[0];
    const index    = (p / 100) * (sortedArr.length - 1);
    const lower    = Math.floor(index);
    const upper    = Math.ceil(index);
    const fraction = index - lower;
    return sortedArr[lower] + fraction * (sortedArr[upper] - sortedArr[lower]);
}

/**
 * runMonteCarlo
 *
 * Monte Carlo Bootstrap Simulation.
 *
 * ALGORITHM:
 * ──────────
 * Given a sequence of N historical trade returns:
 *
 *   1. For each of MONTE_CARLO_RUNS iterations:
 *      a. Bootstrap-resample N trades with replacement
 *         (this creates a synthetic "what-if" history where the order
 *          and composition of trades could have been different)
 *      b. Build the equity curve for this synthetic sequence
 *      c. Record: maxDrawdown, finalPnlPct (vs starting capital)
 *
 *   2. After all runs, sort each output distribution and report:
 *      • P95 Worst Drawdown  (95th percentile — "how bad could it get?")
 *      • P2.5 / P97.5 Final PnL  (95% confidence interval on outcomes)
 *      • Median Final PnL
 *      • Prob of Ruin        (% of simulations where final equity < 50% start)
 *      • Prob of Doubling    (% of simulations where final equity > 2× start)
 *
 * @param {number[]} netPnlArr       — historical net PnL % per trade (after fees)
 * @param {object}   [opts]
 * @param {number}     [opts.runs]          — Monte Carlo iterations (default 1000)
 * @param {number}     [opts.startCapital]  — starting equity ($)
 * @param {number}     [opts.riskPct]       — % risk per trade
 * @param {Function}   [opts.onProgress]    — callback(pct) for progress bar
 *
 * @returns {MonteCarloResult}
 */
function runMonteCarlo(netPnlArr, opts = {}) {
    const {
        runs         = MONTE_CARLO_RUNS,
        startCapital = DEFAULT_CAPITAL,
        riskPct      = DEFAULT_RISK_PER_TRADE,
        onProgress   = null,
    } = opts;

    if (!netPnlArr || netPnlArr.length < 5) {
        throw new Error('[backtestEngine] Monte Carlo requires at least 5 historical trades');
    }

    const n = netPnlArr.length;

    // Output distributions
    const allDrawdowns  = [];   // one value per run
    const allFinalPnls  = [];   // one value per run
    let ruinCount       = 0;    // final equity < 50% of start
    let doubleCount     = 0;    // final equity > 200% of start

    const PROGRESS_STEPS = 20;
    const progressEvery  = Math.ceil(runs / PROGRESS_STEPS);

    for (let run = 0; run < runs; run++) {
        // Progress callback (useful for long runs in a web worker)
        if (onProgress && run % progressEvery === 0) {
            onProgress(Math.round((run / runs) * 100));
        }

        // ── Step a: Bootstrap-resample trade sequence ──────────────────
        const sample = bootstrapSample(netPnlArr, n);

        // ── Step b: Build equity curve ─────────────────────────────────
        const { curve, finalCapital } = buildEquityCurve(sample, startCapital, riskPct);

        // ── Step c: Record statistics ──────────────────────────────────
        const dd       = calcMaxDrawdown(curve);
        const finalPnl = ((finalCapital - startCapital) / startCapital) * 100;

        allDrawdowns.push(dd);
        allFinalPnls.push(finalPnl);

        if (finalCapital < startCapital * 0.50) ruinCount++;
        if (finalCapital > startCapital * 2.00) doubleCount++;
    }

    if (onProgress) onProgress(100);

    // ── Sort distributions for percentile calculations ──────────────────
    const sortedDD    = [...allDrawdowns].sort((a, b) => a - b);   // ascending (most negative first)
    const sortedPnls  = [...allFinalPnls].sort((a, b) => a - b);   // ascending

    // ── Worst-Case Drawdown: 95th percentile of drawdowns ───────────────
    // Since drawdowns are negative, 95th percentile is the MOST negative
    // value encountered in 95% of scenarios.
    const p95Drawdown = percentile(sortedDD, 5);   // 5th percentile of sorted asc = 95th worst

    // ── Confidence Interval on Final PnL ────────────────────────────────
    const p025PnL     = percentile(sortedPnls, 2.5);   // lower bound
    const p975PnL     = percentile(sortedPnls, 97.5);  // upper bound
    const medianPnL   = percentile(sortedPnls, 50);
    const meanPnL     = allFinalPnls.reduce((s, v) => s + v, 0) / runs;

    // ── Standard deviation of final PnL (measure of consistency) ────────
    const variance = allFinalPnls.reduce((s, v) => s + (v - meanPnL) ** 2, 0) / runs;
    const stdDev   = Math.sqrt(variance);

    // ── Probabilities ────────────────────────────────────────────────────
    const probRuin    = (ruinCount   / runs) * 100;
    const probDouble  = (doubleCount / runs) * 100;
    const probProfit  = (allFinalPnls.filter(p => p > 0).length / runs) * 100;

    return {
        runs,
        sampleSize: n,

        // ── Drawdown ──────────────────────────────────────────────────
        worstCaseDrawdown:     parseFloat(p95Drawdown.toFixed(2)),    // 95th percentile worst DD
        medianDrawdown:        parseFloat(percentile(sortedDD, 50).toFixed(2)),
        bestCaseDrawdown:      parseFloat(percentile(sortedDD, 95).toFixed(2)),  // mildest DD

        // ── Final PnL Confidence Interval ────────────────────────────
        pnl_p025:   parseFloat(p025PnL.toFixed(2)),    // 2.5th percentile — near worst
        pnl_median: parseFloat(medianPnL.toFixed(2)),  // 50th percentile
        pnl_mean:   parseFloat(meanPnL.toFixed(2)),
        pnl_p975:   parseFloat(p975PnL.toFixed(2)),    // 97.5th percentile — near best
        pnl_stddev: parseFloat(stdDev.toFixed(2)),

        // ── Probabilities ─────────────────────────────────────────────
        probRuin:   parseFloat(probRuin.toFixed(2)),    // % chance final equity < 50%
        probDouble: parseFloat(probDouble.toFixed(2)),  // % chance final equity > 200%
        probProfit: parseFloat(probProfit.toFixed(2)),  // % chance any profit

        // ── Interpretation strings (for messaging) ────────────────────
        interpretation: _interpretMC({
            p95Drawdown, p025PnL, p975PnL, medianPnL, probRuin
        }),
    };
}

/**
 * _interpretMC
 * Generate a human-readable summary of Monte Carlo results.
 */
function _interpretMC({ p95Drawdown, p025PnL, p975PnL, medianPnL, probRuin }) {
    const ddStr   = `${Math.abs(p95Drawdown).toFixed(1)}%`;
    const pnlStr  = `${p025PnL > 0 ? '+' : ''}${p025PnL.toFixed(1)}% to +${p975PnL.toFixed(1)}%`;
    const medStr  = `${medianPnL > 0 ? '+' : ''}${medianPnL.toFixed(1)}%`;
    const ruinStr = probRuin < 1 ? 'very low ruin risk' : probRuin < 5 ? 'moderate ruin risk' : 'HIGH ruin risk';

    return (
        `📊 Worst-case drawdown (95th pct): -${ddStr}. ` +
        `95% CI on final PnL: ${pnlStr}. ` +
        `Median outcome: ${medStr}. ` +
        `Ruin probability: ${probRuin.toFixed(1)}% (${ruinStr}).`
    );
}

// ─────────────────────────────────────────────────────────────────────────
//  SECTION 5 — FULL BACKTEST RUNNER
// ─────────────────────────────────────────────────────────────────────────

/**
 * runFullBacktest
 *
 * Master function that runs a complete backtest with cost adjustment,
 * equity curve analysis, Kelly sizing, and Monte Carlo simulation.
 *
 * @param {object[]} rawTrades   — array of trade objects from existing backtest
 *   Each: { direction, entry, tp2 (exitPrice for winners), sl (exitPrice for losers), result, leverage? }
 * @param {object}   [opts]
 * @param {number}     [opts.feePct]          — fee per leg %
 * @param {number}     [opts.slippagePct]     — entry slippage %
 * @param {number}     [opts.slipPctExit]     — exit slippage %
 * @param {number}     [opts.startCapital]
 * @param {number}     [opts.riskPct]         — % risk per trade
 * @param {boolean}    [opts.runMonteCarlo]   — set false to skip MC (faster)
 * @param {number}     [opts.mcRuns]          — Monte Carlo iterations
 *
 * @returns {FullBacktestResult}
 */
async function runFullBacktest(rawTrades, opts = {}) {
    const {
        feePct       = DEFAULT_FEE_PCT,
        slippagePct  = DEFAULT_SLIP_ENTRY,
        slipPctExit  = DEFAULT_SLIP_EXIT,
        startCapital = DEFAULT_CAPITAL,
        riskPct      = DEFAULT_RISK_PER_TRADE,
        runMC        = true,
        mcRuns       = MONTE_CARLO_RUNS,
        onProgress   = null,
    } = opts;

    if (!rawTrades || !rawTrades.length) {
        throw new Error('[backtestEngine] No trades to analyse');
    }

    const costs = { feePct, slippagePct, slipPctExit };

    // ── 1. Adjust each trade for costs ────────────────────────────────────
    const adjustedTrades = rawTrades.map((t, idx) => {
        const isWin    = t.result === 'WIN' || t.result === 'TP' || t.result === 'TP2';
        const exitRaw  = isWin ? (t.tp2 || t.tp1 || t.exitPrice) : (t.sl || t.exitPrice);

        if (!t.entry || !exitRaw) {
            return { ...t, netPnlPct: 0, rawPnlPct: 0, costPct: 0, skipped: true };
        }

        const pnl = calcTradePnL({
            direction:  t.direction || 'LONG',
            entry:      parseFloat(t.entry),
            exitPrice:  parseFloat(exitRaw),
            leverage:   t.leverage || 1,
        }, costs);

        return {
            idx,
            coin:        t.coin,
            direction:   t.direction,
            entry:       t.entry,
            exit:        exitRaw,
            result:      t.result,
            ...pnl,
        };
    }).filter(t => !t.skipped);

    const netPnlArr = adjustedTrades.map(t => t.netPnlPct);
    const rawPnlArr = adjustedTrades.map(t => t.rawPnlPct);

    // ── 2. Core statistics ─────────────────────────────────────────────────
    const totalTrades  = adjustedTrades.length;
    const winningTrades= adjustedTrades.filter(t => t.netPnlPct > 0);
    const losingTrades = adjustedTrades.filter(t => t.netPnlPct <= 0);
    const winRate      = (winningTrades.length / totalTrades) * 100;

    const grossProfit  = winningTrades.reduce((s, t) => s + t.netPnlPct, 0);
    const grossLoss    = Math.abs(losingTrades.reduce((s, t) => s + t.netPnlPct, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : Infinity;

    const totalCostDrag= adjustedTrades.reduce((s, t) => s + t.costPct, 0);

    // Sharpe Ratio (simplified — assumes 0 risk-free rate)
    const meanReturn   = netPnlArr.reduce((s, v) => s + v, 0) / netPnlArr.length;
    const stdReturn    = Math.sqrt(
        netPnlArr.reduce((s, v) => s + (v - meanReturn) ** 2, 0) / netPnlArr.length
    );
    const sharpeRatio  = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(252) : 0;

    // ── 3. Equity curve (actual historical sequence) ──────────────────────
    const { curve: equityCurve, finalCapital } = buildEquityCurve(netPnlArr, startCapital, riskPct);
    const historicalMaxDD   = calcMaxDrawdown(equityCurve);
    const totalReturnPct    = ((finalCapital - startCapital) / startCapital) * 100;

    // ── 4. Kelly Criterion ────────────────────────────────────────────────
    const kelly = calcKelly(netPnlArr);

    // ── 5. Raw vs cost-adjusted comparison ───────────────────────────────
    const { curve: rawCurve, finalCapital: rawFinalCapital } = buildEquityCurve(rawPnlArr, startCapital, riskPct);
    const rawReturnPct   = ((rawFinalCapital - startCapital) / startCapital) * 100;
    const costImpactPct  = rawReturnPct - totalReturnPct;

    // ── 6. Monte Carlo simulation ─────────────────────────────────────────
    let monteCarlo = null;
    if (runMC && netPnlArr.length >= 5) {
        monteCarlo = runMonteCarlo(netPnlArr, {
            runs:         mcRuns,
            startCapital,
            riskPct,
            onProgress,
        });
    }

    // ── 7. Assemble result ────────────────────────────────────────────────
    return {
        // ── Summary ────────────────────────────────────────────────────
        totalTrades,
        wins:         winningTrades.length,
        losses:       losingTrades.length,
        winRate:      parseFloat(winRate.toFixed(2)),

        // ── P&L ────────────────────────────────────────────────────────
        grossProfit:   parseFloat(grossProfit.toFixed(4)),
        grossLoss:     parseFloat(grossLoss.toFixed(4)),
        profitFactor:  parseFloat(profitFactor.toFixed(3)),
        totalReturnPct: parseFloat(totalReturnPct.toFixed(2)),
        sharpeRatio:   parseFloat(sharpeRatio.toFixed(3)),

        // ── Cost impact ────────────────────────────────────────────────
        costModel: {
            feePctPerLeg:   feePct,
            entrySlipPct:   slippagePct,
            exitSlipPct:    slipPctExit,
            totalCostDrag:  parseFloat(totalCostDrag.toFixed(4)),
            rawReturnPct:   parseFloat(rawReturnPct.toFixed(2)),
            adjustedReturnPct: parseFloat(totalReturnPct.toFixed(2)),
            costImpactPct:  parseFloat(costImpactPct.toFixed(2)),
        },

        // ── Risk metrics ────────────────────────────────────────────────
        historicalMaxDrawdown: parseFloat(historicalMaxDD.toFixed(2)),
        startCapital,
        finalCapital:          parseFloat(finalCapital.toFixed(2)),

        // ── Kelly sizing ────────────────────────────────────────────────
        kelly,

        // ── Monte Carlo ──────────────────────────────────────────────────
        monteCarlo,

        // ── Trade detail ────────────────────────────────────────────────
        adjustedTrades,
        equityCurve,
    };
}

// ─────────────────────────────────────────────────────────────────────────
//  SECTION 6 — WHATSAPP REPORT FORMATTER
// ─────────────────────────────────────────────────────────────────────────

/**
 * formatBacktestReport
 *
 * Generate a concise WhatsApp-friendly backtest summary message.
 *
 * @param {string} coin
 * @param {string} timeframe
 * @param {FullBacktestResult} result
 * @returns {string}
 */
function formatBacktestReport(coin, timeframe, result) {
    const mc  = result.monteCarlo;
    const k   = result.kelly;
    const cm  = result.costModel;
    const dir = (n) => n >= 0 ? `+${n.toFixed(2)}%` : `${n.toFixed(2)}%`;

    return (
`╔══════════════════════════════════╗
║  📊  PRO BACKTEST REPORT  📊     ║
╚══════════════════════════════════╝

🪙 *${coin}* · ${timeframe}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📈 *Performance (Costs Adjusted)*
  Trades:    ${result.totalTrades} (${result.wins}W / ${result.losses}L)
  Win Rate:  ${result.winRate}%
  Return:    ${dir(result.totalReturnPct)}
  Profit Factor: ${result.profitFactor}×
  Sharpe:    ${result.sharpeRatio}
  Max DD:    ${result.historicalMaxDrawdown}%

💸 *Cost Drag*
  Fees/leg:  ${cm.feePctPerLeg}%
  Slippage:  ${cm.entrySlipPct}% entry / ${cm.exitSlipPct}% exit
  Raw return: ${dir(cm.rawReturnPct)}
  Actual:    ${dir(cm.adjustedReturnPct)}  (drag: ${cm.costImpactPct.toFixed(2)}%)

${mc ? `🎲 *Monte Carlo  (${mc.runs.toLocaleString()} runs)*
  Worst DD (95th pct): ${mc.worstCaseDrawdown}%
  95% CI PnL: ${dir(mc.pnl_p025)} → ${dir(mc.pnl_p975)}
  Median outcome: ${dir(mc.pnl_median)}
  Prob of ruin: ${mc.probRuin}%
  Prob of profit: ${mc.probProfit}%

` : ''}⚖️ *Kelly Criterion*
  Win rate: ${k.winRate}%  |  Payoff: ${k.payoffRatio}×
  Full Kelly: ${k.fullKelly}% of capital/trade
  Half Kelly: *${k.halfKelly}%* ← recommended size

_ApexIQ Pro Engine · All costs applied_`
    );
}

// ─────────────────────────────────────────────────────────────────────────

module.exports = {
    // Main entry
    runFullBacktest,

    // Individual components (for testing & custom pipelines)
    calcTradePnL,
    adjustEntryForCosts,
    adjustExitForCosts,
    buildEquityCurve,
    calcMaxDrawdown,
    calcKelly,
    runMonteCarlo,
    bootstrapSample,
    percentile,

    // Formatters
    formatBacktestReport,

    // Constants
    DEFAULT_FEE_PCT,
    DEFAULT_SLIP_ENTRY,
    DEFAULT_SLIP_EXIT,
    MONTE_CARLO_RUNS,
};

/**
 * @typedef {object} FullBacktestResult
 * @property {number}        totalTrades
 * @property {number}        wins
 * @property {number}        losses
 * @property {number}        winRate
 * @property {number}        profitFactor
 * @property {number}        sharpeRatio
 * @property {number}        historicalMaxDrawdown
 * @property {object}        costModel
 * @property {object}        kelly
 * @property {MonteCarloResult|null} monteCarlo
 * @property {number[]}      equityCurve
 *
 * @typedef {object} MonteCarloResult
 * @property {number}  runs
 * @property {number}  worstCaseDrawdown     — 95th pct worst DD
 * @property {number}  pnl_p025              — 2.5th pct final PnL
 * @property {number}  pnl_median            — 50th pct final PnL
 * @property {number}  pnl_p975              — 97.5th pct final PnL
 * @property {number}  probRuin              — % simulations with <50% equity
 * @property {number}  probProfit            — % simulations profitable
 * @property {string}  interpretation        — human-readable summary
 */
