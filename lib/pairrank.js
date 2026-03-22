'use strict';
/**
 * ═══════════════════════════════════════════════════════════════
 *  APEX-MD  ·  lib/pairrank.js
 *  Pairlist Auto-Ranker — Volume + Win Rate + Score Quality
 * ═══════════════════════════════════════════════════════════════
 */
const axios = require('axios');
const db    = require('./database');

const CACHE_TTL = 10 * 60 * 1000; // 10 min
let _cache = null, _cacheTs = 0;

// ─────────────────────────────────────────────────────────────
//  Fetch top volume futures pairs from Binance
// ─────────────────────────────────────────────────────────────
async function getTopVolumePairs(limit = 50) {
    try {
        const r = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 8000 });
        return r.data
            .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('1000'))
            .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
            .slice(0, limit)
            .map(t => ({
                coin:        t.symbol.replace('USDT',''),
                symbol:      t.symbol,
                volume24h:   parseFloat(t.quoteVolume),
                priceChange: parseFloat(t.priceChangePercent),
                lastPrice:   parseFloat(t.lastPrice),
            }));
    } catch (e) {
        return [];
    }
}

// ─────────────────────────────────────────────────────────────
//  Get per-coin win rate from past paper trades in DB
// ─────────────────────────────────────────────────────────────
async function getCoinWinRates(coins) {
    const stats = {};
    try {
        const trades = await db.Trade.find({
            coin:    { $in: coins.map(c => c + 'USDT') },
            isPaper: true,
            status:  'closed',
        }).lean();

        for (const coin of coins) {
            const symbol = coin + 'USDT';
            const cTrades = trades.filter(t => t.coin === symbol);
            if (cTrades.length === 0) { stats[coin] = { winRate: null, trades: 0 }; continue; }
            const wins = cTrades.filter(t => t.result === 'win' || (t.pnlPct && t.pnlPct > 0)).length;
            const avgScore = cTrades.reduce((s, t) => s + (t.score || 0), 0) / cTrades.length;
            const avgPnl   = cTrades.reduce((s, t) => s + (t.pnlPct || 0), 0) / cTrades.length;
            stats[coin] = {
                winRate:  parseFloat((wins / cTrades.length * 100).toFixed(1)),
                trades:   cTrades.length,
                avgScore: parseFloat(avgScore.toFixed(1)),
                avgPnl:   parseFloat(avgPnl.toFixed(2)),
            };
        }
    } catch (e) { /* ignore */ }
    return stats;
}

// ─────────────────────────────────────────────────────────────
//  Composite rank score
// ─────────────────────────────────────────────────────────────
function _rankScore(vol, maxVol, winRate, trades) {
    const volScore  = (vol / maxVol) * 40;                             // 40 pts: volume
    const wrScore   = winRate != null ? (winRate / 100) * 40 : 20;    // 40 pts: win rate (20 if no data)
    const tradeBonus = Math.min(trades * 0.5, 10);                    // 10 pts: data confidence
    const actBonus  = trades === 0 ? 10 : 0;                          // 10 pts: untested = neutral bonus
    return parseFloat((volScore + wrScore + tradeBonus + actBonus).toFixed(1));
}

// ─────────────────────────────────────────────────────────────
//  MAIN: getTopRankedPairs
// ─────────────────────────────────────────────────────────────
async function getTopRankedPairs(limit = 30) {
    const now = Date.now();
    if (_cache && (now - _cacheTs) < CACHE_TTL) return _cache;

    const pairs   = await getTopVolumePairs(60);
    if (!pairs.length) return { error: 'Binance API unavailable', ranked: [] };

    const coins   = pairs.map(p => p.coin);
    const winRates = await getCoinWinRates(coins);
    const maxVol  = Math.max(...pairs.map(p => p.volume24h));

    const ranked = pairs.map(p => {
        const wr   = winRates[p.coin] || { winRate: null, trades: 0 };
        return {
            ...p,
            winRate:   wr.winRate,
            trades:    wr.trades,
            avgScore:  wr.avgScore || null,
            avgPnl:    wr.avgPnl || null,
            rankScore: _rankScore(p.volume24h, maxVol, wr.winRate, wr.trades),
            tag:       wr.trades === 0 ? '🆕 New'
                     : wr.winRate >= 60 ? '🏆 Top Performer'
                     : wr.winRate >= 50 ? '✅ Solid'
                     : wr.winRate >= 40 ? '⚠️ Average'
                     : '❌ Poor',
        };
    }).sort((a, b) => b.rankScore - a.rankScore).slice(0, limit);

    const result = {
        ranked,
        updatedAt: new Date().toISOString(),
        topCoins:  ranked.slice(0, 5).map(p => p.coin),
        bestPerformers: ranked.filter(p => p.trades >= 3 && p.winRate >= 60).slice(0, 5),
    };

    _cache   = result;
    _cacheTs = now;
    return result;
}

// Force refresh
function clearCache() { _cache = null; _cacheTs = 0; }

module.exports = { getTopRankedPairs, getCoinWinRates, clearCache };
