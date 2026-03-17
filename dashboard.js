'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD v7 PRO VVIP  ·  dashboard.js
 *  ──────────────────────────────────────────────────────────────
 *  SaaS-grade Web Control Panel — zero extra npm dependencies.
 *  Uses only packages already in package.json:
 *    express, axios, crypto (Node built-in), child_process (built-in)
 *
 *  Features:
 *    • Password-protected login (HMAC-signed cookie, no express-session)
 *    • Live bot status cards (WS connection, scanner, trade count)
 *    • Active trades table (reads from MongoDB via db module)
 *    • Real-time log stream (Server-Sent Events)
 *    • Settings page — module toggles + trading params updated live
 *    • Auto-Updater — git pull + npm install + pm2 restart
 *    • GitHub webhook endpoint for push-triggered auto-updates
 *    • Update notification badge when auto-update is disabled
 *
 *  Usage (in index.js):
 *    const { initDashboard, log } = require('./dashboard');
 *    initDashboard();  // call ONCE after express app is set up
 *    log('Bot started');
 * ════════════════════════════════════════════════════════════════
 */

const express     = require('express');
const crypto      = require('crypto');
const { exec }    = require('child_process');
const path        = require('path');

const config  = require('./config');
const db      = require('./lib/database');

// ─── Log Ring-Buffer (last 500 lines) ────────────────────────
const LOG_BUFFER_SIZE = 500;
const _logBuffer      = [];
const _sseClients     = new Set();

function _pushLog(line) {
    const entry = { ts: Date.now(), msg: String(line) };
    _logBuffer.push(entry);
    if (_logBuffer.length > LOG_BUFFER_SIZE) _logBuffer.shift();
    // Push to all connected SSE clients
    for (const client of _sseClients) {
        try { client.write(`data: ${JSON.stringify(entry)}\n\n`); } catch (_) {}
    }
}

// ─── Console interception ─────────────────────────────────────
const _origLog   = console.log.bind(console);
const _origWarn  = console.warn.bind(console);
const _origError = console.error.bind(console);

console.log   = (...a) => { _origLog(...a);   _pushLog('[LOG] '   + a.join(' ')); };
console.warn  = (...a) => { _origWarn(...a);  _pushLog('[WARN] '  + a.join(' ')); };
console.error = (...a) => { _origError(...a); _pushLog('[ERROR] ' + a.join(' ')); };

/**
 * External log helper — call this from index.js / scanner.js for
 * structured dashboard entries.
 */
function log(msg) { _pushLog('[BOT] ' + msg); }

// ─── Cookie Auth (no express-session needed) ──────────────────
const COOKIE_NAME = 'apex_session';
const COOKIE_TTL  = 8 * 60 * 60 * 1000; // 8 hours

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

function _parseCookies(cookieHeader) {
    const out = {};
    if (!cookieHeader) return out;
    cookieHeader.split(';').forEach(part => {
        const [k, ...v] = part.trim().split('=');
        out[k.trim()] = decodeURIComponent(v.join('='));
    });
    return out;
}

function requireAuth(req, res, next) {
    const cookies = _parseCookies(req.headers.cookie);
    const token   = cookies[COOKIE_NAME];
    if (!token || !_verifyToken(token)) {
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        return res.redirect('/dashboard/login');
    }
    next();
}

// ─── Bot State (shared reference) ────────────────────────────
const _botState = {
    waConnected:  false,
    startTime:    Date.now(),
    lastUpdate:   null,        // set by auto-updater
    pendingUpdate: false,      // GitHub pushed while auto-update is off
};

function setBotConnected(connected) { _botState.waConnected = connected; }

// ─── GitHub webhook signature check ──────────────────────────
function _verifyGithubSig(req, body) {
    const secret = config.updater.WEBHOOK_SECRET;
    if (!secret) return true; // no secret = accept all (use with caution)
    const sig = req.headers['x-hub-signature-256'] || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch (_) { return false; }
}

// ─── Update Runner ────────────────────────────────────────────
let _updateInProgress = false;

function runUpdate(res) {
    if (_updateInProgress) {
        if (res) res.json({ ok: false, error: 'Update already in progress' });
        return;
    }
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
            _pushLog('[UPDATER] stdout: ' + stdout.slice(0, 500));
            if (res) res.json({ ok: true, output: stdout.slice(0, 1000) });
        }
    });
}

