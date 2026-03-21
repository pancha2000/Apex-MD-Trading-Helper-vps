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
            coin: t.coin, direction: t.direction,
            entry: fmtPrice(t.entry), tp1: fmtPrice(t.tp1), tp2: fmtPrice(t.tp2||t.tp),
            sl: fmtPrice(t.sl), leverage: t.leverage||1, status: t.status,
            ageHrs: ((Date.now()-new Date(t.openTime))/3600000).toFixed(1),
        }));
        const closed = await db.getSaasUserTradeHistory(user.userId, 100);
        closed.forEach(t=>{ totalPnl+=t.pnlPct||0; if(t.result==='WIN') wins++; });
        closedTrades = closed.map(t => ({
            coin: t.coin, direction: t.direction,
            entry: fmtPrice(t.entry), tp2: fmtPrice(t.tp2||t.tp), sl: fmtPrice(t.sl),
            result: t.result, pnlPct: t.pnlPct||0,
            closedAt: t.closedAt ? new Date(t.closedAt).toLocaleDateString() : '—',
        }));
    } catch(_){}
    const totalClosed = closedTrades.length;
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
    res.send(renderView('app/stats', {
        liveStats:  calcS(live),
        paperStats: calcS(paper),
        paperBalance: paperUser ? parseFloat(paperUser.paperBalance||0).toFixed(2) : '0.00',
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
    let minScoreThreshold = 20;
    try { const fu2 = await db.getSaasUserById(user.userId); minScoreThreshold = fu2?.minScoreThreshold ?? 20; } catch(_) {}
    res.send(renderView('app/settings', {
        user: { username: user.username, role: user.role },
        apiKeys, waLinked, waJid: waJid.replace('@s.whatsapp.net',''), waLinkedAt,
        tradingMode, paperBalance: parseFloat(paperBalance).toFixed(2), margin: parseFloat(margin).toFixed(2),
        minScoreThreshold,
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
        const { coin='', direction='LONG', entry, tp2, sl, leverage=10 } = req.body;
        const coinFull = coin.toUpperCase().replace(/[^A-Z0-9]/g,'') + (coin.includes('USDT')?'':'USDT');
        if (!entry||!tp2||!sl) return res.status(400).json({ok:false,error:'entry, tp2, sl required'});
        const existing = await db.Trade.countDocuments({userJid:waJid,isPaper:true,status:{$in:['active','pending']}});
        if (existing >= 5) return res.status(400).json({ok:false,error:'Max 5 open paper trades'});
        const wu = await db.getUser(waJid);
        const margin = wu?.margin||100;
        const slDist = Math.abs(parseFloat(entry)-parseFloat(sl));
        const qty = slDist>0 ? (margin*0.02)/slDist : 0;
        const marginUsed = qty>0 ? (qty*parseFloat(entry))/leverage : 0;
        await db.saveTrade({ userJid:waJid, userId:req.saasUser.userId, coin:coinFull, type:'future', direction, entry:parseFloat(entry), tp:parseFloat(tp2), tp1:null, tp2:parseFloat(tp2), sl:parseFloat(sl), status:'active', orderType:'MARKET', isPaper:true, source:'WEB', leverage:parseInt(leverage), quantity:qty, marginUsed, score:0, timeframe:'15m' });
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
        if (!config.GROQ_API) return res.json({ok:false,error:'GROQ API key නැත. config.env හි GROQ_API add කරන්න.'});
        const {messages=[]}=req.body;
        if(!messages.length)return res.status(400).json({ok:false,error:'No messages'});
        const r=await axios.post('https://api.groq.com/openai/v1/chat/completions',
            {model:'llama-3.3-70b-versatile',messages:messages.slice(-14),max_tokens:600,temperature:0.5},
            {headers:{Authorization:'Bearer '+config.GROQ_API},timeout:20000});
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

// ── Per-user Signal Score Threshold ────────────────────────────
app.post('/app/api/user-settings/min-score', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const score = parseInt(req.body.score);
        if (isNaN(score) || score < 10 || score > 90) return res.status(400).json({ok:false,error:'Score must be 10–90'});
        await db.setUserMinScore(req.saasUser.userId, score);
        res.json({ok:true, minScoreThreshold: score});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});


}; // end registerApp
