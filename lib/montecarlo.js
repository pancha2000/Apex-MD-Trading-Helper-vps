'use strict';
/**
 * ═══════════════════════════════════════════════════════════════
 *  APEX-MD  ·  lib/montecarlo.js
 *  Monte Carlo Simulation — Stress test strategy outcomes
 * ═══════════════════════════════════════════════════════════════
 */

/**
 * runMonteCarlo(trades, scenarios, riskPerTrade)
 *   trades        — array of { pnlPct } from backtest or paper trades
 *   scenarios     — number of simulations (default 1000)
 *   riskPerTrade  — % of capital per trade (default 2)
 */
function runMonteCarlo(trades, scenarios = 1000, riskPerTrade = 2) {
    if (!trades || trades.length < 5) {
        return { error: 'Minimum 5 trades required for Monte Carlo simulation' };
    }

    const pnls      = trades.map(t => parseFloat(t.pnlPct) || 0);
    const startCap  = 100;
    const results   = [];

    for (let s = 0; s < scenarios; s++) {
        // Shuffle trade sequence randomly
        const shuffled = [...pnls].sort(() => Math.random() - 0.5);
        let   capital  = startCap;
        let   peak     = startCap;
        let   maxDD    = 0;
        const curve    = [startCap];

        for (const pnl of shuffled) {
            // Apply risk per trade
            const riskAmt = capital * (riskPerTrade / 100);
            capital      += riskAmt * (pnl / 100) * (1 / (riskPerTrade / 100));
            // Actually: capital = capital * (1 + pnl/100 * riskPerTrade/100)
            capital = startCap; // reset and recalc properly
            break;
        }

        // Proper calculation
        capital = startCap;
        peak    = startCap;
        maxDD   = 0;
        const equity = [startCap];

        for (const pnl of shuffled) {
            capital *= (1 + (pnl / 100));
            if (capital > peak) peak = capital;
            const dd = (peak - capital) / peak * 100;
            if (dd > maxDD) maxDD = dd;
            equity.push(parseFloat(capital.toFixed(4)));
        }

        results.push({
            finalCapital: parseFloat(capital.toFixed(4)),
            maxDrawdown:  parseFloat(maxDD.toFixed(2)),
            returnPct:    parseFloat(((capital - startCap) / startCap * 100).toFixed(2)),
            equity:       s < 20 ? equity : null, // Only keep equity curves for first 20 scenarios
        });
    }

    // Sort for percentiles
    const finals = results.map(r => r.finalCapital).sort((a, b) => a - b);
    const dds    = results.map(r => r.maxDrawdown).sort((a, b) => a - b);
    const rets   = results.map(r => r.returnPct).sort((a, b) => a - b);

    const pct = (arr, p) => arr[Math.floor(arr.length * p / 100)];

    const profitable = results.filter(r => r.finalCapital > startCap).length;

    // Win/Loss streaks from original order
    let maxWinStreak = 0, maxLossStreak = 0;
    let curWin = 0, curLoss = 0;
    for (const pnl of pnls) {
        if (pnl > 0) { curWin++; curLoss = 0; maxWinStreak = Math.max(maxWinStreak, curWin); }
        else         { curLoss++; curWin = 0; maxLossStreak = Math.max(maxLossStreak, curLoss); }
    }

    // Equity curves for chart (first 20 scenarios)
    const equityCurves = results.filter(r => r.equity).map(r => r.equity);

    return {
        scenarios,
        tradesPerScenario: pnls.length,
        startCapital:      startCap,

        // Return distribution
        return: {
            median:  pct(rets, 50),
            p10:     pct(rets, 10),  // 90% of scenarios beat this
            p25:     pct(rets, 25),
            p75:     pct(rets, 75),
            p90:     pct(rets, 90),
            worst:   rets[0],
            best:    rets[rets.length - 1],
        },

        // Max drawdown distribution
        drawdown: {
            median:  pct(dds, 50),
            p90:     pct(dds, 90),  // worst 10% of scenarios
            p95:     pct(dds, 95),
            worst:   dds[dds.length - 1],
        },

        // Capital distribution
        capital: {
            p10:  pct(finals, 10),
            p50:  pct(finals, 50),
            p90:  pct(finals, 90),
        },

        profitablePct:  parseFloat((profitable / scenarios * 100).toFixed(1)),
        maxWinStreak,
        maxLossStreak,
        equityCurves,

        // Summary verdict
        verdict: _getVerdict(pct(rets, 10), pct(dds, 90), profitable / scenarios),
    };
}

function _getVerdict(worstReturn10, worstDD90, profitRatio) {
    if (profitRatio >= 0.75 && worstReturn10 > 0 && worstDD90 < 25) {
        return { label: '✅ Robust Strategy', color: 'green', detail: `${(profitRatio*100).toFixed(0)}% of scenarios profitable, worst-case DD < ${worstDD90.toFixed(0)}%` };
    } else if (profitRatio >= 0.55 && worstDD90 < 40) {
        return { label: '⚠️ Moderate Strategy', color: 'yellow', detail: `${(profitRatio*100).toFixed(0)}% profitable but high variance` };
    } else {
        return { label: '❌ Weak Strategy', color: 'red', detail: `Only ${(profitRatio*100).toFixed(0)}% of scenarios profitable — review setup` };
    }
}

module.exports = { runMonteCarlo };
