/**
 * ================================================================
 * APEX-MD CONFIRMATIONS ENGINE  ·  v2 FULL SPECTRUM
 * ================================================================
 * EXTERNAL FACTORS (12 total, API-based):
 *   1.  USDT Dominance         — CoinGecko stablecoin flow
 *   2.  Open Interest Change   — Binance Futures OI momentum
 *   3.  CVD External           — Binance aggTrades buy/sell
 *   4.  HTF Key Levels         — Weekly/Monthly S&R proximity
 *   5.  BTC Correlation        — Altcoin macro alignment
 *   6.  Put/Call Ratio         — Deribit options sentiment
 *   7.  Netflow Proxy          — Binance taker buy ratio
 *   8.  Social Volume          — LunarCrush (optional)
 *  [NEW] 9.  Long/Short Ratio  — Binance futures crowd sentiment
 *  [NEW] 10. Funding Momentum  — Funding rate trend direction
 *  [NEW] 11. Order Book Imbalance — Real-time bid/ask wall pressure
 *  [NEW] 12. Whale Activity    — Large-trade direction ($50K+ trades)
 *
 * LOCAL INDICATOR FACTORS (from analyzer aData — zero extra API calls):
 *  [NEW] 13. EMA Ribbon Alignment   — 9/21/55/200 stack
 *  [NEW] 14. Ichimoku Signal         — TK cross + cloud position
 *  [NEW] 15. Supertrend              — Directional bias + flip
 *  [NEW] 16. Wyckoff Phase           — Spring/UTAD high-prob zones
 *  [NEW] 17. Heikin Ashi Momentum    — Consecutive HA candles
 *  [NEW] 18. CVD Local               — Analyzer approximated CVD
 *  [NEW] 19. BB Squeeze Explosion    — Volatility breakout direction
 *  [NEW] 20. Market Maker Trap       — Bear/Bull trap detected
 *  [NEW] 21. Williams %R             — Oversold / overbought
 *  [NEW] 22. StochRSI Cross          — K/D momentum cross
 *  [NEW] 23. 3-TF Alignment          — 15m/1H/4H all aligned
 *  [NEW] 24. Daily Trend Gate        — Trade with / against daily
 *  [NEW] 25. Fib Confluence          — Price at key fib level
 *  [NEW] 26. HTF MTF Alignment       — 1H + 4H both confirm
 * ================================================================
 */

'use strict';

const axios = require('axios');

// ─── SAFE FETCH HELPER ───────────────────────────────────────────
async function safeFetch(url, opts = {}) {
    try {
        const res = await axios.get(url, { timeout: 6000, ...opts });
        return res.data;
    } catch (e) {
        return null;
    }
}

// ================================================================
// FACTOR 1: USDT Dominance
// USDT.D falling = risk-on (bullish), rising = risk-off (bearish)
// ================================================================
async function getUSDTDominance() {
    try {
        const data = await safeFetch('https://api.coingecko.com/api/v3/global');
        if (!data) return { value: null, signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'API unavailable' };

        const usdtPct  = data.data.market_cap_percentage.usdt || 0;
        const usdcPct  = data.data.market_cap_percentage.usdc || 0;
        const totalPct = usdtPct + usdcPct;

        let signal = 'NEUTRAL', emoji = '⚪', detail = '';
        if (totalPct > 9.5)      { signal = 'BEARISH'; emoji = '🔴'; detail = 'High stablecoin % = risk-off'; }
        else if (totalPct < 6.5) { signal = 'BULLISH'; emoji = '🟢'; detail = 'Low stablecoin % = risk-on';  }
        else                     { detail = 'Stablecoin % neutral range'; }

        return {
            value: totalPct.toFixed(2), usdtPct: usdtPct.toFixed(2),
            signal, emoji, detail,
            display: `${emoji} ${totalPct.toFixed(1)}% (USDT: ${usdtPct.toFixed(1)}%)`
        };
    } catch (e) {
        return { value: null, signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'Error' };
    }
}

// ================================================================
// FACTOR 2: Open Interest Change %
// OI↑ + Price↑ = new longs (bullish) | OI↑ + Price↓ = new shorts
// ================================================================
async function getOIChange(coin) {
    try {
        const currentData = await safeFetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${coin}`);
        if (!currentData) return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A (Spot only)', detail: 'Not a futures pair' };

        const histData = await safeFetch(
            `https://fapi.binance.com/futures/data/openInterestHist?symbol=${coin}&period=5m&limit=6`
        );
        if (!histData || histData.length < 2) {
            return { signal: 'NEUTRAL', emoji: '⚪', display: `OI: ${parseFloat(currentData.openInterest).toFixed(0)}`, detail: 'History unavailable' };
        }

        const currentOI = parseFloat(currentData.openInterest);
        const prevOI    = parseFloat(histData[0].sumOpenInterest);
        const oiChange  = ((currentOI - prevOI) / prevOI) * 100;

        const priceData   = await safeFetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}`);
        const priceChange = priceData ? parseFloat(priceData.priceChangePercent) : 0;

        let signal = 'NEUTRAL', emoji = '⚪', detail = '';
        const oiRising = oiChange > 0.3, oiFalling = oiChange < -0.3, priceRising = priceChange > 0;

        if (oiRising && priceRising)    { signal = 'BULLISH';      emoji = '🟢'; detail = 'OI↑ + Price↑ = New longs (strong bull)'; }
        else if (oiRising && !priceRising) { signal = 'BEARISH';   emoji = '🔴'; detail = 'OI↑ + Price↓ = New shorts (strong bear)'; }
        else if (oiFalling && priceRising) { signal = 'WEAK_BULL'; emoji = '🟡'; detail = 'OI↓ + Price↑ = Short squeeze (weak rally)'; }
        else if (oiFalling && !priceRising){ signal = 'DELEVERAGING'; emoji = '🟠'; detail = 'OI↓ + Price↓ = Liquidations / deleveraging'; }
        else                            { detail = 'OI change minimal'; }

        return {
            currentOI: currentOI.toFixed(0), oiChangePct: oiChange.toFixed(2),
            signal, emoji, detail,
            display: `${emoji} OI: ${oiChange >= 0 ? '+' : ''}${oiChange.toFixed(2)}%`
        };
    } catch (e) {
        return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'Error: ' + e.message };
    }
}

// ================================================================
// FACTOR 3: CVD External (Binance aggTrades — last 200 trades)
// ================================================================
async function getCVDExternal(coin) {
    try {
        const trades = await safeFetch(`https://api.binance.com/api/v3/aggTrades?symbol=${coin}&limit=200`);
        if (!trades || trades.length === 0) return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'No trade data' };

        let buyVol = 0, sellVol = 0;
        for (const t of trades) {
            const vol = parseFloat(t.q);
            if (t.m === false) buyVol += vol; else sellVol += vol;
        }
        const totalVol = buyVol + sellVol;
        const cvdRatio = totalVol > 0 ? ((buyVol - sellVol) / totalVol) * 100 : 0;
        const dominance = buyVol > sellVol ? 'BUYERS' : 'SELLERS';

        let signal = 'NEUTRAL', emoji = '⚪', detail = '';
        if      (cvdRatio > 10)  { signal = 'BULLISH';   emoji = '🟢'; detail = `Strong buy pressure`; }
        else if (cvdRatio < -10) { signal = 'BEARISH';   emoji = '🔴'; detail = `Strong sell pressure`; }
        else if (cvdRatio > 3)   { signal = 'MILD_BULL'; emoji = '🟡'; detail = `Mild buy pressure`; }
        else if (cvdRatio < -3)  { signal = 'MILD_BEAR'; emoji = '🟡'; detail = `Mild sell pressure`; }
        else                     { detail = 'Buy/Sell balanced'; }

        return {
            buyVol: buyVol.toFixed(2), sellVol: sellVol.toFixed(2),
            cvdRatio: cvdRatio.toFixed(1), dominance, signal, emoji, detail,
            display: `${emoji} CVD: ${dominance} ${cvdRatio >= 0 ? '+' : ''}${cvdRatio.toFixed(1)}%`
        };
    } catch (e) {
        return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'Error' };
    }
}

