'use strict';
/**
 * ═══════════════════════════════════════════════════════════════
 *  APEX-MD  ·  lib/coinStats.js
 *  Signal Journal Auto-Tagger + Confluence Win Rate Analysis
 * ═══════════════════════════════════════════════════════════════
 */
const db = require('./database');

// ─────────────────────────────────────────────────────────────
//  Confluence win rate — which signals actually predict winners?
// ─────────────────────────────────────────────────────────────
async function getConfluenceWinRates(userId = null) {
    try {
        const query = { isPaper: true, status: 'closed' };
        if (userId) query.userId = userId;

        const trades = await db.Trade.find(query).lean();
        if (trades.length < 5) return { error: 'Need at least 5 closed trades', tags: [] };

        // Parse reasons string into individual confluence tags
        const tagStats = {};

        for (const trade of trades) {
            const isWin  = trade.result === 'win' || (trade.pnlPct && trade.pnlPct > 0);
            const reasons = (trade.reasons || '').split(',').map(r => r.trim()).filter(Boolean);

            for (const reason of reasons) {
                if (!tagStats[reason]) tagStats[reason] = { wins: 0, total: 0, pnlSum: 0 };
                tagStats[reason].total++;
                if (isWin) tagStats[reason].wins++;
                tagStats[reason].pnlSum += trade.pnlPct || 0;
            }
        }

        const tags = Object.entries(tagStats)
            .filter(([, s]) => s.total >= 3) // min 3 occurrences for reliability
            .map(([tag, s]) => ({
                tag,
                winRate:  parseFloat((s.wins / s.total * 100).toFixed(1)),
                total:    s.total,
                wins:     s.wins,
                avgPnl:   parseFloat((s.pnlSum / s.total).toFixed(2)),
                rating:   s.wins / s.total >= 0.65 ? '🏆 Strong'
                        : s.wins / s.total >= 0.50 ? '✅ Good'
                        : s.wins / s.total >= 0.40 ? '⚠️ Weak'
                        : '❌ Avoid',
            }))
            .sort((a, b) => b.winRate - a.winRate);

        return { tags, tradesAnalyzed: trades.length };
    } catch (e) {
        return { error: e.message, tags: [] };
    }
}

// ─────────────────────────────────────────────────────────────
//  Score range win rate — optimal score threshold
// ─────────────────────────────────────────────────────────────
async function getScoreAnalysis(userId = null) {
    try {
        const query = { isPaper: true, status: 'closed' };
        if (userId) query.userId = userId;

        const trades = await db.Trade.find(query).lean();
        if (trades.length < 5) return { error: 'Need at least 5 closed trades', buckets: [] };

        const buckets = [
            { label: '20–29', min: 20, max: 29 },
            { label: '30–39', min: 30, max: 39 },
            { label: '40–49', min: 40, max: 49 },
            { label: '50–59', min: 50, max: 59 },
            { label: '60–69', min: 60, max: 69 },
            { label: '70–79', min: 70, max: 79 },
            { label: '80+',   min: 80, max: 999 },
        ];

        const result = buckets.map(b => {
            const bt = trades.filter(t => (t.score||0) >= b.min && (t.score||0) <= b.max);
            if (!bt.length) return { ...b, trades: 0, winRate: null };
            const wins   = bt.filter(t => t.result === 'win' || (t.pnlPct && t.pnlPct > 0)).length;
            const avgPnl = bt.reduce((s, t) => s + (t.pnlPct||0), 0) / bt.length;
            return {
                ...b,
                trades:  bt.length,
                wins,
                winRate: parseFloat((wins / bt.length * 100).toFixed(1)),
                avgPnl:  parseFloat(avgPnl.toFixed(2)),
            };
        }).filter(b => b.trades > 0);

        // Find optimal threshold — highest win rate bucket with >= 3 trades
        const best = result.filter(b => b.trades >= 3).sort((a, b) => b.winRate - a.winRate)[0];

        return {
            buckets: result,
            optimalThreshold: best ? best.min : null,
            recommendation: best
                ? `Score ${best.label} has ${best.winRate}% win rate (${best.trades} trades) — set threshold to ${best.min}`
                : 'Not enough data yet',
            totalTrades: trades.length,
        };
    } catch (e) {
        return { error: e.message, buckets: [] };
    }
}