// ════════════════════════════════════════════════════════════════
//  EMBEDDED HTML (single-file SPA — no separate template files)
// ════════════════════════════════════════════════════════════════
function _html(title, body) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Apex-MD Dashboard</title>
<style>
  :root{--bg:#0d1117;--card:#161b22;--border:#30363d;--accent:#58a6ff;--green:#3fb950;--red:#f85149;--yellow:#d29922;--text:#c9d1d9;--text2:#8b949e;--font:'Segoe UI',system-ui,sans-serif}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);color:var(--text);font-family:var(--font);min-height:100vh}
  a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
  .nav{background:var(--card);border-bottom:1px solid var(--border);padding:0 24px;display:flex;align-items:center;gap:24px;height:56px;position:sticky;top:0;z-index:100}
  .nav .logo{font-weight:700;font-size:1.1rem;color:#fff;display:flex;align-items:center;gap:8px}
  .nav .logo span{font-size:1.3rem}
  .nav-links{display:flex;gap:4px;margin-left:auto}
  .nav-links a{padding:6px 14px;border-radius:6px;font-size:.88rem;color:var(--text2);transition:.15s}
  .nav-links a:hover,.nav-links a.active{background:#21262d;color:var(--text);text-decoration:none}
  .badge{background:var(--red);color:#fff;border-radius:99px;font-size:.7rem;padding:1px 6px;margin-left:4px;vertical-align:middle}
  .wrap{max-width:1200px;margin:0 auto;padding:28px 20px}
  h1{font-size:1.4rem;font-weight:600;margin-bottom:20px}
  h2{font-size:1.05rem;font-weight:600;margin-bottom:12px;color:var(--text)}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:28px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:20px}
  .card-label{font-size:.78rem;color:var(--text2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
  .card-val{font-size:1.65rem;font-weight:700}
  .card-val.green{color:var(--green)}.card-val.red{color:var(--red)}.card-val.yellow{color:var(--yellow)}.card-val.blue{color:var(--accent)}
  .card-sub{font-size:.78rem;color:var(--text2);margin-top:4px}
  table{width:100%;border-collapse:collapse;font-size:.88rem}
  th{text-align:left;padding:10px 12px;font-weight:600;color:var(--text2);border-bottom:1px solid var(--border)}
  td{padding:10px 12px;border-bottom:1px solid #21262d}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#1c2128}
  .pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:.75rem;font-weight:600}
  .pill.long{background:#1a3a2a;color:var(--green)}.pill.short{background:#3a1a1a;color:var(--red)}.pill.pending{background:#2a2a1a;color:var(--yellow)}
  .pill.active{background:#1a2a3a;color:var(--accent)}.pill.on{background:#1a3a2a;color:var(--green)}.pill.off{background:#3a1a1a;color:var(--red)}
  .log-box{background:#090d11;border:1px solid var(--border);border-radius:10px;height:380px;overflow-y:auto;padding:12px 14px;font-family:'Cascadia Code','Fira Code',monospace;font-size:.8rem;line-height:1.6}
  .log-box .log-warn{color:var(--yellow)}.log-box .log-error{color:var(--red)}.log-box .log-info{color:var(--text2)}.log-box .log-bot{color:var(--green)}
  .section{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:20px}
  .toggle-row{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid #21262d}
  .toggle-row:last-child{border-bottom:none}
  .toggle-info h3{font-size:.95rem;font-weight:500;margin-bottom:2px}
  .toggle-info p{font-size:.8rem;color:var(--text2)}
  .toggle{position:relative;width:44px;height:24px;flex-shrink:0}
  .toggle input{opacity:0;width:0;height:0}
  .slider{position:absolute;inset:0;background:#333;border-radius:99px;cursor:pointer;transition:.25s}
  .slider:before{content:'';position:absolute;width:18px;height:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.25s}
  input:checked+.slider{background:var(--green)}
  input:checked+.slider:before{transform:translateX(20px)}
  .param-row{display:grid;grid-template-columns:1fr 160px;align-items:center;gap:16px;padding:12px 0;border-bottom:1px solid #21262d}
  .param-row:last-child{border-bottom:none}
  input[type=number]{background:#0d1117;border:1px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text);font-size:.9rem;width:100%}
  input[type=number]:focus{outline:none;border-color:var(--accent)}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:8px 18px;border-radius:7px;font-size:.88rem;font-weight:500;cursor:pointer;border:none;transition:.15s}
  .btn-primary{background:var(--accent);color:#fff}.btn-primary:hover{background:#79b8ff}
  .btn-danger{background:var(--red);color:#fff}.btn-danger:hover{background:#ff6b6b}
  .btn-success{background:var(--green);color:#fff}.btn-success:hover{background:#56d364}
  .btn-ghost{background:#21262d;color:var(--text);border:1px solid var(--border)}.btn-ghost:hover{background:#30363d}
  .update-out{background:#090d11;border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-family:monospace;font-size:.8rem;max-height:200px;overflow-y:auto;display:none;margin-top:12px;white-space:pre-wrap}
  .login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg)}
  .login-box{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:40px 36px;width:380px}
  .login-box h1{font-size:1.4rem;margin-bottom:6px;text-align:center}
  .login-box p{color:var(--text2);font-size:.88rem;text-align:center;margin-bottom:28px}
  .field{margin-bottom:16px}label{display:block;font-size:.82rem;color:var(--text2);margin-bottom:6px}
  input[type=password]{background:#0d1117;border:1px solid var(--border);border-radius:7px;padding:10px 12px;color:var(--text);font-size:.95rem;width:100%}
  input[type=password]:focus{outline:none;border-color:var(--accent)}
  .err{color:var(--red);font-size:.82rem;margin-top:4px}.msg-ok{color:var(--green);font-size:.82rem;margin-top:4px}
  @media(max-width:640px){.grid{grid-template-columns:1fr 1fr}.nav-links a span{display:none}}
</style>
</head>
<body>${body}</body>
</html>`;
}

function _nav(active, pendingUpdate) {
    const upBadge = pendingUpdate ? '<span class="badge">!</span>' : '';
    return `
<nav class="nav">
  <div class="logo"><span>📊</span> Apex-MD</div>
  <div class="nav-links">
    <a href="/dashboard/" class="${active==='home'?'active':''}">🏠 <span>Dashboard</span></a>
    <a href="/dashboard/settings" class="${active==='settings'?'active':''}">⚙️ <span>Settings</span></a>
    <a href="/dashboard/updater" class="${active==='updater'?'active':''}">🔄 <span>Updater</span>${upBadge}</a>
    <a href="/dashboard/logout" class="btn-ghost btn" style="font-size:.82rem;padding:5px 12px">Logout</a>
  </div>
</nav>`;
}

// ════════════════════════════════════════════════════════════════
//  ROUTER
// ════════════════════════════════════════════════════════════════
function initDashboard() {
    const app = express();
    const port = config.DASHBOARD_PORT;

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // ── Login ──────────────────────────────────────────────────
    app.get('/dashboard/login', (req, res) => {
        const err = req.query.err ? '<p class="err">❌ Incorrect password</p>' : '';
        res.send(_html('Login', `
<div class="login-wrap">
  <div class="login-box">
    <h1>🔐 Apex-MD</h1>
    <p>Web Control Panel — Owner Access Only</p>
    <form method="POST" action="/dashboard/login">
      <div class="field"><label>Password</label>
        <input type="password" name="password" placeholder="Enter dashboard password" autofocus required>
      </div>
      ${err}
      <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center">Sign In →</button>
    </form>
  </div>
</div>`));
    });

    app.post('/dashboard/login', (req, res) => {
        const pw = (req.body.password || '').trim();
        if (pw !== config.DASHBOARD_PASSWORD) {
            return res.redirect('/dashboard/login?err=1');
        }
        const token = _signToken({ exp: Date.now() + COOKIE_TTL, role: 'owner' });
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${COOKIE_TTL / 1000}; SameSite=Strict`);
        res.redirect('/dashboard/');
    });

    app.get('/dashboard/logout', (req, res) => {
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`);
        res.redirect('/dashboard/login');
    });

    // ── Auth guard for all /dashboard/* routes except login ───
    app.use('/dashboard', (req, res, next) => {
        if (req.path === '/login' || req.method === 'POST' && req.path === '/login') return next();
        requireAuth(req, res, next);
    });

    // ── Main Dashboard Page ────────────────────────────────────
    app.get('/dashboard/', async (req, res) => {
        let tradesHtml = '<tr><td colspan="7" style="text-align:center;color:var(--text2)">No active trades</td></tr>';
        try {
            const trades = await db.Trade.find({ status: { $in: ['active', 'pending'] } }).lean();
            if (trades.length > 0) {
                tradesHtml = trades.map(t => {
                    const dir = t.direction === 'LONG' ? '<span class="pill long">LONG</span>' : '<span class="pill short">SHORT</span>';
                    const st  = t.status === 'pending' ? '<span class="pill pending">PENDING</span>' : '<span class="pill active">ACTIVE</span>';
                    const hrs = ((Date.now() - new Date(t.openTime)) / 3600000).toFixed(1);
                    return `<tr>
                        <td><strong>${t.coin}</strong></td>
                        <td>${dir}</td>
                        <td>$${parseFloat(t.entry).toFixed(4)}</td>
                        <td>$${parseFloat(t.tp2 || t.tp).toFixed(4)}</td>
                        <td>$${parseFloat(t.sl).toFixed(4)}</td>
                        <td>${st}</td>
                        <td>${hrs}h</td>
                    </tr>`;
                }).join('');
            }
        } catch (_) {}

        const uptime  = Math.floor((Date.now() - _botState.startTime) / 60000);
        const uptimeStr = uptime >= 60 ? `${Math.floor(uptime/60)}h ${uptime%60}m` : `${uptime}m`;

        let scannerStatus = false;
        try { scannerStatus = require('./plugins/scanner').getScannerStatus(); } catch (_) {}

        let tradeCount = 0;
        try { tradeCount = await db.Trade.countDocuments({ status: { $in: ['active', 'pending'] } }); } catch (_) {}

        res.send(_html('Dashboard', `
${_nav('home', _botState.pendingUpdate)}
<div class="wrap">
  <h1>📊 Live Dashboard</h1>
  <div class="grid">
    <div class="card"><div class="card-label">WhatsApp</div>
      <div class="card-val ${_botState.waConnected ? 'green' : 'red'}" id="wa-status">${_botState.waConnected ? '🟢 Online' : '🔴 Offline'}</div>
      <div class="card-sub">Connection</div></div>
    <div class="card"><div class="card-label">Auto Scanner</div>
      <div class="card-val ${scannerStatus ? 'green' : 'yellow'}" id="scanner-status">${scannerStatus ? '🟢 Active' : '⚪ Standby'}</div>
      <div class="card-sub">Signal engine</div></div>
    <div class="card"><div class="card-label">Active Trades</div>
      <div class="card-val blue" id="trade-count">${tradeCount}</div>
      <div class="card-sub">Open positions</div></div>
    <div class="card"><div class="card-label">Uptime</div>
      <div class="card-val" id="uptime">${uptimeStr}</div>
      <div class="card-sub">Since last restart</div></div>
    <div class="card"><div class="card-label">AI Model</div>
      <div class="card-val ${config.modules.AI_MODEL ? 'green' : 'yellow'}">${config.modules.AI_MODEL ? '🟢 On' : '⚪ Off'}</div>
      <div class="card-sub">LSTM server</div></div>
    <div class="card"><div class="card-label">Bybit Layer</div>
      <div class="card-val ${config.modules.BYBIT ? 'green' : 'yellow'}">${config.modules.BYBIT ? '🟢 On' : '⚪ Off'}</div>
      <div class="card-sub">Cross-exchange</div></div>
  </div>

  <div class="section">
    <h2>📋 Active Trades</h2>
    <table>
      <thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP2</th><th>SL</th><th>Status</th><th>Open</th></tr></thead>
      <tbody id="trades-body">${tradesHtml}</tbody>
    </table>
  </div>

  <div class="section">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <h2 style="margin:0">🖥️ Live Logs</h2>
      <button class="btn btn-ghost" onclick="clearLogs()" style="font-size:.8rem;padding:5px 10px">🗑️ Clear</button>
    </div>
    <div class="log-box" id="log-box">
      <div class="log-info">Connecting to log stream...</div>
    </div>
  </div>
</div>
<script>
// Log SSE
const lb = document.getElementById('log-box');
const es = new EventSource('/dashboard/api/logs/stream');
let autoScroll = true;
lb.addEventListener('scroll', () => { autoScroll = lb.scrollTop + lb.clientHeight >= lb.scrollHeight - 40; });
es.onmessage = e => {
  const d = JSON.parse(e.data);
  const el = document.createElement('div');
  const msg = d.msg || '';
  el.className = 'log-' + (msg.includes('[ERROR]') ? 'error' : msg.includes('[WARN]') ? 'warn' : msg.includes('[BOT]') ? 'bot' : 'info');
  el.textContent = new Date(d.ts).toLocaleTimeString() + '  ' + msg;
  lb.appendChild(el);
  if (autoScroll) lb.scrollTop = lb.scrollHeight;
};
es.onerror = () => { const el = document.createElement('div'); el.className='log-warn'; el.textContent='[Stream disconnected — reload to reconnect]'; lb.appendChild(el); };
function clearLogs() { lb.innerHTML=''; }

// Status poll every 10s
setInterval(async () => {
  try {
    const r = await fetch('/dashboard/api/status');
    const d = await r.json();
    document.getElementById('wa-status').textContent = d.waConnected ? '🟢 Online' : '🔴 Offline';
    document.getElementById('wa-status').className = 'card-val ' + (d.waConnected ? 'green' : 'red');
    document.getElementById('scanner-status').textContent = d.scannerActive ? '🟢 Active' : '⚪ Standby';
    document.getElementById('trade-count').textContent = d.tradeCount;
    document.getElementById('uptime').textContent = d.uptime;
  } catch(_) {}
}, 10000);
</script>`));
    });

    // ── Settings Page ──────────────────────────────────────────
    app.get('/dashboard/settings', (req, res) => {
        const m  = config.modules;
        const t  = config.trading;
        const pr = config.modes.proMode;
        const ind = config.indicators;
        const smc = config.smc;
        const tgt = config.targets;

        // ── Component helpers ──────────────────────────────────
        const modToggle = (id, label, desc, checked) => `
<div class="toggle-row">
  <div class="toggle-info"><h3>${label}</h3><p>${desc}</p></div>
  <label class="toggle">
    <input type="checkbox" id="mod-${id}" ${checked ? 'checked' : ''} onchange="toggleMod('${id}',this.checked)">
    <span class="slider"></span>
  </label>
</div>`;

        const tradingRow = (key, label, val, min, max, step, unit = '') => `
<div class="param-row">
  <div>
    <strong>${label}</strong>${unit ? `<span class="param-unit">${unit}</span>` : ''}
    <br><span class="param-key">${key}</span>
  </div>
  <input type="number" id="param-${key}" value="${val}" min="${min}" max="${max}" step="${step}"
    onchange="setTradingParam('${key}',this.value)">
</div>`;

        const indRow = (key, label, val, min, max, step, unit = '', hint = '') => `
<div class="param-row pro-param">
  <div>
    <strong>${label}</strong>${unit ? `<span class="param-unit">${unit}</span>` : ''}
    ${hint ? `<br><span class="param-hint">${hint}</span>` : ''}
    <br><span class="param-key">${key}</span>
  </div>
  <input type="number" id="ind-${key}" value="${val}" min="${min}" max="${max}" step="${step}"
    onchange="setIndicatorParam('${key}',this.value)" ${pr ? '' : 'disabled'}>
</div>`;

        const smcRow = (key, label, val, min, max, step, unit = '', hint = '') => `
<div class="param-row pro-param">
  <div>
    <strong>${label}</strong>${unit ? `<span class="param-unit">${unit}</span>` : ''}
    ${hint ? `<br><span class="param-hint">${hint}</span>` : ''}
    <br><span class="param-key">${key}</span>
  </div>
  <input type="number" id="smc-${key}" value="${val}" min="${min}" max="${max}" step="${step}"
    onchange="setSMCParam('${key}',this.value)" ${pr ? '' : 'disabled'}>
</div>`;

        const tgtRow = (key, label, val, min, max, step, unit = '', hint = '') => `
<div class="param-row pro-param">
  <div>
    <strong>${label}</strong>${unit ? `<span class="param-unit">${unit}</span>` : ''}
    ${hint ? `<br><span class="param-hint">${hint}</span>` : ''}
    <br><span class="param-key">${key}</span>
  </div>
  <input type="number" id="tgt-${key}" value="${val}" min="${min}" max="${max}" step="${step}"
    onchange="setTargetParam('${key}',this.value)" ${pr ? '' : 'disabled'}>
</div>`;

        res.send(_html('Settings', `
${_nav('settings', _botState.pendingUpdate)}
<style>
  .param-key{font-size:.75rem;color:var(--text2);font-family:monospace}
  .param-hint{font-size:.75rem;color:var(--text2)}
  .param-unit{font-size:.78rem;color:var(--accent);margin-left:5px;font-weight:400}
  .pro-section{border:1px solid var(--border);border-radius:10px;margin-bottom:20px;overflow:hidden}
  .pro-section-header{padding:14px 20px;display:flex;align-items:center;gap:10px;background:#161b22;border-bottom:1px solid var(--border)}
  .pro-section-header h2{font-size:.95rem;font-weight:600;margin:0}
  .pro-section-header p{font-size:.78rem;color:var(--text2);margin:0;margin-left:auto}
  .pro-section-body{padding:0 20px}
  .pro-master{background:linear-gradient(135deg,#0d2137,#0d1117);border:1px solid var(--accent);border-radius:10px;padding:20px;margin-bottom:24px;display:flex;align-items:center;gap:20px}
  .pro-master-info h2{font-size:1.1rem;font-weight:700;color:var(--accent);margin-bottom:4px}
  .pro-master-info p{font-size:.82rem;color:var(--text2);max-width:480px}
  .pro-master .toggle{margin-left:auto;flex-shrink:0}
  .pro-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:700;background:linear-gradient(90deg,#58a6ff,#7c3aed);color:#fff;margin-left:6px;vertical-align:middle}
  .pro-disabled-overlay{opacity:.45;pointer-events:none;user-select:none}
  .settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
  .settings-grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px}
  .save-toast{position:fixed;bottom:24px;right:24px;background:#1a3a2a;border:1px solid var(--green);color:var(--green);padding:10px 18px;border-radius:8px;font-size:.88rem;display:none;z-index:999;animation:fadeIn .2s}
  .save-toast.err-toast{background:#3a1a1a;border-color:var(--red);color:var(--red)}
  @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  @media(max-width:900px){.settings-grid,.settings-grid-3{grid-template-columns:1fr}}
</style>

<div class="wrap" style="max-width:1300px">
  <h1>⚙️ Settings</h1>

  <!-- ═══ PRO CUSTOM MODE MASTER TOGGLE ═══ -->
  <div class="pro-master">
    <div style="font-size:2rem">🎛️</div>
    <div class="pro-master-info">
      <h2>Pro Custom Mode <span class="pro-badge">PRO</span></h2>
      <p>Override every indicator and strategy parameter. When <strong>OFF</strong>, the bot uses its built-in optimal values automatically.
         When <strong>ON</strong>, your custom values below take full control.</p>
    </div>
    <label class="toggle" style="width:56px;height:30px">
      <input type="checkbox" id="pro-toggle" ${pr ? 'checked' : ''} onchange="toggleProMode(this.checked)">
      <span class="slider" style="border-radius:99px"></span>
    </label>
  </div>

  <!-- ═══ ROW 1: Module Toggles + Trading Parameters ═══ -->
  <div class="settings-grid" style="margin-bottom:20px">
    <div class="section">
      <h2>🧩 Module Toggles</h2>
      <p style="font-size:.82rem;color:var(--text2);margin-bottom:16px">Each module can be disabled independently. Changes apply instantly.</p>
      ${modToggle('AI_MODEL',        '🤖 AI Model',         'Local Python LSTM prediction server (port 5000)', m.AI_MODEL)}
      ${modToggle('BYBIT',           '🐳 Bybit Layer',      'Cross-exchange OB + volume validation',           m.BYBIT)}
      ${modToggle('DYNAMIC_WEIGHTS', '🧠 Dynamic Weights',  'ADX/ATR-based score multipliers',                 m.DYNAMIC_WEIGHTS)}
      ${modToggle('SMC',             '🔮 SMC Scoring',      'ChoCH, Sweep, OB, Wyckoff, BOS, Breakers',        m.SMC)}
    </div>

    <div class="section">
      <h2>💼 Core Trading Parameters</h2>
      <p style="font-size:.82rem;color:var(--text2);margin-bottom:16px">Saved to database — persist across restarts.</p>
      ${tradingRow('DEFAULT_RISK_PCT',    '💰 Risk per Trade',       t.DEFAULT_RISK_PCT,    0.1, 10,   0.1, '%')}
      ${tradingRow('MANUAL_MARGIN',       '🏦 Manual Margin (USDT)', t.MANUAL_MARGIN,       10,  100000, 10, 'USDT')}
      ${tradingRow('DEFAULT_LEVERAGE',    '⚡ Default Leverage',     t.DEFAULT_LEVERAGE,    1,   125,  1,   'x')}
      ${tradingRow('MAX_OPEN_TRADES',     '📂 Max Open Trades',      t.MAX_OPEN_TRADES,     1,   20,   1)}
      ${tradingRow('MIN_SCORE_THRESHOLD', '📊 Min Signal Score',     t.MIN_SCORE_THRESHOLD, 5,   80,   1)}
      ${tradingRow('SIGNAL_COOLDOWN_HOURS','⏱️ Signal Cooldown',      t.SIGNAL_COOLDOWN_HOURS, 0.5, 48, 0.5, 'hr')}
    </div>
  </div>

  <!-- ═══ PRO CUSTOM SECTION ═══ -->
  <div id="pro-panels" class="${pr ? '' : 'pro-disabled-overlay'}">

    <!-- ─── Row 2: Trend & Momentum + Volatility ─── -->
    <div class="settings-grid" style="margin-bottom:20px">

      <!-- 📈 Trend & Momentum -->
      <div class="pro-section">
        <div class="pro-section-header">
          <span style="font-size:1.3rem">📈</span>
          <h2>Trend &amp; Momentum</h2>
          <p>RSI · MACD · EMA</p>
        </div>
        <div class="pro-section-body">
          <div style="padding:10px 0 6px;font-size:.78rem;color:var(--text2);text-transform:uppercase;letter-spacing:.04em">RSI</div>
          ${indRow('RSI_PERIOD',     'Period',         ind.RSI_PERIOD,     2,  50,  1,   'bars')}
          ${indRow('RSI_OVERSOLD',   'Oversold Level', ind.RSI_OVERSOLD,   10, 50,  1,   '',    'Score: Long when RSI < this')}
          ${indRow('RSI_OVERBOUGHT', 'Overbought Level',ind.RSI_OVERBOUGHT,50, 90,  1,   '',    'Score: Short when RSI > this')}
          <div style="padding:10px 0 6px;font-size:.78rem;color:var(--text2);text-transform:uppercase;letter-spacing:.04em;border-top:1px solid #21262d;margin-top:8px">MACD</div>
          ${indRow('MACD_FAST',   'Fast EMA',    ind.MACD_FAST,   2,  50,  1, 'bars')}
          ${indRow('MACD_SLOW',   'Slow EMA',    ind.MACD_SLOW,   5,  100, 1, 'bars')}
          ${indRow('MACD_SIGNAL', 'Signal Line', ind.MACD_SIGNAL, 2,  30,  1, 'bars')}
          <div style="padding:10px 0 6px;font-size:.78rem;color:var(--text2);text-transform:uppercase;letter-spacing:.04em;border-top:1px solid #21262d;margin-top:8px">EMA Ribbon</div>
          ${indRow('EMA_FAST',        'Fast EMA',        ind.EMA_FAST,        2,   100,  1, 'bars')}
          ${indRow('EMA_SLOW',        'Slow EMA',        ind.EMA_SLOW,        10,  500,  5, 'bars', '200 = classic trend filter')}
          ${indRow('EMA_RIBBON_FAST', 'Ribbon Fast EMA', ind.EMA_RIBBON_FAST, 5,   50,   1, 'bars', 'Pullback entry trigger')}
        </div>
      </div>

      <!-- 📊 Volatility -->
      <div class="pro-section">
        <div class="pro-section-header">
          <span style="font-size:1.3rem">📊</span>
          <h2>Volatility</h2>
          <p>ATR · Bollinger Bands · ADX</p>
        </div>
        <div class="pro-section-body">
          <div style="padding:10px 0 6px;font-size:.78rem;color:var(--text2);text-transform:uppercase;letter-spacing:.04em">ATR (Average True Range)</div>
          ${indRow('ATR_PERIOD',      'ATR Period',       ind.ATR_PERIOD,      2,  50, 1, 'bars')}
          ${indRow('ATR_SL_MULTIPLIER','SL ATR Multiplier',ind.ATR_SL_MULTIPLIER, 0.5, 6, 0.1, 'x', 'Default SL = entry ± (ATR × this)')}
          ${indRow('ATR_MAX_SL_MULT', 'Max SL Range',     ind.ATR_MAX_SL_MULT, 1,  10, 0.5, '×ATR', 'Reject SL beyond this ATR distance')}
          <div style="padding:10px 0 6px;font-size:.78rem;color:var(--text2);text-transform:uppercase;letter-spacing:.04em;border-top:1px solid #21262d;margin-top:8px">Bollinger Bands</div>
          ${indRow('BB_PERIOD',         'BB Length',          ind.BB_PERIOD,         5,  100, 1,    'bars')}
          ${indRow('BB_STDDEV',         'Std Deviation Mult', ind.BB_STDDEV,         0.5, 5,  0.1,  'σ',   '2.0 = standard')}
          ${indRow('BB_SQUEEZE_THRESH', 'Squeeze Threshold',  ind.BB_SQUEEZE_THRESH, 0.005, 0.1, 0.005, '%', 'Bandwidth < this = squeeze signal')}
          <div style="padding:10px 0 6px;font-size:.78rem;color:var(--text2);text-transform:uppercase;letter-spacing:.04em;border-top:1px solid #21262d;margin-top:8px">ADX (Trend Strength)</div>
          ${indRow('ADX_PERIOD',       'ADX Period',        ind.ADX_PERIOD,       2,  50, 1, 'bars')}
          ${indRow('ADX_STRONG_THRESH','Trending Threshold',ind.ADX_STRONG_THRESH, 10, 40, 1, '', 'ADX > this = trending market')}
          ${indRow('ADX_VERY_STRONG',  'Strong Threshold',  ind.ADX_VERY_STRONG,  20, 60, 1, '', 'ADX > this = very strong trend')}
        </div>
      </div>
    </div>

    <!-- ─── Row 3: SMC + Risk & Targets ─── -->
    <div class="settings-grid" style="margin-bottom:20px">

      <!-- 🔮 Smart Money Concepts -->
      <div class="pro-section">
        <div class="pro-section-header">
          <span style="font-size:1.3rem">🔮</span>
          <h2>Smart Money Concepts</h2>
          <p>OB · Sweep · ChoCH · FVG · BOS</p>
        </div>
        <div class="pro-section-body">
          <div style="padding:10px 0 6px;font-size:.78rem;color:var(--text2);text-transform:uppercase;letter-spacing:.04em">Lookback Windows</div>
          ${smcRow('OB_LOOKBACK',     'Order Block Lookback',    smc.OB_LOOKBACK,     5,  60, 1,  'bars', 'Bars to scan for OB formation')}
          ${smcRow('SWING_LOOKBACK',  'Swing High/Low Lookback', smc.SWING_LOOKBACK,  5,  100, 1, 'bars', 'Bars for swing structure detection')}
          ${smcRow('CHOCH_LOOKBACK',  'ChoCH Lookback',          smc.CHOCH_LOOKBACK,  5,  100, 1, 'bars', 'Change of Character detection window')}
          ${smcRow('SWEEP_LOOKBACK',  'Liquidity Sweep Lookback',smc.SWEEP_LOOKBACK,  3,  50, 1,  'bars', 'Liquidity sweep detection window')}
          ${smcRow('FVG_LOOKBACK',    'Fair Value Gap Lookback', smc.FVG_LOOKBACK,    10, 200, 5, 'bars', 'Bars to scan for unfilled FVGs')}
          ${smcRow('BOS_LOOKBACK',    'Break of Structure Lookback',smc.BOS_LOOKBACK, 5,  100, 1, 'bars')}
          <div style="padding:10px 0 6px;font-size:.78rem;color:var(--text2);text-transform:uppercase;letter-spacing:.04em;border-top:1px solid #21262d;margin-top:8px">Tolerance Zones</div>
          ${smcRow('OB_TOUCH_TOLERANCE',  'OB Touch Tolerance',  smc.OB_TOUCH_TOLERANCE,  0.001, 0.02, 0.001, '',  'Price proximity % to OB zone (0.003 = 0.3%)')}
          ${smcRow('EQUAL_HL_TOLERANCE',  'Equal H/L Tolerance', smc.EQUAL_HL_TOLERANCE,  0.001, 0.02, 0.001, '',  'Price proximity % for EQH/EQL detection')}
        </div>
      </div>

      <!-- 🎯 Risk & Targets -->
      <div class="pro-section">
        <div class="pro-section-header">
          <span style="font-size:1.3rem">🎯</span>
          <h2>Risk &amp; Targets</h2>
          <p>TP Levels · SL · RRR</p>
        </div>
        <div class="pro-section-body">
          <div style="padding:10px 0 6px;font-size:.78rem;color:var(--text2);text-transform:uppercase;letter-spacing:.04em">Take Profit Levels (RRR)</div>
          ${tgtRow('TP1_RRR', 'TP1 Risk:Reward', tgt.TP1_RRR, 0.5, 20, 0.1, ':1', 'TP1 = entry ± (SL distance × this)')}
          ${tgtRow('TP2_RRR', 'TP2 Risk:Reward', tgt.TP2_RRR, 0.5, 30, 0.1, ':1', 'TP2 = entry ± (SL distance × this)')}
          ${tgtRow('TP3_RRR', 'TP3 Risk:Reward', tgt.TP3_RRR, 1,   50, 0.5, ':1', 'TP3 = entry ± (SL distance × this)')}
          <div style="padding:10px 0 6px;font-size:.78rem;color:var(--text2);text-transform:uppercase;letter-spacing:.04em;border-top:1px solid #21262d;margin-top:8px">Stop Loss</div>
          ${tgtRow('ATR_SL_MULTIPLIER', 'Default SL Multiplier', tgt.ATR_SL_MULTIPLIER, 0.2, 10, 0.1, '×ATR', 'Fallback SL = entry ± (ATR × this)')}
          ${tgtRow('DEFAULT_SL_PCT',    'Max SL %',               tgt.DEFAULT_SL_PCT,    0.1, 20,  0.1, '%',   'Hard max stop loss percentage')}
          ${tgtRow('MIN_RRR',           'Minimum RRR Filter',     tgt.MIN_RRR,           0.5, 10,  0.1, ':1',  'Reject trades with RRR below this')}
          <div style="padding:10px 0 6px;font-size:.78rem;color:var(--text2);text-transform:uppercase;letter-spacing:.04em;border-top:1px solid #21262d;margin-top:8px">Fibonacci Thresholds</div>
          ${tgtRow('FIB_TP1_THRESH', 'Fib TP1 Radius', tgt.FIB_TP1_THRESH, 0.05, 0.8, 0.05, '', 'Max distance from entry for Fib TP1 (0.25 = 25%)')}
          ${tgtRow('FIB_TP2_THRESH', 'Fib TP2 Radius', tgt.FIB_TP2_THRESH, 0.1,  1.5, 0.05, '', 'Max distance from entry for Fib TP2 (0.50 = 50%)')}
        </div>
      </div>
    </div>

    <!-- ─── Pro Mode Info Banner ─── -->
    <div style="background:#0d2137;border:1px solid #1d3d5c;border-radius:8px;padding:14px 20px;font-size:.82rem;color:var(--text2);margin-bottom:20px">
      <strong style="color:var(--accent)">ℹ️ Pro Custom Mode Active</strong> —
      All indicator calls in <code>analyzer.js</code>, <code>indicators.js</code>, and execution modules now use your values above.
      Settings auto-save on every change. <span style="color:var(--yellow)">No restart required.</span>
    </div>

  </div><!-- /pro-panels -->

</div><!-- /wrap -->

<!-- Toast notification -->
<div class="save-toast" id="toast"></div>

<script>
// ── Utility ──────────────────────────────────────────────────
function showToast(msg, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'save-toast' + (isErr ? ' err-toast' : '');
  t.style.display = 'block';
  clearTimeout(t._tid);
  t._tid = setTimeout(() => { t.style.display = 'none'; }, 2800);
}

async function apiPost(url, body) {
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  return r.json();
}

// ── Pro Custom Mode toggle ────────────────────────────────────
async function toggleProMode(val) {
  const d = await apiPost('/dashboard/api/promode', { enabled: val });
  if (d.ok) {
    showToast('🎛️ Pro Custom Mode → ' + (val ? 'ON ✅' : 'OFF'));
    // Enable/disable all pro inputs
    document.querySelectorAll('.pro-param input').forEach(el => el.disabled = !val);
    document.getElementById('pro-panels').classList.toggle('pro-disabled-overlay', !val);
  } else {
    showToast('❌ ' + d.error, true);
    document.getElementById('pro-toggle').checked = !val;
  }
}

// ── Module toggles ────────────────────────────────────────────
async function toggleMod(id, val) {
  const d = await apiPost('/dashboard/api/modules/' + id, { enabled: val });
  showToast(d.ok ? '✅ ' + id + ' → ' + (val ? 'ON' : 'OFF') : '❌ ' + d.error, !d.ok);
}

// ── Trading params ────────────────────────────────────────────
async function setTradingParam(key, val) {
  const d = await apiPost('/dashboard/api/params/' + key, { value: parseFloat(val) });
  showToast(d.ok ? '✅ ' + key + ' = ' + val : '❌ ' + d.error, !d.ok);
}

// ── Indicator params ──────────────────────────────────────────
async function setIndicatorParam(key, val) {
  const d = await apiPost('/dashboard/api/indicators/' + key, { value: parseFloat(val) });
  showToast(d.ok ? '📈 ' + key + ' = ' + val : '❌ ' + d.error, !d.ok);
}

// ── SMC params ────────────────────────────────────────────────
async function setSMCParam(key, val) {
  const d = await apiPost('/dashboard/api/smc/' + key, { value: parseFloat(val) });
  showToast(d.ok ? '🔮 ' + key + ' = ' + val : '❌ ' + d.error, !d.ok);
}

// ── Target params ─────────────────────────────────────────────
async function setTargetParam(key, val) {
  const d = await apiPost('/dashboard/api/targets/' + key, { value: parseFloat(val) });
  showToast(d.ok ? '🎯 ' + key + ' = ' + val : '❌ ' + d.error, !d.ok);
}
</script>`));
    });

    // ── Auto Updater Page ──────────────────────────────────────
    app.get('/dashboard/updater', (req, res) => {
        const enabled = config.updater.ENABLED;
        const pending = _botState.pendingUpdate;
        res.send(_html('Auto Updater', `
${_nav('updater', pending)}
<div class="wrap">
  <h1>🔄 Auto Updater</h1>
  ${pending ? '<div class="section" style="border-color:var(--yellow)"><p style="color:var(--yellow)">⚠️ <strong>New update available on GitHub</strong> — auto-update is OFF. Click "Pull Update" to apply manually.</p></div>' : ''}
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
    <div class="section">
      <h2>🔧 Update Controls</h2>
      <div class="toggle-row">
        <div class="toggle-info"><h3>Auto-Update</h3><p>Automatically apply updates on git push events</p></div>
        <label class="toggle">
          <input type="checkbox" id="auto-toggle" ${enabled ? 'checked' : ''} onchange="setAutoUpdate(this.checked)">
          <span class="slider"></span>
        </label>
      </div>
      <div style="margin-top:20px;display:flex;flex-direction:column;gap:12px">
        <button class="btn btn-primary" onclick="runUpdate()">🔄 Pull Update Now</button>
        <p style="font-size:.8rem;color:var(--text2)">Runs: <code>git pull && npm install && pm2 restart ${config.updater.PM2_APP_NAME}</code></p>
        <p style="font-size:.8rem;color:var(--text2)">PM2 App: <strong>${config.updater.PM2_APP_NAME}</strong></p>
        ${config.updater.WEBHOOK_SECRET ? '<p style="font-size:.8rem;color:var(--green)">✅ GitHub webhook secret configured</p>' : '<p style="font-size:.8rem;color:var(--yellow)">⚠️ No webhook secret — set GITHUB_WEBHOOK_SECRET in config.env</p>'}
      </div>
      <div class="update-out" id="update-out"></div>
      <div id="update-msg" style="margin-top:8px;font-size:.88rem"></div>
    </div>
    <div class="section">
      <h2>📋 Update Info</h2>
      <p style="font-size:.88rem;margin-bottom:12px;color:var(--text2)">Last update: ${_botState.lastUpdate || 'Never'}</p>
      <p style="font-size:.88rem;margin-bottom:12px;color:var(--text2)">GitHub Webhook URL:</p>
      <code style="background:#090d11;padding:8px 12px;border-radius:6px;display:block;font-size:.82rem;word-break:break-all">http://YOUR_VPS_IP:${port}/dashboard/webhook/update</code>
      <p style="font-size:.8rem;color:var(--text2);margin-top:8px">Add this as a Webhook in your GitHub repo → Settings → Webhooks. Set Content-Type to application/json.</p>
    </div>
  </div>
</div>
<script>
async function setAutoUpdate(val) {
  const r = await fetch('/dashboard/api/autoupdate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enabled: val }) });
  const d = await r.json();
  document.getElementById('update-msg').textContent = d.ok ? '✅ Auto-update ' + (val ? 'enabled' : 'disabled') : '❌ ' + d.error;
  document.getElementById('update-msg').className = d.ok ? 'msg-ok' : 'err';
}
async function runUpdate() {
  document.getElementById('update-msg').textContent = '🔄 Starting update... this may take 60s...';
  document.getElementById('update-msg').className = 'log-info';
  const out = document.getElementById('update-out');
  out.style.display = 'block'; out.textContent = 'Running...';
  try {
    const r = await fetch('/dashboard/api/update', { method:'POST' });
    const d = await r.json();
    out.textContent = d.ok ? (d.output || 'Done.') : ('Error: ' + d.error + '\\n' + (d.stderr||''));
    document.getElementById('update-msg').textContent = d.ok ? '✅ Update complete — bot restarting' : '❌ Update failed';
    document.getElementById('update-msg').className = d.ok ? 'msg-ok' : 'err';
  } catch(e) { out.textContent = 'Network error: ' + e.message; }
}
</script>`));
    });

    // ════════════════════════════════════════════════════════════
    //  REST API ENDPOINTS
    // ════════════════════════════════════════════════════════════

    // Status
    app.get('/dashboard/api/status', requireAuth, async (req, res) => {
        let scannerActive = false, tradeCount = 0;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        try { tradeCount = await db.Trade.countDocuments({ status: { $in: ['active', 'pending'] } }); } catch (_) {}
        const uptime = Math.floor((Date.now() - _botState.startTime) / 60000);
        res.json({
            waConnected: _botState.waConnected, scannerActive, tradeCount,
            uptime: uptime >= 60 ? `${Math.floor(uptime/60)}h ${uptime%60}m` : `${uptime}m`,
            modules: config.modules, trading: config.trading,
        });
    });

    // Live log SSE stream
    app.get('/dashboard/api/logs/stream', requireAuth, (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        // Send last 50 buffered lines on connect
        _logBuffer.slice(-50).forEach(entry => {
            res.write(`data: ${JSON.stringify(entry)}\n\n`);
        });

        _sseClients.add(res);
        req.on('close', () => _sseClients.delete(res));
    });

    // Module toggles
    app.post('/dashboard/api/modules/:name', requireAuth, async (req, res) => {
        try {
            const name    = req.params.name.toUpperCase();
            const enabled = Boolean(req.body.enabled);
            config.toggleModule(name, enabled);
            // Also persist to DB settings for scanner-visible toggles
            const dbKey = { AI_MODEL: 'aiModel', BYBIT: 'bybit', DYNAMIC_WEIGHTS: 'dynamicWeights', SMC: 'smcEnabled' }[name];
            if (dbKey) await db.updateSettings({ [dbKey]: enabled }).catch(() => {});
            res.json({ ok: true, module: name, enabled });
        } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    // Trading params
    app.post('/dashboard/api/params/:key', requireAuth, async (req, res) => {
        try {
            const key = req.params.key;
            const val = parseFloat(req.body.value);
            if (isNaN(val)) throw new Error('Invalid number');
            config.setTradingParam(key, val);
            // Persist relevant params to db
            const dbMap = { DEFAULT_RISK_PCT: 'defaultRisk', MIN_SCORE_THRESHOLD: 'minScore', MAX_OPEN_TRADES: 'maxTrades' };
            if (dbMap[key]) await db.updateSettings({ [dbMap[key]]: val }).catch(() => {});
            res.json({ ok: true, key, value: val });
        } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    // Pro Custom Mode toggle
    app.post('/dashboard/api/promode', requireAuth, async (req, res) => {
        try {
            const enabled = Boolean(req.body.enabled);
            config.setProMode(enabled);
            await db.updateSettings({ proMode: enabled }).catch(() => {});
            res.json({ ok: true, proMode: enabled });
        } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    // Indicator params (Pro Custom Mode)
    app.post('/dashboard/api/indicators/:key', requireAuth, async (req, res) => {
        try {
            const key = req.params.key;
            const val = parseFloat(req.body.value);
            if (isNaN(val)) throw new Error('Invalid number');
            config.setIndicatorParam(key, val);
            await db.updateSettings({ [`ind_${key}`]: val }).catch(() => {});
            res.json({ ok: true, key, value: val });
        } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    // SMC params (Pro Custom Mode)
    app.post('/dashboard/api/smc/:key', requireAuth, async (req, res) => {
        try {
            const key = req.params.key;
            const val = parseFloat(req.body.value);
            if (isNaN(val)) throw new Error('Invalid number');
            config.setSMCParam(key, val);
            await db.updateSettings({ [`smc_${key}`]: val }).catch(() => {});
            res.json({ ok: true, key, value: val });
        } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    // Target params (Pro Custom Mode)
    app.post('/dashboard/api/targets/:key', requireAuth, async (req, res) => {
        try {
            const key = req.params.key;
            const val = parseFloat(req.body.value);
            if (isNaN(val)) throw new Error('Invalid number');
            config.setTargetParam(key, val);
            await db.updateSettings({ [`tgt_${key}`]: val }).catch(() => {});
            res.json({ ok: true, key, value: val });
        } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    // Auto update toggle
    app.post('/dashboard/api/autoupdate', requireAuth, (req, res) => {
        config.setAutoUpdate(Boolean(req.body.enabled));
        res.json({ ok: true, enabled: config.updater.ENABLED });
    });

    // Manual update trigger
    app.post('/dashboard/api/update', requireAuth, (req, res) => {
        if (!config.updater.ENABLED && !req.body.force) {
            // Allow dashboard manual trigger even when auto-update is off
        }
        runUpdate(res);
    });

    // Config snapshot
    app.get('/dashboard/api/config', requireAuth, (req, res) => {
        res.json(config.getSnapshot());
    });

    // Trades API
    app.get('/dashboard/api/trades', requireAuth, async (req, res) => {
        try {
            const trades = await db.Trade.find({ status: { $in: ['active', 'pending'] } }).lean();
            res.json({ ok: true, trades });
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    // ── GitHub Webhook ─────────────────────────────────────────
    // Raw body needed for signature verification
    app.post('/dashboard/webhook/update', express.raw({ type: 'application/json' }), (req, res) => {
        const body = req.body;

        if (!_verifyGithubSig(req, body)) {
            return res.status(401).json({ error: 'Invalid signature' });
        }

        res.json({ ok: true, message: 'Webhook received' });

        if (config.updater.ENABLED) {
            _pushLog('[WEBHOOK] 📦 GitHub push received — running auto-update...');
            runUpdate(null);
        } else {
            _botState.pendingUpdate = true;
            _pushLog('[WEBHOOK] ⚠️ GitHub push received — auto-update is OFF. Manual update available in dashboard.');
        }
    });

    // ── Redirect root /dashboard to /dashboard/ ────────────────
    app.get('/dashboard', (req, res) => res.redirect('/dashboard/'));

    // ── Start dashboard server ─────────────────────────────────
    app.listen(port, () => {
        console.log(`\n🌐 [Dashboard] Running at http://localhost:${port}/dashboard/`);
        console.log(`🔐 [Dashboard] Password: ${config.DASHBOARD_PASSWORD}`);
    });

    return { setBotConnected, log };
}

module.exports = { initDashboard, log, setBotConnected };