// ================================================================
// FACTOR 4: HTF Key Levels (Weekly/Monthly S&R proximity)
// ================================================================
async function getHTFLevels(coin) {
    try {
        const [weeklyCandles, monthlyCandles] = await Promise.all([
            safeFetch(`https://api.binance.com/api/v3/klines?symbol=${coin}&interval=1w&limit=20`),
            safeFetch(`https://api.binance.com/api/v3/klines?symbol=${coin}&interval=1M&limit=12`)
        ]);
        if (!weeklyCandles || !monthlyCandles) return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'HTF data unavailable' };

        const currentPrice  = parseFloat(weeklyCandles[weeklyCandles.length - 1][4]);
        const weeklyHighs   = weeklyCandles.map(c => parseFloat(c[2]));
        const weeklyLows    = weeklyCandles.map(c => parseFloat(c[3]));
        const monthlyHighs  = monthlyCandles.map(c => parseFloat(c[2]));
        const monthlyLows   = monthlyCandles.map(c => parseFloat(c[3]));

        const threshold = 0.03;
        const allLevels = [];
        [...weeklyHighs, ...weeklyLows, ...monthlyHighs, ...monthlyLows].forEach(level => {
            const dist = Math.abs(level - currentPrice) / currentPrice;
            if (dist < threshold) allLevels.push({ level, dist, pct: (dist * 100).toFixed(2) });
        });
        allLevels.sort((a, b) => a.dist - b.dist);

        const weeklyHigh  = Math.max(...weeklyHighs.slice(-4));
        const weeklyLow   = Math.min(...weeklyLows.slice(-4));
        const nearHTFLevel = allLevels.length > 0;
        const nearestLevel = allLevels[0];

        let signal = 'NEUTRAL', emoji = '⚪', detail = '';
        if (nearHTFLevel) {
            const isPriceAbove = currentPrice > nearestLevel.level;
            signal = isPriceAbove ? 'AT_SUPPORT' : 'AT_RESISTANCE';
            emoji  = isPriceAbove ? '🟢' : '🔴';
            detail = `Near HTF level $${nearestLevel.level.toFixed(4)} (${nearestLevel.pct}% away)`;
        } else { detail = 'Price in open air'; }

        return {
            currentPrice, weeklyHigh: weeklyHigh.toFixed(4), weeklyLow: weeklyLow.toFixed(4),
            nearLevels: allLevels.slice(0, 3), signal, emoji, detail,
            display: `${emoji} HTF: W.High $${weeklyHigh.toFixed(4)} | W.Low $${weeklyLow.toFixed(4)}`
        };
    } catch (e) {
        return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'Error' };
    }
}

// ================================================================
// FACTOR 5: BTC Correlation
// ================================================================
async function getBTCCorrelation(coin, tradeDirection) {
    try {
        if (coin === 'BTCUSDT') return { signal: 'N/A', emoji: '⚪', display: 'N/A (IS BTC)', detail: 'Trade is BTC itself', isAlts: false };

        const [btcData, coinData] = await Promise.all([
            safeFetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT'),
            safeFetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}`)
        ]);
        if (!btcData || !coinData) return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'API error' };

        const btcChange  = parseFloat(btcData.priceChangePercent);
        const coinChange = parseFloat(coinData.priceChangePercent);
        const btcTrend   = btcChange > 0.5 ? 'BULLISH' : btcChange < -0.5 ? 'BEARISH' : 'NEUTRAL';
        const tradeIsLong = tradeDirection === 'LONG';

        let signal = 'NEUTRAL', emoji = '⚪', detail = '';
        if      (btcTrend === 'BULLISH' &&  tradeIsLong)  { signal = 'CONFIRMED'; emoji = '🟢'; detail = `BTC +${btcChange.toFixed(2)}% ✅ aligned with LONG`; }
        else if (btcTrend === 'BEARISH' && !tradeIsLong)  { signal = 'CONFIRMED'; emoji = '🟢'; detail = `BTC ${btcChange.toFixed(2)}% ✅ aligned with SHORT`; }
        else if (btcTrend === 'BULLISH' && !tradeIsLong)  { signal = 'CONFLICT';  emoji = '🔴'; detail = `BTC +${btcChange.toFixed(2)}% ⚠️ conflicts SHORT`; }
        else if (btcTrend === 'BEARISH' &&  tradeIsLong)  { signal = 'CONFLICT';  emoji = '🔴'; detail = `BTC ${btcChange.toFixed(2)}% ⚠️ conflicts LONG`; }
        else { detail = `BTC neutral (${btcChange.toFixed(2)}%)`; }

        const correlated = (btcChange > 0 && coinChange > 0) || (btcChange < 0 && coinChange < 0);
        return {
            btcChange: btcChange.toFixed(2), coinChange: coinChange.toFixed(2), btcTrend, correlated,
            signal, emoji, detail,
            display: `${emoji} BTC: ${btcChange >= 0 ? '+' : ''}${btcChange.toFixed(2)}% | Coin: ${coinChange >= 0 ? '+' : ''}${coinChange.toFixed(2)}%`,
            isAlts: true
        };
    } catch (e) {
        return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'Error' };
    }
}

// ================================================================
// FACTOR 6: Put/Call Ratio (Deribit — BTC/ETH only)
// ================================================================
async function getPutCallRatio(coin) {
    try {
        const base = coin.replace('USDT', '');
        if (!['BTC', 'ETH'].includes(base)) return { signal: 'N/A', emoji: '⚪', display: 'N/A (No options)', detail: 'Options only BTC/ETH' };

        const data = await safeFetch(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${base}&kind=option`);
        if (!data || !data.result) return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'Deribit unavailable' };

        let totalCallOI = 0, totalPutOI = 0;
        data.result.forEach(opt => {
            const oi = opt.open_interest || 0;
            if (opt.instrument_name.endsWith('-C')) totalCallOI += oi;
            if (opt.instrument_name.endsWith('-P')) totalPutOI  += oi;
        });
        if (totalCallOI === 0) return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'No options data' };

        const pcr = totalPutOI / totalCallOI;
        let signal = 'NEUTRAL', emoji = '⚪', detail = '';
        if      (pcr > 1.3)  { signal = 'BEARISH';   emoji = '🔴'; detail = `PCR ${pcr.toFixed(2)} > 1.3 — heavy put buying`; }
        else if (pcr < 0.7)  { signal = 'BULLISH';   emoji = '🟢'; detail = `PCR ${pcr.toFixed(2)} < 0.7 — call heavy (bullish)`; }
        else if (pcr < 0.9)  { signal = 'MILD_BULL'; emoji = '🟡'; detail = `PCR ${pcr.toFixed(2)} — slightly call heavy`; }
        else                 { detail = `PCR ${pcr.toFixed(2)} — balanced`; }

        return {
            pcr: pcr.toFixed(3), totalCallOI: totalCallOI.toFixed(0), totalPutOI: totalPutOI.toFixed(0),
            signal, emoji, detail,
            display: `${emoji} PCR: ${pcr.toFixed(2)} (P:${(totalPutOI/1000).toFixed(0)}K / C:${(totalCallOI/1000).toFixed(0)}K)`
        };
    } catch (e) {
        return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'Error' };
    }
}

