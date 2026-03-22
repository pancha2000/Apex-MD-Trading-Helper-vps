'use strict';
/**
 * APEX-MD · scanner-routes.js  (CLEAN REWRITE)
 * ══════════════════════════════════════════════════════════════
 *  Page routes   → renderView()  (no HTML strings)
 *  API routes    → res.json()    (unchanged logic)
 * ══════════════════════════════════════════════════════════════
 */

module.exports = function registerScanner({ saasAuth, db, config, axios, renderView, fmtPrice, scoreColor }, app) {

const withTimeout = (p, ms, fb) => Promise.race([p, new Promise(r => setTimeout(() => r(fb), ms))]);
const STABLES  = new Set(['USDCUSDT','BUSDUSDT','DAIUSDT','TUSDUSDT','EURUSDT','GBPUSDT','USDPUSDT']);
const VALID_TF = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','12h','1d','3d','1w'];

function cleanCoin(raw) {
    let c = (raw||'').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!c.endsWith('USDT')) c += 'USDT';
    return c;
}

function calcFutures(a) {
    const entry = parseFloat(a.entryPrice)||0, sl = parseFloat(a.sl)||0, tp2 = parseFloat(a.tp2)||0;
    const risk = Math.abs(entry - sl), slPct = entry > 0 ? risk / entry : 0.02;
    const lev = Math.min(Math.ceil(slPct > 0 ? (0.02 / slPct) / 0.10 : 10), 75);
    const isL = a.direction === 'LONG';
    const rrr = risk > 0 ? (Math.abs(tp2 - entry) / risk).toFixed(2) : '—';
    return {
        leverage: lev, marginPct: 2, rrr,
        dca1: (isL ? entry - risk * 0.35 : entry + risk * 0.35).toFixed(4),
        dca2: (isL ? entry - risk * 0.70 : entry + risk * 0.70).toFixed(4),
    };
}

// ════════════════════════════════════════════════════════════════════════
//  PAGE ROUTES
// ════════════════════════════════════════════════════════════════════════

app.get('/app/scanner', saasAuth.requireUserAuth, async (req, res) => {
    let minScore = 20;
    try {
        const u = await db.getSaasUserById(req.saasUser.userId);
        minScore = u?.minScoreThreshold ?? 20;
    } catch(_) {}
    res.send(renderView('app/scanner', { username: req.saasUser.username, minScore }));
});

app.get('/app/market', saasAuth.requireUserAuth, (req, res) => {
    res.send(renderView('app/market', { username: req.saasUser.username }));
});

app.get('/app/grid', saasAuth.requireUserAuth, (req, res) => {
    res.send(renderView('app/grid', { username: req.saasUser.username }));
});

app.get('/app/funding', saasAuth.requireUserAuth, (req, res) => {
    res.send(renderView('app/funding', { username: req.saasUser.username }));
});

app.get('/app/analyzer', saasAuth.requireUserAuth, (req, res) => {
    res.send(renderView('app/scanner', { username: req.saasUser.username }));
});

// ════════════════════════════════════════════════════════════════════════
//  API ROUTES  (all unchanged logic)
// ════════════════════════════════════════════════════════════════════════

