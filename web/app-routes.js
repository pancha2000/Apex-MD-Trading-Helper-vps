'use strict';
/**
 * APEX-MD · app-routes.js  (CLEAN REWRITE)
 * ══════════════════════════════════════════════════════════════
 *  All /app/* page routes → renderView()  (no HTML strings)
 *  All /app/api/* routes  → res.json()    (unchanged logic)
 * ══════════════════════════════════════════════════════════════
 */

module.exports = function registerApp({ saasAuth, db, config, axios, renderView, fmtPrice, fmtPct, scoreColor }, app) {

const mongoose = require('mongoose');

// ─── Extra models ──────────────────────────────────────────────────────
const AlertSchema = new mongoose.Schema({
    userJid:     { type: String, required: true },
    userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'SaasUser', default: null },
    coin:        { type: String, required: true },
    targetPrice: { type: Number, required: true },
    condition:   { type: String, enum: ['above','below'], required: true },
    triggered:   { type: Boolean, default: false },
    createdAt:   { type: Date, default: Date.now },
});
const WatchlistSchema = new mongoose.Schema({
    userJid: { type: String, required: true, unique: true },
    userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'SaasUser', default: null },
    coins:   { type: [String], default: [] },
});
const Alert     = mongoose.models.Alert     || mongoose.model('Alert',     AlertSchema);
const Watchlist = mongoose.models.Watchlist || mongoose.model('Watchlist', WatchlistSchema);

function withTimeout(p, ms, fb) { return Promise.race([p, new Promise(r => setTimeout(() => r(fb), ms))]); }

// ════════════════════════════════════════════════════════════════════════
//  PAGE ROUTES  (data only — HTML lives in views/app/*.html)
// ════════════════════════════════════════════════════════════════════════

// ─── /app/ Home ─────────────────────────────────────────────────────────
app.get('/app/', saasAuth.requireUserAuth, async (req, res) => {
    const user = req.saasUser;
    let activeTrades=[], closedCount=0, winRate='—', paperBalance=0, alertCount=0, watchCount=0;
    try {
        activeTrades = await db.getSaasUserActiveTrades(user.userId);
        const closed = await db.getSaasUserTradeHistory(user.userId, 200);
        closedCount = closed.length;
        if (closed.length) { const wins=closed.filter(t=>t.result==='WIN').length; winRate=((wins/closed.length)*100).toFixed(1)+'%'; }
        const fullUser = await db.getSaasUserById(user.userId);
        if (fullUser?.whatsappJid) {
            const wu = await db.getUser(fullUser.whatsappJid).catch(()=>null);
            if (wu) paperBalance = wu.paperBalance||0;
            const wl = await Watchlist.findOne({userJid:fullUser.whatsappJid}).catch(()=>null);
            if (wl) watchCount = wl.coins?.length||0;
            alertCount = await Alert.countDocuments({userJid:fullUser.whatsappJid,triggered:false}).catch(()=>0);
        }
    } catch(_){}
    res.send(renderView('app/home', {
        username: user.username,
        forbidden: Boolean(req.query.forbidden),
        activeTrades: activeTrades.map(t => ({
            coin: t.coin, direction: t.direction,
            entry: fmtPrice(t.entry), tp2: fmtPrice(t.tp2||t.tp),
            sl: fmtPrice(t.sl), leverage: t.leverage||1, status: t.status,
            ageHrs: ((Date.now()-new Date(t.openTime))/3600000).toFixed(1),
        })),
        stats: { activeCount: activeTrades.length, winRate, closedCount, paperBalance: parseFloat(paperBalance).toFixed(2), watchCount, alertCount },
    }));
});

// ─── /app/trades ────────────────────────────────────────────────────────
app.get('/app/trades', saasAuth.requireUserAuth, async (req, res) => {
    const user = req.saasUser;
    let activeTrades=[], closedTrades=[], totalPnl=0, wins=0;
    try {
        activeTrades = (await db.getSaasUserActiveTrades(user.userId)).map(t => ({
            _id: t._id.toString(),
            coin: t.coin, direction: t.direction,
            entry: fmtPrice(t.entry), tp1: fmtPrice(t.tp1), tp2: fmtPrice(t.tp2||t.tp),
            sl: fmtPrice(t.sl), leverage: t.leverage||1, status: t.status,
            ageHrs: ((Date.now()-new Date(t.openTime))/3600000).toFixed(1),
        }));
        const closed = await db.getSaasUserTradeHistory(user.userId, 100);
        closed.forEach(t=>{ totalPnl+=t.pnlPct||0; if(t.result==='WIN') wins++; });
        closedTrades = closed.map(t => ({
            _id: t._id.toString(),
            coin: t.coin, direction: t.direction,
            entry: fmtPrice(t.entry), tp2: fmtPrice(t.tp2||t.tp), sl: fmtPrice(t.sl),
            result: t.result, pnlPct: t.pnlPct||0,
            closedAt: t.closedAt ? new Date(t.closedAt).toLocaleDateString() : '—',
        }));
    } catch(_){}
    const totalClosed = closedTrades.length;
    // Auto-cleanup: delete closed trades older than 7 days
    try {
        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        await db.Trade.deleteMany({ userId: user.userId, status: 'closed', closedAt: { $lt: cutoff } });
    } catch(_) {}
    res.send(renderView('app/trades', {
        activeTrades, closedTrades,
        summary: {
            totalClosed,
            winRate: totalClosed>0 ? ((wins/totalClosed)*100).toFixed(1)+'%' : '—',
            totalPnl: totalPnl.toFixed(2),
        },
    }));
});

// ─── /app/paper ─────────────────────────────────────────────────────────
app.get('/app/paper', saasAuth.requireUserAuth, async (req, res) => {
    const user = req.saasUser;
    let paperBalance=0, paperStart=100, wins=0, losses=0, activePaper=[], closedPaper=[], waLinked=false;
    try {
        const fullUser = await db.getSaasUserById(user.userId);
        const waJid = fullUser?.whatsappJid||'';
        waLinked = Boolean(waJid);
        if (waJid) {
            const wu = await db.getUser(waJid).catch(()=>null);
            if (wu) { paperBalance=wu.paperBalance||0; paperStart=wu.paperStartBalance||100; wins=wu.paperWins||0; losses=wu.paperLosses||0; }
            activePaper = (await db.Trade.find({userJid:waJid,isPaper:true,status:{$in:['active','pending']}}).sort({openTime:-1}).lean()).map(t=>({
                _id: t._id.toString(), coin: t.coin.replace('USDT',''), direction: t.direction,
                entry: fmtPrice(t.entry), tp1: fmtPrice(t.tp1), tp2: fmtPrice(t.tp2||t.tp),
                sl: fmtPrice(t.sl), leverage: t.leverage||1, status: t.status,
                ageHrs: ((Date.now()-new Date(t.openTime))/3600000).toFixed(1),
            }));
            closedPaper = (await db.Trade.find({userJid:waJid,isPaper:true,status:'closed'}).sort({closedAt:-1}).limit(30).lean()).map(t=>({
                coin: t.coin.replace('USDT',''), direction: t.direction,
                entry: fmtPrice(t.entry), tp2: fmtPrice(t.tp2||t.tp), sl: fmtPrice(t.sl),
                result: t.result, profit: t.paperProfit ? (t.paperProfit>=0?'+':'')+t.paperProfit.toFixed(2) : '—',
                profitColor: t.paperProfit>0?'var(--green)':t.paperProfit<0?'var(--red)':'var(--text2)',
            }));
        }
    } catch(_){}
    const totalPaper = wins+losses;
    const pnlAmt = paperBalance - paperStart;
    res.send(renderView('app/paper', {
        waLinked,
        stats: {
            balance:    parseFloat(paperBalance).toFixed(2),
            startBal:   parseFloat(paperStart).toFixed(2),
            pnlAmt:     (pnlAmt>=0?'+':'') + Math.abs(pnlAmt).toFixed(2),
            pnlPct:     paperStart>0 ? (pnlAmt>=0?'+':'')+((pnlAmt/paperStart)*100).toFixed(1)+'%' : '0.0%',
            pnlColor:   pnlAmt>=0 ? 'var(--green)' : 'var(--red)',
            winRate:    totalPaper>0 ? ((wins/totalPaper)*100).toFixed(1)+'%' : '—',
            wins, losses, openCount: activePaper.length,
        },
        activePaper, closedPaper,
    }));
});

