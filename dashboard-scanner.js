'use strict';
/**
 * APEX-MD · dashboard-scanner.js
 * ══════════════════════════════════════════════════════════════
 *  Routes:
 *    GET  /app/scanner              → Full scanner page (UI)
 *    GET  /app/api/market-scan      → Auto market scanner (top 5)
 *    POST /app/api/scan             → Single coin deep analysis (.future parity)
 *    POST /app/api/backtest         → Historical backtest (single coin)
 *    POST /app/api/scanbacktest     → Multi-coin scanbacktest (.scanbacktest parity)
 * ══════════════════════════════════════════════════════════════
 */

module.exports = function registerScanner({ saasAuth, db, config, axios, _html, _appNav, fmtPrice, scoreColor }, app) {

// ─── Shared helpers ────────────────────────────────────────────────────
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

function vwapDisplay(vwapRaw) {
    if (!vwapRaw) return '—';
    const m = String(vwapRaw).match(/\$([0-9.]+)/);
    if (!m) return String(vwapRaw);
    const p = parseFloat(m[1]);
    const sign = vwapRaw.includes('🟢') ? '▲ Above' : '▼ Below';
    return `${sign} VWAP ${fmtPrice(p)}`;
}

// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
//  1. GLOBAL MARKET SCANNER  GET /app/api/market-scan
//     100% parity with WhatsApp .scan — same scoring, quality gate,
//     sentiment overlay, SMC tags, all signal fields
// ══════════════════════════════════════════════════════════════
app.get('/app/api/market-scan', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const binance  = require('./lib/binance');
        const analyzer = require('./lib/analyzer');

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

        // Market sentiment — fetched once for all coins
        const fallSent = {
            totalBias:'0', overallSentiment:'NEUTRAL', tradingBias:'Neutral',
            fngEmoji:'\u26aa', fngValue:'N/A', btcDominance:'N/A', newsSentimentScore:0,
        };
        const sent = await withTimeout(
            binance.getMarketSentiment().catch(() => fallSent), 8000, fallSent
        );
        const sentBias = parseFloat(sent.totalBias) || 0;

        const results = [];
        const scanLimit = Math.min(coins.length, 30);

        for (let i = 0; i < scanLimit; i++) {
            try {
                const a = await analyzer.run14FactorAnalysis(coins[i], '15m');
                if (a.score < 20) continue;

                // ── Sentiment bonus (identical to scanner.js) ────────────
                const sentBonus =
                    (a.direction === 'LONG'  && sentBias >= 1)  ?  1 :
                    (a.direction === 'SHORT' && sentBias <= -1) ?  1 :
                    (a.direction === 'LONG'  && sentBias <= -1) ? -1 :
                    (a.direction === 'SHORT' && sentBias >= 1)  ? -1 : 0;
                const adjustedScore = a.score + sentBonus;

                // ── Quality gate (identical to scanner.js getTopDownSetups) ─
                const confScore = a.confScore || 0;
                const confGate  = a.confGate  || false;
                const coreConf  = [
                    a.choch          && a.choch.includes(a.direction === 'LONG' ? 'Bullish' : 'Bearish'),
                    a.liquiditySweep && a.liquiditySweep.includes(a.direction === 'LONG' ? 'Bullish' : 'Bearish'),
                    a.choch5m        && a.choch5m.includes(a.direction === 'LONG' ? 'Bullish' : 'Bearish'),
                    a.sweep5m        && a.sweep5m.includes(a.direction === 'LONG' ? 'Bullish' : 'Bearish'),
                ].filter(Boolean).length;

                const qualityPass =
                    adjustedScore >= 30 ? (confScore >= 1 || coreConf >= 1) :
                    adjustedScore >= 20 ? (confGate  || coreConf >= 1) : false;
                if (!qualityPass) continue;

                const f = calcFutures(a);
                results.push({
                    coin:          coins[i].replace('USDT',''),
                    direction:     a.direction,
                    score:         adjustedScore,
                    maxScore:      a.maxScore || 100,
                    price:         a.priceStr,
                    currentPrice:  a.currentPrice,
                    entryPrice:    a.entryPrice,
                    sl:            a.sl,      slLabel:  a.slLabel,
                    tp1:           a.tp1,     tp1Label: a.tp1Label,
                    tp2:           a.tp2,     tp2Label: a.tp2Label,
                    tp3:           a.tp3,     tp3Label: a.tp3Label,
                    leverage:      f.leverage,
                    rrr:           f.rrr,
                    reasons:       a.reasons,
                    adx:           a.adxData && a.adxData.value,
                    adxStatus:     a.adxData && a.adxData.status,
                    rsi:           a.rsi,
                    // SMC signal tags — identical to .scan WhatsApp output
                    liquiditySweep: a.liquiditySweep || 'None',
                    choch:          a.choch           || 'None',
                    choch5m:        a.choch5m         || 'None',
                    sweep5m:        a.sweep5m         || 'None',
                    // Market context
                    marketState:    a.marketState,
                    mainTrend:      a.mainTrend,
                    trend4H:        a.trend4H,
                    trend1H:        a.trend1H,
                    dailyTrend:     a.dailyTrend  || '',
                    dailyAligned:   a.dailyAligned,
                    session:        a.session && a.session.session,
                    sessionQuality: a.session && a.session.quality,
                    // v6/v7 signals
                    bbSqueeze:      a.bbSqueeze   || null,
                    volExpansion:   a.volExpansion || null,
                    mmTrap:         a.mmTrap       || null,
                    tf3Align:       a.tf3Align     || null,
                    // Order / category
                    orderType:      a.orderSuggestion && a.orderSuggestion.type || 'MARKET',
                    tradeCategory:  a.tradeCategory ? a.tradeCategory.label : null,
                    // Confirmations
                    confScore, confGate, coreConf,
                    // Sentiment
                    sentEmoji: sentBonus > 0 ? '\ud83d\udcf0\u2705' : sentBonus < 0 ? '\ud83d\udcf0\u26a0\ufe0f' : '',
                });
            } catch(_) {}
        }

        results.sort((a, b) => b.score - a.score);
        res.json({
            ok: true,
            setups: results.slice(0, 5),
            scanned: scanLimit,
            ts: Date.now(),
            sentiment: {
                overall:    sent.overallSentiment,
                fngEmoji:   sent.fngEmoji,
                fngValue:   sent.fngValue,
                btcDom:     sent.btcDominance,
                newsScore:  sent.newsSentimentScore,
                tradingBias:sent.tradingBias,
            },
        });
    } catch(e) {
        console.error('[Market Scan]', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

//  2. SINGLE COIN DEEP ANALYSIS  POST /app/api/scan
//     Full parity with .future command (funding, whale, sentiment,
//     11-factor confirmation engine, GROQ AI)
// ══════════════════════════════════════════════════════════════
app.post('/app/api/scan', saasAuth.requireUserAuth, async (req, res) => {
    try {
        let { coin='', timeframe='15m' } = req.body;
        coin = cleanCoin(coin);
        if (!coin || coin === 'USDT') return res.status(400).json({ok:false,error:'Coin symbol required'});
        if (STABLES.has(coin)) return res.status(400).json({ok:false,error:coin.replace('USDT','') + ' is a stablecoin.'});
        if (!VALID_TF.includes(timeframe)) timeframe = '15m';
        console.log(`[Scanner] ${req.saasUser.username} → ${coin} ${timeframe}`);

        const analyzer      = require('./lib/analyzer');
        const binance       = require('./lib/binance');
        const confirmations = require('./lib/confirmations_lib');

        // ── Core analysis ─────────────────────────────────────────────
        const a = await analyzer.run14FactorAnalysis(coin, timeframe);
        const { currentCandles: _c, ...analysis } = a;

        // ── External data (parallel, all with timeouts) ───────────────
        const fallbackSent = {
            fngValue:50,fngLabel:'Neutral',fngEmoji:'⚪',btcDominance:'—',
            newsSentimentScore:0,coinNewsHits:0,newsHeadlines:[],
            overallSentiment:'⚪ NEUTRAL',tradingBias:'Neutral',totalBias:'0',
            summary:'Market data unavailable'
        };
        const [liqData, whaleWalls, fundingRate, sentiment] = await Promise.all([
            withTimeout(binance.getLiquidationData(coin),  12000, {sentiment:'N/A',liqLevel:'N/A'}),
            withTimeout(binance.getLiquidityWalls(coin),   12000, {supportWall:'N/A',resistWall:'N/A',supportVol:'N/A',resistVol:'N/A'}),
            withTimeout(binance.getFundingRate(coin),       8000, 'N/A'),
            withTimeout(binance.getMarketSentiment(coin),  12000, fallbackSent),
        ]);

        // ── 11-Factor Confirmation Engine (20s timeout) ───────────────
        const confFallback = {
            totalScore:0, confirmationStrength:'WEAK',
            display:'⚪ Confirmation data unavailable',
            verdict:'⚪ NEUTRAL', verdictDetail:'Timeout',
            usdtDom:{signal:'N/A',emoji:'⚪',display:'N/A'},
            oiChange:{signal:'N/A',emoji:'⚪',display:'N/A'},
            cvd:{signal:'N/A',emoji:'⚪',display:'N/A'},
            lsRatio:{signal:'N/A',emoji:'⚪',display:'N/A'},
            fundingMomentum:{signal:'N/A',emoji:'⚪',display:'N/A'},
            orderBook:{signal:'N/A',emoji:'⚪',display:'N/A'},
            whaleActivity:{signal:'N/A',emoji:'⚪',display:'N/A'},
            btcCorr:{signal:'N/A',emoji:'⚪',display:'N/A'},
            htfLevels:{signal:'N/A',emoji:'⚪',display:'N/A'},
            pcr:{signal:'N/A',emoji:'⚪',display:'N/A'},
            netflow:{signal:'N/A',emoji:'⚪',display:'N/A'},
            social:{signal:'N/A',emoji:'⚪',display:'N/A'},
        };
        const entryConf = await withTimeout(
            confirmations.runAllConfirmations(coin, a.direction, config.LUNAR_API||null, a),
            20000, confFallback
        );

        // ── GROQ AI (optional, 25s timeout) ──────────────────────────
        const entryNum = parseFloat(a.entryPrice)||0;
        const slNum    = parseFloat(a.sl)||0;
        const tp2Num   = parseFloat(a.tp2)||0;
        const risk     = Math.abs(entryNum - slNum);
        const rrrStr   = risk > 0 ? (Math.abs(tp2Num - entryNum) / risk).toFixed(2) : '0';

        let aiResult = null;
        if (config.GROQ_API) {
            try {
                const prompt = `Analyze ${coin} trade. Score:${a.score}/${a.maxScore}. Direction:${a.direction}. ` +
                    `Confluences:${a.reasons}. MTF:4H=${a.trend4H} 1H=${a.trend1H}. F&G:${sentiment.fngValue}. ` +
                    `Sentiment:${sentiment.overallSentiment}. Funding:${fundingRate}. ` +
                    `Return ONLY JSON: {"confidence":"65%","trend":"short sinhala text","smc_summary":"short text","sentiment_note":"short text"}`;
                const gr = await withTimeout(
                    axios.post('https://api.groq.com/openai/v1/chat/completions', {
                        model:'llama-3.3-70b-versatile',
                        messages:[{role:'user',content:prompt}],
                        max_tokens:200, temperature:0.3
                    }, { headers:{ Authorization:`Bearer ${config.GROQ_API}` }, timeout:25000 }),
                    26000, null
                );
                if (gr?.data?.choices?.[0]?.message?.content) {
                    let raw = gr.data.choices[0].message.content.replace(/```json|```/g,'').trim();
                    const j = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}')+1);
                    aiResult = JSON.parse(j);
                }
            } catch(_) {}
        }

        // ── Futures enrichment ────────────────────────────────────────
        const fut = calcFutures(a);

        // ── Build response ────────────────────────────────────────────
        const sentBoost = parseFloat(sentiment.totalBias||0) > 1 ? '✅ CONFIRMED'
            : parseFloat(sentiment.totalBias||0) < -1 ? '⛔ CONFLICTING' : '⚠️ NEUTRAL';

        res.json({
            ok: true,
            analysis: {
                ...analysis,
                futures: fut,
                vwapDisplay: vwapDisplay(a.vwap),
                // External market data
                fundingRate,
                whaleWalls,
                liqData,
                sentiment: {
                    fngValue:   sentiment.fngValue,
                    fngLabel:   sentiment.fngLabel,
                    fngEmoji:   sentiment.fngEmoji,
                    btcDom:     sentiment.btcDominance,
                    newsScore:  sentiment.newsSentimentScore,
                    overall:    sentiment.overallSentiment,
                    tradingBias: sentiment.tradingBias,
                    totalBias:  sentiment.totalBias,
                    headlines:  (sentiment.newsHeadlines||[]).slice(0,3),
                    boost:      sentBoost,
                },
                // 11-Factor Confirmation Engine
                entryConf: {
                    totalScore:   entryConf.totalScore,
                    strength:     entryConf.confirmationStrength,
                    verdict:      entryConf.verdict,
                    verdictDetail:entryConf.verdictDetail,
                    display:      entryConf.display,
                    factors: {
                        usdtDom:       entryConf.usdtDom,
                        oiChange:      entryConf.oiChange,
                        cvd:           entryConf.cvd,
                        lsRatio:       entryConf.lsRatio,
                        fundingM:      entryConf.fundingMomentum,
                        orderBook:     entryConf.orderBook,
                        whaleActivity: entryConf.whaleActivity,
                        btcCorr:       entryConf.btcCorr,
                        htfLevels:     entryConf.htfLevels,
                        pcr:           entryConf.pcr,
                        netflow:       entryConf.netflow,
                        social:        entryConf.social,
                    },
                },
                // AI
                ai: aiResult || {
                    confidence: `${Math.min(95, Math.round(40 + a.score * 0.5))}%`,
                    trend: a.mainTrend + ' | ' + a.marketState,
                    smc_summary: 'Technical data only (AI unavailable)',
                    sentiment_note: sentiment.tradingBias||'Neutral',
                },
                rrr: rrrStr,
            },
        });
    } catch(e) {
        console.error('[Scanner API]', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  3. HISTORICAL BACKTEST  POST /app/api/backtest
// ══════════════════════════════════════════════════════════════
app.post('/app/api/backtest', saasAuth.requireUserAuth, async (req, res) => {
    try {
        let { coin='', timeframe='15m' } = req.body;
        coin = cleanCoin(coin);
        if (!coin || coin === 'USDT') return res.status(400).json({ok:false,error:'Coin symbol required'});
        if (STABLES.has(coin)) return res.status(400).json({ok:false,error:'Stablecoin — no signals.'});
        if (!VALID_TF.includes(timeframe)) timeframe = '15m';
        console.log(`[Backtest] ${req.saasUser.username} → ${coin} ${timeframe}`);

        const binance    = require('./lib/binance');
        const indicators = require('./lib/indicators');
        const smc        = require('./lib/smartmoney');
        const { calculateRSI,calculateEMA,calculateATR,checkDivergence,checkCandlePattern,calculateMACD,calculateVWAP,checkVolumeBreakout,calculateADX,checkHarmonicPattern,checkICTSilverBullet,calculateStochRSI,calculateBollingerBands,detectMTFOrderBlocks,detectMTFOBs,checkMTFRSIConfluence,detectVolumeNodes,getEMARibbon,calculateSupertrend,calculateRVOL,checkMTFMACD,detectWyckoffPhase,detectBreakerBlocks,detectEqualHighsLows,checkPremiumDiscount,calculateWilliamsR,calculateIchimoku,getHeikinAshiTrend,approximateCVD,calculatePivotPoints,getPivotSignal,checkFibConfluence,detectBBSqueezeExplosion,detectVolatilityExpansion,detectMarketMakerTrap } = indicators;

        let candles, candles1H;
        try {
            [candles, candles1H] = await Promise.all([
                binance.getKlineData(coin, timeframe, 1000),
                binance.getKlineData(coin, '1h', 250).catch(() => null),
            ]);
        } catch(e) { return res.status(500).json({ok:false,error:'Failed to fetch candles: '+e.message}); }
        if (!candles||candles.length<300) return res.status(400).json({ok:false,error:'Insufficient data — need 300+ candles.'});

        function backtestScore(i) {
            const slice  = candles.slice(Math.max(0,i-100),i);
            const slice1H= candles1H ? candles1H.slice(Math.max(0,Math.floor(i/4)-60),Math.floor(i/4)) : slice;
            if (slice.length<50) return {longScore:0,shortScore:0,atr:0,adx:{value:0}};
            const cp=parseFloat(slice[slice.length-1][4]);
            const ema200=parseFloat(calculateEMA(candles.slice(Math.max(0,i-200),i),200));
            const ema50=parseFloat(calculateEMA(slice,50));
            const rsi=calculateRSI(slice.slice(-50),14);
            const atr=parseFloat(calculateATR(slice.slice(-50),14));
            const adx=calculateADX(slice.slice(-50));
            const macd=calculateMACD(slice.slice(-50));
            const vwap=calculateVWAP(slice);
            const mSMC=smc.analyzeSMC(slice.slice(-50));
            const volBrk=checkVolumeBreakout(slice.slice(-50));
            const harm=checkHarmonicPattern(slice);
            const ict=checkICTSilverBullet(slice.slice(-10));
            const diverg=checkDivergence(slice.slice(-50));
            const patt=checkCandlePattern(slice.slice(-10));
            let stoch={isBull:false,isBear:false},bb={isBull:false,isBear:false,squeeze:false};
            let mtfRSI={isBull:false,isBear:false,signal:''},volN={nearHVN:false};
            let mtfOB={confluenceZone:null},mtfOBe={bullish:null,bearish:null};
            let liqS='None',choch='None';
            let superT={isBull:false,isBear:false,justFlipUp:false,justFlipDown:false};
            let rvol={signal:'NORMAL'},mtfMac={signal:''},emaRib=null;
            try{stoch=calculateStochRSI(slice.slice(-60));}catch(_){}
            try{bb=calculateBollingerBands(slice.slice(-30));}catch(_){}
            try{mtfRSI=checkMTFRSIConfluence(slice.slice(-50),slice1H.slice(-50));}catch(_){}
            try{volN=detectVolumeNodes(slice.slice(-100));}catch(_){}
            try{mtfOB=detectMTFOrderBlocks(slice.slice(-30),slice1H.slice(-20));}catch(_){}
            try{mtfOBe=detectMTFOBs(slice.slice(-15));}catch(_){}
            try{liqS=smc.checkLiquiditySweep(slice.slice(-15));}catch(_){}
            try{choch=smc.checkChoCH(slice.slice(-20));}catch(_){}
            try{superT=calculateSupertrend(slice.slice(-60));}catch(_){}
            try{rvol=calculateRVOL(slice.slice(-30));}catch(_){}
            try{mtfMac=checkMTFMACD(slice.slice(-60),slice1H.slice(-60));}catch(_){}
            try{emaRib=getEMARibbon(slice);}catch(_){}
            let wyckoff={phase:'UNKNOWN'},breakers={bullishBreaker:false,bearishBreaker:false};
            let equalHL={eqh:false,eql:false},pdZone={zone:'EQUILIBRIUM',tradeMatch:false};
            let willR={isBull:false,isBear:false},ichi={signal:'NEUTRAL',inCloud:false};
            let ha={isStrong:false,isBull:false,isBear:false},cvd={bullDiv:false,bearDiv:false,trend:'NEUTRAL'};
            let pivSig={isBull:false,isBear:false},fib={hasConfluence:false};
            try{wyckoff=detectWyckoffPhase(slice.slice(-55));}catch(_){}
            try{breakers=detectBreakerBlocks(slice.slice(-40));}catch(_){}
            try{equalHL=detectEqualHighsLows(slice.slice(-60));}catch(_){}
            try{pdZone=checkPremiumDiscount(slice.slice(-60),cp>ema200?'LONG':'SHORT');}catch(_){}
            try{willR=calculateWilliamsR(slice.slice(-20));}catch(_){}
            try{ichi=calculateIchimoku(slice.slice(-60));}catch(_){}
            try{ha=getHeikinAshiTrend(slice.slice(-15));}catch(_){}
            try{cvd=approximateCVD(slice.slice(-30));}catch(_){}
            try{const piv=calculatePivotPoints(slice.slice(-14));pivSig=getPivotSignal(cp,piv,cp>ema200?'LONG':'SHORT');}catch(_){}
            try{fib=checkFibConfluence(slice.slice(-60),cp>ema200?'LONG':'SHORT');}catch(_){}
            let bbSqz={exploding:false,isSqueezing:false,explosionDir:'NONE'};
            let volExp={expanding:false,justStarted:false},trap={bullTrap:false,bearTrap:false};
            try{bbSqz=detectBBSqueezeExplosion(slice.slice(-60));}catch(_){}
            try{volExp=detectVolatilityExpansion(slice.slice(-70));}catch(_){}
            try{trap=detectMarketMakerTrap(slice.slice(-25));}catch(_){}
            const ema1H_a=parseFloat(calculateEMA(slice.slice(-30),30));
            const ema4H_a=parseFloat(calculateEMA(slice.slice(-60),60));
            let ls=0,ss=0;
            if(cp>ema1H_a&&cp>ema4H_a)ls++;if(cp<ema1H_a&&cp<ema4H_a)ss++;
            if(cp>ema200)ls++;else ss++;
            if(Math.abs(cp-ema50)/ema50<0.005){if(cp>ema200)ls++;else ss++;}
            if(mSMC.bullishOB)ls++;if(mSMC.bearishOB)ss++;
            if(rsi<45)ls++;if(rsi>55)ss++;
            if(vwap.includes('🟢'))ls++;if(vwap.includes('🔴'))ss++;
            if(volBrk.includes('Bullish'))ls++;if(volBrk.includes('Bearish'))ss++;
            if(macd.includes('Bullish'))ls++;if(macd.includes('Bearish'))ss++;
            if(mSMC.sweep?.includes('Bullish')||mSMC.choch?.includes('Bullish'))ls++;
            if(mSMC.sweep?.includes('Bearish')||mSMC.choch?.includes('Bearish'))ss++;
            if(harm.includes('Bullish'))ls+=2;if(harm.includes('Bearish'))ss+=2;
            if(ict.includes('Bullish'))ls++;if(ict.includes('Bearish'))ss++;
            if(diverg.includes('Bullish'))ls++;if(diverg.includes('Bearish'))ss++;
            if(patt.includes('🟢'))ls++;if(patt.includes('🔴'))ss++;
            if(liqS.includes('Bullish'))ls+=2;if(liqS.includes('Bearish'))ss+=2;
            if(choch.includes('Bullish'))ls+=2;if(choch.includes('Bearish'))ss+=2;
            if(mtfOBe.bullish)ls++;if(mtfOBe.bearish)ss++;
            if(stoch.isBull)ls++;if(stoch.isBear)ss++;
            if(bb.isBull)ls++;if(bb.isBear)ss++;
            if(mtfRSI.signal==='STRONG_BULL')ls+=2;if(mtfRSI.signal==='STRONG_BEAR')ss+=2;
            if(mtfRSI.isBull&&mtfRSI.signal!=='STRONG_BULL')ls++;if(mtfRSI.isBear&&mtfRSI.signal!=='STRONG_BEAR')ss++;
            if(mtfOB.confluenceZone?.type==='BULLISH')ls+=2;if(mtfOB.confluenceZone?.type==='BEARISH')ss+=2;
            if(superT.justFlipUp)ls+=2;else if(superT.isBull)ls++;
            if(superT.justFlipDown)ss+=2;else if(superT.isBear)ss++;
            if(emaRib){if(emaRib.signal==='STRONG_BULL')ls+=2;if(emaRib.signal==='STRONG_BEAR')ss+=2;if(emaRib.signal==='BULL_PULLBACK')ls++;if(emaRib.signal==='BEAR_PULLBACK')ss++;}
            if(wyckoff.phase==='SPRING')ls+=3;else if(wyckoff.phase==='MARKUP')ls++;else if(wyckoff.phase==='ACCUMULATION')ls+=0.5;
            if(wyckoff.phase==='UTAD')ss+=3;else if(wyckoff.phase==='MARKDOWN')ss++;else if(wyckoff.phase==='DISTRIBUTION')ss+=0.5;
            if(breakers.bullishBreaker)ls+=2;if(breakers.bearishBreaker)ss+=2;
            if(equalHL.eql)ls++;if(equalHL.eqh)ss++;
            if(pdZone.zone==='OTE'){ls+=2;ss+=2;}else if(pdZone.tradeMatch){if(cp>ema200)ls++;else ss++;}
            if(willR.isBull)ls++;if(willR.isBear)ss++;
            if(ichi.signal==='STRONG_BULL')ls+=2;else if(ichi.signal==='BULL')ls++;
            if(ichi.signal==='STRONG_BEAR')ss+=2;else if(ichi.signal==='BEAR')ss++;
            if(cvd.bullDiv)ls+=2;else if(cvd.trend==='BULL')ls++;
            if(cvd.bearDiv)ss+=2;else if(cvd.trend==='BEAR')ss++;
            if(ha.isStrong&&ha.isBull)ls++;if(ha.isStrong&&ha.isBear)ss++;
            if(pivSig.isBull)ls++;if(pivSig.isBear)ss++;
            if(fib.hasConfluence){if(cp>ema200)ls+=2;else ss+=2;}
            if(bbSqz.exploding&&bbSqz.explosionDir==='BULL')ls+=3;
            if(bbSqz.exploding&&bbSqz.explosionDir==='BEAR')ss+=3;
            if(volExp.justStarted){ls+=3;ss+=3;}else if(volExp.expanding){ls++;ss++;}
            if(trap.bearTrap)ls+=3;if(trap.bullTrap)ss+=3;
            const bestDir=ls>=ss?'LONG':'SHORT';
            return {longScore:ls,shortScore:ss,bestDir,atr,adx,currentPrice:cp};
        }

        function simTrade(idx,entry,sl,tp1,tp2,tp3,isLong) {
            const slD=Math.abs(entry-sl);
            if(slD===0)return{result:'SKIP',pnlR:0,tp1Hit:false,tp2Hit:false,tp3Hit:false};
            let tp1Hit=false,tp2Hit=false,pnlR=0;
            for(let j=idx;j<Math.min(idx+200,candles.length);j++){
                const hi=parseFloat(candles[j][2]),lo=parseFloat(candles[j][3]);
                if(isLong){
                    if(lo<=sl)return{result:'LOSS',pnlR:pnlR-(tp1Hit?0.67:1.0),tp1Hit,tp2Hit,tp3Hit:false};
                    if(!tp1Hit&&hi>=tp1){tp1Hit=true;pnlR+=0.33*1.5;}
                    if(tp1Hit&&!tp2Hit&&hi>=tp2){tp2Hit=true;pnlR+=0.33*3;}
                    if(tp2Hit&&hi>=tp3)return{result:'WIN',pnlR:pnlR+0.34*5,tp1Hit,tp2Hit,tp3Hit:true};
                }else{
                    if(hi>=sl)return{result:'LOSS',pnlR:pnlR-(tp1Hit?0.67:1.0),tp1Hit,tp2Hit,tp3Hit:false};
                    if(!tp1Hit&&lo<=tp1){tp1Hit=true;pnlR+=0.33*1.5;}
                    if(tp1Hit&&!tp2Hit&&lo<=tp2){tp2Hit=true;pnlR+=0.33*3;}
                    if(tp2Hit&&lo<=tp3)return{result:'WIN',pnlR:pnlR+0.34*5,tp1Hit,tp2Hit,tp3Hit:true};
                }
            }
            const lastP=parseFloat(candles[Math.min(idx+199,candles.length-1)][4]);
            const openR=isLong?(lastP-entry)/slD:(entry-lastP)/slD;
            return{result:'OPEN',pnlR:pnlR+openR*(tp2Hit?0.34:tp1Hit?0.67:1.0),tp1Hit,tp2Hit,tp3Hit:false};
        }

        const trades=[],MIN_SCORE=12;
        let equity=0,maxEq=0,maxDD=0,wins=0,losses=0,longT=0,shortT=0;
        let tp1Count=0,tp2Count=0,tp3Count=0,i=200;

        while(i<candles.length-25){
            const{longScore,shortScore,bestDir,atr,adx,currentPrice}=backtestScore(i);
            if(atr===0){i++;continue;}
            const adxVal=adx?.value??adx??0;
            const score=bestDir==='LONG'?longScore:shortScore;
            if(adxVal<18||score<MIN_SCORE){i++;continue;}
            const isLong=bestDir==='LONG';
            const entry=currentPrice,sl=isLong?entry-atr*2:entry+atr*2;
            const tp1=isLong?entry+atr*1.5:entry-atr*1.5;
            const tp2=isLong?entry+atr*3:entry-atr*3;
            const tp3=isLong?entry+atr*5:entry-atr*5;
            const sim=simTrade(i,entry,sl,tp1,tp2,tp3,isLong);
            if(sim.result==='SKIP'){i++;continue;}
            trades.push({dir:isLong?'L':'S',entry,result:sim.result,pnlR:sim.pnlR,score,idx:i});
            equity+=sim.pnlR;
            if(equity>maxEq)maxEq=equity;
            const dd=maxEq-equity;if(dd>maxDD)maxDD=dd;
            if(sim.result==='WIN')wins++;if(sim.result==='LOSS')losses++;
            if(sim.tp1Hit)tp1Count++;if(sim.tp2Hit)tp2Count++;if(sim.tp3Hit)tp3Count++;
            if(isLong)longT++;else shortT++;
            i+=20;
        }

        const total=wins+losses;
        const winRate=total>0?(wins/total*100).toFixed(1):'0.0';
        const gW=trades.filter(t=>t.pnlR>0).reduce((s,t)=>s+t.pnlR,0);
        const gL=Math.abs(trades.filter(t=>t.pnlR<0).reduce((s,t)=>s+t.pnlR,0));
        const pf=gL>0?(gW/gL).toFixed(2):'∞';
        let conL=0,maxCL=0;
        [...trades].sort((a,b)=>a.idx-b.idx).forEach(t=>{if(t.result==='LOSS'){conL++;if(conL>maxCL)maxCL=conL;}else conL=0;});
        const sorted=[...trades].sort((a,b)=>b.pnlR-a.pnlR);

        res.json({ok:true,result:{
            trades,wins,losses,longT,shortT,total,winRate,pf,
            gW:gW.toFixed(2),gL:gL.toFixed(2),maxDD:maxDD.toFixed(2),
            netR:equity.toFixed(2),maxCL,candleCount:candles.length,
            best:sorted[0]||null,worst:sorted[sorted.length-1]||null,
            tpBreakdown:{tp1:tp1Count,tp2:tp2Count,tp3:tp3Count},
        }});
    } catch(e) {
        console.error('[Backtest]', e.message);
        res.status(500).json({ok:false,error:e.message});
    }
});

// ══════════════════════════════════════════════════════════════
//  4. SCANBACKTEST  POST /app/api/scanbacktest
//     Multi-coin backtest — mirrors .scanbacktest command
// ══════════════════════════════════════════════════════════════
app.post('/app/api/scanbacktest', saasAuth.requireUserAuth, async (req, res) => {
    try {
        let { timeframe='15m', limit=15 } = req.body;
        if (!VALID_TF.includes(timeframe)) timeframe = '15m';
        limit = Math.min(parseInt(limit)||15, 20);
        console.log(`[ScanBacktest] ${req.saasUser.username} → ${timeframe} top-${limit}`);

        const binance = require('./lib/binance');
        const allCoins = binance.isReady()
            ? binance.getWatchedCoins().slice(0, limit)
            : await binance.getTopTrendingCoins(limit).catch(() => [
                'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT',
                'AVAXUSDT','DOTUSDT','LINKUSDT','MATICUSDT','ATOMUSDT','NEARUSDT',
                'LTCUSDT','DOGEUSDT','UNIUSDT',
            ]);
        const coins = allCoins.filter(c => !STABLES.has(c)).slice(0, limit);

        const results = [];
        for (const coin of coins) {
            try {
                // Mini backtest per coin (faster: 500 candles, no 1H cross)
                const binanceLib = require('./lib/binance');
                const indLib     = require('./lib/indicators');
                const smcLib     = require('./lib/smartmoney');
                const candles    = await binanceLib.getKlineData(coin, timeframe, 500).catch(() => null);
                if (!candles || candles.length < 200) { results.push({coin:coin.replace('USDT',''),error:'insufficient data'}); continue; }

                let wins=0,losses=0,equity=0,i=100;
                while(i < candles.length-25) {
                    const slice = candles.slice(Math.max(0,i-80),i);
                    if(slice.length<50){i++;continue;}
                    const cp   = parseFloat(slice[slice.length-1][4]);
                    const atr  = parseFloat(indLib.calculateATR(slice.slice(-30),14));
                    const adxR = indLib.calculateADX(slice.slice(-30));
                    const adxV = adxR?.value??adxR??0;
                    const rsi  = indLib.calculateRSI(slice.slice(-30),14);
                    const macd = indLib.calculateMACD(slice.slice(-30));
                    const mSMC = smcLib.analyzeSMC(slice.slice(-30));
                    if(atr===0||adxV<18){i++;continue;}
                    let ls=0,ss=0;
                    const ema50=parseFloat(indLib.calculateEMA(slice,50));
                    if(cp>ema50)ls++;else ss++;
                    if(rsi<45)ls++;if(rsi>55)ss++;
                    if(macd.includes('Bullish'))ls++;if(macd.includes('Bearish'))ss++;
                    if(mSMC.bullishOB)ls++;if(mSMC.bearishOB)ss++;
                    if(mSMC.sweep?.includes('Bullish'))ls+=2;if(mSMC.sweep?.includes('Bearish'))ss+=2;
                    if(mSMC.choch?.includes('Bullish'))ls+=2;if(mSMC.choch?.includes('Bearish'))ss+=2;
                    const score=Math.max(ls,ss);
                    if(score<6){i++;continue;}
                    const isLong=ls>=ss;
                    const entry=cp,sl=isLong?cp-atr*2:cp+atr*2;
                    const tp1=isLong?cp+atr*1.5:cp-atr*1.5;
                    const tp2=isLong?cp+atr*3:cp-atr*3;
                    let hit=false;
                    for(let j=i;j<Math.min(i+100,candles.length);j++){
                        const hi=parseFloat(candles[j][2]),lo=parseFloat(candles[j][3]);
                        if(isLong){if(lo<=sl){losses++;equity-=1;hit=true;break;}if(hi>=tp2){wins++;equity+=3;hit=true;break;}}
                        else{if(hi>=sl){losses++;equity-=1;hit=true;break;}if(lo<=tp2){wins++;equity+=3;hit=true;break;}}
                    }
                    if(!hit) equity+=0;
                    i+=15;
                }
                const total=wins+losses;
                const winRate=total>0?(wins/total*100).toFixed(1):'0.0';
                const pf=losses>0?(wins*3/losses).toFixed(2):'∞';
                const pfNum=losses>0?wins*3/losses:999;
                results.push({
                    coin:coin.replace('USDT',''), timeframe,
                    total, wins, losses, winRate, pf,
                    netR:equity.toFixed(2),
                    grade: pfNum>=2?'Excellent':pfNum>=1.5?'Good':pfNum>=1?'Marginal':'Poor',
                    gradeColor: pfNum>=2?'var(--green)':pfNum>=1.5?'var(--accent)':pfNum>=1?'var(--yellow)':'var(--red)',
                    recommended: pfNum >= 1.5,
                });
            } catch(e) { results.push({coin:coin.replace('USDT',''),error:e.message}); }
        }
        results.sort((a,b)=>(parseFloat(b.winRate)||0)-(parseFloat(a.winRate)||0));
        res.json({ok:true, results, timeframe, scanned:coins.length, ts:Date.now()});
    } catch(e) {
        console.error('[ScanBacktest]', e.message);
        res.status(500).json({ok:false,error:e.message});
    }
});

// ══════════════════════════════════════════════════════════════
//  5. SCANNER PAGE  GET /app/scanner
//     Full UI — market scanner + single-coin deep analysis
//     + backtest mode + scanbacktest tab
// ══════════════════════════════════════════════════════════════
app.get('/app/scanner', saasAuth.requireUserAuth, (req, res) => {
    const user = req.saasUser;
    res.send(_html('AI Scanner', `
${_appNav('scanner', user.username)}
<div class="wrap">
  <h1 class="page-title">⚡ AI Scanner <span>Full 70-Factor Analysis · .future Parity</span></h1>

  <!-- ── Scanner Tabs ── -->
  <div style="display:flex;gap:0;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:24px;width:fit-content">
    <button id="tab-live"    onclick="switchTab('live')"    style="padding:9px 22px;font-size:.82rem;font-weight:600;border:none;cursor:pointer;transition:.15s;background:var(--accent);color:#000;font-family:var(--font-mono)">⚡ Live Analysis</button>
    <button id="tab-bt"      onclick="switchTab('bt')"      style="padding:9px 22px;font-size:.82rem;font-weight:600;border:none;cursor:pointer;transition:.15s;background:var(--card2);color:var(--text2);font-family:var(--font-mono)">📊 Backtest</button>
    <button id="tab-scanbt"  onclick="switchTab('scanbt')"  style="padding:9px 22px;font-size:.82rem;font-weight:600;border:none;cursor:pointer;transition:.15s;background:var(--card2);color:var(--text2);font-family:var(--font-mono)">🌐 Scan Backtest</button>
  </div>

  <!-- ══ TAB: LIVE ANALYSIS ══ -->
  <div id="panel-live">

    <!-- ── Quick Market Scanner ──────────────────────────── -->
    <div id="qs-panel" style="margin-bottom:20px;background:linear-gradient(135deg,rgba(0,200,255,.05),rgba(0,230,118,.03));border:1px solid rgba(0,200,255,.18);border-radius:var(--radius);padding:18px 20px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:4px">
        <div>
          <div style="font-weight:700;font-size:.95rem;color:#fff;margin-bottom:3px">🔍 Market Scanner — Top 30 Coins</div>
          <div style="font-size:.72rem;color:var(--text2)">14-Factor SMC + ICT analysis · Quality gate · Sentiment overlay · Bot code parity</div>
        </div>
        <button id="qs-btn" onclick="quickMarketScan()" class="btn btn-primary" style="padding:10px 26px;font-weight:700">
          🔍 Scan Top 30
        </button>
      </div>

      <div id="qs-loading" style="display:none;padding:22px 0;text-align:center">
        <div style="font-size:2rem;animation:spin 1.2s linear infinite;display:inline-block">🔍</div>
        <div style="margin-top:8px;font-size:.85rem;color:var(--text)" id="qs-msg">Scanning top 30 coins...</div>
        <div style="font-size:.7rem;color:var(--text2);margin-top:3px">SMC · ICT · Quality Gate · Sentiment</div>
      </div>
      <div id="qs-error" style="display:none;margin-top:12px;color:var(--red);font-size:.84rem"></div>
      <div id="qs-empty" style="display:none;margin-top:12px;text-align:center;color:var(--text2);font-size:.83rem;padding:14px">
        🔍 Score 20+ setups නෑ. Next 15m candle close වෙනකල් try again.
      </div>

      <div id="qs-sentiment" style="display:none;margin-top:14px;padding:10px 12px;background:rgba(0,0,0,.2);border-radius:var(--radius-sm)">
        <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center">
          <span style="font-size:.78rem">🧠 <b id="qs-overall">—</b></span>
          <span style="font-size:.78rem" id="qs-fng-el">—</span>
          <span style="font-size:.78rem">₿ BTC.D: <b id="qs-btcdom">—</b>%</span>
          <span style="font-size:.78rem">📰 News: <b id="qs-news">—</b></span>
          <span style="font-size:.68rem;color:var(--text2);margin-left:auto" id="qs-meta"></span>
        </div>
      </div>

      <div id="qs-grid" style="display:none;margin-top:14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:10px"></div>
    </div>

    <!-- ── Deep Analysis Input ──────────────────────────── -->
    <div class="panel" style="max-width:740px;margin-bottom:22px">
      <div class="panel-body">
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
          <div style="flex:1;min-width:130px">
            <label class="field-label">Coin Symbol</label>
            <input type="text" id="coin-input" class="inp"
              placeholder="BTC, ETH, SOL..."
              style="font-family:var(--font-mono);font-size:1.05rem;font-weight:700;text-transform:uppercase"
              maxlength="12" autocomplete="off">
          </div>
          <div style="min-width:120px">
            <label class="field-label">Timeframe</label>
            <select id="tf-select" class="inp">
              <option value="5m">5 Minutes</option>
              <option value="15m" selected>15 Minutes</option>
              <option value="1h">1 Hour</option>
              <option value="4h">4 Hours</option>
              <option value="1d">1 Day</option>
            </select>
          </div>
          <button id="scan-btn" class="btn btn-primary" style="padding:11px 26px" onclick="runLiveScan()">⚡ Analyse</button>
        </div>
        <div style="font-size:.72rem;color:var(--text2);margin-top:9px">70-Factor MTF + SMC + Wyckoff · Funding Rate · Whale Walls · 11-Factor Confirmation Engine</div>
      </div>
    </div>

    <div id="live-loading" style="display:none;padding:50px 0;text-align:center">
      <div style="font-size:2.8rem;animation:spin 1s linear infinite;display:inline-block">⚙️</div>
      <div style="margin-top:14px;font-size:.95rem;color:var(--text)" id="live-msg">Running 70-Factor Analysis...</div>
      <div style="margin-top:5px;font-size:.75rem;color:var(--text2)">Candles · Indicators · External Data · AI</div>
    </div>
    <div id="live-error" style="display:none;background:rgba(255,51,85,.07);border:1px solid rgba(255,51,85,.25);border-radius:var(--radius);padding:14px 18px;margin-bottom:16px;color:var(--red);font-size:.88rem"></div>
    <div id="live-results" style="display:none"></div>
  </div>

  <!-- ══ TAB: BACKTEST ══ -->
  <div id="panel-bt" style="display:none">
    <div class="panel" style="max-width:600px;margin-bottom:22px">
      <div class="panel-body">
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
          <div style="flex:1;min-width:130px">
            <label class="field-label">Coin Symbol</label>
            <input type="text" id="bt-coin" class="inp" placeholder="BTC, ETH, SOL..."
              style="font-family:var(--font-mono);font-size:1.05rem;font-weight:700;text-transform:uppercase" maxlength="12" autocomplete="off">
          </div>
          <div style="min-width:120px">
            <label class="field-label">Timeframe</label>
            <select id="bt-tf" class="inp">
              <option value="5m">5 Minutes</option>
              <option value="15m" selected>15 Minutes</option>
              <option value="1h">1 Hour</option>
              <option value="4h">4 Hours</option>
              <option value="1d">1 Day</option>
            </select>
          </div>
          <button id="bt-btn" class="btn btn-warn" style="padding:11px 22px" onclick="runBacktest()">📊 Run Backtest</button>
        </div>
        <div style="font-size:.72rem;color:var(--text2);margin-top:9px">1000 candles · v6 Full-Spectrum · TP1/TP2/TP3 partial close simulation</div>
      </div>
    </div>
    <div id="bt-loading" style="display:none;padding:50px 0;text-align:center">
      <div style="font-size:2.8rem;animation:spin 1.2s linear infinite;display:inline-block">📊</div>
      <div style="margin-top:14px;font-size:.95rem;color:var(--text)" id="bt-msg">Downloading candles...</div>
    </div>
    <div id="bt-error" style="display:none;background:rgba(255,51,85,.07);border:1px solid rgba(255,51,85,.25);border-radius:var(--radius);padding:14px 18px;margin-bottom:16px;color:var(--red);font-size:.88rem"></div>
    <div id="bt-results" style="display:none"></div>
  </div>

  <!-- ══ TAB: SCAN BACKTEST ══ -->
  <div id="panel-scanbt" style="display:none">
    <div class="panel" style="max-width:600px;margin-bottom:22px">
      <div class="panel-body">
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
          <div style="min-width:120px">
            <label class="field-label">Timeframe</label>
            <select id="sbt-tf" class="inp">
              <option value="15m" selected>15 Minutes</option>
              <option value="1h">1 Hour</option>
              <option value="4h">4 Hours</option>
            </select>
          </div>
          <div style="min-width:100px">
            <label class="field-label">Coins</label>
            <select id="sbt-limit" class="inp">
              <option value="10">Top 10</option>
              <option value="15" selected>Top 15</option>
              <option value="20">Top 20</option>
            </select>
          </div>
          <button id="sbt-btn" class="btn btn-primary" style="padding:11px 22px" onclick="runScanBacktest()">🌐 Scan All</button>
        </div>
        <div style="font-size:.72rem;color:var(--text2);margin-top:9px">Backtests top coins · Ranks by Win Rate · Finds the best pairs for this strategy</div>
      </div>
    </div>
    <div id="sbt-loading" style="display:none;padding:50px 0;text-align:center">
      <div style="font-size:2.8rem;animation:spin 1s linear infinite;display:inline-block">🌐</div>
      <div style="margin-top:14px;font-size:.95rem;color:var(--text)" id="sbt-msg">Scanning coins...</div>
    </div>
    <div id="sbt-error" style="display:none;background:rgba(255,51,85,.07);border:1px solid rgba(255,51,85,.25);border-radius:var(--radius);padding:14px 18px;margin-bottom:16px;color:var(--red);font-size:.88rem"></div>
    <div id="sbt-results" style="display:none"></div>
  </div>

</div>

<style>
.res-section{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px;margin-bottom:14px}
.res-section-title{font-family:var(--font-head);font-size:.82rem;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.res-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:10px}
.res-item{background:var(--bg2);border-radius:var(--radius-sm);padding:10px 12px}
.res-item-label{font-size:.62rem;color:var(--text2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px}
.res-item-val{font-family:var(--font-mono);font-size:.88rem;font-weight:600;color:var(--text)}
.conf-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:middle}
.conf-row{display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:.8rem}
.conf-row:last-child{border-bottom:none}
.opp-card{border-radius:var(--radius);border:1px solid var(--border);padding:15px;background:var(--card);cursor:pointer;transition:.15s;position:relative;overflow:hidden}
.opp-card:hover{transform:translateY(-2px);border-color:var(--border2);box-shadow:0 6px 20px rgba(0,0,0,.3)}
.opp-card.long-card{border-left:3px solid var(--green)}
.opp-card.short-card{border-left:3px solid var(--red)}
.score-bar{height:3px;border-radius:99px;background:var(--border);margin:8px 0}
.score-bar-fill{height:100%;border-radius:99px}
.sbt-row{display:flex;align-items:center;gap:14px;padding:13px 16px;border-bottom:1px solid var(--border);transition:.12s}
.sbt-row:last-child{border-bottom:none}
.sbt-row:hover{background:rgba(0,200,255,.03)}
.sbt-rank{font-family:var(--font-mono);font-size:.72rem;color:var(--text2);min-width:24px;text-align:center}
.sbt-wr-bar{height:6px;border-radius:99px;background:var(--border);min-width:80px;overflow:hidden}
.sbt-wr-fill{height:100%;border-radius:99px;transition:width 1s ease}
</style>

<script>
const _$ = id => document.getElementById(id);
function fmtP(n,d=4){if(n==null||isNaN(Number(n)))return'—';const p=parseFloat(n);if(isNaN(p))return'—';if(d===4){if(p>=10000)return'$'+p.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});if(p>=1)return'$'+p.toFixed(4);return'$'+p.toFixed(6);}return p.toFixed(d);}
function sCol(s){return s>=70?'var(--green)':s>=45?'var(--yellow)':'var(--red)';}
function sigCol(s){return(s||'').includes('CONFIRMED')?'var(--green)':(s||'').includes('CONFLICT')?'var(--red)':'var(--yellow)';}

// ── Tab switch ─────────────────────────────────────────────
let _tab = 'live';
function switchTab(t) {
  _tab = t;
  ['live','bt','scanbt'].forEach(id => {
    _$('tab-'+id).style.background   = t===id ? 'var(--accent)'  : 'var(--card2)';
    _$('tab-'+id).style.color        = t===id ? '#000'           : 'var(--text2)';
    _$('panel-'+id).style.display    = t===id ? ''               : 'none';
  });
}

// ── Market Scan ────────────────────────────────────────────
async function runMarketScan() {
  _$('ms-btn').disabled=true; _$('ms-btn').textContent='⏳ Scanning...';
  _$('ms-badge').textContent='RUNNING'; _$('ms-badge').style.color='var(--yellow)';
  _$('ms-results').style.display='none'; _$('ms-empty').style.display='none';
  _$('ms-error').style.display='none'; _$('ms-loading').style.display='block';
  const tips=['Fetching candles...','Scoring confluences...','Ranking setups...','Calculating DCA...'];
  let ti=0; const tt=setInterval(()=>{ _$('ms-msg').textContent=tips[ti%tips.length]; ti++; },3000);
  try {
    const r=await fetch('/app/api/market-scan'); const d=await r.json();
    clearInterval(tt); _$('ms-loading').style.display='none';
    if(!r.ok||!d.ok){_$('ms-error').style.display='block';_$('ms-error').textContent='❌ '+(d.error||'Scan failed');return;}
    if(!d.setups||d.setups.length===0){_$('ms-empty').style.display='block';return;}
    _$('ms-meta').textContent='Top '+d.setups.length+' from '+d.scanned+' coins · '+new Date(d.ts).toLocaleTimeString();
    const g=_$('ms-grid'); g.innerHTML='';
    d.setups.forEach((s,i)=>{
      const isL=s.direction==='LONG',dc=isL?'var(--green)':'var(--red)';
      const sc=sCol(s.score),sPct=Math.min((s.score/s.maxScore)*100,100).toFixed(1);
      const reasons=(s.reasons||'').split(',').slice(0,3).map(r=>'<span style="display:inline-block;background:rgba(0,200,255,.06);border-radius:3px;padding:1px 5px;margin:1px;font-size:.6rem">'+r.trim()+'</span>').join('');
      const card=document.createElement('div');
      card.className='opp-card '+(isL?'long-card':'short-card');
      card.onclick=()=>{_$('coin-input').value=s.coin;switchTab('live');setTimeout(runLiveScan,100);}
      card.innerHTML=\`
        <div style="position:absolute;top:8px;right:10px;font-family:var(--font-mono);font-size:.6rem;color:var(--text2)">#\${i+1}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <div style="font-family:var(--font-head);font-size:1.1rem;font-weight:800;color:#fff">\${s.coin}</div>
          <div style="font-size:.75rem;font-weight:700;padding:2px 9px;border-radius:99px;background:\${isL?'rgba(0,230,118,.12)':'rgba(255,51,85,.12)'};color:\${dc}">\${isL?'▲':'▼'} \${s.direction}</div>
          <div style="margin-left:auto;font-family:var(--font-mono);font-size:.72rem;color:\${sc};font-weight:700">\${s.score}/\${s.maxScore}</div>
        </div>
        <div class="score-bar"><div class="score-bar-fill" style="width:\${sPct}%;background:\${sc}"></div></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0">
          <div><div style="font-size:.6rem;color:var(--text2)">Entry</div><div style="font-family:var(--font-mono);font-size:.82rem;color:var(--accent)">\${fmtP(s.entryPrice)}</div></div>
          <div><div style="font-size:.6rem;color:var(--text2)">SL</div><div style="font-family:var(--font-mono);font-size:.82rem;color:var(--red)">\${fmtP(s.sl)}</div></div>
          <div><div style="font-size:.6rem;color:var(--text2)">Leverage</div><div style="font-family:var(--font-mono);font-size:.82rem;color:var(--yellow)">Cross \${s.leverage}x</div></div>
          <div><div style="font-size:.6rem;color:var(--text2)">RRR</div><div style="font-family:var(--font-mono);font-size:.82rem;color:\${parseFloat(s.rrr)>=2?'var(--green)':parseFloat(s.rrr)>=1?'var(--yellow)':'var(--red)'}">1:\${s.rrr}</div></div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:8px">
          <div style="background:rgba(0,0,0,.2);border-radius:5px;padding:4px 6px;text-align:center"><div style="font-size:.58rem;color:var(--text2)">TP1</div><div style="font-family:var(--font-mono);font-size:.72rem;color:var(--green)">\${fmtP(s.tp1)}</div></div>
          <div style="background:rgba(0,0,0,.2);border-radius:5px;padding:4px 6px;text-align:center"><div style="font-size:.58rem;color:var(--text2)">TP2</div><div style="font-family:var(--font-mono);font-size:.72rem;color:var(--green)">\${fmtP(s.tp2)}</div></div>
          <div style="background:rgba(0,0,0,.2);border-radius:5px;padding:4px 6px;text-align:center"><div style="font-size:.58rem;color:var(--text2)">TP3</div><div style="font-family:var(--font-mono);font-size:.72rem;color:var(--green)">\${fmtP(s.tp3)}</div></div>
        </div>
        <div style="margin-top:8px">\${reasons}</div>
        <div style="margin-top:7px;text-align:right;font-size:.62rem;color:var(--accent)">Click → deep analyse</div>
      \`;
      g.appendChild(card);
    });
    _$('ms-results').style.display='block';
  } catch(e) { clearInterval(tt); _$('ms-loading').style.display='none'; _$('ms-error').style.display='block'; _$('ms-error').textContent='❌ '+e.message; }
  finally { _$('ms-btn').disabled=false; _$('ms-btn').textContent='⚡ Scan Market Now'; _$('ms-badge').textContent='DONE'; _$('ms-badge').style.color='var(--green)'; }
}

// ── Live Analysis ──────────────────────────────────────────
async function runLiveScan() {
  const coinRaw=_$('coin-input').value.trim().toUpperCase(), tf=_$('tf-select').value;
  if(!coinRaw){_$('coin-input').focus();return;}
  _$('live-results').style.display='none'; _$('live-error').style.display='none';
  _$('live-loading').style.display='block'; _$('scan-btn').disabled=true; _$('scan-btn').textContent='⏳...';
  const msgs=['Fetching candles...','Calculating 70 indicators...','Fetching funding rate & whale walls...','Running 11-factor confirmation...','Generating AI analysis...','Almost done...'];
  let mi=0; const mt=setInterval(()=>_$('live-msg').textContent=msgs[Math.min(++mi,msgs.length-1)],4500);
  try {
    const r=await fetch('/app/api/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({coin:coinRaw,timeframe:tf})});
    const d=await r.json(); clearInterval(mt);
    if(!r.ok||!d.ok){_$('live-loading').style.display='none';_$('live-error').style.display='block';_$('live-error').textContent='❌ '+(d.error||'Analysis failed');return;}
    renderLive(d.analysis, coinRaw, tf);
  } catch(e){clearInterval(mt);_$('live-loading').style.display='none';_$('live-error').style.display='block';_$('live-error').textContent='❌ Network error: '+e.message;}
  finally{_$('scan-btn').disabled=false;_$('scan-btn').textContent='⚡ Analyse';}
}

function renderLive(a, coin, tf) {
  _$('live-loading').style.display='none';
  const isL=a.direction==='LONG', dc=isL?'var(--green)':'var(--red)', da=isL?'▲':'▼';
  const sc=sCol(a.score||0), f=a.futures||{};
  const s=a.sentiment||{}, ec=a.entryConf||{}, ai=a.ai||{};
  const entry=parseFloat(a.entryPrice)||0, sl=parseFloat(a.sl)||0, tp2v=parseFloat(a.tp2)||0;
  const risk=Math.abs(entry-sl);
  const dca1=isL?entry-risk*0.35:entry+risk*0.35;
  const dca2=isL?entry-risk*0.70:entry+risk*0.70;
  const reasons=(a.reasons||'').split(',').map(r=>r.trim()).filter(Boolean);

  let html = \`
  <!-- ── Hero ── -->
  <div class="scan-hero" style="margin-bottom:18px">
    <div style="text-align:center;min-width:100px">
      <div style="width:88px;height:88px;border-radius:50%;border:3px solid \${sc};display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:1.7rem;font-weight:800;color:\${sc};margin:0 auto">\${a.score||0}</div>
      <div style="font-size:.65rem;color:var(--text2);margin-top:6px;text-transform:uppercase;letter-spacing:.08em">Confluence</div>
    </div>
    <div style="flex:1">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">
        <span style="font-family:var(--font-head);font-size:1.55rem;font-weight:800;color:#fff">\${coin.replace('USDT','')}/USDT</span>
        <span style="background:var(--card2);padding:2px 9px;border-radius:5px;font-size:.72rem;color:var(--text2);font-family:var(--font-mono)">\${tf.toUpperCase()}</span>
        <span style="padding:4px 14px;border-radius:99px;font-size:.85rem;font-weight:700;font-family:var(--font-mono);background:\${isL?'rgba(0,230,118,.12)':'rgba(255,51,85,.12)'};color:\${dc}">\${da} \${a.direction}</span>
        <span style="font-family:var(--font-mono);font-size:.82rem;color:var(--text2)">📍 \${fmtP(a.currentPrice)}</span>
      </div>
      <div style="font-size:.73rem;color:var(--text2);line-height:1.8">\${reasons.slice(0,10).map(r=>'<span style="display:inline-block;background:rgba(0,200,255,.07);border-radius:4px;padding:2px 6px;margin:1px">'+r+'</span>').join('')}</div>
      <div style="margin-top:10px;display:flex;gap:12px;flex-wrap:wrap">
        <span style="font-size:.77rem;color:var(--text2)">ADX: <b style="color:var(--text)">\${a.adxData?.value?.toFixed(1)||'—'}</b></span>
        <span style="font-size:.77rem;color:var(--text2)">Market: <b style="color:var(--text)">\${a.marketState||'—'}</b></span>
        <span style="font-size:.77rem;color:var(--text2)">Session: <b style="color:var(--text)">\${a.session?.session||'—'}</b></span>
        <span style="font-size:.77rem;color:\${(a.confGate)?'var(--green)':'var(--text2)'}">Gate: <b>\${a.confGate?'✅ PASSED':'⏳ '+((a.confScore||0))+'/14'}</b></span>
        <span style="font-size:.77rem;color:var(--text2)">AI: <b style="color:var(--accent)">\${ai.confidence||'—'}</b></span>
      </div>
    </div>
  </div>

  <!-- ── Futures Setup ── -->
  <div class="res-section" style="border-color:rgba(255,171,0,.22);background:linear-gradient(135deg,rgba(255,171,0,.04),rgba(255,51,85,.025))">
    <div class="res-section-title">⚡ Futures Trade Setup</div>
    <div class="res-grid" style="margin-bottom:14px">
      <div class="res-item" style="border:1px solid rgba(255,171,0,.18)"><div class="res-item-label">Leverage</div><div class="res-item-val" style="color:var(--yellow);font-size:1.2rem">Cross \${f.leverage||'—'}x</div></div>
      <div class="res-item" style="border:1px solid rgba(255,171,0,.18)"><div class="res-item-label">Margin</div><div class="res-item-val" style="color:var(--yellow);font-size:1.2rem">2% wallet</div></div>
      <div class="res-item"><div class="res-item-label">Entry</div><div class="res-item-val" style="color:var(--accent)">\${fmtP(a.entryPrice)}</div><div style="font-size:.62rem;color:var(--text2)">\${a.orderSuggestion?.type||''}</div></div>
      <div class="res-item"><div class="res-item-label">Stop Loss</div><div class="res-item-val" style="color:var(--red)">\${fmtP(a.sl)}</div><div style="font-size:.62rem;color:var(--text2)">\${a.slLabel||'ATR'}</div></div>
      <div class="res-item"><div class="res-item-label">RRR</div><div class="res-item-val" style="color:\${parseFloat(f.rrr)>=2?'var(--green)':parseFloat(f.rrr)>=1?'var(--yellow)':'var(--red)'}">1:\${f.rrr||a.rrr||'—'}</div></div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px">
      <div class="res-item"><div class="res-item-label">🎯 TP1 — 33%</div><div class="res-item-val" style="color:var(--green)">\${fmtP(a.tp1)}</div><div style="font-size:.6rem;color:var(--text2)">\${a.tp1Label||''}</div></div>
      <div class="res-item"><div class="res-item-label">🎯 TP2 — 33%</div><div class="res-item-val" style="color:var(--green)">\${fmtP(a.tp2)}</div><div style="font-size:.6rem;color:var(--text2)">\${a.tp2Label||''}</div></div>
      <div class="res-item"><div class="res-item-label">🎯 TP3 — Full</div><div class="res-item-val" style="color:var(--green)">\${fmtP(a.tp3)}</div><div style="font-size:.6rem;color:var(--text2)">\${a.tp3Label||''}</div></div>
    </div>
    <div style="background:rgba(0,200,255,.04);border:1px solid rgba(0,200,255,.12);border-radius:var(--radius);padding:12px 14px">
      <div style="font-size:.68rem;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.07em;margin-bottom:9px">📉 DCA Points</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px">
        <div><div style="font-size:.62rem;color:var(--text2)">Entry (50% size)</div><div style="font-family:var(--font-mono);font-size:.88rem;color:var(--text)">\${fmtP(a.entryPrice)}</div></div>
        <div><div style="font-size:.62rem;color:var(--text2)">DCA 1 — 35% toward SL</div><div style="font-family:var(--font-mono);font-size:.88rem;color:var(--yellow)">\${fmtP(dca1)}</div></div>
        <div><div style="font-size:.62rem;color:var(--text2)">DCA 2 — 70% toward SL</div><div style="font-family:var(--font-mono);font-size:.88rem;color:var(--red)">\${fmtP(dca2)}</div></div>
        <div><div style="font-size:.62rem;color:var(--text2)">Hard Stop Loss</div><div style="font-family:var(--font-mono);font-size:.88rem;font-weight:700;color:var(--red)">\${fmtP(a.sl)}</div></div>
      </div>
    </div>
  </div>

  <!-- ── Market Context ── -->
  <div class="res-section">
    <div class="res-section-title">🌊 Market Context</div>
    <div class="res-grid" style="margin-bottom:12px">
      <div class="res-item"><div class="res-item-label">Market State</div><div class="res-item-val" style="font-size:.82rem">\${a.marketState||'—'}</div></div>
      <div class="res-item"><div class="res-item-label">Main Trend</div><div class="res-item-val" style="font-size:.82rem">\${a.mainTrend||'—'}</div></div>
      <div class="res-item"><div class="res-item-label">4H Trend</div><div class="res-item-val" style="font-size:.82rem">\${a.trend4H||'—'}</div></div>
      <div class="res-item"><div class="res-item-label">1H Trend</div><div class="res-item-val" style="font-size:.82rem">\${a.trend1H||'—'}</div></div>
      <div class="res-item"><div class="res-item-label">RSI (14)</div><div class="res-item-val" style="color:\${parseFloat(a.rsi)>70?'var(--red)':parseFloat(a.rsi)<30?'var(--green)':'var(--text)'}">\${a.rsi?parseFloat(a.rsi).toFixed(1):'—'}</div></div>
      <div class="res-item"><div class="res-item-label">ADX</div><div class="res-item-val" style="font-size:.82rem">\${a.adxData?a.adxData.value?.toFixed(1)+' · '+a.adxData.status:'—'}</div></div>
      <div class="res-item"><div class="res-item-label">Daily Trend</div><div class="res-item-val" style="font-size:.82rem">\${a.dailyTrend||'—'} \${a.dailyAligned?'✅':'⚠️'}</div></div>
      <div class="res-item"><div class="res-item-label">Session</div><div class="res-item-val" style="font-size:.82rem">\${a.session?(a.session.session+' · '+a.session.quality):'—'}</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div>
        <div style="font-size:.65rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">🐋 Whale Walls</div>
        <div style="font-size:.82rem"><span style="color:var(--green)">Buy: \${fmtP(a.whaleWalls?.supportWall)} (\${a.whaleWalls?.supportVol||'—'} USDT)</span></div>
        <div style="font-size:.82rem;margin-top:3px"><span style="color:var(--red)">Sell: \${fmtP(a.whaleWalls?.resistWall)} (\${a.whaleWalls?.resistVol||'—'} USDT)</span></div>
        <div style="font-size:.82rem;margin-top:3px;color:var(--text2)">Funding: <b style="color:\${(a.fundingRate||'').includes('-')?'var(--green)':'var(--text)'}">\${a.fundingRate||'N/A'}</b></div>
      </div>
      <div>
        <div style="font-size:.65rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">😨 Sentiment</div>
        <div style="font-size:.82rem">\${s.fngEmoji||'⚪'} F&G: <b>\${s.fngValue||'—'}</b> (\${s.fngLabel||'—'})</div>
        <div style="font-size:.82rem;margin-top:3px">₿ Dom: <b>\${s.btcDom||'—'}%</b></div>
        <div style="font-size:.82rem;margin-top:3px">News: <b style="color:\${(s.newsScore||0)>0?'var(--green)':(s.newsScore||0)<0?'var(--red)':'var(--text2)'}">\${(s.newsScore||0)>=0?'+':''}\${s.newsScore||0}</b> · <span style="color:\${sigCol(s.boost)}">\${s.boost||'—'}</span></div>
      </div>
    </div>
  </div>

  <!-- ── AI Analysis ── -->
  <div class="res-section" style="border-color:rgba(124,58,237,.25);background:rgba(124,58,237,.03)">
    <div class="res-section-title">🤖 AI Analysis · \${ai.confidence||'—'} Confidence</div>
    <div style="font-size:.85rem;color:var(--text);line-height:1.7;margin-bottom:6px">\${ai.trend||'—'}</div>
    <div style="font-size:.82rem;color:var(--text2);line-height:1.6">\${ai.smc_summary||''}</div>
    \${ai.sentiment_note?'<div style="font-size:.8rem;color:var(--text3);margin-top:6px;padding-top:6px;border-top:1px solid var(--border)">'+ai.sentiment_note+'</div>':''}
  </div>

  <!-- ── Smart Money ── -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
    <div class="res-section" style="margin-bottom:0">
      <div class="res-section-title">🔮 Smart Money Concepts</div>
      \${[['Liq. Sweep',a.liquiditySweep],['ChoCH / BOS',a.choch],['Bullish OB',a.marketSMC?.bullishOBDisplay],['Bearish OB',a.marketSMC?.bearishOBDisplay],['Wyckoff',a.wyckoff?(a.wyckoff.phase+' · '+a.wyckoff.signal):null],['P/D Zone',a.pdZone?(a.pdZone.zone+' · '+a.pdZone.position+'%'):null]].map(([l,v])=>'<div class="conf-row"><span>'+l+'</span><span style="font-family:var(--font-mono);font-size:.75rem;color:var(--text)">'+((v&&v!=='None')?v:'—')+'</span></div>').join('')}
    </div>
    <div class="res-section" style="margin-bottom:0">
      <div class="res-section-title">📈 Key Indicators</div>
      \${[['VWAP',a.vwapDisplay||'—'],['Supertrend',a.supertrend?(a.supertrend.signal+(a.supertrend.justFlipUp?' ⚡UP':a.supertrend.justFlipDown?' ⚡DOWN':'')):null],['Ichimoku',a.ichimoku?.signal],['StochRSI',a.stochRSI?(a.stochRSI.signal+' K:'+a.stochRSI.k?.toFixed(1)):null],['RVOL',a.rvol?(a.rvol.rvol?.toFixed(2)+'x · '+a.rvol.signal):null],['EMA Ribbon',a.emaRibbon?.signal]].map(([l,v])=>'<div class="conf-row"><span>'+l+'</span><span style="font-family:var(--font-mono);font-size:.75rem;color:var(--text)">'+(v||'—')+'</span></div>').join('')}
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
    <div class="res-section" style="margin-bottom:0">
      <div class="res-section-title">🧠 Advanced Signals</div>
      \${[['Heikin Ashi',a.heikinAshi?(a.heikinAshi.consecutive+'× '+a.heikinAshi.signal+(a.heikinAshi.isStrong?' 💪':'')):null],['BB Squeeze',a.bbSqueeze?(a.bbSqueeze.squeezing?'🔴 Squeezing':a.bbSqueeze.exploding?'💥 Exploding · '+a.bbSqueeze.explosionDir:'Normal'):null],['Fib Confluence',a.fibConf?.hasConfluence?(a.fibConf.count+' levels @ $'+a.fibConf.zone):'None'],['EQH/EQL',a.equalHL?.display],['MM Trap',a.mmTrap?(a.mmTrap.bullTrap?'🐂 Bull Trap':a.mmTrap.bearTrap?'🐻 Bear Trap':'None'):null],['CVD',a.cvd?(a.cvd.trend+(a.cvd.bullDiv?' · Accum.':a.cvd.bearDiv?' · Dist.':'')):null]].map(([l,v])=>'<div class="conf-row"><span>'+l+'</span><span style="font-family:var(--font-mono);font-size:.75rem;color:var(--text)">'+(v||'—')+'</span></div>').join('')}
    </div>
    <div class="res-section" style="margin-bottom:0">
      <div class="res-section-title">⚡ v7 PRO Signals</div>
      \${[['Gann Angles',a.gannAngles?.display],['Renko',a.renko?.display],['Moon Cycle',a.moonCycle?.display],['MFI (14)',a.mfi?(a.mfi.value?.toFixed(1)+' · '+a.mfi.signal):null],['ROC (10)',a.roc?(a.roc.value?.toFixed(2)+'% · '+a.roc.signal):null],['CCI (20)',a.cci?(a.cci.value?.toFixed(1)+' · '+a.cci.signal):null]].map(([l,v])=>'<div class="conf-row"><span>'+l+'</span><span style="font-family:var(--font-mono);font-size:.75rem;color:var(--text)">'+(v||'—')+'</span></div>').join('')}
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
    <div class="res-section" style="margin-bottom:0">
      <div class="res-section-title">📊 More Indicators</div>
      \${[['Dynamic S/R',a.dynamicSR?.display],['Fib Levels',a.fibLevels?.display],['BOS',a.bos?.display],['Momentum',a.momentumShift?.display],['Adv Candles',a.advCandles?.display],['MTF MACD',a.mtfMACD?.display]].map(([l,v])=>'<div class="conf-row"><span>'+l+'</span><span style="font-family:var(--font-mono);font-size:.75rem;color:var(--text)">'+(v||'—')+'</span></div>').join('')}
    </div>
    <div class="res-section" style="margin-bottom:0">
      <div class="res-section-title">📐 More Analysis</div>
      \${[['Weekly Tgts',a.weeklyTgts?.display],['CME Gap',a.cmeGap?.hasGap?a.cmeGap.display:'None'],['Harmonic',a.harmonicPattern&&a.harmonicPattern!=='None'?a.harmonicPattern:'None'],['ICT Silver',a.ictSilverBullet&&a.ictSilverBullet!=='None'?a.ictSilverBullet:'None'],['Trade Cat.',a.tradeCategory?.label],['Refinements',a.refinementNote||'None']].map(([l,v])=>'<div class="conf-row"><span>'+l+'</span><span style="font-family:var(--font-mono);font-size:.75rem;color:var(--text);max-width:180px;overflow:hidden;text-overflow:ellipsis">'+(v||'—')+'</span></div>').join('')}
    </div>
  </div>

  <!-- ── 11-Factor Confirmation Engine ── -->
  <div class="res-section" style="border-color:rgba(0,200,255,.18)">
    <div class="res-section-title">🔬 11-Factor Confirmation Engine
      <span style="margin-left:auto;font-family:var(--font-mono);font-size:.8rem;color:\${ec.strength==='STRONG'?'var(--green)':ec.strength==='MODERATE'?'var(--accent)':ec.strength==='CONFLICT'?'var(--red)':'var(--text2)'}">\${ec.verdict||'⚪ NEUTRAL'}</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:5px;margin-bottom:12px">
      \${ec.factors?Object.entries({
        'Stablecoin Flow':ec.factors.usdtDom,'Open Interest':ec.factors.oiChange,
        'CVD External':ec.factors.cvd,'L/S Ratio':ec.factors.lsRatio,
        'Funding Momentum':ec.factors.fundingM,'Order Book':ec.factors.orderBook,
        'Whale Activity':ec.factors.whaleActivity,'BTC Correlation':ec.factors.btcCorr,
        'HTF Levels':ec.factors.htfLevels,'Put/Call Ratio':ec.factors.pcr,
        'Netflow':ec.factors.netflow,'Social':ec.factors.social,
      }).map(([label,f])=>{
        const sig=f?.signal||'N/A',em=f?.emoji||'⚪';
        const bg=sig==='BULL'||sig==='POSITIVE'?'rgba(0,230,118,.06)':sig==='BEAR'||sig==='NEGATIVE'?'rgba(255,51,85,.06)':'rgba(0,0,0,.15)';
        return '<div style="background:'+bg+';border-radius:5px;padding:6px 8px;font-size:.72rem"><div style="color:var(--text2);margin-bottom:2px">'+em+' '+label+'</div><div style="font-family:var(--font-mono);font-size:.7rem;color:var(--text)">'+(f?.display||'N/A').slice(0,50)+'</div></div>';
      }).join('') : '<div style="color:var(--text2);font-size:.82rem">Confirmation data unavailable</div>'}
    </div>
    <div style="padding-top:10px;border-top:1px solid var(--border);display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div style="font-size:.8rem;color:var(--text2)">\${ec.verdictDetail||''}</div>
      <div style="font-family:var(--font-mono);font-size:.78rem;color:\${ec.strength==='STRONG'?'var(--green)':ec.strength==='MODERATE'?'var(--accent)':ec.strength==='CONFLICT'?'var(--red)':'var(--text2)'}">Score: \${ec.totalScore>=0?'+':''}\${(ec.totalScore||0).toFixed(1)} (\${ec.strength||'WEAK'})</div>
    </div>
  </div>

  <!-- ── 14-Factor Confirmation Gate ── -->
  <div class="res-section">
    <div class="res-section-title">✅ 14-Factor Confirmation Gate
      <span style="margin-left:auto;font-family:var(--font-mono);font-size:.78rem;color:\${a.confGate?'var(--green)':'var(--text2)'}">\${a.confGate?'✅ PASSED':'❌ NOT PASSED'} (\${a.confScore||0}/14)</span>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">
      \${Object.entries({htfAligned:'HTF Aligned',chochPrimary:'ChoCH',sweepPrimary:'Sweep',volumeConf:'Volume',wyckoffConf:'Wyckoff',ichimokuConf:'Ichimoku',supTrendConf:'Supertrend',fibZoneConf:'Fib Zone',bbExplosion:'BB Explode',mmTrapConf:'MM Trap',bosConf:'BOS',dailyGate:'Daily Gate',aiConf:'AI Model',bybitConf:'Bybit'}).map(([k,l])=>{const pass=(a.confChecks||{})[k];return '<div style="display:flex;align-items:center;gap:5px;font-size:.72rem;padding:3px 0;color:'+(pass?'var(--green)':'var(--text2)')+'"><span>'+(pass?'✅':'○')+'</span><span>'+l+'</span></div>';}).join('')}
    </div>
  </div>

  <!-- ── Dynamic Weights ── -->
  <div class="res-section">
    <div class="res-section-title">🎛️ Dynamic Regime · AI Weights</div>
    <div class="res-grid">
      <div class="res-item"><div class="res-item-label">Regime</div><div class="res-item-val" style="font-size:.82rem">\${a.dynRegime?.regimeLabel||'—'}</div></div>
      <div class="res-item"><div class="res-item-label">Trend Wt</div><div class="res-item-val c-cyan">\${a.weights?.trend?.toFixed(2)||'—'}</div></div>
      <div class="res-item"><div class="res-item-label">Osc Wt</div><div class="res-item-val">\${a.weights?.oscillator?.toFixed(2)||'—'}</div></div>
      <div class="res-item"><div class="res-item-label">Volume Wt</div><div class="res-item-val">\${a.weights?.volume?.toFixed(2)||'—'}</div></div>
      <div class="res-item"><div class="res-item-label">PA Wt</div><div class="res-item-val">\${a.weights?.priceAction?.toFixed(2)||'—'}</div></div>
    </div>
  </div>

  <div style="text-align:center;font-size:.7rem;color:var(--text2);margin-top:4px">
    ⏱️ Analysis at \${new Date().toLocaleString()} · Binance Futures · v7 PRO
  </div>
  \`;

  _$('live-results').innerHTML = html;
  _$('live-results').style.display = 'block';
}

// ── Backtest ───────────────────────────────────────────────
async function runBacktest() {
  const coinRaw=_$('bt-coin').value.trim().toUpperCase(), tf=_$('bt-tf').value;
  if(!coinRaw){_$('bt-coin').focus();return;}
  _$('bt-results').style.display='none'; _$('bt-error').style.display='none';
  _$('bt-loading').style.display='block'; _$('bt-btn').disabled=true; _$('bt-btn').textContent='⏳...';
  const msgs=['Downloading 1000 candles...','Replaying v6 indicator engine...','Simulating TP1/TP2/TP3 exits...','Calculating win rate & profit factor...','Building equity curve...'];
  let mi=0; const mt=setInterval(()=>_$('bt-msg').textContent=msgs[Math.min(++mi,msgs.length-1)],3500);
  try {
    const r=await fetch('/app/api/backtest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({coin:coinRaw,timeframe:tf})});
    const d=await r.json(); clearInterval(mt);
    if(!r.ok||!d.ok){_$('bt-loading').style.display='none';_$('bt-error').style.display='block';_$('bt-error').textContent='❌ '+(d.error||'Backtest failed');return;}
    renderBacktest(d.result, coinRaw, tf);
  } catch(e){clearInterval(mt);_$('bt-loading').style.display='none';_$('bt-error').style.display='block';_$('bt-error').textContent='❌ '+e.message;}
  finally{_$('bt-btn').disabled=false;_$('bt-btn').textContent='📊 Run Backtest';}
}

function renderBacktest(r, coin, tf) {
  _$('bt-loading').style.display='none';
  const wr=parseFloat(r.winRate), pf=parseFloat(r.pf)||0, net=parseFloat(r.netR);
  const pfc=pf>=2?'var(--green)':pf>=1.5?'var(--accent)':pf>=1?'var(--yellow)':'var(--red)';
  const wrc=wr>=60?'var(--green)':wr>=50?'var(--yellow)':'var(--red)';
  const grade=pf>=2?'Excellent 🏆':pf>=1.5?'Good ✅':pf>=1?'Marginal ⚠️':'Poor ❌';
  const vMap={excellent:'🔥 Highly tradeable. Strong edge across 1000 candles.',good:'✅ Solid edge. Trade with normal 2% risk sizing.',marginal:'⚠️ Slight edge. Use stricter filters: score ≥ 18 + prime session only.',poor:'❌ Avoid this pair. Try 🌐 Market Scan for better opportunities.'};
  const vKey=pf>=2?'excellent':pf>=1.5?'good':pf>=1?'marginal':'poor';
  const tpD=r.tpBreakdown||{},tot=r.total||1;
  const tpRows=[['TP1 Hits (1.5R)',tpD.tp1||0,'var(--accent)'],['TP2 Hits (3R)',tpD.tp2||0,'var(--green2)'],['TP3 Hits (5R)',tpD.tp3||0,'var(--green)'],['SL Hits (loss)',r.losses,'var(--red)']];
  _$('bt-results').innerHTML=\`
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:18px">
      <div>
        <div style="font-family:var(--font-head);font-size:1.3rem;font-weight:800;color:#fff">\${coin.replace('USDT','')}/USDT — \${tf.toUpperCase()} Backtest</div>
        <div style="font-size:.75rem;color:var(--text2)">v6 · \${r.candleCount||'1000'} candles · TP1/TP2/TP3 partial close</div>
      </div>
      <div style="padding:5px 16px;border-radius:99px;font-size:.82rem;font-weight:700;font-family:var(--font-mono);color:\${pfc};border:1px solid \${pfc}">\${grade}</div>
    </div>
    <div class="res-section" style="background:var(--card)">
      <div style="display:grid;grid-template-columns:auto 1fr;gap:20px;align-items:center">
        <div style="text-align:center;min-width:130px">
          <div style="font-size:.64rem;color:var(--text2);text-transform:uppercase;letter-spacing:.08em;margin-bottom:5px">Win Rate</div>
          <div style="font-family:var(--font-mono);font-size:3.6rem;font-weight:800;line-height:1;color:\${wrc}">\${wr.toFixed(1)}%</div>
          <div style="font-size:.77rem;color:var(--text2);margin-top:5px">\${r.wins} W / \${r.losses} L</div>
        </div>
        <div>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <div style="flex:1;height:12px;background:rgba(255,51,85,.15);border-radius:99px;overflow:hidden">
              <div id="win-bar" style="height:100%;width:0%;background:linear-gradient(90deg,var(--green2),var(--green));border-radius:99px;transition:width 1.2s"></div>
            </div>
            <span style="font-family:var(--font-mono);font-size:.78rem;font-weight:700;color:\${wrc};min-width:40px">\${wr.toFixed(1)}%</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px">
            \${[['Total',r.total,'var(--text)'],['TP Hits',r.wins,'var(--green)'],['SL Hits',r.losses,'var(--red)'],['Long/Short',(r.longT||0)+'L/'+(r.shortT||0)+'S','var(--text)']].map(([l,v,c])=>'<div style="background:var(--card2);border-radius:6px;padding:9px 11px"><div style="font-size:.6rem;color:var(--text2);text-transform:uppercase;margin-bottom:3px">'+l+'</div><div style="font-family:var(--font-mono);font-size:1.1rem;font-weight:700;color:'+c+'">'+v+'</div></div>').join('')}
          </div>
        </div>
      </div>
    </div>
    <div class="res-grid" style="margin-bottom:14px">
      \${[['Profit Factor',r.pf==='∞'?'∞ 🏆':parseFloat(r.pf).toFixed(2),pfc],['Net P&L',( net>=0?'+':'')+net.toFixed(2)+'R',net>=0?'var(--green)':'var(--red)'],['Gross Wins','+'+r.gW+'R','var(--green)'],['Gross Losses','-'+r.gL+'R','var(--red)'],['Max Drawdown',r.maxDD+'R','var(--red)'],['Max Consec. L',r.maxCL,'var(--red)']].map(([l,v,c])=>'<div class="res-item"><div class="res-item-label">'+l+'</div><div class="res-item-val" style="color:'+c+';font-size:1.25rem">'+v+'</div></div>').join('')}
    </div>
    <div class="res-section">
      <div class="res-section-title">🎯 TP Simulation Breakdown</div>
      <div style="display:grid;gap:9px">
        \${tpRows.map(([l,cnt,col])=>{const pct=(cnt/tot*100);return '<div><div style="display:flex;justify-content:space-between;margin-bottom:3px"><span style="font-size:.72rem;color:var(--text2)">'+l+'</span><span style="font-family:var(--font-mono);font-size:.72rem">'+cnt+' ('+pct.toFixed(1)+'%)</span></div><div style="height:7px;background:var(--border);border-radius:99px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:'+col+';border-radius:99px;transition:width 1s"></div></div></div>';}).join('')}
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div class="res-section" style="margin-bottom:0">
        <div class="res-section-title">🏆 Trade Extremes</div>
        \${[['Best Trade',r.best?(r.best.pnlR>=0?'+':'')+parseFloat(r.best.pnlR).toFixed(2)+'R ('+( r.best.dir==='L'?'LONG':'SHORT')+')':'—','c-green'],['Worst Trade',r.worst?(r.worst.pnlR>=0?'+':'')+parseFloat(r.worst.pnlR).toFixed(2)+'R ('+( r.worst.dir==='L'?'LONG':'SHORT')+')':'—','c-red']].map(([l,v,c])=>'<div class="conf-row"><span>'+l+'</span><span class="'+c+'" style="font-family:var(--font-mono);font-size:.78rem">'+v+'</span></div>').join('')}
      </div>
      <div class="res-section" style="margin-bottom:0">
        <div class="res-section-title">📋 Strategy Verdict</div>
        <div style="font-size:.85rem;line-height:1.65;color:var(--text)">\${vMap[vKey]}</div>
        <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border);font-size:.75rem;color:\${pfc};font-weight:600">Grade: \${grade}</div>
      </div>
    </div>
    <div style="text-align:center;font-size:.7rem;color:var(--text2);margin-top:12px">⚠️ Past performance ≠ future results. Backtest uses idealized fill prices.</div>
  \`;
  _$('bt-results').style.display='block';
  setTimeout(()=>{const b=_$('win-bar');if(b)b.style.width=Math.min(wr,100)+'%';},100);
}

// ── Scan Backtest ──────────────────────────────────────────
async function runScanBacktest() {
  const tf=_$('sbt-tf').value, limit=_$('sbt-limit').value;
  _$('sbt-results').style.display='none'; _$('sbt-error').style.display='none';
  _$('sbt-loading').style.display='block'; _$('sbt-btn').disabled=true; _$('sbt-btn').textContent='⏳...';
  const msgs=['Downloading candles...','Running backtest engine...','Ranking coins...'];
  let mi=0; const mt=setInterval(()=>_$('sbt-msg').textContent=msgs[Math.min(++mi,msgs.length-1)],4000);
  try {
    const r=await fetch('/app/api/scanbacktest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({timeframe:tf,limit})});
    const d=await r.json(); clearInterval(mt);
    if(!r.ok||!d.ok){_$('sbt-loading').style.display='none';_$('sbt-error').style.display='block';_$('sbt-error').textContent='❌ '+(d.error||'Failed');return;}
    renderScanBacktest(d);
  } catch(e){clearInterval(mt);_$('sbt-loading').style.display='none';_$('sbt-error').style.display='block';_$('sbt-error').textContent='❌ '+e.message;}
  finally{_$('sbt-btn').disabled=false;_$('sbt-btn').textContent='🌐 Scan All';}
}

function renderScanBacktest(d) {
  _$('sbt-loading').style.display='none';
  const rows=d.results.filter(r=>!r.error);
  _$('sbt-results').innerHTML=\`
    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">🌐 Scan Backtest — \${d.timeframe?.toUpperCase()} · \${d.scanned} coins</div>
        <div style="font-size:.75rem;color:var(--text2)">Ranked by Win Rate · Best pairs for this strategy</div>
      </div>
      <div style="padding:8px 0">
        \${rows.map((r,i)=>{
          const wr=parseFloat(r.winRate)||0,wrc=wr>=60?'var(--green)':wr>=50?'var(--accent)':wr>=40?'var(--yellow)':'var(--red)';
          const rec=r.recommended;
          return '<div class="sbt-row">'+
            '<div class="sbt-rank">'+(i+1)+'</div>'+
            '<div style="min-width:60px"><div style="font-family:var(--font-head);font-size:.95rem;font-weight:700;color:#fff">'+r.coin+'</div></div>'+
            '<div style="flex:1"><div style="font-size:.7rem;color:var(--text2);margin-bottom:3px">Win Rate</div><div style="display:flex;align-items:center;gap:8px"><div class="sbt-wr-bar"><div class="sbt-wr-fill" style="width:'+Math.min(wr,100)+'%;background:'+wrc+'"></div></div><span style="font-family:var(--font-mono);font-size:.82rem;font-weight:700;color:'+wrc+'">'+wr.toFixed(1)+'%</span></div></div>'+
            '<div style="min-width:50px;text-align:center"><div style="font-size:.62rem;color:var(--text2)">PF</div><div style="font-family:var(--font-mono);font-size:.82rem;font-weight:700;color:'+r.gradeColor+'">'+r.pf+'</div></div>'+
            '<div style="min-width:50px;text-align:center"><div style="font-size:.62rem;color:var(--text2)">Trades</div><div style="font-family:var(--font-mono);font-size:.82rem">'+r.total+'</div></div>'+
            '<div style="min-width:80px;text-align:center"><div style="padding:3px 8px;border-radius:99px;font-size:.68rem;font-weight:700;color:'+r.gradeColor+';border:1px solid '+r.gradeColor+';font-family:var(--font-mono)">'+r.grade+'</div></div>'+
            (rec?'<button class="btn btn-primary btn-sm" onclick="loadToScanner(\''+r.coin+'\')">⚡ Analyse</button>':'<button class="btn btn-ghost btn-sm" style="opacity:.5" disabled>Skip</button>')+
          '</div>';
        }).join('')}
      </div>
    </div>
  \`;
  _$('sbt-results').style.display='block';
}

function loadToScanner(coin) {
  _$('coin-input').value=coin;
  switchTab('live');
  setTimeout(runLiveScan, 100);
}

// ── Quick Market Scanner (inside Live Analysis panel) ─────────
async function quickMarketScan() {
  var btn = document.getElementById('qs-btn');
  btn.disabled = true; btn.textContent = '⏳ Scanning...';
  document.getElementById('qs-loading').style.display   = 'block';
  document.getElementById('qs-error').style.display     = 'none';
  document.getElementById('qs-empty').style.display     = 'none';
  document.getElementById('qs-sentiment').style.display = 'none';
  var grid = document.getElementById('qs-grid');
  grid.innerHTML = ''; grid.style.display = 'none';

  var msgs = ['Scanning top 30 coins...','14-Factor SMC analysis...','Applying quality gate...','Ranking best setups...'];
  var mi = 0;
  var mt = setInterval(function(){ document.getElementById('qs-msg').textContent = msgs[mi%msgs.length]; mi++; }, 3500);

  try {
    var r = await fetch('/app/api/market-scan');
    var d = await r.json();
    clearInterval(mt);
    document.getElementById('qs-loading').style.display = 'none';

    if (!r.ok || !d.ok) {
      document.getElementById('qs-error').style.display = 'block';
      document.getElementById('qs-error').textContent = '❌ ' + (d.error || 'Scan failed');
      return;
    }

    // Sentiment
    var sn = d.sentiment || {};
    var ns = parseInt(sn.newsScore || 0);
    var nc = ns > 0 ? 'var(--green)' : ns < 0 ? 'var(--red)' : 'var(--text2)';
    document.getElementById('qs-overall').textContent   = sn.overall || '—';
    document.getElementById('qs-fng-el').innerHTML = (sn.fngEmoji||'') + ' F&G: <b style="color:var(--accent)">' + (sn.fngValue||'—') + '</b>';
    document.getElementById('qs-btcdom').textContent    = sn.btcDom || '—';
    document.getElementById('qs-news').innerHTML = '<span style="color:'+nc+'">'+(ns>=0?'+':'')+ns+'</span>';
    document.getElementById('qs-meta').textContent = d.setups.length + ' setups from ' + d.scanned + ' coins · ' + new Date(d.ts).toLocaleTimeString();
    document.getElementById('qs-sentiment').style.display = 'block';

    if (!d.setups || !d.setups.length) {
      document.getElementById('qs-empty').style.display = 'block';
      return;
    }

    d.setups.forEach(function(s, i) {
      var isL = s.direction === 'LONG';
      var dc  = isL ? 'var(--green)' : 'var(--red)';
      var sc  = sCol(s.score);
      var sPct = Math.min((s.score/(s.maxScore||100))*100, 100).toFixed(1);
      var rrC = parseFloat(s.rrr||0)>=2?'var(--green)':parseFloat(s.rrr||0)>=1?'var(--yellow)':'var(--red)';
      var confTotal = s.confScore||s.coreConf||0;
      var confMax   = s.confScore ? 21 : 4;

      // SMC signal tags
      var tags = '';
      if(s.liquiditySweep && s.liquiditySweep!=='None')
        tags += '<span style="font-size:.6rem;padding:2px 6px;border-radius:3px;background:rgba(0,200,255,.08);color:var(--accent)">💧 Sweep</span> ';
      if(s.choch && s.choch!=='None')
        tags += '<span style="font-size:.6rem;padding:2px 6px;border-radius:3px;background:rgba(0,200,255,.08);color:var(--accent)">🔄 ChoCH</span> ';
      if(s.choch5m && s.choch5m!=='None')
        tags += '<span style="font-size:.6rem;padding:2px 6px;border-radius:3px;background:rgba(0,200,255,.08);color:var(--accent)">⚡ 5m ChoCH</span> ';
      if(s.tf3Align && s.tf3Align.aligned)
        tags += '<span style="font-size:.6rem;padding:2px 6px;border-radius:3px;background:rgba(0,230,118,.08);color:var(--green)">✅ 3TF Aligned</span> ';
      if(s.bbSqueeze && s.bbSqueeze.exploding)
        tags += '<span style="font-size:.6rem;padding:2px 6px;border-radius:3px;background:rgba(0,230,118,.08);color:var(--green)">💥 BB Explode</span> ';
      if(s.mmTrap && (s.mmTrap.bullTrap||s.mmTrap.bearTrap))
        tags += '<span style="font-size:.6rem;padding:2px 6px;border-radius:3px;background:rgba(255,171,0,.1);color:var(--yellow)">🪤 MM Trap</span> ';
      if(s.dailyTrend)
        tags += '<span style="font-size:.6rem;padding:2px 6px;border-radius:3px;background:rgba(255,255,255,.05);color:var(--text2)">'+(s.dailyAligned?'✅':'⚠️')+' Daily '+s.dailyTrend+'</span> ';

      var orderBadge = s.orderType&&s.orderType.includes('LIMIT')
        ? '<span style="font-size:.6rem;padding:1px 6px;border-radius:3px;background:rgba(255,171,0,.12);color:var(--yellow);font-family:var(--font-mono)">⏳ LIMIT</span>'
        : '<span style="font-size:.6rem;padding:1px 6px;border-radius:3px;background:rgba(0,200,255,.08);color:var(--accent);font-family:var(--font-mono)">⚡ MARKET</span>';

      var reasons = (s.reasons||'').split(',').slice(0,5).map(function(r){
        return '<span style="font-size:.6rem;padding:1px 5px;border-radius:3px;background:rgba(255,255,255,.04);color:var(--text2)">'+r.trim()+'</span>';
      }).join(' ');

      var card = document.createElement('div');
      card.style.cssText = 'background:var(--card2);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;border-left:3px solid '+(isL?'var(--green)':'var(--red)')+';transition:.15s';
      card.onmouseover = function(){ this.style.borderColor = isL?'var(--green)':'var(--red)'; this.style.transform='translateY(-1px)'; this.style.boxShadow='0 4px 16px rgba(0,0,0,.3)'; };
      card.onmouseout  = function(){ this.style.transform=''; this.style.boxShadow=''; };

      card.innerHTML =
        // ── Header row ──
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:9px">'
        +'<div style="display:flex;align-items:center;gap:7px">'
        +'<span style="font-family:var(--font-mono);font-size:.65rem;color:var(--text2);background:rgba(0,0,0,.3);padding:1px 5px;border-radius:3px">#'+(i+1)+'</span>'
        +'<span style="font-family:var(--font-head);font-size:1.05rem;font-weight:800;color:#fff">'+s.coin+'</span>'
        +'<span style="font-size:.72rem;font-weight:700;padding:2px 10px;border-radius:99px;background:'+(isL?'rgba(0,230,118,.12)':'rgba(255,51,85,.12)')+';color:'+dc+'">'+(isL?'▲ LONG':'▼ SHORT')+'</span>'
        +(s.sentEmoji?'<span style="font-size:.8rem">'+s.sentEmoji+'</span>':'')
        +orderBadge
        +'</div>'
        +'<div style="text-align:right">'
        +'<div style="font-family:var(--font-mono);font-size:.82rem;font-weight:700;color:'+sc+'">'+s.score+'/'+(s.maxScore||100)+' ⭐</div>'
        +'<div style="font-size:.6rem;color:var(--text2)">ADX '+(s.adx?parseFloat(s.adx).toFixed(1):'—')+' · RSI '+(s.rsi?parseFloat(s.rsi).toFixed(0):'—')+'</div>'
        +'</div>'
        +'</div>'

        // ── Score bar ──
        +'<div style="height:3px;background:var(--border);border-radius:99px;margin-bottom:11px;overflow:hidden">'
        +'<div style="height:100%;width:'+sPct+'%;background:'+sc+';border-radius:99px"></div>'
        +'</div>'

        // ── Price levels ──
        +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:9px">'
        +'<div style="background:rgba(0,0,0,.2);border-radius:5px;padding:7px 9px;grid-column:span 1">'
        +'<div style="font-size:.58rem;color:var(--text2)">📍 Entry</div>'
        +'<div style="font-family:var(--font-mono);font-size:.88rem;font-weight:600;color:var(--accent)">'+fmtP(s.entryPrice)+'</div>'
        +'</div>'
        +'<div style="background:rgba(0,0,0,.2);border-radius:5px;padding:7px 9px">'
        +'<div style="font-size:.58rem;color:var(--text2)">🛡️ SL</div>'
        +'<div style="font-family:var(--font-mono);font-size:.88rem;font-weight:600;color:var(--red)">'+fmtP(s.sl)+'</div>'
        +'</div>'
        +'</div>'
        +'<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:9px">'
        +'<div style="text-align:center;background:rgba(0,0,0,.2);border-radius:5px;padding:6px 4px">'
        +'<div style="font-size:.57rem;color:var(--text2)">TP1</div>'
        +'<div style="font-family:var(--font-mono);font-size:.74rem;color:var(--green)">'+fmtP(s.tp1)+'</div>'
        +'</div>'
        +'<div style="text-align:center;background:rgba(0,0,0,.2);border-radius:5px;padding:6px 4px">'
        +'<div style="font-size:.57rem;color:var(--text2)">TP2</div>'
        +'<div style="font-family:var(--font-mono);font-size:.74rem;color:var(--green)">'+fmtP(s.tp2)+'</div>'
        +'</div>'
        +'<div style="text-align:center;background:rgba(0,0,0,.2);border-radius:5px;padding:6px 4px">'
        +'<div style="font-size:.57rem;color:var(--text2)">TP3</div>'
        +'<div style="font-family:var(--font-mono);font-size:.74rem;color:var(--green)">'+fmtP(s.tp3)+'</div>'
        +'</div>'
        +'</div>'

        // ── RRR + Confirmations ──
        +'<div style="display:flex;gap:10px;margin-bottom:9px">'
        +'<div style="background:rgba(0,0,0,.2);border-radius:5px;padding:6px 9px;flex:1">'
        +'<div style="font-size:.57rem;color:var(--text2)">⚖️ RRR</div>'
        +'<div style="font-family:var(--font-mono);font-size:.82rem;font-weight:600;color:'+rrC+'">1:'+(s.rrr||'—')+'</div>'
        +'</div>'
        +'<div style="background:rgba(0,0,0,.2);border-radius:5px;padding:6px 9px;flex:1">'
        +'<div style="font-size:.57rem;color:var(--text2)">⚡ Leverage</div>'
        +'<div style="font-family:var(--font-mono);font-size:.82rem;font-weight:600;color:var(--yellow)">Cross '+(s.leverage||'—')+'x</div>'
        +'</div>'
        +'<div style="background:rgba(0,0,0,.2);border-radius:5px;padding:6px 9px;flex:1">'
        +'<div style="font-size:.57rem;color:var(--text2)">🔒 Confirms</div>'
        +'<div style="font-family:var(--font-mono);font-size:.82rem;font-weight:600;color:'+(s.confGate?'var(--green)':'var(--text2)')+'">'+confTotal+'/'+confMax+' '+(s.confGate?'✅':'')+'</div>'
        +'</div>'
        +'</div>'

        // ── Confluence reasons ──
        +(reasons?'<div style="margin-bottom:8px;display:flex;flex-wrap:wrap;gap:3px">'+reasons+'</div>':'')

        // ── SMC signal tags ──
        +(tags?'<div style="margin-bottom:10px">'+tags+'</div>':'')

        // ── Deep Analyse link ──
        +'<div style="padding-top:10px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">'
        +'<div style="font-size:.68rem;color:var(--text2)">'+(s.session||'')+''+(s.sessionQuality?' · <span style="color:var(--accent)">'+s.sessionQuality+'</span>':'')+''+(s.marketState?' · '+s.marketState:'')+'</div>'
        +'<button class="btn btn-primary btn-sm" style="font-size:.72rem" onclick="(function(){'
        +'  document.getElementById(\'coin-input\').value=\''+s.coin+'\';'
        +'  document.getElementById(\'tf-select\').value=\'15m\';'
        +'  document.getElementById(\'qs-panel\').scrollIntoView({behavior:\'smooth\'});'
        +'  setTimeout(function(){runLiveScan();},300);'
        +'})()">⚡ Deep Analyse →</button>'
        +'</div>';

      grid.appendChild(card);
    });

    grid.style.display = 'grid';

  } catch(e) {
    clearInterval(mt);
    document.getElementById('qs-loading').style.display = 'none';
    document.getElementById('qs-error').style.display   = 'block';
    document.getElementById('qs-error').textContent = '❌ ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = '🔍 Scan Top 30';
  }
}


document.addEventListener('DOMContentLoaded', () => {
  // Auto-run deep analysis if ?coin= is in URL (from market scanner links)
  var urlCoin = new URLSearchParams(window.location.search).get('coin');
  if (urlCoin) {
    _$('coin-input').value = urlCoin.toUpperCase().replace(/[^A-Z0-9]/g,'');
    setTimeout(runLiveScan, 400);
  }
  _$('coin-input')?.addEventListener('keydown', e => { if(e.key==='Enter') runLiveScan(); });
  _$('coin-input')?.addEventListener('input',   e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''); });
  _$('bt-coin')?.addEventListener('keydown',    e => { if(e.key==='Enter') runBacktest(); });
  _$('bt-coin')?.addEventListener('input',      e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''); });
});
</script>
`, ``));
});

// ══════════════════════════════════════════════════════════════
//  /app/market — Standalone Market Scanner Page
//  Auto-runs on load · Full .scan parity · Deep Analyse link
// ══════════════════════════════════════════════════════════════
app.get('/app/market', saasAuth.requireUserAuth, (req, res) => {
    const user = req.saasUser;
    res.send(_html('Market Scanner', `
${_appNav('market', user.username)}
<div class="wrap">
  <h1 class="page-title">🔍 Market Scanner <span>Top 30 Coins · 14-Factor SMC + ICT · Auto Quality Gate</span></h1>

  <div class="panel" style="border-color:rgba(0,200,255,.2)">
    <div class="panel-head" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
      <div>
        <div class="panel-title">
          🌐 Best Trade Setups Right Now
          <span id="s-badge" style="font-size:.65rem;padding:2px 10px;border-radius:99px;background:rgba(255,171,0,.1);color:var(--yellow);border:1px solid rgba(255,171,0,.3);margin-left:8px">LOADING...</span>
        </div>
        <div style="font-size:.7rem;color:var(--text2);margin-top:2px">Quality gate · Sentiment overlay · .scan parity · Auto scans on load</div>
      </div>
      <button id="s-btn" onclick="doScan()" class="btn btn-primary" style="padding:9px 24px;font-weight:700">⚡ Scan Now</button>
    </div>

    <div id="s-sentiment" style="display:none;padding:10px 20px;border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
      <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center">
        <span style="font-size:.78rem">🧠 <b id="s-overall">—</b></span>
        <span style="font-size:.78rem" id="s-fng">—</span>
        <span style="font-size:.78rem">₿ BTC.D: <b id="s-btcdom">—</b>%</span>
        <span style="font-size:.78rem">📰 News: <b id="s-news">—</b></span>
        <span style="font-size:.7rem;color:var(--text2);margin-left:auto" id="s-meta"></span>
      </div>
    </div>

    <div id="s-loading" style="padding:50px 20px;text-align:center">
      <div style="font-size:2.8rem;animation:spin 1.2s linear infinite;display:inline-block">🔍</div>
      <div style="margin-top:12px;font-size:.92rem;color:var(--text);font-weight:600" id="s-msg">Scanning top 30 coins...</div>
      <div style="margin-top:4px;font-size:.72rem;color:var(--text2)">14-Factor SMC + ICT · Quality Gate · Sentiment</div>
    </div>
    <div id="s-error" style="display:none;color:var(--red);padding:20px;font-size:.88rem"></div>
    <div id="s-empty" style="display:none;padding:44px 20px;text-align:center;color:var(--text2)">
      <div style="font-size:2.5rem;margin-bottom:10px">🔍</div>
      <div style="font-size:.92rem;font-weight:600;margin-bottom:5px">High-quality setups නෑ</div>
      <div style="font-size:.78rem">Score 20+ සහ SMC confirmation pass setups නෑ. Next 15m candle close වෙනකල් wait.</div>
      <button class="btn btn-ghost" style="margin-top:16px" onclick="doScan()">↺ Try Again</button>
    </div>
    <div id="s-results" style="display:none;padding:16px 20px 20px">
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px" id="s-grid"></div>
    </div>
  </div>
</div>

<style>
.s-card{border-radius:var(--radius);border:1px solid var(--border);padding:16px;background:var(--card);transition:.18s}
.s-card:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.35)}
.s-long{border-left:4px solid var(--green)}.s-short{border-left:4px solid var(--red)}
.s-tag{font-size:.6rem;padding:2px 7px;border-radius:3px;display:inline-block;margin:1px}
.s-smc{background:rgba(0,200,255,.08);color:var(--accent)}
.s-hot{background:rgba(0,230,118,.08);color:var(--green)}
.s-warn{background:rgba(255,171,0,.1);color:var(--yellow)}
</style>

<script>
async function doScan() {
  var btn   = document.getElementById('s-btn');
  var badge = document.getElementById('s-badge');
  btn.disabled = true;
  btn.textContent = '⏳...';
  badge.textContent = 'SCANNING';
  badge.style.background = 'rgba(255,171,0,.1)';
  badge.style.color = 'var(--yellow)';
  badge.style.borderColor = 'rgba(255,171,0,.3)';
  document.getElementById('s-sentiment').style.display = 'none';
  document.getElementById('s-results').style.display   = 'none';
  document.getElementById('s-empty').style.display     = 'none';
  document.getElementById('s-error').style.display     = 'none';
  document.getElementById('s-loading').style.display   = 'block';

  var msgs = ['Scanning top 30 coins...','14-Factor SMC + ICT analysis...','Applying quality gate...','Sentiment overlay...','Ranking best 5 setups...'];
  var mi = 0;
  var mt = setInterval(function() {
    document.getElementById('s-msg').textContent = msgs[mi % msgs.length]; mi++;
  }, 3000);

  try {
    var resp = await fetch('/app/api/market-scan');
    var data = await resp.json();
    clearInterval(mt);
    document.getElementById('s-loading').style.display = 'none';

    if (!resp.ok || !data.ok) {
      document.getElementById('s-error').style.display = 'block';
      document.getElementById('s-error').textContent = 'Error: ' + (data.error || 'Scan failed');
      badge.textContent = 'ERROR';
      badge.style.color = 'var(--red)';
      badge.style.borderColor = 'rgba(255,51,85,.3)';
      return;
    }

    // Sentiment bar
    var sn = data.sentiment || {};
    var ns = parseInt(sn.newsScore || 0);
    var nc = ns > 0 ? 'var(--green)' : ns < 0 ? 'var(--red)' : 'var(--text2)';
    document.getElementById('s-overall').textContent = sn.overall || '—';
    document.getElementById('s-fng').innerHTML = (sn.fngEmoji || '') + ' F&G: <b style="color:var(--accent)">' + (sn.fngValue || '—') + '</b>';
    document.getElementById('s-btcdom').textContent = sn.btcDom || '—';
    document.getElementById('s-news').innerHTML = '<span style="color:' + nc + '">' + (ns >= 0 ? '+' : '') + ns + '</span>';
    document.getElementById('s-meta').textContent = data.setups.length + ' setups · ' + data.scanned + ' coins · ' + new Date(data.ts).toLocaleTimeString();
    document.getElementById('s-sentiment').style.display = 'block';

    if (!data.setups || !data.setups.length) {
      document.getElementById('s-empty').style.display = 'block';
      badge.textContent = 'NO SETUPS';
      badge.style.color = 'var(--text2)';
      badge.style.background = 'rgba(255,255,255,.05)';
      badge.style.borderColor = 'var(--border)';
      return;
    }

    var grid = document.getElementById('s-grid');
    grid.innerHTML = '';

    data.setups.forEach(function(s, i) {
      var isL  = s.direction === 'LONG';
      var dc   = isL ? 'var(--green)' : 'var(--red)';
      var sc   = s.score >= 70 ? 'var(--green)' : s.score >= 45 ? 'var(--yellow)' : 'var(--red)';
      var sPct = Math.min((s.score / (s.maxScore || 100)) * 100, 100).toFixed(0);

      var reasons = (s.reasons || '').split(',').slice(0, 4).map(function(r) {
        return '<div style="font-size:.62rem;color:var(--text2)">• ' + r.trim() + '</div>';
      }).join('');

      var tags = '';
      if (s.liquiditySweep && s.liquiditySweep !== 'None') tags += '<span class="s-tag s-smc">💧 Sweep</span>';
      if (s.choch && s.choch !== 'None')                   tags += '<span class="s-tag s-smc">🔄 ChoCH</span>';
      if (s.choch5m && s.choch5m !== 'None')               tags += '<span class="s-tag s-smc">⚡ 5m ChoCH</span>';
      if (s.tf3Align && s.tf3Align.aligned)                tags += '<span class="s-tag s-hot">✅ 3TF</span>';
      if (s.bbSqueeze && s.bbSqueeze.exploding)            tags += '<span class="s-tag s-hot">💥 BB Explode</span>';
      if (s.mmTrap && (s.mmTrap.bullTrap || s.mmTrap.bearTrap)) tags += '<span class="s-tag s-warn">🪤 Trap</span>';
      if (s.dailyTrend) tags += '<span class="s-tag" style="background:rgba(255,255,255,.05);color:var(--text2)">' + (s.dailyAligned ? '✅' : '⚠️') + ' ' + s.dailyTrend + '</span>';

      var card = document.createElement('div');
      card.className = 's-card ' + (isL ? 's-long' : 's-short');
      card.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">'
        + '<div style="display:flex;align-items:center;gap:7px">'
        + '<span style="font-family:var(--font-mono);font-size:.62rem;color:var(--text2);background:var(--card2);padding:1px 5px;border-radius:3px">#' + (i + 1) + '</span>'
        + '<span style="font-family:var(--font-head);font-size:1.12rem;font-weight:800;color:#fff">' + s.coin + '</span>'
        + '<span style="font-size:.72rem;font-weight:700;padding:2px 10px;border-radius:99px;background:' + (isL ? 'rgba(0,230,118,.12)' : 'rgba(255,51,85,.12)') + ';color:' + dc + '">' + (isL ? '▲ LONG' : '▼ SHORT') + '</span>'
        + (s.sentEmoji ? '<span style="font-size:.8rem">' + s.sentEmoji + '</span>' : '')
        + '</div>'
        + '<div style="text-align:right">'
        + '<div style="font-family:var(--font-mono);font-size:.82rem;font-weight:700;color:' + sc + '">' + s.score + '/' + (s.maxScore || 100) + ' ⭐</div>'
        + '<div style="font-size:.6rem;color:var(--text2)">ADX ' + (s.adx ? parseFloat(s.adx).toFixed(1) : '—') + ' · RSI ' + (s.rsi ? parseFloat(s.rsi).toFixed(0) : '—') + '</div>'
        + '</div>'
        + '</div>'
        + '<div style="height:4px;background:var(--border);border-radius:99px;margin-bottom:12px;overflow:hidden">'
        + '<div style="height:100%;width:' + sPct + '%;background:' + sc + ';border-radius:99px"></div>'
        + '</div>'
        + '<div style="margin-bottom:9px">' + reasons + '</div>'
        + (tags ? '<div style="margin-bottom:10px">' + tags + '</div>' : '')
        + '<div style="font-size:.62rem;color:var(--text2);margin-bottom:12px">'
        + '🔒 ' + (s.confScore || s.coreConf || 0) + '/' + (s.confScore ? 21 : 4) + ' confirms ' + (s.confGate ? '✅' : '')
        + (s.orderType && s.orderType.includes('LIMIT') ? ' · ⏳ LIMIT' : ' · ⚡ MARKET')
        + (s.tradeCategory ? ' · ' + s.tradeCategory : '')
        + '</div>'
        + '<a href="/app/scanner?coin=' + s.coin + '" class="btn btn-primary" style="display:block;width:100%;padding:9px;font-size:.8rem;font-weight:700;text-align:center;text-decoration:none">⚡ Deep Scanner →</a>';

      grid.appendChild(card);
    });

    document.getElementById('s-results').style.display = 'block';
    badge.textContent = '✅ ' + data.setups.length + ' Setups Found';
    badge.style.background = 'rgba(0,230,118,.08)';
    badge.style.color = 'var(--green)';
    badge.style.borderColor = 'rgba(0,230,118,.3)';

  } catch (e) {
    clearInterval(mt);
    document.getElementById('s-loading').style.display = 'none';
    document.getElementById('s-error').style.display   = 'block';
    document.getElementById('s-error').textContent = 'Network error: ' + e.message;
    badge.textContent = 'ERROR';
    badge.style.color = 'var(--red)';
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ Scan Now';
  }
}

document.addEventListener('DOMContentLoaded', function() { doScan(); });
</script>`));
});



// ─── /app/analyzer — serve same as /app/market (not redirect) ──
app.get('/app/analyzer', saasAuth.requireUserAuth, (req, res) => {
    res.redirect(302, '/app/market');
});


}; // end module.exports