// ─── Auto Market Scan ────────────────────────────────────────────────────
app.get('/app/api/market-scan', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const binance  = require('../lib/binance');
        const analyzer = require('../lib/analyzer');
        // Get user's personal min score threshold
        let userMinScore = 20;
        try { const u = await db.getSaasUserById(req.saasUser.userId); userMinScore = u?.minScoreThreshold ?? 20; } catch(_) {}

        const allCoins = binance.isReady()
            ? binance.getWatchedCoins()
            : await binance.getTopTrendingCoins(30).catch(() => [
                'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT',
                'AVAXUSDT','DOTUSDT','LINKUSDT','MATICUSDT','ATOMUSDT','NEARUSDT',
                'LTCUSDT','DOGEUSDT','UNIUSDT','INJUSDT','APTUSDT','ARBUSDT',
                'OPUSDT','SUIUSDT','TIAUSDT','SEIUSDT','STXUSDT','RUNEUSDT',
                'RENDERUSDT','FETUSDT','WLDUSDT','JUPUSDT','PYTHUSDT','ORDIUSDT',
            ]);
        const coins = allCoins.filter(c => !STABLES.has(c));

        const fallSent = { totalBias:'0', overallSentiment:'NEUTRAL', tradingBias:'Neutral', fngEmoji:'⚪', fngValue:'N/A', btcDominance:'N/A', newsSentimentScore:0 };
        const sent = await withTimeout(binance.getMarketSentiment().catch(() => fallSent), 8000, fallSent);
        const sentBias = parseFloat(sent.totalBias) || 0;

        const results = [];
        const scanLimit = Math.min(coins.length, 30);

        for (let i = 0; i < scanLimit; i++) {
            try {
                const a = await analyzer.run14FactorAnalysis(coins[i], '15m');
                if (a.score < 20) continue;
                const sentBonus =
                    (a.direction === 'LONG'  && sentBias >= 1)  ?  1 :
                    (a.direction === 'SHORT' && sentBias <= -1) ?  1 :
                    (a.direction === 'LONG'  && sentBias <= -1) ? -1 :
                    (a.direction === 'SHORT' && sentBias >= 1)  ? -1 : 0;
                const adjustedScore = a.score + sentBonus;
                const confScore = a.confScore || 0;
                const confGate  = a.confGate  || false;
                const coreConf  = [
                    a.choch          && a.choch.includes(a.direction === 'LONG' ? 'Bullish' : 'Bearish'),
                    a.liquiditySweep && a.liquiditySweep.includes(a.direction === 'LONG' ? 'Bullish' : 'Bearish'),
                    a.choch5m        && a.choch5m.includes(a.direction === 'LONG' ? 'Bullish' : 'Bearish'),
                    a.sweep5m        && a.sweep5m.includes(a.direction === 'LONG' ? 'Bullish' : 'Bearish'),
                ].filter(Boolean).length;
                // ── User threshold gate ──────────────────────────────────────────
                if (adjustedScore < userMinScore) continue;
                // ── RRR check — minimum 1:1.5 ────────────────────────────────────
                const entry = parseFloat(a.entryPrice)||0, sl = parseFloat(a.sl)||0, tp2 = parseFloat(a.tp2)||0;
                const riskDist = Math.abs(entry-sl), rewardDist = Math.abs(tp2-entry);
                const rrr = riskDist > 0 ? rewardDist/riskDist : 0;
                if (rrr < 1.5 && rrr > 0) continue; // below minimum RRR
                // ── Confirmation gate ─────────────────────────────────────────────
                const qualityPass =
                    adjustedScore >= 30 ? (confScore >= 1 || coreConf >= 1) :
                    adjustedScore >= userMinScore ? (confGate || coreConf >= 1) : false;
                if (!qualityPass) continue;
                const f = calcFutures(a);
                results.push({
                    coin:        coins[i].replace('USDT',''),
                    direction:   a.direction, score: adjustedScore,
                    entryPrice:  a.entryPrice, sl: a.sl, tp1: a.tp1, tp2: a.tp2, tp3: a.tp3,
                    leverage:    f.leverage, rrr: f.rrr,
                    reasons:     a.reasons,
                    fundingRate: a.fundingRate ?? null,
                    dailyAligned: a.dailyAligned,
                });
            } catch(_) { continue; }
        }
        results.sort((a,b) => b.score - a.score);
        res.json({ ok:true, setups: results.slice(0,5), scanned: Math.min(coins.length,30), userMinScore });
    } catch(e) { console.error('[Market Scan]', e.message); res.status(500).json({ok:false,error:e.message}); }
});

