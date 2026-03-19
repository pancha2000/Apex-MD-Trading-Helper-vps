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
    <a href="/app/"          class="nav-link ${active==='home'      ?'active':''}" >Dashboard</a>
    <a href="/app/scanner"   class="nav-link ${active==='scanner'   ?'active':''}" >⚡ Scanner</a>
    <a href="/app/paper"     class="nav-link ${active==='paper'     ?'active':''}" >📄 Paper</a>
    <a href="/app/watchlist" class="nav-link ${active==='watchlist' ?'active':''}" >👁 Watch</a>
    <a href="/app/alerts"    class="nav-link ${active==='alerts'    ?'active':''}" >🔔 Alerts</a>
    <a href="/app/news"      class="nav-link ${active==='news'      ?'active':''}" >📰 Intel</a>
    <a href="/app/calc"      class="nav-link ${active==='calc'      ?'active':''}" >🧮 Calc</a>
    <a href="/app/trades"    class="nav-link ${active==='trades'    ?'active':''}" >Trades</a>
    <a href="/app/settings"  class="nav-link ${active==='settings'  ?'active':''}" >⚙️</a>
    <span style="font-size:.78rem;color:var(--text2);padding:0 4px;font-family:var(--font-mono)">👤 ${username||''}</span>
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

    // ─── Scanner Module (inline) ───────────────────────────────────────
    (function registerScanner({ saasAuth, db, config, axios, _html, _appNav, fmtPrice, scoreColor }, app) {


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
//  1. GLOBAL MARKET SCANNER  GET /app/api/market-scan
// ══════════════════════════════════════════════════════════════
app.get('/app/api/market-scan', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const binance  = require('./lib/binance');
        const analyzer = require('./lib/analyzer');
        const allCoins = binance.isReady()
            ? binance.getWatchedCoins()
            : await binance.getTopTrendingCoins(20).catch(() => [
                'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT',
                'AVAXUSDT','DOTUSDT','LINKUSDT','MATICUSDT','ATOMUSDT','NEARUSDT',
                'LTCUSDT','DOGEUSDT','UNIUSDT','INJUSDT','APTUSDT','ARBUSDT','OPUSDT','SUIUSDT',
            ]);
        const coins = allCoins.filter(c => !STABLES.has(c));
        const results = [];
        const scanLimit = Math.min(coins.length, 25);
        for (let i = 0; i < scanLimit; i++) {
            try {
                const a = await analyzer.run14FactorAnalysis(coins[i], '15m');
                if (a.score < 18) continue;
                const f = calcFutures(a);
                results.push({
                    coin: coins[i].replace('USDT',''), direction: a.direction,
                    score: a.score, maxScore: a.maxScore||100,
                    price: a.priceStr, currentPrice: a.currentPrice,
                    entryPrice: a.entryPrice, sl: a.sl, tp1: a.tp1, tp2: a.tp2, tp3: a.tp3,
                    slLabel: a.slLabel, tp1Label: a.tp1Label, tp2Label: a.tp2Label, tp3Label: a.tp3Label,
                    leverage: f.leverage, marginPct: 2, dca1: f.dca1, dca2: f.dca2, rrr: f.rrr,
                    reasons: a.reasons, adx: a.adxData?.value, adxStatus: a.adxData?.status,
                    marketState: a.marketState, mainTrend: a.mainTrend,
                    confScore: a.confScore, confGate: a.confGate,
                    orderType: a.orderSuggestion?.type||'MARKET',
                    dailyAligned: a.dailyAligned, dailyTrend: a.dailyTrend,
                    bbSqueeze: a.bbSqueeze?.exploding||false,
                    mmTrap: a.mmTrap?.bullTrap||a.mmTrap?.bearTrap||false,
                    rsi: a.rsi, session: a.session?.session, sessionQuality: a.session?.quality,
                });
            } catch(_) {}
        }
        results.sort((a, b) => b.score - a.score);
        res.json({ ok: true, setups: results.slice(0, 5), scanned: scanLimit, ts: Date.now() });
    } catch(e) {
        console.error('[Market Scan]', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
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
        console.error('[Scanner API] ERROR:', e.message, e.stack?.split('\n')[1]||'');
        res.status(500).json({ ok: false, error: e.message || 'Analysis failed — check server logs' });
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
    <button id="tab-market"  onclick="switchTab('market')"  style="padding:9px 22px;font-size:.82rem;font-weight:600;border:none;cursor:pointer;transition:.15s;background:var(--card2);color:var(--text2);font-family:var(--font-mono)">🔍 Market Scan</button>
  </div>

  <!-- ══ TAB: LIVE ANALYSIS ══ -->
  <div id="panel-live">
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

  <!-- ══ TAB: MARKET SCAN ══ -->
  <div id="panel-market" style="display:none">
    <div class="panel" style="margin-bottom:22px;border-color:rgba(0,200,255,.2)">
      <div class="panel-head" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div class="panel-title">🌐 Auto Market Scanner
          <span id="ms-badge" style="font-size:.65rem;padding:2px 8px;border-radius:99px;background:rgba(0,200,255,.1);color:var(--accent);border:1px solid rgba(0,200,255,.2);margin-left:8px">READY</span>
        </div>
        <button id="ms-btn" class="btn btn-primary" style="padding:8px 20px" onclick="runMarketScan()">⚡ Scan Market Now</button>
      </div>
      <div id="ms-loading" style="display:none;padding:40px 20px;text-align:center">
        <div style="font-size:2.4rem;animation:spin 1.2s linear infinite;display:inline-block">🌐</div>
        <div style="margin-top:12px;font-size:.9rem;color:var(--text)" id="ms-msg">Scanning top coins...</div>
      </div>
      <div id="ms-error" style="display:none;color:var(--red);padding:14px 20px;font-size:.87rem"></div>
      <div id="ms-empty" style="display:none;padding:32px 20px;text-align:center;color:var(--text2)">
        <div style="font-size:2rem;margin-bottom:8px">🔍</div>No high-quality setups right now. Try again after the next 15m candle.
      </div>
      <div id="ms-results" style="display:none;padding:16px 20px 20px">
        <div style="font-size:.75rem;color:var(--text2);margin-bottom:12px" id="ms-meta"></div>
        <div id="ms-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:14px"></div>
      </div>
    </div>
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
  ['live','bt','scanbt','market'].forEach(id => {
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

document.addEventListener('DOMContentLoaded', () => {
  _$('coin-input')?.addEventListener('keydown', e => { if(e.key==='Enter') runLiveScan(); });
  _$('coin-input')?.addEventListener('input',   e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''); });
  _$('bt-coin')?.addEventListener('keydown',    e => { if(e.key==='Enter') runBacktest(); });
  _$('bt-coin')?.addEventListener('input',      e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''); });
});
</script>
`, ``));
});


    })({ saasAuth, db, config, axios, _html, _appNav, fmtPrice, scoreColor }, app);

    // ─── App Module (inline) ───────────────────────────────────────────
    (function registerApp({ saasAuth, db, config, axios, _html, _appNav, fmtPrice, fmtPct, scoreColor }, app) {


const mongoose = require('mongoose');

// ─── Extra models (alerts + watchlist — defined in plugins) ───────────
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

// ══════════════════════════════════════════════════════════════
//  APP HOME  GET /app/
// ══════════════════════════════════════════════════════════════
app.get('/app/', saasAuth.requireUserAuth, async (req, res) => {
    const user = req.saasUser;
    const forbidden = req.query.forbidden
        ? `<div style="background:rgba(255,51,85,.08);border:1px solid rgba(255,51,85,.2);border-radius:var(--radius);padding:12px 16px;margin-bottom:20px;font-size:.84rem;color:var(--red)">🚫 Admin panel requires an <strong>admin</strong> role account.</div>` : '';

    let activeTrades=[], closedCount=0, winRate='—', paperBalance=0;
    let alertCount=0, watchCount=0;
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

    const tradesHtml = activeTrades.length===0
        ? `<tr><td colspan="7" style="text-align:center;color:var(--text2);padding:32px"><div style="font-size:1.6rem;margin-bottom:8px">🛑</div>No active trades</td></tr>`
        : activeTrades.map(t => {
            const dir=t.direction==='LONG'?'<span class="pill pill-long">▲ LONG</span>':'<span class="pill pill-short">▼ SHORT</span>';
            const st=t.status==='pending'?'<span class="pill pill-pending">PENDING</span>':'<span class="pill pill-active">ACTIVE</span>';
            const hrs=((Date.now()-new Date(t.openTime))/3600000).toFixed(1);
            return `<tr><td><strong style="font-family:var(--font-mono)">${t.coin}</strong></td><td>${dir}</td><td style="font-family:var(--font-mono)">${fmtPrice(t.entry)}</td><td style="font-family:var(--font-mono);color:var(--green)">${fmtPrice(t.tp2||t.tp)}</td><td style="font-family:var(--font-mono);color:var(--red)">${fmtPrice(t.sl)}</td><td style="font-family:var(--font-mono)">${t.leverage||1}x</td><td>${st} <span style="color:var(--text2);font-size:.72rem;font-family:var(--font-mono)">${hrs}h</span></td></tr>`;
        }).join('');

    res.send(_html('My Dashboard', `
${_appNav('home', user.username)}
<div class="wrap">
  ${forbidden}
  <h1 class="page-title">👋 Welcome, <span style="color:var(--accent)">${user.username}</span></h1>
  <div class="g-stats">
    <div class="stat-card"><div class="stat-label">Active Trades</div><div class="stat-val c-cyan">${activeTrades.length}</div><div class="stat-sub">Open positions</div></div>
    <div class="stat-card"><div class="stat-label">Win Rate</div><div class="stat-val c-green">${winRate}</div><div class="stat-sub">${closedCount} closed</div></div>
    <div class="stat-card"><div class="stat-label">Paper Balance</div><div class="stat-val c-yellow">$${parseFloat(paperBalance).toFixed(2)}</div><div class="stat-sub">Virtual wallet</div></div>
    <div class="stat-card"><div class="stat-label">Watchlist</div><div class="stat-val c-purple">${watchCount}</div><div class="stat-sub">Coins tracked</div></div>
    <div class="stat-card"><div class="stat-label">Active Alerts</div><div class="stat-val">${alertCount}</div><div class="stat-sub">Price alerts</div></div>
    <div class="stat-card"><div class="stat-label">Account</div><div class="stat-val" style="font-size:.95rem;padding-top:6px"><span class="pill pill-ok">active</span></div><div class="stat-sub">${user.role}</div></div>
  </div>
  <div class="panel" style="margin-bottom:20px">
    <div class="panel-head"><div class="panel-title">⚡ Active Trades</div><a href="/app/trades" class="btn btn-ghost btn-sm">Full History →</a></div>
    <div class="panel-body" style="padding:0"><div class="tbl-wrap">
      <table><thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP</th><th>SL</th><th>Lev</th><th>Status</th></tr></thead>
      <tbody>${tradesHtml}</tbody></table>
    </div></div>
  </div>
  <div class="g-2">
    <div class="panel" style="background:linear-gradient(135deg,rgba(0,200,255,.05),var(--card))">
      <div class="panel-body">
        <div style="font-size:1.4rem;margin-bottom:8px">⚡</div>
        <div style="font-family:var(--font-head);font-size:1rem;font-weight:700;margin-bottom:5px">AI Scanner</div>
        <div style="font-size:.82rem;color:var(--text2);margin-bottom:14px">70-Factor analysis · Funding · Whale Walls · AI</div>
        <a href="/app/scanner" class="btn btn-primary">⚡ Open Scanner →</a>
      </div>
    </div>
    <div class="panel" style="background:linear-gradient(135deg,rgba(255,171,0,.04),var(--card))">
      <div class="panel-body">
        <div style="font-size:1.4rem;margin-bottom:8px">📄</div>
        <div style="font-family:var(--font-head);font-size:1rem;font-weight:700;margin-bottom:5px">Paper Trading</div>
        <div style="font-size:.82rem;color:var(--text2);margin-bottom:14px">Virtual trades · Live P&L tracking</div>
        <a href="/app/paper" class="btn btn-warn">📄 Paper Trades →</a>
      </div>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-top:4px">
    <a href="/app/watchlist" class="stat-card" style="text-decoration:none;cursor:pointer;display:block">
      <div class="stat-label">👁 Watchlist</div>
      <div style="font-size:.88rem;color:var(--text);margin-top:8px">Track ${watchCount} coins</div>
      <div style="font-size:.72rem;color:var(--accent);margin-top:6px">Open →</div>
    </a>
    <a href="/app/alerts" class="stat-card" style="text-decoration:none;cursor:pointer;display:block">
      <div class="stat-label">🔔 Alerts</div>
      <div style="font-size:.88rem;color:var(--text);margin-top:8px">${alertCount} active alerts</div>
      <div style="font-size:.72rem;color:var(--accent);margin-top:6px">Open →</div>
    </a>
    <a href="/app/news" class="stat-card" style="text-decoration:none;cursor:pointer;display:block">
      <div class="stat-label">📰 Market Intel</div>
      <div style="font-size:.88rem;color:var(--text);margin-top:8px">F&G · Sentiment · News</div>
      <div style="font-size:.72rem;color:var(--accent);margin-top:6px">Open →</div>
    </a>
    <a href="/app/calc" class="stat-card" style="text-decoration:none;cursor:pointer;display:block">
      <div class="stat-label">🧮 Risk Calc</div>
      <div style="font-size:.88rem;color:var(--text);margin-top:8px">Position sizing</div>
      <div style="font-size:.72rem;color:var(--accent);margin-top:6px">Open →</div>
    </a>
  </div>
</div>`));
});

// ══════════════════════════════════════════════════════════════
//  APP TRADES  GET /app/trades
// ══════════════════════════════════════════════════════════════
app.get('/app/trades', saasAuth.requireUserAuth, async (req, res) => {
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
                return `<tr><td><strong style="font-family:var(--font-mono)">${t.coin}</strong></td><td>${dir}</td><td style="font-family:var(--font-mono)">${fmtPrice(t.entry)}</td><td style="font-family:var(--font-mono);color:var(--text3)">${fmtPrice(t.tp1)}</td><td style="font-family:var(--font-mono);color:var(--green)">${fmtPrice(t.tp2||t.tp)}</td><td style="font-family:var(--font-mono);color:var(--red)">${fmtPrice(t.sl)}</td><td style="font-family:var(--font-mono)">${t.leverage||1}x</td><td>${st} <span style="color:var(--text2);font-size:.72rem">${hrs}h</span></td></tr>`;
            }).join('');
        const closed = await db.getSaasUserTradeHistory(user.userId, 100);
        totalClosed = closed.length;
        if (closed.length) {
            closed.forEach(t=>{ totalPnl+=t.pnlPct||0; if(t.result==='WIN') wins++; });
            closedHtml = closed.map(t => {
                const dir=t.direction==='LONG'?'<span class="pill pill-long">▲ LONG</span>':'<span class="pill pill-short">▼ SHORT</span>';
                const result=t.result==='WIN'?'<span class="pill pill-win">WIN</span>':t.result==='LOSS'?'<span class="pill pill-loss">LOSS</span>':'<span class="pill pill-be">B/E</span>';
                const pnl=t.pnlPct?fmtPct(t.pnlPct):'—', pnlColor=t.pnlPct>0?'var(--green)':t.pnlPct<0?'var(--red)':'var(--text2)';
                return `<tr><td><strong style="font-family:var(--font-mono)">${t.coin}</strong></td><td>${dir}</td><td style="font-family:var(--font-mono)">${fmtPrice(t.entry)}</td><td style="font-family:var(--font-mono);color:var(--green)">${fmtPrice(t.tp2||t.tp)}</td><td style="font-family:var(--font-mono);color:var(--red)">${fmtPrice(t.sl)}</td><td>${result}</td><td style="font-family:var(--font-mono);font-weight:700;color:${pnlColor}">${pnl}</td><td style="font-size:.8rem;color:var(--text2)">${t.closedAt?new Date(t.closedAt).toLocaleDateString():'—'}</td></tr>`;
            }).join('');
        } else closedHtml=`<tr><td colspan="8" style="text-align:center;color:var(--text2);padding:28px">No trade history yet</td></tr>`;
    } catch(_){}
    const pnlColor=totalPnl>=0?'var(--green)':'var(--red)';
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

// ══════════════════════════════════════════════════════════════
//  PAPER TRADING  GET /app/paper
// ══════════════════════════════════════════════════════════════
app.get('/app/paper', saasAuth.requireUserAuth, async (req, res) => {
    const user = req.saasUser;
    let paperBalance=0, paperStart=100, wins=0, losses=0, activePaper=[], closedPaper=[];
    let waJid='';
    try {
        const fullUser = await db.getSaasUserById(user.userId);
        waJid = fullUser?.whatsappJid||'';
        if (waJid) {
            const wu = await db.getUser(waJid).catch(()=>null);
            if (wu) { paperBalance=wu.paperBalance||0; paperStart=wu.paperStartBalance||100; wins=wu.paperWins||0; losses=wu.paperLosses||0; }
            activePaper = await db.Trade.find({userJid:waJid,isPaper:true,status:{$in:['active','pending']}}).sort({openTime:-1}).lean();
            closedPaper = await db.Trade.find({userJid:waJid,isPaper:true,status:'closed'}).sort({closedAt:-1}).limit(30).lean();
        }
    } catch(_){}
    const totalPaper=wins+losses;
    const wrStr=totalPaper>0?((wins/totalPaper)*100).toFixed(1)+'%':'—';
    const pnlAmt=paperBalance-paperStart;
    const pnlColor=pnlAmt>=0?'var(--green)':'var(--red)';
    const pnlPct=paperStart>0?((pnlAmt/paperStart)*100).toFixed(1):'0.0';

    const activeRows = activePaper.length===0
        ? `<tr><td colspan="9" style="text-align:center;color:var(--text2);padding:28px"><div style="font-size:1.6rem;margin-bottom:8px">📄</div>No open paper trades<br><small>Open a position from the <a href="/app/scanner">AI Scanner</a> results</small></td></tr>`
        : activePaper.map(t => {
            const dir=t.direction==='LONG'?'<span class="pill pill-long">▲ L</span>':'<span class="pill pill-short">▼ S</span>';
            const st=t.status==='pending'?'<span class="pill pill-pending">LIMIT</span>':'<span class="pill pill-active">LIVE</span>';
            const hrs=((Date.now()-new Date(t.openTime))/3600000).toFixed(1);
            return `<tr>
              <td><strong style="font-family:var(--font-mono)">${t.coin.replace('USDT','')}</strong></td>
              <td>${dir}</td>
              <td style="font-family:var(--font-mono)">${fmtPrice(t.entry)}</td>
              <td style="font-family:var(--font-mono);color:var(--text3)">${fmtPrice(t.tp1)}</td>
              <td style="font-family:var(--font-mono);color:var(--green)">${fmtPrice(t.tp2||t.tp)}</td>
              <td style="font-family:var(--font-mono);color:var(--red)">${fmtPrice(t.sl)}</td>
              <td style="font-family:var(--font-mono)">${t.leverage||1}x</td>
              <td>${st} <span style="color:var(--text2);font-size:.72rem">${hrs}h</span></td>
              <td><button class="btn btn-danger btn-sm" onclick="closePaperTrade('${t._id}','${t.coin.replace('USDT','')}')">Close</button></td>
            </tr>`;
        }).join('');

    const closedRows = closedPaper.length===0
        ? `<tr><td colspan="7" style="text-align:center;color:var(--text2);padding:28px">No closed paper trades yet</td></tr>`
        : closedPaper.map(t => {
            const dir=t.direction==='LONG'?'<span class="pill pill-long">▲ L</span>':'<span class="pill pill-short">▼ S</span>';
            const result=t.result==='WIN'?'<span class="pill pill-win">WIN</span>':t.result==='LOSS'?'<span class="pill pill-loss">LOSS</span>':'<span class="pill pill-be">B/E</span>';
            const pnl=t.paperProfit?(t.paperProfit>=0?'+':'')+t.paperProfit.toFixed(2):'—';
            const pnlColor=t.paperProfit>0?'var(--green)':t.paperProfit<0?'var(--red)':'var(--text2)';
            return `<tr><td><strong style="font-family:var(--font-mono)">${t.coin.replace('USDT','')}</strong></td><td>${dir}</td><td style="font-family:var(--font-mono)">${fmtPrice(t.entry)}</td><td style="font-family:var(--font-mono);color:var(--green)">${fmtPrice(t.tp2||t.tp)}</td><td style="font-family:var(--font-mono);color:var(--red)">${fmtPrice(t.sl)}</td><td>${result}</td><td style="font-family:var(--font-mono);font-weight:700;color:${pnlColor}">${pnl}</td></tr>`;
        }).join('');

    const notLinked = !waJid ? `<div style="background:rgba(255,171,0,.07);border:1px solid rgba(255,171,0,.2);border-radius:var(--radius);padding:14px 18px;margin-bottom:20px;font-size:.85rem;color:var(--yellow)">
        ⚠️ <strong>WhatsApp not linked.</strong> Paper trade balance &amp; history is tied to your WhatsApp number.
        <a href="/app/settings" style="color:var(--accent);margin-left:8px">Link WhatsApp →</a>
    </div>` : '';

    res.send(_html('Paper Trading', `
${_appNav('paper', user.username)}
<div class="wrap">
  <h1 class="page-title">📄 Paper Trading <span>Virtual trades · Zero risk · Full realism</span></h1>
  ${notLinked}
  <div class="g-stats" style="margin-bottom:22px">
    <div class="stat-card"><div class="stat-label">Paper Balance</div><div class="stat-val c-yellow">$${parseFloat(paperBalance).toFixed(2)}</div><div class="stat-sub">Virtual wallet</div></div>
    <div class="stat-card"><div class="stat-label">Start Balance</div><div class="stat-val">$${parseFloat(paperStart).toFixed(2)}</div><div class="stat-sub">Baseline</div></div>
    <div class="stat-card"><div class="stat-label">Net P&L</div><div class="stat-val" style="color:${pnlColor}">${pnlAmt>=0?'+':''}$${Math.abs(pnlAmt).toFixed(2)}</div><div class="stat-sub">${pnlAmt>=0?'+':''}${pnlPct}%</div></div>
    <div class="stat-card"><div class="stat-label">Win Rate</div><div class="stat-val c-green">${wrStr}</div><div class="stat-sub">${wins}W / ${losses}L</div></div>
    <div class="stat-card"><div class="stat-label">Open Positions</div><div class="stat-val c-cyan">${activePaper.length}</div><div class="stat-sub">Max 5</div></div>
  </div>

  <div class="panel" style="margin-bottom:18px;border-color:rgba(255,171,0,.2)">
    <div class="panel-head">
      <div class="panel-title" style="color:var(--yellow)">📄 Open Paper Trade</div>
      <div style="font-size:.75rem;color:var(--text2)">Enter coin details manually</div>
    </div>
    <div class="panel-body">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-bottom:14px">
        <div><label class="field-label">Coin</label><input type="text" id="pt-coin" class="inp" placeholder="BTC" style="font-family:var(--font-mono);font-weight:700;text-transform:uppercase" maxlength="10"></div>
        <div><label class="field-label">Direction</label><select id="pt-dir" class="inp"><option value="LONG">▲ LONG</option><option value="SHORT">▼ SHORT</option></select></div>
        <div><label class="field-label">Entry Price</label><input type="number" id="pt-entry" class="inp" placeholder="0.00" step="any"></div>
        <div><label class="field-label">TP2 Price</label><input type="number" id="pt-tp2" class="inp" placeholder="0.00" step="any"></div>
        <div><label class="field-label">SL Price</label><input type="number" id="pt-sl" class="inp" placeholder="0.00" step="any"></div>
        <div><label class="field-label">Leverage</label><input type="number" id="pt-lev" class="inp" placeholder="10" value="10" min="1" max="125"></div>
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="btn btn-warn" onclick="openPaperTrade()">📄 Open Paper Trade</button>
        <div id="pt-msg" style="font-size:.83rem"></div>
      </div>
      <div style="font-size:.72rem;color:var(--text2);margin-top:8px">💡 Or use <a href="/app/scanner" style="color:var(--accent)">⚡ AI Scanner</a> to get signals, then click "Open Paper Trade" from the analysis</div>
    </div>
  </div>

  <div class="panel" style="margin-bottom:18px">
    <div class="panel-head">
      <div class="panel-title">⚡ Open Positions (${activePaper.length})</div>
      <div id="close-all-wrap" style="${activePaper.length>0?'':'display:none'}">
        <button class="btn btn-danger btn-sm" onclick="resetBalance()">🔄 Reset Paper ($100)</button>
      </div>
    </div>
    <div class="panel-body" style="padding:0"><div class="tbl-wrap">
      <table><thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP1</th><th>TP2</th><th>SL</th><th>Lev</th><th>Status</th><th>Action</th></tr></thead>
      <tbody id="paper-active-body">${activeRows}</tbody></table>
    </div></div>
  </div>

  <div class="panel">
    <div class="panel-head"><div class="panel-title">📜 Paper Trade History <span style="font-size:.78rem;color:var(--text2)">(Last 30)</span></div></div>
    <div class="panel-body" style="padding:0"><div class="tbl-wrap">
      <table><thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP2</th><th>SL</th><th>Result</th><th>Profit $</th></tr></thead>
      <tbody>${closedRows}</tbody></table>
    </div></div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
function showToast(msg,type='ok'){const t=document.getElementById('toast');t.textContent=msg;t.className='toast'+(type==='err'?' err':type==='info'?' info':'');t.style.display='block';clearTimeout(t._to);t._to=setTimeout(()=>t.style.display='none',3200);}
document.getElementById('pt-coin')?.addEventListener('input',e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''));
async function openPaperTrade() {
  const coin=document.getElementById('pt-coin').value.trim().toUpperCase();
  const dir=document.getElementById('pt-dir').value;
  const entry=parseFloat(document.getElementById('pt-entry').value);
  const tp2=parseFloat(document.getElementById('pt-tp2').value);
  const sl=parseFloat(document.getElementById('pt-sl').value);
  const lev=parseInt(document.getElementById('pt-lev').value)||10;
  const msg=document.getElementById('pt-msg');
  if(!coin||!entry||!tp2||!sl){msg.style.color='var(--red)';msg.textContent='❌ Fill all fields';return;}
  msg.style.color='var(--text2)';msg.textContent='⏳ Opening...';
  try{
    const r=await fetch('/app/api/paper/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({coin,direction:dir,entry,tp2,sl,leverage:lev})});
    const d=await r.json();
    if(d.ok){msg.style.color='var(--green)';msg.textContent='✅ Paper trade opened!';setTimeout(()=>location.reload(),1200);}
    else{msg.style.color='var(--red)';msg.textContent='❌ '+(d.error||'Failed');}
  }catch(e){msg.style.color='var(--red)';msg.textContent='❌ Network error';}
}
async function closePaperTrade(id, coin) {
  if(!confirm('Close paper trade for '+coin+'?'))return;
  try{
    const r=await fetch('/app/api/paper/close/'+id,{method:'POST'});
    const d=await r.json();
    if(d.ok){showToast('✅ '+coin+' paper trade closed');setTimeout(()=>location.reload(),1000);}
    else showToast('❌ '+(d.error||'Failed'),'err');
  }catch(e){showToast('❌ Network error','err');}
}
async function resetBalance() {
  if(!confirm('Reset paper balance to $100? This will clear all paper trade history.'))return;
  try{
    const r=await fetch('/app/api/paper/reset',{method:'POST'});
    const d=await r.json();
    if(d.ok){showToast('✅ Paper balance reset to $100');setTimeout(()=>location.reload(),1000);}
    else showToast('❌ '+(d.error||'Failed'),'err');
  }catch(e){showToast('❌ Network error','err');}
}
</script>`));
});

// ─── Paper Trade APIs ──────────────────────────────────────────────────
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
        const risk2pct = margin * 0.02;
        const slDist = Math.abs(parseFloat(entry)-parseFloat(sl));
        const qty = slDist>0 ? risk2pct/slDist : 0;
        const marginUsed = qty>0 ? (qty*parseFloat(entry))/leverage : 0;
        await db.saveTrade({
            userJid:waJid, userId:req.saasUser.userId,
            coin:coinFull, type:'future', direction,
            entry:parseFloat(entry), tp:parseFloat(tp2), tp1:null, tp2:parseFloat(tp2), sl:parseFloat(sl),
            status:'active', orderType:'MARKET', isPaper:true, source:'WEB',
            leverage:parseInt(leverage), quantity:qty, marginUsed, score:0, timeframe:'15m',
        });
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

// ══════════════════════════════════════════════════════════════
//  PRICE ALERTS  GET /app/alerts
// ══════════════════════════════════════════════════════════════
app.get('/app/alerts', saasAuth.requireUserAuth, async (req, res) => {
    const user = req.saasUser;
    let activeAlerts=[], triggeredAlerts=[], waJid='';
    try {
        const fullUser = await db.getSaasUserById(user.userId);
        waJid = fullUser?.whatsappJid||'';
        if (waJid) {
            activeAlerts    = await Alert.find({userJid:waJid,triggered:false}).sort({createdAt:-1}).lean();
            triggeredAlerts = await Alert.find({userJid:waJid,triggered:true}).sort({createdAt:-1}).limit(20).lean();
        }
    } catch(_){}

    const notLinked = !waJid ? `<div style="background:rgba(255,171,0,.07);border:1px solid rgba(255,171,0,.2);border-radius:var(--radius);padding:14px 18px;margin-bottom:20px;font-size:.85rem;color:var(--yellow)">
        ⚠️ <strong>WhatsApp not linked.</strong> Alerts fire to your WhatsApp number. <a href="/app/settings" style="color:var(--accent)">Link WhatsApp →</a>
    </div>` : '';

    const activeRows = activeAlerts.length===0
        ? `<tr><td colspan="5" style="text-align:center;color:var(--text2);padding:28px"><div style="font-size:1.6rem;margin-bottom:8px">🔔</div>No active alerts. Create one below.</td></tr>`
        : activeAlerts.map(a => {
            const cond = a.condition==='above' ? '<span style="color:var(--green)">📈 Above</span>' : '<span style="color:var(--red)">📉 Below</span>';
            return `<tr>
              <td><strong style="font-family:var(--font-mono)">${a.coin.replace('USDT','')}</strong></td>
              <td>${cond}</td>
              <td style="font-family:var(--font-mono);font-weight:700">$${parseFloat(a.targetPrice).toFixed(4)}</td>
              <td style="font-size:.8rem;color:var(--text2)">${new Date(a.createdAt).toLocaleDateString()}</td>
              <td><button class="btn btn-danger btn-sm" onclick="deleteAlert('${a._id}')">Delete</button></td>
            </tr>`;
        }).join('');

    const trgRows = triggeredAlerts.length===0
        ? `<tr><td colspan="3" style="text-align:center;color:var(--text2);padding:20px">No triggered alerts yet</td></tr>`
        : triggeredAlerts.map(a=>`<tr><td style="font-family:var(--font-mono)">${a.coin.replace('USDT','')}</td><td style="font-size:.82rem">${a.condition==='above'?'📈 Above':'📉 Below'} $${parseFloat(a.targetPrice).toFixed(4)}</td><td style="font-size:.78rem;color:var(--text2)">${new Date(a.createdAt).toLocaleDateString()}</td></tr>`).join('');

    res.send(_html('Price Alerts', `
${_appNav('alerts', user.username)}
<div class="wrap">
  <h1 class="page-title">🔔 Price Alerts <span>Get notified on WhatsApp when price hits your target</span></h1>
  ${notLinked}

  <div class="panel" style="margin-bottom:20px;max-width:560px">
    <div class="panel-head"><div class="panel-title">➕ Create Alert</div></div>
    <div class="panel-body">
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
        <div style="flex:1;min-width:110px">
          <label class="field-label">Coin</label>
          <input type="text" id="al-coin" class="inp" placeholder="BTC, ETH..." style="font-family:var(--font-mono);font-weight:700;text-transform:uppercase" maxlength="10">
        </div>
        <div style="min-width:120px">
          <label class="field-label">Condition</label>
          <select id="al-cond" class="inp">
            <option value="above">📈 Price Above</option>
            <option value="below">📉 Price Below</option>
          </select>
        </div>
        <div style="min-width:130px">
          <label class="field-label">Target Price ($)</label>
          <input type="number" id="al-price" class="inp" placeholder="0.00" step="any">
        </div>
        <button class="btn btn-primary" onclick="createAlert()">🔔 Set Alert</button>
      </div>
      <div id="al-msg" style="margin-top:10px;font-size:.83rem"></div>
    </div>
  </div>

  <div class="panel" style="margin-bottom:20px">
    <div class="panel-head"><div class="panel-title">🔔 Active Alerts (${activeAlerts.length})</div></div>
    <div class="panel-body" style="padding:0"><div class="tbl-wrap">
      <table><thead><tr><th>Coin</th><th>Condition</th><th>Target</th><th>Created</th><th>Action</th></tr></thead>
      <tbody id="alerts-body">${activeRows}</tbody></table>
    </div></div>
  </div>

  <div class="panel">
    <div class="panel-head"><div class="panel-title">✅ Triggered Alerts (Recent)</div></div>
    <div class="panel-body" style="padding:0"><div class="tbl-wrap">
      <table><thead><tr><th>Coin</th><th>Condition</th><th>Date</th></tr></thead>
      <tbody>${trgRows}</tbody></table>
    </div></div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
function showToast(msg,type='ok'){const t=document.getElementById('toast');t.textContent=msg;t.className='toast'+(type==='err'?' err':type==='info'?' info':'');t.style.display='block';clearTimeout(t._to);t._to=setTimeout(()=>t.style.display='none',3200);}
document.getElementById('al-coin')?.addEventListener('input',e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''));
async function createAlert() {
  const coin=document.getElementById('al-coin').value.trim().toUpperCase();
  const cond=document.getElementById('al-cond').value;
  const price=parseFloat(document.getElementById('al-price').value);
  const msg=document.getElementById('al-msg');
  if(!coin||!price||isNaN(price)){msg.style.color='var(--red)';msg.textContent='❌ Fill all fields';return;}
  msg.style.color='var(--text2)';msg.textContent='⏳ Creating...';
  try{
    const r=await fetch('/app/api/alerts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({coin,condition:cond,targetPrice:price})});
    const d=await r.json();
    if(d.ok){msg.style.color='var(--green)';msg.textContent='✅ Alert created!';setTimeout(()=>location.reload(),1200);}
    else{msg.style.color='var(--red)';msg.textContent='❌ '+(d.error||'Failed');}
  }catch(e){msg.style.color='var(--red)';msg.textContent='❌ Network error';}
}
async function deleteAlert(id) {
  if(!confirm('Delete this alert?'))return;
  try{
    const r=await fetch('/app/api/alerts/'+id,{method:'DELETE'});
    const d=await r.json();
    if(d.ok){showToast('✅ Alert deleted');setTimeout(()=>location.reload(),800);}
    else showToast('❌ '+(d.error||'Failed'),'err');
  }catch(e){showToast('❌ Network error','err');}
}
</script>`));
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

// ══════════════════════════════════════════════════════════════
//  WATCHLIST  GET /app/watchlist
// ══════════════════════════════════════════════════════════════
app.get('/app/watchlist', saasAuth.requireUserAuth, async (req, res) => {
    const user = req.saasUser;
    let coins=[], waJid='';
    try {
        const fullUser = await db.getSaasUserById(user.userId);
        waJid = fullUser?.whatsappJid||'';
        if (waJid) {
            const wl = await Watchlist.findOne({userJid:waJid}).lean();
            coins = wl?.coins||[];
        }
    } catch(_){}

    const notLinked = !waJid ? `<div style="background:rgba(255,171,0,.07);border:1px solid rgba(255,171,0,.2);border-radius:var(--radius);padding:14px 18px;margin-bottom:20px;font-size:.85rem;color:var(--yellow)">⚠️ <strong>WhatsApp not linked.</strong> Watchlist is tied to your WhatsApp. <a href="/app/settings" style="color:var(--accent)">Link →</a></div>` : '';

    res.send(_html('Watchlist', `
${_appNav('watchlist', user.username)}
<div class="wrap">
  <h1 class="page-title">👁 Watchlist <span>${coins.length}/15 coins</span></h1>
  ${notLinked}

  <div class="panel" style="margin-bottom:20px;max-width:520px">
    <div class="panel-head"><div class="panel-title">➕ Add Coins</div></div>
    <div class="panel-body">
      <div style="display:flex;gap:10px;align-items:flex-end">
        <div style="flex:1"><label class="field-label">Coins (space-separated)</label>
          <input type="text" id="wl-coins" class="inp" placeholder="BTC ETH SOL AVAX" style="text-transform:uppercase;font-family:var(--font-mono)">
        </div>
        <button class="btn btn-primary" onclick="addCoins()">Add →</button>
      </div>
      <div id="wl-add-msg" style="margin-top:8px;font-size:.82rem"></div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <div class="panel-title">👁 My Watchlist</div>
      <button class="btn btn-ghost btn-sm" onclick="refreshPrices()">↺ Refresh Prices</button>
    </div>
    <div id="wl-loading" style="display:none;padding:20px;text-align:center;color:var(--text2);font-size:.85rem">⏳ Loading prices...</div>
    <div id="wl-grid" style="padding:16px 20px;display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px">
      ${coins.length===0
        ? '<div style="grid-column:1/-1;text-align:center;padding:32px;color:var(--text2)"><div style="font-size:2rem;margin-bottom:8px">👁</div>No coins yet. Add some above.</div>'
        : coins.map(c=>`<div id="wc-${c}" class="stat-card" style="cursor:pointer" onclick="analyseCoin('${c.replace('USDT','')}')">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <div style="font-family:var(--font-head);font-size:1rem;font-weight:800">${c.replace('USDT','')}</div>
              <button class="btn btn-danger btn-sm" style="padding:2px 7px;font-size:.65rem" onclick="event.stopPropagation();removeCoin('${c}')">✕</button>
            </div>
            <div style="font-family:var(--font-mono);font-size:1.1rem;font-weight:700;color:var(--accent)" id="wp-${c}">Loading...</div>
            <div style="font-size:.7rem;color:var(--text2);margin-top:4px" id="wch-${c}"></div>
            <div style="font-size:.65rem;color:var(--accent);margin-top:6px">Click → Analyse ⚡</div>
          </div>`).join('')}
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
function showToast(msg,t='ok'){const el=document.getElementById('toast');el.textContent=msg;el.className='toast'+(t==='err'?' err':t==='info'?' info':'');el.style.display='block';clearTimeout(el._to);el._to=setTimeout(()=>el.style.display='none',3200);}
document.getElementById('wl-coins')?.addEventListener('input',e=>e.target.value=e.target.value.toUpperCase());
async function addCoins() {
  const raw=document.getElementById('wl-coins').value.trim();
  const msg=document.getElementById('wl-add-msg');
  if(!raw){msg.style.color='var(--red)';msg.textContent='❌ Enter coin symbols';return;}
  const coins=raw.split(/[\\s,]+/).filter(Boolean);
  msg.style.color='var(--text2)';msg.textContent='⏳ Adding...';
  try{
    const r=await fetch('/app/api/watchlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({coins})});
    const d=await r.json();
    if(d.ok){msg.style.color='var(--green)';msg.textContent='✅ Added!';setTimeout(()=>location.reload(),1000);}
    else{msg.style.color='var(--red)';msg.textContent='❌ '+(d.error||'Failed');}
  }catch(e){msg.style.color='var(--red)';msg.textContent='❌ Network error';}
}
async function removeCoin(coin) {
  try{
    const r=await fetch('/app/api/watchlist/'+coin,{method:'DELETE'});
    const d=await r.json();
    if(d.ok){showToast('✅ Removed');document.getElementById('wc-'+coin)?.remove();}
    else showToast('❌ '+(d.error||'Failed'),'err');
  }catch(e){showToast('❌ Network error','err');}
}
function analyseCoin(coin) { window.location.href='/app/scanner?coin='+coin; }
async function refreshPrices() {
  document.getElementById('wl-loading').style.display='block';
  try{
    const r=await fetch('/app/api/watchlist/prices');
    const d=await r.json();
    if(d.ok && d.prices){
      d.prices.forEach(p=>{
        const pe=document.getElementById('wp-'+p.coin);
        const ch=document.getElementById('wch-'+p.coin);
        if(pe){pe.textContent='$'+parseFloat(p.price).toFixed(p.price>=1000?2:p.price>=1?4:6);pe.style.color=parseFloat(p.change)>=0?'var(--green)':'var(--red)';}
        if(ch&&p.change!=null){ch.textContent=(parseFloat(p.change)>=0?'+':'')+parseFloat(p.change).toFixed(2)+'% 24h';ch.style.color=parseFloat(p.change)>=0?'var(--green)':'var(--red)';}
      });
    }
  }catch(_){}
  document.getElementById('wl-loading').style.display='none';
}
document.addEventListener('DOMContentLoaded', () => {
  const params=new URLSearchParams(location.search);
  if(params.get('coin')){document.getElementById('wl-coins').value=params.get('coin');}
  if(${JSON.stringify(coins.length > 0)}) refreshPrices();
});
</script>`));
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

// ══════════════════════════════════════════════════════════════
//  MARKET INTEL  GET /app/news
// ══════════════════════════════════════════════════════════════
app.get('/app/news', saasAuth.requireUserAuth, async (req, res) => {
    const user = req.saasUser;
    res.send(_html('Market Intel', `
${_appNav('news', user.username)}
<div class="wrap">
  <h1 class="page-title">📰 Market Intel <span>F&G · Sentiment · Funding · News</span></h1>
  <div id="intel-loading" style="padding:60px 0;text-align:center">
    <div style="font-size:2.6rem;animation:spin 1s linear infinite;display:inline-block">📡</div>
    <div style="margin-top:14px;font-size:.9rem;color:var(--text)">Loading market data...</div>
  </div>
  <div id="intel-content" style="display:none"></div>
</div>
<script>
async function loadIntel() {
  try {
    const r=await fetch('/app/api/market-intel');
    const d=await r.json();
    if(!d.ok){document.getElementById('intel-loading').innerHTML='<div style="color:var(--red)">❌ '+( d.error||'Failed to load')+'</div>';return;}
    const{sent,funding,topCoins}=d;
    const s=sent||{};
    const fngEmoji=s.fngEmoji||'⚪',fngVal=s.fngValue||'—',fngLbl=s.fngLabel||'—';
    const fngColor=parseInt(fngVal)<25?'var(--red)':parseInt(fngVal)<45?'var(--yellow)':parseInt(fngVal)<60?'var(--green)':parseInt(fngVal)<80?'var(--yellow)':'var(--red)';
    const nScore=s.newsSentimentScore||0;
    const headlines=(s.newsHeadlines||[]).slice(0,5);
    document.getElementById('intel-content').innerHTML=\`
      <div class="g-stats" style="margin-bottom:22px">
        <div class="stat-card"><div class="stat-label">Fear & Greed</div>
          <div style="font-size:2.2rem;font-family:var(--font-mono);font-weight:800;line-height:1;color:\${fngColor}">\${fngEmoji} \${fngVal}</div>
          <div class="stat-sub">\${fngLbl}</div></div>
        <div class="stat-card"><div class="stat-label">₿ BTC Dominance</div>
          <div class="stat-val c-yellow">\${s.btcDominance||'—'}%</div>
          <div class="stat-sub">\${parseInt(s.btcDominance)>55?'Alts suffering':parseInt(s.btcDominance)<45?'Altseason':'Balanced'}</div></div>
        <div class="stat-card"><div class="stat-label">News Sentiment</div>
          <div class="stat-val" style="color:\${nScore>0?'var(--green)':nScore<0?'var(--red)':'var(--text2)'}">\${nScore>=0?'+':''}\${nScore} / 5</div>
          <div class="stat-sub">\${nScore>2?'Very Bullish':nScore>0?'Slightly Bullish':nScore<-2?'Very Bearish':nScore<0?'Slightly Bearish':'Neutral'}</div></div>
        <div class="stat-card"><div class="stat-label">Overall Bias</div>
          <div style="font-size:.95rem;font-weight:700;margin-top:8px;color:var(--text)">\${s.overallSentiment||'—'}</div>
          <div class="stat-sub">\${s.tradingBias||'—'}</div></div>
      </div>

      \${topCoins&&topCoins.length?'<div class="panel" style="margin-bottom:20px"><div class="panel-head"><div class="panel-title">💸 Extreme Funding Rates</div><div style="font-size:.75rem;color:var(--text2)">>0.1% = squeeze risk</div></div><div class="panel-body" style="padding:0"><table style="width:100%"><thead><tr><th>Coin</th><th>Funding Rate</th><th>Signal</th></tr></thead><tbody>'+topCoins.map(f=>'<tr><td style="font-family:var(--font-mono);font-weight:700">'+f.coin+'</td><td style="font-family:var(--font-mono);color:'+(parseFloat(f.rate)>0?'var(--red)':'var(--green)')+';">'+(parseFloat(f.rate)>=0?'+':'')+f.rate+'%</td><td style="font-size:.82rem">'+f.signal+'</td></tr>').join('')+'</tbody></table></div></div>':''}

      \${headlines.length?'<div class="panel" style="margin-bottom:20px"><div class="panel-head"><div class="panel-title">📰 Latest News</div></div><div class="panel-body"><div style="display:flex;flex-direction:column;gap:10px">'+headlines.map(h=>'<div style="padding:10px 14px;background:var(--bg2);border-radius:var(--radius-sm);font-size:.84rem;color:var(--text);border-left:3px solid var(--border2)">'+h+'</div>').join('')+'</div></div></div>':''}

      <div style="text-align:right;font-size:.7rem;color:var(--text2)">⏱️ Updated at \${new Date().toLocaleTimeString()}</div>
    \`;
    document.getElementById('intel-loading').style.display='none';
    document.getElementById('intel-content').style.display='block';
  }catch(e){document.getElementById('intel-loading').innerHTML='<div style="color:var(--red)">❌ Failed: '+e.message+'</div>';}
}
document.addEventListener('DOMContentLoaded', loadIntel);
</script>`));
});

app.get('/app/api/market-intel', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const binance = require('./lib/binance');
        const fallback = {fngValue:50,fngLabel:'Neutral',fngEmoji:'⚪',btcDominance:'—',newsSentimentScore:0,newsHeadlines:[],overallSentiment:'⚪ NEUTRAL',tradingBias:'Neutral'};
        const sent = await withTimeout(binance.getMarketSentiment(), 12000, fallback);
        // Extreme funding rates
        let topCoins = [];
        try {
            const fr = await axios.get('https://fapi.binance.com/fapi/v1/premiumIndex',{timeout:8000});
            const WATCH = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT','MATICUSDT','ATOMUSDT','NEARUSDT','LTCUSDT','DOGEUSDT','UNIUSDT'];
            topCoins = WATCH.map(sym => {
                const d = fr.data.find(x=>x.symbol===sym);
                if (!d) return null;
                const rate = (parseFloat(d.lastFundingRate)*100).toFixed(4);
                const rateNum = parseFloat(rate);
                if (Math.abs(rateNum) < 0.05) return null;
                return { coin:sym.replace('USDT',''), rate, signal: rateNum>0.1?'🔴 Longs heavy → SHORT squeeze':rateNum<-0.1?'🟢 Shorts heavy → LONG squeeze':rateNum>0?'⚠️ Longs elevated':'⚠️ Shorts elevated' };
            }).filter(Boolean).sort((a,b)=>Math.abs(parseFloat(b.rate))-Math.abs(parseFloat(a.rate)));
        } catch(_){}
        res.json({ok:true, sent, topCoins});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// ══════════════════════════════════════════════════════════════
//  RISK CALCULATOR  GET /app/calc
// ══════════════════════════════════════════════════════════════
app.get('/app/calc', saasAuth.requireUserAuth, (req, res) => {
    const user = req.saasUser;
    res.send(_html('Risk Calculator', `
${_appNav('calc', user.username)}
<div class="wrap">
  <h1 class="page-title">🧮 Risk & Position Calculator <span>Binance Futures · Risk-Based Sizing</span></h1>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start">

    <div class="panel">
      <div class="panel-head"><div class="panel-title">⚙️ Trade Parameters</div></div>
      <div class="panel-body">
        <div class="field"><label class="field-label">💰 Account Balance ($)</label>
          <input type="number" id="c-balance" class="inp" placeholder="1000" value="1000" min="1" oninput="calc()"></div>
        <div class="field"><label class="field-label">🛡️ Risk Per Trade (%)</label>
          <input type="number" id="c-risk" class="inp" placeholder="2" value="2" min="0.1" max="100" step="0.1" oninput="calc()">
          <div style="font-size:.72rem;color:var(--text2);margin-top:5px">Professional traders risk 1–2% per trade</div>
        </div>
        <div class="field"><label class="field-label">📍 Entry Price ($)</label>
          <input type="number" id="c-entry" class="inp" placeholder="42000" step="any" oninput="calc()"></div>
        <div class="field"><label class="field-label">🛡️ Stop Loss Price ($)</label>
          <input type="number" id="c-sl" class="inp" placeholder="41000" step="any" oninput="calc()"></div>
        <div class="field"><label class="field-label">🎯 Take Profit Price ($)</label>
          <input type="number" id="c-tp" class="inp" placeholder="44000" step="any" oninput="calc()"></div>
        <div class="field"><label class="field-label">⚡ Leverage Override (optional)</label>
          <input type="number" id="c-lev" class="inp" placeholder="Auto-calculated" min="1" max="125" oninput="calc()">
          <div style="font-size:.72rem;color:var(--text2);margin-top:5px">Leave blank for AI auto-leverage</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary" style="flex:1" onclick="calc()">🧮 Calculate</button>
          <button class="btn btn-ghost" onclick="clearCalc()">Clear</button>
        </div>
      </div>
    </div>

    <div>
      <div class="panel" style="margin-bottom:18px;border-color:rgba(0,200,255,.2)">
        <div class="panel-head"><div class="panel-title" style="color:var(--accent)">📊 Position Sizing</div></div>
        <div class="panel-body">
          <div class="g-stats" style="grid-template-columns:1fr 1fr;margin-bottom:14px">
            <div class="stat-card"><div class="stat-label">Recommended Leverage</div><div class="stat-val c-yellow" id="r-lev">—</div><div class="stat-sub">Cross mode</div></div>
            <div class="stat-card"><div class="stat-label">Margin to Use</div><div class="stat-val c-cyan" id="r-margin">—</div><div class="stat-sub">Of your balance</div></div>
          </div>
          <div style="display:grid;gap:8px">
            ${[['💰 Risk Amount','r-risk','Amount at risk (max loss)'],['📦 Position Size','r-qty','Units to buy/sell'],['🎯 Risk/Reward','r-rrr','TP vs SL ratio'],['📉 SL Distance','r-sldist','% from entry to SL'],['💸 Pot. Profit','r-profit','If TP is hit']].map(([l,id,sub])=>`
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg2);border-radius:var(--radius-sm)">
              <div><div style="font-size:.82rem;font-weight:600">${l}</div><div style="font-size:.68rem;color:var(--text2)">${sub}</div></div>
              <div style="font-family:var(--font-mono);font-size:1rem;font-weight:700;color:var(--text)" id="${id}">—</div>
            </div>`).join('')}
          </div>
        </div>
      </div>

      <div class="panel" style="margin-bottom:18px">
        <div class="panel-head"><div class="panel-title">📉 DCA Plan</div></div>
        <div class="panel-body">
          <div style="display:grid;gap:7px" id="dca-plan">
            <div style="color:var(--text2);font-size:.83rem">Enter entry and SL to calculate DCA points.</div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><div class="panel-title">📚 Quick Guide</div></div>
        <div class="panel-body">
          ${[['1–2%','Safe (professional standard)','var(--green)'],['3–5%','Aggressive (experienced traders)','var(--yellow)'],['5–10%','Very High Risk','var(--red)'],['> 10%','Gambling — avoid','var(--red)']].map(([pct,label,c])=>`<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:.82rem"><span style="color:${c};font-weight:700">${pct}</span><span style="color:var(--text2)">${label}</span></div>`).join('')}
          <div style="margin-top:12px;font-size:.77rem;color:var(--text2);line-height:1.6">
            💡 <strong>Formula:</strong> Margin = (Risk $ × Leverage) ÷ Entry<br>
            💡 <strong>SL Distance</strong> determines leverage: tighter SL = higher leverage
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
function fmtD(n,d=4){if(n==null||isNaN(n))return'—';const p=parseFloat(n);if(d===4){if(p>=10000)return'$'+p.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});if(p>=1)return'$'+p.toFixed(4);return'$'+p.toFixed(6);}return p.toFixed(d);}
function calc() {
  const bal=parseFloat(document.getElementById('c-balance').value)||0;
  const riskPct=parseFloat(document.getElementById('c-risk').value)||2;
  const entry=parseFloat(document.getElementById('c-entry').value)||0;
  const sl=parseFloat(document.getElementById('c-sl').value)||0;
  const tp=parseFloat(document.getElementById('c-tp').value)||0;
  const levOverride=parseFloat(document.getElementById('c-lev').value)||0;
  if(!bal||!entry||!sl){return;}
  const isLong=tp>entry;
  const riskAmt=bal*(riskPct/100);
  const slDist=Math.abs(entry-sl);
  const slDistPct=slDist/entry*100;
  const qty=slDist>0?riskAmt/slDist:0;
  let lev=levOverride>0?levOverride:Math.min(Math.ceil(slDistPct>0?(riskPct/slDistPct)/0.10:10),75);
  const marginUsed=qty>0?(qty*entry)/lev:0;
  const potProfit=tp>0&&qty>0?Math.abs(tp-entry)*qty:0;
  const rrr=slDist>0&&tp>0?Math.abs(tp-entry)/slDist:0;
  document.getElementById('r-lev').textContent='Cross '+lev+'x';
  document.getElementById('r-margin').textContent='$'+marginUsed.toFixed(2)+' ('+(marginUsed/bal*100).toFixed(1)+'%)';
  document.getElementById('r-risk').textContent='$'+riskAmt.toFixed(2)+' ('+riskPct+'%)';
  document.getElementById('r-qty').textContent=qty>0?(qty<1?qty.toFixed(4):Math.round(qty).toString())+' units':'—';
  document.getElementById('r-sldist').textContent=slDistPct.toFixed(2)+'% ($'+slDist.toFixed(4)+')';
  document.getElementById('r-rrr').textContent=rrr>0?'1:'+rrr.toFixed(2):(tp?'—':'Enter TP');
  document.getElementById('r-profit').textContent=tp>0?'$'+potProfit.toFixed(2):'Enter TP price';
  // DCA
  const dca1=isLong?entry-slDist*0.35:entry+slDist*0.35;
  const dca2=isLong?entry-slDist*0.70:entry+slDist*0.70;
  document.getElementById('dca-plan').innerHTML=[
    ['Entry (50% size)',entry,'var(--accent)'],
    ['DCA 1 — 35% toward SL',dca1,'var(--yellow)'],
    ['DCA 2 — 70% toward SL',dca2,'var(--red)'],
    ['Hard Stop Loss',sl,'var(--red)'],
  ].map(([l,v,c])=>'<div style="display:flex;justify-content:space-between;padding:7px 10px;background:var(--bg2);border-radius:5px"><span style="font-size:.8rem;color:var(--text2)">'+l+'</span><span style="font-family:var(--font-mono);font-size:.85rem;font-weight:600;color:'+c+'">'+fmtD(v)+'</span></div>').join('');
}
function clearCalc(){['c-entry','c-sl','c-tp','c-lev'].forEach(id=>document.getElementById(id).value='');['r-lev','r-margin','r-risk','r-qty','r-sldist','r-rrr','r-profit'].forEach(id=>document.getElementById(id).textContent='—');document.getElementById('dca-plan').innerHTML='<div style="color:var(--text2);font-size:.83rem">Enter entry and SL to calculate DCA points.</div>';}
document.addEventListener('DOMContentLoaded', calc);
</script>`));
});

// ══════════════════════════════════════════════════════════════
//  SETTINGS  GET /app/settings
// ══════════════════════════════════════════════════════════════
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
            waLinkedAt = fullUser.whatsappLinkedAt?new Date(fullUser.whatsappLinkedAt).toLocaleString():'';
        }
        if (waJid) {
            const wu = await db.getUser(waJid).catch(()=>null);
            if (wu) { paperBalance=wu.paperBalance||0; margin=wu.margin||0; }
        }
    } catch(_){}

    const keysHtml = apiKeys.length===0
        ? `<div style="text-align:center;padding:28px;color:var(--text2)"><div style="font-size:1.5rem;margin-bottom:8px">🔑</div>No API keys yet</div>`
        : `<div class="tbl-wrap" style="margin-bottom:16px"><table><thead><tr><th>Label</th><th>Exchange</th><th>Added</th><th>Action</th></tr></thead><tbody>
        ${apiKeys.map(k=>`<tr><td><strong>${k.label}</strong></td><td style="text-transform:capitalize;font-size:.82rem">${k.exchange}</td><td style="font-size:.82rem;color:var(--text2)">${k.addedAt}</td><td><button class="btn btn-danger btn-sm" onclick="removeKey('${k._id}')">Remove</button></td></tr>`).join('')}
        </tbody></table></div>`;

    const msgs = {
        added:   req.query.added   ? '<div style="color:var(--green);font-size:.82rem;margin-bottom:10px">✅ API key added.</div>' : '',
        removed: req.query.removed ? '<div style="color:var(--green);font-size:.82rem;margin-bottom:10px">✅ API key removed.</div>' : '',
        keyerr:  req.query.keyerr==='exists'?'<div style="color:var(--red);font-size:.82rem;margin-bottom:10px">❌ Label already exists.</div>':req.query.keyerr==='invalid'?'<div style="color:var(--red);font-size:.82rem;margin-bottom:10px">❌ Fill all fields.</div>':req.query.keyerr?'<div style="color:var(--red);font-size:.82rem;margin-bottom:10px">❌ Error saving key.</div>':'',
        unlinked:req.query.unlinked?'<div style="color:var(--green);font-size:.82rem;margin-bottom:10px">✅ WhatsApp unlinked.</div>':'',
    };
    const isAuto = tradingMode==='auto_trade';

    res.send(_html('Settings', `
${_appNav('settings', user.username)}
<div class="wrap">
  <h1 class="page-title">⚙️ Account Settings</h1>
  <div class="g-2">
    <div>
      <div class="panel" style="margin-bottom:20px">
        <div class="panel-head"><div class="panel-title">🗝️ Exchange API Keys</div></div>
        <div class="panel-body">
          <div style="font-size:.82rem;color:var(--text2);margin-bottom:14px">Keys stored encrypted (AES-256-GCM). <strong style="color:var(--yellow)">⚠️ Never share secret key.</strong></div>
          ${msgs.added}${msgs.removed}${msgs.keyerr}${keysHtml}
          <form method="POST" action="/app/api/keys/add">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
              <div><label class="field-label">Label</label><input class="inp" type="text" name="label" placeholder="Binance Main" required maxlength="40"></div>
              <div><label class="field-label">Exchange</label><select class="inp" name="exchange"><option value="binance">Binance</option><option value="bybit">Bybit</option></select></div>
              <div><label class="field-label">API Key</label><input class="inp" type="text" name="apiKey" placeholder="Your API key" autocomplete="off" required></div>
              <div><label class="field-label">Secret Key</label><input class="inp" type="password" name="secretKey" placeholder="Your secret" autocomplete="off" required></div>
            </div>
            <button type="submit" class="btn btn-primary">🔒 Save Key</button>
          </form>
        </div>
      </div>

      <div class="panel" style="margin-bottom:20px">
        <div class="panel-head"><div class="panel-title">💰 Capital & Paper Balance</div></div>
        <div class="panel-body">
          <div class="stat-row"><span>Trading Capital</span><span class="stat-row-val c-cyan">$${parseFloat(margin).toFixed(2)}</span></div>
          <div class="stat-row"><span>Paper Balance</span><span class="stat-row-val c-yellow">$${parseFloat(paperBalance).toFixed(2)}</span></div>
          <div style="margin-top:12px;display:flex;gap:10px;align-items:flex-end">
            <div style="flex:1"><label class="field-label">Set Capital ($)</label><input type="number" id="margin-inp" class="inp" placeholder="${margin||1000}" min="1" step="1"></div>
            <button class="btn btn-primary" onclick="setMargin()">Save</button>
          </div>
          <div id="margin-msg" style="margin-top:8px;font-size:.82rem"></div>
        </div>
      </div>
    </div>

    <div>
      <div class="panel" style="margin-bottom:20px;border-color:${waLinked?'rgba(0,230,118,.25)':'var(--border)'}">
        <div class="panel-head"><div class="panel-title">📱 WhatsApp</div></div>
        <div class="panel-body">
          ${msgs.unlinked}
          ${waLinked?`
          <div style="background:rgba(0,230,118,.06);border:1px solid rgba(0,230,118,.2);border-radius:var(--radius);padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
            <div><div style="color:var(--green);font-weight:600">✅ Connected</div>
              <div style="color:var(--text2);font-size:.78rem">${waJid.replace('@s.whatsapp.net','')}</div>
              <div style="color:var(--text2);font-size:.78rem">${waLinkedAt}</div></div>
            <button class="btn btn-danger btn-sm" onclick="unlinkWa()">Unlink</button>
          </div>`:`<div style="background:rgba(255,171,0,.06);border:1px solid rgba(255,171,0,.2);border-radius:var(--radius);padding:10px 12px;margin-bottom:12px;font-size:.82rem;color:var(--yellow)">⚠️ Not linked</div>`}
          <div style="font-size:.8rem;color:var(--text2);margin-bottom:10px">1. Generate token → 2. Send <code style="background:var(--card2);padding:1px 5px;border-radius:3px">.link TOKEN</code> to bot → Done!</div>
          <button class="btn btn-primary" onclick="generateToken()" id="gen-btn">⚡ Generate Token</button>
          <div id="token-display" style="display:none;margin-top:14px">
            <div style="font-size:.78rem;color:var(--text2);margin-bottom:6px">Token (valid 15 min):</div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <code id="token-value" style="background:var(--bg2);border:1px solid var(--accent);border-radius:7px;padding:10px 16px;font-size:1.1rem;font-weight:700;letter-spacing:.12em;color:var(--accent);font-family:var(--font-mono)"></code>
              <button class="btn btn-ghost btn-sm" onclick="copyToken()">📋 Copy</button>
            </div>
            <div id="token-timer" style="font-size:.76rem;color:var(--yellow);margin-top:4px">⏳ Expires in 15:00</div>
          </div>
        </div>
      </div>

      <div class="panel" style="margin-bottom:20px">
        <div class="panel-head"><div class="panel-title">🤖 Trading Mode</div></div>
        <div class="panel-body">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
            <div onclick="setMode('signals_only')" style="cursor:pointer;border:2px solid ${!isAuto?'var(--green)':'var(--border)'};border-radius:var(--radius);padding:14px;background:${!isAuto?'rgba(0,230,118,.04)':'var(--bg2)'};transition:.2s">
              <div style="font-size:1.2rem;margin-bottom:6px">📡</div>
              <div style="font-weight:700;font-size:.88rem;color:${!isAuto?'var(--green)':'var(--text)'}">Signals Only</div>
              <div style="font-size:.73rem;color:var(--text2);margin-top:4px">Alerts via WhatsApp &amp; website</div>
              ${!isAuto?'<div style="margin-top:7px;font-size:.7rem;font-weight:700;color:var(--green)">✅ ACTIVE</div>':''}
            </div>
            <div onclick="setMode('auto_trade')" style="cursor:pointer;border:2px solid ${isAuto?'var(--accent)':'var(--border)'};border-radius:var(--radius);padding:14px;background:${isAuto?'rgba(0,200,255,.04)':'var(--bg2)'};transition:.2s">
              <div style="font-size:1.2rem;margin-bottom:6px">🤖</div>
              <div style="font-weight:700;font-size:.88rem;color:${isAuto?'var(--accent)':'var(--text)'}">Auto Trade</div>
              <div style="font-size:.73rem;color:var(--text2);margin-top:4px">Bot executes on Binance</div>
              ${isAuto?'<div style="margin-top:7px;font-size:.7rem;font-weight:700;color:var(--accent)">✅ ACTIVE</div>':''}
            </div>
          </div>
          <div id="mode-msg" style="font-size:.82rem"></div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><div class="panel-title">👤 Account</div></div>
        <div class="panel-body">
          <div class="stat-row"><span>Username</span><span class="stat-row-val">${user.username}</span></div>
          <div class="stat-row"><span>Role</span><span class="stat-row-val">${user.role}</span></div>
          <div class="stat-row"><span>Mode</span><span class="stat-row-val">${isAuto?'<span class="pill pill-active">🤖 Auto</span>':'<span class="pill pill-ok">📡 Signals</span>'}</span></div>
          <div class="stat-row"><span>WhatsApp</span><span class="stat-row-val">${waLinked?'<span class="pill pill-ok">linked</span>':'<span class="pill pill-susp">not linked</span>'}</span></div>
        </div>
      </div>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
function showToast(msg,type='ok'){const t=document.getElementById('toast');t.textContent=msg;t.className='toast'+(type==='err'?' err':type==='info'?' info':'');t.style.display='block';clearTimeout(t._to);t._to=setTimeout(()=>t.style.display='none',3000);}
async function removeKey(keyId){if(!confirm('Remove this API key?'))return;try{const r=await fetch('/app/api/keys/'+keyId,{method:'DELETE'});const d=await r.json();if(d.ok)location.href='/app/settings?removed=1';else showToast('Error: '+d.error,'err');}catch(e){showToast('Network error','err');}}
async function generateToken(){const btn=document.getElementById('gen-btn');btn.disabled=true;btn.textContent='⏳ Generating...';try{const r=await fetch('/app/api/link/generate',{method:'POST'});const d=await r.json();if(!d.ok){showToast('Error: '+d.error,'err');btn.disabled=false;btn.textContent='⚡ Generate Token';return;}document.getElementById('token-value').textContent=d.token;document.getElementById('token-display').style.display='block';btn.textContent='🔄 Regenerate';btn.disabled=false;let secs=900;const iv=setInterval(()=>{secs--;const m=String(Math.floor(secs/60)).padStart(2,'0'),s=String(secs%60).padStart(2,'0');document.getElementById('token-timer').textContent='⏳ Expires in '+m+':'+s;if(secs<=0){clearInterval(iv);document.getElementById('token-timer').textContent='❌ Expired — regenerate';document.getElementById('token-timer').style.color='var(--red)';}},1000);}catch(e){showToast('Network error','err');btn.disabled=false;btn.textContent='⚡ Generate Token';}}
function copyToken(){const t=document.getElementById('token-value').textContent;navigator.clipboard.writeText(t).then(()=>{const btn=event.target;btn.textContent='✅ Copied!';setTimeout(()=>btn.textContent='📋 Copy',2000);});}
async function unlinkWa(){if(!confirm('Unlink WhatsApp?'))return;try{const r=await fetch('/app/api/link/unlink',{method:'POST'});const d=await r.json();if(d.ok)location.href='/app/settings?unlinked=1';else showToast('Error: '+d.error,'err');}catch(e){showToast('Network error','err');}}
async function setMode(mode){const msg=document.getElementById('mode-msg');msg.textContent='⏳...';msg.style.color='var(--text2)';try{const r=await fetch('/app/api/trading-mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode})});const d=await r.json();if(d.ok){msg.textContent='✅ Mode updated';msg.style.color='var(--green)';setTimeout(()=>location.reload(),900);}else{msg.textContent='❌ '+d.error;msg.style.color='var(--red)';}}catch(e){msg.textContent='❌ Network error';msg.style.color='var(--red)';}}
async function setMargin(){const v=parseFloat(document.getElementById('margin-inp').value);const msg=document.getElementById('margin-msg');if(!v||v<1){msg.style.color='var(--red)';msg.textContent='❌ Enter valid amount';return;}msg.style.color='var(--text2)';msg.textContent='⏳...';try{const r=await fetch('/app/api/margin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:v})});const d=await r.json();if(d.ok){msg.style.color='var(--green)';msg.textContent='✅ Capital set to $'+v.toFixed(2);}else{msg.style.color='var(--red)';msg.textContent='❌ '+(d.error||'Failed');}}catch(e){msg.style.color='var(--red)';msg.textContent='❌ Network error';}}
</script>`));
});

// ─── Settings API endpoints ────────────────────────────────────────────
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
    }catch(e){console.error('[APP] Add key:',e.message);res.redirect('/app/settings?keyerr=server');}
});
app.delete('/app/api/keys/:keyId', saasAuth.requireUserAuth, async (req, res) => {
    try{await db.removeUserApiKey(req.saasUser.userId,req.params.keyId);res.json({ok:true});}
    catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/app/api/link/generate', saasAuth.requireUserAuth, async (req, res) => {
    try{const token=await db.createLinkToken(req.saasUser.userId);res.json({ok:true,token});}
    catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/app/api/link/unlink', saasAuth.requireUserAuth, async (req, res) => {
    try{await db.unlinkWhatsapp(req.saasUser.userId);res.json({ok:true});}
    catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/app/api/trading-mode', saasAuth.requireUserAuth, async (req, res) => {
    try{
        const{mode}=req.body;
        if(!['signals_only','auto_trade'].includes(mode))return res.status(400).json({ok:false,error:'Invalid mode'});
        await db.setTradingMode(req.saasUser.userId,mode);
        res.json({ok:true,mode});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/app/api/margin', saasAuth.requireUserAuth, async (req, res) => {
    try{
        const fullUser=await db.getSaasUserById(req.saasUser.userId);
        const waJid=fullUser?.whatsappJid;
        if(!waJid)return res.status(400).json({ok:false,error:'WhatsApp not linked'});
        const amount=parseFloat(req.body.amount);
        if(!amount||amount<1)return res.status(400).json({ok:false,error:'Invalid amount'});
        await db.setMargin(waJid,amount);
        res.json({ok:true,amount});
    }catch(e){res.status(500).json({ok:false,error:e.message});}
});


    })({ saasAuth, db, config, axios, _html, _appNav, fmtPrice, fmtPct, scoreColor }, app);

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