// ================================================================
// FACTOR 7: Netflow Proxy (Binance 24h taker buy ratio)
// ================================================================
async function getNetflowProxy(coin) {
    try {
        const data = await safeFetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}`);
        if (!data) return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'API error' };

        const takerBuyVol = parseFloat(data.takerBuyBaseAssetVolume);
        const totalVol    = parseFloat(data.volume);
        if (!totalVol || isNaN(totalVol) || totalVol === 0) return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'No volume' };
        if (isNaN(takerBuyVol)) return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'No taker data' };

        const buyRatio  = (takerBuyVol / totalVol) * 100;
        const sellRatio = 100 - buyRatio;

        let signal = 'NEUTRAL', emoji = '⚪', detail = '';
        if      (buyRatio > 56) { signal = 'BULLISH'; emoji = '🟢'; detail = `${buyRatio.toFixed(1)}% taker buys — accumulation`; }
        else if (buyRatio < 44) { signal = 'BEARISH'; emoji = '🔴'; detail = `${sellRatio.toFixed(1)}% taker sells — distribution`; }
        else                    { detail = `Balanced (${buyRatio.toFixed(1)}% buys)`; }

        return {
            buyRatio: buyRatio.toFixed(1), sellRatio: sellRatio.toFixed(1),
            signal, emoji, detail,
            display: `${emoji} Netflow: ${buyRatio.toFixed(1)}% Buy / ${sellRatio.toFixed(1)}% Sell`
        };
    } catch (e) {
        return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'Error' };
    }
}

// ================================================================
// FACTOR 8: Social Volume (LunarCrush — optional)
// ================================================================
async function getSocialVolume(coin, lunarApiKey = null) {
    if (!lunarApiKey) return { signal: 'N/A', emoji: '⚪', display: 'N/A (No LUNAR_API)', detail: 'Add LUNAR_API to config.env' };
    try {
        const base = coin.replace('USDT', '').toLowerCase();
        const data = await safeFetch(`https://lunarcrush.com/api4/public/coins/${base}/v1`, { headers: { Authorization: `Bearer ${lunarApiKey}` } });
        if (!data || !data.data) return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'LunarCrush unavailable' };

        const d = data.data;
        const galaxyScore  = d.galaxy_score || 50;
        const altRank      = d.alt_rank || 500;
        const socialChange = d.social_volume_24h_change || 0;

        let signal = 'NEUTRAL', emoji = '⚪', detail = '';
        if      (galaxyScore > 65 && socialChange > 20)  { signal = 'BULLISH'; emoji = '🟢'; detail = `Galaxy ${galaxyScore} | Social +${socialChange}% (viral)`; }
        else if (galaxyScore < 35 || socialChange < -30) { signal = 'BEARISH'; emoji = '🔴'; detail = `Galaxy ${galaxyScore} | Social ${socialChange}% (fading)`; }
        else                                              { detail = `Galaxy ${galaxyScore} | AltRank #${altRank}`; }

        return {
            galaxyScore, altRank, socialChange, signal, emoji, detail,
            display: `${emoji} Social: Galaxy ${galaxyScore} | AltRank #${altRank} | Δ${socialChange >= 0 ? '+' : ''}${socialChange}%`
        };
    } catch (e) {
        return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'Error' };
    }
}

// ================================================================
// [NEW] FACTOR 9: Long/Short Ratio
// Retail LONG crowd > 75% = contrarian BEARISH (overcrowded longs)
// Retail SHORT crowd > 70% = potential squeeze UP (contrarian BULLISH)
// Source: Binance futures globalLongShortAccountRatio (free)
// ================================================================
async function getLongShortRatio(coin) {
    try {
        const data = await safeFetch(
            `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${coin}&period=5m&limit=2`
        );
        if (!data || data.length === 0) return { signal: 'N/A', emoji: '⚪', display: 'N/A (Spot only)', detail: 'Futures data unavailable' };

        const latest   = data[data.length - 1];
        const lsRatio  = parseFloat(latest.longShortRatio);
        const longPct  = (lsRatio / (1 + lsRatio)) * 100;
        const shortPct = 100 - longPct;

        let signal = 'NEUTRAL', emoji = '⚪', detail = '';

        // Contrarian logic: extreme retail sentiment = fade it
        if (longPct > 75) {
            // Retail crowd all-in LONG = danger for longs, short opportunity
            signal = 'BEARISH'; emoji = '🔴';
            detail = `${longPct.toFixed(1)}% retail LONG — crowd overcrowded, reversal risk`;
        } else if (shortPct > 70) {
            // Retail crowd heavy SHORT = squeeze fuel for longs
            signal = 'BULLISH'; emoji = '🟢';
            detail = `${shortPct.toFixed(1)}% retail SHORT — short squeeze potential`;
        } else if (longPct > 60) {
            signal = 'MILD_BEAR'; emoji = '🟡';
            detail = `${longPct.toFixed(1)}% longs — slightly crowded`;
        } else if (shortPct > 60) {
            signal = 'MILD_BULL'; emoji = '🟡';
            detail = `${shortPct.toFixed(1)}% shorts — mild squeeze potential`;
        } else {
            detail = `L/S balanced: ${longPct.toFixed(1)}% Long / ${shortPct.toFixed(1)}% Short`;
        }

        return {
            lsRatio: lsRatio.toFixed(3), longPct: longPct.toFixed(1), shortPct: shortPct.toFixed(1),
            signal, emoji, detail,
            display: `${emoji} L/S: ${longPct.toFixed(1)}% Long / ${shortPct.toFixed(1)}% Short`
        };
    } catch (e) {
        return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'Error: ' + e.message };
    }
}