// ─── Deep Single-Coin Scan ───────────────────────────────────────────────
app.post('/app/api/scan', saasAuth.requireUserAuth, async (req, res) => {
    try {
        let { coin='', timeframe='15m' } = req.body;
        coin = cleanCoin(coin);
        if (!coin || coin==='USDT') return res.status(400).json({ok:false,error:'Coin required'});
        if (STABLES.has(coin)) return res.status(400).json({ok:false,error:'Stablecoin not supported'});
        if (!VALID_TF.includes(timeframe)) timeframe = '15m';

        const analyzer      = require('../lib/analyzer');
        const binance       = require('../lib/binance');
        const confirmations = require('../lib/confirmations_lib');

        const masterTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Analysis timeout')), 30000));
        const fallSent = { fngValue:'N/A', fngEmoji:'⚪', overallSentiment:'NEUTRAL', tradingBias:'Neutral', btcDominance:'N/A', newsSentimentScore:0 };

        const analysis = await Promise.race([
            (async () => {
                const a = await withTimeout(analyzer.run14FactorAnalysis(coin, timeframe), 25000, null);
                if (!a) throw new Error('Analysis timeout');
                const f = calcFutures(a);
                const fallWalls = { supportWall:'N/A', resistWall:'N/A', supportVol:'N/A', resistVol:'N/A' };
                const fallLiq   = { sentiment:'N/A', liqLevel:'N/A' };
                const [conf, sent, whaleWalls, liqData] = await Promise.all([
                    withTimeout(confirmations.runAllConfirmations(coin, a.direction, null, a), 12000, { totalScore:0, confirmationStrength:'WEAK', verdict:'⚪ NEUTRAL', verdictDetail:'Timeout' }),
                    withTimeout(binance.getMarketSentiment(coin).catch(()=>fallSent), 8000, fallSent),
                    withTimeout(binance.getLiquidityWalls(coin).catch(()=>fallWalls), 8000, fallWalls),
                    withTimeout(binance.getLiquidationData(coin).catch(()=>fallLiq), 8000, fallLiq),
                ]);
                let aiSummary = null;
                // Resolve GROQ key: user key > system key
                let groqKey = config.GROQ_API || '';
                try {
                    const fu = await db.getSaasUserById(req.saasUser.userId);
                    if (fu?.encGroqApiKey) { const {decryptApiKey} = require('../lib/saas-auth'); groqKey = decryptApiKey(fu.encGroqApiKey); }
                } catch(_) {}
                if (groqKey) {
                    try {
                        const prompt = `Apex-MD crypto analysis for ${coin} on ${timeframe}. Score:${a.score}/${a.maxScore||100}. Direction:${a.direction}. Entry:${a.entryPrice} TP2:${a.tp2} SL:${a.sl} RRR:${f.rrr}:1. Leverage:${f.leverage}x. 4H:${a.trend4H} 1H:${a.trend1H}. FnG:${sent.fngValue}. Sentiment:${sent.overallSentiment}. Confirmations:${conf.confirmationStrength}. Confluences:${a.reasons}. Reply ONLY with JSON: {"summary":"2-3 sentences","risk":"low|medium|high","confidence":"0-100%","keyLevel":"price level to watch"}`;
                        const gr = await withTimeout(axios.post('https://api.groq.com/openai/v1/chat/completions',
                            { model:'llama-3.3-70b-versatile', messages:[{role:'user',content:prompt}], max_tokens:180, temperature:0.3 },
                            { headers:{Authorization:`Bearer ${groqKey}`}, timeout:22000 }), 23000, null);
                        if (gr?.data?.choices?.[0]?.message?.content) {
                            let raw = gr.data.choices[0].message.content.replace(/```json|```/g,'').trim();
                            aiSummary = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}')+1));
                        }
                    } catch(_) {}
                }
                return { a, f, conf, sent, aiSummary, whaleWalls, liqData };
            })(),
            masterTimeout
        ]);

        const { a, f, conf, sent, aiSummary, whaleWalls, liqData } = analysis;
        res.json({ ok:true, analysis:{
            coin: coin.replace('USDT',''), timeframe, direction: a.direction,
            score: a.score, maxScore: a.maxScore||100,
            currentPrice: a.currentPrice, priceStr: a.priceStr,
            entryPrice: a.entryPrice, sl: a.sl, tp1: a.tp1, tp2: a.tp2, tp3: a.tp3,
            leverage: f.leverage, rrr: f.rrr, dca1: f.dca1, dca2: f.dca2,
            slLabel: a.slLabel, orderType: a.orderType||'MARKET',
            trend4H: a.trend4H, trend1H: a.trend1H,
            rsi: a.rsi, macd: a.macd, adx: a.adx, bb: a.bb, atr: a.atr,
            choch: a.choch, liquiditySweep: a.liquiditySweep,
            fundingRate: a.fundingRate ?? null,
            dailyAligned: a.dailyAligned,
            dailyTrend: a.dailyTrend,
            reasons: a.reasons,
            confirmation: { strength: conf.confirmationStrength, verdict: conf.verdict, detail: conf.verdictDetail,
                usdtDom: conf.usdtDom?.signal||'N/A', oiChange: conf.oiChange?.signal||'N/A',
                cvd: conf.cvd?.signal||'N/A', btcCorr: conf.btcCorr?.signal||'N/A',
                pcr: conf.pcr?.signal||'N/A', netflow: conf.netflow?.signal||'N/A', totalScore: conf.totalScore||0 },
            sentiment: { fng: sent.fngValue, fngEmoji: sent.fngEmoji, overall: sent.overallSentiment, bias: sent.tradingBias, btcDom: sent.btcDominance,
                newsSentimentScore: sent.newsSentimentScore, coinNewsHits: sent.coinNewsHits },
            whaleWalls: { supportWall: whaleWalls.supportWall, resistWall: whaleWalls.resistWall,
                supportVol: whaleWalls.supportVol, resistVol: whaleWalls.resistVol },
            liquidation: { sentiment: liqData.sentiment, liqLevel: liqData.liqLevel },
            // Advanced fields — all from analyzer
            mainTrend: a.mainTrend, marketState: a.marketState, isTrueChoppy: a.isTrueChoppy,
            stochRSI: a.stochRSI, bbands: a.bbands, mtfOB: a.mtfOB, emaRibbon: a.emaRibbon,
            volNodes: a.volNodes, session: a.session, candleConf: a.candleConf,
            keyLevels: a.keyLevels, fvgData: a.fvgData, supertrend: a.supertrend,
            rvol: a.rvol, mtfMACD: a.mtfMACD, mtfRSI: a.mtfRSI,
            wyckoff: a.wyckoff, breakers: a.breakers, equalHL: a.equalHL,
            pdZone: a.pdZone, ichimoku: a.ichimoku, heikinAshi: a.heikinAshi,
            cvd: a.cvd, williamsR: a.williamsR, pivotSignal: a.pivotSignal, fibConf: a.fibConf,
            bbSqueeze: a.bbSqueeze, volExpansion: a.volExpansion, mmTrap: a.mmTrap,
            tf3Align: a.tf3Align, weeklyTgts: a.weeklyTgts, cmeGap: a.cmeGap,
            gannAngles: a.gannAngles, renko: a.renko, dynamicSR: a.dynamicSR,
            bos: a.bos, advCandles: a.advCandles, fibLevels: a.fibLevels,
            mfi: a.mfi, roc: a.roc, cci: a.cci, momentumShift: a.momentumShift,
            mtfOBsExtra: a.mtfOBsExtra, entryValidation: a.entryValidation,
            tradeCategory: a.tradeCategory, refinementNote: a.refinementNote,
            ob5m: a.ob5m, choch5m: a.choch5m, sweep5m: a.sweep5m, trend5m: a.trend5m,
            ob4H: a.ob4H, ob1H: a.ob1H, choch15m: a.choch15m, sweep15m: a.sweep15m,
            harmonicPattern: a.harmonicPattern, ictSilverBullet: a.ictSilverBullet,
            tp1Label: a.tp1Label, tp2Label: a.tp2Label, tp3Label: a.tp3Label,
            vwap: a.vwap, confScore: a.confScore, confGate: a.confGate,
            future: a.future ? { prediction: a.future.prediction, confidence: a.future.confidence,
                targetPrice: a.future.targetPrice, modifier: a.future.modifier,
                label: a.future.label, available: a.future.available } : null,
            ai: aiSummary,
        }});
    } catch(e) { console.error('[Scan API]', e.message); res.status(500).json({ok:false,error:e.message}); }
});

