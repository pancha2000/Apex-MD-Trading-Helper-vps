'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════
 *  APEX-MD v7.2 PRO VVIP  ·  dashboard.js  ·  REDESIGNED
 *  ──────────────────────────────────────────────────────────────────────
 *  ✅ 100% backward compatible — all API routes unchanged.
 *  🎨 Complete UI redesign — professional dark trading terminal.
 *  🔔 NEW: Signal notification system (pushSignal export).
 *
 *  HOW TO ENABLE LIVE SIGNAL FEED ON WEBSITE:
 *  Add this ONE line to lib/signalDispatch.js after building the
 *  alert message (optional — dashboard still works without it):
 *
 *    try { require('../dashboard').pushSignal(setup); } catch(_){}
 *
 *  Route Architecture (unchanged):
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

const config   = require('./config');
const db       = require('./lib/database');
const saasAuth = require('./lib/saas-auth');

// ─── Log Ring-Buffer ───────────────────────────────────────────────────
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

// ─── Signal Buffer (NEW) ───────────────────────────────────────────────
const SIGNAL_BUFFER_SIZE = 200;
const _signalBuffer      = [];
const _signalSseClients  = new Set();

/**
 * pushSignal(setup) — Call from signalDispatch.js to show signals on the
 * web dashboard in real-time alongside WhatsApp notifications.
 * setup shape: { coin, direction, score, price, tp1, tp2, tp3, sl, reasons, orderType, leverage }
 */
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

// ─── Admin Auth ────────────────────────────────────────────────────────
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

// ─── Bot State ─────────────────────────────────────────────────────────
const _botState = {
    waConnected: false, startTime: Date.now(),
    lastUpdate: null, pendingUpdate: false,
};
function setBotConnected(connected) { _botState.waConnected = connected; }

// ─── GitHub Webhook ────────────────────────────────────────────────────
function _verifyGithubSig(req, body) {
    const secret = config.updater.WEBHOOK_SECRET;
    if (!secret) return true;
    const sig      = req.headers['x-hub-signature-256'] || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}

let _updateInProgress = false;
function runUpdate(res) {
    if (_updateInProgress) { if (res) res.json({ ok: false, error: 'Update already in progress' }); return; }
    _updateInProgress = true;
    _pushLog('[UPDATER] 🔄 Starting git pull + npm install...');
    const cmd = `cd ${path.resolve(__dirname)} && git pull && npm install --production && pm2 restart ${config.updater.PM2_APP_NAME} --update-env`;
    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
        _updateInProgress = false;
        _botState.lastUpdate = new Date().toISOString();
        _botState.pendingUpdate = false;
        if (err) {
            _pushLog('[UPDATER] ❌ Update failed: ' + err.message);
            if (res) res.json({ ok: false, error: err.message, stderr: stderr.slice(0,500) });
        } else {
            _pushLog('[UPDATER] ✅ Update complete. Bot restarting...');
            if (res) res.json({ ok: true, output: stdout.slice(0,1000) });
        }
    });
}