// ================================================================
// [NEW] FACTOR 10: Funding Rate Momentum
// Checks if funding rate is ACCELERATING (trend strengthening)
// or DECELERATING (trend weakening / reversal risk).
// Negative funding = longs pay shorts = SHORT overcrowded (LONG opp)
// Positive + accelerating = longs overcrowded (SHORT opp)
// Source: Binance fundingRate history (free)
// ================================================================
async function getFundingRateMomentum(coin) {
    try {
        const data = await safeFetch(
            `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${coin}&limit=8`
        );
        if (!data || data.length < 3) return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A (Spot only)', detail: 'Funding history unavailable' };

        const rates   = data.map(d => parseFloat(d.fundingRate) * 100); // convert to %
        const current = rates[rates.length - 1];
        const prev    = rates[rates.length - 2];
        const prev2   = rates[rates.length - 3];

        // Trend: accelerating means each period is more extreme than last
        const acceleratingPositive = current > prev && prev > prev2;
        const acceleratingNegative = current < prev && prev < prev2;
        const decelerating         = !acceleratingPositive && !acceleratingNegative;

        const avg = rates.reduce((a, b) => a + b, 0) / rates.length;

        let signal = 'NEUTRAL', emoji = '⚪', detail = '';

        if (current > 0.1 && acceleratingPositive) {
            // Longs paying heavily and accelerating = LONG overcrowded
            signal = 'BEARISH'; emoji = '🔴';
            detail = `Funding +${current.toFixed(4)}% accelerating — longs overcrowded`;
        } else if (current < -0.05 && acceleratingNegative) {
            // Shorts paying and accelerating = SHORT overcrowded = LONG opportunity
            signal = 'BULLISH'; emoji = '🟢';
            detail = `Funding ${current.toFixed(4)}% (neg, accelerating) — shorts overcrowded`;
        } else if (current < 0 && current < -0.03) {
            // Negative funding = cheaper for longs
            signal = 'MILD_BULL'; emoji = '🟡';
            detail = `Funding ${current.toFixed(4)}% negative — favors LONG entries`;
        } else if (current > 0.05) {
            signal = 'MILD_BEAR'; emoji = '🟡';
            detail = `Funding +${current.toFixed(4)}% elevated — longs paying`;
        } else {
            detail = `Funding ${current.toFixed(4)}% (neutral range, avg ${avg.toFixed(4)}%)`;
        }

        return {
            current: current.toFixed(4), prev: prev.toFixed(4), avg: avg.toFixed(4),
            acceleratingPositive, acceleratingNegative, decelerating,
            signal, emoji, detail,
            display: `${emoji} Funding: ${current >= 0 ? '+' : ''}${current.toFixed(4)}% (${acceleratingPositive ? 'accel↑' : acceleratingNegative ? 'accel↓' : 'stable'})`
        };
    } catch (e) {
        return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'Error: ' + e.message };
    }
}

// ================================================================
// [NEW] FACTOR 11: Order Book Imbalance
// Compares total bid volume vs ask volume in top 20 levels.
// Bid > Ask by 60%+ = strong buy wall = LONG confirmation
// Ask > Bid by 60%+ = strong sell wall = SHORT confirmation
// Source: Binance depth API (free, real-time)
// ================================================================
async function getOrderBookImbalance(coin) {
    try {
        const data = await safeFetch(
            `https://api.binance.com/api/v3/depth?symbol=${coin}&limit=20`
        );
        if (!data || !data.bids || !data.asks) return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'Order book unavailable' };

        // Sum total bid and ask USD volume in top 20 levels
        let totalBidUSD = 0, totalAskUSD = 0;
        for (const [price, qty] of data.bids) totalBidUSD += parseFloat(price) * parseFloat(qty);
        for (const [price, qty] of data.asks) totalAskUSD += parseFloat(price) * parseFloat(qty);

        const total      = totalBidUSD + totalAskUSD;
        const bidPct     = total > 0 ? (totalBidUSD / total) * 100 : 50;
        const askPct     = 100 - bidPct;
        const imbalance  = Math.abs(bidPct - askPct);

        let signal = 'NEUTRAL', emoji = '⚪', detail = '';

        if (bidPct > 65) {
            // Strong buy wall — institutional support below price
            signal = 'BULLISH'; emoji = '🟢';
            detail = `${bidPct.toFixed(1)}% Bid vs ${askPct.toFixed(1)}% Ask — strong buy wall`;
        } else if (askPct > 65) {
            // Strong sell wall — institutional resistance above
            signal = 'BEARISH'; emoji = '🔴';
            detail = `${askPct.toFixed(1)}% Ask vs ${bidPct.toFixed(1)}% Bid — strong sell wall`;
        } else if (bidPct > 58) {
            signal = 'MILD_BULL'; emoji = '🟡';
            detail = `${bidPct.toFixed(1)}% Bid slight dominance`;
        } else if (askPct > 58) {
            signal = 'MILD_BEAR'; emoji = '🟡';
            detail = `${askPct.toFixed(1)}% Ask slight dominance`;
        } else {
            detail = `Balanced OB: ${bidPct.toFixed(1)}% Bid / ${askPct.toFixed(1)}% Ask`;
        }

        return {
            totalBidUSD: (totalBidUSD / 1000).toFixed(1) + 'K',
            totalAskUSD: (totalAskUSD / 1000).toFixed(1) + 'K',
            bidPct: bidPct.toFixed(1), askPct: askPct.toFixed(1), imbalance: imbalance.toFixed(1),
            signal, emoji, detail,
            display: `${emoji} OB: ${bidPct.toFixed(1)}% Buy / ${askPct.toFixed(1)}% Sell wall`
        };
    } catch (e) {
        return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'Error: ' + e.message };
    }
}