// ─── Backtest ────────────────────────────────────────────────────────────
app.post('/app/api/backtest', saasAuth.requireUserAuth, async (req, res) => {
    try {
        let { coin='', timeframe='15m', days=30 } = req.body;
        coin = cleanCoin(coin);
        if (!coin||coin==='USDT') return res.status(400).json({ok:false,error:'Coin required'});
        if (!VALID_TF.includes(timeframe)) timeframe='15m';
        days = Math.max(5, Math.min(parseInt(days)||30, 90));
        const backtest = require('../plugins/backtest');
        if (typeof backtest.runBacktest !== 'function') return res.status(500).json({ok:false,error:'Backtest module not available'});
        const result = await withTimeout(backtest.runBacktest(coin, timeframe, days), 55000, null);
        if (!result) return res.status(500).json({ok:false,error:'Backtest timeout'});
        res.json({ok:true, result});
    } catch(e) { console.error('[Backtest API]', e.message); res.status(500).json({ok:false,error:e.message}); }
});

// ─── ScanBacktest ────────────────────────────────────────────────────────
app.post('/app/api/scanbacktest', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const backtest = require('../plugins/backtest');
        if (typeof backtest.runScanBacktest !== 'function') return res.status(500).json({ok:false,error:'ScanBacktest not available'});
        const result = await withTimeout(backtest.runScanBacktest(), 110000, null);
        if (!result) return res.status(500).json({ok:false,error:'ScanBacktest timeout'});
        res.json({ok:true, result});
    } catch(e) { console.error('[ScanBacktest API]', e.message); res.status(500).json({ok:false,error:e.message}); }
});