// ─── API Health Check ──────────────────────────────────────────────────
async function checkApiHealth() {
    const results = {};
    try { await axios.get('https://fapi.binance.com/fapi/v1/ping', { timeout: 5000 }); results.binance = { ok: true, label: 'Binance Futures' }; }
    catch { results.binance = { ok: false, label: 'Binance Futures' }; }
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

// ════════════════════════════════════════════════════════════════════════
//  DESIGN SYSTEM
// ════════════════════════════════════════════════════════════════════════

const GOOGLE_FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500;700&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">`;

const CSS_BASE = `
:root{
  --bg:#060d17;--bg2:#0b1828;--card:#0d1f30;--card2:#112436;
  --border:#1c3349;--border2:#254560;
  --accent:#00c8ff;--accent2:#0095cc;
  --green:#00e676;--green2:#00c853;
  --red:#ff3355;--red2:#c62828;
  --yellow:#ffab00;--purple:#b388ff;
  --text:#d6eeff;--text2:#5c87a8;--text3:#8ab0cc;
  --long-card:#001a12;--short-card:#1a0009;
  --font-head:'Syne',sans-serif;
  --font-mono:'JetBrains Mono',monospace;
  --font-body:'DM Sans',sans-serif;
  --glow-cyan:0 0 20px rgba(0,200,255,.18);
  --glow-green:0 0 16px rgba(0,230,118,.15);
  --glow-red:0 0 16px rgba(255,51,85,.15);
  --radius:10px;--radius-sm:6px;--radius-lg:16px;
}
*{margin:0;padding:0;box-sizing:border-box;}
html{scroll-behavior:smooth;}
body{background:var(--bg);color:var(--text);font-family:var(--font-body);min-height:100vh;line-height:1.6;}
body::before{content:'';position:fixed;inset:0;
  background-image:linear-gradient(rgba(0,200,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(0,200,255,.025) 1px,transparent 1px);
  background-size:60px 60px;pointer-events:none;z-index:0;}
a{color:var(--accent);text-decoration:none;}
a:hover{color:#33d6ff;}

/* NAV */
.nav{position:sticky;top:0;z-index:200;background:rgba(6,13,23,.92);backdrop-filter:blur(20px);
  border-bottom:1px solid var(--border);padding:0 24px;display:flex;align-items:center;gap:12px;height:60px;}
.nav-logo{font-family:var(--font-head);font-weight:800;font-size:1.05rem;color:#fff;display:flex;align-items:center;gap:10px;white-space:nowrap;}
.nav-logo-badge{font-size:.62rem;font-weight:700;background:linear-gradient(135deg,var(--accent),#7c3aed);color:#fff;padding:2px 8px;border-radius:4px;letter-spacing:.06em;font-family:var(--font-mono);}
.nav-links{display:flex;gap:2px;margin-left:auto;align-items:center;flex-wrap:wrap;}
.nav-link{padding:6px 13px;border-radius:var(--radius-sm);font-size:.82rem;font-weight:500;color:var(--text2);transition:all .15s;white-space:nowrap;border:1px solid transparent;}
.nav-link:hover{color:var(--text);background:var(--card);border-color:var(--border);}
.nav-link.active{color:var(--accent);background:rgba(0,200,255,.08);border-color:rgba(0,200,255,.2);}
.nav-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;background:var(--red);color:#fff;border-radius:99px;font-size:.6rem;font-weight:700;margin-left:4px;vertical-align:middle;font-family:var(--font-mono);}
.nav-badge.green{background:var(--green2);color:#000;}
.nav-btn{display:inline-flex;align-items:center;gap:5px;padding:6px 14px;border-radius:var(--radius-sm);font-size:.8rem;font-weight:500;cursor:pointer;border:1px solid var(--border);background:var(--card);color:var(--text2);transition:all .15s;margin-left:4px;}
.nav-btn:hover{border-color:var(--border2);color:var(--text);}

/* LAYOUT */
.wrap{max-width:1340px;margin:0 auto;padding:28px 20px;position:relative;z-index:1;}
.page-title{font-family:var(--font-head);font-size:1.5rem;font-weight:700;color:#fff;margin-bottom:24px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.page-title span{color:var(--text2);font-size:.85rem;font-weight:400;margin-left:4px;}

/* GRIDS */
.g-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:24px;}
.g-2{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:20px;}
.g-3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:20px;}
@media(max-width:900px){.g-2,.g-3{grid-template-columns:1fr;}.g-stats{grid-template-columns:repeat(2,1fr);}}
@media(max-width:480px){.g-stats{grid-template-columns:1fr;}}

/* STAT CARDS */
.stat-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px;transition:border-color .2s,box-shadow .2s;position:relative;overflow:hidden;}
.stat-card:hover{border-color:var(--border2);box-shadow:var(--glow-cyan);}
.stat-card::after{content:'';position:absolute;top:0;right:0;width:60px;height:60px;background:radial-gradient(circle,rgba(0,200,255,.06) 0%,transparent 70%);}
.stat-label{font-size:.72rem;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;}
.stat-val{font-family:var(--font-mono);font-size:1.65rem;font-weight:700;line-height:1;}
.stat-sub{font-size:.72rem;color:var(--text2);margin-top:6px;}
.c-cyan{color:var(--accent);}.c-green{color:var(--green);}.c-red{color:var(--red);}.c-yellow{color:var(--yellow);}.c-purple{color:var(--purple);}.c-white{color:#fff;}

/* PANELS */
.panel{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:20px;overflow:hidden;}
.panel-head{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--card2);}
.panel-title{font-family:var(--font-head);font-size:.92rem;font-weight:700;color:var(--text);display:flex;align-items:center;gap:8px;}
.panel-body{padding:20px;}

/* TABLES */
.tbl-wrap{overflow-x:auto;}
table{width:100%;border-collapse:collapse;font-size:.84rem;}
th{padding:10px 14px;font-size:.7rem;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid var(--border);text-align:left;font-family:var(--font-mono);}
td{padding:11px 14px;border-bottom:1px solid rgba(28,51,73,.5);}
tr:last-child td{border-bottom:none;}
tr:hover td{background:rgba(0,200,255,.03);}

/* PILLS */
.pill{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:99px;font-size:.7rem;font-weight:700;font-family:var(--font-mono);letter-spacing:.04em;}
.pill-long{background:rgba(0,230,118,.12);color:var(--green);border:1px solid rgba(0,230,118,.2);}
.pill-short{background:rgba(255,51,85,.12);color:var(--red);border:1px solid rgba(255,51,85,.2);}
.pill-pending{background:rgba(255,171,0,.1);color:var(--yellow);border:1px solid rgba(255,171,0,.2);}
.pill-active{background:rgba(0,200,255,.1);color:var(--accent);border:1px solid rgba(0,200,255,.2);}
.pill-win{background:rgba(0,230,118,.12);color:var(--green);}
.pill-loss{background:rgba(255,51,85,.1);color:var(--red);}
.pill-be{background:rgba(92,135,168,.1);color:var(--text2);}
.pill-ok{background:rgba(0,230,118,.1);color:var(--green);}
.pill-admin{background:rgba(179,136,255,.1);color:var(--purple);}
.pill-user{background:rgba(0,200,255,.1);color:var(--accent);}
.pill-susp{background:rgba(255,51,85,.1);color:var(--red);}

/* BUTTONS */
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 18px;border-radius:var(--radius-sm);font-size:.84rem;font-weight:600;cursor:pointer;border:none;transition:all .15s;font-family:var(--font-body);white-space:nowrap;}
.btn:disabled{opacity:.35;cursor:not-allowed;}
.btn-primary{background:var(--accent);color:#000;}
.btn-primary:hover:not(:disabled){background:#33d6ff;box-shadow:0 0 20px rgba(0,200,255,.35);}
.btn-success{background:var(--green);color:#000;}
.btn-success:hover:not(:disabled){background:#33ff8c;box-shadow:0 0 20px rgba(0,230,118,.35);}
.btn-danger{background:var(--red);color:#fff;}
.btn-danger:hover:not(:disabled){opacity:.88;}
.btn-ghost{background:var(--card2);color:var(--text3);border:1px solid var(--border);}
.btn-ghost:hover:not(:disabled){border-color:var(--border2);color:var(--text);}
.btn-warn{background:rgba(255,171,0,.12);color:var(--yellow);border:1px solid rgba(255,171,0,.25);}
.btn-sm{padding:5px 12px;font-size:.78rem;}

/* INPUTS */
.field{margin-bottom:16px;}
.field-label{display:block;font-size:.78rem;font-weight:600;color:var(--text2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;}
.inp{width:100%;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:9px 13px;color:var(--text);font-size:.88rem;font-family:var(--font-body);transition:border-color .15s;}
.inp:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(0,200,255,.1);}
select.inp{cursor:pointer;}

/* TOGGLE */
.toggle-row{display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--border);}
.toggle-row:last-child{border-bottom:none;}
.toggle-info h3{font-size:.9rem;font-weight:600;color:var(--text);margin-bottom:2px;}
.toggle-info p{font-size:.77rem;color:var(--text2);}
.toggle{position:relative;width:44px;height:24px;flex-shrink:0;}
.toggle input{opacity:0;width:0;height:0;}
.slider{position:absolute;inset:0;background:#1a3349;border-radius:99px;cursor:pointer;transition:.25s;border:1px solid var(--border);}
.slider:before{content:'';position:absolute;width:18px;height:18px;left:2px;top:2px;background:var(--text2);border-radius:50%;transition:.25s;}
input:checked+.slider{background:rgba(0,230,118,.2);border-color:var(--green2);}
input:checked+.slider:before{transform:translateX(20px);background:var(--green);}

/* PARAM ROWS */
.param-row{display:grid;grid-template-columns:1fr 160px;align-items:center;gap:14px;padding:12px 0;border-bottom:1px solid var(--border);}
.param-row:last-child{border-bottom:none;}
.param-label{font-size:.87rem;font-weight:500;color:var(--text);}
.param-key{font-size:.7rem;color:var(--text2);font-family:var(--font-mono);margin-top:2px;}
.param-unit{font-size:.7rem;color:var(--accent);margin-left:4px;}
.param-hint{font-size:.72rem;color:var(--text2);}
.inp-num{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:7px 10px;color:var(--text);font-size:.88rem;width:100%;font-family:var(--font-mono);text-align:right;}
.inp-num:focus{outline:none;border-color:var(--accent);}
.inp-num:disabled{opacity:.4;cursor:not-allowed;}

/* LOG BOX */
.log-box{background:#03080e;border:1px solid var(--border);border-radius:var(--radius);height:360px;overflow-y:auto;padding:12px 16px;font-family:var(--font-mono);font-size:.75rem;line-height:1.8;}
.log-box::-webkit-scrollbar{width:4px;}
.log-box::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px;}
.log-warn{color:var(--yellow);}.log-error{color:var(--red);}.log-info{color:var(--text2);}.log-bot{color:var(--green);}.log-signal{color:var(--accent);font-weight:700;}

/* STATUS DOT */
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle;}
.dot-green{background:var(--green);box-shadow:0 0 8px var(--green);}
.dot-red{background:var(--red);}
.dot-yellow{background:var(--yellow);}
.dot-grey{background:var(--text2);}

/* ANIMATIONS */
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:.45;}}
@keyframes fadeUp{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:translateY(0);}}
@keyframes slideIn{from{opacity:0;transform:translateX(20px);}to{opacity:1;transform:translateX(0);}}
@keyframes spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}
.pulse{animation:pulse 2s ease-in-out infinite;}
.fade-up{animation:fadeUp .4s ease;}

/* SIGNAL CARDS */
.signal-card{border-radius:var(--radius);border:1px solid var(--border);padding:18px 20px;margin-bottom:14px;transition:all .2s;animation:slideIn .3s ease;position:relative;overflow:hidden;}
.signal-card.long-card{background:var(--long-card);border-color:rgba(0,230,118,.2);}
.signal-card.short-card{background:var(--short-card);border-color:rgba(255,51,85,.2);}
.signal-card:hover{transform:translateX(4px);}
.signal-card .score-ring{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:1rem;font-weight:700;border:2px solid;flex-shrink:0;}
.signal-levels{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:14px;}
.sig-level{background:rgba(0,0,0,.3);border-radius:6px;padding:8px 10px;}
.sig-level-label{font-size:.65rem;color:var(--text2);font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px;}
.sig-level-val{font-family:var(--font-mono);font-size:.85rem;font-weight:700;}
@media(max-width:600px){.signal-levels{grid-template-columns:repeat(2,1fr);}}

/* STAT ROW */
.stat-row{display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px solid var(--border);font-size:.87rem;}
.stat-row:last-child{border-bottom:none;}
.stat-row-val{font-weight:600;font-family:var(--font-mono);}

/* HEALTH */
.health-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;}
.health-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;}
.health-label{font-size:.85rem;font-weight:600;color:var(--text);margin-bottom:4px;}
.health-status{font-size:.78rem;}

/* SCORE RING LARGE */
.score-ring-lg{width:92px;height:92px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:1.8rem;font-weight:800;border:3px solid;flex-shrink:0;}

/* TOAST */
.toast{position:fixed;bottom:24px;right:24px;z-index:9999;background:var(--card2);border:1px solid var(--green);color:var(--green);padding:10px 18px;border-radius:var(--radius);font-size:.84rem;font-weight:500;display:none;box-shadow:var(--glow-green);}
.toast.err{border-color:var(--red);color:var(--red);box-shadow:var(--glow-red);}
.toast.info{border-color:var(--accent);color:var(--accent);box-shadow:var(--glow-cyan);}

/* SCAN HERO */
.scan-hero{background:linear-gradient(135deg,#031526,#060d17);border:1px solid var(--accent);border-radius:var(--radius-lg);padding:30px 26px;margin-bottom:20px;display:flex;align-items:center;gap:26px;flex-wrap:wrap;box-shadow:var(--glow-cyan);}

/* PRO BANNER */
.pro-banner{background:linear-gradient(135deg,rgba(0,200,255,.07),rgba(124,58,237,.07));border:1px solid rgba(0,200,255,.15);border-radius:var(--radius);padding:18px 22px;margin-bottom:22px;display:flex;align-items:center;gap:18px;}
.pro-overlay{opacity:.35;pointer-events:none;user-select:none;}
.pro-badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:.65rem;font-weight:800;background:linear-gradient(90deg,var(--accent),#7c3aed);color:#fff;margin-left:6px;vertical-align:middle;font-family:var(--font-mono);}

/* UPDATE */
.update-out{background:#02060a;border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;font-family:var(--font-mono);font-size:.76rem;max-height:180px;overflow-y:auto;display:none;margin-top:12px;white-space:pre-wrap;color:var(--text3);}

/* AUTH */
.auth-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
.auth-box{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:44px 40px;width:100%;max-width:400px;box-shadow:0 24px 64px rgba(0,0,0,.5);animation:fadeUp .35s ease;}
.auth-logo{text-align:center;margin-bottom:30px;}
.auth-logo-icon{font-size:2.4rem;margin-bottom:10px;}
.auth-title{font-family:var(--font-head);font-size:1.5rem;font-weight:800;color:#fff;margin-bottom:4px;}
.auth-sub{font-size:.84rem;color:var(--text2);}
.auth-alert-err{background:rgba(255,51,85,.1);border:1px solid rgba(255,51,85,.25);border-radius:var(--radius-sm);padding:11px 14px;margin-bottom:16px;font-size:.83rem;color:var(--red);}
.auth-alert-ok{background:rgba(0,230,118,.08);border:1px solid rgba(0,230,118,.2);border-radius:var(--radius-sm);padding:11px 14px;margin-bottom:16px;font-size:.83rem;color:var(--green);}
.auth-footer{text-align:center;margin-top:22px;font-size:.82rem;color:var(--text2);}

/* SIGNAL TOAST POPUP */
.signal-toast{position:fixed;bottom:24px;right:24px;z-index:9998;background:var(--card2);border:1px solid;border-radius:var(--radius);padding:16px 20px;max-width:320px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.5);animation:slideIn .3s ease;}
.signal-toast.long-toast{border-color:rgba(0,230,118,.4);box-shadow:var(--glow-green);}
.signal-toast.short-toast{border-color:rgba(255,51,85,.4);box-shadow:var(--glow-red);}

/* SCANNER STATUS */
.scanner-status-card{border-radius:var(--radius);padding:22px 24px;display:flex;align-items:center;gap:18px;border:1px solid var(--border);}
.scanner-status-card.active{background:rgba(0,230,118,.04);border-color:rgba(0,230,118,.25);}
.scanner-status-icon{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0;}
`;

// ─── HTML Shell ────────────────────────────────────────────────────────
function _html(title, body, extraCss = '') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Apex-MD</title>
${GOOGLE_FONTS}
<style>${CSS_BASE}${extraCss}</style>
</head>
<body>${body}
<script>
// Global signal toast — shown on EVERY page when a new signal fires
window._showSignalToast = function(sig) {
  const old = document.getElementById('sig-toast');
  if (old) old.remove();
  const isLong = sig.direction === 'LONG';
  const el = document.createElement('div');
  el.id = 'sig-toast';
  el.className = 'signal-toast ' + (isLong ? 'long-toast' : 'short-toast');
  el.innerHTML = \`
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div style="font-family:var(--font-head);font-weight:700;font-size:.95rem;color:#fff">
        \${isLong ? '🟢' : '🔴'} \${sig.coin} \${sig.direction}
      </div>
      <div style="font-size:.7rem;color:var(--text2);font-family:var(--font-mono)">\${sig.score}/100</div>
    </div>
    <div style="font-size:.78rem;color:var(--text2);font-family:var(--font-mono)">
      Entry: <span style="color:var(--accent)">$\${parseFloat(sig.price||0).toFixed(4)}</span>
      &nbsp;|&nbsp; SL: <span style="color:var(--red)">$\${parseFloat(sig.sl||0).toFixed(4)}</span>
    </div>
    <div style="font-size:.7rem;color:var(--text2);margin-top:6px">New signal via Apex-MD 🚀</div>
  \`;
  document.body.appendChild(el);
  setTimeout(() => { el.style.transition='opacity .5s'; el.style.opacity='0'; }, 7000);
  setTimeout(() => el.remove(), 7600);
};
(function() {
  try {
    const es = new EventSource('/admin/api/signals/stream');
    es.onmessage = e => {
      try {
        const sig = JSON.parse(e.data);
        window._showSignalToast(sig);
        const badge = document.getElementById('signal-count-badge');
        if (badge) { const n = parseInt(badge.textContent||'0')+1; badge.textContent=n; badge.style.display='flex'; }
      } catch(_) {}
    };
  } catch(_) {}
})();
</script>
</body>
</html>`;
}

// ─── Admin Nav ─────────────────────────────────────────────────────────
function _adminNav(active, pendingUpdate, scannerActive) {
    const upBadge   = pendingUpdate ? '<span class="nav-badge">!</span>' : '';
    const scanBadge = scannerActive ? '<span class="nav-badge green">ON</span>' : '';
    const sigCount  = _signalBuffer.length;
    return `
<nav class="nav">
  <div class="nav-logo">
    <span>⚡</span> Apex-MD
    <span class="nav-logo-badge">v${config.VERSION}</span>
  </div>
  <div class="nav-links">
    <a href="/admin/"         class="nav-link ${active==='home'    ?'active':''}">Dashboard</a>
    <a href="/admin/signals"  class="nav-link ${active==='signals' ?'active':''}">Signals${sigCount?`<span id="signal-count-badge" class="nav-badge green">${sigCount}</span>`:'<span id="signal-count-badge" class="nav-badge green" style="display:none">0</span>'}</a>
    <a href="/admin/trades"   class="nav-link ${active==='trades'  ?'active':''}">Trades</a>
    <a href="/admin/stats"    class="nav-link ${active==='stats'   ?'active':''}">Stats</a>
    <a href="/admin/users"    class="nav-link ${active==='users'   ?'active':''}">Users</a>
    <a href="/admin/scanner"  class="nav-link ${active==='scanner' ?'active':''}">Scanner${scanBadge}</a>
    <a href="/admin/settings" class="nav-link ${active==='settings'?'active':''}">Settings</a>
    <a href="/admin/updater"  class="nav-link ${active==='updater' ?'active':''}">Updater${upBadge}</a>
    <a href="/auth/logout"    class="nav-btn">Logout →</a>
  </div>
</nav>`;
}

// ─── App Nav ───────────────────────────────────────────────────────────
function _appNav(active, username) {
    return `
<nav class="nav">
  <div class="nav-logo">
    <span>⚡</span> Apex-MD
    <span class="nav-logo-badge" style="background:linear-gradient(135deg,#1a3349,#254560);color:var(--text3)">PORTAL</span>
  </div>
  <div class="nav-links">
    <a href="/app/"          class="nav-link ${active==='home'      ?'active':''}">Dashboard</a>
    <a href="/app/scanner"   class="nav-link ${active==='scanner'   ?'active':''}">⚡ Scanner</a>
    <a href="/app/paper"     class="nav-link ${active==='paper'     ?'active':''}">📄 Paper</a>
    <a href="/app/watchlist" class="nav-link ${active==='watchlist' ?'active':''}">👁 Watch</a>
    <a href="/app/alerts"    class="nav-link ${active==='alerts'    ?'active':''}">🔔 Alerts</a>
    <a href="/app/news"      class="nav-link ${active==='news'      ?'active':''}">📰 Intel</a>
    <a href="/app/calc"      class="nav-link ${active==='calc'      ?'active':''}">🧮 Calc</a>
    <a href="/app/trades"    class="nav-link ${active==='trades'    ?'active':''}">Trades</a>
    <a href="/app/settings"  class="nav-link ${active==='settings'  ?'active':''}">⚙️</a>
    <span style="font-size:.78rem;color:var(--text2);padding:0 5px;font-family:var(--font-mono)">👤 ${username||''}</span>
    <a href="/auth/logout" class="nav-btn">Logout →</a>
  </div>
</nav>`;
}

// ─── Helpers ───────────────────────────────────────────────────────────
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
function initDashboard() {
    const app  = express();
    const port = config.DASHBOARD_PORT;

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.get('/admin/login',  (req, res) => res.redirect('/auth/login'));
    app.get('/admin/logout', (req, res) => res.redirect('/auth/logout'));
    app.use('/admin', requireAdminAuth);

    // ─── Admin Home ────────────────────────────────────────────────────
    app.get('/admin/', async (req, res) => {
        let trades = [], tradeCount = 0;
        try {
            trades = await db.Trade.find({ status: { $in: ['active','pending'] } }).lean();
            tradeCount = trades.length;
        } catch (_) {}

        const tradesHtml = trades.length === 0
            ? `<tr><td colspan="8" style="text-align:center;color:var(--text2);padding:28px"><span style="font-size:1.5rem;display:block;margin-bottom:8px">🛑</span>No active trades</td></tr>`
            : trades.map(t => {
                const dir = t.direction==='LONG' ? '<span class="pill pill-long">▲ LONG</span>' : '<span class="pill pill-short">▼ SHORT</span>';
                const st  = t.status==='pending' ? '<span class="pill pill-pending">PENDING</span>' : '<span class="pill pill-active">ACTIVE</span>';
                const hrs = ((Date.now() - new Date(t.openTime)) / 3600000).toFixed(1);
                return `<tr>
                  <td><strong style="font-family:var(--font-mono)">${t.coin}</strong>${t.isPaper?' <span style="font-size:.7rem;color:var(--text2)">📄</span>':''}</td>
                  <td>${dir}</td>
                  <td style="font-family:var(--font-mono)">${fmtPrice(t.entry)}</td>
                  <td style="font-family:var(--font-mono);color:var(--green)">${fmtPrice(t.tp2||t.tp)}</td>
                  <td style="font-family:var(--font-mono);color:var(--red)">${fmtPrice(t.sl)}</td>
                  <td style="font-family:var(--font-mono)">${t.leverage||1}x</td>
                  <td>${st}</td>
                  <td style="color:var(--text2);font-family:var(--font-mono)">${hrs}h</td>
                </tr>`;
            }).join('');

        const uptime = Math.floor((Date.now() - _botState.startTime) / 60000);
        const uptimeStr = uptime >= 60 ? `${Math.floor(uptime/60)}h ${uptime%60}m` : `${uptime}m`;
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        let saasUserCount = 0;
        try { saasUserCount = await db.SaasUser.countDocuments(); } catch (_) {}

        const waIcon   = _botState.waConnected ? '<span class="dot dot-green pulse"></span>' : '<span class="dot dot-red"></span>';
        const scanIcon = scannerActive ? '<span class="dot dot-green pulse"></span>' : '<span class="dot dot-grey"></span>';

        res.send(_html('Dashboard', `
${_adminNav('home', _botState.pendingUpdate, scannerActive)}
<div class="wrap">
  <h1 class="page-title">📊 Admin Dashboard <span>Live Overview</span></h1>

  <div class="g-stats">
    <div class="stat-card">
      <div class="stat-label">WhatsApp</div>
      <div class="stat-val ${_botState.waConnected?'c-green':'c-red'}" id="wa-val">${waIcon}${_botState.waConnected?'Online':'Offline'}</div>
      <div class="stat-sub">Bot connection</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Auto Scanner</div>
      <div class="stat-val ${scannerActive?'c-green':'c-yellow'}" id="scan-val">${scanIcon}${scannerActive?'Active':'Standby'}</div>
      <div class="stat-sub">Signal engine</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Active Trades</div>
      <div class="stat-val c-cyan" id="trade-count-val">${tradeCount}</div>
      <div class="stat-sub">Open positions</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Signals Today</div>
      <div class="stat-val c-purple">${_signalBuffer.filter(s=>Date.now()-s.ts<86400000).length}</div>
      <div class="stat-sub">Website feed</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Uptime</div>
      <div class="stat-val c-white" id="uptime-val">${uptimeStr}</div>
      <div class="stat-sub">Since last restart</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">SaaS Users</div>
      <div class="stat-val c-purple">${saasUserCount}</div>
      <div class="stat-sub">Registered accounts</div>
    </div>
  </div>

  <div class="panel" style="margin-bottom:20px">
    <div class="panel-head">
      <div class="panel-title">🔌 API Health Monitor</div>
      <button class="btn btn-ghost btn-sm" onclick="refreshHealth()">↺ Refresh</button>
    </div>
    <div class="panel-body">
      <div class="health-grid" id="health-grid"><div style="color:var(--text2);font-size:.85rem">⏳ Checking APIs...</div></div>
    </div>
  </div>

  <div class="panel" style="margin-bottom:20px">
    <div class="panel-head">
      <div class="panel-title">⚡ Active Trades</div>
      <a href="/admin/trades" class="btn btn-ghost btn-sm">View All →</a>
    </div>
    <div class="panel-body" style="padding:0">
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP2</th><th>SL</th><th>Lev</th><th>Status</th><th>Open</th></tr></thead>
          <tbody>${tradesHtml}</tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <div class="panel-title">🖥️ Live Logs</div>
      <button class="btn btn-ghost btn-sm" onclick="clearLogs()">🗑️ Clear</button>
    </div>
    <div class="panel-body" style="padding:14px">
      <div class="log-box" id="log-box"><div class="log-info">Connecting to log stream...</div></div>
    </div>
  </div>
</div>

<script>
const lb = document.getElementById('log-box');
const es = new EventSource('/admin/api/logs/stream');
let autoScroll = true;
lb.addEventListener('scroll', () => { autoScroll = lb.scrollTop + lb.clientHeight >= lb.scrollHeight - 40; });
es.onmessage = e => {
  const d = JSON.parse(e.data), el = document.createElement('div'), msg = d.msg||'';
  el.className = 'log-' + (msg.includes('[ERROR]')?'error':msg.includes('[WARN]')?'warn':msg.includes('[SIGNAL]')?'signal':msg.includes('[BOT]')?'bot':'info');
  el.textContent = new Date(d.ts).toLocaleTimeString() + '  ' + msg;
  lb.appendChild(el);
  if (autoScroll) lb.scrollTop = lb.scrollHeight;
};
es.onerror = () => { const el=document.createElement('div');el.className='log-warn';el.textContent='[stream disconnected — reload page]';lb.appendChild(el); };
function clearLogs() { lb.innerHTML=''; }

setInterval(async () => {
  try {
    const d = await (await fetch('/admin/api/status')).json();
    const waEl = document.getElementById('wa-val');
    waEl.className = 'stat-val ' + (d.waConnected?'c-green':'c-red');
    waEl.innerHTML = d.waConnected ? '<span class="dot dot-green pulse"></span>Online' : '<span class="dot dot-red"></span>Offline';
    const scanEl = document.getElementById('scan-val');
    scanEl.className = 'stat-val ' + (d.scannerActive?'c-green':'c-yellow');
    scanEl.innerHTML = d.scannerActive ? '<span class="dot dot-green pulse"></span>Active' : '<span class="dot dot-grey"></span>Standby';
    document.getElementById('trade-count-val').textContent = d.tradeCount;
    document.getElementById('uptime-val').textContent = d.uptime;
  } catch(_) {}
}, 10000);

async function refreshHealth() {
  const g = document.getElementById('health-grid');
  g.innerHTML = '<div style="color:var(--text2);font-size:.85rem">⏳ Checking...</div>';
  try {
    const h = await (await fetch('/admin/api/health')).json();
    g.innerHTML = Object.values(h).map(s => {
      const cls  = s.missing ? 'dot-yellow' : (s.ok ? 'dot-green' : 'dot-red');
      const text = s.missing ? '⚠️ Not configured' : (s.ok ? '✅ Online' : (s.warn ? '⚠️ Warning' : '❌ Offline'));
      return \`<div class="health-card">
        <div class="health-label"><span class="dot \${cls}"></span>\${s.label}</div>
        <div class="health-status" style="color:\${s.ok&&!s.missing?'var(--green)':s.missing?'var(--yellow)':'var(--red)'}">\${text}</div>
      </div>\`;
    }).join('');
  } catch { g.innerHTML = '<div style="color:var(--red)">❌ Health check failed</div>'; }
}
refreshHealth();
</script>`));
    });

    // ─── Admin Signals (NEW PAGE) ──────────────────────────────────────
    app.get('/admin/signals', (req, res) => {
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}

        const signals = [..._signalBuffer].reverse();
        const signalsHtml = signals.length === 0
            ? `<div style="text-align:center;padding:60px 20px;color:var(--text2)">
                 <div style="font-size:3rem;margin-bottom:16px">📡</div>
                 <div style="font-size:1rem;font-weight:600;margin-bottom:8px">No signals yet</div>
                 <div style="font-size:.85rem">Signals appear here when the scanner fires.<br>
                 WhatsApp notifications still go as normal.<br><br>
                 <strong style="color:var(--accent)">To enable full website signal feed:</strong><br>
                 Add <code style="background:#0d1f30;padding:2px 6px;border-radius:4px;font-size:.78rem">try{require('../dashboard').pushSignal(setup);}catch(_){}</code><br>
                 to <code>lib/signalDispatch.js</code> after building the alert.</div>
               </div>`
            : signals.map(sig => {
                const isLong = sig.direction === 'LONG';
                const sc     = scoreColor(sig.score);
                const ageMs  = Date.now() - sig.ts;
                const ageStr = ageMs < 3600000 ? Math.floor(ageMs/60000) + 'm ago' : Math.floor(ageMs/3600000) + 'h ago';
                return `
<div class="signal-card ${isLong?'long-card':'short-card'}">
  <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
    <div class="score-ring" style="border-color:${sc};color:${sc}">${sig.score}</div>
    <div style="flex:1">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap">
        <span style="font-family:var(--font-head);font-size:1.15rem;font-weight:800;color:#fff">${sig.coin}</span>
        <span class="pill ${isLong?'pill-long':'pill-short'}">${isLong?'▲':'▼'} ${sig.direction}</span>
        ${sig.orderType?`<span class="pill pill-active" style="font-size:.65rem">${sig.orderType}</span>`:''}
        <span style="font-family:var(--font-mono);font-size:.72rem;color:var(--text2);margin-left:auto">${ageStr}</span>
      </div>
      <div style="font-size:.78rem;color:var(--text2);line-height:1.6">${(sig.reasons||'').split(',').slice(0,6).map(r=>r.trim()).filter(Boolean).map(r=>`<span style="display:inline-block;background:rgba(0,200,255,.06);border-radius:4px;padding:1px 6px;margin:1px">${r}</span>`).join('')}</div>
    </div>
  </div>
  <div class="signal-levels">
    <div class="sig-level"><div class="sig-level-label">Entry</div><div class="sig-level-val c-cyan">${fmtPrice(sig.price)}</div></div>
    <div class="sig-level"><div class="sig-level-label">Stop Loss</div><div class="sig-level-val c-red">${fmtPrice(sig.sl)}</div></div>
    <div class="sig-level"><div class="sig-level-label">TP1</div><div class="sig-level-val c-green">${fmtPrice(sig.tp1)}</div></div>
    <div class="sig-level"><div class="sig-level-label">TP2</div><div class="sig-level-val c-green">${fmtPrice(sig.tp2)}</div></div>
  </div>
</div>`;
            }).join('');

        res.send(_html('Signals', `
${_adminNav('signals', _botState.pendingUpdate, scannerActive)}
<div class="wrap">
  <h1 class="page-title">📡 Signal Feed
    <span>${_signalBuffer.length} total</span>
    <div style="display:flex;gap:8px;margin-left:auto">
      <button class="btn btn-ghost btn-sm" id="filter-all"   onclick="setFilter('all')">All</button>
      <button class="btn btn-ghost btn-sm" id="filter-long"  onclick="setFilter('long')">🟢 Long</button>
      <button class="btn btn-ghost btn-sm" id="filter-short" onclick="setFilter('short')">🔴 Short</button>
    </div>
  </h1>

  <div style="background:rgba(0,200,255,.05);border:1px solid rgba(0,200,255,.15);border-radius:var(--radius);padding:14px 18px;margin-bottom:22px;font-size:.84rem;color:var(--text3)">
    🔔 Signals appear here in real-time alongside WhatsApp notifications.
    Live updates via SSE — no page refresh needed.
    <strong style="color:var(--accent)">New signals flash as popups on all pages.</strong>
  </div>

  <div id="signals-list">${signalsHtml}</div>
</div>

<script>
const sigEs = new EventSource('/admin/api/signals/stream');
sigEs.onmessage = e => {
  try {
    const sig = JSON.parse(e.data);
    if (!matchesFilter(sig)) return;
    const isLong = sig.direction==='LONG';
    const sc = sig.score>=70?'var(--green)':sig.score>=45?'var(--yellow)':'var(--red)';
    const card = document.createElement('div');
    card.className = 'signal-card '+(isLong?'long-card':'short-card');
    const reasons = (sig.reasons||'').split(',').slice(0,6).map(r=>r.trim()).filter(Boolean)
      .map(r=>'<span style="display:inline-block;background:rgba(0,200,255,.06);border-radius:4px;padding:1px 6px;margin:1px">'+r+'</span>').join('');
    card.innerHTML = \`
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <div class="score-ring" style="border-color:\${sc};color:\${sc}">\${sig.score}</div>
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap">
            <span style="font-family:var(--font-head);font-size:1.15rem;font-weight:800;color:#fff">\${sig.coin}</span>
            <span class="pill \${isLong?'pill-long':'pill-short'}">\${isLong?'▲':'▼'} \${sig.direction}</span>
            <span style="font-family:var(--font-mono);font-size:.72rem;color:var(--text2);margin-left:auto">just now</span>
          </div>
          <div style="font-size:.78rem;color:var(--text2)">\${reasons}</div>
        </div>
      </div>
      <div class="signal-levels">
        <div class="sig-level"><div class="sig-level-label">Entry</div><div class="sig-level-val c-cyan">\${sig.price?'$'+parseFloat(sig.price).toFixed(4):'—'}</div></div>
        <div class="sig-level"><div class="sig-level-label">SL</div><div class="sig-level-val c-red">\${sig.sl?'$'+parseFloat(sig.sl).toFixed(4):'—'}</div></div>
        <div class="sig-level"><div class="sig-level-label">TP1</div><div class="sig-level-val c-green">\${sig.tp1?'$'+parseFloat(sig.tp1).toFixed(4):'—'}</div></div>
        <div class="sig-level"><div class="sig-level-label">TP2</div><div class="sig-level-val c-green">\${sig.tp2?'$'+parseFloat(sig.tp2).toFixed(4):'—'}</div></div>
      </div>\`;
    const list = document.getElementById('signals-list');
    if (list.children[0] && list.children[0].textContent.includes('No signals')) list.innerHTML='';
    list.prepend(card);
  } catch(_) {}
};

let _filter = 'all';
function setFilter(f) {
  _filter = f;
  ['all','long','short'].forEach(x => {
    document.getElementById('filter-'+x).className = 'btn btn-sm '+(f===x?'btn-primary':'btn-ghost');
  });
  document.querySelectorAll('.signal-card').forEach(card => {
    if (f==='all') card.style.display='';
    else if (f==='long')  card.style.display=card.classList.contains('long-card') ?'':'none';
    else card.style.display=card.classList.contains('short-card')?'':'none';
  });
}
function matchesFilter(sig) {
  if (_filter==='all') return true;
  if (_filter==='long'  && sig.direction==='LONG')  return true;
  if (_filter==='short' && sig.direction==='SHORT') return true;
  return false;
}
setFilter('all');
</script>`));
    });

    // ─── Admin Trades ──────────────────────────────────────────────────
    app.get('/admin/trades', async (req, res) => {
        let activeHtml = '', closedHtml = '';
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        try {
            const active = await db.Trade.find({ status: { $in: ['active','pending'] } }).sort({ openTime:-1 }).lean();
            activeHtml = active.length===0
                ? `<tr><td colspan="8" style="text-align:center;color:var(--text2);padding:28px">No active trades</td></tr>`
                : active.map(t => {
                    const dir = t.direction==='LONG' ? '<span class="pill pill-long">▲ LONG</span>' : '<span class="pill pill-short">▼ SHORT</span>';
                    const st  = t.status==='pending' ? '<span class="pill pill-pending">PENDING</span>' : '<span class="pill pill-active">ACTIVE</span>';
                    const hrs = ((Date.now()-new Date(t.openTime))/3600000).toFixed(1);
                    return `<tr>
                      <td><strong style="font-family:var(--font-mono)">${t.coin}</strong>${t.isPaper?' <span style="color:var(--text2);font-size:.7rem">📄</span>':''}</td>
                      <td>${dir}</td>
                      <td style="font-family:var(--font-mono)">${fmtPrice(t.entry)}</td>
                      <td style="font-family:var(--font-mono);color:var(--text3)">${fmtPrice(t.tp1)}</td>
                      <td style="font-family:var(--font-mono);color:var(--green)">${fmtPrice(t.tp2||t.tp)}</td>
                      <td style="font-family:var(--font-mono);color:var(--red)">${fmtPrice(t.sl)}</td>
                      <td style="font-family:var(--font-mono)">${t.leverage||1}x</td>
                      <td>${st} <span style="color:var(--text2);font-size:.75rem;font-family:var(--font-mono)">${hrs}h</span></td>
                    </tr>`;
                }).join('');
            const closed = await db.Trade.find({ status:'closed' }).sort({ closedAt:-1 }).limit(50).lean();
            closedHtml = closed.length===0
                ? `<tr><td colspan="8" style="text-align:center;color:var(--text2);padding:28px">No closed trades yet</td></tr>`
                : closed.map(t => {
                    const dir    = t.direction==='LONG' ? '<span class="pill pill-long">▲ LONG</span>' : '<span class="pill pill-short">▼ SHORT</span>';
                    const result = t.result==='WIN' ? '<span class="pill pill-win">WIN</span>' : t.result==='LOSS' ? '<span class="pill pill-loss">LOSS</span>' : '<span class="pill pill-be">B/E</span>';
                    const pnl    = t.pnlPct ? fmtPct(t.pnlPct) : '—';
                    const pnlColor = t.pnlPct>0?'var(--green)':t.pnlPct<0?'var(--red)':'var(--text2)';
                    const dt     = t.closedAt ? new Date(t.closedAt).toLocaleDateString() : '—';
                    return `<tr>
                      <td><strong style="font-family:var(--font-mono)">${t.coin}</strong>${t.isPaper?' <span style="color:var(--text2);font-size:.7rem">📄</span>':''}</td>
                      <td>${dir}</td>
                      <td style="font-family:var(--font-mono)">${fmtPrice(t.entry)}</td>
                      <td style="font-family:var(--font-mono);color:var(--green)">${fmtPrice(t.tp2||t.tp)}</td>
                      <td style="font-family:var(--font-mono);color:var(--red)">${fmtPrice(t.sl)}</td>
                      <td>${result}</td>
                      <td style="font-family:var(--font-mono);font-weight:700;color:${pnlColor}">${pnl}</td>
                      <td style="font-size:.8rem;color:var(--text2)">${dt}</td>
                    </tr>`;
                }).join('');
        } catch (_) {}

        res.send(_html('Trades', `
${_adminNav('trades', _botState.pendingUpdate, scannerActive)}
<div class="wrap">
  <h1 class="page-title">📋 All Trades</h1>
  <div class="panel" style="margin-bottom:20px">
    <div class="panel-head"><div class="panel-title">⚡ Active &amp; Pending</div></div>
    <div class="panel-body" style="padding:0"><div class="tbl-wrap">
      <table><thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP1</th><th>TP2</th><th>SL</th><th>Lev</th><th>Status</th></tr></thead>
      <tbody>${activeHtml}</tbody></table>
    </div></div>
  </div>
  <div class="panel">
    <div class="panel-head"><div class="panel-title">📜 Closed Trades <span style="font-size:.78rem;color:var(--text2);margin-left:6px">(Last 50)</span></div></div>
    <div class="panel-body" style="padding:0"><div class="tbl-wrap">
      <table><thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP2</th><th>SL</th><th>Result</th><th>PnL %</th><th>Date</th></tr></thead>
      <tbody>${closedHtml}</tbody></table>
    </div></div>
  </div>
</div>`));
    });

    // ─── Admin Stats ───────────────────────────────────────────────────
    app.get('/admin/stats', async (req, res) => {
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        const calcStats = (arr) => {
            if (!arr.length) return null;
            const wins=arr.filter(t=>t.result==='WIN').length, loss=arr.filter(t=>t.result==='LOSS').length;
            const totalPnl=arr.reduce((s,t)=>s+(t.pnlPct||0),0);
            const best=arr.reduce((b,t)=>(t.pnlPct||0)>(b?.pnlPct||0)?t:b,null);
            const worst=arr.reduce((w,t)=>(t.pnlPct||0)<(w?.pnlPct||0)?t:w,null);
            return { total:arr.length, wins, loss, wr:((wins/arr.length)*100).toFixed(1), totalPnl:totalPnl.toFixed(2), best, worst };
        };
        let stats=null, paperStats=null;
        try {
            stats=calcStats(await db.Trade.find({status:'closed',isPaper:false}).lean());
            paperStats=calcStats(await db.Trade.find({status:'closed',isPaper:true}).lean());
        } catch (_) {}

        const statBlock = (s, title, emoji) => {
            if (!s) return `<div class="panel" style="margin-bottom:20px"><div class="panel-head"><div class="panel-title">${emoji} ${title}</div></div><div class="panel-body" style="text-align:center;padding:40px;color:var(--text2)"><div style="font-size:2rem;margin-bottom:8px">🛑</div>No closed trades yet.</div></div>`;
            const wrNum=parseFloat(s.wr), pnlNum=parseFloat(s.totalPnl);
            const wrColor=wrNum>=55?'var(--green)':wrNum>=45?'var(--yellow)':'var(--red)';
            const pnlColor=pnlNum>=0?'var(--green)':'var(--red)';
            return `<div class="panel" style="margin-bottom:20px">
  <div class="panel-head"><div class="panel-title">${emoji} ${title}</div></div>
  <div class="panel-body">
    <div class="g-stats" style="margin-bottom:20px">
      <div class="stat-card"><div class="stat-label">Total Trades</div><div class="stat-val c-cyan">${s.total}</div></div>
      <div class="stat-card"><div class="stat-label">Win Rate</div><div class="stat-val" style="color:${wrColor}">${s.wr}%</div></div>
      <div class="stat-card"><div class="stat-label">Wins / Losses</div><div class="stat-val c-green">${s.wins}<span style="color:var(--text2);font-size:1rem"> W</span></div><div class="stat-sub" style="color:var(--red)">${s.loss} losses</div></div>
      <div class="stat-card"><div class="stat-label">Total PnL</div><div class="stat-val" style="color:${pnlColor}">${pnlNum>=0?'+':''}${s.totalPnl}%</div></div>
      <div class="stat-card"><div class="stat-label">Avg PnL/Trade</div><div class="stat-val" style="color:${parseFloat((pnlNum/s.total).toFixed(2))>=0?'var(--green)':'var(--red)'}">${parseFloat((pnlNum/s.total).toFixed(2))>=0?'+':''}${(pnlNum/s.total).toFixed(2)}%</div></div>
    </div>
    <div class="stat-row"><span>🏆 Best Trade</span><span class="stat-row-val c-green">${s.best?s.best.coin+' +'+(s.best.pnlPct||0).toFixed(2)+'%':'—'}</span></div>
    <div class="stat-row"><span>💀 Worst Trade</span><span class="stat-row-val c-red">${s.worst?s.worst.coin+' '+(s.worst.pnlPct||0).toFixed(2)+'%':'—'}</span></div>
  </div>
</div>`;
        };

        res.send(_html('Stats', `
${_adminNav('stats', _botState.pendingUpdate, scannerActive)}
<div class="wrap">
  <h1 class="page-title">📊 Performance Statistics</h1>
  ${statBlock(stats,'Live Trades','💰')}
  ${statBlock(paperStats,'Paper Trades','📄')}
</div>`));
    });

    // ─── Admin Scanner ─────────────────────────────────────────────────
    app.get('/admin/scanner', async (req, res) => {
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}

        res.send(_html('Scanner', `
${_adminNav('scanner', _botState.pendingUpdate, scannerActive)}
<div class="wrap">
  <h1 class="page-title">🔍 Scanner Control</h1>

  <div class="scanner-status-card ${scannerActive?'active':''}" style="margin-bottom:20px">
    <div class="scanner-status-icon" style="background:${scannerActive?'rgba(0,230,118,.1)':'var(--card2)'}">
      ${scannerActive?'🟢':'⚫'}
    </div>
    <div style="flex:1">
      <div style="font-family:var(--font-head);font-size:1.1rem;font-weight:700;margin-bottom:4px">
        Auto Scanner — <span id="scan-stat-text" style="color:${scannerActive?'var(--green)':'var(--text2)'}">${scannerActive?'Active':'Standby'}</span>
      </div>
      <div style="font-size:.82rem;color:var(--text2)">
        Monitors top <strong>${config.trading.WS_WATCH_COUNT}</strong> coins on 15m candle close.
        Min score: <strong style="color:var(--accent)">${config.trading.MIN_SCORE_THRESHOLD}/100</strong>
      </div>
    </div>
    <div style="display:flex;gap:10px">
      <button class="btn btn-success" id="btn-start" onclick="scannerCtrl('start')" ${scannerActive?'disabled':''}>▶ Start</button>
      <button class="btn btn-danger"  id="btn-stop"  onclick="scannerCtrl('stop')"  ${!scannerActive?'disabled':''}>⏹ Stop</button>
    </div>
  </div>

  <div id="scan-msg" style="margin-bottom:16px;font-size:.85rem"></div>

  <div class="g-2">
    <div class="panel">
      <div class="panel-head"><div class="panel-title">📈 Scanner Config</div></div>
      <div class="panel-body">
        <div class="stat-row"><span>Watched Coins</span><span class="stat-row-val c-cyan">${config.trading.WS_WATCH_COUNT}</span></div>
        <div class="stat-row"><span>Min Signal Score</span><span class="stat-row-val">${config.trading.MIN_SCORE_THRESHOLD}/100</span></div>
        <div class="stat-row"><span>Signal Cooldown</span><span class="stat-row-val">${config.trading.SIGNAL_COOLDOWN_HOURS}h</span></div>
        <div class="stat-row"><span>Max Open Trades</span><span class="stat-row-val">${config.trading.MAX_OPEN_TRADES}</span></div>
        <div class="stat-row"><span>SMC Scoring</span><span class="stat-row-val ${config.modules.SMC?'c-green':'c-red'}">${config.modules.SMC?'✅ On':'❌ Off'}</span></div>
        <div style="margin-top:14px;font-size:.78rem;color:var(--text2)">Adjust in <a href="/admin/settings">⚙️ Settings</a></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><div class="panel-title">📡 Recent Signals</div></div>
      <div class="panel-body">
        ${_signalBuffer.slice(-5).reverse().map(s=>`
          <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
            <span class="pill ${s.direction==='LONG'?'pill-long':'pill-short'}" style="font-size:.65rem">${s.direction==='LONG'?'▲':'▼'}</span>
            <span style="font-family:var(--font-mono);font-weight:700">${s.coin}</span>
            <span style="font-family:var(--font-mono);font-size:.75rem;color:var(--accent)">${s.score}/100</span>
            <span style="font-size:.72rem;color:var(--text2);margin-left:auto">${Math.floor((Date.now()-s.ts)/60000)}m ago</span>
          </div>`).join('') || '<div style="color:var(--text2);font-size:.85rem">No signals yet</div>'}
        <div style="margin-top:14px"><a href="/admin/signals" class="btn btn-ghost btn-sm">View All Signals →</a></div>
      </div>
    </div>
  </div>
</div>

<script>
async function scannerCtrl(action) {
  const msg = document.getElementById('scan-msg');
  msg.style.color='var(--text2)';
  msg.textContent = action==='start'?'⏳ Starting scanner...':'⏳ Stopping scanner...';
  try {
    const d = await (await fetch('/admin/api/scanner/'+action,{method:'POST'})).json();
    if (d.ok) {
      const on=action==='start';
      msg.textContent=on?'✅ Scanner started!':'✅ Scanner stopped.';
      msg.style.color=on?'var(--green)':'var(--text2)';
      document.getElementById('scan-stat-text').textContent=on?'Active':'Standby';
      document.getElementById('scan-stat-text').style.color=on?'var(--green)':'var(--text2)';
      document.getElementById('btn-start').disabled=on;
      document.getElementById('btn-stop').disabled=!on;
    } else { msg.textContent='❌ '+d.error; msg.style.color='var(--red)'; }
  } catch(e) { msg.textContent='❌ Network error'; msg.style.color='var(--red)'; }
}
</script>`));
    });

    // ─── Admin Settings ────────────────────────────────────────────────
    app.get('/admin/settings', (req, res) => {
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        const m=config.modules||{}, t=config.trading||{}, pr=m.PRO_MODE||false;
        const ind=config.indicatorParams||{}, smc=config.smcParams||{}, tgt=config.targetParams||{};
        const iv=(o,k,d)=>o[k]!==undefined?o[k]:d;
        const tv=(k,d)=>iv(t,k,d), indv=(k,d)=>iv(ind,k,d), smcv=(k,d)=>iv(smc,k,d), tgtv=(k,d)=>iv(tgt,k,d);

        const modToggle=(id,label,desc,checked)=>`
<div class="toggle-row">
  <div class="toggle-info"><h3>${label}</h3><p>${desc}</p></div>
  <label class="toggle"><input type="checkbox" id="mod-${id}" ${checked?'checked':''} onchange="toggleMod('${id}',this.checked)"><span class="slider"></span></label>
</div>`;
        const tradRow=(key,label,val,min,max,step,unit='')=>`
<div class="param-row">
  <div><div class="param-label">${label}${unit?`<span class="param-unit">${unit}</span>`:''}</div><div class="param-key">${key}</div></div>
  <input type="number" class="inp-num" value="${val}" min="${min}" max="${max}" step="${step}" onchange="setTradingParam('${key}',this.value)">
</div>`;
        const indRow=(key,label,val,min,max,step,unit='',hint='')=>`
<div class="param-row">
  <div><div class="param-label">${label}${unit?`<span class="param-unit">${unit}</span>`:''}</div>${hint?`<div class="param-hint">${hint}</div>`:''}<div class="param-key">${key}</div></div>
  <input type="number" class="inp-num" value="${val}" min="${min}" max="${max}" step="${step}" onchange="setIndicatorParam('${key}',this.value)" ${pr?'':'disabled'}>
</div>`;
        const smcRow=(key,label,val,min,max,step,unit='',hint='')=>`
<div class="param-row">
  <div><div class="param-label">${label}${unit?`<span class="param-unit">${unit}</span>`:''}</div>${hint?`<div class="param-hint">${hint}</div>`:''}<div class="param-key">${key}</div></div>
  <input type="number" class="inp-num" value="${val}" min="${min}" max="${max}" step="${step}" onchange="setSMCParam('${key}',this.value)" ${pr?'':'disabled'}>
</div>`;
        const tgtRow=(key,label,val,min,max,step,unit='')=>`
<div class="param-row">
  <div><div class="param-label">${label}${unit?`<span class="param-unit">${unit}</span>`:''}</div><div class="param-key">${key}</div></div>
  <input type="number" class="inp-num" value="${val}" min="${min}" max="${max}" step="${step}" onchange="setTargetParam('${key}',this.value)" ${pr?'':'disabled'}>
</div>`;

        res.send(_html('Settings', `
${_adminNav('settings', _botState.pendingUpdate, scannerActive)}
<div class="wrap">
  <h1 class="page-title">⚙️ Settings</h1>

  <div class="pro-banner" style="margin-bottom:24px">
    <div style="font-size:2rem">🎛️</div>
    <div style="flex:1">
      <div style="font-family:var(--font-head);font-size:1rem;font-weight:700;color:var(--accent)">
        Pro Custom Mode <span class="pro-badge">PRO</span>
      </div>
      <div style="font-size:.8rem;color:var(--text2);margin-top:4px">Override every indicator and strategy parameter. OFF = bot uses optimal built-in defaults.</div>
    </div>
    <label class="toggle" style="width:50px;height:27px">
      <input type="checkbox" id="pro-toggle" ${pr?'checked':''} onchange="toggleProMode(this.checked)">
      <span class="slider"></span>
    </label>
  </div>

  <div class="g-2" style="margin-bottom:20px">
    <div class="panel">
      <div class="panel-head"><div class="panel-title">🧩 Module Toggles</div></div>
      <div class="panel-body">
        ${modToggle('AI_MODEL','🤖 AI Model','Local Python LSTM prediction server',m.AI_MODEL)}
        ${modToggle('BYBIT','🐋 Bybit Layer','Cross-exchange OB + volume validation',m.BYBIT)}
        ${modToggle('DYNAMIC_WEIGHTS','🧠 Dynamic Weights','ADX/ATR adaptive score multipliers',m.DYNAMIC_WEIGHTS)}
        ${modToggle('SMC','🔮 SMC Scoring','ChoCH, Sweep, OB, Wyckoff, BOS, Breakers',m.SMC)}
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><div class="panel-title">💼 Core Trading Parameters</div></div>
      <div class="panel-body">
        ${tradRow('DEFAULT_RISK_PCT','💰 Risk per Trade',tv('DEFAULT_RISK_PCT',2),0.1,10,0.1,'%')}
        ${tradRow('DEFAULT_LEVERAGE','⚡ Default Leverage',tv('DEFAULT_LEVERAGE',10),1,125,1,'x')}
        ${tradRow('MAX_OPEN_TRADES','📂 Max Open Trades',tv('MAX_OPEN_TRADES',5),1,20,1)}
        ${tradRow('MIN_SCORE_THRESHOLD','📊 Min Signal Score',tv('MIN_SCORE_THRESHOLD',20),5,80,1,'/100')}
        ${tradRow('SIGNAL_COOLDOWN_HOURS','⏱️ Cooldown',tv('SIGNAL_COOLDOWN_HOURS',4),0.5,48,0.5,'hr')}
        ${tradRow('WS_WATCH_COUNT','🪙 Watched Coins',tv('WS_WATCH_COUNT',30),5,100,1)}
      </div>
    </div>
  </div>

  <div id="pro-panels" class="${pr?'':'pro-overlay'}">
    <div class="g-2" style="margin-bottom:20px">
      <div class="panel">
        <div class="panel-head"><div class="panel-title">📈 Trend &amp; Momentum</div><span style="font-size:.75rem;color:var(--text2)">RSI · EMA · ADX</span></div>
        <div class="panel-body">
          ${indRow('RSI_PERIOD','RSI Period',indv('RSI_PERIOD',14),2,50,1,'bars')}
          ${indRow('FAST_EMA','Fast EMA',indv('FAST_EMA',50),2,200,1,'bars')}
          ${indRow('SLOW_EMA','Slow EMA',indv('SLOW_EMA',200),10,500,5,'bars')}
          ${indRow('ADX_CHOPPY','ADX Choppy',indv('ADX_CHOPPY',20),5,40,1,'','ADX < this = sideways')}
          ${indRow('ADX_TRENDING','ADX Trending',indv('ADX_TRENDING',25),10,60,1,'','ADX > this = trending')}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><div class="panel-title">🔮 Smart Money (SMC)</div><span style="font-size:.75rem;color:var(--text2)">OB · Sweep · FVG</span></div>
        <div class="panel-body">
          ${smcRow('OB_LOOKBACK','OB Lookback',smcv('OB_LOOKBACK',10),3,60,1,'bars')}
          ${smcRow('FVG_MIN_PCT','FVG Min Size',smcv('FVG_MIN_PCT',0.1),0.01,2,0.01,'%')}
          ${smcRow('SWEEP_BUFFER','Sweep Buffer',smcv('SWEEP_BUFFER',0.5),0.1,5,0.1,'%')}
        </div>
      </div>
    </div>
    <div class="panel" style="margin-bottom:20px">
      <div class="panel-head"><div class="panel-title">🎯 Risk &amp; Target Parameters</div><span style="font-size:.75rem;color:var(--text2)">TP · SL · RRR</span></div>
      <div class="panel-body">
        <div class="g-2">
          <div>
            ${tgtRow('TP1_MULT','TP1 Multiplier',tgtv('TP1_MULT',1.0),0.3,20,0.1,':1 RRR')}
            ${tgtRow('TP2_MULT','TP2 Multiplier',tgtv('TP2_MULT',2.0),0.5,30,0.1,':1 RRR')}
          </div>
          <div>
            ${tgtRow('TP3_MULT','TP3 Multiplier',tgtv('TP3_MULT',3.0),1,50,0.5,':1 RRR')}
            ${tgtRow('SL_BUFFER','SL Buffer',tgtv('SL_BUFFER',0.5),0.1,5,0.1,'%')}
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><div class="panel-title">🔔 Notifications</div></div>
    <div class="panel-body">
      <div class="toggle-row">
        <div class="toggle-info"><h3>📊 Auto Daily P&amp;L Report</h3><p>Send P&amp;L summary to owner every midnight UTC</p></div>
        <label class="toggle"><input type="checkbox" ${config.dailyReport?.ENABLED!==false?'checked':''} onchange="toggleMod('DAILY_REPORT',this.checked)"><span class="slider"></span></label>
      </div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>
<script>
function showToast(msg,type='ok'){const t=document.getElementById('toast');t.textContent=msg;t.className='toast'+(type==='err'?' err':type==='info'?' info':'');t.style.display='block';clearTimeout(t._to);t._to=setTimeout(()=>t.style.display='none',3000);}
async function apiPost(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json();}
async function toggleProMode(val){const d=await apiPost('/admin/api/promode',{enabled:val});if(d.ok){showToast('🎛️ Pro Mode '+(val?'ON':'OFF'));document.getElementById('pro-panels').classList.toggle('pro-overlay',!val);}else{showToast('❌ '+d.error,'err');document.getElementById('pro-toggle').checked=!val;}}
async function toggleMod(id,val){const d=await apiPost('/admin/api/modules/'+id,{enabled:val});showToast(d.ok?'✅ '+id+' → '+(val?'ON':'OFF'):'❌ '+d.error,d.ok?'ok':'err');}
async function setTradingParam(key,val){const d=await apiPost('/admin/api/params/'+key,{value:parseFloat(val)});showToast(d.ok?'✅ '+key+' = '+val:'❌ '+d.error,d.ok?'ok':'err');}
async function setIndicatorParam(key,val){const d=await apiPost('/admin/api/indicators/'+key,{value:parseFloat(val)});showToast(d.ok?'📈 '+key+' = '+val:'❌ '+d.error,d.ok?'ok':'err');}
async function setSMCParam(key,val){const d=await apiPost('/admin/api/smc/'+key,{value:parseFloat(val)});showToast(d.ok?'🔮 '+key+' = '+val:'❌ '+d.error,d.ok?'ok':'err');}
async function setTargetParam(key,val){const d=await apiPost('/admin/api/targets/'+key,{value:parseFloat(val)});showToast(d.ok?'🎯 '+key+' = '+val:'❌ '+d.error,d.ok?'ok':'err');}
</script>`));
    });

    // ─── Admin Updater ─────────────────────────────────────────────────
    app.get('/admin/updater', (req, res) => {
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        const enabled = config.updater.ENABLED, pending = _botState.pendingUpdate;

        res.send(_html('Updater', `
${_adminNav('updater', pending, scannerActive)}
<div class="wrap">
  <h1 class="page-title">🔄 Auto Updater</h1>

  ${pending?`<div style="background:rgba(255,171,0,.08);border:1px solid rgba(255,171,0,.25);border-radius:var(--radius);padding:14px 18px;margin-bottom:20px;color:var(--yellow);font-size:.88rem">
    ⚠️ <strong>New update available</strong> — auto-update is OFF. Click Pull Update to apply manually.
  </div>`:''}

  <div class="g-2">
    <div class="panel">
      <div class="panel-head"><div class="panel-title">🔧 Update Controls</div></div>
      <div class="panel-body">
        <div class="toggle-row">
          <div class="toggle-info"><h3>Auto-Update</h3><p>Apply updates automatically on git push</p></div>
          <label class="toggle"><input type="checkbox" id="auto-toggle" ${enabled?'checked':''} onchange="setAutoUpdate(this.checked)"><span class="slider"></span></label>
        </div>
        <div style="margin-top:20px;display:flex;flex-direction:column;gap:12px">
          <button class="btn btn-primary" onclick="runUpdate()">🔄 Pull Update Now</button>
          <code style="font-size:.72rem;color:var(--text2);background:var(--bg2);padding:8px 10px;border-radius:6px;display:block">git pull && npm install && pm2 restart ${config.updater.PM2_APP_NAME}</code>
          <div style="font-size:.78rem;color:${config.updater.WEBHOOK_SECRET?'var(--green)':'var(--yellow)'}">
            ${config.updater.WEBHOOK_SECRET?'✅ Webhook secret configured':'⚠️ No GITHUB_WEBHOOK_SECRET set'}
          </div>
        </div>
        <div class="update-out" id="update-out"></div>
        <div id="update-msg" style="margin-top:10px;font-size:.85rem"></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><div class="panel-title">📋 Update Info</div></div>
      <div class="panel-body">
        <div class="stat-row"><span>Last Update</span><span class="stat-row-val" style="font-size:.82rem">${_botState.lastUpdate||'Never'}</span></div>
        <div class="stat-row"><span>Bot Version</span><span class="stat-row-val c-cyan">v${config.VERSION}</span></div>
        <div style="margin-top:16px">
          <div style="font-size:.8rem;color:var(--text2);margin-bottom:8px">GitHub Webhook URL:</div>
          <code style="font-size:.74rem;color:var(--text3);background:var(--bg2);padding:10px 12px;border-radius:6px;display:block;word-break:break-all;border:1px solid var(--border)">http://YOUR_VPS_IP:${port}/admin/webhook/update</code>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
async function setAutoUpdate(val){const r=await fetch('/admin/api/autoupdate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:val})});const d=await r.json();const msg=document.getElementById('update-msg');msg.textContent=d.ok?'✅ Auto-update '+(val?'enabled':'disabled'):'❌ '+d.error;msg.style.color=d.ok?'var(--green)':'var(--red)';}
async function runUpdate(){const msg=document.getElementById('update-msg'),out=document.getElementById('update-out');msg.textContent='🔄 Running update...';msg.style.color='var(--text2)';out.style.display='block';out.textContent='Running...';try{const d=await(await fetch('/admin/api/update',{method:'POST'})).json();out.textContent=d.ok?(d.output||'Done.'):('Error: '+d.error+'\n'+(d.stderr||''));msg.textContent=d.ok?'✅ Update complete — bot restarting':'❌ Update failed';msg.style.color=d.ok?'var(--green)':'var(--red)';}catch(e){out.textContent='Network error: '+e.message;}}
</script>`));
    });

    // ─── Admin Users ───────────────────────────────────────────────────
    app.get('/admin/users', async (req, res) => {
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        let usersHtml='', totalUsers=0;
        try {
            const { users, total } = await db.listSaasUsers(1, 100);
            totalUsers = total;
            usersHtml = users.length===0
                ? `<tr><td colspan="7" style="text-align:center;color:var(--text2);padding:28px">No users yet</td></tr>`
                : users.map(u => {
                    const rolePill   = u.role==='admin' ? '<span class="pill pill-admin">admin</span>' : '<span class="pill pill-user">user</span>';
                    const statusPill = u.accountStatus==='active' ? '<span class="pill pill-ok">active</span>' : '<span class="pill pill-susp">suspended</span>';
                    const lastLogin  = u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : 'Never';
                    const suspBtn    = u.accountStatus==='active'
                        ? `<button class="btn btn-danger btn-sm" onclick="setStatus('${u._id}','suspended')">Suspend</button>`
                        : `<button class="btn btn-success btn-sm" onclick="setStatus('${u._id}','active')">Activate</button>`;
                    return `<tr>
                      <td><strong>${u.username}</strong></td>
                      <td style="color:var(--text2);font-size:.82rem">${u.email}</td>
                      <td>${rolePill}</td>
                      <td>${statusPill}</td>
                      <td style="font-size:.82rem">${new Date(u.createdAt).toLocaleDateString()}</td>
                      <td style="font-size:.82rem">${lastLogin} <span style="color:var(--text2)">(${u.loginCount||0}x)</span></td>
                      <td>${suspBtn}</td>
                    </tr>`;
                }).join('');
        } catch (e) { console.error('Admin users error:', e.message); }

        res.send(_html('Users', `
${_adminNav('users', _botState.pendingUpdate, scannerActive)}
<div class="wrap">
  <h1 class="page-title">👥 SaaS Users <span>${totalUsers} total</span></h1>
  <div class="panel">
    <div class="panel-head">
      <div class="panel-title">All Platform Users</div>
      <div style="font-size:.8rem;color:var(--text2)">Register at <a href="/auth/register">/auth/register</a></div>
    </div>
    <div class="panel-body" style="padding:0"><div class="tbl-wrap">
      <table><thead><tr><th>Username</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th>Last Login</th><th>Action</th></tr></thead>
      <tbody id="users-body">${usersHtml}</tbody></table>
    </div></div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
async function setStatus(userId,status){
  if(!confirm('Change user status to "'+status+'"?'))return;
  try{
    const d=await(await fetch('/admin/api/users/'+userId+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})})).json();
    const t=document.getElementById('toast');t.textContent=d.ok?'✅ Status updated to '+status:'❌ '+d.error;t.className='toast'+(d.ok?'':' err');t.style.display='block';
    setTimeout(()=>t.style.display='none',3000);if(d.ok)setTimeout(()=>location.reload(),1200);
  }catch(e){alert('Network error: '+e.message);}
}
</script>`));
    });

    // ════════════════════════════════════════════════════════════════════
    //  ADMIN REST API  (100% unchanged from original)
    // ════════════════════════════════════════════════════════════════════

    app.get('/admin/api/status', requireAdminAuth, async (req, res) => {
        let scannerActive=false, tradeCount=0;
        try { scannerActive=require('./plugins/scanner').getScannerStatus(); } catch(_){}
        try { tradeCount=await db.Trade.countDocuments({status:{$in:['active','pending']}}); } catch(_){}
        const uptime=Math.floor((Date.now()-_botState.startTime)/60000);
        res.json({ waConnected:_botState.waConnected, scannerActive, tradeCount,
            uptime: uptime>=60?`${Math.floor(uptime/60)}h ${uptime%60}m`:`${uptime}m`,
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

    // NEW: Signal SSE stream
    app.get('/admin/api/signals/stream', requireAdminAuth, (req, res) => {
        res.setHeader('Content-Type','text/event-stream');
        res.setHeader('Cache-Control','no-cache');
        res.setHeader('Connection','keep-alive');
        res.flushHeaders();
        _signalSseClients.add(res);
        req.on('close', () => _signalSseClients.delete(res));
    });

    // NEW: Get recent signals as JSON
    app.get('/admin/api/signals', requireAdminAuth, (req, res) => {
        const limit = Math.min(parseInt(req.query.limit)||50, 200);
        res.json({ ok:true, signals:_signalBuffer.slice(-limit).reverse() });
    });

    // NEW: Manual signal push (for testing)
    app.post('/admin/api/signals/push', requireAdminAuth, (req, res) => {
        try { pushSignal(req.body); res.json({ ok:true }); }
        catch(e){ res.status(400).json({ok:false,error:e.message}); }
    });

    app.post('/admin/api/scanner/:action', requireAdminAuth, async (req, res) => {
        try {
            const scanner = require('./plugins/scanner');
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

    // GitHub Webhook
    app.post('/admin/webhook/update', express.raw({type:'application/json'}), (req, res) => {
        if (!_verifyGithubSig(req, req.body)) return res.status(401).json({error:'Invalid signature'});
        res.json({ok:true});
        if (config.updater.ENABLED) { _pushLog('[WEBHOOK] 📦 GitHub push — running auto-update...'); runUpdate(null); }
        else { _botState.pendingUpdate=true; _pushLog('[WEBHOOK] ⚠️ GitHub push — auto-update is OFF.'); }
    });

    // Backward compat redirect
    app.use('/dashboard', (req, res) => {
        const dest = req.path==='/'||req.path==='' ? '/admin/' : '/admin'+req.path;
        res.redirect(301, dest+(req.search||''));
    });

    // ════════════════════════════════════════════════════════════════════
    //  AUTH ROUTES
    // ════════════════════════════════════════════════════════════════════

    app.get('/auth/register', (req, res) => {
        const err = req.query.err;
        const errMsg = {exists_email:'❌ That email is already registered.',exists_username:'❌ Username already taken.',short_password:'❌ Password must be at least 8 characters.',mismatch:'❌ Passwords do not match.',invalid:'❌ Please fill in all fields correctly.',server:'❌ Server error — please try again.'}[err]||'';
        const success = req.query.success ? '<div class="auth-alert-ok">✅ Account created! Please sign in.</div>' : '';
        res.send(_html('Register', `
<div class="auth-wrap">
  <div class="auth-box">
    <div class="auth-logo">
      <div class="auth-logo-icon">⚡</div>
      <div class="auth-title">Create Account</div>
      <div class="auth-sub">Apex-MD Trading Portal</div>
    </div>
    ${success}
    ${errMsg?`<div class="auth-alert-err">${errMsg}</div>`:''}
    <form method="POST" action="/auth/register">
      <div class="field"><label class="field-label">Username</label><input class="inp" type="text" name="username" placeholder="e.g. trader_pancha" minlength="3" maxlength="32" autocomplete="username" required></div>
      <div class="field"><label class="field-label">Email Address</label><input class="inp" type="email" name="email" placeholder="you@example.com" autocomplete="email" required></div>
      <div class="field"><label class="field-label">Password</label><input class="inp" type="password" name="password" placeholder="Min 8 characters" minlength="8" autocomplete="new-password" required></div>
      <div class="field"><label class="field-label">Confirm Password</label><input class="inp" type="password" name="confirm" placeholder="Repeat password" autocomplete="new-password" required></div>
      <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center;padding:12px;font-size:.95rem;margin-top:6px">Create Account →</button>
    </form>
    <div class="auth-footer">Already have an account? <a href="/auth/login">Sign in →</a></div>
  </div>
</div>`));
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
        const err = req.query.err;
        const errMsg = {invalid:'❌ Invalid email or password.',locked:'🔒 Too many attempts — try again in 15 minutes.',server:'❌ Server error — please try again.'}[err]||'';
        const registered = req.query.registered ? '<div class="auth-alert-ok">✅ Account created! Please sign in.</div>' : '';
        const suspended  = req.query.suspended  ? '<div style="background:rgba(255,171,0,.08);border:1px solid rgba(255,171,0,.25);border-radius:6px;padding:11px 14px;margin-bottom:16px;font-size:.83rem;color:var(--yellow)">⚠️ Your account has been suspended.</div>' : '';
        const nextUrl    = req.query.next ? `<input type="hidden" name="next" value="${req.query.next}">` : '';
        res.send(_html('Login', `
<div class="auth-wrap">
  <div class="auth-box">
    <div class="auth-logo">
      <div class="auth-logo-icon">⚡</div>
      <div class="auth-title">Sign In</div>
      <div class="auth-sub">Apex-MD Trading Portal</div>
    </div>
    ${registered}${suspended}
    ${errMsg?`<div class="auth-alert-err">${errMsg}</div>`:''}
    <form method="POST" action="/auth/login">
      ${nextUrl}
      <div class="field"><label class="field-label">Email Address</label><input class="inp" type="email" name="email" placeholder="you@example.com" autocomplete="email" autofocus required></div>
      <div class="field"><label class="field-label">Password</label><input class="inp" type="password" name="password" placeholder="Your password" autocomplete="current-password" required></div>
      <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center;padding:12px;font-size:.95rem;margin-top:6px">Sign In →</button>
    </form>
    <div class="auth-footer">New here? <a href="/auth/register">Create account →</a></div>
  </div>
</div>`));
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

    // ─── App Home ──────────────────────────────────────────────────────
    app.get('/app/', async (req, res) => {
        const user = req.saasUser;
        const forbidden = req.query.forbidden
            ? `<div style="background:rgba(255,51,85,.08);border:1px solid rgba(255,51,85,.2);border-radius:var(--radius);padding:12px 16px;margin-bottom:20px;font-size:.84rem;color:var(--red)">🚫 Admin panel requires an <strong>admin</strong> role account.</div>` : '';
        let activeTrades=[], closedCount=0, winRate='—';
        try {
            activeTrades = await db.getSaasUserActiveTrades(user.userId);
            const closed = await db.getSaasUserTradeHistory(user.userId, 200);
            closedCount = closed.length;
            if (closed.length>0) {
                const wins = closed.filter(t=>t.result==='WIN').length;
                winRate = ((wins/closed.length)*100).toFixed(1)+'%';
            }
        } catch(_){}

        const tradesHtml = activeTrades.length===0
            ? `<tr><td colspan="7" style="text-align:center;color:var(--text2);padding:36px"><div style="font-size:1.8rem;margin-bottom:8px">🛑</div>No active trades on your account</td></tr>`
            : activeTrades.map(t => {
                const dir = t.direction==='LONG'?'<span class="pill pill-long">▲ LONG</span>':'<span class="pill pill-short">▼ SHORT</span>';
                const st  = t.status==='pending'?'<span class="pill pill-pending">PENDING</span>':'<span class="pill pill-active">ACTIVE</span>';
                const hrs = ((Date.now()-new Date(t.openTime))/3600000).toFixed(1);
                return `<tr>
                  <td><strong style="font-family:var(--font-mono)">${t.coin}</strong></td>
                  <td>${dir}</td>
                  <td style="font-family:var(--font-mono)">${fmtPrice(t.entry)}</td>
                  <td style="font-family:var(--font-mono);color:var(--green)">${fmtPrice(t.tp2||t.tp)}</td>
                  <td style="font-family:var(--font-mono);color:var(--red)">${fmtPrice(t.sl)}</td>
                  <td style="font-family:var(--font-mono)">${t.leverage||1}x</td>
                  <td>${st} <span style="color:var(--text2);font-size:.72rem;font-family:var(--font-mono)">${hrs}h</span></td>
                </tr>`;
            }).join('');

        res.send(_html('My Dashboard', `
${_appNav('home', user.username)}
<div class="wrap">
  ${forbidden}
  <h1 class="page-title">👋 Welcome back, <span style="color:var(--accent)">${user.username}</span></h1>

  <div class="g-stats">
    <div class="stat-card"><div class="stat-label">Active Trades</div><div class="stat-val c-cyan">${activeTrades.length}</div><div class="stat-sub">Open positions</div></div>
    <div class="stat-card"><div class="stat-label">Closed Trades</div><div class="stat-val">${closedCount}</div><div class="stat-sub">Completed</div></div>
    <div class="stat-card"><div class="stat-label">Win Rate</div><div class="stat-val c-green">${winRate}</div><div class="stat-sub">Historical</div></div>
    <div class="stat-card"><div class="stat-label">Account</div><div class="stat-val" style="font-size:1rem;padding-top:6px"><span class="pill pill-ok">active</span></div><div class="stat-sub">${user.role} account</div></div>
  </div>

  <div class="panel" style="margin-bottom:20px">
    <div class="panel-head">
      <div class="panel-title">⚡ My Active Trades</div>
      <a href="/app/trades" class="btn btn-ghost btn-sm">Full History →</a>
    </div>
    <div class="panel-body" style="padding:0"><div class="tbl-wrap">
      <table><thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP</th><th>SL</th><th>Lev</th><th>Status</th></tr></thead>
      <tbody>${tradesHtml}</tbody></table>
    </div></div>
  </div>

  <div class="g-2">
    <div class="panel" style="background:linear-gradient(135deg,rgba(0,200,255,.05),var(--card))">
      <div class="panel-body">
        <div style="font-size:1.5rem;margin-bottom:10px">🔬</div>
        <div style="font-family:var(--font-head);font-size:1rem;font-weight:700;margin-bottom:6px">AI Scanner</div>
        <div style="font-size:.82rem;color:var(--text2);margin-bottom:16px">Run 14-Factor SMC analysis on any coin</div>
        <a href="/app/scanner" class="btn btn-primary">⚡ Open Scanner →</a>
      </div>
    </div>
    <div class="panel">
      <div class="panel-body">
        <div style="font-size:1.5rem;margin-bottom:10px">🔑</div>
        <div style="font-family:var(--font-head);font-size:1rem;font-weight:700;margin-bottom:6px">API Keys &amp; WhatsApp</div>
        <div style="font-size:.82rem;color:var(--text2);margin-bottom:16px">Connect your exchange and link WhatsApp for signals</div>
        <a href="/app/settings" class="btn btn-ghost">⚙️ Manage Settings →</a>
      </div>
    </div>
  </div>
</div>`));
    });

    // ─── App Trades ────────────────────────────────────────────────────
    app.get('/app/trades', async (req, res) => {
        const user = req.saasUser;
        let activeHtml='', closedHtml='', totalPnl=0, wins=0, totalClosed=0;
        try {
            const active = await db.getSaasUserActiveTrades(user.userId);
            activeHtml = active.length===0
                ? `<tr><td colspan="8" style="text-align:center;color:var(--text2);padding:28px">No active trades</td></tr>`
                : active.map(t => {
                    const dir=t.direction==='LONG'?'<span class="pill pill-long">▲ LONG</span>':'<span class="pill pill-short">▼ SHORT</span>';
                    const st=t.status==='pending'?'<span class="pill pill-pending">PENDING</span>':'<span class="pill pill-active">ACTIVE</span>';
                    const hrs=((Date.now()-new Date(t.openTime))/3600000).toFixed(1);
                    return `<tr>
                      <td><strong style="font-family:var(--font-mono)">${t.coin}</strong></td>
                      <td>${dir}</td>
                      <td style="font-family:var(--font-mono)">${fmtPrice(t.entry)}</td>
                      <td style="font-family:var(--font-mono);color:var(--text3)">${fmtPrice(t.tp1)}</td>
                      <td style="font-family:var(--font-mono);color:var(--green)">${fmtPrice(t.tp2||t.tp)}</td>
                      <td style="font-family:var(--font-mono);color:var(--red)">${fmtPrice(t.sl)}</td>
                      <td style="font-family:var(--font-mono)">${t.leverage||1}x</td>
                      <td>${st} <span style="color:var(--text2);font-size:.72rem">${hrs}h</span></td>
                    </tr>`;
                }).join('');
            const closed = await db.getSaasUserTradeHistory(user.userId, 100);
            totalClosed = closed.length;
            if (closed.length) {
                closed.forEach(t=>{ totalPnl+=t.pnlPct||0; if(t.result==='WIN') wins++; });
                closedHtml = closed.map(t => {
                    const dir=t.direction==='LONG'?'<span class="pill pill-long">▲ LONG</span>':'<span class="pill pill-short">▼ SHORT</span>';
                    const result=t.result==='WIN'?'<span class="pill pill-win">WIN</span>':t.result==='LOSS'?'<span class="pill pill-loss">LOSS</span>':'<span class="pill pill-be">B/E</span>';
                    const pnl=t.pnlPct?fmtPct(t.pnlPct):'—';
                    const pnlColor=t.pnlPct>0?'var(--green)':t.pnlPct<0?'var(--red)':'var(--text2)';
                    return `<tr>
                      <td><strong style="font-family:var(--font-mono)">${t.coin}</strong></td>
                      <td>${dir}</td>
                      <td style="font-family:var(--font-mono)">${fmtPrice(t.entry)}</td>
                      <td style="font-family:var(--font-mono);color:var(--green)">${fmtPrice(t.tp2||t.tp)}</td>
                      <td style="font-family:var(--font-mono);color:var(--red)">${fmtPrice(t.sl)}</td>
                      <td>${result}</td>
                      <td style="font-family:var(--font-mono);font-weight:700;color:${pnlColor}">${pnl}</td>
                      <td style="font-size:.8rem;color:var(--text2)">${t.closedAt?new Date(t.closedAt).toLocaleDateString():'—'}</td>
                    </tr>`;
                }).join('');
            } else { closedHtml=`<tr><td colspan="8" style="text-align:center;color:var(--text2);padding:28px">No trade history yet</td></tr>`; }
        } catch(_){}

        const pnlColor = totalPnl>=0?'var(--green)':'var(--red)';
        res.send(_html('My Trades', `
${_appNav('trades', user.username)}
<div class="wrap">
  <h1 class="page-title">📋 My Trades</h1>
  <div class="g-stats" style="margin-bottom:24px">
    <div class="stat-card"><div class="stat-label">Closed Trades</div><div class="stat-val c-cyan">${totalClosed}</div></div>
    <div class="stat-card"><div class="stat-label">Win Rate</div><div class="stat-val c-green">${totalClosed>0?((wins/totalClosed)*100).toFixed(1)+'%':'—'}</div></div>
    <div class="stat-card"><div class="stat-label">Total PnL</div><div class="stat-val" style="color:${pnlColor}">${totalPnl>=0?'+':''}${totalPnl.toFixed(2)}%</div></div>
  </div>
  <div class="panel" style="margin-bottom:20px">
    <div class="panel-head"><div class="panel-title">⚡ Active &amp; Pending</div></div>
    <div class="panel-body" style="padding:0"><div class="tbl-wrap">
      <table><thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP1</th><th>TP2</th><th>SL</th><th>Lev</th><th>Status</th></tr></thead>
      <tbody>${activeHtml}</tbody></table>
    </div></div>
  </div>
  <div class="panel">
    <div class="panel-head"><div class="panel-title">📜 Trade History <span style="font-size:.78rem;color:var(--text2);margin-left:6px">(Last 100)</span></div></div>
    <div class="panel-body" style="padding:0"><div class="tbl-wrap">
      <table><thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP2</th><th>SL</th><th>Result</th><th>PnL %</th><th>Date</th></tr></thead>
      <tbody>${closedHtml}</tbody></table>
    </div></div>
  </div>
</div>`));
    });

    // ─── App Settings ──────────────────────────────────────────────────
    app.get('/app/settings', async (req, res) => {
        const user = req.saasUser;
        let apiKeys=[], waLinked=false, waJid='', waLinkedAt='', tradingMode='signals_only';
        try {
            const fullUser = await db.getSaasUserById(user.userId);
            if (fullUser) {
                tradingMode = fullUser.tradingMode||'signals_only';
                apiKeys = (fullUser.apiKeys||[]).map(k=>({_id:k._id.toString(),label:k.label,exchange:k.exchange,addedAt:new Date(k.addedAt).toLocaleDateString()}));
                waLinked = Boolean(fullUser.whatsappJid);
                waJid    = fullUser.whatsappJid||'';
                waLinkedAt = fullUser.whatsappLinkedAt?new Date(fullUser.whatsappLinkedAt).toLocaleString():'';
            }
        } catch(_){}

        const keysHtml = apiKeys.length===0
            ? `<div style="text-align:center;padding:28px;color:var(--text2)"><div style="font-size:1.5rem;margin-bottom:8px">🔑</div>No API keys yet</div>`
            : `<div class="tbl-wrap" style="margin-bottom:16px"><table><thead><tr><th>Label</th><th>Exchange</th><th>Added</th><th>Action</th></tr></thead><tbody>
            ${apiKeys.map(k=>`<tr>
              <td><strong>${k.label}</strong></td>
              <td style="text-transform:capitalize;font-size:.82rem">${k.exchange}</td>
              <td style="font-size:.82rem;color:var(--text2)">${k.addedAt}</td>
              <td><button class="btn btn-danger btn-sm" onclick="removeKey('${k._id}')">Remove</button></td>
            </tr>`).join('')}
            </tbody></table></div>`;

        const msgs = {
            added:   req.query.added   ? '<div style="color:var(--green);font-size:.82rem;margin-bottom:10px">✅ API key added.</div>' : '',
            removed: req.query.removed ? '<div style="color:var(--green);font-size:.82rem;margin-bottom:10px">✅ API key removed.</div>' : '',
            keyerr:  req.query.keyerr==='exists'?'<div style="color:var(--red);font-size:.82rem;margin-bottom:10px">❌ Label already exists.</div>':req.query.keyerr==='invalid'?'<div style="color:var(--red);font-size:.82rem;margin-bottom:10px">❌ Fill in all fields.</div>':req.query.keyerr?'<div style="color:var(--red);font-size:.82rem;margin-bottom:10px">❌ Error saving key.</div>':'',
            unlinked:req.query.unlinked?'<div style="color:var(--green);font-size:.82rem;margin-bottom:10px">✅ WhatsApp unlinked.</div>':'',
        };
        const isAuto = tradingMode==='auto_trade';

        res.send(_html('Settings', `
${_appNav('settings', user.username)}
<div class="wrap">
  <h1 class="page-title">⚙️ Account Settings</h1>

  <div class="panel" style="margin-bottom:20px">
    <div class="panel-head"><div class="panel-title">🗝️ Exchange API Keys</div></div>
    <div class="panel-body">
      <div style="font-size:.82rem;color:var(--text2);margin-bottom:16px">
        Keys stored encrypted (AES-256-GCM).<br>
        <strong style="color:var(--yellow)">⚠️ Never share your secret key with anyone.</strong>
      </div>
      ${msgs.added}${msgs.removed}${msgs.keyerr}
      ${keysHtml}
    </div>
  </div>

  <div class="panel" style="margin-bottom:20px">
    <div class="panel-head"><div class="panel-title">➕ Add New API Key</div></div>
    <div class="panel-body">
      <form method="POST" action="/app/api/keys/add" style="max-width:480px">
        <div class="field"><label class="field-label">Label</label><input class="inp" type="text" name="label" placeholder="e.g. Binance Main" required maxlength="40"></div>
        <div class="field"><label class="field-label">Exchange</label>
          <select class="inp" name="exchange">
            <option value="binance">Binance</option>
            <option value="bybit">Bybit</option>
          </select>
        </div>
        <div class="field"><label class="field-label">API Key</label><input class="inp" type="text" name="apiKey" placeholder="Your API key" autocomplete="off" required></div>
        <div class="field"><label class="field-label">Secret Key</label><input class="inp" type="password" name="secretKey" placeholder="Your secret key" autocomplete="off" required></div>
        <button type="submit" class="btn btn-primary">🔒 Save Encrypted Key</button>
      </form>
    </div>
  </div>

  <div class="panel" style="margin-bottom:20px;border-color:${waLinked?'rgba(0,230,118,.25)':'var(--border)'}">
    <div class="panel-head"><div class="panel-title">📱 WhatsApp Linking</div></div>
    <div class="panel-body">
      <div style="font-size:.82rem;color:var(--text2);margin-bottom:16px">Link your WhatsApp to receive trade signals and alerts directly.</div>
      ${msgs.unlinked}
      ${waLinked?`
      <div style="background:rgba(0,230,118,.06);border:1px solid rgba(0,230,118,.2);border-radius:var(--radius);padding:14px 16px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div>
          <div style="color:var(--green);font-weight:600;font-size:.9rem">✅ WhatsApp Connected</div>
          <div style="color:var(--text2);font-size:.78rem;margin-top:3px">Number: <strong style="color:var(--text)">${waJid.replace('@s.whatsapp.net','')}</strong></div>
          <div style="color:var(--text2);font-size:.78rem">Linked: ${waLinkedAt}</div>
        </div>
        <button class="btn btn-danger btn-sm" onclick="unlinkWa()">Unlink</button>
      </div>`:`
      <div style="background:rgba(255,171,0,.06);border:1px solid rgba(255,171,0,.2);border-radius:var(--radius);padding:12px 15px;margin-bottom:16px;font-size:.82rem;color:var(--yellow)">⚠️ Not linked — generate a token below</div>`}
      <div style="font-size:.82rem;color:var(--text2);margin-bottom:12px">
        <strong>How to link:</strong><br>
        1. Click Generate Token → 2. Send <code style="background:var(--card2);padding:2px 6px;border-radius:4px">.link YOUR-TOKEN</code> to the bot → 3. Done!
      </div>
      <button class="btn btn-primary" onclick="generateToken()" id="gen-btn">⚡ Generate Linking Token</button>
      <div id="token-display" style="display:none;margin-top:16px">
        <div style="font-size:.8rem;color:var(--text2);margin-bottom:8px">Your token (valid 15 min):</div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <code id="token-value" style="background:var(--bg2);border:1px solid var(--accent);border-radius:8px;padding:12px 20px;font-size:1.2rem;font-weight:700;letter-spacing:.15em;color:var(--accent);font-family:var(--font-mono)"></code>
          <button class="btn btn-ghost btn-sm" onclick="copyToken()">📋 Copy</button>
        </div>
        <div id="token-timer" style="font-size:.78rem;color:var(--yellow);margin-top:5px">⏳ Expires in 15:00</div>
      </div>
    </div>
  </div>

  <div class="panel" style="margin-bottom:20px;border-color:${isAuto?'rgba(0,200,255,.25)':'var(--border)'}">
    <div class="panel-head"><div class="panel-title">🤖 Trading Mode</div></div>
    <div class="panel-body">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px">
        <div onclick="setMode('signals_only')" style="cursor:pointer;border:2px solid ${!isAuto?'var(--green)':'var(--border)'};border-radius:var(--radius);padding:18px;background:${!isAuto?'rgba(0,230,118,.04)':'var(--bg2)'};transition:.2s">
          <div style="font-size:1.4rem;margin-bottom:8px">📡</div>
          <div style="font-weight:700;font-size:.9rem;color:${!isAuto?'var(--green)':'var(--text)'}">Signals Only</div>
          <div style="font-size:.77rem;color:var(--text2);margin-top:5px;line-height:1.5">Alerts on WhatsApp &amp; website. No auto execution.</div>
          ${!isAuto?'<div style="margin-top:8px;font-size:.72rem;font-weight:700;color:var(--green)">✅ ACTIVE</div>':''}
        </div>
        <div onclick="setMode('auto_trade')" style="cursor:pointer;border:2px solid ${isAuto?'var(--accent)':'var(--border)'};border-radius:var(--radius);padding:18px;background:${isAuto?'rgba(0,200,255,.04)':'var(--bg2)'};transition:.2s">
          <div style="font-size:1.4rem;margin-bottom:8px">🤖</div>
          <div style="font-weight:700;font-size:.9rem;color:${isAuto?'var(--accent)':'var(--text)'}">Auto Trade</div>
          <div style="font-size:.77rem;color:var(--text2);margin-top:5px;line-height:1.5">Bot executes trades automatically on Binance.</div>
          ${isAuto?'<div style="margin-top:8px;font-size:.72rem;font-weight:700;color:var(--accent)">✅ ACTIVE</div>':''}
        </div>
      </div>
      <div id="mode-msg" style="margin-top:10px;font-size:.83rem"></div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><div class="panel-title">👤 Account Info</div></div>
    <div class="panel-body">
      <div class="stat-row"><span>Username</span><span class="stat-row-val">${user.username}</span></div>
      <div class="stat-row"><span>Role</span><span class="stat-row-val">${user.role}</span></div>
      <div class="stat-row"><span>Trading Mode</span><span class="stat-row-val">${isAuto?'<span class="pill pill-active">🤖 Auto Trade</span>':'<span class="pill pill-ok">📡 Signals Only</span>'}</span></div>
      <div class="stat-row"><span>WhatsApp</span><span class="stat-row-val">${waLinked?'<span class="pill pill-ok">linked</span>':'<span class="pill pill-susp">not linked</span>'}</span></div>
    </div>
  </div>
</div>

<script>
async function removeKey(keyId){if(!confirm('Remove this API key?'))return;try{const r=await fetch('/app/api/keys/'+keyId,{method:'DELETE'});const d=await r.json();if(d.ok)location.href='/app/settings?removed=1';else alert('Error: '+d.error);}catch(e){alert('Network error');}}
async function generateToken(){const btn=document.getElementById('gen-btn');btn.disabled=true;btn.textContent='⏳ Generating...';try{const r=await fetch('/app/api/link/generate',{method:'POST'});const d=await r.json();if(!d.ok){alert('Error: '+d.error);btn.disabled=false;btn.textContent='⚡ Generate Linking Token';return;}document.getElementById('token-value').textContent=d.token;document.getElementById('token-display').style.display='block';btn.textContent='🔄 Regenerate Token';btn.disabled=false;let secs=900;const iv=setInterval(()=>{secs--;const m=String(Math.floor(secs/60)).padStart(2,'0'),s=String(secs%60).padStart(2,'0');document.getElementById('token-timer').textContent='⏳ Expires in '+m+':'+s;if(secs<=0){clearInterval(iv);document.getElementById('token-timer').textContent='❌ Token expired — regenerate';document.getElementById('token-timer').style.color='var(--red)';}},1000);}catch(e){alert('Network error');btn.disabled=false;btn.textContent='⚡ Generate Linking Token';}}
function copyToken(){const t=document.getElementById('token-value').textContent;navigator.clipboard.writeText(t).then(()=>{const btn=event.target;btn.textContent='✅ Copied!';setTimeout(()=>btn.textContent='📋 Copy',2000);});}
async function unlinkWa(){if(!confirm('Unlink WhatsApp? You will stop receiving signals.'))return;try{const r=await fetch('/app/api/link/unlink',{method:'POST'});const d=await r.json();if(d.ok)location.href='/app/settings?unlinked=1';else alert('Error: '+d.error);}catch(e){alert('Network error');}}
async function setMode(mode){const msg=document.getElementById('mode-msg');msg.textContent='⏳ Saving...';msg.style.color='var(--text2)';try{const r=await fetch('/app/api/trading-mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode})});const d=await r.json();if(d.ok){msg.textContent=mode==='auto_trade'?'✅ Auto Trade enabled':'✅ Signals Only enabled';msg.style.color='var(--green)';setTimeout(()=>location.reload(),900);}else{msg.textContent='❌ '+d.error;msg.style.color='var(--red)';}}catch(e){msg.textContent='❌ Network error';msg.style.color='var(--red)';}}
</script>`));
    });

    // ─── App API Endpoints (unchanged) ─────────────────────────────────
    app.post('/app/api/keys/add', saasAuth.requireUserAuth, async (req, res) => {
        try {
            const user=req.saasUser;
            const { label='', exchange='binance', apiKey='', secretKey='' } = req.body;
            if (!label.trim()||!apiKey.trim()||!secretKey.trim()) return res.redirect('/app/settings?keyerr=invalid');
            const fullUser = await db.getSaasUserById(user.userId);
            if (fullUser&&fullUser.apiKeys.some(k=>k.label===label.trim())) return res.redirect('/app/settings?keyerr=exists');
            const entry={ label:label.trim(), exchange:exchange==='bybit'?'bybit':'binance', encApiKey:saasAuth.encryptApiKey(apiKey.trim()), encSecretKey:saasAuth.encryptApiKey(secretKey.trim()) };
            await db.addUserApiKey(user.userId, entry);
            res.redirect('/app/settings?added=1');
        } catch(e){ console.error('[APP] Add key error:',e.message); res.redirect('/app/settings?keyerr=server'); }
    });

    app.delete('/app/api/keys/:keyId', saasAuth.requireUserAuth, async (req, res) => {
        try { await db.removeUserApiKey(req.saasUser.userId, req.params.keyId); res.json({ok:true}); }
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
            const { mode } = req.body;
            if (!['signals_only','auto_trade'].includes(mode)) return res.status(400).json({ok:false,error:'Invalid mode'});
            await db.setTradingMode(req.saasUser.userId, mode);
            console.log(`[Portal] ${req.saasUser.username} set tradingMode → ${mode}`);
            res.json({ok:true,mode});
        } catch(e){ res.status(500).json({ok:false,error:e.message}); }
    });


    // ════════════════════════════════════════════════════════════════════
    //  SCANNER  GET /app/scanner + POST /app/api/scan + /app/api/backtest
    // ════════════════════════════════════════════════════════════════════

    const _withTimeout = (p, ms, fb) => Promise.race([p, new Promise(r => setTimeout(() => r(fb), ms))]);
    const _STABLES = new Set(['USDCUSDT','BUSDUSDT','DAIUSDT','TUSDUSDT','EURUSDT','GBPUSDT','USDPUSDT']);
    const _VALID_TF = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','12h','1d','3d','1w'];

    function _cleanCoin(raw) {
        let c = (raw||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
        if (!c.endsWith('USDT')) c += 'USDT';
        return c;
    }
    function _calcFutures(a) {
        const entry=parseFloat(a.entryPrice)||0, sl=parseFloat(a.sl)||0, tp2=parseFloat(a.tp2)||0;
        const risk=Math.abs(entry-sl), slPct=entry>0?risk/entry:0.02;
        const lev=Math.min(Math.ceil(slPct>0?(0.02/slPct)/0.10:10),75);
        const isL=a.direction==='LONG';
        const rrr=risk>0?(Math.abs(tp2-entry)/risk).toFixed(2):'—';
        return { leverage:lev, marginPct:2, rrr,
            dca1:(isL?entry-risk*0.35:entry+risk*0.35).toFixed(4),
            dca2:(isL?entry-risk*0.70:entry+risk*0.70).toFixed(4) };
    }

    // ── Scanner Page ──────────────────────────────────────────────────
    app.get('/app/scanner', saasAuth.requireUserAuth, (req, res) => {
        const user = req.saasUser;
        res.send(_html('AI Scanner', `
${_appNav('scanner', user.username)}
<div class="wrap">
  <h1 class="page-title">⚡ AI Scanner <span>70-Factor Analysis</span></h1>
  <div class="panel" style="max-width:680px;margin-bottom:22px">
    <div class="panel-body">
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
        <div style="flex:1;min-width:140px">
          <label class="field-label">Coin</label>
          <input type="text" id="coin-inp" class="inp" placeholder="BTC, ETH, SOL..."
            style="font-family:var(--font-mono);font-size:1.05rem;font-weight:700;text-transform:uppercase"
            maxlength="12" autocomplete="off">
        </div>
        <div style="min-width:130px">
          <label class="field-label">Timeframe</label>
          <select id="tf-sel" class="inp">
            <option value="5m">5 Minutes</option>
            <option value="15m" selected>15 Minutes</option>
            <option value="1h">1 Hour</option>
            <option value="4h">4 Hours</option>
            <option value="1d">1 Day</option>
          </select>
        </div>
        <button class="btn btn-primary" style="padding:11px 28px" id="scan-btn">⚡ Analyse</button>
        <button class="btn btn-ghost" style="padding:11px 22px" id="bt-btn">📊 Backtest</button>
      </div>
    </div>
  </div>
  <div id="scan-loading" style="display:none;padding:50px;text-align:center">
    <div style="font-size:2.5rem;display:inline-block" id="spin-icon">⚙️</div>
    <div style="margin-top:14px;font-size:.95rem;color:var(--text)" id="scan-msg">Analysing...</div>
  </div>
  <div id="scan-error" style="display:none;background:rgba(255,51,85,.08);border:1px solid rgba(255,51,85,.25);border-radius:var(--radius);padding:14px 18px;margin-bottom:16px;color:var(--red);font-size:.88rem"></div>
  <div id="scan-result" style="display:none"></div>
</div>
<style>
.rcard{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;margin-bottom:12px}
.rcard-title{font-family:var(--font-head);font-size:.8rem;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px}
.rgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}
.ritem{background:var(--bg2);border-radius:6px;padding:9px 11px}
.ritem-label{font-size:.6rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px}
.ritem-val{font-family:var(--font-mono);font-size:.88rem;font-weight:600}
.rrow{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:.83rem}
.rrow:last-child{border-bottom:none}
.conf-item{background:var(--bg2);border-radius:5px;padding:6px 8px;font-size:.7rem}
.conf-label{color:var(--text2);margin-bottom:2px}
.conf-val{font-family:var(--font-mono);font-size:.68rem;color:var(--text)}
</style>
<script>
var scanBtn = document.getElementById('scan-btn');
var btBtn = document.getElementById('bt-btn');
var coinInp = document.getElementById('coin-inp');
var tfSel = document.getElementById('tf-sel');

coinInp.addEventListener('input', function(){ this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g,''); });
coinInp.addEventListener('keydown', function(e){ if(e.key==='Enter') doScan(); });

scanBtn.addEventListener('click', function(){ doScan(); });
btBtn.addEventListener('click', function(){ doBacktest(); });

function show(id){ document.getElementById(id).style.display=''; }
function hide(id){ document.getElementById(id).style.display='none'; }
function setText(id,t){ document.getElementById(id).textContent=t; }
function setHtml(id,h){ document.getElementById(id).innerHTML=h; }
function fmtP(n){
  if(!n||isNaN(parseFloat(n)))return'—';
  var p=parseFloat(n);
  if(p>=10000)return'$'+p.toFixed(2);
  if(p>=1)return'$'+p.toFixed(4);
  return'$'+p.toFixed(6);
}
function sCol(s){ return s>=70?'var(--green)':s>=45?'var(--yellow)':'var(--red)'; }

function doScan(){
  var coin=coinInp.value.trim();
  if(!coin){ coinInp.focus(); return; }
  hide('scan-result'); hide('scan-error');
  show('scan-loading');
  scanBtn.disabled=true; btBtn.disabled=true;
  var msgs=['Running analysis...','Calculating indicators...','Fetching market data...','AI processing...','Almost done...'];
  var mi=0;
  var mt=setInterval(function(){ setText('scan-msg',msgs[Math.min(++mi,msgs.length-1)]); },4000);
  var spinFrames=['⚙️','🔄','⚡','🔍'];
  var si=0;
  var st=setInterval(function(){ setText('spin-icon',spinFrames[si++%spinFrames.length]); },600);
  fetch('/app/api/scan',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({coin:coin,timeframe:tfSel.value})
  }).then(function(r){ return r.json(); }).then(function(d){
    clearInterval(mt); clearInterval(st);
    hide('scan-loading');
    if(!d.ok){ show('scan-error'); setText('scan-error','❌ '+(d.error||'Analysis failed')); return; }
    renderScan(d.analysis, coin);
  }).catch(function(e){
    clearInterval(mt); clearInterval(st);
    hide('scan-loading');
    show('scan-error'); setText('scan-error','❌ Network error: '+e.message);
  }).finally(function(){ scanBtn.disabled=false; btBtn.disabled=false; });
}

function renderScan(a, coin){
  var isL=a.direction==='LONG';
  var dc=isL?'var(--green)':'var(--red)';
  var da=isL?'▲ LONG':'▼ SHORT';
  var sc=sCol(a.score||0);
  var f=a.futures||{};
  var s=a.sentiment||{};
  var ec=a.entryConf||{};
  var ai=a.ai||{};
  var entry=parseFloat(a.entryPrice)||0;
  var sl=parseFloat(a.sl)||0;
  var risk=Math.abs(entry-sl);
  var dca1=(isL?entry-risk*0.35:entry+risk*0.35).toFixed(4);
  var dca2=(isL?entry-risk*0.70:entry+risk*0.70).toFixed(4);
  var reasons=(a.reasons||'').split(',').map(function(r){return r.trim();}).filter(Boolean);

  var html='';

  // Hero
  html+='<div class="rcard" style="background:linear-gradient(135deg,#031526,#060d17);border-color:'+sc+';margin-bottom:16px">';
  html+='<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">';
  html+='<div style="width:80px;height:80px;border-radius:50%;border:3px solid '+sc+';display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:1.6rem;font-weight:800;color:'+sc+';flex-shrink:0">'+(a.score||0)+'</div>';
  html+='<div style="flex:1"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">';
  html+='<span style="font-family:var(--font-head);font-size:1.4rem;font-weight:800;color:#fff">'+coin.replace('USDT','')+'/USDT</span>';
  html+='<span style="padding:4px 14px;border-radius:99px;font-size:.85rem;font-weight:700;background:'+(isL?'rgba(0,230,118,.12)':'rgba(255,51,85,.12)')+';color:'+dc+'">'+da+'</span>';
  html+='<span style="font-family:var(--font-mono);font-size:.82rem;color:var(--text2)">'+fmtP(a.currentPrice)+'</span>';
  html+='</div>';
  html+='<div style="font-size:.72rem;color:var(--text2);line-height:1.8">';
  reasons.slice(0,8).forEach(function(r){
    html+='<span style="display:inline-block;background:rgba(0,200,255,.07);border-radius:4px;padding:1px 6px;margin:1px">'+r+'</span>';
  });
  html+='</div>';
  html+='<div style="margin-top:8px;display:flex;gap:12px;flex-wrap:wrap">';
  html+='<span style="font-size:.75rem;color:var(--text2)">ADX: <b style="color:var(--text)">'+(a.adxData?parseFloat(a.adxData.value||0).toFixed(1)+' · '+a.adxData.status:'—')+'</b></span>';
  html+='<span style="font-size:.75rem;color:var(--text2)">Market: <b style="color:var(--text)">'+(a.marketState||'—')+'</b></span>';
  html+='<span style="font-size:.75rem;color:var(--text2)">Trend: <b style="color:var(--text)">'+(a.mainTrend||'—')+'</b></span>';
  html+='<span style="font-size:.75rem;color:var(--text2)">AI: <b style="color:var(--accent)">'+(ai.confidence||'—')+'</b></span>';
  html+='</div></div></div></div>';

  // Futures Setup
  html+='<div class="rcard" style="border-color:rgba(255,171,0,.2)">';
  html+='<div class="rcard-title">⚡ Futures Trade Setup</div>';
  html+='<div class="rgrid" style="margin-bottom:12px">';
  html+='<div class="ritem"><div class="ritem-label">Leverage</div><div class="ritem-val" style="color:var(--yellow);font-size:1.1rem">Cross '+(f.leverage||'—')+'x</div></div>';
  html+='<div class="ritem"><div class="ritem-label">Margin</div><div class="ritem-val" style="color:var(--yellow)">2% wallet</div></div>';
  html+='<div class="ritem"><div class="ritem-label">Entry</div><div class="ritem-val" style="color:var(--accent)">'+fmtP(a.entryPrice)+'</div></div>';
  html+='<div class="ritem"><div class="ritem-label">Stop Loss</div><div class="ritem-val" style="color:var(--red)">'+fmtP(a.sl)+'</div></div>';
  html+='<div class="ritem"><div class="ritem-label">RRR</div><div class="ritem-val" style="color:'+(parseFloat(f.rrr)>=2?'var(--green)':parseFloat(f.rrr)>=1?'var(--yellow)':'var(--red)')+'">1:'+(f.rrr||a.rrr||'—')+'</div></div>';
  html+='</div>';
  html+='<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px">';
  html+='<div class="ritem"><div class="ritem-label">TP1 — 33%</div><div class="ritem-val" style="color:var(--green)">'+fmtP(a.tp1)+'</div></div>';
  html+='<div class="ritem"><div class="ritem-label">TP2 — 33%</div><div class="ritem-val" style="color:var(--green)">'+fmtP(a.tp2)+'</div></div>';
  html+='<div class="ritem"><div class="ritem-label">TP3 — 34%</div><div class="ritem-val" style="color:var(--green)">'+fmtP(a.tp3)+'</div></div>';
  html+='</div>';
  html+='<div style="background:rgba(0,200,255,.04);border:1px solid rgba(0,200,255,.1);border-radius:var(--radius);padding:10px 12px">';
  html+='<div style="font-size:.65rem;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">DCA Plan</div>';
  html+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:6px">';
  html+='<div><div style="font-size:.6rem;color:var(--text2)">Entry</div><div style="font-family:var(--font-mono);font-size:.82rem;color:var(--text)">'+fmtP(a.entryPrice)+'</div></div>';
  html+='<div><div style="font-size:.6rem;color:var(--text2)">DCA 1 (35% to SL)</div><div style="font-family:var(--font-mono);font-size:.82rem;color:var(--yellow)">'+fmtP(dca1)+'</div></div>';
  html+='<div><div style="font-size:.6rem;color:var(--text2)">DCA 2 (70% to SL)</div><div style="font-family:var(--font-mono);font-size:.82rem;color:var(--red)">'+fmtP(dca2)+'</div></div>';
  html+='<div><div style="font-size:.6rem;color:var(--text2)">Hard SL</div><div style="font-family:var(--font-mono);font-size:.82rem;font-weight:700;color:var(--red)">'+fmtP(a.sl)+'</div></div>';
  html+='</div></div></div>';

  // Market Context + Sentiment
  html+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">';
  html+='<div class="rcard" style="margin-bottom:0"><div class="rcard-title">📊 Key Indicators</div>';
  [['RSI',a.rsi?parseFloat(a.rsi).toFixed(1):'—'],
   ['VWAP',a.vwap?String(a.vwap).replace(/🟢|🔴/g,'').trim():'—'],
   ['4H Trend',a.trend4H||'—'],['1H Trend',a.trend1H||'—'],
   ['Wyckoff',a.wyckoff?(a.wyckoff.phase||'—'):'—'],
   ['HTF Aligned',a.dailyAligned?'✅ Yes':'⚠️ No']
  ].forEach(function(row){
    html+='<div class="rrow"><span style="color:var(--text2)">'+row[0]+'</span><span style="font-family:var(--font-mono);font-size:.8rem">'+row[1]+'</span></div>';
  });
  html+='</div>';
  html+='<div class="rcard" style="margin-bottom:0"><div class="rcard-title">🌊 Market Data</div>';
  [['F&G Index',(s.fngEmoji||'⚪')+' '+(s.fngValue||'—')+' ('+( s.fngLabel||'—')+')'],
   ['BTC Dominance',(s.btcDom||'—')+'%'],
   ['News Score',(s.newsScore>=0?'+':'')+( s.newsScore||0)],
   ['Funding Rate',a.fundingRate||'N/A'],
   ['Buy Wall',a.whaleWalls?fmtP(a.whaleWalls.supportWall):'—'],
   ['Sell Wall',a.whaleWalls?fmtP(a.whaleWalls.resistWall):'—']
  ].forEach(function(row){
    html+='<div class="rrow"><span style="color:var(--text2)">'+row[0]+'</span><span style="font-family:var(--font-mono);font-size:.8rem">'+row[1]+'</span></div>';
  });
  html+='</div></div>';

  // AI Analysis
  html+='<div class="rcard" style="border-color:rgba(124,58,237,.2);background:rgba(124,58,237,.03);margin-bottom:12px">';
  html+='<div class="rcard-title">🤖 AI Analysis · '+(ai.confidence||'—')+' Confidence</div>';
  html+='<div style="font-size:.85rem;color:var(--text);line-height:1.7">'+(ai.trend||'—')+'</div>';
  if(ai.smc_summary) html+='<div style="font-size:.8rem;color:var(--text2);margin-top:6px">'+ ai.smc_summary+'</div>';
  html+='</div>';

  // 11-Factor Confirmation
  var factors=ec.factors||{};
  var factorList=[['Stablecoin',factors.usdtDom],['OI Change',factors.oiChange],
    ['CVD',factors.cvd],['L/S Ratio',factors.lsRatio],
    ['Funding',factors.fundingM],['Order Book',factors.orderBook],
    ['Whales',factors.whaleActivity],['BTC Corr',factors.btcCorr],
    ['HTF Levels',factors.htfLevels],['Put/Call',factors.pcr],
    ['Netflow',factors.netflow],['Social',factors.social]];
  html+='<div class="rcard" style="border-color:rgba(0,200,255,.15);margin-bottom:12px">';
  html+='<div class="rcard-title" style="display:flex;justify-content:space-between">🔬 11-Factor Confirmation <span style="color:'+(ec.strength==='STRONG'?'var(--green)':ec.strength==='MODERATE'?'var(--accent)':ec.strength==='CONFLICT'?'var(--red)':'var(--text2)')+'">'+( ec.verdict||'—')+'</span></div>';
  html+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:4px;margin-bottom:10px">';
  factorList.forEach(function(item){
    var lbl=item[0], f=item[1]||{};
    var sig=f.signal||'N/A';
    var bg=sig==='BULL'||sig==='POSITIVE'?'rgba(0,230,118,.07)':sig==='BEAR'||sig==='NEGATIVE'?'rgba(255,51,85,.07)':'rgba(0,0,0,.15)';
    html+='<div class="conf-item" style="background:'+bg+'"><div class="conf-label">'+(f.emoji||'⚪')+' '+lbl+'</div><div class="conf-val">'+( (f.display||'N/A').slice(0,45))+'</div></div>';
  });
  html+='</div>';
  html+='<div style="display:flex;justify-content:space-between;padding-top:8px;border-top:1px solid var(--border);font-size:.78rem">';
  html+='<span style="color:var(--text2)">'+(ec.verdictDetail||'')+'</span>';
  html+='<span style="font-family:var(--font-mono);color:'+(ec.strength==='STRONG'?'var(--green)':ec.strength==='MODERATE'?'var(--accent)':'var(--text2)')+'">Score: '+(ec.totalScore>=0?'+':'')+parseFloat(ec.totalScore||0).toFixed(1)+' ('+( ec.strength||'WEAK')+')</span>';
  html+='</div></div>';

  // 14-Factor Gate
  var checks=a.confChecks||{};
  var gateItems=[['HTF Aligned','htfAligned'],['ChoCH','chochPrimary'],['Sweep','sweepPrimary'],
    ['Volume','volumeConf'],['Wyckoff','wyckoffConf'],['Ichimoku','ichimokuConf'],
    ['Supertrend','supTrendConf'],['Fib Zone','fibZoneConf'],['BB Explode','bbExplosion'],
    ['MM Trap','mmTrapConf'],['BOS','bosConf'],['Daily Gate','dailyGate'],
    ['AI Model','aiConf'],['Bybit','bybitConf']];
  html+='<div class="rcard"><div class="rcard-title" style="display:flex;justify-content:space-between">✅ 14-Factor Gate <span style="color:'+(a.confGate?'var(--green)':'var(--text2)')+'">'+( a.confGate?'PASSED':''+( a.confScore||0)+'/14')+'</span></div>';
  html+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:3px">';
  gateItems.forEach(function(item){
    var pass=checks[item[1]];
    html+='<div style="font-size:.72rem;padding:3px 0;color:'+(pass?'var(--green)':'var(--text2)')+'"><span>'+(pass?'✅':'○')+'</span> '+item[0]+'</div>';
  });
  html+='</div></div>';

  html+='<div style="text-align:center;font-size:.7rem;color:var(--text2);margin-top:8px">⏱️ Analysis at '+new Date().toLocaleString()+' · Binance Futures · v7 PRO</div>';

  setHtml('scan-result', html);
  show('scan-result');
}

function doBacktest(){
  var coin=coinInp.value.trim();
  if(!coin){ coinInp.focus(); return; }
  hide('scan-result'); hide('scan-error');
  show('scan-loading');
  scanBtn.disabled=true; btBtn.disabled=true;
  setText('scan-msg','Running backtest...');
  var spinFrames=['📊','🔄','📈','⚡'];
  var si=0;
  var st=setInterval(function(){ setText('spin-icon',spinFrames[si++%spinFrames.length]); },700);
  fetch('/app/api/backtest',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({coin:coin,timeframe:tfSel.value})
  }).then(function(r){ return r.json(); }).then(function(d){
    clearInterval(st);
    hide('scan-loading');
    if(!d.ok){ show('scan-error'); setText('scan-error','❌ '+(d.error||'Backtest failed')); return; }
    renderBacktest(d.result, coin);
  }).catch(function(e){
    clearInterval(st);
    hide('scan-loading');
    show('scan-error'); setText('scan-error','❌ '+e.message);
  }).finally(function(){ scanBtn.disabled=false; btBtn.disabled=false; });
}

function renderBacktest(r, coin){
  var wr=parseFloat(r.winRate), pf=parseFloat(r.pf)||0, net=parseFloat(r.netR);
  var pfc=pf>=2?'var(--green)':pf>=1.5?'var(--accent)':pf>=1?'var(--yellow)':'var(--red)';
  var wrc=wr>=60?'var(--green)':wr>=50?'var(--yellow)':'var(--red)';
  var grade=pf>=2?'Excellent 🏆':pf>=1.5?'Good ✅':pf>=1?'Marginal ⚠️':'Poor ❌';
  var verdict=pf>=2?'Highly tradeable. Strong edge.':pf>=1.5?'Solid edge. Trade with normal 2% risk.':pf>=1?'Slight edge. Use stricter filters.':'Avoid this pair.';
  var tpD=r.tpBreakdown||{}, tot=r.total||1;

  var html='';
  html+='<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px">';
  html+='<div><div style="font-family:var(--font-head);font-size:1.2rem;font-weight:800;color:#fff">'+coin.replace('USDT','')+' Backtest</div>';
  html+='<div style="font-size:.75rem;color:var(--text2)">'+(r.candleCount||1000)+' candles · TP1/TP2/TP3 sim</div></div>';
  html+='<div style="padding:4px 14px;border-radius:99px;font-size:.8rem;font-weight:700;font-family:var(--font-mono);color:'+pfc+';border:1px solid '+pfc+'">'+grade+'</div></div>';

  html+='<div class="rcard"><div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap">';
  html+='<div style="text-align:center;min-width:120px"><div style="font-size:.62rem;color:var(--text2);text-transform:uppercase;margin-bottom:4px">Win Rate</div>';
  html+='<div style="font-family:var(--font-mono);font-size:3.2rem;font-weight:800;color:'+wrc+'">'+wr.toFixed(1)+'%</div>';
  html+='<div style="font-size:.75rem;color:var(--text2)">'+r.wins+' W / '+r.losses+' L</div></div>';
  html+='<div style="flex:1"><div style="height:10px;background:rgba(255,51,85,.15);border-radius:99px;overflow:hidden;margin-bottom:12px">';
  html+='<div style="height:100%;width:'+Math.min(wr,100)+'%;background:linear-gradient(90deg,var(--green2),var(--green));border-radius:99px"></div></div>';
  html+='<div class="rgrid">';
  [['Total',r.total,'var(--text)'],['TP Hits',r.wins,'var(--green)'],['SL Hits',r.losses,'var(--red)'],
   ['Long/Short',(r.longT||0)+'L/'+(r.shortT||0)+'S','var(--text)']].forEach(function(item){
    html+='<div class="ritem"><div class="ritem-label">'+item[0]+'</div><div class="ritem-val" style="color:'+item[2]+'">'+item[1]+'</div></div>';
  });
  html+='</div></div></div></div>';

  html+='<div class="rgrid" style="margin-bottom:12px">';
  [['Profit Factor',r.pf==='∞'?'∞ 🏆':parseFloat(r.pf).toFixed(2),pfc],
   ['Net P&L',(net>=0?'+':'')+net.toFixed(2)+'R',net>=0?'var(--green)':'var(--red)'],
   ['Max Drawdown',r.maxDD+'R','var(--red)'],['Max Consec L',r.maxCL,'var(--red)']
  ].forEach(function(item){
    html+='<div class="ritem"><div class="ritem-label">'+item[0]+'</div><div class="ritem-val" style="color:'+item[2]+';font-size:1.2rem">'+item[1]+'</div></div>';
  });
  html+='</div>';

  html+='<div class="rcard"><div class="rcard-title">🎯 TP Breakdown</div>';
  [['TP1 Hits (1.5R)',tpD.tp1||0,'var(--accent)'],
   ['TP2 Hits (3R)',tpD.tp2||0,'var(--green2)'],
   ['TP3 Hits (5R)',tpD.tp3||0,'var(--green)'],
   ['SL Hits',r.losses,'var(--red)']].forEach(function(item){
    var pct=(item[1]/tot*100);
    html+='<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;margin-bottom:3px">';
    html+='<span style="font-size:.72rem;color:var(--text2)">'+item[0]+'</span>';
    html+='<span style="font-family:var(--font-mono);font-size:.72rem">'+item[1]+' ('+pct.toFixed(1)+'%)</span></div>';
    html+='<div style="height:6px;background:var(--border);border-radius:99px;overflow:hidden">';
    html+='<div style="height:100%;width:'+pct+'%;background:'+item[2]+';border-radius:99px"></div></div></div>';
  });
  html+='</div>';

  html+='<div class="rcard"><div class="rcard-title">📋 Verdict</div>';
  html+='<div style="font-size:.85rem;color:var(--text);line-height:1.6">'+verdict+'</div>';
  html+='<div style="margin-top:8px;font-size:.75rem;color:'+pfc+';font-weight:600">Grade: '+grade+'</div></div>';
  html+='<div style="text-align:center;font-size:.7rem;color:var(--text2);margin-top:8px">⚠️ Past results ≠ future performance</div>';

  setHtml('scan-result', html);
  show('scan-result');
}
</script>`));
    });

    // ── Market Scan API ───────────────────────────────────────────────
    app.get('/app/api/market-scan', saasAuth.requireUserAuth, async (req, res) => {
        try {
            const binance  = require('./lib/binance');
            const analyzer = require('./lib/analyzer');
            const allCoins = binance.isReady() ? binance.getWatchedCoins()
                : ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT','MATICUSDT','ATOMUSDT','NEARUSDT','LTCUSDT','DOGEUSDT','UNIUSDT','INJUSDT','APTUSDT','ARBUSDT','OPUSDT','SUIUSDT'];
            const coins = allCoins.filter(c => !_STABLES.has(c));
            const results = [];
            for (let i = 0; i < Math.min(coins.length, 25); i++) {
                try {
                    const a = await analyzer.run14FactorAnalysis(coins[i], '15m');
                    if (a.score < 18) continue;
                    const f = _calcFutures(a);
                    results.push({ coin:coins[i].replace('USDT',''), direction:a.direction, score:a.score, maxScore:a.maxScore||100, price:a.priceStr, entryPrice:a.entryPrice, sl:a.sl, tp1:a.tp1, tp2:a.tp2, tp3:a.tp3, leverage:f.leverage, rrr:f.rrr, reasons:a.reasons });
                } catch(_){}
            }
            results.sort((a,b)=>b.score-a.score);
            res.json({ ok:true, setups:results.slice(0,5), scanned:Math.min(coins.length,25) });
        } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
    });

    // ── Scan API ──────────────────────────────────────────────────────
    app.post('/app/api/scan', saasAuth.requireUserAuth, async (req, res) => {
        try {
            let { coin='', timeframe='15m' } = req.body;
            coin = _cleanCoin(coin);
            if (!coin || coin === 'USDT') return res.status(400).json({ok:false,error:'Coin symbol required'});
            if (_STABLES.has(coin)) return res.status(400).json({ok:false,error:'Stablecoin — no signals'});
            if (!_VALID_TF.includes(timeframe)) timeframe = '15m';
            console.log(`[SCAN] ${req.saasUser.username} → ${coin} ${timeframe}`);

            const analyzer      = require('./lib/analyzer');
            const binance       = require('./lib/binance');
            const confirmations = require('./lib/confirmations_lib');

            const a = await analyzer.run14FactorAnalysis(coin, timeframe);
            const { currentCandles: _cc, ...analysis } = a;

            const fallbackSent = { fngValue:50, fngLabel:'Neutral', fngEmoji:'⚪', btcDominance:'—', newsSentimentScore:0, newsHeadlines:[], overallSentiment:'⚪ NEUTRAL', tradingBias:'Neutral', totalBias:'0' };
            const [liqData, whaleWalls, fundingRate, sentiment] = await Promise.all([
                _withTimeout(binance.getLiquidationData(coin),  12000, {sentiment:'N/A'}),
                _withTimeout(binance.getLiquidityWalls(coin),   12000, {supportWall:'N/A',resistWall:'N/A',supportVol:'N/A',resistVol:'N/A'}),
                _withTimeout(binance.getFundingRate(coin),        8000, 'N/A'),
                _withTimeout(binance.getMarketSentiment(coin),  12000, fallbackSent),
            ]);

            const confFallback = { totalScore:0, confirmationStrength:'WEAK', verdict:'⚪ NEUTRAL', verdictDetail:'Timeout',
                factors:{ usdtDom:{signal:'N/A',emoji:'⚪',display:'N/A'}, oiChange:{signal:'N/A',emoji:'⚪',display:'N/A'}, cvd:{signal:'N/A',emoji:'⚪',display:'N/A'}, lsRatio:{signal:'N/A',emoji:'⚪',display:'N/A'}, fundingMomentum:{signal:'N/A',emoji:'⚪',display:'N/A'}, orderBook:{signal:'N/A',emoji:'⚪',display:'N/A'}, whaleActivity:{signal:'N/A',emoji:'⚪',display:'N/A'}, btcCorr:{signal:'N/A',emoji:'⚪',display:'N/A'}, htfLevels:{signal:'N/A',emoji:'⚪',display:'N/A'}, pcr:{signal:'N/A',emoji:'⚪',display:'N/A'}, netflow:{signal:'N/A',emoji:'⚪',display:'N/A'}, social:{signal:'N/A',emoji:'⚪',display:'N/A'} }
            };
            const rawConf = await _withTimeout(confirmations.runAllConfirmations(coin, a.direction, config.LUNAR_API||null, a), 20000, confFallback);
            const entryConf = rawConf.factors ? rawConf : { ...rawConf, factors:{ usdtDom:rawConf.usdtDom||{}, oiChange:rawConf.oiChange||{}, cvd:rawConf.cvd||{}, lsRatio:rawConf.lsRatio||{}, fundingM:rawConf.fundingMomentum||{}, orderBook:rawConf.orderBook||{}, whaleActivity:rawConf.whaleActivity||{}, btcCorr:rawConf.btcCorr||{}, htfLevels:rawConf.htfLevels||{}, pcr:rawConf.pcr||{}, netflow:rawConf.netflow||{}, social:rawConf.social||{} }};

            let aiResult = null;
            if (config.GROQ_API) {
                try {
                    const gr = await _withTimeout(axios.post('https://api.groq.com/openai/v1/chat/completions', { model:'llama-3.3-70b-versatile', messages:[{role:'user',content:`Analyse ${coin} trade. Score:${a.score}. Dir:${a.direction}. Confluences:${a.reasons}. F&G:${sentiment.fngValue}. Return ONLY JSON: {"confidence":"65%","trend":"short text","smc_summary":"short text","sentiment_note":"short"}`}], max_tokens:200, temperature:0.3 }, { headers:{ Authorization:`Bearer ${config.GROQ_API}` }, timeout:25000 }), 26000, null);
                    if (gr?.data?.choices?.[0]?.message?.content) {
                        let raw = gr.data.choices[0].message.content.replace(/```json|```/g,'').trim();
                        aiResult = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}')+1));
                    }
                } catch(_) {}
            }

            const fut = _calcFutures(a);
            const entry=parseFloat(a.entryPrice)||0, sl=parseFloat(a.sl)||0, tp2v=parseFloat(a.tp2)||0;
            const rrrStr = Math.abs(entry-sl)>0 ? (Math.abs(tp2v-entry)/Math.abs(entry-sl)).toFixed(2) : '0';

            res.json({ ok:true, analysis:{
                ...analysis, futures:fut,
                fundingRate, whaleWalls, liqData,
                sentiment:{ fngValue:sentiment.fngValue, fngLabel:sentiment.fngLabel, fngEmoji:sentiment.fngEmoji, btcDom:sentiment.btcDominance, newsScore:sentiment.newsSentimentScore, overall:sentiment.overallSentiment, tradingBias:sentiment.tradingBias, totalBias:sentiment.totalBias },
                entryConf, rrr:rrrStr,
                ai: aiResult || { confidence:`${Math.min(95, Math.round(40+a.score*0.5))}%`, trend:(a.mainTrend||'—')+' | '+(a.marketState||'—'), smc_summary:'Technical analysis only', sentiment_note:sentiment.tradingBias||'Neutral' },
            }});
        } catch(e) {
            console.error('[SCAN ERROR]', e.message);
            res.status(500).json({ ok:false, error:e.message });
        }
    });

    // ── Backtest API ──────────────────────────────────────────────────
    app.post('/app/api/backtest', saasAuth.requireUserAuth, async (req, res) => {
        try {
            let { coin='', timeframe='15m' } = req.body;
            coin = _cleanCoin(coin);
            if (!coin || coin==='USDT') return res.status(400).json({ok:false,error:'Coin required'});
            if (_STABLES.has(coin)) return res.status(400).json({ok:false,error:'Stablecoin'});
            if (!_VALID_TF.includes(timeframe)) timeframe='15m';
            console.log(`[BACKTEST] ${req.saasUser.username} → ${coin} ${timeframe}`);

            const binanceLib = require('./lib/binance');
            const indLib     = require('./lib/indicators');
            const smcLib     = require('./lib/smartmoney');

            const candles = await binanceLib.getKlineData(coin, timeframe, 1000);
            if (!candles||candles.length<200) return res.status(400).json({ok:false,error:'Insufficient candle data'});

            let wins=0,losses=0,equity=0,longT=0,shortT=0,tp1Count=0,tp2Count=0,tp3Count=0,maxEq=0,maxDD=0,conL=0,maxCL=0;
            const trades=[];
            let i=150;
            while(i<candles.length-30){
                const slice=candles.slice(Math.max(0,i-80),i);
                if(slice.length<50){i++;continue;}
                const cp=parseFloat(slice[slice.length-1][4]);
                const atr=parseFloat(indLib.calculateATR(slice.slice(-30),14));
                const adxR=indLib.calculateADX(slice.slice(-30));
                const adxV=adxR?.value??adxR??0;
                const rsi=indLib.calculateRSI(slice.slice(-30),14);
                const macd=indLib.calculateMACD(slice.slice(-30));
                const mSMC=smcLib.analyzeSMC(slice.slice(-30));
                const ema50=parseFloat(indLib.calculateEMA(slice,50));
                if(atr===0||adxV<18){i++;continue;}
                let ls=0,ss=0;
                if(cp>ema50)ls++;else ss++;
                if(rsi<45)ls++;if(rsi>55)ss++;
                if(macd.includes('Bullish'))ls++;if(macd.includes('Bearish'))ss++;
                if(mSMC.bullishOB)ls++;if(mSMC.bearishOB)ss++;
                if((mSMC.sweep||'').includes('Bullish'))ls+=2;if((mSMC.sweep||'').includes('Bearish'))ss+=2;
                if((mSMC.choch||'').includes('Bullish'))ls+=2;if((mSMC.choch||'').includes('Bearish'))ss+=2;
                const score=Math.max(ls,ss);
                if(score<6){i++;continue;}
                const isLong=ls>=ss;
                const entry=cp,sl2=isLong?cp-atr*2:cp+atr*2;
                const tp1=isLong?cp+atr*1.5:cp-atr*1.5;
                const tp2=isLong?cp+atr*3:cp-atr*3;
                const tp3=isLong?cp+atr*5:cp-atr*5;
                let tp1h=false,tp2h=false,tp3h=false,pnlR=0,hit=false;
                for(let j=i;j<Math.min(i+150,candles.length);j++){
                    const hi=parseFloat(candles[j][2]),lo=parseFloat(candles[j][3]);
                    if(isLong){
                        if(lo<=sl2){losses++;pnlR-=(tp1h?0.67:1.0);hit=true;break;}
                        if(!tp1h&&hi>=tp1){tp1h=true;pnlR+=0.33*1.5;}
                        if(tp1h&&!tp2h&&hi>=tp2){tp2h=true;pnlR+=0.33*3;}
                        if(tp2h&&!tp3h&&hi>=tp3){tp3h=true;pnlR+=0.34*5;wins++;hit=true;break;}
                    }else{
                        if(hi>=sl2){losses++;pnlR-=(tp1h?0.67:1.0);hit=true;break;}
                        if(!tp1h&&lo<=tp1){tp1h=true;pnlR+=0.33*1.5;}
                        if(tp1h&&!tp2h&&lo<=tp2){tp2h=true;pnlR+=0.33*3;}
                        if(tp2h&&!tp3h&&lo<=tp3){tp3h=true;pnlR+=0.34*5;wins++;hit=true;break;}
                    }
                }
                if(!hit){if(tp2h)wins++;else if(tp1h){}else{}}
                equity+=pnlR;
                if(equity>maxEq)maxEq=equity;
                const dd=maxEq-equity;if(dd>maxDD)maxDD=dd;
                if(tp1h)tp1Count++;if(tp2h)tp2Count++;if(tp3h)tp3Count++;
                if(isLong)longT++;else shortT++;
                const result=pnlR>0?'WIN':'LOSS';
                if(result==='LOSS'){conL++;if(conL>maxCL)maxCL=conL;}else conL=0;
                trades.push({dir:isLong?'L':'S',pnlR,result});
                i+=15;
            }
            const total=wins+losses;
            const winRate=total>0?(wins/total*100).toFixed(1):'0.0';
            const gW=trades.filter(t=>t.pnlR>0).reduce((s,t)=>s+t.pnlR,0);
            const gL=Math.abs(trades.filter(t=>t.pnlR<0).reduce((s,t)=>s+t.pnlR,0));
            const pf=gL>0?(gW/gL).toFixed(2):'∞';
            const sorted=[...trades].sort((a,b)=>b.pnlR-a.pnlR);
            res.json({ok:true,result:{wins,losses,longT,shortT,total,winRate,pf,gW:gW.toFixed(2),gL:gL.toFixed(2),netR:equity.toFixed(2),maxDD:maxDD.toFixed(2),maxCL,candleCount:candles.length,tpBreakdown:{tp1:tp1Count,tp2:tp2Count,tp3:tp3Count},best:sorted[0]||null,worst:sorted[sorted.length-1]||null}});
        } catch(e) {
            console.error('[BACKTEST ERROR]', e.message);
            res.status(500).json({ok:false,error:e.message});
        }
    });

    // ─── Root & Compat ─────────────────────────────────────────────────
    app.get('/', (req, res) => res.redirect('/auth/login'));
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
        console.log(`\n💡 To enable live signal feed on website, add this line to lib/signalDispatch.js:`);
        console.log(`   try { require('../dashboard').pushSignal(setup); } catch(_) {}\n`);
    });

    return { setBotConnected, log, pushSignal };
}

module.exports = { initDashboard, setBotConnected, log, pushSignal };
