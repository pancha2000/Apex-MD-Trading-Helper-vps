'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD v7 PRO VVIP  ·  dashboard.js
 *  ──────────────────────────────────────────────────────────────
 *  Upgraded Control Panel — Master Pro Mode + Paper Trading
 *
 *  New features in this version:
 *    • Master Pro Mode toggle (Settings page)
 *      OFF = Auto AI Mode (default)
 *      ON  = Pro Custom Mode → Advanced Tuning panel expands
 *    • Advanced Tuning panel (hidden until Pro Mode ON):
 *        – RSI Period, Fast EMA, Slow EMA, ADX Choppy, ADX Trending
 *        – Manual Margin (USDT), Manual Leverage
 *    • Paper Trading toggle (Settings page)
 *        – Shows PAPER badge next to all active paper trades
 *        – Separate paper trade stats card on dashboard
 *    • New API endpoints:
 *        POST /api/promode        – toggle Pro Mode
 *        POST /api/papertrading   – toggle Paper Trading
 *        POST /api/proparams/:key – update individual pro params
 *    • Dashboard home page:
 *        – Pro Mode status card
 *        – Paper Trade count card
 *        – Trades table shows 📄 tag for paper trades
 * ════════════════════════════════════════════════════════════════
 */

const express     = require('express');
const crypto      = require('crypto');
const { exec }    = require('child_process');
const path        = require('path');

const config  = require('./config');
const db      = require('./lib/database');

// ─── Log Ring-Buffer ─────────────────────────────────────────
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

// ─── Cookie Auth ──────────────────────────────────────────────
const COOKIE_NAME = 'apex_session';
const COOKIE_TTL  = 8 * 60 * 60 * 1000;

function _signToken(payload) {
    const data = JSON.stringify(payload);
    const sig  = crypto.createHmac('sha256', config.DASHBOARD_SECRET).update(data).digest('hex');
    return Buffer.from(data).toString('base64url') + '.' + sig;
}
function _verifyToken(token) {
    try {
        const [dataPart, sig] = token.split('.');
        const data    = Buffer.from(dataPart, 'base64url').toString();
        const expected = crypto.createHmac('sha256', config.DASHBOARD_SECRET).update(data).digest('hex');
        if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
        const payload = JSON.parse(data);
        if (payload.exp < Date.now()) return null;
        return payload;
    } catch (_) { return null; }
}
function _parseCookies(h) {
    const out = {};
    if (!h) return out;
    h.split(';').forEach(p => { const [k,...v] = p.trim().split('='); out[k.trim()] = decodeURIComponent(v.join('=')); });
    return out;
}
function requireAuth(req, res, next) {
    const token = _parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token || !_verifyToken(token)) {
        return req.path.startsWith('/api/') ? res.status(401).json({ error: 'Unauthorized' }) : res.redirect('/dashboard/login');
    }
    next();
}

// ─── Bot State ────────────────────────────────────────────────
const _botState = { waConnected: false, startTime: Date.now(), lastUpdate: null, pendingUpdate: false };
function setBotConnected(c) { _botState.waConnected = c; }

// ─── GitHub Webhook ───────────────────────────────────────────
function _verifyGithubSig(req, body) {
    const secret = config.updater.WEBHOOK_SECRET;
    if (!secret) return true;
    const sig = req.headers['x-hub-signature-256'] || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch (_) { return false; }
}

// ─── Update Runner ────────────────────────────────────────────
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
            if (stderr) _pushLog('[UPDATER] stderr: ' + stderr.slice(0, 500));
            if (res) res.json({ ok: false, error: err.message, stderr: stderr.slice(0, 500) });
        } else {
            _pushLog('[UPDATER] ✅ Update complete. Bot restarting...');
            if (res) res.json({ ok: true, output: stdout.slice(0, 1000) });
        }
    });
}