// ─────────────────────────────────────────────────────────────
//  Per-coin performance stats
// ─────────────────────────────────────────────────────────────
async function getCoinPerformance(userId = null, limit = 20) {
    try {
        const query = { isPaper: true, status: 'closed' };
        if (userId) query.userId = userId;

        const trades = await db.Trade.find(query).lean();
        if (!trades.length) return { coins: [] };

        const coinMap = {};
        for (const t of trades) {
            const coin = (t.coin || '').replace('USDT','');
            if (!coinMap[coin]) coinMap[coin] = { wins:0, total:0, pnlSum:0, scores:[] };
            coinMap[coin].total++;
            if (t.result === 'win' || (t.pnlPct && t.pnlPct > 0)) coinMap[coin].wins++;
            coinMap[coin].pnlSum += t.pnlPct || 0;
            if (t.score) coinMap[coin].scores.push(t.score);
        }

        const coins = Object.entries(coinMap).map(([coin, s]) => ({
            coin,
            trades:   s.total,
            winRate:  parseFloat((s.wins / s.total * 100).toFixed(1)),
            avgPnl:   parseFloat((s.pnlSum / s.total).toFixed(2)),
            avgScore: s.scores.length ? parseFloat((s.scores.reduce((a,b)=>a+b,0)/s.scores.length).toFixed(1)) : null,
            tag:      s.wins / s.total >= 0.6 ? '🏆' : s.wins / s.total >= 0.5 ? '✅' : s.wins / s.total >= 0.4 ? '⚠️' : '❌',
        })).sort((a, b) => b.winRate - a.winRate).slice(0, limit);

        return { coins };
    } catch (e) {
        return { error: e.message, coins: [] };
    }
}

// ─────────────────────────────────────────────────────────────
//  Timeframe win rate
// ─────────────────────────────────────────────────────────────
async function getTimeframeStats(userId = null) {
    try {
        const query = { isPaper: true, status: 'closed' };
        if (userId) query.userId = userId;
        const trades = await db.Trade.find(query).lean();

        const tfMap = {};
        for (const t of trades) {
            const tf = t.timeframe || '15m';
            if (!tfMap[tf]) tfMap[tf] = { wins:0, total:0, pnlSum:0 };
            tfMap[tf].total++;
            if (t.result === 'win' || (t.pnlPct && t.pnlPct > 0)) tfMap[tf].wins++;
            tfMap[tf].pnlSum += t.pnlPct || 0;
        }

        return Object.entries(tfMap).map(([tf, s]) => ({
            timeframe: tf,
            trades:   s.total,
            winRate:  parseFloat((s.wins/s.total*100).toFixed(1)),
            avgPnl:   parseFloat((s.pnlSum/s.total).toFixed(2)),
        })).sort((a, b) => b.winRate - a.winRate);
    } catch (e) {
        return [];
    }
}

// ─────────────────────────────────────────────────────────────
//  Monthly performance
// ─────────────────────────────────────────────────────────────
async function getMonthlyStats(userId = null) {
    try {
        const query = { isPaper: true, status: 'closed' };
        if (userId) query.userId = userId;
        const trades = await db.Trade.find(query).lean();

        const monthMap = {};
        for (const t of trades) {
            const m = new Date(t.closedAt || t.openTime).toISOString().slice(0,7);
            if (!monthMap[m]) monthMap[m] = { wins:0, total:0, pnlSum:0 };
            monthMap[m].total++;
            if (t.result === 'win' || (t.pnlPct && t.pnlPct > 0)) monthMap[m].wins++;
            monthMap[m].pnlSum += t.pnlPct || 0;
        }

        return Object.entries(monthMap).sort().map(([month, s]) => ({
            month,
            trades:  s.total,
            winRate: parseFloat((s.wins/s.total*100).toFixed(1)),
            pnl:     parseFloat(s.pnlSum.toFixed(2)),
        }));
    } catch (e) { return []; }
}