// ─── Grid API ────────────────────────────────────────────────────────────
app.post('/app/api/grid', saasAuth.requireUserAuth, async (req, res) => {
    try {
        let { coin='', timeframe='15m' } = req.body;
        coin = cleanCoin(coin);
        if (!coin||coin==='USDT') return res.status(400).json({ok:false,error:'Coin required'});
        if (STABLES.has(coin)) return res.status(400).json({ok:false,error:'Stablecoin'});
        if (!VALID_TF.includes(timeframe)) timeframe='15m';
        const binance    = require('../lib/binance');
        const indicators = require('../lib/indicators');
        const candles = await binance.getKlineData(coin, timeframe, 100);
        if (!candles||candles.length<50) return res.status(500).json({ok:false,error:'Insufficient candle data'});
        const cp  = parseFloat(candles[candles.length-1][4]);
        const adx = indicators.calculateADX(candles.slice(-50));
        const atr = parseFloat(indicators.calculateATR(candles.slice(-50), 14));
        const highs = candles.slice(-50).map(c=>parseFloat(c[2]));
        const lows  = candles.slice(-50).map(c=>parseFloat(c[3]));
        const resistance = Math.max(...highs), support = Math.min(...lows);
        const step = (resistance - support) / 5;
        const gridLevels = Array.from({length:6}, (_,i) => (support+step*i).toFixed(4));
        const isTrending = adx.isStrong || (adx.value||0) > 25;
        res.json({ok:true, result:{
            coin: coin.replace('USDT',''), timeframe, currentPrice: cp,
            adx: adx.value, adxStatus: adx.status||'', isTrending,
            resistance: resistance.toFixed(4), support: support.toFixed(4),
            gridLevels, gridStep: step.toFixed(4), atr: atr.toFixed(4),
            dcaZone1: (support+step*0.5).toFixed(4), dcaZone2: support.toFixed(4),
            warning: isTrending ? 'ADX '+(adx.value||0).toFixed(1)+' — Market is TRENDING. Grid trading risky!' : null,
            advice: isTrending ? 'Avoid grid in trending markets — use Deep Scanner instead.' : 'Choppy/sideways market detected. Grid strategy is suitable.',
        }});
    } catch(e) { console.error('[Grid API]', e.message); res.status(500).json({ok:false,error:e.message}); }
});