// ════════════════════════════════════════════════════════════════
//  HTML HELPERS
// ════════════════════════════════════════════════════════════════
function _html(title, body) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Apex-MD</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--border:#30363d;--accent:#58a6ff;--green:#3fb950;--red:#f85149;--yellow:#d29922;--purple:#bc8cff;--orange:#ffa657;--text:#c9d1d9;--text2:#8b949e;--font:'Segoe UI',system-ui,sans-serif}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:var(--font);min-height:100vh}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.nav{background:var(--card);border-bottom:1px solid var(--border);padding:0 24px;display:flex;align-items:center;gap:24px;height:56px;position:sticky;top:0;z-index:100}
.nav .logo{font-weight:700;font-size:1.1rem;color:#fff;display:flex;align-items:center;gap:8px}
.nav-links{display:flex;gap:4px;margin-left:auto;align-items:center}
.nav-links a{padding:6px 14px;border-radius:6px;font-size:.88rem;color:var(--text2);transition:.15s}
.nav-links a:hover,.nav-links a.active{background:#21262d;color:var(--text);text-decoration:none}
.badge{background:var(--red);color:#fff;border-radius:99px;font-size:.7rem;padding:1px 6px;margin-left:4px;vertical-align:middle}
.mode-badge{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:99px;font-size:.75rem;font-weight:600;margin-left:8px}
.mode-badge.auto{background:#1a2a3a;color:var(--accent);border:1px solid #1e3a5f}
.mode-badge.pro{background:#2a1a3a;color:var(--purple);border:1px solid #4a2a6a}
.mode-badge.paper{background:#2a2a1a;color:var(--yellow);border:1px solid #4a3a10}
.wrap{max-width:1280px;margin:0 auto;padding:28px 20px}
h1{font-size:1.4rem;font-weight:600;margin-bottom:20px}
h2{font-size:1.05rem;font-weight:600;margin-bottom:14px;color:var(--text)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px;margin-bottom:28px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:20px;transition:.2s}
.card.pro-active{border-color:var(--purple)!important;box-shadow:0 0 0 1px #4a2a6a30}
.card.paper-active{border-color:var(--yellow)!important;box-shadow:0 0 0 1px #4a3a1030}
.card-label{font-size:.78rem;color:var(--text2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.card-val{font-size:1.65rem;font-weight:700}
.card-val.green{color:var(--green)}.card-val.red{color:var(--red)}.card-val.yellow{color:var(--yellow)}.card-val.blue{color:var(--accent)}.card-val.purple{color:var(--purple)}
.card-sub{font-size:.78rem;color:var(--text2);margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:.88rem}
th{text-align:left;padding:10px 12px;font-weight:600;color:var(--text2);border-bottom:1px solid var(--border)}
td{padding:10px 12px;border-bottom:1px solid #21262d}
tr:last-child td{border-bottom:none}tr:hover td{background:#1c2128}
.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:.75rem;font-weight:600}
.pill.long{background:#1a3a2a;color:var(--green)}.pill.short{background:#3a1a1a;color:var(--red)}
.pill.pending{background:#2a2a1a;color:var(--yellow)}.pill.active{background:#1a2a3a;color:var(--accent)}
.pill.paper{background:#2a2a12;color:var(--yellow)}.pill.on{background:#1a3a2a;color:var(--green)}.pill.off{background:#3a1a1a;color:var(--red)}
.log-box{background:#090d11;border:1px solid var(--border);border-radius:10px;height:380px;overflow-y:auto;padding:12px 14px;font-family:'Cascadia Code','Fira Code',monospace;font-size:.8rem;line-height:1.6}
.log-box .log-warn{color:var(--yellow)}.log-box .log-error{color:var(--red)}.log-box .log-info{color:var(--text2)}.log-box .log-bot{color:var(--green)}
.section{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:22px;margin-bottom:20px}
.section.pro-section{border-color:var(--purple)}
.section.paper-section{border-color:var(--yellow)}
.toggle-row{display:flex;align-items:center;justify-content:space-between;padding:13px 0;border-bottom:1px solid #21262d}
.toggle-row:last-child{border-bottom:none}
.toggle-info h3{font-size:.95rem;font-weight:500;margin-bottom:3px}
.toggle-info p{font-size:.8rem;color:var(--text2)}
.toggle{position:relative;width:46px;height:26px;flex-shrink:0}
.toggle input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;background:#30363d;border-radius:99px;cursor:pointer;transition:.25s}
.slider:before{content:'';position:absolute;width:20px;height:20px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.25s;box-shadow:0 1px 3px #0004}
input:checked+.slider{background:var(--green)}
input:checked+.slider:before{transform:translateX(20px)}
.toggle.pro-toggle input:checked+.slider{background:var(--purple)}
.toggle.paper-toggle input:checked+.slider{background:var(--yellow)}
.param-row{display:grid;grid-template-columns:1fr 150px;align-items:center;gap:16px;padding:11px 0;border-bottom:1px solid #21262d}
.param-row:last-child{border-bottom:none}
.param-row strong{font-size:.9rem}
.param-label{font-size:.78rem;color:var(--text2);margin-top:2px}
input[type=number]{background:#0d1117;border:1px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text);font-size:.9rem;width:100%;transition:.15s}
input[type=number]:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px #58a6ff18}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 18px;border-radius:7px;font-size:.88rem;font-weight:500;cursor:pointer;border:none;transition:.15s}
.btn-primary{background:var(--accent);color:#fff}.btn-primary:hover{background:#79b8ff}
.btn-danger{background:var(--red);color:#fff}.btn-danger:hover{opacity:.85}
.btn-success{background:var(--green);color:#fff}.btn-success:hover{opacity:.85}
.btn-ghost{background:#21262d;color:var(--text);border:1px solid var(--border)}.btn-ghost:hover{background:#30363d}
.btn-purple{background:#4a2a6a;color:#d8b4fe;border:1px solid #6a3a8a}.btn-purple:hover{background:#5a3a7a}
.update-out{background:#090d11;border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-family:monospace;font-size:.8rem;max-height:200px;overflow-y:auto;display:none;margin-top:12px;white-space:pre-wrap}
/* ── Pro Mode Advanced Panel ─────────────────────────────── */
.pro-master-card{border:2px solid var(--border);border-radius:12px;padding:22px;margin-bottom:22px;transition:.3s;background:var(--card)}
.pro-master-card.is-pro{border-color:var(--purple);background:#130d1f}
.pro-master-card.is-paper{border-color:var(--yellow);background:#131100}
.pro-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.pro-header-info h2{margin:0 0 4px;font-size:1.05rem}
.pro-header-info p{font-size:.82rem;color:var(--text2);max-width:480px;line-height:1.5}
.pro-mode-status{font-size:.75rem;font-weight:600;padding:3px 10px;border-radius:99px;margin-top:6px;display:inline-block}
.pro-mode-status.auto{background:#1a2a3a;color:var(--accent)}
.pro-mode-status.custom{background:#2a1a3a;color:var(--purple)}
.advanced-panel{overflow:hidden;max-height:0;opacity:0;transition:max-height .45s cubic-bezier(.4,0,.2,1), opacity .3s ease, margin .3s ease;margin-top:0}
.advanced-panel.open{max-height:700px;opacity:1;margin-top:20px}
.advanced-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.adv-section-title{font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text2);margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.adv-input-row{display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid #21262d}
.adv-input-row:last-child{border-bottom:none}
.adv-input-row .label{font-size:.88rem}.adv-input-row .sublabel{font-size:.75rem;color:var(--text2)}
.adv-input-row input[type=number]{width:110px}
.reset-defaults{font-size:.78rem;color:var(--text2);cursor:pointer;text-decoration:underline;background:none;border:none;padding:0;margin-top:8px;display:block}
.reset-defaults:hover{color:var(--text)}
/* Login */
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center}
.login-box{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:44px 40px;width:400px;box-shadow:0 8px 32px #00000040}
.login-box h1{font-size:1.5rem;margin-bottom:8px;text-align:center}
.login-box p{color:var(--text2);font-size:.88rem;text-align:center;margin-bottom:32px}
.field{margin-bottom:18px}label{display:block;font-size:.82rem;color:var(--text2);margin-bottom:6px}
input[type=password]{background:#0d1117;border:1px solid var(--border);border-radius:7px;padding:10px 14px;color:var(--text);font-size:.95rem;width:100%;transition:.15s}
input[type=password]:focus{outline:none;border-color:var(--accent)}
.err{color:var(--red);font-size:.82rem;margin-top:6px}.msg-ok{color:var(--green);font-size:.82rem;margin-top:6px}
.save-bar{position:sticky;bottom:0;background:var(--bg);border-top:1px solid var(--border);padding:12px 0;z-index:10;display:flex;align-items:center;gap:12px;opacity:0;transform:translateY(8px);transition:.2s}
.save-bar.visible{opacity:1;transform:translateY(0)}
@media(max-width:768px){.advanced-grid{grid-template-columns:1fr}.grid{grid-template-columns:1fr 1fr}.nav-links a span{display:none}}
@media(max-width:480px){.grid{grid-template-columns:1fr}.pro-header{flex-direction:column}}
</style>
</head>
<body>${body}</body>
</html>`;
}

function _nav(active, pendingUpdate) {
    const upBadge  = pendingUpdate ? '<span class="badge">!</span>' : '';
    const proMode  = config.modules.PRO_MODE;
    const paperMode = config.modules.PAPER_TRADING;
    const modeBadge = proMode
        ? '<span class="mode-badge pro">🔬 Pro Mode</span>'
        : '<span class="mode-badge auto">🤖 Auto AI</span>';
    const paperBadge = paperMode ? '<span class="mode-badge paper">📄 Paper</span>' : '';
    return `
<nav class="nav">
  <div class="logo"><span>📊</span> Apex-MD ${modeBadge}${paperBadge}</div>
  <div class="nav-links">
    <a href="/dashboard/"        class="${active==='home'?'active'    :''}">🏠 <span>Dashboard</span></a>
    <a href="/dashboard/settings" class="${active==='settings'?'active':''}">⚙️ <span>Settings</span></a>
    <a href="/dashboard/updater"  class="${active==='updater'?'active' :''}">🔄 <span>Updater</span>${upBadge}</a>
    <a href="/dashboard/logout" class="btn btn-ghost" style="font-size:.82rem;padding:5px 12px;margin-left:4px">Logout</a>
  </div>
</nav>`;
}

// ════════════════════════════════════════════════════════════════
//  ROUTER
// ════════════════════════════════════════════════════════════════
function initDashboard() {
    const app  = express();
    const port = config.DASHBOARD_PORT;

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // ── Login ────────────────────────────────────────────────
    app.get('/dashboard/login', (req, res) => {
        const errHtml = req.query.err ? '<p class="err">❌ Incorrect password</p>' : '';
        res.send(_html('Login', `
<div class="login-wrap">
  <div class="login-box">
    <h1>🔐 Apex-MD</h1>
    <p>Web Control Panel — Owner Access Only</p>
    <form method="POST" action="/dashboard/login">
      <div class="field"><label>Password</label>
        <input type="password" name="password" placeholder="Enter dashboard password" autofocus required>
      </div>
      ${errHtml}
      <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center;margin-top:4px">Sign In →</button>
    </form>
  </div>
</div>`));
    });

    app.post('/dashboard/login', (req, res) => {
        if ((req.body.password || '').trim() !== config.DASHBOARD_PASSWORD)
            return res.redirect('/dashboard/login?err=1');
        const token = _signToken({ exp: Date.now() + COOKIE_TTL, role: 'owner' });
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${COOKIE_TTL/1000}; SameSite=Strict`);
        res.redirect('/dashboard/');
    });

    app.get('/dashboard/logout', (req, res) => {
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`);
        res.redirect('/dashboard/login');
    });

    app.use('/dashboard', (req, res, next) => {
        if (req.path === '/login') return next();
        requireAuth(req, res, next);
    });

    // ── Dashboard Home ───────────────────────────────────────
    app.get('/dashboard/', async (req, res) => {
        let tradesHtml = '<tr><td colspan="8" style="text-align:center;color:var(--text2);padding:20px">No active trades</td></tr>';
        let tradeCount = 0, paperCount = 0;
        try {
            const trades = await db.Trade.find({ status: { $in: ['active', 'pending'] } }).lean();
            tradeCount   = trades.length;
            paperCount   = trades.filter(t => t.isPaper).length;
            if (trades.length > 0) {
                tradesHtml = trades.map(t => {
                    const dir    = t.direction === 'LONG' ? '<span class="pill long">LONG</span>' : '<span class="pill short">SHORT</span>';
                    const st     = t.status === 'pending' ? '<span class="pill pending">PENDING</span>' : '<span class="pill active">ACTIVE</span>';
                    const paper  = t.isPaper ? ' <span class="pill paper">📄 PAPER</span>' : '';
                    const hrs    = ((Date.now() - new Date(t.openTime)) / 3600000).toFixed(1);
                    return `<tr>
                        <td><strong>${t.coin}</strong>${paper}</td>
                        <td>${dir}</td>
                        <td>$${parseFloat(t.entry).toFixed(4)}</td>
                        <td>$${parseFloat(t.tp2 || t.tp).toFixed(4)}</td>
                        <td>$${parseFloat(t.sl).toFixed(4)}</td>
                        <td>${st}</td>
                        <td>${t.isPaper ? '📄' : '💰'}</td>
                        <td>${hrs}h</td>
                    </tr>`;
                }).join('');
            }
        } catch (_) {}

        const uptime    = Math.floor((Date.now() - _botState.startTime) / 60000);
        const uptimeStr = uptime >= 60 ? `${Math.floor(uptime/60)}h ${uptime%60}m` : `${uptime}m`;
        let scannerStatus = false;
        try { scannerStatus = require('./plugins/scanner').getScannerStatus(); } catch (_) {}

        const proMode   = config.modules.PRO_MODE;
        const paperMode = config.modules.PAPER_TRADING;

        res.send(_html('Dashboard', `
${_nav('home', _botState.pendingUpdate)}
<div class="wrap">
  <h1>📊 Live Dashboard</h1>
  <div class="grid">
    <div class="card"><div class="card-label">WhatsApp</div>
      <div class="card-val ${_botState.waConnected?'green':'red'}" id="wa-status">${_botState.waConnected?'🟢 Online':'🔴 Offline'}</div>
      <div class="card-sub">Connection</div></div>
    <div class="card"><div class="card-label">Scanner</div>
      <div class="card-val ${scannerStatus?'green':'yellow'}" id="scanner-status">${scannerStatus?'🟢 Active':'⚪ Standby'}</div>
      <div class="card-sub">Signal engine</div></div>
    <div class="card"><div class="card-label">Active Trades</div>
      <div class="card-val blue" id="trade-count">${tradeCount}</div>
      <div class="card-sub">Open positions</div></div>
    <div class="card"><div class="card-label">Uptime</div>
      <div class="card-val" id="uptime">${uptimeStr}</div>
      <div class="card-sub">Since last restart</div></div>
    <div class="card ${proMode?'pro-active':''}">
      <div class="card-label">Bot Mode</div>
      <div class="card-val ${proMode?'purple':'blue'}" id="bot-mode">${proMode?'🔬 Pro Custom':'🤖 Auto AI'}</div>
      <div class="card-sub" id="bot-mode-sub">${proMode?'RSI:'+config.proParams.RSI_PERIOD+' EMA:'+config.proParams.FAST_EMA+'/'+config.proParams.SLOW_EMA:'Dynamic weights + auto sizing'}</div></div>
    <div class="card ${paperMode?'paper-active':''}">
      <div class="card-label">Paper Trades</div>
      <div class="card-val ${paperMode?'yellow':'green'}" id="paper-count">${paperCount}</div>
      <div class="card-sub">${paperMode?'📄 Paper Mode ON':'💰 Live mode'}</div></div>
  </div>

  <div class="section">
    <h2>📋 Active Trades</h2>
    <div style="overflow-x:auto">
    <table>
      <thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP2</th><th>SL</th><th>Status</th><th>Type</th><th>Open</th></tr></thead>
      <tbody id="trades-body">${tradesHtml}</tbody>
    </table>
    </div>
  </div>

  <div class="section">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <h2 style="margin:0">🖥️ Live Logs</h2>
      <button class="btn btn-ghost" onclick="clearLogs()" style="font-size:.8rem;padding:5px 10px">🗑️ Clear</button>
    </div>
    <div class="log-box" id="log-box"><div class="log-info">Connecting to log stream...</div></div>
  </div>
</div>
<script>
const lb = document.getElementById('log-box');
const es = new EventSource('/dashboard/api/logs/stream');
let autoScroll = true;
lb.addEventListener('scroll', () => { autoScroll = lb.scrollTop + lb.clientHeight >= lb.scrollHeight - 40; });
es.onmessage = e => {
  const d = JSON.parse(e.data);
  const el = document.createElement('div');
  const msg = d.msg || '';
  el.className = 'log-' + (msg.includes('[ERROR]')?'error':msg.includes('[WARN]')?'warn':msg.includes('[BOT]')?'bot':'info');
  el.textContent = new Date(d.ts).toLocaleTimeString() + '  ' + msg;
  lb.appendChild(el);
  if (autoScroll) lb.scrollTop = lb.scrollHeight;
};
es.onerror = () => { const el=document.createElement('div');el.className='log-warn';el.textContent='[Stream disconnected]';lb.appendChild(el); };
function clearLogs() { lb.innerHTML=''; }
setInterval(async () => {
  try {
    const r = await fetch('/dashboard/api/status');
    const d = await r.json();
    document.getElementById('wa-status').textContent  = d.waConnected?'🟢 Online':'🔴 Offline';
    document.getElementById('wa-status').className    = 'card-val '+(d.waConnected?'green':'red');
    document.getElementById('scanner-status').textContent = d.scannerActive?'🟢 Active':'⚪ Standby';
    document.getElementById('trade-count').textContent = d.tradeCount;
    document.getElementById('uptime').textContent      = d.uptime;
    document.getElementById('bot-mode').textContent    = d.proMode?'🔬 Pro Custom':'🤖 Auto AI';
    document.getElementById('bot-mode').className      = 'card-val '+(d.proMode?'purple':'blue');
  } catch(_) {}
}, 10000);
</script>`));
    });

    // ── Settings Page ────────────────────────────────────────
    app.get('/dashboard/settings', (req, res) => {
        const m  = config.modules;
        const t  = config.trading;
        const pp = config.proParams;
        const proOn   = m.PRO_MODE;
        const paperOn = m.PAPER_TRADING;

        const modToggle = (id, label, desc, checked, cls='') => `
<div class="toggle-row">
  <div class="toggle-info"><h3>${label}</h3><p>${desc}</p></div>
  <label class="toggle ${cls}">
    <input type="checkbox" id="mod-${id}" ${checked?'checked':''} onchange="toggleMod('${id}',this.checked)">
    <span class="slider"></span>
  </label>
</div>`;

        const paramRow = (key, label, hint, val, min, max, step) => `
<div class="param-row">
  <div><strong>${label}</strong><div class="param-label">${hint}</div></div>
  <input type="number" id="param-${key}" value="${val}" min="${min}" max="${max}" step="${step}" onchange="setParam('${key}',this.value)">
</div>`;

        const proParamRow = (key, label, hint, val, min, max, step) => `
<div class="adv-input-row">
  <div><div class="label">${label}</div><div class="sublabel">${hint}</div></div>
  <input type="number" id="pro-${key}" value="${val}" min="${min}" max="${max}" step="${step}" onchange="setProParam('${key}',this.value)">
</div>`;

        res.send(_html('Settings', `
${_nav('settings', _botState.pendingUpdate)}
<div class="wrap">
<h1>⚙️ Settings</h1>

<!-- ══ MASTER PRO MODE CARD ══════════════════════════════════ -->
<div class="pro-master-card ${proOn?'is-pro':''}" id="pro-master-card">
  <div class="pro-header">
    <div class="pro-header-info">
      <h2>🔬 Master Pro Mode</h2>
      <p>Switch the bot between fully-automatic AI mode and manual parameter control.
         In <strong>Auto AI Mode</strong> all weights, periods and position sizing are calculated dynamically.
         In <strong>Pro Custom Mode</strong> you override every indicator period, ADX threshold,
         and trade execution parameter below.</p>
      <span class="pro-mode-status ${proOn?'custom':'auto'}" id="pro-status-badge">
        ${proOn?'🔬 PRO CUSTOM MODE ACTIVE':'🤖 AUTO AI MODE (Default)'}
      </span>
    </div>
    <label class="toggle pro-toggle" style="transform:scale(1.3);transform-origin:right center;margin-top:4px">
      <input type="checkbox" id="pro-mode-toggle" ${proOn?'checked':''} onchange="toggleProMode(this.checked)">
      <span class="slider"></span>
    </label>
  </div>

  <!-- Advanced Tuning Panel — hidden when Auto AI, expands in Pro Mode -->
  <div class="advanced-panel ${proOn?'open':''}" id="advanced-panel">
    <div class="advanced-grid">
      <!-- Left: Indicator Parameters -->
      <div>
        <div class="adv-section-title">📐 Indicator Parameters</div>
        ${proParamRow('RSI_PERIOD',   'RSI Period',      'Default: 14 (classic). Range: 7–21',          pp.RSI_PERIOD,   7,   30,  1)}
        ${proParamRow('FAST_EMA',     'Fast EMA Length', 'Default: 50. Used for pullback detection',     pp.FAST_EMA,     5,   100, 1)}
        ${proParamRow('SLOW_EMA',     'Slow EMA Length', 'Default: 200. Used for main trend bias',       pp.SLOW_EMA,     50,  500, 10)}
        ${proParamRow('ADX_CHOPPY',   'ADX Choppy ↓',   'Below this = choppy regime (default: 20)',     pp.ADX_CHOPPY,   10,  40,  1)}
        ${proParamRow('ADX_TRENDING', 'ADX Trending ↑', 'Above this = trending regime (default: 25)',   pp.ADX_TRENDING, 15,  50,  1)}
        <button class="reset-defaults" onclick="resetProDefaults()">↩ Reset to defaults</button>
      </div>
      <!-- Right: Manual Trade Execution -->
      <div>
        <div class="adv-section-title">💼 Manual Trade Execution</div>
        ${proParamRow('MANUAL_MARGIN',   'Manual Margin (USDT)',
          'Set > 0 to use fixed USDT amount instead of wallet auto-sizing. 0 = auto 2% risk.',
          pp.MANUAL_MARGIN, 0, 100000, 10)}
        ${proParamRow('MANUAL_LEVERAGE', 'Manual Leverage (x)',
          'Override the auto-calculated leverage. Only applies when Pro Mode is ON.',
          pp.MANUAL_LEVERAGE, 1, 125, 1)}
        <p style="font-size:.78rem;color:var(--text2);margin-top:14px;line-height:1.6">
          💡 <strong>Tip:</strong> Set Manual Margin to <code>0</code> to keep the 2% wallet risk formula
          while still using custom indicator periods.</p>
        <p style="font-size:.78rem;color:var(--orange);margin-top:8px">
          ⚠️ Always test your custom params with <strong>Paper Trading ON</strong> before going live.</p>
      </div>
    </div>
  </div>
</div>

<!-- ══ PAPER TRADING CARD ════════════════════════════════════ -->
<div class="pro-master-card ${paperOn?'is-paper':''}" id="paper-master-card" style="margin-bottom:22px">
  <div class="pro-header">
    <div class="pro-header-info">
      <h2>📄 Paper Trading Mode</h2>
      <p>When enabled, every <code>.future</code> signal is automatically saved as a paper trade —
         no real Binance orders are placed. All signals are tracked in the database so you can measure
         win rate, PnL and test your Pro Mode configurations safely.</p>
      <span class="pro-mode-status ${paperOn?'custom':'auto'}" id="paper-status-badge"
            style="${paperOn?'background:#2a2a1a;color:var(--yellow)':''}">
        ${paperOn?'📄 PAPER TRADING ACTIVE — No real orders':'💰 LIVE TRADING MODE (Default)'}
      </span>
    </div>
    <label class="toggle paper-toggle" style="transform:scale(1.3);transform-origin:right center;margin-top:4px">
      <input type="checkbox" id="paper-mode-toggle" ${paperOn?'checked':''} onchange="togglePaperMode(this.checked)">
      <span class="slider"></span>
    </label>
  </div>
</div>

<!-- ══ STANDARD SETTINGS ════════════════════════════════════ -->
<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
  <div>
    <div class="section">
      <h2>🧩 Module Toggles</h2>
      <p style="font-size:.82rem;color:var(--text2);margin-bottom:16px">Changes apply immediately — no restart needed.</p>
      ${modToggle('AI_MODEL',        '🤖 AI Model',         'Local Python LSTM prediction server (port 5000)', m.AI_MODEL)}
      ${modToggle('BYBIT',           '🐳 Bybit Layer',      'Cross-exchange OB + volume validation',           m.BYBIT)}
      ${modToggle('DYNAMIC_WEIGHTS', '🧠 Dynamic Weights',  'ADX/ATR-based score multipliers',                 m.DYNAMIC_WEIGHTS)}
      ${modToggle('SMC',             '🔮 SMC Scoring',      'ChoCH, Sweep, OB, Wyckoff, BOS, Breakers',        m.SMC)}
    </div>
  </div>
  <div>
    <div class="section">
      <h2>📊 Trading Parameters</h2>
      <p style="font-size:.82rem;color:var(--text2);margin-bottom:16px">Saved to database for persistence.</p>
      ${paramRow('DEFAULT_RISK_PCT',    'Risk % per trade',  'Wallet % to risk (2% = standard)', t.DEFAULT_RISK_PCT,    0.5, 10,  0.5)}
      ${paramRow('MAX_OPEN_TRADES',     'Max open trades',   'Concurrent positions limit',        t.MAX_OPEN_TRADES,     1,   20,  1)}
      ${paramRow('MIN_SCORE_THRESHOLD', 'Min signal score',  'Gate for signal quality (0-100)',   t.MIN_SCORE_THRESHOLD, 5,   80,  1)}
      ${paramRow('DEFAULT_LEVERAGE',    'Default leverage',  'Fallback when auto-calc disabled',  t.DEFAULT_LEVERAGE,    1,   125, 1)}
    </div>
  </div>
</div>

<div id="save-bar" class="save-bar">
  <span id="save-msg" style="font-size:.88rem"></span>
</div>
</div>

<script>
// ── Pro Mode toggle ──────────────────────────────────────────
async function toggleProMode(val) {
  const r = await fetch('/dashboard/api/promode', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ enabled: val })
  });
  const d = await r.json();
  if (d.ok) {
    const card   = document.getElementById('pro-master-card');
    const badge  = document.getElementById('pro-status-badge');
    const panel  = document.getElementById('advanced-panel');
    card.classList.toggle('is-pro', val);
    badge.textContent = val ? '🔬 PRO CUSTOM MODE ACTIVE' : '🤖 AUTO AI MODE (Default)';
    badge.className   = 'pro-mode-status ' + (val ? 'custom' : 'auto');
    panel.classList.toggle('open', val);
    showSaveMsg('✅ ' + (val ? 'Pro Custom Mode ON 🔬' : 'Auto AI Mode ON 🤖'), true);
  } else {
    showSaveMsg('❌ ' + d.error, false);
    document.getElementById('pro-mode-toggle').checked = !val;
  }
}

// ── Paper Trading toggle ─────────────────────────────────────
async function togglePaperMode(val) {
  const r = await fetch('/dashboard/api/papertrading', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ enabled: val })
  });
  const d = await r.json();
  if (d.ok) {
    const card  = document.getElementById('paper-master-card');
    const badge = document.getElementById('paper-status-badge');
    card.classList.toggle('is-paper', val);
    badge.textContent = val ? '📄 PAPER TRADING ACTIVE — No real orders' : '💰 LIVE TRADING MODE (Default)';
    badge.style.background = val ? '#2a2a1a' : '';
    badge.style.color      = val ? 'var(--yellow)' : '';
    showSaveMsg('✅ ' + (val ? 'Paper Trading ON 📄 — signals will auto-log' : 'Live Trading ON 💰'), true);
  } else {
    showSaveMsg('❌ ' + d.error, false);
    document.getElementById('paper-mode-toggle').checked = !val;
  }
}

// ── Module toggle ────────────────────────────────────────────
async function toggleMod(id, val) {
  const r = await fetch('/dashboard/api/modules/' + id, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ enabled: val })
  });
  const d = await r.json();
  showSaveMsg(d.ok ? '✅ ' + id + ' → ' + (val?'ON':'OFF') : '❌ ' + d.error, d.ok);
}

// ── Trading param ────────────────────────────────────────────
async function setParam(key, val) {
  const r = await fetch('/dashboard/api/params/' + key, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ value: parseFloat(val) })
  });
  const d = await r.json();
  showSaveMsg(d.ok ? '✅ ' + key + ' → ' + val : '❌ ' + d.error, d.ok);
}

// ── Pro param ────────────────────────────────────────────────
async function setProParam(key, val) {
  const r = await fetch('/dashboard/api/proparams/' + key, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ value: parseFloat(val) })
  });
  const d = await r.json();
  showSaveMsg(d.ok ? '🔬 ' + key + ' → ' + val : '❌ ' + d.error, d.ok);
}

// ── Reset Pro defaults ───────────────────────────────────────
async function resetProDefaults() {
  const defaults = { RSI_PERIOD:14, FAST_EMA:50, SLOW_EMA:200, ADX_CHOPPY:20, ADX_TRENDING:25, MANUAL_MARGIN:0, MANUAL_LEVERAGE:10 };
  for (const [k,v] of Object.entries(defaults)) {
    const el = document.getElementById('pro-' + k);
    if (el) el.value = v;
    await setProParam(k, v);
  }
  showSaveMsg('↩ Pro params reset to defaults', true);
}

// ── Save message bar ─────────────────────────────────────────
function showSaveMsg(msg, ok) {
  const bar = document.getElementById('save-bar');
  const txt = document.getElementById('save-msg');
  txt.textContent = msg;
  txt.style.color = ok ? 'var(--green)' : 'var(--red)';
  bar.classList.add('visible');
  clearTimeout(window._saveTimer);
  window._saveTimer = setTimeout(() => bar.classList.remove('visible'), 3500);
}
</script>`));
    });

    // ── Auto Updater Page ────────────────────────────────────
    app.get('/dashboard/updater', (req, res) => {
        const enabled = config.updater.ENABLED;
        const pending = _botState.pendingUpdate;
        res.send(_html('Auto Updater', `
${_nav('updater', pending)}
<div class="wrap">
  <h1>🔄 Auto Updater</h1>
  ${pending?'<div class="section" style="border-color:var(--yellow)"><p style="color:var(--yellow)">⚠️ <strong>New update available on GitHub</strong> — auto-update is OFF. Click "Pull Update" to apply manually.</p></div>':''}
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
    <div class="section">
      <h2>🔧 Update Controls</h2>
      <div class="toggle-row">
        <div class="toggle-info"><h3>Auto-Update</h3><p>Automatically apply updates on GitHub push events</p></div>
        <label class="toggle">
          <input type="checkbox" id="auto-toggle" ${enabled?'checked':''} onchange="setAutoUpdate(this.checked)">
          <span class="slider"></span>
        </label>
      </div>
      <div style="margin-top:20px;display:flex;flex-direction:column;gap:12px">
        <button class="btn btn-primary" onclick="runUpdate()">🔄 Pull Update Now</button>
        <p style="font-size:.8rem;color:var(--text2)">Runs: <code>git pull && npm install && pm2 restart ${config.updater.PM2_APP_NAME}</code></p>
        ${config.updater.WEBHOOK_SECRET?'<p style="font-size:.8rem;color:var(--green)">✅ GitHub webhook secret configured</p>':'<p style="font-size:.8rem;color:var(--yellow)">⚠️ No webhook secret — set GITHUB_WEBHOOK_SECRET in config.env</p>'}
      </div>
      <div class="update-out" id="update-out"></div>
      <div id="update-msg" style="margin-top:8px;font-size:.88rem"></div>
    </div>
    <div class="section">
      <h2>📋 Update Info</h2>
      <p style="font-size:.88rem;margin-bottom:12px;color:var(--text2)">Last update: ${_botState.lastUpdate||'Never'}</p>
      <p style="font-size:.88rem;margin-bottom:12px;color:var(--text2)">GitHub Webhook URL:</p>
      <code style="background:#090d11;padding:8px 12px;border-radius:6px;display:block;font-size:.82rem;word-break:break-all">http://YOUR_VPS_IP:${port}/dashboard/webhook/update</code>
      <p style="font-size:.8rem;color:var(--text2);margin-top:8px">Add this as a Webhook in your GitHub repo → Settings → Webhooks. Content-Type: application/json.</p>
    </div>
  </div>
</div>
<script>
async function setAutoUpdate(val) {
  const r = await fetch('/dashboard/api/autoupdate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:val})});
  const d = await r.json();
  document.getElementById('update-msg').textContent = d.ok?'✅ Auto-update '+(val?'enabled':'disabled'):'❌ '+d.error;
  document.getElementById('update-msg').className = d.ok?'msg-ok':'err';
}
async function runUpdate() {
  document.getElementById('update-msg').textContent='🔄 Starting update... this may take 60s...';
  const out=document.getElementById('update-out');
  out.style.display='block';out.textContent='Running...';
  try {
    const r=await fetch('/dashboard/api/update',{method:'POST'});
    const d=await r.json();
    out.textContent=d.ok?(d.output||'Done.'):('Error: '+d.error+'\\n'+(d.stderr||''));
    document.getElementById('update-msg').textContent=d.ok?'✅ Update complete — bot restarting':'❌ Update failed';
    document.getElementById('update-msg').className=d.ok?'msg-ok':'err';
  } catch(e){out.textContent='Network error: '+e.message;}
}
</script>`));
    });

    // ════════════════════════════════════════════════════════
    //  REST API
    // ════════════════════════════════════════════════════════

    // Status
    app.get('/dashboard/api/status', requireAuth, async (req, res) => {
        let scannerActive = false, tradeCount = 0;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        try { tradeCount = await db.Trade.countDocuments({ status: { $in: ['active','pending'] } }); } catch (_) {}
        const uptime = Math.floor((Date.now() - _botState.startTime) / 60000);
        res.json({
            waConnected: _botState.waConnected, scannerActive, tradeCount,
            uptime: uptime >= 60 ? `${Math.floor(uptime/60)}h ${uptime%60}m` : `${uptime}m`,
            modules: config.modules, trading: config.trading,
            proMode: config.modules.PRO_MODE, paperTrading: config.modules.PAPER_TRADING,
        });
    });

    // SSE log stream
    app.get('/dashboard/api/logs/stream', requireAuth, (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        _logBuffer.slice(-50).forEach(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
        _sseClients.add(res);
        req.on('close', () => _sseClients.delete(res));
    });

    // Module toggles (existing: AI_MODEL, BYBIT, DYNAMIC_WEIGHTS, SMC)
    app.post('/dashboard/api/modules/:name', requireAuth, async (req, res) => {
        try {
            const name    = req.params.name.toUpperCase();
            const enabled = Boolean(req.body.enabled);
            config.toggleModule(name, enabled);
            const dbKey = { AI_MODEL:'aiModel', BYBIT:'bybit', DYNAMIC_WEIGHTS:'dynamicWeights', SMC:'smcEnabled' }[name];
            if (dbKey) await db.updateSettings({ [dbKey]: enabled }).catch(() => {});
            res.json({ ok: true, module: name, enabled });
        } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    // ── NEW: Pro Mode toggle ──────────────────────────────────
    app.post('/dashboard/api/promode', requireAuth, async (req, res) => {
        try {
            const enabled = Boolean(req.body.enabled);
            config.setProMode(enabled);
            await db.updateSettings({ proMode: enabled }).catch(() => {});
            console.log(`[Dashboard] Pro Mode → ${enabled ? 'ON 🔬' : 'OFF 🤖'}`);
            res.json({ ok: true, proMode: enabled, proParams: { ...config.proParams } });
        } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    // ── NEW: Paper Trading toggle ─────────────────────────────
    app.post('/dashboard/api/papertrading', requireAuth, async (req, res) => {
        try {
            const enabled = Boolean(req.body.enabled);
            config.setPaperTrading(enabled);
            await db.updateSettings({ paperTrading: enabled }).catch(() => {});
            console.log(`[Dashboard] Paper Trading → ${enabled ? 'ON 📄' : 'OFF 💰'}`);
            res.json({ ok: true, paperTrading: enabled });
        } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    // ── NEW: Pro Mode indicator/execution params ──────────────
    app.post('/dashboard/api/proparams/:key', requireAuth, async (req, res) => {
        try {
            const key = req.params.key.toUpperCase();
            const val = parseFloat(req.body.value);
            if (isNaN(val)) throw new Error('Invalid number');
            config.setProParam(key, val);
            res.json({ ok: true, key, value: val });
        } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    // Trading params
    app.post('/dashboard/api/params/:key', requireAuth, async (req, res) => {
        try {
            const key = req.params.key;
            const val = parseFloat(req.body.value);
            if (isNaN(val)) throw new Error('Invalid number');
            config.setTradingParam(key, val);
            const dbMap = { DEFAULT_RISK_PCT:'defaultRisk', MIN_SCORE_THRESHOLD:'minScore', MAX_OPEN_TRADES:'maxTrades' };
            if (dbMap[key]) await db.updateSettings({ [dbMap[key]]: val }).catch(() => {});
            res.json({ ok: true, key, value: val });
        } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    // Auto update toggle
    app.post('/dashboard/api/autoupdate', requireAuth, (req, res) => {
        config.setAutoUpdate(Boolean(req.body.enabled));
        res.json({ ok: true, enabled: config.updater.ENABLED });
    });

    // Manual update trigger
    app.post('/dashboard/api/update', requireAuth, (req, res) => { runUpdate(res); });

    // Config snapshot
    app.get('/dashboard/api/config', requireAuth, (req, res) => res.json(config.getSnapshot()));

    // Trades API
    app.get('/dashboard/api/trades', requireAuth, async (req, res) => {
        try {
            const trades = await db.Trade.find({ status: { $in: ['active','pending'] } }).lean();
            res.json({ ok: true, trades });
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    // GitHub Webhook
    app.post('/dashboard/webhook/update', express.raw({ type: 'application/json' }), (req, res) => {
        if (!_verifyGithubSig(req, req.body)) return res.status(401).json({ error: 'Invalid signature' });
        res.json({ ok: true, message: 'Webhook received' });
        if (config.updater.ENABLED) {
            _pushLog('[WEBHOOK] 📦 GitHub push received — running auto-update...');
            runUpdate(null);
        } else {
            _botState.pendingUpdate = true;
            _pushLog('[WEBHOOK] ⚠️ GitHub push received — auto-update OFF. Manual update available in dashboard.');
        }
    });

    app.get('/dashboard', (req, res) => res.redirect('/dashboard/'));

    app.listen(port, () => {
        console.log(`\n🌐 [Dashboard] Running at http://localhost:${port}/dashboard/`);
        console.log(`🔐 [Dashboard] Password: ${config.DASHBOARD_PASSWORD}`);
        console.log(`🤖 [Dashboard] Mode: ${config.modules.PRO_MODE ? '🔬 Pro Custom' : '🤖 Auto AI'} | Paper: ${config.modules.PAPER_TRADING ? '📄 ON' : '💰 OFF'}`);
    });

    return { setBotConnected, log };
}

module.exports = { initDashboard, log, setBotConnected };