// ─────────────────────────────────────────────────────────────
//  Advanced Metrics (Sharpe, Profit Factor, Calmar, streaks)
// ─────────────────────────────────────────────────────────────
async function getAdvancedMetrics(userId = null) {
    try {
        const query = { isPaper: true, status: 'closed' };
        if (userId) query.userId = userId;
        const trades = await db.Trade.find(query).sort({ closedAt: 1 }).lean();
        if (trades.length < 3) return { error: 'Need at least 3 closed trades' };

        const pnls   = trades.map(t => t.pnlPct || 0);
        const wins   = pnls.filter(p => p > 0);
        const losses = pnls.filter(p => p < 0);

        // Profit Factor
        const grossProfit = wins.reduce((s, p) => s + p, 0);
        const grossLoss   = Math.abs(losses.reduce((s, p) => s + p, 0));
        const profitFactor = grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 999 : 0;

        // Sharpe Ratio (annualized, assuming 1 trade/day)
        const mean  = pnls.reduce((s, p) => s + p, 0) / pnls.length;
        const variance = pnls.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / pnls.length;
        const stdDev = Math.sqrt(variance);
        const sharpe = stdDev > 0 ? parseFloat((mean / stdDev * Math.sqrt(252)).toFixed(2)) : 0;

        // Calmar Ratio
        let equity = 100, peak = 100, maxDD = 0;
        for (const pnl of pnls) {
            equity *= (1 + pnl / 100);
            if (equity > peak) peak = equity;
            const dd = (peak - equity) / peak * 100;
            if (dd > maxDD) maxDD = dd;
        }
        const totalReturn = equity - 100;
        const calmar = maxDD > 0 ? parseFloat((totalReturn / maxDD).toFixed(2)) : 0;

        // Consecutive streaks
        let maxWin = 0, maxLoss = 0, curW = 0, curL = 0;
        let avgHoldHours = null;
        const holdTimes = [];

        for (let i = 0; i < trades.length; i++) {
            const t = trades[i];
            if (t.openTime && t.closedAt) {
                holdTimes.push((new Date(t.closedAt) - new Date(t.openTime)) / 3600000);
            }
            if ((t.pnlPct||0) > 0) { curW++; curL=0; maxWin=Math.max(maxWin,curW); }
            else                    { curL++; curW=0; maxLoss=Math.max(maxLoss,curL); }
        }
        if (holdTimes.length) {
            avgHoldHours = parseFloat((holdTimes.reduce((s,h)=>s+h,0)/holdTimes.length).toFixed(1));
        }

        // Expectancy
        const avgWin  = wins.length  ? wins.reduce((s,p)=>s+p,0)/wins.length   : 0;
        const avgLoss = losses.length ? Math.abs(losses.reduce((s,p)=>s+p,0)/losses.length) : 0;
        const wr      = wins.length / pnls.length;
        const expectancy = parseFloat(((wr * avgWin) - ((1-wr) * avgLoss)).toFixed(2));

        return {
            totalTrades:       trades.length,
            profitFactor,
            sharpeRatio:       sharpe,
            calmarRatio:       calmar,
            maxDrawdownPct:    parseFloat(maxDD.toFixed(2)),
            maxConsecWins:     maxWin,
            maxConsecLosses:   maxLoss,
            expectancyPct:     expectancy,
            avgHoldHours,
            grossProfit:       parseFloat(grossProfit.toFixed(2)),
            grossLoss:         parseFloat(grossLoss.toFixed(2)),
            avgWinPct:         parseFloat(avgWin.toFixed(2)),
            avgLossPct:        parseFloat(avgLoss.toFixed(2)),
            rating: profitFactor >= 1.5 && sharpe >= 1 ? '✅ Strong'
                  : profitFactor >= 1.2 ? '⚠️ Moderate' : '❌ Weak',
        };
    } catch (e) {
        return { error: e.message };
    }
}

module.exports = {
    getConfluenceWinRates,
    getScoreAnalysis,
    getCoinPerformance,
    getTimeframeStats,
    getMonthlyStats,
    getAdvancedMetrics,
};