// ─── Coin Compare API ───────────────────────────────────────────────────
app.post('/app/api/compare', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const analyzer = require('../lib/analyzer');
        let { coin1='BTC', coin2='ETH', timeframe='15m' } = req.body;
        coin1 = cleanCoin(coin1); coin2 = cleanCoin(coin2);
        if (STABLES.has(coin1)||STABLES.has(coin2)) return res.status(400).json({ok:false,error:'Stablecoins not supported'});
        if (!VALID_TF.includes(timeframe)) timeframe = '15m';
        const [a1, a2] = await Promise.all([
            withTimeout(analyzer.run14FactorAnalysis(coin1, timeframe), 25000, null),
            withTimeout(analyzer.run14FactorAnalysis(coin2, timeframe), 25000, null),
        ]);
        const safeStr = v => (v && typeof v === 'string') ? v : (v ? String(v) : '—');
        const fmtCoin = (a, coinStr) => a ? {
            coin:        coinStr.replace('USDT',''),
            direction:   a.direction || '—',
            score:       a.score || 0,
            entryPrice:  a.entryPrice,
            tp1: a.tp1, tp2: a.tp2, sl: a.sl,
            trend4H:     safeStr(a.trend4H),
            trend1H:     safeStr(a.trend1H),
            dailyTrend:  safeStr(a.dailyTrend),
            rsi:         a.rsi ? parseFloat(a.rsi).toFixed(1) : '—',
            adx:         a.adxData?.value ? parseFloat(a.adxData.value).toFixed(1) : '—',
            fundingRate: a.fundingRate ?? null,
            dailyAligned: a.dailyAligned,
            reasons:     a.reasons,
            rrr:         calcFutures(a).rrr,
        } : null;
        res.json({ok:true,
            coin1: fmtCoin(a1, coin1),
            coin2: fmtCoin(a2, coin2),
        });
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// ─── Funding Rates API ───────────────────────────────────────────────────
app.get('/app/api/funding', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const COINS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT','MATICUSDT','ATOMUSDT','NEARUSDT','LTCUSDT','DOGEUSDT','UNIUSDT','INJUSDT','APTUSDT','ARBUSDT','OPUSDT','SUIUSDT','TIAUSDT','FETUSDT','RENDERUSDT','WLDUSDT','RUNEUSDT'];
        const data = await withTimeout(axios.get('https://fapi.binance.com/fapi/v1/premiumIndex',{timeout:8000}).then(r=>r.data), 10000, null);
        if (!data) return res.status(500).json({ok:false,error:'Binance unavailable'});
        const results = COINS.map(sym => {
            const d = data.find(x=>x.symbol===sym);
            if (!d) return null;
            const rate = parseFloat(d.lastFundingRate)*100;
            const tier = Math.abs(rate)>=0.1?'extreme':Math.abs(rate)>=0.05?'elevated':'normal';
            return { symbol:sym, name:sym.replace('USDT',''), rate:parseFloat(rate.toFixed(4)), tier, dir:rate>0?'SHORT':'LONG', emoji:rate>0.1?'🔴':rate<-0.1?'🟢':rate>0.05?'🟡':rate<-0.05?'🟡':'⚪', label:rate>0.1?'Longs overloaded → SHORT squeeze!':rate<-0.1?'Shorts overloaded → LONG squeeze!':'Normal range' };
        }).filter(Boolean).sort((a,b)=>Math.abs(b.rate)-Math.abs(a.rate));
        res.json({ok:true, rates:results, ts:Date.now()});
    } catch(e) { console.error('[Funding API]', e.message); res.status(500).json({ok:false,error:e.message}); }
});

