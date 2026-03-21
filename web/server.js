'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════
 *  APEX-MD v7.2 PRO VVIP  ·  web/server.js  ·  CLEAN ARCHITECTURE
 *  ──────────────────────────────────────────────────────────────────────
 *  ✅ Zero HTML strings in JS — all views are real .html files
 *  ✅ CSS in /public/css/   JS in /public/js/
 *  ✅ All API routes 100% unchanged
 *  ✅ Signal / Log SSE streams unchanged
 *
 *  Route Architecture:
 *    /admin/*   → Super-Admin Panel (role=admin required)
 *    /auth/*    → Public Login / Register
 *    /app/*     → User Portal (JWT-cookie protected)
 * ════════════════════════════════════════════════════════════════════════
 */

const express  = require('express');
const crypto   = require('crypto');
const { exec } = require('child_process');
const path     = require('path');
const axios    = require('axios');

const config       = require('../config');
const db           = require('../lib/database');
const saasAuth     = require('../lib/saas-auth');
const { renderView } = require('./render');

// ─── Log Ring-Buffer ────────────────────────────────────────────────────
const LOG_BUFFER_SIZE = 500;
const _logBuffer      = [];
const _sseClients     = new Set();

function _pushLog(line) {
    const entry = { ts: Date.now(), msg: String(line) };
    _logBuffer.push(entry);
    if (_logBuffer.length > LOG_BUFFER_SIZE) _logBuffer.shift();
    for (const client of _sseClients) {
        try { client.write(`data: ${JSON.stringify(entry)}\n\n`); } catch (_) {}
    }
}

const _origLog   = console.log.bind(console);
const _origWarn  = console.warn.bind(console);
const _origError = console.error.bind(console);
console.log   = (...a) => { _origLog(...a);   _pushLog('[LOG] '   + a.join(' ')); };
console.warn  = (...a) => { _origWarn(...a);  _pushLog('[WARN] '  + a.join(' ')); };
console.error = (...a) => { _origError(...a); _pushLog('[ERROR] ' + a.join(' ')); };

function log(msg) { _pushLog('[BOT] ' + msg); }

// ─── Signal Buffer ──────────────────────────────────────────────────────
const SIGNAL_BUFFER_SIZE = 200;
const _signalBuffer      = [];
const _signalSseClients  = new Set();
// Make signal buffer globally accessible for user-facing routes
global._apexSignalBuffer = _signalBuffer;

function pushSignal(setup) {
    const entry = {
        id:        Date.now() + '_' + Math.random().toString(36).slice(2),
        ts:        Date.now(),
        coin:      setup.coin      || '—',
        direction: setup.direction || 'LONG',
        score:     setup.score     || 0,
        price:     setup.price     || setup.entry || 0,
        tp1:       setup.tp1       || null,
        tp2:       setup.tp2       || null,
        tp3:       setup.tp3       || null,
        sl:        setup.sl        || null,
        leverage:  setup.leverage  || 1,
        reasons:   setup.reasons   || '',
        orderType: setup.orderType || 'MARKET',
    };
    _signalBuffer.push(entry);
    if (_signalBuffer.length > SIGNAL_BUFFER_SIZE) _signalBuffer.shift();
    for (const client of _signalSseClients) {
        try { client.write(`data: ${JSON.stringify(entry)}\n\n`); } catch (_) {}
    }
    _pushLog(`[SIGNAL] 🚀 ${entry.direction} ${entry.coin} score=${entry.score}`);
}

// ─── Admin Auth ─────────────────────────────────────────────────────────
function requireAdminAuth(req, res, next) {
    saasAuth.requireUserAuth(req, res, () => {
        if (!req.saasUser || req.saasUser.role !== 'admin') {
            if (req.path.startsWith('/api/'))
                return res.status(403).json({ error: 'Forbidden — admin role required' });
            return res.redirect('/app/?forbidden=1');
        }
        next();
    });
}

// ─── Bot State ──────────────────────────────────────────────────────────
const _botState = {
    waConnected: false, startTime: Date.now(),
    lastUpdate: null, pendingUpdate: false,
};
function setBotConnected(connected) { _botState.waConnected = connected; }