// ================================================================
// [NEW] FACTOR 12: Whale Activity
// Filters aggTrades > $50,000 USD value — detects smart money.
// Whale buys > 65% = institutional accumulation (BULLISH)
// Whale sells > 65% = institutional distribution (BEARISH)
// Source: Binance aggTrades (free, last 500 trades)
// ================================================================
async function getWhaleActivity(coin) {
    try {
        // Get recent price for USD calculation
        const priceData = await safeFetch(`https://api.binance.com/api/v3/ticker/price?symbol=${coin}`);
        const price = priceData ? parseFloat(priceData.price) : 0;
        if (price === 0) return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'Price unavailable' };

        const trades = await safeFetch(`https://api.binance.com/api/v3/aggTrades?symbol=${coin}&limit=500`);
        if (!trades || trades.length === 0) return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'No trade data' };

        const WHALE_THRESHOLD_USD = 50000; // $50K minimum per trade
        let whaleBuyUSD = 0, whaleSellUSD = 0, whaleCount = 0;

        for (const t of trades) {
            const qty    = parseFloat(t.q);
            const tPrice = parseFloat(t.p) || price;
            const usdVal = qty * tPrice;

            if (usdVal >= WHALE_THRESHOLD_USD) {
                whaleCount++;
                if (t.m === false) whaleBuyUSD  += usdVal; // taker buy (aggressor)
                else               whaleSellUSD += usdVal;
            }
        }

        if (whaleCount < 3) {
            return {
                signal: 'NEUTRAL', emoji: '⚪',
                display: `⚪ Whale: ${whaleCount} trades detected (low activity)`,
                detail: `< 3 whale trades in last 500 — not significant`,
                whaleBuyUSD: 0, whaleSellUSD: 0, whaleCount
            };
        }

        const totalWhaleUSD = whaleBuyUSD + whaleSellUSD;
        const buyPct  = (whaleBuyUSD  / totalWhaleUSD) * 100;
        const sellPct = (whaleSellUSD / totalWhaleUSD) * 100;

        let signal = 'NEUTRAL', emoji = '⚪', detail = '';

        if (buyPct > 65) {
            signal = 'BULLISH'; emoji = '🟢';
            detail = `${buyPct.toFixed(1)}% whale BUYS ($${(whaleBuyUSD/1000).toFixed(0)}K) — smart money accumulating`;
        } else if (sellPct > 65) {
            signal = 'BEARISH'; emoji = '🔴';
            detail = `${sellPct.toFixed(1)}% whale SELLS ($${(whaleSellUSD/1000).toFixed(0)}K) — smart money distributing`;
        } else if (buyPct > 55) {
            signal = 'MILD_BULL'; emoji = '🟡';
            detail = `${buyPct.toFixed(1)}% whale buys — slight accumulation`;
        } else if (sellPct > 55) {
            signal = 'MILD_BEAR'; emoji = '🟡';
            detail = `${sellPct.toFixed(1)}% whale sells — slight distribution`;
        } else {
            detail = `Whales balanced: ${buyPct.toFixed(1)}% buy / ${sellPct.toFixed(1)}% sell (${whaleCount} trades)`;
        }

        return {
            whaleBuyUSD: (whaleBuyUSD/1000).toFixed(1) + 'K',
            whaleSellUSD: (whaleSellUSD/1000).toFixed(1) + 'K',
            buyPct: buyPct.toFixed(1), sellPct: sellPct.toFixed(1), whaleCount,
            signal, emoji, detail,
            display: `${emoji} Whale: ${buyPct.toFixed(1)}% Buy / ${sellPct.toFixed(1)}% Sell (${whaleCount} trades $50K+)`
        };
    } catch (e) {
        return { signal: 'NEUTRAL', emoji: '⚪', display: 'N/A', detail: 'Error: ' + e.message };
    }
}