// ─── Spot Analysis API ───────────────────────────────────────────────────
app.post('/app/api/spot', saasAuth.requireUserAuth, async (req, res) => {
    try {
        let { coin='', timeframe='1d' } = req.body;
        coin = cleanCoin(coin);
        if (!coin||coin==='USDT') return res.status(400).json({ok:false,error:'Coin required'});
        if (STABLES.has(coin)) return res.status(400).json({ok:false,error:'Stablecoin'});
        if (!VALID_TF.includes(timeframe)) timeframe='1d';
        const analyzer      = require('../lib/analyzer');
        const binance       = require('../lib/binance');
        const confirmations = require('../lib/confirmations_lib');
        const aData = await analyzer.run14FactorAnalysis(coin, timeframe);
        const mSMC  = aData.marketSMC || {};
        const tp1 = mSMC.resistance ? parseFloat(mSMC.resistance).toFixed(6) : aData.tp1;
        const tp2 = mSMC.ext1618    ? parseFloat(mSMC.ext1618).toFixed(6)    : aData.tp2;
        const tp3 = mSMC.ext2618    ? parseFloat(mSMC.ext2618).toFixed(6)    : aData.tp3;
        const entry=parseFloat(aData.entryPrice)||0, sl=parseFloat(aData.sl)||0, tp2n=parseFloat(tp2)||0;
        const risk=Math.abs(entry-sl), rrr=risk>0?(Math.abs(tp2n-entry)/risk).toFixed(2):'0';
        const fallSent={fngValue:'N/A',fngEmoji:'⚪',overallSentiment:'NEUTRAL',tradingBias:'Neutral',btcDominance:'N/A',newsSentimentScore:0};
        const [entryConf, sentiment] = await Promise.all([
            withTimeout(confirmations.runAllConfirmations(coin,'LONG',null,aData),18000,{totalScore:0,confirmationStrength:'WEAK',verdict:'⚪ NEUTRAL',verdictDetail:'Timeout'}),
            withTimeout(binance.getMarketSentiment(coin).catch(()=>fallSent),8000,fallSent),
        ]);
        let aiResult = null;
        if (config.GROQ_API) {
            try {
                const prompt = `Analyze ${coin} SPOT trade. Score:${aData.score}/${aData.maxScore}. Dir:${aData.direction}. Entry:${entry} SL:${sl} RRR:${rrr}. 4H:${aData.trend4H} 1H:${aData.trend1H}. F&G:${sentiment.fngValue}. Confluences:${aData.reasons}. Return ONLY JSON: {"confidence":"65%","trend":"short text","smc_summary":"short text","spot_advice":"short text"}`;
                const gr = await withTimeout(axios.post('https://api.groq.com/openai/v1/chat/completions',
                    {model:'llama-3.3-70b-versatile',messages:[{role:'user',content:prompt}],max_tokens:200,temperature:0.3},
                    {headers:{Authorization:`Bearer ${config.GROQ_API}`},timeout:22000}),23000,null);
                if (gr?.data?.choices?.[0]?.message?.content) {
                    let raw=gr.data.choices[0].message.content.replace(/```json|```/g,'').trim();
                    aiResult=JSON.parse(raw.slice(raw.indexOf('{'),raw.lastIndexOf('}')+1));
                }
            } catch(_) {}
        }
        res.json({ok:true, analysis:{
            coin:coin.replace('USDT',''), direction:aData.direction, score:aData.score, maxScore:aData.maxScore||100,
            currentPrice:aData.currentPrice, priceStr:aData.priceStr, entryPrice:entry, sl, tp1, tp2, tp3, rrr,
            dca1:(entry-risk*0.35).toFixed(6), dca2:(entry-risk*0.70).toFixed(6),
            reasons:aData.reasons,
            confirmation:{strength:entryConf.confirmationStrength,verdict:entryConf.verdict,detail:entryConf.verdictDetail},
            sentiment:{fng:sentiment.fngValue,fngEmoji:sentiment.fngEmoji,overall:sentiment.overallSentiment,bias:sentiment.tradingBias,btcDom:sentiment.btcDominance},
            ai:aiResult,
        }});
    } catch(e){ console.error('[Spot API]',e.message); res.status(500).json({ok:false,error:e.message}); }
});

}; // end registerScanner
