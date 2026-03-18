'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD v7.1 PRO VVIP  ·  dashboard.js
 *  ──────────────────────────────────────────────────────────────
 *  ✅ FIXES & UPGRADES:
 *    - Login brute-force rate limiting (5 attempts / 15 min)
 *    - setIndicatorParam/setSMCParam/setTargetParam now route to
 *      the fixed config.js functions (no more silent fail)
 *    - API Health Monitor panel (Binance/GROQ/Gemini/MongoDB)
 *    - Paper Trading Stats panel (win rate, equity, best/worst)
 *    - Scanner Start/Stop control panel
 *    - Trade History tab (closed trades)
 *    - Navigation: added Stats & History tabs
 *    - Mobile responsive improved
 *    - Dashboard nav shows scanner status badge
 * ════════════════════════════════════════════════════════════════
 */

const express  = require('express');
const crypto   = require('crypto');
const { exec } = require('child_process');
const path     = require('path');
const axios    = require('axios');

const config = require('./config');
const db     = require('./lib/database');

// ─── Log Ring-Buffer (last 500 lines) ────────────────────────
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

// ─── Console interception ─────────────────────────────────────
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
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
        return res.redirect('/dashboard/login');
    }
    next();
}

// ─── Login Rate Limiter (5 attempts / 15 min per IP) ─────────
const _loginAttempts = new Map();
function _checkLoginRateLimit(ip) {
    const now  = Date.now();
    const data = _loginAttempts.get(ip) || { count: 0, first: now };
    if (now - data.first > 15 * 60 * 1000) {
        _loginAttempts.set(ip, { count: 1, first: now });
        return true;
    }
    if (data.count >= 5) return false;
    data.count++;
    _loginAttempts.set(ip, data);
    return true;
}
function _resetLoginLimit(ip) { _loginAttempts.delete(ip); }

// ─── Bot State ────────────────────────────────────────────────
const _botState = {
    waConnected:   false,
    startTime:     Date.now(),
    lastUpdate:    null,
    pendingUpdate: false,
};
function setBotConnected(connected) { _botState.waConnected = connected; }

// ─── GitHub Webhook signature ─────────────────────────────────
function _verifyGithubSig(req, body) {
    const secret = config.updater.WEBHOOK_SECRET;
    if (!secret) return true;
    const sig      = req.headers['x-hub-signature-256'] || '';
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
            if (res) res.json({ ok: false, error: err.message, stderr: stderr.slice(0, 500) });
        } else {
            _pushLog('[UPDATER] ✅ Update complete. Bot restarting...');
            if (res) res.json({ ok: true, output: stdout.slice(0, 1000) });
        }
    });
}