// ─── /app/alerts ────────────────────────────────────────────────────────
app.get('/app/alerts', saasAuth.requireUserAuth, async (req, res) => {
    const user = req.saasUser;
    let activeAlerts=[], triggeredAlerts=[], waLinked=false;
    try {
        const fullUser = await db.getSaasUserById(user.userId);
        const waJid = fullUser?.whatsappJid||'';
        waLinked = Boolean(waJid);
        if (waJid) {
            activeAlerts   = (await Alert.find({userJid:waJid,triggered:false}).sort({createdAt:-1}).lean()).map(a=>({_id:a._id.toString(),coin:a.coin,condition:a.condition,targetPrice:a.targetPrice,createdAt:new Date(a.createdAt).toLocaleDateString()}));
            triggeredAlerts= (await Alert.find({userJid:waJid,triggered:true}).sort({createdAt:-1}).limit(20).lean()).map(a=>({coin:a.coin,condition:a.condition,targetPrice:a.targetPrice}));
        }
    } catch(_){}
    res.send(renderView('app/alerts', { waLinked, activeAlerts, triggeredAlerts }));
});

// ─── /app/watchlist ─────────────────────────────────────────────────────
app.get('/app/watchlist', saasAuth.requireUserAuth, async (req, res) => {
    const user = req.saasUser;
    let coins=[], waLinked=false;
    try {
        const fullUser = await db.getSaasUserById(user.userId);
        const waJid = fullUser?.whatsappJid||'';
        waLinked = Boolean(waJid);
        if (waJid) {
            const wl = await Watchlist.findOne({userJid:waJid}).lean();
            coins = wl?.coins||[];
        }
    } catch(_){}
    res.send(renderView('app/watchlist', { waLinked, coins }));
});

// ─── /app/news ──────────────────────────────────────────────────────────
app.get('/app/news', saasAuth.requireUserAuth, async (req, res) => {
    res.send(renderView('app/news', { username: req.saasUser.username }));
});

// ─── /app/calc ──────────────────────────────────────────────────────────
app.get('/app/calc', saasAuth.requireUserAuth, (req, res) => {
    res.send(renderView('app/calc', { username: req.saasUser.username }));
});

// ─── /app/journal (Signal Journal) ──────────────────────────────────────
app.get('/app/journal', saasAuth.requireUserAuth, async (req, res) => {
    const user = req.saasUser;
    let history = [];
    try { history = await db.getSaasUserTradeHistory(user.userId, 100); } catch(_) {}
    res.send(renderView('app/journal', { username: user.username, history: history.map(t => ({
        coin: (t.coin||'').replace('USDT',''), direction: t.direction,
        entry: fmtPrice(t.entry), tp2: fmtPrice(t.tp2||t.tp), sl: fmtPrice(t.sl),
        result: t.result, pnlPct: t.pnlPct||0, score: t.score||0,
        closedAt: t.closedAt ? new Date(t.closedAt).toLocaleDateString() : '—',
        isPaper: t.isPaper,
    })) }));
});

// ─── /app/backtest ────────────────────────────────────────────────────────
app.get('/app/backtest', saasAuth.requireUserAuth, (req, res) => {
    res.send(renderView('app/backtest', { username: req.saasUser.username }));
});

// ─── /app/heatmap ─────────────────────────────────────────────────────────
app.get('/app/heatmap', saasAuth.requireUserAuth, (req, res) => {
    res.send(renderView('app/heatmap', { username: req.saasUser.username }));
});

// ─── /app/portfolio ───────────────────────────────────────────────────────
app.get('/app/portfolio', saasAuth.requireUserAuth, async (req, res) => {
    const user = req.saasUser;
    let apiKeys = [];
    try {
        const fu = await db.getSaasUserById(user.userId);
        apiKeys = (fu?.apiKeys||[]).map(k=>({ _id:k._id.toString(), label:k.label, exchange:k.exchange, hasSecret: Boolean(k.encSecretKey) }));
    } catch(_) {}
    res.send(renderView('app/portfolio', { username: user.username, apiKeys }));
});

// ─── /app/compare ─────────────────────────────────────────────────────────
app.get('/app/compare', saasAuth.requireUserAuth, (req, res) => {
    res.send(renderView('app/compare', { username: req.saasUser.username }));
});

// ─── Portfolio API (Binance read-only) ─────────────────────────────────────
app.get('/app/api/portfolio/balance', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const fu = await db.getSaasUserById(req.saasUser.userId);
        const key = (fu?.apiKeys||[]).find(k => k.exchange === 'binance' && k.encApiKey);
        if (!key) return res.json({ok:false, error:'No Binance API key found. Add one in Settings.'});
        const apiKey = saasAuth.decryptApiKey(key.encApiKey);
        const crypto = require('crypto');
        const ts = Date.now();
        const queryStr = `timestamp=${ts}&recvWindow=10000`;
        const sig = crypto.createHmac('sha256', key.encSecretKey ? saasAuth.decryptApiKey(key.encSecretKey) : '').update(queryStr).digest('hex');
        const url = `https://fapi.binance.com/fapi/v2/balance?${queryStr}&signature=${sig}`;
        const r = await axios.get(url, { headers:{'X-MBX-APIKEY': apiKey}, timeout:8000 });
        const balances = (r.data||[]).filter(b => parseFloat(b.balance) > 0);
        res.json({ok:true, balances, label: key.label});
    } catch(e) {
        const msg = e.response?.data?.msg || e.message;
        res.json({ok:false, error: msg});
    }
});