// ================================================================
// [NEW] LOCAL INDICATORS ANALYZER
// Converts all pre-computed aData indicators into confirmation
// signals — zero extra API calls, instant execution.
// Called only when aData is passed to runAllConfirmations().
// ================================================================
function analyzeLocalIndicators(aData, direction) {
    const isLong = direction === 'LONG';
    const results = {};

    // ── 13. EMA Ribbon Alignment (9/21/55/200 stack) ──────────
    try {
        const r = aData.emaRibbon;
        if (!r) {
            results.emaRibbon = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'EMA ribbon not computed' };
        } else {
            const aligned = isLong
                ? (r.signal === 'STRONG_BULL' || r.signal === 'BULL_PULLBACK')
                : (r.signal === 'STRONG_BEAR' || r.signal === 'BEAR_PULLBACK');
            const conflict = isLong
                ? (r.signal === 'STRONG_BEAR' || r.signal === 'BEAR_PULLBACK')
                : (r.signal === 'STRONG_BULL' || r.signal === 'BULL_PULLBACK');
            const sig = aligned ? 'BULLISH' : conflict ? 'BEARISH' : 'NEUTRAL';
            results.emaRibbon = {
                signal: sig, emoji: aligned ? '🟢' : conflict ? '🔴' : '⚪',
                display: `${aligned ? '🟢' : conflict ? '🔴' : '⚪'} EMA Ribbon: ${r.quality || r.signal}`,
                detail: `Ribbon: ${r.signal}`
            };
        }
    } catch (_) { results.emaRibbon = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Error' }; }

    // ── 14. Ichimoku Signal ────────────────────────────────────
    try {
        const ich = aData.ichimoku;
        if (!ich) {
            results.ichimoku = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Ichimoku not computed' };
        } else {
            const bullSignals = ['STRONG_BULL', 'BULL'];
            const bearSignals = ['STRONG_BEAR', 'BEAR'];
            const isBull = bullSignals.includes(ich.signal);
            const isBear = bearSignals.includes(ich.signal);
            const aligned  = isLong ? isBull : isBear;
            const conflict = isLong ? isBear : isBull;
            const sig = aligned ? 'BULLISH' : conflict ? 'BEARISH' : 'NEUTRAL';
            results.ichimoku = {
                signal: sig, emoji: aligned ? '🟢' : conflict ? '🔴' : '⚪',
                display: `${aligned ? '🟢' : conflict ? '🔴' : '⚪'} Ichimoku: ${ich.signal || 'NEUTRAL'}`,
                detail: ich.tkCross ? `TK Cross: ${ich.tkCross}` : ich.signal
            };
        }
    } catch (_) { results.ichimoku = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Error' }; }

    // ── 15. Supertrend ─────────────────────────────────────────
    try {
        const st = aData.supertrend;
        if (!st) {
            results.supertrend = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Supertrend not computed' };
        } else {
            const justFlipped = isLong ? st.justFlipUp : st.justFlipDown;
            const aligned     = isLong ? (st.isBull || st.justFlipUp)  : (st.isBear || st.justFlipDown);
            const conflict    = isLong ? (st.isBear || st.justFlipDown) : (st.isBull || st.justFlipUp);
            const sig = aligned ? (justFlipped ? 'BULLISH' : 'BULLISH') : conflict ? 'BEARISH' : 'NEUTRAL';
            results.supertrend = {
                signal: sig, emoji: aligned ? '🟢' : conflict ? '🔴' : '⚪',
                display: `${aligned ? '🟢' : conflict ? '🔴' : '⚪'} Supertrend: ${st.isBull ? 'BULL' : st.isBear ? 'BEAR' : 'N/A'}${justFlipped ? ' 🔄 JUST FLIPPED' : ''}`,
                detail: st.display || ''
            };
        }
    } catch (_) { results.supertrend = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Error' }; }

    // ── 16. Wyckoff Phase ──────────────────────────────────────
    try {
        const wy = aData.wyckoff;
        if (!wy) {
            results.wyckoff = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Wyckoff not computed' };
        } else {
            const bullPhases = ['SPRING', 'MARKUP', 'ACCUMULATION'];
            const bearPhases = ['UTAD', 'MARKDOWN', 'DISTRIBUTION'];
            const isBull = bullPhases.includes(wy.phase);
            const isBear = bearPhases.includes(wy.phase);
            const aligned  = isLong ? isBull : isBear;
            const conflict = isLong ? isBear : isBull;
            const sig = aligned ? 'BULLISH' : conflict ? 'BEARISH' : 'NEUTRAL';
            results.wyckoff = {
                signal: sig, emoji: aligned ? '🟢' : conflict ? '🔴' : '⚪',
                display: `${aligned ? '🟢' : conflict ? '🔴' : '⚪'} Wyckoff: ${wy.phase || 'Unknown'}`,
                detail: wy.display || wy.phase
            };
        }
    } catch (_) { results.wyckoff = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Error' }; }

    // ── 17. Heikin Ashi Momentum ───────────────────────────────
    try {
        const ha = aData.heikinAshi;
        if (!ha) {
            results.heikinAshi = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'HA not computed' };
        } else {
            const aligned  = isLong ? ha.isBull : ha.isBear;
            const conflict = isLong ? ha.isBear : ha.isBull;
            // Strong streak = +1 bonus weighting
            const sig = aligned ? 'BULLISH' : conflict ? 'BEARISH' : 'NEUTRAL';
            results.heikinAshi = {
                signal: sig, emoji: aligned ? '🟢' : conflict ? '🔴' : '⚪',
                display: `${aligned ? '🟢' : conflict ? '🔴' : '⚪'} Heikin Ashi: ${ha.consecutive || 0}× ${ha.signal || 'N/A'}${ha.isStrong ? ' (Strong)' : ''}`,
                detail: `Streak: ${ha.consecutive}, momentum: ${ha.momentum}`
            };
        }
    } catch (_) { results.heikinAshi = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Error' }; }

    // ── 18. CVD Local (approximated from OHLCV) ───────────────
    try {
        const cvd = aData.cvd;
        if (!cvd) {
            results.cvdLocal = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'CVD not computed' };
        } else {
            const isBull = cvd.isBull || cvd.trend === 'BULL';
            const isBear = cvd.isBear || cvd.trend === 'BEAR';
            const aligned  = isLong ? isBull : isBear;
            const conflict = isLong ? isBear : isBull;
            const sig = aligned ? 'BULLISH' : conflict ? 'BEARISH' : 'NEUTRAL';
            results.cvdLocal = {
                signal: sig, emoji: aligned ? '🟢' : conflict ? '🔴' : '⚪',
                display: `${aligned ? '🟢' : conflict ? '🔴' : '⚪'} CVD Local: ${cvd.trend || 'NEUTRAL'}${cvd.bullDiv ? ' (Bull Div 🚀)' : cvd.bearDiv ? ' (Bear Div ⚠️)' : ''}`,
                detail: cvd.display || ''
            };
        }
    } catch (_) { results.cvdLocal = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Error' }; }

    // ── 19. BB Squeeze Explosion ───────────────────────────────
    try {
        const bb = aData.bbSqueeze;
        if (!bb) {
            results.bbSqueeze = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'BB Squeeze not computed' };
        } else if (!bb.exploding) {
            results.bbSqueeze = {
                signal: 'NEUTRAL', emoji: '⚪',
                display: `⚪ BB Squeeze: ${bb.squeezing ? 'Coiling (breakout pending)' : 'Normal range'}`,
                detail: 'Not yet exploding'
            };
        } else {
            const aligned  = isLong ? bb.explosionDir === 'BULL' : bb.explosionDir === 'BEAR';
            const conflict = isLong ? bb.explosionDir === 'BEAR' : bb.explosionDir === 'BULL';
            const sig = aligned ? 'BULLISH' : conflict ? 'BEARISH' : 'NEUTRAL';
            results.bbSqueeze = {
                signal: sig, emoji: aligned ? '🟢' : conflict ? '🔴' : '⚪',
                display: `${aligned ? '🟢' : conflict ? '🔴' : '⚪'} BB Explosion: ${bb.explosionDir} 🔥`,
                detail: bb.display || ''
            };
        }
    } catch (_) { results.bbSqueeze = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Error' }; }

    // ── 20. Market Maker Trap ──────────────────────────────────
    try {
        const mm = aData.mmTrap;
        if (!mm) {
            results.mmTrap = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'MM Trap not computed' };
        } else {
            // Bear Trap = price faked down then reversed = LONG signal
            // Bull Trap = price faked up then reversed = SHORT signal
            const bearTrap = mm.bearTrap;
            const bullTrap = mm.bullTrap;
            const aligned  = isLong ? bearTrap : bullTrap;
            const conflict = isLong ? bullTrap : bearTrap;
            const sig = aligned ? 'BULLISH' : conflict ? 'BEARISH' : 'NEUTRAL';
            results.mmTrap = {
                signal: sig, emoji: aligned ? '🟢' : conflict ? '🔴' : '⚪',
                display: `${aligned ? '🟢' : conflict ? '🔴' : '⚪'} MM Trap: ${bearTrap ? 'Bear Trap ✅ (LONG)' : bullTrap ? 'Bull Trap ⚠️ (SHORT)' : 'None'}`,
                detail: mm.display || 'No trap detected'
            };
        }
    } catch (_) { results.mmTrap = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Error' }; }

    // ── 21. Williams %R ────────────────────────────────────────
    try {
        const wr = aData.williamsR;
        if (!wr) {
            results.williamsR = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Williams R not computed' };
        } else {
            const aligned  = isLong ? wr.isBull : wr.isBear;
            const conflict = isLong ? wr.isBear : wr.isBull;
            const sig = aligned ? 'BULLISH' : conflict ? 'BEARISH' : 'NEUTRAL';
            results.williamsR = {
                signal: sig, emoji: aligned ? '🟢' : conflict ? '🔴' : '⚪',
                display: `${aligned ? '🟢' : conflict ? '🔴' : '⚪'} W%R: ${wr.value} — ${wr.signal}`,
                detail: wr.display || ''
            };
        }
    } catch (_) { results.williamsR = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Error' }; }

    // ── 22. StochRSI K/D Cross ─────────────────────────────────
    try {
        const srsi = aData.stochRSI;
        if (!srsi) {
            results.stochRSI = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'StochRSI not computed' };
        } else {
            const k = parseFloat(srsi.k) || 50;
            const d = parseFloat(srsi.d) || 50;
            const kCrossUp   = k > d && k < 30; // oversold K crossing D
            const kCrossDown = k < d && k > 70; // overbought K crossing D
            const oversold   = k < 20;
            const overbought = k > 80;
            const aligned  = isLong  ? (oversold || kCrossUp)   : (overbought || kCrossDown);
            const conflict = !isLong ? (oversold || kCrossUp)   : (overbought || kCrossDown);
            const sig = aligned ? 'BULLISH' : conflict ? 'BEARISH' : 'NEUTRAL';
            results.stochRSI = {
                signal: sig, emoji: aligned ? '🟢' : conflict ? '🔴' : '⚪',
                display: `${aligned ? '🟢' : conflict ? '🔴' : '⚪'} StochRSI: K=${k.toFixed(1)} D=${d.toFixed(1)}${kCrossUp ? ' ⬆️Cross' : kCrossDown ? ' ⬇️Cross' : ''}`,
                detail: `${oversold ? 'Oversold' : overbought ? 'Overbought' : 'Mid-range'} | ${srsi.signal || ''}`
            };
        }
    } catch (_) { results.stochRSI = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Error' }; }

    // ── 23. 3-TF Alignment (15m/1H/4H) ────────────────────────
    try {
        const tf = aData.tf3Align;
        if (!tf) {
            results.tfAlign = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: '3TF data not computed' };
        } else {
            const tfDir    = tf.direction || tf.dir || '';
            const aligned  = tf.aligned && (isLong ? tfDir.includes('BULL') || tfDir.includes('LONG') : tfDir.includes('BEAR') || tfDir.includes('SHORT'));
            const conflict = tf.aligned && (isLong ? tfDir.includes('BEAR') || tfDir.includes('SHORT') : tfDir.includes('BULL') || tfDir.includes('LONG'));
            const sig = aligned ? 'BULLISH' : conflict ? 'BEARISH' : 'NEUTRAL';
            results.tfAlign = {
                signal: sig, emoji: aligned ? '🟢' : conflict ? '🔴' : '⚪',
                display: `${aligned ? '🟢' : conflict ? '🔴' : '⚪'} 3TF Align: ${tf.aligned ? `✅ ${tfDir}` : '❌ Mixed'}`,
                detail: tf.display || ''
            };
        }
    } catch (_) { results.tfAlign = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Error' }; }

    // ── 24. Daily Trend Gate ───────────────────────────────────
    try {
        const dailyAligned = aData.dailyAligned;
        const dailyTrend   = aData.dailyTrend || '';
        if (typeof dailyAligned === 'undefined') {
            results.dailyGate = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Daily data not computed' };
        } else {
            results.dailyGate = {
                signal: dailyAligned ? 'BULLISH' : 'BEARISH',
                emoji:  dailyAligned ? '🟢' : '🔴',
                display: `${dailyAligned ? '🟢' : '🔴'} Daily: ${dailyTrend} ${dailyAligned ? '✅ Aligned' : '⚠️ Against daily trend'}`,
                detail: `dailyAligned=${dailyAligned}, trend=${dailyTrend}`
            };
        }
    } catch (_) { results.dailyGate = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Error' }; }

    // ── 25. Fib Confluence ─────────────────────────────────────
    try {
        const fib = aData.fibConf;
        if (!fib) {
            results.fibConf = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Fib data not computed' };
        } else {
            const sig = fib.hasConfluence ? 'BULLISH' : 'NEUTRAL';
            results.fibConf = {
                signal: sig, emoji: fib.hasConfluence ? '🟢' : '⚪',
                display: `${fib.hasConfluence ? '🟢' : '⚪'} Fib Zone: ${fib.hasConfluence ? '✅ At key fib level' : 'No fib confluence'}`,
                detail: fib.display || ''
            };
        }
    } catch (_) { results.fibConf = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Error' }; }

    // ── 26. HTF MTF Alignment (1H + 4H) ───────────────────────
    try {
        const cc = aData.confChecks;
        if (!cc) {
            results.htfMTF = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Conf checks not computed' };
        } else {
            const t1H = aData.trend1H || '';
            const t4H = aData.trend4H || '';
            const bothBull = t1H.includes('Bullish') && t4H.includes('Bullish');
            const bothBear = t1H.includes('Bearish') && t4H.includes('Bearish');
            const aligned  = isLong ? bothBull : bothBear;
            const conflict = isLong ? bothBear  : bothBull;
            const sig = aligned ? 'BULLISH' : conflict ? 'BEARISH' : 'NEUTRAL';
            results.htfMTF = {
                signal: sig, emoji: aligned ? '🟢' : conflict ? '🔴' : '⚪',
                display: `${aligned ? '🟢' : conflict ? '🔴' : '⚪'} HTF MTF: 4H=${t4H.split(' ')[0] || '?'} | 1H=${t1H.split(' ')[0] || '?'}`,
                detail: `1H: ${t1H}, 4H: ${t4H}`
            };
        }
    } catch (_) { results.htfMTF = { signal: 'N/A', emoji: '⚪', display: 'N/A', detail: 'Error' }; }

    return results;
}

// ================================================================
// MASTER FUNCTION: runAllConfirmations
// Runs all 12 external + up to 14 local indicator factors.
// aData parameter (optional): pass the full analyzer output to
// enable local indicator confirmations without extra API calls.
// ================================================================
async function runAllConfirmations(coin, direction, lunarApiKey = null, aData = null) {
    const isLong = direction === 'LONG';

    // ── Run all external factors in parallel ──────────────────
    const [
        usdtDom, oiChange, cvd, htfLevels,
        btcCorr, pcr, netflow, social,
        lsRatio, fundingMomentum, orderBook, whaleActivity
    ] = await Promise.all([
        getUSDTDominance(),
        getOIChange(coin),
        getCVDExternal(coin),
        getHTFLevels(coin),
        getBTCCorrelation(coin, direction),
        getPutCallRatio(coin),
        getNetflowProxy(coin),
        getSocialVolume(coin, lunarApiKey),
        getLongShortRatio(coin),
        getFundingRateMomentum(coin),
        getOrderBookImbalance(coin),
        getWhaleActivity(coin),
    ]);

    // ── Run local indicator analysis (if aData provided) ─────
    const local = aData ? analyzeLocalIndicators(aData, direction) : null;

    // ─── AGGREGATE SCORE ─────────────────────────────────────
    const scoreMap = {
        'BULLISH':      isLong ?  1    : -1,
        'BEARISH':      isLong ? -1    :  1,
        'CONFIRMED':     1,
        'CONFLICT':     -1,
        'AT_SUPPORT':   isLong ?  1    :  0,
        'AT_RESISTANCE':isLong ?  0    :  1,
        'MILD_BULL':    isLong ?  0.5  : -0.5,
        'MILD_BEAR':    isLong ? -0.5  :  0.5,
        'WEAK_BULL':    isLong ?  0.5  : -0.5,
        'DELEVERAGING': isLong ? -0.5  :  0.5,
        'NEUTRAL': 0, 'N/A': 0
    };

    // External factors
    const externalFactors = [usdtDom, oiChange, cvd, htfLevels, btcCorr, pcr, netflow, social, lsRatio, fundingMomentum, orderBook, whaleActivity];

    // Local factors (if available)
    const localFactors = local
        ? [local.emaRibbon, local.ichimoku, local.supertrend, local.wyckoff, local.heikinAshi, local.cvdLocal, local.bbSqueeze, local.mmTrap, local.williamsR, local.stochRSI, local.tfAlign, local.dailyGate, local.fibConf, local.htfMTF]
        : [];

    const allFactors = [...externalFactors, ...localFactors];

    let totalScore = 0, scoredCount = 0;
    allFactors.forEach(f => {
        if (!f) return;
        const s = scoreMap[f.signal] ?? 0;
        totalScore += s;
        if (f.signal !== 'N/A') scoredCount++;
    });

    const maxPossible      = scoredCount;
    const normalizedScore  = maxPossible > 0 ? ((totalScore / maxPossible) * 100).toFixed(0) : 0;

    // Overall verdict
    let verdict = '⚪ NEUTRAL', verdictDetail = 'Mixed signals — trade with caution', confirmationStrength = 'WEAK';
    const threshold = local ? 5 : 3; // higher threshold if more factors

    if      (totalScore >= threshold * 1.5)  { verdict = '🟢 STRONGLY CONFIRMED'; verdictDetail = 'Strong multi-factor alignment'; confirmationStrength = 'STRONG'; }
    else if (totalScore >= threshold)         { verdict = '🟡 CONFIRMED';           verdictDetail = 'Majority of factors support trade'; confirmationStrength = 'MODERATE'; }
    else if (totalScore <= -threshold * 1.5) { verdict = '🔴 STRONGLY REJECTED';  verdictDetail = 'Multiple factors conflict — avoid'; confirmationStrength = 'CONFLICT'; }
    else if (totalScore <= -threshold)        { verdict = '🟠 CAUTION';             verdictDetail = 'Several factors conflict';        confirmationStrength = 'CAUTION'; }

    // ─── DISPLAY STRING ──────────────────────────────────────
    const localSection = local ? `
━━━━━━━━━━━━━━━━━━
*📊 INDICATOR CONFIRMATIONS*
━━━━━━━━━━━━━━━━━━
${local.emaRibbon.display}
${local.ichimoku.display}
${local.supertrend.display}
${local.wyckoff.display}
${local.heikinAshi.display}
${local.cvdLocal.display}
${local.bbSqueeze.display}
${local.mmTrap.display}
${local.williamsR.display}
${local.stochRSI.display}
${local.tfAlign.display}
${local.dailyGate.display}
${local.fibConf.display}
${local.htfMTF.display}` : '';

    const display = `
━━━━━━━━━━━━━━━━━━
*🔬 CONFIRMATION ENGINE (${scoredCount} factors)*
━━━━━━━━━━━━━━━━━━
*🌐 EXTERNAL MARKET DATA*
${usdtDom.emoji} Stablecoin Flow:  ${usdtDom.display}
${oiChange.emoji} Open Interest:    ${oiChange.display}
${cvd.emoji} CVD (External):   ${cvd.display}
${lsRatio.emoji} Long/Short Ratio: ${lsRatio.display}
${fundingMomentum.emoji} Funding Momentum: ${fundingMomentum.display}
${orderBook.emoji} Order Book:       ${orderBook.display}
${whaleActivity.emoji} Whale Activity:   ${whaleActivity.display}
${btcCorr.emoji} BTC Correlation:  ${btcCorr.display}
${htfLevels.emoji} HTF Levels:       ${htfLevels.display}
${pcr.emoji} Put/Call Ratio:   ${pcr.display}
${netflow.emoji} Netflow:          ${netflow.display}
${social.emoji} Social:           ${social.display}${localSection}

━━━━━━━━━━━━━━━━━━
${verdict}
_Score: ${totalScore >= 0 ? '+' : ''}${totalScore.toFixed(1)} / ${maxPossible} factors (${confirmationStrength})_
${verdictDetail}`;

    return {
        // External factors (backward compatible)
        usdtDom, oiChange, cvd, htfLevels,
        btcCorr, pcr, netflow, social,
        // New external factors
        lsRatio, fundingMomentum, orderBook, whaleActivity,
        // Local indicator factors (if aData was provided)
        local,
        // Aggregates
        totalScore, normalizedScore,
        verdict, verdictDetail, confirmationStrength,
        display,
        // Helper flags for future.js
        isStronglyConfirmed: confirmationStrength === 'STRONG',
        isConflicting: confirmationStrength === 'CONFLICT' || confirmationStrength === 'CAUTION',
    };
}

module.exports = {
    getUSDTDominance,
    getOIChange,
    getCVDExternal,
    getHTFLevels,
    getBTCCorrelation,
    getPutCallRatio,
    getNetflowProxy,
    getSocialVolume,
    getLongShortRatio,
    getFundingRateMomentum,
    getOrderBookImbalance,
    getWhaleActivity,
    analyzeLocalIndicators,
    runAllConfirmations,
};