// ════════════════════════════════════════════════════════════════
//  SHARED HTML HELPERS
// ════════════════════════════════════════════════════════════════
function _html(title, body) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Apex-MD</title>
<style>
  :root{--bg:#0d1117;--card:#161b22;--border:#30363d;--accent:#58a6ff;--green:#3fb950;--red:#f85149;--yellow:#d29922;--purple:#bc8cff;--text:#c9d1d9;--text2:#8b949e;--font:'Segoe UI',system-ui,sans-serif}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);color:var(--text);font-family:var(--font);min-height:100vh}
  a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
  .nav{background:var(--card);border-bottom:1px solid var(--border);padding:0 20px;display:flex;align-items:center;gap:16px;height:56px;position:sticky;top:0;z-index:100;flex-wrap:wrap}
  .nav .logo{font-weight:700;font-size:1.05rem;color:#fff;display:flex;align-items:center;gap:8px;flex-shrink:0}
  .nav-links{display:flex;gap:2px;margin-left:auto;flex-wrap:wrap}
  .nav-links a{padding:5px 11px;border-radius:6px;font-size:.83rem;color:var(--text2);transition:.15s;white-space:nowrap}
  .nav-links a:hover,.nav-links a.active{background:#21262d;color:var(--text);text-decoration:none}
  .badge{background:var(--red);color:#fff;border-radius:99px;font-size:.65rem;padding:1px 5px;margin-left:3px;vertical-align:middle}
  .badge-green{background:var(--green)}
  .wrap{max-width:1300px;margin:0 auto;padding:24px 16px}
  h1{font-size:1.35rem;font-weight:600;margin-bottom:18px}
  h2{font-size:1rem;font-weight:600;margin-bottom:12px;color:var(--text)}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:24px}
  .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px}
  .grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:18px}
  .card-label{font-size:.75rem;color:var(--text2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px}
  .card-val{font-size:1.55rem;font-weight:700}
  .card-val.green{color:var(--green)}.card-val.red{color:var(--red)}.card-val.yellow{color:var(--yellow)}.card-val.blue{color:var(--accent)}.card-val.purple{color:var(--purple)}
  .card-sub{font-size:.75rem;color:var(--text2);margin-top:3px}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  th{text-align:left;padding:9px 11px;font-weight:600;color:var(--text2);border-bottom:1px solid var(--border)}
  td{padding:9px 11px;border-bottom:1px solid #21262d}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#1c2128}
  .pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:.72rem;font-weight:600}
  .pill.long{background:#1a3a2a;color:var(--green)}.pill.short{background:#3a1a1a;color:var(--red)}
  .pill.pending{background:#2a2a1a;color:var(--yellow)}.pill.active{background:#1a2a3a;color:var(--accent)}
  .pill.on{background:#1a3a2a;color:var(--green)}.pill.off{background:#3a1a1a;color:var(--red)}
  .pill.win{background:#1a3a2a;color:var(--green)}.pill.loss{background:#3a1a1a;color:var(--red)}.pill.be{background:#1a2a1a;color:var(--text2)}
  .log-box{background:#090d11;border:1px solid var(--border);border-radius:10px;height:340px;overflow-y:auto;padding:10px 13px;font-family:'Cascadia Code','Fira Code',monospace;font-size:.78rem;line-height:1.6}
  .log-box .log-warn{color:var(--yellow)}.log-box .log-error{color:var(--red)}.log-box .log-info{color:var(--text2)}.log-box .log-bot{color:var(--green)}
  .section{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:18px;margin-bottom:18px}
  .toggle-row{display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid #21262d}
  .toggle-row:last-child{border-bottom:none}
  .toggle-info h3{font-size:.92rem;font-weight:500;margin-bottom:2px}
  .toggle-info p{font-size:.78rem;color:var(--text2)}
  .toggle{position:relative;width:42px;height:23px;flex-shrink:0}
  .toggle input{opacity:0;width:0;height:0}
  .slider{position:absolute;inset:0;background:#333;border-radius:99px;cursor:pointer;transition:.25s}
  .slider:before{content:'';position:absolute;width:17px;height:17px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.25s}
  input:checked+.slider{background:var(--green)}
  input:checked+.slider:before{transform:translateX(19px)}
  .param-row{display:grid;grid-template-columns:1fr 150px;align-items:center;gap:14px;padding:11px 0;border-bottom:1px solid #21262d}
  .param-row:last-child{border-bottom:none}
  input[type=number]{background:#0d1117;border:1px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text);font-size:.88rem;width:100%}
  input[type=number]:focus{outline:none;border-color:var(--accent)}
  .btn{display:inline-flex;align-items:center;gap:5px;padding:7px 16px;border-radius:7px;font-size:.85rem;font-weight:500;cursor:pointer;border:none;transition:.15s}
  .btn-primary{background:var(--accent);color:#fff}.btn-primary:hover{background:#79b8ff}
  .btn-danger{background:var(--red);color:#fff}.btn-danger:hover{opacity:.85}
  .btn-success{background:var(--green);color:#fff}.btn-success:hover{opacity:.85}
  .btn-ghost{background:#21262d;color:var(--text);border:1px solid var(--border)}.btn-ghost:hover{background:#30363d}
  .btn-warn{background:#3a2e00;color:var(--yellow);border:1px solid var(--yellow)}.btn-warn:hover{background:#4a3a00}
  .update-out{background:#090d11;border:1px solid var(--border);border-radius:8px;padding:10px 13px;font-family:monospace;font-size:.78rem;max-height:180px;overflow-y:auto;display:none;margin-top:10px;white-space:pre-wrap}
  .login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center}
  .login-box{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:38px 34px;width:360px}
  .login-box h1{font-size:1.35rem;margin-bottom:5px;text-align:center}
  .login-box p{color:var(--text2);font-size:.85rem;text-align:center;margin-bottom:26px}
  .field{margin-bottom:15px}label{display:block;font-size:.8rem;color:var(--text2);margin-bottom:5px}
  input[type=password]{background:#0d1117;border:1px solid var(--border);border-radius:7px;padding:10px 12px;color:var(--text);font-size:.92rem;width:100%}
  input[type=password]:focus{outline:none;border-color:var(--accent)}
  .err{color:var(--red);font-size:.8rem;margin-top:4px}.msg-ok{color:var(--green);font-size:.8rem;margin-top:4px}
  .health-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:middle}
  .health-ok{background:var(--green)}.health-fail{background:var(--red)}.health-warn{background:var(--yellow)}.health-check{background:#555}
  .stat-row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #21262d;font-size:.88rem}
  .stat-row:last-child{border-bottom:none}
  .stat-val{font-weight:600}
  .save-toast{position:fixed;bottom:22px;right:22px;background:#1a3a2a;border:1px solid var(--green);color:var(--green);padding:9px 16px;border-radius:8px;font-size:.85rem;display:none;z-index:9999;animation:fadeIn .2s}
  .save-toast.err-toast{background:#3a1a1a;border-color:var(--red);color:var(--red)}
  @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  .param-key{font-size:.72rem;color:var(--text2);font-family:monospace}
  .param-hint{font-size:.73rem;color:var(--text2)}
  .param-unit{font-size:.75rem;color:var(--accent);margin-left:4px;font-weight:400}
  .pro-section{border:1px solid var(--border);border-radius:10px;margin-bottom:18px;overflow:hidden}
  .pro-section-header{padding:13px 18px;display:flex;align-items:center;gap:10px;background:#161b22;border-bottom:1px solid var(--border)}
  .pro-section-header h2{font-size:.92rem;font-weight:600;margin:0}
  .pro-section-header p{font-size:.75rem;color:var(--text2);margin:0;margin-left:auto}
  .pro-section-body{padding:0 18px}
  .pro-master{background:linear-gradient(135deg,#0d2137,#0d1117);border:1px solid var(--accent);border-radius:10px;padding:18px;margin-bottom:20px;display:flex;align-items:center;gap:18px}
  .pro-master-info h2{font-size:1rem;font-weight:700;color:var(--accent);margin-bottom:3px}
  .pro-master-info p{font-size:.8rem;color:var(--text2);max-width:460px}
  .pro-master .toggle{margin-left:auto}
  .pro-badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:.68rem;font-weight:700;background:linear-gradient(90deg,#58a6ff,#7c3aed);color:#fff;margin-left:5px;vertical-align:middle}
  .pro-disabled-overlay{opacity:.4;pointer-events:none;user-select:none}
  .scanner-ctrl{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  @media(max-width:768px){.grid-2,.grid-3{grid-template-columns:1fr}.grid{grid-template-columns:1fr 1fr}}
  @media(max-width:480px){.grid{grid-template-columns:1fr}.nav-links a{padding:5px 8px;font-size:.78rem}}
</style>
</head>
<body>${body}</body>
</html>`;
}

function _nav(active, pendingUpdate, scannerActive) {
    const upBadge  = pendingUpdate  ? '<span class="badge">!</span>'             : '';
    const scanBadge = scannerActive ? '<span class="badge badge-green">ON</span>' : '';
    return `
<nav class="nav">
  <div class="logo">📊 Apex-MD <span style="font-size:.7rem;background:#21262d;padding:2px 7px;border-radius:4px;color:var(--text2);font-weight:400">v${config.VERSION}</span></div>
  <div class="nav-links">
    <a href="/dashboard/"         class="${active==='home'    ?'active':''}">🏠 Dashboard</a>
    <a href="/dashboard/trades"   class="${active==='trades'  ?'active':''}">📋 Trades</a>
    <a href="/dashboard/stats"    class="${active==='stats'   ?'active':''}">📊 Stats</a>
    <a href="/dashboard/scanner"  class="${active==='scanner' ?'active':''}">🔍 Scanner${scanBadge}</a>
    <a href="/dashboard/settings" class="${active==='settings'?'active':''}">⚙️ Settings</a>
    <a href="/dashboard/updater"  class="${active==='updater' ?'active':''}">🔄 Updater${upBadge}</a>
    <a href="/dashboard/logout" class="btn btn-ghost" style="font-size:.78rem;padding:4px 10px">Logout</a>
  </div>
</nav>`;
}

// ════════════════════════════════════════════════════════════════
//  API HEALTH CHECK (called by /dashboard/api/health)
// ════════════════════════════════════════════════════════════════
async function checkApiHealth() {
    const results = {};

    // Binance
    try {
        await axios.get('https://fapi.binance.com/fapi/v1/ping', { timeout: 5000 });
        results.binance = { ok: true, label: 'Binance Futures' };
    } catch { results.binance = { ok: false, label: 'Binance Futures' }; }

    // GROQ
    if (config.GROQ_API) {
        try {
            await axios.get('https://api.groq.com/openai/v1/models', {
                headers: { Authorization: `Bearer ${config.GROQ_API}` }, timeout: 5000
            });
            results.groq = { ok: true, label: 'GROQ API' };
        } catch (e) {
            results.groq = { ok: e.response?.status === 401 ? false : true, label: 'GROQ API',
                warn: e.response?.status !== 401 };
        }
    } else {
        results.groq = { ok: false, label: 'GROQ API', missing: true };
    }

    // Gemini
    if (config.GEMINI_API) {
        try {
            await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${config.GEMINI_API}`, { timeout: 5000 });
            results.gemini = { ok: true, label: 'Gemini API' };
        } catch { results.gemini = { ok: false, label: 'Gemini API' }; }
    } else {
        results.gemini = { ok: false, label: 'Gemini API', missing: true };
    }

    // MongoDB
    try {
        const mongoose = require('mongoose');
        results.mongo = { ok: mongoose.connection.readyState === 1, label: 'MongoDB' };
    } catch { results.mongo = { ok: false, label: 'MongoDB' }; }

    // Binance Secret
    results.binanceSecret = {
        ok: Boolean(config.BINANCE_SECRET),
        label: 'Binance Secret Key',
        warn: !config.BINANCE_SECRET
    };

    return results;
}

// ════════════════════════════════════════════════════════════════
//  ROUTER
// ════════════════════════════════════════════════════════════════
function initDashboard() {
    const app  = express();
    const port = config.DASHBOARD_PORT;

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // ── Login ─────────────────────────────────────────────────
    app.get('/dashboard/login', (req, res) => {
        const err = req.query.err ? '<p class="err">❌ Incorrect password</p>' : '';
        const locked = req.query.locked ? '<p class="err">🔒 Too many attempts. Try again in 15 minutes.</p>' : '';
        res.send(_html('Login', `
<div class="login-wrap">
  <div class="login-box">
    <h1>🔐 Apex-MD</h1>
    <p>Web Control Panel — Owner Access Only</p>
    <form method="POST" action="/dashboard/login">
      <div class="field"><label>Password</label>
        <input type="password" name="password" placeholder="Enter dashboard password" autofocus required>
      </div>
      ${err}${locked}
      <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center">Sign In →</button>
    </form>
  </div>
</div>`));
    });

    app.post('/dashboard/login', (req, res) => {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        if (!_checkLoginRateLimit(ip)) {
            return res.redirect('/dashboard/login?locked=1');
        }
        const pw = (req.body.password || '').trim();
        if (pw !== config.DASHBOARD_PASSWORD) {
            return res.redirect('/dashboard/login?err=1');
        }
        _resetLoginLimit(ip);
        const token = _signToken({ exp: Date.now() + COOKIE_TTL, role: 'owner' });
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${COOKIE_TTL / 1000}; SameSite=Strict`);
        res.redirect('/dashboard/');
    });

    app.get('/dashboard/logout', (req, res) => {
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`);
        res.redirect('/dashboard/login');
    });

    app.use('/dashboard', (req, res, next) => {
        if (req.path === '/login' || (req.method === 'POST' && req.path === '/login')) return next();
        requireAuth(req, res, next);
    });

    // ── Main Dashboard ────────────────────────────────────────
    app.get('/dashboard/', async (req, res) => {
        let tradesHtml = '<tr><td colspan="8" style="text-align:center;color:var(--text2)">No active trades</td></tr>';
        let tradeCount = 0;
        try {
            const trades = await db.Trade.find({ status: { $in: ['active', 'pending'] } }).lean();
            tradeCount = trades.length;
            if (trades.length > 0) {
                tradesHtml = trades.map(t => {
                    const dir = t.direction === 'LONG' ? '<span class="pill long">LONG</span>' : '<span class="pill short">SHORT</span>';
                    const st  = t.status === 'pending' ? '<span class="pill pending">PENDING</span>' : '<span class="pill active">ACTIVE</span>';
                    const hrs = ((Date.now() - new Date(t.openTime)) / 3600000).toFixed(1);
                    const isPaper = t.isPaper ? '📄' : '💰';
                    return `<tr>
                        <td><strong>${t.coin}</strong> ${isPaper}</td>
                        <td>${dir}</td>
                        <td>$${parseFloat(t.entry).toFixed(4)}</td>
                        <td>$${parseFloat(t.tp2 || t.tp || 0).toFixed(4)}</td>
                        <td>$${parseFloat(t.sl || 0).toFixed(4)}</td>
                        <td>${t.leverage || 1}x</td>
                        <td>${st}</td>
                        <td>${hrs}h</td>
                    </tr>`;
                }).join('');
            }
        } catch (_) {}

        const uptime = Math.floor((Date.now() - _botState.startTime) / 60000);
        const uptimeStr = uptime >= 60 ? `${Math.floor(uptime/60)}h ${uptime%60}m` : `${uptime}m`;

        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}

        res.send(_html('Dashboard', `
${_nav('home', _botState.pendingUpdate, scannerActive)}
<div class="wrap">
  <h1>📊 Live Dashboard</h1>

  <div class="grid">
    <div class="card"><div class="card-label">WhatsApp</div>
      <div class="card-val ${_botState.waConnected ? 'green' : 'red'}" id="wa-status">${_botState.waConnected ? '🟢 Online' : '🔴 Offline'}</div>
      <div class="card-sub">Connection</div></div>
    <div class="card"><div class="card-label">Auto Scanner</div>
      <div class="card-val ${scannerActive ? 'green' : 'yellow'}" id="scanner-status">${scannerActive ? '🟢 Active' : '⚪ Standby'}</div>
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
    <div class="card"><div class="card-label">Pro Mode</div>
      <div class="card-val ${config.modules.PRO_MODE ? 'purple' : 'yellow'}">${config.modules.PRO_MODE ? '🔬 Custom' : '🤖 Auto AI'}</div>
      <div class="card-sub">Trade engine</div></div>
  </div>

  <!-- API Health Monitor -->
  <div class="section" style="margin-bottom:18px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <h2 style="margin:0">🔌 API Health Monitor</h2>
      <button class="btn btn-ghost" onclick="refreshHealth()" style="font-size:.78rem;padding:5px 10px">↺ Refresh</button>
    </div>
    <div id="health-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">
      <div style="color:var(--text2);font-size:.85rem">⏳ Checking APIs...</div>
    </div>
  </div>

  <div class="section">
    <h2>📋 Active Trades</h2>
    <div style="overflow-x:auto">
    <table>
      <thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP2</th><th>SL</th><th>Lev</th><th>Status</th><th>Open</th></tr></thead>
      <tbody id="trades-body">${tradesHtml}</tbody>
    </table>
    </div>
  </div>

  <div class="section">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <h2 style="margin:0">🖥️ Live Logs</h2>
      <button class="btn btn-ghost" onclick="clearLogs()" style="font-size:.78rem;padding:5px 10px">🗑️ Clear</button>
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
  const d = JSON.parse(e.data), el = document.createElement('div'), msg = d.msg || '';
  el.className = 'log-' + (msg.includes('[ERROR]') ? 'error' : msg.includes('[WARN]') ? 'warn' : msg.includes('[BOT]') ? 'bot' : 'info');
  el.textContent = new Date(d.ts).toLocaleTimeString() + '  ' + msg;
  lb.appendChild(el);
  if (autoScroll) lb.scrollTop = lb.scrollHeight;
};
es.onerror = () => { const el = document.createElement('div'); el.className='log-warn'; el.textContent='[Stream disconnected — reload]'; lb.appendChild(el); };
function clearLogs() { lb.innerHTML = ''; }

setInterval(async () => {
  try {
    const d = await (await fetch('/dashboard/api/status')).json();
    document.getElementById('wa-status').textContent  = d.waConnected ? '🟢 Online' : '🔴 Offline';
    document.getElementById('wa-status').className    = 'card-val ' + (d.waConnected ? 'green' : 'red');
    document.getElementById('scanner-status').textContent = d.scannerActive ? '🟢 Active' : '⚪ Standby';
    document.getElementById('trade-count').textContent = d.tradeCount;
    document.getElementById('uptime').textContent = d.uptime;
  } catch(_) {}
}, 10000);

async function refreshHealth() {
  const g = document.getElementById('health-grid');
  g.innerHTML = '<div style="color:var(--text2);font-size:.85rem">⏳ Checking...</div>';
  try {
    const h = await (await fetch('/dashboard/api/health')).json();
    g.innerHTML = Object.values(h).map(s => {
      const cls  = s.missing ? 'health-warn' : (s.ok ? 'health-ok' : 'health-fail');
      const text = s.missing ? '⚠️ Not configured' : (s.ok ? '✅ Online' : (s.warn ? '⚠️ Warning' : '❌ Offline'));
      return '<div style="background:#0d1117;border:1px solid var(--border);border-radius:8px;padding:12px 14px">' +
        '<span class="health-dot ' + cls + '"></span><strong style="font-size:.88rem">' + s.label + '</strong>' +
        '<div style="font-size:.78rem;color:var(--text2);margin-top:3px">' + text + '</div></div>';
    }).join('');
  } catch { g.innerHTML = '<div style="color:var(--red)">❌ Health check failed</div>'; }
}
refreshHealth();
</script>`));
    });

    // ── Trades Page ───────────────────────────────────────────
    app.get('/dashboard/trades', async (req, res) => {
        let activeHtml = '<tr><td colspan="8" style="text-align:center;color:var(--text2)">No active trades</td></tr>';
        let closedHtml = '<tr><td colspan="8" style="text-align:center;color:var(--text2)">No closed trades</td></tr>';
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        try {
            const active = await db.Trade.find({ status: { $in: ['active', 'pending'] } }).sort({ openTime: -1 }).lean();
            if (active.length) {
                activeHtml = active.map(t => {
                    const dir = t.direction === 'LONG' ? '<span class="pill long">LONG</span>' : '<span class="pill short">SHORT</span>';
                    const st  = t.status === 'pending' ? '<span class="pill pending">PENDING</span>' : '<span class="pill active">ACTIVE</span>';
                    const hrs = ((Date.now() - new Date(t.openTime)) / 3600000).toFixed(1);
                    return `<tr><td><strong>${t.coin}</strong>${t.isPaper ? ' 📄' : ''}</td><td>${dir}</td>
                    <td>$${parseFloat(t.entry).toFixed(4)}</td><td>$${parseFloat(t.tp1||0).toFixed(4)}</td>
                    <td>$${parseFloat(t.tp2||t.tp||0).toFixed(4)}</td><td>$${parseFloat(t.sl||0).toFixed(4)}</td>
                    <td>${t.leverage||1}x</td><td>${st} ${hrs}h</td></tr>`;
                }).join('');
            }
            const closed = await db.Trade.find({ status: 'closed' }).sort({ closedAt: -1 }).limit(50).lean();
            if (closed.length) {
                closedHtml = closed.map(t => {
                    const dir = t.direction === 'LONG' ? '<span class="pill long">LONG</span>' : '<span class="pill short">SHORT</span>';
                    const res = t.result === 'WIN' ? '<span class="pill win">WIN</span>' : t.result === 'LOSS' ? '<span class="pill loss">LOSS</span>' : '<span class="pill be">B/E</span>';
                    const pnl = t.pnlPct ? (t.pnlPct > 0 ? '+' : '') + parseFloat(t.pnlPct).toFixed(2) + '%' : '—';
                    const pnlColor = t.pnlPct > 0 ? 'var(--green)' : t.pnlPct < 0 ? 'var(--red)' : 'var(--text2)';
                    const dt = t.closedAt ? new Date(t.closedAt).toLocaleDateString() : '—';
                    return `<tr><td><strong>${t.coin}</strong>${t.isPaper ? ' 📄' : ''}</td><td>${dir}</td>
                    <td>$${parseFloat(t.entry).toFixed(4)}</td><td>$${parseFloat(t.tp2||t.tp||0).toFixed(4)}</td>
                    <td>$${parseFloat(t.sl||0).toFixed(4)}</td><td>${res}</td>
                    <td style="color:${pnlColor};font-weight:600">${pnl}</td><td>${dt}</td></tr>`;
                }).join('');
            }
        } catch (_) {}

        res.send(_html('Trades', `
${_nav('trades', _botState.pendingUpdate, scannerActive)}
<div class="wrap">
  <h1>📋 Trade History</h1>
  <div class="section">
    <h2>⚡ Active & Pending Trades</h2>
    <div style="overflow-x:auto">
    <table><thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP1</th><th>TP2</th><th>SL</th><th>Lev</th><th>Status</th></tr></thead>
    <tbody>${activeHtml}</tbody></table>
    </div>
  </div>
  <div class="section">
    <h2>📜 Closed Trades (Last 50)</h2>
    <div style="overflow-x:auto">
    <table><thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP2</th><th>SL</th><th>Result</th><th>PnL%</th><th>Date</th></tr></thead>
    <tbody>${closedHtml}</tbody></table>
    </div>
  </div>
</div>`));
    });

    // ── Stats Page ────────────────────────────────────────────
    app.get('/dashboard/stats', async (req, res) => {
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        let stats = null, paperStats = null;
        try {
            const closed = await db.Trade.find({ status: 'closed', isPaper: false }).lean();
            const pClosed = await db.Trade.find({ status: 'closed', isPaper: true }).lean();

            const calcStats = (arr) => {
                if (!arr.length) return null;
                const wins = arr.filter(t => t.result === 'WIN').length;
                const loss = arr.filter(t => t.result === 'LOSS').length;
                const totalPnl = arr.reduce((s, t) => s + (t.pnlPct || 0), 0);
                const best  = arr.reduce((b, t) => (t.pnlPct||0) > (b?.pnlPct||0) ? t : b, null);
                const worst = arr.reduce((w, t) => (t.pnlPct||0) < (w?.pnlPct||0) ? t : w, null);
                const wr = arr.length > 0 ? ((wins / arr.length) * 100).toFixed(1) : '0';
                return { total: arr.length, wins, loss, wr, totalPnl: totalPnl.toFixed(2), best, worst };
            };

            stats = calcStats(closed);
            paperStats = calcStats(pClosed);
        } catch (_) {}

        const statBlock = (s, title, emoji) => {
            if (!s) return `<div class="section"><h2>${emoji} ${title}</h2><p style="color:var(--text2);font-size:.88rem">No closed trades yet.</p></div>`;
            const pnlColor = parseFloat(s.totalPnl) >= 0 ? 'var(--green)' : 'var(--red)';
            const wrColor  = parseFloat(s.wr) >= 55 ? 'var(--green)' : parseFloat(s.wr) >= 45 ? 'var(--yellow)' : 'var(--red)';
            return `
<div class="section">
  <h2>${emoji} ${title}</h2>
  <div class="grid" style="margin-bottom:14px">
    <div class="card"><div class="card-label">Total Trades</div><div class="card-val blue">${s.total}</div></div>
    <div class="card"><div class="card-label">Win Rate</div><div class="card-val" style="color:${wrColor}">${s.wr}%</div></div>
    <div class="card"><div class="card-label">Wins / Losses</div><div class="card-val green">${s.wins}</div><div class="card-sub" style="color:var(--red)">${s.loss} losses</div></div>
    <div class="card"><div class="card-label">Total PnL</div><div class="card-val" style="color:${pnlColor}">${parseFloat(s.totalPnl) >= 0 ? '+' : ''}${s.totalPnl}%</div></div>
  </div>
  <div class="stat-row"><span>🏆 Best Trade</span><span class="stat-val" style="color:var(--green)">${s.best ? s.best.coin + ' +' + (s.best.pnlPct||0).toFixed(2) + '%' : '—'}</span></div>
  <div class="stat-row"><span>💀 Worst Trade</span><span class="stat-val" style="color:var(--red)">${s.worst ? s.worst.coin + ' ' + (s.worst.pnlPct||0).toFixed(2) + '%' : '—'}</span></div>
  <div class="stat-row"><span>📊 Avg PnL per Trade</span><span class="stat-val">${(parseFloat(s.totalPnl) / s.total).toFixed(2)}%</span></div>
</div>`;
        };

        res.send(_html('Stats', `
${_nav('stats', _botState.pendingUpdate, scannerActive)}
<div class="wrap">
  <h1>📊 Performance Statistics</h1>
  ${statBlock(stats,       'Real Trading Stats',  '💰')}
  ${statBlock(paperStats,  'Paper Trading Stats', '📄')}
</div>`));
    });

    // ── Scanner Control Page ──────────────────────────────────
    app.get('/dashboard/scanner', async (req, res) => {
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}

        res.send(_html('Scanner', `
${_nav('scanner', _botState.pendingUpdate, scannerActive)}
<div class="wrap">
  <h1>🔍 Scanner Control</h1>

  <div class="section">
    <h2>⚡ Auto Scanner</h2>
    <p style="font-size:.85rem;color:var(--text2);margin-bottom:16px">
      Event-driven WebSocket scanner. Monitors ${config.trading.WS_WATCH_COUNT} top coins on 15m candle closes.
      No REST polling — minimal server load.
    </p>
    <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:18px">
      <div>
        <span style="font-size:.85rem;color:var(--text2)">Status: </span>
        <span id="scan-stat" class="pill ${scannerActive ? 'on' : 'off'}" style="font-size:.85rem">${scannerActive ? '🟢 ACTIVE' : '⚪ STANDBY'}</span>
      </div>
    </div>
    <div class="scanner-ctrl">
      <button class="btn btn-success" id="btn-start" onclick="scannerCtrl('start')" ${scannerActive ? 'disabled' : ''}>▶ Start Scanner</button>
      <button class="btn btn-danger"  id="btn-stop"  onclick="scannerCtrl('stop')"  ${!scannerActive ? 'disabled' : ''}>⏹ Stop Scanner</button>
    </div>
    <div id="scan-msg" style="margin-top:12px;font-size:.85rem"></div>
    <p style="font-size:.78rem;color:var(--text2);margin-top:12px">
      ⚠️ Scanner requires WhatsApp to be connected to send signal alerts.<br>
      Minimum score threshold: <strong>${config.trading.MIN_SCORE_THRESHOLD}/100</strong> | Signal cooldown: <strong>${config.trading.SIGNAL_COOLDOWN_HOURS}h</strong>
    </p>
  </div>

  <div class="section">
    <h2>📈 Scanner Settings</h2>
    <div class="stat-row"><span>Watched Coins</span><span class="stat-val">${config.trading.WS_WATCH_COUNT}</span></div>
    <div class="stat-row"><span>Min Signal Score</span><span class="stat-val">${config.trading.MIN_SCORE_THRESHOLD}/100</span></div>
    <div class="stat-row"><span>Signal Cooldown</span><span class="stat-val">${config.trading.SIGNAL_COOLDOWN_HOURS}h</span></div>
    <div class="stat-row"><span>Max Open Trades</span><span class="stat-val">${config.trading.MAX_OPEN_TRADES}</span></div>
    <div class="stat-row"><span>SMC Scoring</span><span class="stat-val">${config.modules.SMC ? '✅ Enabled' : '❌ Disabled'}</span></div>
    <div class="stat-row"><span>Bybit Cross-Exchange</span><span class="stat-val">${config.modules.BYBIT ? '✅ Enabled' : '❌ Disabled'}</span></div>
    <p style="font-size:.78rem;color:var(--text2);margin-top:12px">Change these in <a href="/dashboard/settings">⚙️ Settings</a></p>
  </div>
</div>
<script>
async function scannerCtrl(action) {
  document.getElementById('scan-msg').textContent = action === 'start' ? '⏳ Starting scanner...' : '⏳ Stopping scanner...';
  try {
    const r = await fetch('/dashboard/api/scanner/' + action, { method: 'POST' });
    const d = await r.json();
    document.getElementById('scan-msg').textContent = d.ok ? (action === 'start' ? '✅ Scanner started!' : '✅ Scanner stopped.') : '❌ ' + d.error;
    document.getElementById('scan-msg').style.color = d.ok ? 'var(--green)' : 'var(--red)';
    if (d.ok) {
      const on = action === 'start';
      document.getElementById('scan-stat').textContent = on ? '🟢 ACTIVE' : '⚪ STANDBY';
      document.getElementById('scan-stat').className   = 'pill ' + (on ? 'on' : 'off');
      document.getElementById('btn-start').disabled = on;
      document.getElementById('btn-stop').disabled  = !on;
    }
  } catch(e) { document.getElementById('scan-msg').textContent = '❌ Network error'; }
}
</script>`));
    });

    // ── Settings Page ─────────────────────────────────────────
    app.get('/dashboard/settings', (req, res) => {
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        const m   = config.modules         || {};
        const t   = config.trading         || {};
        const pr  = m.PRO_MODE             || false;
        const ind = config.indicatorParams || {};
        const smc = config.smcParams       || {};
        const tgt = config.targetParams    || {};

        const iv   = (obj, key, def) => obj[key] !== undefined ? obj[key] : def;
        const tv   = (key, def) => iv(t,   key, def);
        const indv = (key, def) => iv(ind, key, def);
        const smcv = (key, def) => iv(smc, key, def);
        const tgtv = (key, def) => iv(tgt, key, def);

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
  <div><strong>${label}</strong>${unit ? `<span class="param-unit">${unit}</span>` : ''}<br>
  <span class="param-key">${key}</span></div>
  <input type="number" value="${val}" min="${min}" max="${max}" step="${step}" onchange="setTradingParam('${key}',this.value)">
</div>`;

        const indRow = (key, label, val, min, max, step, unit = '', hint = '') => `
<div class="param-row pro-param">
  <div><strong>${label}</strong>${unit ? `<span class="param-unit">${unit}</span>` : ''}
  ${hint ? `<br><span class="param-hint">${hint}</span>` : ''}<br>
  <span class="param-key">${key}</span></div>
  <input type="number" value="${val}" min="${min}" max="${max}" step="${step}"
    onchange="setIndicatorParam('${key}',this.value)" ${pr ? '' : 'disabled'}>
</div>`;

        const smcRow = (key, label, val, min, max, step, unit = '', hint = '') => `
<div class="param-row pro-param">
  <div><strong>${label}</strong>${unit ? `<span class="param-unit">${unit}</span>` : ''}
  ${hint ? `<br><span class="param-hint">${hint}</span>` : ''}<br>
  <span class="param-key">${key}</span></div>
  <input type="number" value="${val}" min="${min}" max="${max}" step="${step}"
    onchange="setSMCParam('${key}',this.value)" ${pr ? '' : 'disabled'}>
</div>`;

        const tgtRow = (key, label, val, min, max, step, unit = '', hint = '') => `
<div class="param-row pro-param">
  <div><strong>${label}</strong>${unit ? `<span class="param-unit">${unit}</span>` : ''}
  ${hint ? `<br><span class="param-hint">${hint}</span>` : ''}<br>
  <span class="param-key">${key}</span></div>
  <input type="number" value="${val}" min="${min}" max="${max}" step="${step}"
    onchange="setTargetParam('${key}',this.value)" ${pr ? '' : 'disabled'}>
</div>`;

        res.send(_html('Settings', `
${_nav('settings', _botState.pendingUpdate, scannerActive)}
<style>
  .param-key{font-size:.7rem;color:var(--text2);font-family:monospace}
  .param-hint{font-size:.72rem;color:var(--text2)}
  .param-unit{font-size:.73rem;color:var(--accent);margin-left:4px;font-weight:400}
  .pro-disabled-overlay{opacity:.4;pointer-events:none;user-select:none}
  @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  .save-toast{position:fixed;bottom:22px;right:22px;background:#1a3a2a;border:1px solid var(--green);color:var(--green);padding:9px 16px;border-radius:8px;font-size:.85rem;display:none;z-index:9999;animation:fadeIn .2s}
  .save-toast.err-toast{background:#3a1a1a;border-color:var(--red);color:var(--red)}
</style>
<div class="wrap" style="max-width:1300px">
  <h1>⚙️ Settings</h1>

  <div class="pro-master">
    <div style="font-size:1.8rem">🎛️</div>
    <div class="pro-master-info">
      <h2>Pro Custom Mode <span class="pro-badge">PRO</span></h2>
      <p>Override every indicator and strategy parameter. OFF = bot uses optimal built-in values automatically.</p>
    </div>
    <label class="toggle" style="width:50px;height:27px;margin-left:auto">
      <input type="checkbox" id="pro-toggle" ${pr ? 'checked' : ''} onchange="toggleProMode(this.checked)">
      <span class="slider"></span>
    </label>
  </div>

  <div class="grid-2" style="margin-bottom:18px">
    <div class="section">
      <h2>🧩 Module Toggles</h2>
      ${modToggle('AI_MODEL',        '🤖 AI Model',         'Local Python LSTM prediction server',       m.AI_MODEL)}
      ${modToggle('BYBIT',           '🐳 Bybit Layer',      'Cross-exchange OB + volume validation',     m.BYBIT)}
      ${modToggle('DYNAMIC_WEIGHTS', '🧠 Dynamic Weights',  'ADX/ATR-based adaptive score multipliers',  m.DYNAMIC_WEIGHTS)}
      ${modToggle('SMC',             '🔮 SMC Scoring',      'ChoCH, Sweep, OB, Wyckoff, BOS, Breakers', m.SMC)}
    </div>
    <div class="section">
      <h2>💼 Core Trading Parameters</h2>
      ${tradingRow('DEFAULT_RISK_PCT',      '💰 Risk per Trade',     tv('DEFAULT_RISK_PCT',2),      0.1, 10,    0.1, '%')}
      ${tradingRow('DEFAULT_LEVERAGE',      '⚡ Default Leverage',   tv('DEFAULT_LEVERAGE',10),     1,   125,   1,   'x')}
      ${tradingRow('MAX_OPEN_TRADES',       '📂 Max Open Trades',    tv('MAX_OPEN_TRADES',5),       1,   20,    1)}
      ${tradingRow('MIN_SCORE_THRESHOLD',   '📊 Min Signal Score',   tv('MIN_SCORE_THRESHOLD',20),  5,   80,    1)}
      ${tradingRow('SIGNAL_COOLDOWN_HOURS', '⏱️ Signal Cooldown',    tv('SIGNAL_COOLDOWN_HOURS',4), 0.5, 48,    0.5, 'hr')}
      ${tradingRow('WS_WATCH_COUNT',        '🪙 Watched Coins',      tv('WS_WATCH_COUNT',30),       5,   100,   1)}
    </div>
  </div>

  <div id="pro-panels" class="${pr ? '' : 'pro-disabled-overlay'}">
    <div class="grid-2" style="margin-bottom:18px">
      <div class="pro-section">
        <div class="pro-section-header"><span>📈</span><h2>Trend & Momentum</h2><p>RSI · EMA · ADX</p></div>
        <div class="pro-section-body">
          ${indRow('RSI_PERIOD',    'RSI Period',      indv('RSI_PERIOD',14),    2,   50,  1, 'bars')}
          ${indRow('FAST_EMA',      'Fast EMA',        indv('FAST_EMA',50),      2,   200, 1, 'bars')}
          ${indRow('SLOW_EMA',      'Slow EMA',        indv('SLOW_EMA',200),     10,  500, 5, 'bars')}
          ${indRow('ADX_CHOPPY',    'ADX Choppy',      indv('ADX_CHOPPY',20),    5,   40,  1, '', 'ADX < this = sideways')}
          ${indRow('ADX_TRENDING',  'ADX Trending',    indv('ADX_TRENDING',25),  10,  60,  1, '', 'ADX > this = trending')}
        </div>
      </div>
      <div class="pro-section">
        <div class="pro-section-header"><span>🔮</span><h2>Smart Money (SMC)</h2><p>OB · Sweep · FVG</p></div>
        <div class="pro-section-body">
          ${smcRow('OB_LOOKBACK',        'OB Lookback',         smcv('OB_LOOKBACK',10),         3,  60,  1, 'bars')}
          ${smcRow('FVG_MIN_PCT',        'FVG Min Size',        smcv('FVG_MIN_PCT',0.1),         0.01, 2, 0.01, '%')}
          ${smcRow('SWEEP_BUFFER',       'Sweep Buffer',        smcv('SWEEP_BUFFER',0.5),        0.1, 5,  0.1, '%')}
        </div>
      </div>
    </div>
    <div class="grid-2" style="margin-bottom:18px">
      <div class="pro-section">
        <div class="pro-section-header"><span>🎯</span><h2>Risk & Targets</h2><p>TP · SL · RRR</p></div>
        <div class="pro-section-body">
          ${tgtRow('TP1_MULT', 'TP1 Multiplier', tgtv('TP1_MULT',1.0), 0.3, 20,  0.1, ':1 RRR')}
          ${tgtRow('TP2_MULT', 'TP2 Multiplier', tgtv('TP2_MULT',2.0), 0.5, 30,  0.1, ':1 RRR')}
          ${tgtRow('TP3_MULT', 'TP3 Multiplier', tgtv('TP3_MULT',3.0), 1,   50,  0.5, ':1 RRR')}
          ${tgtRow('SL_BUFFER', 'SL Buffer',     tgtv('SL_BUFFER',0.5),0.1, 5,   0.1, '%')}
        </div>
      </div>
      <div class="section">
        <h2>🔔 Daily Report</h2>
        <div class="toggle-row">
          <div class="toggle-info"><h3>📊 Auto Daily P&L Report</h3><p>Send P&L summary to owner every day at midnight UTC</p></div>
          <label class="toggle">
            <input type="checkbox" ${config.dailyReport?.ENABLED !== false ? 'checked' : ''} onchange="toggleMod('DAILY_REPORT',this.checked)">
            <span class="slider"></span>
          </label>
        </div>
        <div style="margin-top:12px;font-size:.82rem;color:var(--text2)">
          ℹ️ Report time: Midnight UTC (${config.dailyReport?.HOUR_UTC || 0}:00 UTC)<br>
          Change <code>DAILY_REPORT_HOUR_UTC</code> in config.env to adjust.
        </div>
      </div>
    </div>
  </div>
</div>
<div class="save-toast" id="toast"></div>
<script>
function showToast(msg, isErr=false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'save-toast' + (isErr ? ' err-toast' : '');
  t.style.display = 'block'; clearTimeout(t._tid);
  t._tid = setTimeout(() => { t.style.display='none'; }, 2800);
}
async function apiPost(url, body) {
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  return r.json();
}
async function toggleProMode(val) {
  const d = await apiPost('/dashboard/api/promode', { enabled: val });
  if (d.ok) {
    showToast('🎛️ Pro Custom Mode → ' + (val ? 'ON ✅' : 'OFF'));
    document.querySelectorAll('.pro-param input').forEach(el => el.disabled = !val);
    document.getElementById('pro-panels').classList.toggle('pro-disabled-overlay', !val);
  } else { showToast('❌ ' + d.error, true); document.getElementById('pro-toggle').checked = !val; }
}
async function toggleMod(id, val) {
  const d = await apiPost('/dashboard/api/modules/' + id, { enabled: val });
  showToast(d.ok ? '✅ ' + id + ' → ' + (val ? 'ON' : 'OFF') : '❌ ' + d.error, !d.ok);
}
async function setTradingParam(key, val) {
  const d = await apiPost('/dashboard/api/params/' + key, { value: parseFloat(val) });
  showToast(d.ok ? '✅ ' + key + ' = ' + val : '❌ ' + d.error, !d.ok);
}
async function setIndicatorParam(key, val) {
  const d = await apiPost('/dashboard/api/indicators/' + key, { value: parseFloat(val) });
  showToast(d.ok ? '📈 ' + key + ' = ' + val : '❌ ' + d.error, !d.ok);
}
async function setSMCParam(key, val) {
  const d = await apiPost('/dashboard/api/smc/' + key, { value: parseFloat(val) });
  showToast(d.ok ? '🔮 ' + key + ' = ' + val : '❌ ' + d.error, !d.ok);
}
async function setTargetParam(key, val) {
  const d = await apiPost('/dashboard/api/targets/' + key, { value: parseFloat(val) });
  showToast(d.ok ? '🎯 ' + key + ' = ' + val : '❌ ' + d.error, !d.ok);
}
</script>`));
    });

    // ── Auto Updater Page ─────────────────────────────────────
    app.get('/dashboard/updater', (req, res) => {
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        const enabled = config.updater.ENABLED;
        const pending = _botState.pendingUpdate;
        res.send(_html('Updater', `
${_nav('updater', pending, scannerActive)}
<div class="wrap">
  <h1>🔄 Auto Updater</h1>
  ${pending ? '<div class="section" style="border-color:var(--yellow)"><p style="color:var(--yellow)">⚠️ <strong>New update available</strong> — auto-update is OFF. Click "Pull Update" to apply manually.</p></div>' : ''}
  <div class="grid-2">
    <div class="section">
      <h2>🔧 Update Controls</h2>
      <div class="toggle-row">
        <div class="toggle-info"><h3>Auto-Update</h3><p>Automatically apply updates on git push events</p></div>
        <label class="toggle">
          <input type="checkbox" id="auto-toggle" ${enabled ? 'checked' : ''} onchange="setAutoUpdate(this.checked)">
          <span class="slider"></span>
        </label>
      </div>
      <div style="margin-top:18px;display:flex;flex-direction:column;gap:10px">
        <button class="btn btn-primary" onclick="runUpdate()">🔄 Pull Update Now</button>
        <p style="font-size:.78rem;color:var(--text2)">Runs: <code>git pull && npm install && pm2 restart ${config.updater.PM2_APP_NAME}</code></p>
        <p style="font-size:.78rem;color:var(--text2)">PM2 App: <strong>${config.updater.PM2_APP_NAME}</strong></p>
        ${config.updater.WEBHOOK_SECRET ? '<p style="font-size:.78rem;color:var(--green)">✅ Webhook secret configured</p>' : '<p style="font-size:.78rem;color:var(--yellow)">⚠️ No GITHUB_WEBHOOK_SECRET set</p>'}
      </div>
      <div class="update-out" id="update-out"></div>
      <div id="update-msg" style="margin-top:8px;font-size:.85rem"></div>
    </div>
    <div class="section">
      <h2>📋 Update Info</h2>
      <div class="stat-row"><span>Last Update</span><span class="stat-val">${_botState.lastUpdate || 'Never'}</span></div>
      <div class="stat-row"><span>Bot Version</span><span class="stat-val">${config.VERSION}</span></div>
      <p style="font-size:.85rem;margin:14px 0 8px;color:var(--text2)">GitHub Webhook URL:</p>
      <code style="background:#090d11;padding:8px 11px;border-radius:6px;display:block;font-size:.78rem;word-break:break-all">http://YOUR_VPS_IP:${port}/dashboard/webhook/update</code>
      <p style="font-size:.75rem;color:var(--text2);margin-top:8px">Paste this in GitHub repo → Settings → Webhooks → Content-Type: application/json</p>
    </div>
  </div>
</div>
<script>
async function setAutoUpdate(val) {
  const r = await fetch('/dashboard/api/autoupdate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enabled: val }) });
  const d = await r.json();
  const msg = document.getElementById('update-msg');
  msg.textContent = d.ok ? '✅ Auto-update ' + (val ? 'enabled' : 'disabled') : '❌ ' + d.error;
  msg.className   = d.ok ? 'msg-ok' : 'err';
}
async function runUpdate() {
  const msg = document.getElementById('update-msg'), out = document.getElementById('update-out');
  msg.textContent = '🔄 Starting update... this may take 60s...'; msg.className = '';
  out.style.display = 'block'; out.textContent = 'Running...';
  try {
    const d = await (await fetch('/dashboard/api/update', { method:'POST' })).json();
    out.textContent = d.ok ? (d.output || 'Done.') : ('Error: ' + d.error + '\n' + (d.stderr||''));
    msg.textContent = d.ok ? '✅ Update complete — bot restarting' : '❌ Update failed';
    msg.className   = d.ok ? 'msg-ok' : 'err';
  } catch(e) { out.textContent = 'Network error: ' + e.message; }
}
</script>`));
    });

    // ════════════════════════════════════════════════════════
    //  REST API ENDPOINTS
    // ════════════════════════════════════════════════════════

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

    app.get('/dashboard/api/health', requireAuth, async (req, res) => {
        try { res.json(await checkApiHealth()); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/dashboard/api/logs/stream', requireAuth, (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        _logBuffer.slice(-50).forEach(entry => res.write(`data: ${JSON.stringify(entry)}\n\n`));
        _sseClients.add(res);
        req.on('close', () => _sseClients.delete(res));
    });

    // Scanner start/stop
    app.post('/dashboard/api/scanner/:action', requireAuth, async (req, res) => {
        try {
            const action = req.params.action;
            const scanner = require('./plugins/scanner');
            if (action === 'start') {
                // We need a conn reference — use stored global if available
                const started = typeof scanner.startScannerFromSettings === 'function'
                    ? await scanner.startScannerFromSettings(global._botConn, config.OWNER_NUMBER + '@s.whatsapp.net')
                    : false;
                res.json({ ok: true, started });
            } else if (action === 'stop') {
                const stopped = typeof scanner.stopScannerFromSettings === 'function'
                    ? scanner.stopScannerFromSettings()
                    : false;
                res.json({ ok: true, stopped });
            } else {
                res.status(400).json({ ok: false, error: 'Unknown action' });
            }
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    app.post('/dashboard/api/modules/:name', requireAuth, async (req, res) => {
        try {
            const name    = req.params.name.toUpperCase();
            const enabled = Boolean(req.body.enabled);
            config.toggleModule(name, enabled);
            const dbKey = { AI_MODEL: 'aiModel', BYBIT: 'bybit', DYNAMIC_WEIGHTS: 'dynamicWeights', SMC: 'smcEnabled' }[name];
            if (dbKey) await db.updateSettings({ [dbKey]: enabled }).catch(() => {});
            res.json({ ok: true, module: name, enabled });
        } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    app.post('/dashboard/api/params/:key', requireAuth, async (req, res) => {
        try {
            const key = req.params.key;
            const val = parseFloat(req.body.value);
            if (isNaN(val)) throw new Error('Invalid number');
            config.setTradingParam(key, val);
            const dbMap = { DEFAULT_RISK_PCT: 'defaultRisk', MIN_SCORE_THRESHOLD: 'minScore', MAX_OPEN_TRADES: 'maxTrades' };
            if (dbMap[key]) await db.updateSettings({ [dbMap[key]]: val }).catch(() => {});
            res.json({ ok: true, key, value: val });
        } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    app.post('/dashboard/api/promode', requireAuth, async (req, res) => {
        try {
            config.setProMode(Boolean(req.body.enabled));
            await db.updateSettings({ proMode: req.body.enabled }).catch(() => {});
            res.json({ ok: true, proMode: config.modules.PRO_MODE });
        } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    // ✅ FIX: These now route to real config functions that actually exist
    app.post('/dashboard/api/indicators/:key', requireAuth, async (req, res) => {
        try {
            const val = parseFloat(req.body.value);
            if (isNaN(val)) throw new Error('Invalid number');
            config.setIndicatorParam(req.params.key, val);
            await db.updateSettings({ [`ind_${req.params.key}`]: val }).catch(() => {});
            res.json({ ok: true, key: req.params.key, value: val });
        } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    app.post('/dashboard/api/smc/:key', requireAuth, async (req, res) => {
        try {
            const val = parseFloat(req.body.value);
            if (isNaN(val)) throw new Error('Invalid number');
            config.setSMCParam(req.params.key, val);
            await db.updateSettings({ [`smc_${req.params.key}`]: val }).catch(() => {});
            res.json({ ok: true, key: req.params.key, value: val });
        } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    app.post('/dashboard/api/targets/:key', requireAuth, async (req, res) => {
        try {
            const val = parseFloat(req.body.value);
            if (isNaN(val)) throw new Error('Invalid number');
            config.setTargetParam(req.params.key, val);
            await db.updateSettings({ [`tgt_${req.params.key}`]: val }).catch(() => {});
            res.json({ ok: true, key: req.params.key, value: val });
        } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    app.post('/dashboard/api/autoupdate', requireAuth, (req, res) => {
        config.setAutoUpdate(Boolean(req.body.enabled));
        res.json({ ok: true, enabled: config.updater.ENABLED });
    });

    app.post('/dashboard/api/update', requireAuth, (req, res) => {
        runUpdate(res);
    });

    app.get('/dashboard/api/config', requireAuth, (req, res) => {
        res.json(config.getSnapshot());
    });

    app.get('/dashboard/api/trades', requireAuth, async (req, res) => {
        try {
            const trades = await db.Trade.find({ status: { $in: ['active', 'pending'] } }).lean();
            res.json({ ok: true, trades });
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    // GitHub Webhook
    app.post('/dashboard/webhook/update', express.raw({ type: 'application/json' }), (req, res) => {
        if (!_verifyGithubSig(req, req.body)) return res.status(401).json({ error: 'Invalid signature' });
        res.json({ ok: true });
        if (config.updater.ENABLED) {
            _pushLog('[WEBHOOK] 📦 GitHub push — running auto-update...');
            runUpdate(null);
        } else {
            _botState.pendingUpdate = true;
            _pushLog('[WEBHOOK] ⚠️ GitHub push — auto-update is OFF. Update via dashboard.');
        }
    });

    app.get('/dashboard', (req, res) => res.redirect('/dashboard/'));

    app.listen(port, () => {
        console.log(`\n🌐 [Dashboard] Running at http://localhost:${port}/dashboard/`);
        console.log(`🔐 [Dashboard] Password: ${config.DASHBOARD_PASSWORD}`);
    });

    return { setBotConnected, log };
}

module.exports = { initDashboard, setBotConnected, log };