// ─── Heatmap API ───────────────────────────────────────────────────────────
app.get('/app/api/heatmap', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const r = await axios.get('https://api.binance.com/api/v3/ticker/24hr', {timeout:8000});
        const coins = (r.data||[])
            .filter(t => t.symbol.endsWith('USDT') && !['USDCUSDT','BUSDUSDT','USDTUSDT','TUSDUSDT','DAIUSDT','EURUSDT'].includes(t.symbol))
            .sort((a,b) => parseFloat(b.quoteVolume)-parseFloat(a.quoteVolume))
            .slice(0, 50)
            .map(t => ({
                coin: t.symbol.replace('USDT',''),
                price: parseFloat(t.lastPrice),
                change: parseFloat(t.priceChangePercent),
                volume: parseFloat(t.quoteVolume),
            }));
        res.json({ok:true, coins});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// ─── /app/guide ─────────────────────────────────────────────────────────
app.get('/app/guide', saasAuth.requireUserAuth, async (req, res) => {
    const fu = await db.getSaasUserById(req.saasUser.userId).catch(()=>null);
    res.send(renderView('app/guide', {
        username: req.saasUser.username,
        tier: fu?.tier || 'free',
    }));
});

// ─── /app/stats ─────────────────────────────────────────────────────────
app.get('/app/stats', saasAuth.requireUserAuth, async (req, res) => {
    const user = req.saasUser;
    let history=[], paperUser=null, waJid='';
    try {
        history = await db.getSaasUserTradeHistory(user.userId, 100);
        const fullUser = await db.getSaasUserById(user.userId);
        waJid = fullUser?.whatsappJid||'';
        if (waJid) paperUser = await db.getUser(waJid).catch(()=>null);
    } catch(_){}
    const live   = history.filter(t=>!t.isPaper);
    const paper  = history.filter(t=>t.isPaper);
    const calcS  = arr => {
        if (!arr.length) return null;
        const wins=arr.filter(t=>t.result==='WIN').length, loss=arr.filter(t=>t.result==='LOSS').length;
        const pnl=arr.reduce((s,t)=>s+(t.pnlPct||0),0);
        const best=arr.reduce((b,t)=>(t.pnlPct||0)>(b?.pnlPct||0)?t:b,null);
        const worst=arr.reduce((w,t)=>(t.pnlPct||0)<(w?.pnlPct||0)?t:w,null);
        return { total:arr.length, wins, loss, wr:((wins/arr.length)*100).toFixed(1), totalPnl:pnl.toFixed(2), avgPnl:(pnl/arr.length).toFixed(2), best:best?{coin:best.coin,pnl:(best.pnlPct||0).toFixed(2)}:null, worst:worst?{coin:worst.coin,pnl:(worst.pnlPct||0).toFixed(2)}:null };
    };
    // Build equity curve data (cumulative PnL timeline)
    const equityCurve = live.slice().sort((a,b)=>new Date(a.closedAt)-new Date(b.closedAt)).reduce((acc, t) => {
        const prev = acc.length ? acc[acc.length-1].cumPnl : 0;
        acc.push({ date: t.closedAt ? new Date(t.closedAt).toLocaleDateString() : '—', pnl: t.pnlPct||0, cumPnl: parseFloat((prev+(t.pnlPct||0)).toFixed(2)), coin: (t.coin||'').replace('USDT',''), result: t.result });
        return acc;
    }, []);
    res.send(renderView('app/stats', {
        liveStats:  calcS(live),
        paperStats: calcS(paper),
        paperBalance: paperUser ? parseFloat(paperUser.paperBalance||0).toFixed(2) : '0.00',
        equityCurve,
    }));
});

// ─── /app/ai ────────────────────────────────────────────────────────────
app.get('/app/ai', saasAuth.requireUserAuth, (req, res) => {
    res.send(renderView('app/ai', { username: req.saasUser.username, hasGroq: Boolean(config.GROQ_API) }));
});

// ─── /app/tracks ────────────────────────────────────────────────────────
app.get('/app/tracks', saasAuth.requireUserAuth, async (req, res) => {
    const user = req.saasUser;
    let activeTrades=[], closedTrades=[], waLinked=false;
    try {
        const fullUser = await db.getSaasUserById(user.userId);
        const waJid = fullUser?.whatsappJid||'';
        waLinked = Boolean(waJid);
        if (waJid) {
            activeTrades = (await db.getActiveTrades(waJid).catch(()=>[])).map(t=>({
                _id: t._id.toString(), coin: (t.coin||'').replace('USDT',''), direction: t.direction,
                entry: fmtPrice(t.entry), tp2: fmtPrice(t.tp2||t.tp), sl: fmtPrice(t.sl),
                leverage: t.leverage||1, status: t.status,
                ageHrs: ((Date.now()-new Date(t.openTime))/3600000).toFixed(1),
            }));
            const hist = await db.getSaasUserTradeHistory(user.userId, 50);
            closedTrades = hist.filter(t=>!t.isPaper).map(t=>({
                coin: (t.coin||'').replace('USDT',''), direction: t.direction,
                entry: fmtPrice(t.entry), tp2: fmtPrice(t.tp2||t.tp), sl: fmtPrice(t.sl),
                result: t.result, pnlPct: t.pnlPct||0,
                closedAt: t.closedAt ? new Date(t.closedAt).toLocaleDateString() : '—',
            }));
        }
    } catch(_){}
    res.send(renderView('app/tracks', { waLinked, activeTrades, closedTrades, deleted: Boolean(req.query.deleted) }));
});

// ─── /app/settings ──────────────────────────────────────────────────────
app.get('/app/settings', saasAuth.requireUserAuth, async (req, res) => {
    const user = req.saasUser;
    let apiKeys=[], waLinked=false, waJid='', waLinkedAt='', tradingMode='signals_only', paperBalance=0, margin=0;
    try {
        const fullUser = await db.getSaasUserById(user.userId);
        if (fullUser) {
            tradingMode = fullUser.tradingMode||'signals_only';
            apiKeys = (fullUser.apiKeys||[]).map(k=>({_id:k._id.toString(),label:k.label,exchange:k.exchange,addedAt:new Date(k.addedAt).toLocaleDateString()}));
            waLinked = Boolean(fullUser.whatsappJid);
            waJid    = fullUser.whatsappJid||'';
            waLinkedAt = fullUser.whatsappLinkedAt ? new Date(fullUser.whatsappLinkedAt).toLocaleString() : '';
        }
        if (waJid) {
            const wu = await db.getUser(waJid).catch(()=>null);
            if (wu) { paperBalance=wu.paperBalance||0; margin=wu.margin||0; }
        }
    } catch(_){}
    let minScoreThreshold = 20, hasUserGroq = false, hasUserGemini = false, userTier = 'free';
    try {
        const fu2 = await db.getSaasUserById(user.userId);
        minScoreThreshold = fu2?.minScoreThreshold ?? 20;
        hasUserGroq   = Boolean(fu2?.encGroqApiKey);
        hasUserGemini = Boolean(fu2?.encGeminiApiKey);
        userTier      = fu2?.tier || 'free';
    } catch(_) {}
    res.send(renderView('app/settings', {
        user: { username: user.username, role: user.role },
        apiKeys, waLinked, waJid: waJid.replace('@s.whatsapp.net',''), waLinkedAt,
        tradingMode, paperBalance: parseFloat(paperBalance).toFixed(2), margin: parseFloat(margin).toFixed(2),
        minScoreThreshold,
        hasUserGroq, hasUserGemini,
        hasSysGroq: false,  // system keys not shared with users
        hasSysGemini: false,
        userTier,
        msg: req.query.added?'added':req.query.removed?'removed':req.query.unlinked?'unlinked':req.query.keyerr||'',
    }));
});

// ─── /app/system ────────────────────────────────────────────────────────
app.get('/app/system', saasAuth.requireUserAuth, async (req, res) => {
    const os = require('os');
    const uptimeSec = process.uptime();
    const d=Math.floor(uptimeSec/86400), h=Math.floor((uptimeSec%86400)/3600), m=Math.floor((uptimeSec%3600)/60);
    const totalMem=(os.totalmem()/1024/1024).toFixed(0), freeMem=(os.freemem()/1024/1024).toFixed(0);
    const usedMem=(totalMem-freeMem), memPct=((usedMem/totalMem)*100).toFixed(0);
    const cpus=os.cpus();
    res.send(renderView('app/system', {
        uptime: (d>0?d+'d ':'') + h+'h ' + m+'m',
        platform: os.platform()+' '+os.arch(), nodeVersion: process.version,
        totalMem, freeMem, usedMem: usedMem.toFixed(0), memPct,
        cpuModel: cpus[0]?.model||'Unknown', cpuCount: cpus.length,
        loadAvg: os.loadavg().map(v=>v.toFixed(2)).join(' / '),
        pid: process.pid,
    }));
});

// ════════════════════════════════════════════════════════════════════════
//  API ROUTES  (unchanged logic)
// ════════════════════════════════════════════════════════════════════════

app.post('/app/api/paper/open', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const fullUser = await db.getSaasUserById(req.saasUser.userId);
        const waJid = fullUser?.whatsappJid;
        if (!waJid) return res.status(400).json({ok:false,error:'WhatsApp not linked. Link in Settings first.'});
        const { coin='', direction='LONG', entry, tp1: tp1Raw, tp2, tp3: tp3Raw, sl, leverage=10 } = req.body;
        const coinFull = coin.toUpperCase().replace(/[^A-Z0-9]/g,'') + (coin.includes('USDT')?'':'USDT');
        if (!entry||!tp2||!sl) return res.status(400).json({ok:false,error:'entry, tp2, sl required'});
        const existing = await db.Trade.countDocuments({userJid:waJid,isPaper:true,status:{$in:['active','pending']}});
        if (existing >= 5) return res.status(400).json({ok:false,error:'Max 5 open paper trades'});
        const wu = await db.getUser(waJid);
        const margin = wu?.margin||100;
        const entryF = parseFloat(entry), tp2F = parseFloat(tp2), slF = parseFloat(sl);
        const isLong = direction === 'LONG';
        // Auto-calculate TP1 midpoint between entry and TP2 if not provided
        const tp1F = tp1Raw ? parseFloat(tp1Raw) : (entryF + tp2F) / 2;
        const tp3F = tp3Raw ? parseFloat(tp3Raw) : (isLong ? tp2F + (tp2F-entryF)*0.5 : tp2F - (entryF-tp2F)*0.5);
        const slDist = Math.abs(entryF - slF);
        const qty = slDist>0 ? (margin*0.02)/slDist : 0;
        const marginUsed = qty>0 ? (qty*entryF)/leverage : 0;
        const riskDist = Math.abs(entryF - slF);
        const rewardDist = Math.abs(tp2F - entryF);
        const rrr = riskDist > 0 ? (rewardDist/riskDist).toFixed(2)+':1' : '—';
        await db.saveTrade({ userJid:waJid, userId:req.saasUser.userId, coin:coinFull, type:'future', direction, entry:entryF, tp:tp2F, tp1:tp1F, tp2:tp2F, tp3:tp3F, sl:slF, status:'active', orderType:'MARKET', isPaper:true, source:'WEB', leverage:parseInt(leverage), quantity:qty, marginUsed, score:0, timeframe:'15m', rrr });
        res.json({ok:true});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post('/app/api/paper/close/:tradeId', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const fullUser = await db.getSaasUserById(req.saasUser.userId);
        const waJid = fullUser?.whatsappJid;
        const trade = await db.Trade.findById(req.params.tradeId);
        if (!trade || (!waJid || trade.userJid !== waJid) && String(trade.userId) !== req.saasUser.userId)
            return res.status(403).json({ok:false,error:'Not your trade'});
        const priceRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${trade.coin}`,{timeout:5000});
        const curP = parseFloat(priceRes.data.price);
        const isLong = trade.direction==='LONG';
        const priceDiff = isLong ? curP-trade.entry : trade.entry-curP;
        const profit = priceDiff * (trade.quantity||0);
        const pnlPct = trade.entry>0 ? (priceDiff/trade.entry*100) : 0;
        const result = priceDiff>0?'WIN':priceDiff<0?'LOSS':'BREAK-EVEN';
        await db.closeTrade(trade._id, result, parseFloat(pnlPct.toFixed(2)), parseFloat(profit.toFixed(2)));
        if (waJid) await db.updatePaperBalance(waJid, profit, result==='WIN', result==='BREAK-EVEN').catch(()=>{});
        res.json({ok:true,profit:profit.toFixed(2),result});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post('/app/api/paper/reset', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const fullUser = await db.getSaasUserById(req.saasUser.userId);
        const waJid = fullUser?.whatsappJid;
        if (!waJid) return res.status(400).json({ok:false,error:'WhatsApp not linked'});
        await db.setPaperCapital(waJid, 100);
        await db.Trade.updateMany({userJid:waJid,isPaper:true,status:{$in:['active','pending']}},{status:'closed',result:'BREAK-EVEN',closedAt:new Date()});
        res.json({ok:true});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post('/app/api/paper/set-capital', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const fullUser = await db.getSaasUserById(req.saasUser.userId);
        const waJid = fullUser?.whatsappJid;
        if (!waJid) return res.json({ok:false,error:'WhatsApp not linked'});
        const amount = parseFloat(req.body.amount);
        if (!amount || amount < 10 || amount > 1000000) return res.json({ok:false,error:'Amount must be $10–$1,000,000'});
        await db.setPaperCapital(waJid, amount);
        res.json({ok:true, amount});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post('/app/api/alerts', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const fullUser = await db.getSaasUserById(req.saasUser.userId);
        const waJid = fullUser?.whatsappJid;
        if (!waJid) return res.status(400).json({ok:false,error:'WhatsApp not linked'});
        const { coin='', condition='above', targetPrice } = req.body;
        if (!coin||!targetPrice||isNaN(targetPrice)) return res.status(400).json({ok:false,error:'coin and targetPrice required'});
        const coinFull = coin.toUpperCase().replace(/[^A-Z0-9]/g,'') + (coin.includes('USDT')?'':'USDT');
        const count = await Alert.countDocuments({userJid:waJid,triggered:false});
        if (count >= 20) return res.status(400).json({ok:false,error:'Max 20 active alerts'});
        await Alert.create({userJid:waJid,userId:req.saasUser.userId,coin:coinFull,condition,targetPrice:parseFloat(targetPrice)});
        res.json({ok:true});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.delete('/app/api/alerts/:id', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const fullUser = await db.getSaasUserById(req.saasUser.userId);
        const waJid = fullUser?.whatsappJid;
        const alert = await Alert.findById(req.params.id);
        if (!alert || alert.userJid !== waJid) return res.status(403).json({ok:false,error:'Not yours'});
        await Alert.findByIdAndDelete(req.params.id);
        res.json({ok:true});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post('/app/api/alerts/clear', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const fullUser = await db.getSaasUserById(req.saasUser.userId);
        const waJid = fullUser?.whatsappJid;
        if (!waJid) return res.json({ok:false,error:'WhatsApp not linked'});
        await Alert.deleteMany({userJid:waJid});
        res.json({ok:true});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post('/app/api/watchlist', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const fullUser = await db.getSaasUserById(req.saasUser.userId);
        const waJid = fullUser?.whatsappJid;
        if (!waJid) return res.status(400).json({ok:false,error:'WhatsApp not linked'});
        const { coins=[] } = req.body;
        const STABLES = new Set(['USDCUSDT','BUSDUSDT','DAIUSDT','TUSDUSDT','EURUSDT','GBPUSDT']);
        const toAdd = coins.map(c=>(c.toUpperCase().replace(/[^A-Z0-9]/g,'')+(c.includes('USDT')?'':'USDT'))).filter(c=>!STABLES.has(c));
        if (!toAdd.length) return res.status(400).json({ok:false,error:'No valid coins'});
        let wl = await Watchlist.findOne({userJid:waJid});
        if (!wl) wl = new Watchlist({userJid:waJid,userId:req.saasUser.userId,coins:[]});
        const existing = new Set(wl.coins);
        const newCoins = toAdd.filter(c=>!existing.has(c));
        if (!newCoins.length) return res.json({ok:true,message:'Already in watchlist'});
        if (wl.coins.length + newCoins.length > 15) return res.status(400).json({ok:false,error:'Max 15 coins'});
        wl.coins.push(...newCoins);
        await wl.save();
        res.json({ok:true,added:newCoins.length});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.delete('/app/api/watchlist/:coin', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const fullUser = await db.getSaasUserById(req.saasUser.userId);
        const waJid = fullUser?.whatsappJid;
        if (!waJid) return res.status(400).json({ok:false,error:'WhatsApp not linked'});
        const coin = req.params.coin.toUpperCase()+(req.params.coin.includes('USDT')?'':'USDT');
        await Watchlist.findOneAndUpdate({userJid:waJid},{$pull:{coins:coin}});
        res.json({ok:true});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post('/app/api/watchlist/clear', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const fullUser = await db.getSaasUserById(req.saasUser.userId);
        const waJid = fullUser?.whatsappJid;
        if (!waJid) return res.json({ok:false,error:'WhatsApp not linked'});
        await Watchlist.findOneAndUpdate({userJid:waJid},{coins:[]},{upsert:true});
        res.json({ok:true});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.get('/app/api/watchlist/prices', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const fullUser = await db.getSaasUserById(req.saasUser.userId);
        const waJid = fullUser?.whatsappJid;
        if (!waJid) return res.json({ok:true,prices:[]});
        const wl = await Watchlist.findOne({userJid:waJid}).lean();
        if (!wl?.coins?.length) return res.json({ok:true,prices:[]});
        const prices = await Promise.all(wl.coins.map(async coin => {
            try {
                const [p24, pt] = await Promise.all([
                    axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}`,{timeout:5000}),
                    axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${coin}`,{timeout:5000}),
                ]);
                return { coin, price: pt.data.price, change: p24.data.priceChangePercent };
            } catch { return { coin, price: null, change: null }; }
        }));
        res.json({ok:true,prices});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.get('/app/api/market-intel', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const [fg, news] = await Promise.allSettled([
            withTimeout(axios.get('https://api.alternative.me/fng/?limit=1',{timeout:8000}), 8000, null),
            withTimeout(axios.get('https://cryptopanic.com/api/v1/posts/?auth_token=public&kind=news&regions=en&public=true',{timeout:8000}), 8000, null),
        ]);
        const fgData = fg.value?.data?.data?.[0] || null;
        const newsItems = news.value?.data?.results?.slice(0,10) || [];
        res.json({ ok:true, fearGreed: fgData, news: newsItems });
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post('/app/api/keys/add', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const user=req.saasUser;
        const{label='',exchange='binance',apiKey='',secretKey=''}=req.body;
        if(!label.trim()||!apiKey.trim()||!secretKey.trim())return res.redirect('/app/settings?keyerr=invalid');
        const fullUser=await db.getSaasUserById(user.userId);
        if(fullUser&&fullUser.apiKeys.some(k=>k.label===label.trim()))return res.redirect('/app/settings?keyerr=exists');
        const entry={label:label.trim(),exchange:exchange==='bybit'?'bybit':'binance',encApiKey:saasAuth.encryptApiKey(apiKey.trim()),encSecretKey:saasAuth.encryptApiKey(secretKey.trim())};
        await db.addUserApiKey(user.userId,entry);
        res.redirect('/app/settings?added=1');
    } catch(e){ console.error('[APP] Add key:',e.message); res.redirect('/app/settings?keyerr=server'); }
});

app.delete('/app/api/keys/:keyId', saasAuth.requireUserAuth, async (req, res) => {
    try { await db.removeUserApiKey(req.saasUser.userId,req.params.keyId); res.json({ok:true}); }
    catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.post('/app/api/link/generate', saasAuth.requireUserAuth, async (req, res) => {
    try { const token=await db.createLinkToken(req.saasUser.userId); res.json({ok:true,token}); }
    catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.post('/app/api/link/unlink', saasAuth.requireUserAuth, async (req, res) => {
    try { await db.unlinkWhatsapp(req.saasUser.userId); res.json({ok:true}); }
    catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.post('/app/api/trading-mode', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const{mode}=req.body;
        if(!['signals_only','auto_trade'].includes(mode))return res.status(400).json({ok:false,error:'Invalid mode'});
        await db.setTradingMode(req.saasUser.userId,mode);
        res.json({ok:true,mode});
    } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.post('/app/api/margin', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const fullUser=await db.getSaasUserById(req.saasUser.userId);
        const waJid=fullUser?.whatsappJid;
        if(!waJid)return res.status(400).json({ok:false,error:'WhatsApp not linked'});
        const amount=parseFloat(req.body.amount);
        if(!amount||amount<1)return res.status(400).json({ok:false,error:'Invalid amount'});
        await db.setMargin(waJid,amount);
        res.json({ok:true,amount});
    } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.post('/app/api/ai-chat', saasAuth.requireUserAuth, async (req, res) => {
    try {
        // Users must provide their OWN GROQ key — system key not shared
        let groqKey = '';
        try {
            const fu = await db.getSaasUserById(req.saasUser.userId);
            if (fu?.encGroqApiKey) groqKey = saasAuth.decryptApiKey(fu.encGroqApiKey);
        } catch(_) {}
        if (!groqKey) return res.json({ok:false,error:'AI Chat ලිනිිusage ගන්න Settings → AI Keys හි ඔබගේ GROQ API key add කරන්න. (Free service — groq.com)'});
        const {messages=[]}=req.body;
        if(!messages.length)return res.status(400).json({ok:false,error:'No messages'});
        const r=await axios.post('https://api.groq.com/openai/v1/chat/completions',
            {model:'llama-3.3-70b-versatile',messages:messages.slice(-14),max_tokens:600,temperature:0.5},
            {headers:{Authorization:'Bearer '+groqKey},timeout:20000});
        res.json({ok:true,reply:r.data.choices[0].message.content||''});
    } catch(e){ console.error('[AI Chat]',e.message); res.status(500).json({ok:false,error:e.message}); }
});

app.get('/app/api/tracks/delete/:id', saasAuth.requireUserAuth, async (req, res) => {
    try { await db.deleteTrade(req.params.id); res.redirect('/app/tracks?deleted=1'); }
    catch(e){ res.redirect('/app/tracks?error=1'); }
});

app.post('/app/api/stats/reset', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const fullUser=await db.getSaasUserById(req.saasUser.userId);
        const waJid=fullUser?.whatsappJid;
        if(!waJid)return res.json({ok:false,error:'WhatsApp not linked'});
        const wu=await db.getUser(waJid);
        wu.totalTrades=0; wu.wins=0; wu.losses=0;
        await wu.save();
        res.json({ok:true});
    } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// ── Pro Mode API (user-level access) ──────────────────────────────────
app.post('/app/api/promode', saasAuth.requireUserAuth, async (req, res) => {
    try { config.setProMode(Boolean(req.body.enabled)); res.json({ok:true,enabled:Boolean(req.body.enabled)}); }
    catch(e){ res.json({ok:false,error:e.message}); }
});
app.post('/app/api/indicators/:key', saasAuth.requireUserAuth, async (req, res) => {
    try { const val=parseFloat(req.body.value); if(isNaN(val))throw new Error('Invalid number'); config.setIndicatorParam(req.params.key,val); res.json({ok:true,key:req.params.key,value:val}); }
    catch(e){ res.json({ok:false,error:e.message}); }
});
app.post('/app/api/smc/:key', saasAuth.requireUserAuth, async (req, res) => {
    try { const val=parseFloat(req.body.value); if(isNaN(val))throw new Error('Invalid number'); config.setSMCParam(req.params.key,val); res.json({ok:true,key:req.params.key,value:val}); }
    catch(e){ res.json({ok:false,error:e.message}); }
});
app.post('/app/api/targets/:key', saasAuth.requireUserAuth, async (req, res) => {
    try { const val=parseFloat(req.body.value); if(isNaN(val))throw new Error('Invalid number'); config.setTargetParam(req.params.key,val); res.json({ok:true,key:req.params.key,value:val}); }
    catch(e){ res.json({ok:false,error:e.message}); }
});
app.post('/app/api/params/:key', saasAuth.requireUserAuth, async (req, res) => {
    try { const val=parseFloat(req.body.value); if(isNaN(val))throw new Error('Invalid number'); config.setTradingParam(req.params.key,val); res.json({ok:true,key:req.params.key,value:val}); }
    catch(e){ res.json({ok:false,error:e.message}); }
});

// ── User AI API Keys (GROQ / Gemini) ───────────────────────────
app.post('/app/api/aikeys/save', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const { type, key } = req.body;
        if (!['groq','gemini'].includes(type)) return res.status(400).json({ok:false,error:'Invalid type'});
        if (!key || !key.trim()) return res.status(400).json({ok:false,error:'Key is empty'});
        const encKey = saasAuth.encryptApiKey(key.trim());
        await db.setUserAiKey(req.saasUser.userId, type, encKey);
        res.json({ok:true, type});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post('/app/api/aikeys/remove', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const { type } = req.body;
        if (!['groq','gemini'].includes(type)) return res.status(400).json({ok:false,error:'Invalid type'});
        await db.setUserAiKey(req.saasUser.userId, type, '');
        res.json({ok:true, type});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// ── Per-user Signal Score Threshold ────────────────────────────
app.post('/app/api/user-settings/min-score', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const score = parseInt(req.body.score);
        if (isNaN(score) || score < 10 || score > 90) return res.status(400).json({ok:false,error:'Score must be 10–90'});
        await db.setUserMinScore(req.saasUser.userId, score);
        res.json({ok:true, minScoreThreshold: score});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// ✅ Protection System APIs
app.get('/app/api/protection/status', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const protection = require('../lib/protection');
        const [status, wrAlert] = await Promise.all([
            protection.getStatus(),
            protection.checkWinRateAlert(req.saasUser.userId),
        ]);
        res.json({ ok:true, status, winRateAlert: wrAlert });
    } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ✅ Pairlist Ranker APIs
app.get('/app/api/pairrank', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const pairrank = require('../lib/pairrank');
        const data = await pairrank.getTopRankedPairs(30);
        res.json({ ok:true, ...data });
    } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});
app.post('/app/api/pairrank/refresh', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const pairrank = require('../lib/pairrank');
        pairrank.clearCache();
        const data = await pairrank.getTopRankedPairs(30);
        res.json({ ok:true, ...data });
    } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ✅ Advanced Stats APIs
app.get('/app/api/stats/advanced', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const coinStats = require('../lib/coinStats');
        const uid = req.saasUser.userId;
        const [metrics, coinPerf, tfStats, monthlyStats] = await Promise.all([
            coinStats.getAdvancedMetrics(uid),
            coinStats.getCoinPerformance(uid, 20),
            coinStats.getTimeframeStats(uid),
            coinStats.getMonthlyStats(uid),
        ]);
        res.json({ ok:true, metrics, coinPerformance:coinPerf.coins, timeframes:tfStats, monthly:monthlyStats });
    } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});
app.get('/app/api/stats/confluence', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const coinStats = require('../lib/coinStats');
        const data = await coinStats.getConfluenceWinRates(req.saasUser.userId);
        res.json({ ok:true, ...data });
    } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});
app.get('/app/api/stats/score-analysis', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const coinStats = require('../lib/coinStats');
        const data = await coinStats.getScoreAnalysis(req.saasUser.userId);
        res.json({ ok:true, ...data });
    } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ✅ Monte Carlo API
app.post('/app/api/montecarlo', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const { scenarios=1000, useBacktest, coin, timeframe, days } = req.body;
        const mc = require('../lib/montecarlo');
        let trades;
        if (useBacktest && coin) {
            const bt = require('../plugins/backtest');
            const r  = await bt.runBacktest((coin.endsWith('USDT')?coin:coin+'USDT'), timeframe||'15m', days||30);
            trades   = (r.trades||[]).map(t=>({ pnlPct: parseFloat(t.pnlPct||t.pnlR||0) }));
        } else {
            const dbTrades = await db.Trade.find({ userId:req.saasUser.userId, isPaper:true, status:'closed' }).lean();
            trades = dbTrades.map(t=>({ pnlPct: t.pnlPct||0 }));
        }
        if (!trades||trades.length<5) return res.status(400).json({ ok:false, error:'Need at least 5 trades' });
        const result = mc.runMonteCarlo(trades, Math.min(parseInt(scenarios)||1000,2000), 2);
        res.json({ ok:true, ...result, tradesUsed:trades.length });
    } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ✅ Walk-Forward API
app.post('/app/api/walkforward', saasAuth.requireUserAuth, async (req, res) => {
    try {
        let { coin='BTC', timeframe='15m', days=90, folds=3 } = req.body;
        coin = coin.toUpperCase(); if (!coin.endsWith('USDT')) coin += 'USDT';
        folds = Math.min(Math.max(parseInt(folds)||3,2),5);
        const bt = require('../plugins/backtest');
        const results = [];
        for (let f=0; f<folds; f++) {
            try {
                const r = await bt.runBacktest(coin, timeframe, Math.floor(Math.min(parseInt(days)||90,180)/folds));
                results.push({ fold:f+1, winRate:r.winRate, sharpe:r.sharpeRatio, calmar:r.calmarRatio,
                    profitFactor:r.profitFactor, totalReturn:r.totalReturnPct, trades:r.total });
            } catch(_) { results.push({ fold:f+1, error:'Insufficient data' }); }
        }
        const valid = results.filter(r=>!r.error);
        const avgWR = valid.length?(valid.reduce((s,r)=>s+parseFloat(r.winRate||0),0)/valid.length).toFixed(1):0;
        const avgSharpe = valid.length?(valid.reduce((s,r)=>s+(r.sharpe||0),0)/valid.length).toFixed(2):0;
        const consistent = valid.length>=2 && valid.every(r=>parseFloat(r.winRate||0)>=45);
        res.json({ ok:true, coin:coin.replace('USDT',''), timeframe, folds, results,
            summary:{ avgWinRate:avgWR, avgSharpe, consistent,
                verdict:consistent?'✅ Consistent across folds':'⚠️ Inconsistent — possible overfitting' }});
    } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ✅ Backtest with settings
app.post('/app/api/backtest/run', saasAuth.requireUserAuth, async (req, res) => {
    try {
        let { coin='BTC', timeframe='15m', days=30 } = req.body;
        coin = coin.toUpperCase(); if (!coin.endsWith('USDT')) coin += 'USDT';
        const bt  = require('../plugins/backtest');
        const cfg = await db.getBacktestSettings();
        const result = await bt.runBacktest(coin, timeframe, Math.min(parseInt(days)||30,90));
        res.json({ ok:true, ...result, settings:{ fee:cfg.feePct, slippage:cfg.slippagePct } });
    } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ── User Signals (from shared signal buffer) ─────────────────
app.get('/app/api/signals/recent', saasAuth.requireUserAuth, (req, res) => {
    try {
        const { pushSignal, ...rest } = require('../web/server');
        // Access via global shared state
        const signals = global._apexSignalBuffer || [];
        const limit = Math.min(parseInt(req.query.limit)||50, 200);
        res.json({ ok:true, signals: signals.slice(-limit).reverse() });
    } catch(e) { res.json({ ok:true, signals: [] }); }
});

// ── Trade Detail ─────────────────────────────────────────────
app.get('/app/api/trades/:id', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const trade = await db.Trade.findById(req.params.id).lean();
        if (!trade) return res.status(404).json({ok:false,error:'Trade not found'});
        // verify ownership
        if (String(trade.userId) !== req.saasUser.userId) {
            const fu = await db.getSaasUserById(req.saasUser.userId);
            if (!fu?.whatsappJid || trade.userJid !== fu.whatsappJid)
                return res.status(403).json({ok:false,error:'Not your trade'});
        }
        res.json({ok:true, trade:{
            _id:       trade._id.toString(),
            coin:      (trade.coin||'').replace('USDT',''),
            direction: trade.direction,
            entry:     trade.entry,   tp1: trade.tp1,
            tp2:       trade.tp2||trade.tp, tp3: trade.tp3,
            sl:        trade.sl,      leverage: trade.leverage||1,
            status:    trade.status,  result: trade.result,
            pnlPct:    trade.pnlPct,  score: trade.score,
            timeframe: trade.timeframe, orderType: trade.orderType,
            isPaper:   trade.isPaper,
            openTime:  trade.openTime,
            closedAt:  trade.closedAt,
            rrr:       trade.rrr,
            tp1Hit:    trade.tp1Hit,  tp2Hit: trade.tp2Hit,
        }});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// ── Auto-cleanup old closed trades (>7 days) ─────────────────
app.post('/app/api/trades/cleanup', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const result = await db.Trade.deleteMany({
            userId: req.saasUser.userId,
            status: 'closed',
            closedAt: { $lt: cutoff },
        });
        res.json({ok:true, deleted: result.deletedCount});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});



// ════════════════════════════════════════════════════════════════════════
//  ZONE BYPASS LIMIT ORDER
// ════════════════════════════════════════════════════════════════════════

app.post('/app/api/paper/open-limit', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const fullUser = await db.getSaasUserById(req.saasUser.userId);
        const waJid   = fullUser?.whatsappJid;
        if (!waJid) return res.status(400).json({ok:false,error:'WhatsApp not linked.'});
        const { coin='', direction='LONG', limitPrice, tp1, tp2, tp3, sl, leverage=10, zoneLabel='', zoneStrength='' } = req.body;
        if (!limitPrice||!tp2||!sl) return res.status(400).json({ok:false,error:'limitPrice, tp2, sl required'});
        const coinFull = coin.toUpperCase().replace(/[^A-Z0-9]/g,'') + (coin.includes('USDT')?'':'USDT');
        const existing = await db.Trade.countDocuments({userJid:waJid,isPaper:true,status:{$in:['active','pending']}});
        if (existing >= 5) return res.status(400).json({ok:false,error:'Max 5 open paper trades'});
        const wu     = await db.getUser(waJid);
        const margin = wu?.margin || 100;
        const limF   = parseFloat(limitPrice), tp2F = parseFloat(tp2), slF = parseFloat(sl);
        const tp1F   = tp1 ? parseFloat(tp1) : (limF+tp2F)/2;
        const tp3F   = tp3 ? parseFloat(tp3) : (direction==='LONG' ? tp2F+(tp2F-limF)*0.5 : tp2F-(limF-tp2F)*0.5);
        const slDist = Math.abs(limF-slF);
        const qty    = slDist>0 ? (margin*0.02)/slDist : 0;
        const riskD  = Math.abs(limF-slF), rewardD = Math.abs(tp2F-limF);
        const rrr    = riskD>0 ? (rewardD/riskD).toFixed(2)+':1' : '—';
        await db.saveTrade({ userJid:waJid, userId:req.saasUser.userId, coin:coinFull, type:'future', direction,
            entry:limF, tp:tp2F, tp1:tp1F, tp2:tp2F, tp3:tp3F, sl:slF,
            status:'pending', orderType:'LIMIT', isPaper:true, source:'WEB_LIMIT',
            leverage:parseInt(leverage), quantity:qty, marginUsed:qty>0?(qty*limF)/leverage:0,
            score:0, timeframe:'15m', rrr, limitPrice:limF, zoneLabel, zoneStrength });
        res.json({ok:true, msg:`Limit order placed at $${limF} — watching for price to reach zone.`});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post('/app/api/paper/cancel-limit/:tradeId', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const trade = await db.Trade.findById(req.params.tradeId);
        if (!trade) return res.status(404).json({ok:false,error:'Trade not found'});
        const fullUser = await db.getSaasUserById(req.saasUser.userId);
        if (String(trade.userId) !== req.saasUser.userId && trade.userJid !== fullUser?.whatsappJid)
            return res.status(403).json({ok:false,error:'Not your trade'});
        if (trade.status !== 'pending') return res.status(400).json({ok:false,error:'Trade is not pending'});
        await db.Trade.findByIdAndUpdate(req.params.tradeId, {status:'closed',result:'CANCELLED',closedAt:new Date()});
        res.json({ok:true});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post('/app/api/paper/update-limit/:tradeId', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const trade = await db.Trade.findById(req.params.tradeId);
        if (!trade) return res.status(404).json({ok:false,error:'Trade not found'});
        const fullUser = await db.getSaasUserById(req.saasUser.userId);
        if (String(trade.userId) !== req.saasUser.userId && trade.userJid !== fullUser?.whatsappJid)
            return res.status(403).json({ok:false,error:'Not your trade'});
        if (trade.status !== 'pending') return res.status(400).json({ok:false,error:'Can only update pending orders'});
        const { limitPrice, sl, tp1, tp2, tp3 } = req.body;
        const updates = {};
        if (limitPrice) { updates.limitPrice=parseFloat(limitPrice); updates.entry=parseFloat(limitPrice); }
        if (sl)  updates.sl  = parseFloat(sl);
        if (tp1) updates.tp1 = parseFloat(tp1);
        if (tp2) { updates.tp2=parseFloat(tp2); updates.tp=parseFloat(tp2); }
        if (tp3) updates.tp3 = parseFloat(tp3);
        await db.Trade.findByIdAndUpdate(req.params.tradeId, updates);
        res.json({ok:true});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// ── Background Zone Watcher — every 3 min (Oracle free tier safe) ──────
// ════════════════════════════════════════════════════════════════════════
//  SMART ZONE WATCHER v2 — Oracle Cloud friendly (3min interval)
//
//  Edge cases handled:
//  1. FAKEOUT PROTECTION   — requires 2 consecutive checks in zone before triggering
//  2. APPROACHING WARNING  — WA alert when price < 1.5% from zone
//  3. STALE ORDER ALERT    — if price moves >6% AWAY from zone (wrong direction)
//  4. ZONE BLOWN THROUGH   — price shot past zone toward TP without touching (re-entry miss)
//  5. ENTRY MISS           — small correction but not enough → zone still valid, wait
// ════════════════════════════════════════════════════════════════════════

// In-memory fakeout counter (resets on restart — safe, just slightly more patient after restart)
const _triggerCount = {}; // tradeId → consecutive hit count

let _watcherRunning = false;
async function runLimitOrderWatcher() {
    if (_watcherRunning) return;
    _watcherRunning = true;
    try {
        const pending = await db.Trade.find({status:'pending',orderType:'LIMIT',isPaper:true}).lean();
        if (!pending.length) return;

        const coins    = [...new Set(pending.map(t=>t.coin))];
        const priceMap = {};
        await Promise.all(coins.map(async coin => {
            try {
                const r = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${coin}`,{timeout:5000});
                priceMap[coin] = parseFloat(r.data.price);
            } catch(_) {}
        }));

        for (const trade of pending) {
            const curP = priceMap[trade.coin]; if (!curP) continue;
            const limP = trade.limitPrice || trade.entry;
            const isL  = trade.direction === 'LONG';
            const tp2  = trade.tp2 || trade.tp;
            const id   = trade._id.toString();

            // Distance from limit zone (%)
            const distFromZone = Math.abs(curP - limP) / limP * 100;

            // ── 1. Check if price is AT zone (within 0.5% tolerance) ────────
            const inZone = isL ? curP <= limP * 1.005 : curP >= limP * 0.995;

            // ── 2. FAKEOUT PROTECTION: count consecutive hits ────────────────
            if (inZone) {
                _triggerCount[id] = (_triggerCount[id] || 0) + 1;
            } else {
                // Price left zone — reset counter (fakeout, didn't hold)
                if (_triggerCount[id] > 0 && _triggerCount[id] < 2) {
                    const conn = global._botConn;
                    if (conn && trade.userJid) {
                        conn.sendMessage(trade.userJid, {text:
                            `⚡ *Fakeout Detected — Held!*\n\n` +
                            `*${trade.coin.replace('USDT','')}* touched $${limP} briefly but left zone.\n` +
                            `Limit order NOT triggered. Waiting for proper candle close in zone.\n\n` +
                            `💡 This is normal — fakeout protection saved you from a bad fill.`
                        }).catch(()=>{});
                    }
                }
                _triggerCount[id] = 0;
            }

            if (inZone && _triggerCount[id] >= 2) {
                // ✅ CONFIRMED TRIGGER — 2 consecutive checks in zone = real entry
                delete _triggerCount[id];
                await db.Trade.findByIdAndUpdate(trade._id, {
                    status: 'active', fillPrice: curP, entry: curP, lastWatchAt: new Date()
                });
                const rr = tp2 && trade.sl ? (Math.abs(tp2-curP)/Math.abs(curP-trade.sl)).toFixed(2) : '—';
                const conn = global._botConn;
                if (conn && trade.userJid) {
                    conn.sendMessage(trade.userJid, {text:
                        `✅ *Limit Order TRIGGERED!* (Confirmed)\n\n` +
                        `🪙 *${trade.coin.replace('USDT','')}* ${isL?'🟢 LONG':'🔴 SHORT'}\n` +
                        `📍 Zone: *${trade.zoneLabel||'Fib Zone'}* ${trade.zoneStrength==='STRONG'?'💪 STRONG':'📌 MEDIUM'}\n\n` +
                        `💵 Fill Price: *$${curP}*\n` +
                        `🎯 TP1: $${trade.tp1||'—'} | TP2: $${tp2||'—'} | TP3: $${trade.tp3||'—'}\n` +
                        `🛡️ SL: $${trade.sl} | ⚖️ RRR: ${rr}:1 | 💡 ${trade.leverage}x\n\n` +
                        `📊 Paper trade now ACTIVE — track in dashboard!`
                    }).catch(()=>{});
                }
                console.log(`[LimitWatcher] ✅ CONFIRMED TRIGGER ${trade.coin} ${trade.direction} @ $${curP}`);
                continue;
            }

            if (inZone) {
                // First check in zone — log and wait for confirmation next cycle
                console.log(`[LimitWatcher] 🕐 ${trade.coin} in zone (check ${_triggerCount[id]}/2) @ $${curP}`);
                continue;
            }

            // ── 3. APPROACHING WARNING (< 1.5% away, alert once per 30min) ──
            if (distFromZone < 1.5) {
                const sinceWarn = trade.lastWatchAt ? Date.now()-new Date(trade.lastWatchAt).getTime() : Infinity;
                if (sinceWarn > 30*60*1000) {
                    await db.Trade.findByIdAndUpdate(trade._id, {lastWatchAt: new Date()});
                    const conn = global._botConn;
                    if (conn && trade.userJid) {
                        conn.sendMessage(trade.userJid, {text:
                            `📍 *Limit Order Approaching!*\n\n` +
                            `*${trade.coin.replace('USDT','')}* ${trade.direction}\n` +
                            `🎯 Zone: $${limP} (${trade.zoneLabel||''})\n` +
                            `💰 Current: $${curP} — *${distFromZone.toFixed(2)}% away*\n\n` +
                            `Price getting close! Ready to enter? Check dashboard.`
                        }).catch(()=>{});
                    }
                }
                continue;
            }

            // ── 4. STALE ORDER — price moved > 6% AWAY from zone ────────────
            const movingAway = isL
                ? curP > limP * 1.06   // LONG: price way above zone (no pullback)
                : curP < limP * 0.94;  // SHORT: price way below zone (no bounce)

            if (movingAway) {
                const sinceCreate = trade.openTime ? Date.now()-new Date(trade.openTime).getTime() : 0;
                const sinceWarn   = trade.lastWatchAt ? Date.now()-new Date(trade.lastWatchAt).getTime() : Infinity;
                // Only warn once per 2h and if order is older than 30min
                if (sinceCreate > 30*60*1000 && sinceWarn > 2*60*60*1000) {
                    await db.Trade.findByIdAndUpdate(trade._id, {lastWatchAt: new Date()});
                    const conn = global._botConn;
                    if (conn && trade.userJid) {
                        conn.sendMessage(trade.userJid, {text:
                            `⚠️ *Limit Order May Be Stale*\n\n` +
                            `*${trade.coin.replace('USDT','')}* ${trade.direction}\n` +
                            `🎯 Your zone: $${limP} | Current: $${curP}\n` +
                            `📏 Distance: *${distFromZone.toFixed(1)}% away* from zone\n\n` +
                            `Price moved far from your limit zone.\n` +
                            `*Options:*\n` +
                            `• Wait — price may still pull back\n` +
                            `• ✏️ Update entry in Paper tab\n` +
                            `• ✕ Cancel if setup is no longer valid\n\n` +
                            `Check dashboard → Paper tab to manage.`
                        }).catch(()=>{});
                    }
                }
                continue;
            }

            // ── 5. ZONE BLOWN THROUGH — price shot past zone toward TP ──────
            // i.e. entry zone was supposed to be a pullback, but price went straight to TP
            // For LONG: zone was below current, but now price is between zone and TP2 → bypassed
            const blownThrough = tp2 && (
                isL  ? (curP > limP * 1.01 && curP < tp2) // LONG: above zone, below TP
                     : (curP < limP * 0.99 && curP > tp2) // SHORT: below zone, above TP
            );

            if (blownThrough) {
                const sinceWarn = trade.lastWatchAt ? Date.now()-new Date(trade.lastWatchAt).getTime() : Infinity;
                if (sinceWarn > 4*60*60*1000) { // warn once per 4h
                    await db.Trade.findByIdAndUpdate(trade._id, {lastWatchAt: new Date()});
                    const conn = global._botConn;
                    if (conn && trade.userJid) {
                        conn.sendMessage(trade.userJid, {text:
                            `🔄 *Zone Bypassed Again — Re-entry Needed*\n\n` +
                            `*${trade.coin.replace('USDT','')}* ${trade.direction}\n` +
                            `Your limit zone $${limP} was skipped — price went straight toward TP.\n\n` +
                            `💡 *What to do:*\n` +
                            `• Run a fresh analysis in Scanner\n` +
                            `• A new limit zone will be suggested\n` +
                            `• Cancel this order and place a new one\n\n` +
                            `Current price: $${curP} (between zone and TP)`
                        }).catch(()=>{});
                    }
                }
            }
        }
    } catch(e) { console.error('[LimitWatcher]', e.message); }
    finally { _watcherRunning = false; }
}
setInterval(runLimitOrderWatcher, 3*60*1000);
setTimeout(runLimitOrderWatcher, 15000);
console.log('[LimitWatcher] ✅ Smart Zone Watcher v2 started (fakeout protection + stale detection)');


}; // end registerApp