// ─── GitHub Webhook ─────────────────────────────────────────────────────
function _verifyGithubSig(req, body) {
    const secret = config.updater.WEBHOOK_SECRET;
    if (!secret) return true;
    const sig      = req.headers['x-hub-signature-256'] || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}

let _updateInProgress = false;
function runUpdate(res) {
    if (_updateInProgress) {
        if (res) res.json({ ok: false, error: 'Update already in progress' });
        return;
    }
    _updateInProgress = true;
    _pushLog('[UPDATER] 🔄 Starting update...');
    const cmd = `cd ${process.cwd()} && git pull && npm install --production && pm2 restart ${config.updater.PM2_APP_NAME}`;
    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
        _updateInProgress = false;
        _botState.lastUpdate = new Date().toLocaleString();
        _botState.pendingUpdate = false;
        if (err) {
            _pushLog('[UPDATER] ❌ Update failed: ' + err.message);
            if (res) res.json({ ok: false, error: err.message, stderr: stderr.slice(0,500) });
        } else {
            _pushLog('[UPDATER] ✅ Update complete');
            if (res) res.json({ ok: true, output: stdout.slice(0,1000) });
        }
    });
}

// ─── API Health Check ────────────────────────────────────────────────────
async function checkApiHealth() {
    const results = {};
    if (config.GROQ_API) {
        try { await axios.get('https://api.groq.com/openai/v1/models', { headers:{ Authorization:`Bearer ${config.GROQ_API}` }, timeout:5000 }); results.groq = { ok:true, label:'GROQ API' }; }
        catch (e) { results.groq = { ok: e.response?.status===401 ? false : true, label:'GROQ API', warn: e.response?.status!==401 }; }
    } else { results.groq = { ok:false, label:'GROQ API', missing:true }; }
    if (config.GEMINI_API) {
        try { await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${config.GEMINI_API}`, { timeout:5000 }); results.gemini = { ok:true, label:'Gemini API' }; }
        catch { results.gemini = { ok:false, label:'Gemini API' }; }
    } else { results.gemini = { ok:false, label:'Gemini API', missing:true }; }
    try { const mongoose = require('mongoose'); results.mongo = { ok: mongoose.connection.readyState===1, label:'MongoDB' }; }
    catch { results.mongo = { ok:false, label:'MongoDB' }; }
    results.binanceSecret = { ok: Boolean(config.BINANCE_SECRET), label:'Binance Secret Key', warn: !config.BINANCE_SECRET };
    return results;
}

// ─── Format Helpers (passed to sub-modules) ──────────────────────────────
function fmtPrice(n) {
    if (!n || isNaN(n)) return '—';
    const p = parseFloat(n);
    if (p >= 1000) return '$' + p.toFixed(2);
    if (p >= 1)    return '$' + p.toFixed(4);
    return '$' + p.toFixed(6);
}
function fmtPct(n) {
    if (!n || isNaN(n)) return '—';
    const p = parseFloat(n);
    return (p >= 0 ? '+' : '') + p.toFixed(2) + '%';
}
function scoreColor(s) {
    if (s >= 70) return 'var(--green)';
    if (s >= 45) return 'var(--yellow)';
    return 'var(--red)';
}

// ════════════════════════════════════════════════════════════════════════
//  MAIN INIT
// ════════════════════════════════════════════════════════════════════════
function start() {
    const app  = express();
    const port = config.DASHBOARD_PORT;

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // ─── Static Files ──────────────────────────────────────────────────
    app.use(express.static(path.join(__dirname, 'public')));

    // ─── Public pages (no auth required — never redirect) ─────────────
    // optionalAuth: reads cookie if present but NEVER redirects
    function optionalAuth(req, res, next) {
        try {
            const cookies = saasAuth.parseCookies(req.headers.cookie || '');
            const payload  = saasAuth.verifyUserToken(cookies[saasAuth.USER_COOKIE_NAME]);
            req.saasUser   = payload || null;
        } catch(_) { req.saasUser = null; }
        next();
    }

    app.get('/', optionalAuth, (req, res) => {
        res.send(renderView('public/landing', { loggedIn: Boolean(req.saasUser), username: req.saasUser?.username || '' }));
    });

    app.get('/about', optionalAuth, (req, res) => {
        res.send(renderView('public/landing', { loggedIn: Boolean(req.saasUser), username: req.saasUser?.username || '' }));
    });

    app.get('/privacy', optionalAuth, (req, res) => {
        res.send(renderView('public/privacy', { loggedIn: Boolean(req.saasUser), username: req.saasUser?.username || '' }));
    });

    app.get('/terms', optionalAuth, (req, res) => {
        res.send(renderView('public/terms', { loggedIn: Boolean(req.saasUser), username: req.saasUser?.username || '' }));
    });

    app.get('/robots.txt', (req, res) => {
        res.type('text/plain').send([
            'User-agent: *',
            'Allow: /',
            'Allow: /privacy',
            'Allow: /terms',
            'Disallow: /app/',
            'Disallow: /admin/',
            'Disallow: /auth/',
            'Disallow: /app/api/',
            '',
            'Sitemap: ' + (process.env.SITE_URL || 'https://apextradingfree.duckdns.org') + '/sitemap.xml',
        ].join('\n'));
    });

    app.get('/sitemap.xml', (req, res) => {
        const base = process.env.SITE_URL || 'https://apextradingfree.duckdns.org';
        res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${base}/privacy</loc><changefreq>monthly</changefreq><priority>0.4</priority></url>
  <url><loc>${base}/terms</loc><changefreq>monthly</changefreq><priority>0.4</priority></url>
  <url><loc>${base}/auth/register</loc><changefreq>monthly</changefreq><priority>0.7</priority></url>
</urlset>`);
    });

    // ─── Admin redirect compat ─────────────────────────────────────────
    app.get('/admin/login',  (req, res) => res.redirect('/auth/login'));
    app.get('/admin/logout', (req, res) => res.redirect('/auth/logout'));
    app.use('/admin', requireAdminAuth);

    // ════════════════════════════════════════════════════════════════════
    //  ADMIN PAGES
    // ════════════════════════════════════════════════════════════════════

    // ─── Dashboard ─────────────────────────────────────────────────────
    app.get('/admin/', async (req, res) => {
        let trades = [], scannerActive = false, saasUserCount = 0;
        try { trades = await db.Trade.find({ status: { $in: ['active','pending'] } }).lean(); } catch(_){}
        try { scannerActive = require('../plugins/scanner').getScannerStatus(); } catch(_){}
        try { saasUserCount = await db.SaasUser.countDocuments(); } catch(_){}
        const uptime = Math.floor((Date.now() - _botState.startTime) / 60000);
        res.send(renderView('admin/dashboard', {
            waConnected:    _botState.waConnected,
            scannerActive,
            tradeCount:     trades.length,
            signalsToday:   _signalBuffer.filter(s => Date.now()-s.ts < 86400000).length,
            uptime:         uptime >= 60 ? `${Math.floor(uptime/60)}h ${uptime%60}m` : `${uptime}m`,
            saasUserCount,
            pendingUpdate:  _botState.pendingUpdate,
            trades:         trades.map(t => ({
                coin:      t.coin,
                direction: t.direction,
                entry:     fmtPrice(t.entry),
                tp2:       fmtPrice(t.tp2||t.tp),
                sl:        fmtPrice(t.sl),
                leverage:  t.leverage||1,
                status:    t.status,
                isPaper:   t.isPaper||false,
                ageHrs:    ((Date.now()-new Date(t.openTime))/3600000).toFixed(1),
            })),
        }));
    });

    // ─── Signals ───────────────────────────────────────────────────────
    app.get('/admin/signals', (req, res) => {
        res.send(renderView('admin/signals', {
            signals: [..._signalBuffer].reverse(),
        }));
    });

    // ─── Trades ────────────────────────────────────────────────────────
    app.get('/admin/trades', async (req, res) => {
        let activeTrades = [], closedTrades = [];
        try { activeTrades = await db.Trade.find({ status:{$in:['active','pending']} }).sort({openTime:-1}).lean(); } catch(_){}
        try { closedTrades = await db.Trade.find({ status:'closed' }).sort({closedAt:-1}).limit(50).lean(); } catch(_){}
        const mapActive = t => ({
            coin: t.coin, direction: t.direction, isPaper: t.isPaper||false,
            entry: fmtPrice(t.entry), tp1: fmtPrice(t.tp1), tp2: fmtPrice(t.tp2||t.tp),
            sl: fmtPrice(t.sl), leverage: t.leverage||1, status: t.status,
            ageHrs: ((Date.now()-new Date(t.openTime))/3600000).toFixed(1),
        });
        const mapClosed = t => ({
            coin: t.coin, direction: t.direction, isPaper: t.isPaper||false,
            entry: fmtPrice(t.entry), tp2: fmtPrice(t.tp2||t.tp), sl: fmtPrice(t.sl),
            result: t.result, pnlPct: t.pnlPct||0,
            closedAt: t.closedAt ? new Date(t.closedAt).toLocaleDateString() : '—',
        });
        res.send(renderView('admin/trades', {
            activeTrades: activeTrades.map(mapActive),
            closedTrades: closedTrades.map(mapClosed),
        }));
    });

    // ─── Stats ─────────────────────────────────────────────────────────
    app.get('/admin/stats', async (req, res) => {
        const calcStats = arr => {
            if (!arr.length) return null;
            const wins = arr.filter(t=>t.result==='WIN').length;
            const loss = arr.filter(t=>t.result==='LOSS').length;
            const totalPnl = arr.reduce((s,t) => s+(t.pnlPct||0), 0);
            const best  = arr.reduce((b,t) => (t.pnlPct||0)>(b?.pnlPct||0)?t:b, null);
            const worst = arr.reduce((w,t) => (t.pnlPct||0)<(w?.pnlPct||0)?t:w, null);
            return {
                total: arr.length, wins, loss,
                wr: ((wins/arr.length)*100).toFixed(1),
                totalPnl: totalPnl.toFixed(2),
                avgPnl: (totalPnl/arr.length).toFixed(2),
                best:  best  ? { coin: best.coin,  pnl: (best.pnlPct||0).toFixed(2)  } : null,
                worst: worst ? { coin: worst.coin, pnl: (worst.pnlPct||0).toFixed(2) } : null,
            };
        };
        let stats = null, paperStats = null;
        try { stats      = calcStats(await db.Trade.find({status:'closed',isPaper:false}).lean()); } catch(_){}
        try { paperStats = calcStats(await db.Trade.find({status:'closed',isPaper:true}).lean());  } catch(_){}
        res.send(renderView('admin/stats', { stats, paperStats }));
    });

    // ─── Scanner ────────────────────────────────────────────────────────
    app.get('/admin/scanner', async (req, res) => {
        let scannerActive = false;
        try { scannerActive = require('../plugins/scanner').getScannerStatus(); } catch(_){}
        res.send(renderView('admin/scanner', { scannerActive }));
    });

    // ─── Settings ───────────────────────────────────────────────────────
    app.get('/admin/settings', (req, res) => {
        res.send(renderView('admin/settings', {
            modules:         config.modules   || {},
            trading:         config.trading   || {},
            indicatorParams: config.indicatorParams || {},
            smcParams:       config.smcParams || {},
            targetParams:    config.targetParams || {},
            proMode:         (config.modules||{}).PRO_MODE || false,
            webhookSecret:   Boolean(config.updater.WEBHOOK_SECRET),
            version:         config.VERSION,
            dailyReportEnabled: config.dailyReport?.ENABLED !== false,
        }));
    });

    // ─── Updater ────────────────────────────────────────────────────────
    app.get('/admin/updater', (req, res) => {
        res.send(renderView('admin/updater', {
            enabled:       config.updater.ENABLED,
            pending:       _botState.pendingUpdate,
            lastUpdate:    _botState.lastUpdate || 'Never',
            version:       config.VERSION,
            port,
            pm2Name:       config.updater.PM2_APP_NAME,
            webhookSecret: Boolean(config.updater.WEBHOOK_SECRET),
        }));
    });

    // ─── Users ──────────────────────────────────────────────────────────
    app.get('/admin/users', async (req, res) => {
        let users = [], totalUsers = 0;
        try {
            const result = await db.listSaasUsers(1, 100);
            users = result.users || [];
            totalUsers = result.total || 0;
        } catch(e) { console.error('Admin users error:', e.message); }
        res.send(renderView('admin/users', {
            totalUsers,
            users: users.map(u => ({
                id:          u._id.toString(),
                username:    u.username,
                email:       u.email,
                role:        u.role,
                status:      u.accountStatus,
                createdAt:   new Date(u.createdAt).toLocaleDateString(),
                lastLoginAt: u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : 'Never',
                loginCount:  u.loginCount || 0,
            })),
        }));
    });

    // ════════════════════════════════════════════════════════════════════
    //  ADMIN REST API  (100% unchanged)
    // ════════════════════════════════════════════════════════════════════

    app.get('/admin/api/status', requireAdminAuth, async (req, res) => {
        let scannerActive=false, tradeCount=0;
        try { scannerActive=require('../plugins/scanner').getScannerStatus(); } catch(_){}
        try { tradeCount=await db.Trade.countDocuments({status:{$in:['active','pending']}}); } catch(_){}
        const uptime=Math.floor((Date.now()-_botState.startTime)/60000);
        res.json({ waConnected:_botState.waConnected, scannerActive, tradeCount,
            uptime: uptime>=60?`${Math.floor(uptime/60)}h ${uptime%60}m`:`${uptime}m`,
            pendingUpdate: _botState.pendingUpdate,
            modules:config.modules, trading:config.trading });
    });

    app.get('/admin/api/health', requireAdminAuth, async (req,res) => {
        try { res.json(await checkApiHealth()); } catch(e){ res.status(500).json({error:e.message}); }
    });

    app.get('/admin/api/logs/stream', requireAdminAuth, (req, res) => {
        res.setHeader('Content-Type','text/event-stream');
        res.setHeader('Cache-Control','no-cache');
        res.setHeader('Connection','keep-alive');
        res.flushHeaders();
        _logBuffer.slice(-50).forEach(entry => res.write(`data: ${JSON.stringify(entry)}\n\n`));
        _sseClients.add(res);
        req.on('close', () => _sseClients.delete(res));
    });

    app.get('/admin/api/signals/stream', requireAdminAuth, (req, res) => {
        res.setHeader('Content-Type','text/event-stream');
        res.setHeader('Cache-Control','no-cache');
        res.setHeader('Connection','keep-alive');
        res.flushHeaders();
        _signalSseClients.add(res);
        req.on('close', () => _signalSseClients.delete(res));
    });

    app.get('/admin/api/signals', requireAdminAuth, (req, res) => {
        const limit = Math.min(parseInt(req.query.limit)||50, 200);
        res.json({ ok:true, signals:_signalBuffer.slice(-limit).reverse() });
    });

    // User-accessible signals endpoint (read-only, no admin required)
    app.get('/app/api/signals/stream', saasAuth.requireUserAuth, (req, res) => {
        res.setHeader('Content-Type','text/event-stream');
        res.setHeader('Cache-Control','no-cache');
        res.setHeader('Connection','keep-alive');
        _signalSseClients.add(res);
        res.write('data: {"ping":true}\n\n');
        req.on('close', () => _signalSseClients.delete(res));
    });

    app.post('/admin/api/signals/push', requireAdminAuth, (req, res) => {
        try { pushSignal(req.body); res.json({ ok:true }); }
        catch(e){ res.status(400).json({ok:false,error:e.message}); }
    });

    app.post('/admin/api/scanner/:action', requireAdminAuth, async (req, res) => {
        try {
            const scanner = require('../plugins/scanner');
            if (req.params.action==='start') {
                const started = typeof scanner.startScannerFromSettings==='function'
                    ? await scanner.startScannerFromSettings(global._botConn, config.OWNER_NUMBER+'@s.whatsapp.net') : false;
                res.json({ok:true,started});
            } else if (req.params.action==='stop') {
                const stopped = typeof scanner.stopScannerFromSettings==='function' ? scanner.stopScannerFromSettings() : false;
                res.json({ok:true,stopped});
            } else res.status(400).json({ok:false,error:'Unknown action'});
        } catch(e){ res.status(500).json({ok:false,error:e.message}); }
    });

    app.post('/admin/api/modules/:name', requireAdminAuth, async (req, res) => {
        try {
            const name=req.params.name.toUpperCase(), enabled=Boolean(req.body.enabled);
            config.toggleModule(name, enabled);
            const dbKey={AI_MODEL:'aiModel',BYBIT:'bybit',DYNAMIC_WEIGHTS:'dynamicWeights',SMC:'smcEnabled'}[name];
            if (dbKey) await db.updateSettings({[dbKey]:enabled}).catch(()=>{});
            res.json({ok:true,module:name,enabled});
        } catch(e){ res.status(400).json({ok:false,error:e.message}); }
    });

    app.post('/admin/api/params/:key', requireAdminAuth, async (req, res) => {
        try {
            const key=req.params.key, val=parseFloat(req.body.value);
            if (isNaN(val)) throw new Error('Invalid number');
            config.setTradingParam(key, val);
            const dbMap={DEFAULT_RISK_PCT:'defaultRisk',MIN_SCORE_THRESHOLD:'minScore',MAX_OPEN_TRADES:'maxTrades'};
            if (dbMap[key]) await db.updateSettings({[dbMap[key]]:val}).catch(()=>{});
            res.json({ok:true,key,value:val});
        } catch(e){ res.status(400).json({ok:false,error:e.message}); }
    });

    app.post('/admin/api/promode', requireAdminAuth, async (req, res) => {
        try { config.setProMode(Boolean(req.body.enabled)); await db.updateSettings({proMode:req.body.enabled}).catch(()=>{}); res.json({ok:true,proMode:config.modules.PRO_MODE}); }
        catch(e){ res.status(400).json({ok:false,error:e.message}); }
    });

    app.post('/admin/api/indicators/:key', requireAdminAuth, async (req, res) => {
        try { const val=parseFloat(req.body.value); if(isNaN(val)) throw new Error('Invalid number'); config.setIndicatorParam(req.params.key,val); await db.updateSettings({[`ind_${req.params.key}`]:val}).catch(()=>{}); res.json({ok:true,key:req.params.key,value:val}); }
        catch(e){ res.status(400).json({ok:false,error:e.message}); }
    });

    app.post('/admin/api/smc/:key', requireAdminAuth, async (req, res) => {
        try { const val=parseFloat(req.body.value); if(isNaN(val)) throw new Error('Invalid number'); config.setSMCParam(req.params.key,val); await db.updateSettings({[`smc_${req.params.key}`]:val}).catch(()=>{}); res.json({ok:true,key:req.params.key,value:val}); }
        catch(e){ res.status(400).json({ok:false,error:e.message}); }
    });

    app.post('/admin/api/targets/:key', requireAdminAuth, async (req, res) => {
        try { const val=parseFloat(req.body.value); if(isNaN(val)) throw new Error('Invalid number'); config.setTargetParam(req.params.key,val); await db.updateSettings({[`tgt_${req.params.key}`]:val}).catch(()=>{}); res.json({ok:true,key:req.params.key,value:val}); }
        catch(e){ res.status(400).json({ok:false,error:e.message}); }
    });

    app.post('/admin/api/autoupdate', requireAdminAuth, (req,res) => { config.setAutoUpdate(Boolean(req.body.enabled)); res.json({ok:true,enabled:config.updater.ENABLED}); });
    app.post('/admin/api/update',     requireAdminAuth, (req,res) => runUpdate(res));
    app.get('/admin/api/config',      requireAdminAuth, (req,res) => res.json(config.getSnapshot()));
    app.get('/admin/api/trades',      requireAdminAuth, async (req,res) => {
        try { res.json({ok:true,trades:await db.Trade.find({status:{$in:['active','pending']}}).lean()}); }
        catch(e){ res.status(500).json({ok:false,error:e.message}); }
    });

    app.post('/admin/api/users/:id/status', requireAdminAuth, async (req, res) => {
        try {
            const { status } = req.body;
            if (!['active','suspended'].includes(status)) return res.status(400).json({ok:false,error:'Invalid status'});
            await db.setSaasUserStatus(req.params.id, status);
            res.json({ok:true,status});
        } catch(e){ res.status(500).json({ok:false,error:e.message}); }
    });


    // ── User role change ─────────────────────────────────────────
    app.post('/admin/api/users/:id/role', requireAdminAuth, async (req, res) => {
        try {
            const { role } = req.body;
            if (!['admin','user'].includes(role)) return res.status(400).json({ok:false,error:'Invalid role'});
            await db.getSaasUserById(req.params.id); // verify exists
            const mongoose = require('mongoose');
            const SaasUser = mongoose.model('SaasUser');
            await SaasUser.findByIdAndUpdate(req.params.id, { role });
            res.json({ok:true, role});
        } catch(e){ res.status(500).json({ok:false,error:e.message}); }
    });

    // ── Bot restart / stop ───────────────────────────────────────
    app.post('/admin/api/bot/:action', requireAdminAuth, (req, res) => {
        const action = req.params.action;
        if (!['restart','stop'].includes(action)) return res.status(400).json({ok:false,error:'Invalid action'});
        res.json({ok:true, action});
        setTimeout(() => {
            if (action === 'restart') {
                _pushLog('[ADMIN] 🔄 Bot restart requested by admin');
                process.exit(0); // pm2 will restart
            } else {
                _pushLog('[ADMIN] ⛔ Bot stop requested by admin');
                process.exit(1);
            }
        }, 500);
    });

    // ── System info ──────────────────────────────────────────────
    app.get('/admin/api/system', requireAdminAuth, async (req, res) => {
        try {
            const os = require('os');
            const { execSync } = require('child_process');
            const totalMem  = os.totalmem();
            const freeMem   = os.freemem();
            const usedMem   = totalMem - freeMem;
            const cpus      = os.cpus();
            const cpuModel  = cpus[0]?.model?.trim() || 'Unknown';
            const cpuCount  = cpus.length;
            // CPU usage (1s sample)
            let cpuPct = 0;
            try {
                const load = os.loadavg()[0];
                cpuPct = Math.min(100, Math.round((load / cpuCount) * 100));
            } catch(_){}
            // Disk
            let diskTotal = '—', diskUsed = '—', diskPct = 0;
            try {
                const df = execSync("df -BG / | tail -1").toString().trim().split(/\s+/);
                diskTotal = df[1]; diskUsed = df[2]; diskPct = parseInt(df[4]);
            } catch(_){}
            res.json({
                ok: true,
                mem:  { total: totalMem, used: usedMem, free: freeMem, pct: Math.round((usedMem/totalMem)*100) },
                cpu:  { model: cpuModel, cores: cpuCount, pct: cpuPct },
                disk: { total: diskTotal, used: diskUsed, pct: diskPct },
                uptime: Math.floor(process.uptime()),
                node: process.version,
                platform: os.platform(),
            });
        } catch(e){ res.status(500).json({ok:false,error:e.message}); }
    });

    app.post('/admin/webhook/update', express.raw({type:'application/json'}), (req, res) => {
        if (!_verifyGithubSig(req, req.body)) return res.status(401).json({error:'Invalid signature'});
        res.json({ok:true});
        if (config.updater.ENABLED) { _pushLog('[WEBHOOK] 📦 GitHub push — running auto-update...'); runUpdate(null); }
        else { _botState.pendingUpdate=true; _pushLog('[WEBHOOK] ⚠️ GitHub push — auto-update is OFF.'); }
    });

    // ════════════════════════════════════════════════════════════════════
    //  AUTH ROUTES
    // ════════════════════════════════════════════════════════════════════

    app.get('/auth/register', (req, res) => {
        const errMessages = {
            exists_email:    '❌ That email is already registered.',
            exists_username: '❌ Username already taken.',
            short_password:  '❌ Password must be at least 8 characters.',
            mismatch:        '❌ Passwords do not match.',
            invalid:         '❌ Please fill in all fields correctly.',
            server:          '❌ Server error — please try again.',
        };
        res.send(renderView('auth/register', {
            errMsg:  errMessages[req.query.err] || '',
            success: Boolean(req.query.success),
        }));
    });

    app.post('/auth/register', async (req, res) => {
        const ip = req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown';
        if (!saasAuth.loginRateLimiter.check(ip+'_reg')) return res.redirect('/auth/register?err=server');
        try {
            const { username='', email='', password='', confirm='' } = req.body;
            if (!username.trim()||!email.trim()||!password) return res.redirect('/auth/register?err=invalid');
            if (!/^[a-zA-Z0-9_]{3,32}$/.test(username.trim())) return res.redirect('/auth/register?err=invalid');
            if (password.length<8) return res.redirect('/auth/register?err=short_password');
            if (password!==confirm) return res.redirect('/auth/register?err=mismatch');
            if (await db.findSaasUserByEmail(email)) return res.redirect('/auth/register?err=exists_email');
            if (await db.findSaasUserByUsername(username.trim())) return res.redirect('/auth/register?err=exists_username');
            const passwordHash = await saasAuth.hashPassword(password);
            await db.createSaasUser({ username:username.trim(), email, passwordHash });
            res.redirect('/auth/login?registered=1');
        } catch(e){ console.error('[AUTH] Register error:',e.message); res.redirect('/auth/register?err=server'); }
    });

    app.get('/auth/login', (req, res) => {
        const errMessages = {
            invalid: '❌ Invalid email or password.',
            locked:  '🔒 Too many attempts — try again in 15 minutes.',
            server:  '❌ Server error — please try again.',
        };
        res.send(renderView('auth/login', {
            errMsg:     errMessages[req.query.err] || '',
            registered: Boolean(req.query.registered),
            suspended:  Boolean(req.query.suspended),
            nextUrl:    req.query.next || '',
        }));
    });

    app.post('/auth/login', async (req, res) => {
        const ip = req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown';
        if (!saasAuth.loginRateLimiter.check(ip)) return res.redirect('/auth/login?err=locked');
        try {
            const { email='', password='', next='' } = req.body;
            if (!email||!password) return res.redirect('/auth/login?err=invalid');
            const user = await db.findSaasUserByEmail(email);
            if (!user) return res.redirect('/auth/login?err=invalid');
            if (user.accountStatus==='suspended') return res.redirect('/auth/login?suspended=1');
            if (!await saasAuth.verifyPassword(password, user.passwordHash)) return res.redirect('/auth/login?err=invalid');
            saasAuth.loginRateLimiter.reset(ip);
            await db.recordSaasLogin(user._id);
            const token = saasAuth.signUserToken({ userId:user._id.toString(), username:user.username, role:user.role, accountStatus:user.accountStatus, exp:Date.now()+saasAuth.USER_COOKIE_TTL });
            res.setHeader('Set-Cookie', saasAuth.buildUserCookieHeader(token, saasAuth.USER_COOKIE_TTL));
            res.redirect(user.role==='admin' ? '/admin/' : (next&&next.startsWith('/app')?next:'/app/'));
        } catch(e){ console.error('[AUTH] Login error:',e.message); res.redirect('/auth/login?err=server'); }
    });

    app.get('/auth/logout', (req, res) => {
        res.setHeader('Set-Cookie', saasAuth.clearUserCookieHeader());
        res.redirect('/auth/login');
    });

    // ════════════════════════════════════════════════════════════════════
    //  USER PORTAL (/app/*)
    // ════════════════════════════════════════════════════════════════════
    app.use('/app', saasAuth.requireUserAuth);

    // ─── App routes delegated to app-routes.js ────────────────────────
    try {
        const registerApp = require('./app-routes');
        registerApp({ saasAuth, db, config, axios, renderView, fmtPrice, fmtPct, scoreColor }, app);
        console.log('[Dashboard] ✅ App portal routes registered (/app/*)');
    } catch(e) {
        console.error('[Dashboard] ❌ app-routes.js failed:', e.message);
    }

    // ─── Scanner routes ───────────────────────────────────────────────
    try {
        const registerScanner = require('./scanner-routes');
        registerScanner({ saasAuth, db, config, axios, renderView, fmtPrice, scoreColor }, app);
        console.log('[Dashboard] ✅ Scanner routes registered (/app/scanner)');
    } catch(e) {
        console.error('[Dashboard] ❌ scanner-routes.js failed:', e.message);
    }

    // ─── Root & Compat ─────────────────────────────────────────────────
    app.use('/dashboard', (req, res) => {
        const dest = req.path==='/'||req.path==='' ? '/admin/' : '/admin'+req.path;
        res.redirect(301, dest+(req.search||''));
    });

    // ─── Start Server ──────────────────────────────────────────────────
    app.listen(port, () => {
        console.log(`\n🌐 [Server] Running on port ${port}`);
        console.log(`🔐 [Admin]   http://localhost:${port}/admin/`);
        console.log(`📡 [Signals] http://localhost:${port}/admin/signals`);
        console.log(`👥 [Portal]  http://localhost:${port}/app/`);
        console.log(`🔑 [Auth]    http://localhost:${port}/auth/login`);
    });

    return app;
}

module.exports = { start, setBotConnected, log, pushSignal };
