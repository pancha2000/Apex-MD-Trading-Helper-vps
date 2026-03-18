'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD v7.2 PRO VVIP  ·  dashboard.js
 *  ──────────────────────────────────────────────────────────────
 *  SAAS UPGRADE — Route Architecture:
 *
 *    /admin/*    → Super-Admin Panel (owner-only, password from config.env)
 *                  All former /dashboard/* routes moved here.
 *                  /dashboard/* redirects preserved for backward compat.
 *
 *    /auth/*     → Public Login / Register for SaaS users
 *                  POST /auth/login        — email + password
 *                  POST /auth/register     — username + email + password
 *                  GET  /auth/logout       — clears user session
 *
 *    /app/*      → User Portal (JWT-cookie protected)
 *                  GET  /app/              — dashboard home
 *                  GET  /app/trades        — personal trade history
 *                  GET  /app/settings      — API key management
 *
 *  Admin-only extras:
 *    GET  /admin/users             — SaaS user management list
 *    POST /admin/api/users/:id/status — suspend / reactivate user
 *
 *  ──────────────────────────────────────────────────────────────
 *  Original v7.1 fixes preserved:
 *    - Login brute-force rate limiting (5 attempts / 15 min)
 *    - setIndicatorParam/setSMCParam/setTargetParam fixed routing
 *    - API Health Monitor, Paper Trading Stats, Scanner control
 *    - Trade History tab, SSE log streaming
 * ════════════════════════════════════════════════════════════════
 */

const express  = require('express');
const crypto   = require('crypto');
const { exec } = require('child_process');
const path     = require('path');
const axios    = require('axios');

const config   = require('./config');
const db       = require('./lib/database');
const saasAuth = require('./lib/saas-auth');

// ─── Log Ring-Buffer (last 500 lines) ─────────────────────────────
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

// ─────────────────────────────────────────────────────────────────
//  ADMIN AUTH  (single-password, owner-only — unchanged from v7.1)
// ─────────────────────────────────────────────────────────────────
const ADMIN_COOKIE_NAME = 'apex_admin_session';
const ADMIN_COOKIE_TTL  = 8 * 60 * 60 * 1000;

function _signAdminToken(payload) {
    const data = JSON.stringify(payload);
    const sig  = crypto.createHmac('sha256', config.DASHBOARD_SECRET).update(data).digest('hex');
    return Buffer.from(data).toString('base64url') + '.' + sig;
}
function _verifyAdminToken(token) {
    try {
        const [dataPart, sig] = token.split('.');
        const data     = Buffer.from(dataPart, 'base64url').toString();
        const expected = crypto.createHmac('sha256', config.DASHBOARD_SECRET).update(data).digest('hex');
        if (sig.length !== expected.length) return null;
        if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
        const payload = JSON.parse(data);
        if (payload.exp < Date.now()) return null;
        return payload;
    } catch { return null; }
}
function _parseCookies(header) {
    const out = {};
    if (!header) return out;
    header.split(';').forEach(p => {
        const [k, ...v] = p.trim().split('=');
        out[k.trim()] = decodeURIComponent(v.join('='));
    });
    return out;
}

// Admin auth middleware
function requireAdminAuth(req, res, next) {
    const cookies = _parseCookies(req.headers.cookie);
    const token   = cookies[ADMIN_COOKIE_NAME];
    if (!token || !_verifyAdminToken(token)) {
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
        return res.redirect('/admin/login');
    }
    next();
}

// Admin brute-force limiter (5 attempts / 15 min)
const _adminLoginAttempts = new Map();
function _checkAdminRateLimit(ip) {
    const now  = Date.now();
    const data = _adminLoginAttempts.get(ip) || { count: 0, first: now };
    if (now - data.first > 15 * 60 * 1000) { _adminLoginAttempts.set(ip, { count: 1, first: now }); return true; }
    if (data.count >= 5) return false;
    data.count++;
    _adminLoginAttempts.set(ip, data);
    return true;
}
function _resetAdminLimit(ip) { _adminLoginAttempts.delete(ip); }

// ─────────────────────────────────────────────────────────────────
//  BOT STATE
// ─────────────────────────────────────────────────────────────────
const _botState = {
    waConnected: false, startTime: Date.now(),
    lastUpdate: null, pendingUpdate: false,
};
function setBotConnected(connected) { _botState.waConnected = connected; }

// ─────────────────────────────────────────────────────────────────
//  GITHUB WEBHOOK
// ─────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────
//  SHARED HTML HELPERS
// ─────────────────────────────────────────────────────────────────
const CSS_VARS = `
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
  h1{font-size:1.35rem;font-weight:600;margin-bottom:18px}h2{font-size:1rem;font-weight:600;margin-bottom:12px;color:var(--text)}
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
  td{padding:9px 11px;border-bottom:1px solid #21262d}tr:last-child td{border-bottom:none}tr:hover td{background:#1c2128}
  .pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:.72rem;font-weight:600}
  .pill.long{background:#1a3a2a;color:var(--green)}.pill.short{background:#3a1a1a;color:var(--red)}
  .pill.pending{background:#2a2a1a;color:var(--yellow)}.pill.active{background:#1a2a3a;color:var(--accent)}
  .pill.on{background:#1a3a2a;color:var(--green)}.pill.off{background:#3a1a1a;color:var(--red)}
  .pill.win{background:#1a3a2a;color:var(--green)}.pill.loss{background:#3a1a1a;color:var(--red)}.pill.be{background:#1a2a1a;color:var(--text2)}
  .pill.active-status{background:#1a3a2a;color:var(--green)}.pill.suspended{background:#3a1a1a;color:var(--red)}
  .pill.user{background:#1a2a3a;color:var(--accent)}.pill.admin{background:#2a1a3a;color:var(--purple)}
  .log-box{background:#090d11;border:1px solid var(--border);border-radius:10px;height:340px;overflow-y:auto;padding:10px 13px;font-family:'Cascadia Code','Fira Code',monospace;font-size:.78rem;line-height:1.6}
  .log-box .log-warn{color:var(--yellow)}.log-box .log-error{color:var(--red)}.log-box .log-info{color:var(--text2)}.log-box .log-bot{color:var(--green)}
  .section{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:18px;margin-bottom:18px}
  .toggle-row{display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid #21262d}
  .toggle-row:last-child{border-bottom:none}
  .toggle-info h3{font-size:.92rem;font-weight:500;margin-bottom:2px}.toggle-info p{font-size:.78rem;color:var(--text2)}
  .toggle{position:relative;width:42px;height:23px;flex-shrink:0}
  .toggle input{opacity:0;width:0;height:0}
  .slider{position:absolute;inset:0;background:#333;border-radius:99px;cursor:pointer;transition:.25s}
  .slider:before{content:'';position:absolute;width:17px;height:17px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.25s}
  input:checked+.slider{background:var(--green)}input:checked+.slider:before{transform:translateX(19px)}
  .param-row{display:grid;grid-template-columns:1fr 150px;align-items:center;gap:14px;padding:11px 0;border-bottom:1px solid #21262d}
  .param-row:last-child{border-bottom:none}
  input[type=number],input[type=text],input[type=email],input[type=password]{background:#0d1117;border:1px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text);font-size:.88rem;width:100%}
  input[type=number]:focus,input[type=text]:focus,input[type=email]:focus,input[type=password]:focus{outline:none;border-color:var(--accent)}
  .btn{display:inline-flex;align-items:center;gap:5px;padding:7px 16px;border-radius:7px;font-size:.85rem;font-weight:500;cursor:pointer;border:none;transition:.15s}
  .btn-primary{background:var(--accent);color:#fff}.btn-primary:hover{background:#79b8ff}
  .btn-danger{background:var(--red);color:#fff}.btn-danger:hover{opacity:.85}
  .btn-success{background:var(--green);color:#fff}.btn-success:hover{opacity:.85}
  .btn-ghost{background:#21262d;color:var(--text);border:1px solid var(--border)}.btn-ghost:hover{background:#30363d}
  .btn-warn{background:#3a2e00;color:var(--yellow);border:1px solid var(--yellow)}.btn-warn:hover{background:#4a3a00}
  .btn:disabled{opacity:.4;cursor:not-allowed}
  .update-out{background:#090d11;border:1px solid var(--border);border-radius:8px;padding:10px 13px;font-family:monospace;font-size:.78rem;max-height:180px;overflow-y:auto;display:none;margin-top:10px;white-space:pre-wrap}
  .health-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:middle}
  .health-ok{background:var(--green)}.health-fail{background:var(--red)}.health-warn{background:var(--yellow)}.health-check{background:#555}
  .stat-row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #21262d;font-size:.88rem}
  .stat-row:last-child{border-bottom:none}.stat-val{font-weight:600}
  .save-toast{position:fixed;bottom:22px;right:22px;background:#1a3a2a;border:1px solid var(--green);color:var(--green);padding:9px 16px;border-radius:8px;font-size:.85rem;display:none;z-index:9999;animation:fadeIn .2s}
  .save-toast.err-toast{background:#3a1a1a;border-color:var(--red);color:var(--red)}
  @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  .param-key{font-size:.72rem;color:var(--text2);font-family:monospace}.param-hint{font-size:.73rem;color:var(--text2)}.param-unit{font-size:.75rem;color:var(--accent);margin-left:4px;font-weight:400}
  .pro-section{border:1px solid var(--border);border-radius:10px;margin-bottom:18px;overflow:hidden}
  .pro-section-header{padding:13px 18px;display:flex;align-items:center;gap:10px;background:#161b22;border-bottom:1px solid var(--border)}
  .pro-section-header h2{font-size:.92rem;font-weight:600;margin:0}.pro-section-header p{font-size:.75rem;color:var(--text2);margin:0;margin-left:auto}
  .pro-section-body{padding:0 18px}
  .pro-master{background:linear-gradient(135deg,#0d2137,#0d1117);border:1px solid var(--accent);border-radius:10px;padding:18px;margin-bottom:20px;display:flex;align-items:center;gap:18px}
  .pro-master-info h2{font-size:1rem;font-weight:700;color:var(--accent);margin-bottom:3px}.pro-master-info p{font-size:.8rem;color:var(--text2);max-width:460px}
  .pro-badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:.68rem;font-weight:700;background:linear-gradient(90deg,#58a6ff,#7c3aed);color:#fff;margin-left:5px;vertical-align:middle}
  .pro-disabled-overlay{opacity:.4;pointer-events:none;user-select:none}
  .scanner-ctrl{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .field{margin-bottom:15px}label.field-label{display:block;font-size:.8rem;color:var(--text2);margin-bottom:5px}
  .err{color:var(--red);font-size:.8rem;margin-top:4px}.msg-ok{color:var(--green);font-size:.8rem;margin-top:4px}
  @media(max-width:768px){.grid-2,.grid-3{grid-template-columns:1fr}.grid{grid-template-columns:1fr 1fr}}
  @media(max-width:480px){.grid{grid-template-columns:1fr}.nav-links a{padding:5px 8px;font-size:.78rem}}`;

function _html(title, body, extraCss = '') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Apex-MD</title>
<style>${CSS_VARS}${extraCss}</style>
</head>
<body>${body}</body>
</html>`;
}

// ─── Admin navigation bar ──────────────────────────────────────────
function _adminNav(active, pendingUpdate, scannerActive) {
    const upBadge   = pendingUpdate  ? '<span class="badge">!</span>'              : '';
    const scanBadge = scannerActive  ? '<span class="badge badge-green">ON</span>' : '';
    return `
<nav class="nav">
  <div class="logo">🔐 Apex-MD Admin <span style="font-size:.7rem;background:#21262d;padding:2px 7px;border-radius:4px;color:var(--text2);font-weight:400">v${config.VERSION}</span></div>
  <div class="nav-links">
    <a href="/admin/"         class="${active==='home'    ?'active':''}">🏠 Dashboard</a>
    <a href="/admin/trades"   class="${active==='trades'  ?'active':''}">📋 Trades</a>
    <a href="/admin/stats"    class="${active==='stats'   ?'active':''}">📊 Stats</a>
    <a href="/admin/users"    class="${active==='users'   ?'active':''}">👥 Users</a>
    <a href="/admin/scanner"  class="${active==='scanner' ?'active':''}">🔍 Scanner${scanBadge}</a>
    <a href="/admin/settings" class="${active==='settings'?'active':''}">⚙️ Settings</a>
    <a href="/admin/updater"  class="${active==='updater' ?'active':''}">🔄 Updater${upBadge}</a>
    <a href="/admin/logout" class="btn btn-ghost" style="font-size:.78rem;padding:4px 10px">Logout</a>
  </div>
</nav>`;
}

// ─── User portal navigation bar ────────────────────────────────────
function _appNav(active, username) {
    return `
<nav class="nav">
  <div class="logo">📊 Apex-MD <span style="font-size:.7rem;background:#21262d;padding:2px 7px;border-radius:4px;color:var(--text2);font-weight:400">Portal</span></div>
  <div class="nav-links">
    <a href="/app/"          class="${active==='home'    ?'active':''}">🏠 Home</a>
    <a href="/app/trades"    class="${active==='trades'  ?'active':''}">📋 My Trades</a>
    <a href="/app/settings"  class="${active==='settings'?'active':''}">🔑 API Keys</a>
    <span style="font-size:.82rem;color:var(--text2);margin-left:auto;padding:0 4px">👤 ${username || ''}</span>
    <a href="/auth/logout" class="btn btn-ghost" style="font-size:.78rem;padding:4px 10px">Logout</a>
  </div>
</nav>`;
}

// ─────────────────────────────────────────────────────────────────
//  API HEALTH CHECK
// ─────────────────────────────────────────────────────────────────
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

// ═════════════════════════════════════════════════════════════════
//  MAIN INIT
// ═════════════════════════════════════════════════════════════════
function initDashboard() {
    const app  = express();
    const port = config.DASHBOARD_PORT;

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // ────────────────────────────────────────────────────────────
    //  SECTION 1 — ADMIN AUTH ROUTES  (/admin/login, /admin/logout)
    // ────────────────────────────────────────────────────────────

    app.get('/admin/login', (req, res) => {
        const err    = req.query.err    ? '<p class="err">❌ Incorrect password</p>' : '';
        const locked = req.query.locked ? '<p class="err">🔒 Too many attempts. Try again in 15 minutes.</p>' : '';
        res.send(_html('Admin Login', `
<div style="min-height:100vh;display:flex;align-items:center;justify-content:center">
  <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:38px 34px;width:360px">
    <h1 style="font-size:1.35rem;margin-bottom:5px;text-align:center">🔐 Admin Panel</h1>
    <p style="color:var(--text2);font-size:.85rem;text-align:center;margin-bottom:26px">Apex-MD Owner Access</p>
    <form method="POST" action="/admin/login">
      <div class="field"><label class="field-label">Password</label>
        <input type="password" name="password" placeholder="Enter dashboard password" autofocus required>
      </div>
      ${err}${locked}
      <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center;margin-top:12px">Sign In →</button>
    </form>
    <p style="text-align:center;margin-top:20px;font-size:.78rem;color:var(--text2)">
      Not an admin? <a href="/auth/login">User Login →</a>
    </p>
  </div>
</div>`));
    });

    app.post('/admin/login', (req, res) => {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        if (!_checkAdminRateLimit(ip)) return res.redirect('/admin/login?locked=1');
        if ((req.body.password || '').trim() !== config.DASHBOARD_PASSWORD) return res.redirect('/admin/login?err=1');
        _resetAdminLimit(ip);
        const token = _signAdminToken({ exp: Date.now() + ADMIN_COOKIE_TTL, role: 'owner' });
        res.setHeader('Set-Cookie', `${ADMIN_COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${ADMIN_COOKIE_TTL/1000}; SameSite=Strict`);
        res.redirect('/admin/');
    });

    app.get('/admin/logout', (req, res) => {
        res.setHeader('Set-Cookie', `${ADMIN_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`);
        res.redirect('/admin/login');
    });

    // All /admin/* routes require admin auth
    app.use('/admin', (req, res, next) => {
        if (req.path === '/login' || (req.method === 'POST' && req.path === '/login')) return next();
        requireAdminAuth(req, res, next);
    });

    // ────────────────────────────────────────────────────────────
    //  SECTION 2 — ADMIN PAGES
    // ────────────────────────────────────────────────────────────

    // ── Admin Home ──────────────────────────────────────────────
    app.get('/admin/', async (req, res) => {
        let tradesHtml = '<tr><td colspan="8" style="text-align:center;color:var(--text2)">No active trades</td></tr>';
        let tradeCount = 0;
        try {
            const trades = await db.Trade.find({ status: { $in: ['active','pending'] } }).lean();
            tradeCount = trades.length;
            if (trades.length > 0) {
                tradesHtml = trades.map(t => {
                    const dir = t.direction==='LONG' ? '<span class="pill long">LONG</span>' : '<span class="pill short">SHORT</span>';
                    const st  = t.status==='pending'  ? '<span class="pill pending">PENDING</span>' : '<span class="pill active">ACTIVE</span>';
                    const hrs = ((Date.now() - new Date(t.openTime)) / 3600000).toFixed(1);
                    return `<tr><td><strong>${t.coin}</strong>${t.isPaper?' 📄':''}</td><td>${dir}</td>
                        <td>$${parseFloat(t.entry).toFixed(4)}</td><td>$${parseFloat(t.tp2||t.tp||0).toFixed(4)}</td>
                        <td>$${parseFloat(t.sl||0).toFixed(4)}</td><td>${t.leverage||1}x</td><td>${st}</td><td>${hrs}h</td></tr>`;
                }).join('');
            }
        } catch (_) {}
        const uptime = Math.floor((Date.now() - _botState.startTime) / 60000);
        const uptimeStr = uptime >= 60 ? `${Math.floor(uptime/60)}h ${uptime%60}m` : `${uptime}m`;
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        let saasUserCount = 0;
        try { saasUserCount = await db.SaasUser.countDocuments(); } catch (_) {}

        res.send(_html('Admin Dashboard', `
${_adminNav('home', _botState.pendingUpdate, scannerActive)}
<div class="wrap">
  <h1>📊 Admin Dashboard</h1>
  <div class="grid">
    <div class="card"><div class="card-label">WhatsApp</div><div class="card-val ${_botState.waConnected?'green':'red'}" id="wa-status">${_botState.waConnected?'🟢 Online':'🔴 Offline'}</div><div class="card-sub">Connection</div></div>
    <div class="card"><div class="card-label">Auto Scanner</div><div class="card-val ${scannerActive?'green':'yellow'}" id="scanner-status">${scannerActive?'🟢 Active':'⚪ Standby'}</div><div class="card-sub">Signal engine</div></div>
    <div class="card"><div class="card-label">Active Trades</div><div class="card-val blue" id="trade-count">${tradeCount}</div><div class="card-sub">Open positions</div></div>
    <div class="card"><div class="card-label">Uptime</div><div class="card-val" id="uptime">${uptimeStr}</div><div class="card-sub">Since last restart</div></div>
    <div class="card"><div class="card-label">SaaS Users</div><div class="card-val purple">${saasUserCount}</div><div class="card-sub">Registered users</div></div>
    <div class="card"><div class="card-label">AI Model</div><div class="card-val ${config.modules.AI_MODEL?'green':'yellow'}">${config.modules.AI_MODEL?'🟢 On':'⚪ Off'}</div><div class="card-sub">LSTM server</div></div>
  </div>
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
    <table><thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP2</th><th>SL</th><th>Lev</th><th>Status</th><th>Open</th></tr></thead>
    <tbody id="trades-body">${tradesHtml}</tbody></table></div>
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
const es = new EventSource('/admin/api/logs/stream');
let autoScroll = true;
lb.addEventListener('scroll', () => { autoScroll = lb.scrollTop + lb.clientHeight >= lb.scrollHeight - 40; });
es.onmessage = e => {
  const d = JSON.parse(e.data), el = document.createElement('div'), msg = d.msg || '';
  el.className = 'log-' + (msg.includes('[ERROR]')?'error':msg.includes('[WARN]')?'warn':msg.includes('[BOT]')?'bot':'info');
  el.textContent = new Date(d.ts).toLocaleTimeString() + '  ' + msg;
  lb.appendChild(el);
  if (autoScroll) lb.scrollTop = lb.scrollHeight;
};
es.onerror = () => { const el = document.createElement('div'); el.className='log-warn'; el.textContent='[Stream disconnected — reload]'; lb.appendChild(el); };
function clearLogs() { lb.innerHTML = ''; }
setInterval(async () => {
  try {
    const d = await (await fetch('/admin/api/status')).json();
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
    const h = await (await fetch('/admin/api/health')).json();
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

    // ── Admin Trades ─────────────────────────────────────────────
    app.get('/admin/trades', async (req, res) => {
        let activeHtml = '<tr><td colspan="8" style="text-align:center;color:var(--text2)">No active trades</td></tr>';
        let closedHtml = '<tr><td colspan="8" style="text-align:center;color:var(--text2)">No closed trades</td></tr>';
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        try {
            const active = await db.Trade.find({ status: { $in: ['active','pending'] } }).sort({ openTime:-1 }).lean();
            if (active.length) activeHtml = active.map(t => {
                const dir = t.direction==='LONG' ? '<span class="pill long">LONG</span>' : '<span class="pill short">SHORT</span>';
                const st  = t.status==='pending' ? '<span class="pill pending">PENDING</span>' : '<span class="pill active">ACTIVE</span>';
                const hrs = ((Date.now() - new Date(t.openTime)) / 3600000).toFixed(1);
                return `<tr><td><strong>${t.coin}</strong>${t.isPaper?' 📄':''}</td><td>${dir}</td>
                <td>$${parseFloat(t.entry).toFixed(4)}</td><td>$${parseFloat(t.tp1||0).toFixed(4)}</td>
                <td>$${parseFloat(t.tp2||t.tp||0).toFixed(4)}</td><td>$${parseFloat(t.sl||0).toFixed(4)}</td>
                <td>${t.leverage||1}x</td><td>${st} ${hrs}h</td></tr>`;
            }).join('');
            const closed = await db.Trade.find({ status:'closed' }).sort({ closedAt:-1 }).limit(50).lean();
            if (closed.length) closedHtml = closed.map(t => {
                const dir = t.direction==='LONG' ? '<span class="pill long">LONG</span>' : '<span class="pill short">SHORT</span>';
                const res = t.result==='WIN' ? '<span class="pill win">WIN</span>' : t.result==='LOSS' ? '<span class="pill loss">LOSS</span>' : '<span class="pill be">B/E</span>';
                const pnl = t.pnlPct ? (t.pnlPct>0?'+':'')+parseFloat(t.pnlPct).toFixed(2)+'%' : '—';
                const pnlColor = t.pnlPct>0?'var(--green)':t.pnlPct<0?'var(--red)':'var(--text2)';
                const dt = t.closedAt ? new Date(t.closedAt).toLocaleDateString() : '—';
                return `<tr><td><strong>${t.coin}</strong>${t.isPaper?' 📄':''}</td><td>${dir}</td>
                <td>$${parseFloat(t.entry).toFixed(4)}</td><td>$${parseFloat(t.tp2||t.tp||0).toFixed(4)}</td>
                <td>$${parseFloat(t.sl||0).toFixed(4)}</td><td>${res}</td>
                <td style="color:${pnlColor};font-weight:600">${pnl}</td><td>${dt}</td></tr>`;
            }).join('');
        } catch (_) {}
        res.send(_html('Trades', `
${_adminNav('trades', _botState.pendingUpdate, scannerActive)}
<div class="wrap">
  <h1>📋 All Trades</h1>
  <div class="section">
    <h2>⚡ Active & Pending</h2><div style="overflow-x:auto">
    <table><thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP1</th><th>TP2</th><th>SL</th><th>Lev</th><th>Status</th></tr></thead>
    <tbody>${activeHtml}</tbody></table></div>
  </div>
  <div class="section">
    <h2>📜 Closed Trades (Last 50)</h2><div style="overflow-x:auto">
    <table><thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP2</th><th>SL</th><th>Result</th><th>PnL%</th><th>Date</th></tr></thead>
    <tbody>${closedHtml}</tbody></table></div>
  </div>
</div>`));
    });

    // ── Admin Stats ───────────────────────────────────────────────
    app.get('/admin/stats', async (req, res) => {
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        let stats = null, paperStats = null;
        try {
            const calcStats = (arr) => {
                if (!arr.length) return null;
                const wins = arr.filter(t => t.result==='WIN').length;
                const loss = arr.filter(t => t.result==='LOSS').length;
                const totalPnl = arr.reduce((s,t) => s+(t.pnlPct||0), 0);
                const best  = arr.reduce((b,t) => (t.pnlPct||0)>(b?.pnlPct||0)?t:b, null);
                const worst = arr.reduce((w,t) => (t.pnlPct||0)<(w?.pnlPct||0)?t:w, null);
                return { total:arr.length, wins, loss, wr: arr.length>0?((wins/arr.length)*100).toFixed(1):'0', totalPnl:totalPnl.toFixed(2), best, worst };
            };
            stats      = calcStats(await db.Trade.find({ status:'closed', isPaper:false }).lean());
            paperStats = calcStats(await db.Trade.find({ status:'closed', isPaper:true  }).lean());
        } catch (_) {}
        const statBlock = (s, title, emoji) => {
            if (!s) return `<div class="section"><h2>${emoji} ${title}</h2><p style="color:var(--text2);font-size:.88rem">No closed trades yet.</p></div>`;
            const pnlColor = parseFloat(s.totalPnl)>=0 ? 'var(--green)':'var(--red)';
            const wrColor  = parseFloat(s.wr)>=55?'var(--green)':parseFloat(s.wr)>=45?'var(--yellow)':'var(--red)';
            return `<div class="section"><h2>${emoji} ${title}</h2>
  <div class="grid" style="margin-bottom:14px">
    <div class="card"><div class="card-label">Total Trades</div><div class="card-val blue">${s.total}</div></div>
    <div class="card"><div class="card-label">Win Rate</div><div class="card-val" style="color:${wrColor}">${s.wr}%</div></div>
    <div class="card"><div class="card-label">Wins / Losses</div><div class="card-val green">${s.wins}</div><div class="card-sub" style="color:var(--red)">${s.loss} losses</div></div>
    <div class="card"><div class="card-label">Total PnL</div><div class="card-val" style="color:${pnlColor}">${parseFloat(s.totalPnl)>=0?'+':''}${s.totalPnl}%</div></div>
  </div>
  <div class="stat-row"><span>🏆 Best Trade</span><span class="stat-val" style="color:var(--green)">${s.best?s.best.coin+' +'+(s.best.pnlPct||0).toFixed(2)+'%':'—'}</span></div>
  <div class="stat-row"><span>💀 Worst Trade</span><span class="stat-val" style="color:var(--red)">${s.worst?s.worst.coin+' '+(s.worst.pnlPct||0).toFixed(2)+'%':'—'}</span></div>
  <div class="stat-row"><span>📊 Avg PnL/Trade</span><span class="stat-val">${(parseFloat(s.totalPnl)/s.total).toFixed(2)}%</span></div>
</div>`;
        };
        res.send(_html('Stats', `${_adminNav('stats', _botState.pendingUpdate, scannerActive)}
<div class="wrap"><h1>📊 Performance Statistics</h1>${statBlock(stats,'Real Trades','💰')}${statBlock(paperStats,'Paper Trades','📄')}</div>`));
    });

    // ── Admin Scanner ─────────────────────────────────────────────
    app.get('/admin/scanner', async (req, res) => {
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        res.send(_html('Scanner', `
${_adminNav('scanner', _botState.pendingUpdate, scannerActive)}
<div class="wrap">
  <h1>🔍 Scanner Control</h1>
  <div class="section">
    <h2>⚡ Auto Scanner</h2>
    <p style="font-size:.85rem;color:var(--text2);margin-bottom:16px">Event-driven WebSocket scanner. Monitors ${config.trading.WS_WATCH_COUNT} top coins on 15m candle closes.</p>
    <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:18px">
      <div><span style="font-size:.85rem;color:var(--text2)">Status: </span>
        <span id="scan-stat" class="pill ${scannerActive?'on':'off'}" style="font-size:.85rem">${scannerActive?'🟢 ACTIVE':'⚪ STANDBY'}</span>
      </div>
    </div>
    <div class="scanner-ctrl">
      <button class="btn btn-success" id="btn-start" onclick="scannerCtrl('start')" ${scannerActive?'disabled':''}>▶ Start Scanner</button>
      <button class="btn btn-danger"  id="btn-stop"  onclick="scannerCtrl('stop')"  ${!scannerActive?'disabled':''}>⏹ Stop Scanner</button>
    </div>
    <div id="scan-msg" style="margin-top:12px;font-size:.85rem"></div>
    <p style="font-size:.78rem;color:var(--text2);margin-top:12px">Min score: <strong>${config.trading.MIN_SCORE_THRESHOLD}/100</strong> · Cooldown: <strong>${config.trading.SIGNAL_COOLDOWN_HOURS}h</strong></p>
  </div>
  <div class="section"><h2>📈 Scanner Settings</h2>
    <div class="stat-row"><span>Watched Coins</span><span class="stat-val">${config.trading.WS_WATCH_COUNT}</span></div>
    <div class="stat-row"><span>Min Signal Score</span><span class="stat-val">${config.trading.MIN_SCORE_THRESHOLD}/100</span></div>
    <div class="stat-row"><span>Signal Cooldown</span><span class="stat-val">${config.trading.SIGNAL_COOLDOWN_HOURS}h</span></div>
    <div class="stat-row"><span>Max Open Trades</span><span class="stat-val">${config.trading.MAX_OPEN_TRADES}</span></div>
    <div class="stat-row"><span>SMC Scoring</span><span class="stat-val">${config.modules.SMC?'✅ Enabled':'❌ Disabled'}</span></div>
    <p style="font-size:.78rem;color:var(--text2);margin-top:12px">Change in <a href="/admin/settings">⚙️ Settings</a></p>
  </div>
</div>
<script>
async function scannerCtrl(action) {
  document.getElementById('scan-msg').textContent = action==='start'?'⏳ Starting...':'⏳ Stopping...';
  try {
    const d = await (await fetch('/admin/api/scanner/'+action,{method:'POST'})).json();
    document.getElementById('scan-msg').textContent = d.ok?(action==='start'?'✅ Started!':'✅ Stopped.'):'❌ '+d.error;
    document.getElementById('scan-msg').style.color = d.ok?'var(--green)':'var(--red)';
    if (d.ok) {
      const on=action==='start';
      document.getElementById('scan-stat').textContent=on?'🟢 ACTIVE':'⚪ STANDBY';
      document.getElementById('scan-stat').className='pill '+(on?'on':'off');
      document.getElementById('btn-start').disabled=on;
      document.getElementById('btn-stop').disabled=!on;
    }
  } catch(e){document.getElementById('scan-msg').textContent='❌ Network error';}
}
</script>`));
    });

    // ── Admin Settings ────────────────────────────────────────────
    app.get('/admin/settings', (req, res) => {
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        const m=config.modules||{}, t=config.trading||{}, pr=m.PRO_MODE||false;
        const ind=config.indicatorParams||{}, smc=config.smcParams||{}, tgt=config.targetParams||{};
        const iv=(o,k,d)=>o[k]!==undefined?o[k]:d;
        const tv=(k,d)=>iv(t,k,d), indv=(k,d)=>iv(ind,k,d), smcv=(k,d)=>iv(smc,k,d), tgtv=(k,d)=>iv(tgt,k,d);
        const modToggle=(id,label,desc,checked)=>`<div class="toggle-row"><div class="toggle-info"><h3>${label}</h3><p>${desc}</p></div><label class="toggle"><input type="checkbox" id="mod-${id}" ${checked?'checked':''} onchange="toggleMod('${id}',this.checked)"><span class="slider"></span></label></div>`;
        const tradingRow=(key,label,val,min,max,step,unit='')=>`<div class="param-row"><div><strong>${label}</strong>${unit?`<span class="param-unit">${unit}</span>`:''}<br><span class="param-key">${key}</span></div><input type="number" value="${val}" min="${min}" max="${max}" step="${step}" onchange="setTradingParam('${key}',this.value)"></div>`;
        const indRow=(key,label,val,min,max,step,unit='',hint='')=>`<div class="param-row pro-param"><div><strong>${label}</strong>${unit?`<span class="param-unit">${unit}</span>`:''} ${hint?`<br><span class="param-hint">${hint}</span>`:''}<br><span class="param-key">${key}</span></div><input type="number" value="${val}" min="${min}" max="${max}" step="${step}" onchange="setIndicatorParam('${key}',this.value)" ${pr?'':'disabled'}></div>`;
        const smcRow=(key,label,val,min,max,step,unit='',hint='')=>`<div class="param-row pro-param"><div><strong>${label}</strong>${unit?`<span class="param-unit">${unit}</span>`:''} ${hint?`<br><span class="param-hint">${hint}</span>`:''}<br><span class="param-key">${key}</span></div><input type="number" value="${val}" min="${min}" max="${max}" step="${step}" onchange="setSMCParam('${key}',this.value)" ${pr?'':'disabled'}></div>`;
        const tgtRow=(key,label,val,min,max,step,unit='',hint='')=>`<div class="param-row pro-param"><div><strong>${label}</strong>${unit?`<span class="param-unit">${unit}</span>`:''} ${hint?`<br><span class="param-hint">${hint}</span>`:''}<br><span class="param-key">${key}</span></div><input type="number" value="${val}" min="${min}" max="${max}" step="${step}" onchange="setTargetParam('${key}',this.value)" ${pr?'':'disabled'}></div>`;

        res.send(_html('Settings', `
${_adminNav('settings', _botState.pendingUpdate, scannerActive)}
<div class="wrap" style="max-width:1300px"><h1>⚙️ Settings</h1>
  <div class="pro-master"><div style="font-size:1.8rem">🎛️</div>
    <div class="pro-master-info"><h2>Pro Custom Mode <span class="pro-badge">PRO</span></h2><p>Override every indicator and strategy parameter. OFF = bot uses optimal built-in values automatically.</p></div>
    <label class="toggle" style="width:50px;height:27px;margin-left:auto"><input type="checkbox" id="pro-toggle" ${pr?'checked':''} onchange="toggleProMode(this.checked)"><span class="slider"></span></label>
  </div>
  <div class="grid-2" style="margin-bottom:18px">
    <div class="section"><h2>🧩 Module Toggles</h2>
      ${modToggle('AI_MODEL','🤖 AI Model','Local Python LSTM prediction server',m.AI_MODEL)}
      ${modToggle('BYBIT','🐳 Bybit Layer','Cross-exchange OB + volume validation',m.BYBIT)}
      ${modToggle('DYNAMIC_WEIGHTS','🧠 Dynamic Weights','ADX/ATR-based adaptive score multipliers',m.DYNAMIC_WEIGHTS)}
      ${modToggle('SMC','🔮 SMC Scoring','ChoCH, Sweep, OB, Wyckoff, BOS, Breakers',m.SMC)}
    </div>
    <div class="section"><h2>💼 Core Trading Parameters</h2>
      ${tradingRow('DEFAULT_RISK_PCT','💰 Risk per Trade',tv('DEFAULT_RISK_PCT',2),0.1,10,0.1,'%')}
      ${tradingRow('DEFAULT_LEVERAGE','⚡ Default Leverage',tv('DEFAULT_LEVERAGE',10),1,125,1,'x')}
      ${tradingRow('MAX_OPEN_TRADES','📂 Max Open Trades',tv('MAX_OPEN_TRADES',5),1,20,1)}
      ${tradingRow('MIN_SCORE_THRESHOLD','📊 Min Signal Score',tv('MIN_SCORE_THRESHOLD',20),5,80,1)}
      ${tradingRow('SIGNAL_COOLDOWN_HOURS','⏱️ Signal Cooldown',tv('SIGNAL_COOLDOWN_HOURS',4),0.5,48,0.5,'hr')}
      ${tradingRow('WS_WATCH_COUNT','🪙 Watched Coins',tv('WS_WATCH_COUNT',30),5,100,1)}
    </div>
  </div>
  <div id="pro-panels" class="${pr?'':'pro-disabled-overlay'}">
    <div class="grid-2" style="margin-bottom:18px">
      <div class="pro-section"><div class="pro-section-header"><span>📈</span><h2>Trend & Momentum</h2><p>RSI · EMA · ADX</p></div><div class="pro-section-body">
        ${indRow('RSI_PERIOD','RSI Period',indv('RSI_PERIOD',14),2,50,1,'bars')}
        ${indRow('FAST_EMA','Fast EMA',indv('FAST_EMA',50),2,200,1,'bars')}
        ${indRow('SLOW_EMA','Slow EMA',indv('SLOW_EMA',200),10,500,5,'bars')}
        ${indRow('ADX_CHOPPY','ADX Choppy',indv('ADX_CHOPPY',20),5,40,1,'','ADX < this = sideways')}
        ${indRow('ADX_TRENDING','ADX Trending',indv('ADX_TRENDING',25),10,60,1,'','ADX > this = trending')}
      </div></div>
      <div class="pro-section"><div class="pro-section-header"><span>🔮</span><h2>Smart Money (SMC)</h2><p>OB · Sweep · FVG</p></div><div class="pro-section-body">
        ${smcRow('OB_LOOKBACK','OB Lookback',smcv('OB_LOOKBACK',10),3,60,1,'bars')}
        ${smcRow('FVG_MIN_PCT','FVG Min Size',smcv('FVG_MIN_PCT',0.1),0.01,2,0.01,'%')}
        ${smcRow('SWEEP_BUFFER','Sweep Buffer',smcv('SWEEP_BUFFER',0.5),0.1,5,0.1,'%')}
      </div></div>
    </div>
    <div class="grid-2" style="margin-bottom:18px">
      <div class="pro-section"><div class="pro-section-header"><span>🎯</span><h2>Risk & Targets</h2><p>TP · SL · RRR</p></div><div class="pro-section-body">
        ${tgtRow('TP1_MULT','TP1 Multiplier',tgtv('TP1_MULT',1.0),0.3,20,0.1,':1 RRR')}
        ${tgtRow('TP2_MULT','TP2 Multiplier',tgtv('TP2_MULT',2.0),0.5,30,0.1,':1 RRR')}
        ${tgtRow('TP3_MULT','TP3 Multiplier',tgtv('TP3_MULT',3.0),1,50,0.5,':1 RRR')}
        ${tgtRow('SL_BUFFER','SL Buffer',tgtv('SL_BUFFER',0.5),0.1,5,0.1,'%')}
      </div></div>
      <div class="section"><h2>🔔 Daily Report</h2>
        <div class="toggle-row"><div class="toggle-info"><h3>📊 Auto Daily P&L Report</h3><p>Send P&L summary to owner every day at midnight UTC</p></div>
          <label class="toggle"><input type="checkbox" ${config.dailyReport?.ENABLED!==false?'checked':''} onchange="toggleMod('DAILY_REPORT',this.checked)"><span class="slider"></span></label>
        </div>
        <div style="margin-top:12px;font-size:.82rem;color:var(--text2)">ℹ️ Report time: Midnight UTC (${config.dailyReport?.HOUR_UTC||0}:00 UTC)</div>
      </div>
    </div>
  </div>
</div>
<div class="save-toast" id="toast"></div>
<script>
function showToast(msg,isErr=false){const t=document.getElementById('toast');t.textContent=msg;t.className='save-toast'+(isErr?' err-toast':'');t.style.display='block';clearTimeout(t._to);t._to=setTimeout(()=>t.style.display='none',3000);}
async function apiPost(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json();}
async function toggleProMode(val){
  const d=await apiPost('/admin/api/promode',{enabled:val});
  if(d.ok){showToast('🎛️ Pro Mode '+(val?'ON':'OFF'));document.getElementById('pro-panels').classList.toggle('pro-disabled-overlay',!val);}
  else{showToast('❌ '+d.error,true);document.getElementById('pro-toggle').checked=!val;}
}
async function toggleMod(id,val){const d=await apiPost('/admin/api/modules/'+id,{enabled:val});showToast(d.ok?'✅ '+id+' → '+(val?'ON':'OFF'):'❌ '+d.error,!d.ok);}
async function setTradingParam(key,val){const d=await apiPost('/admin/api/params/'+key,{value:parseFloat(val)});showToast(d.ok?'✅ '+key+' = '+val:'❌ '+d.error,!d.ok);}
async function setIndicatorParam(key,val){const d=await apiPost('/admin/api/indicators/'+key,{value:parseFloat(val)});showToast(d.ok?'📈 '+key+' = '+val:'❌ '+d.error,!d.ok);}
async function setSMCParam(key,val){const d=await apiPost('/admin/api/smc/'+key,{value:parseFloat(val)});showToast(d.ok?'🔮 '+key+' = '+val:'❌ '+d.error,!d.ok);}
async function setTargetParam(key,val){const d=await apiPost('/admin/api/targets/'+key,{value:parseFloat(val)});showToast(d.ok?'🎯 '+key+' = '+val:'❌ '+d.error,!d.ok);}
</script>`));
    });

    // ── Admin Updater ─────────────────────────────────────────────
    app.get('/admin/updater', (req, res) => {
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        const enabled = config.updater.ENABLED, pending = _botState.pendingUpdate;
        res.send(_html('Updater', `
${_adminNav('updater', pending, scannerActive)}
<div class="wrap"><h1>🔄 Auto Updater</h1>
  ${pending?'<div class="section" style="border-color:var(--yellow)"><p style="color:var(--yellow)">⚠️ <strong>New update available</strong> — auto-update is OFF. Click Pull Update to apply manually.</p></div>':''}
  <div class="grid-2">
    <div class="section"><h2>🔧 Update Controls</h2>
      <div class="toggle-row"><div class="toggle-info"><h3>Auto-Update</h3><p>Automatically apply updates on git push events</p></div>
        <label class="toggle"><input type="checkbox" id="auto-toggle" ${enabled?'checked':''} onchange="setAutoUpdate(this.checked)"><span class="slider"></span></label>
      </div>
      <div style="margin-top:18px;display:flex;flex-direction:column;gap:10px">
        <button class="btn btn-primary" onclick="runUpdate()">🔄 Pull Update Now</button>
        <p style="font-size:.78rem;color:var(--text2)">Runs: <code>git pull && npm install && pm2 restart ${config.updater.PM2_APP_NAME}</code></p>
        ${config.updater.WEBHOOK_SECRET?'<p style="font-size:.78rem;color:var(--green)">✅ Webhook secret configured</p>':'<p style="font-size:.78rem;color:var(--yellow)">⚠️ No GITHUB_WEBHOOK_SECRET set</p>'}
      </div>
      <div class="update-out" id="update-out"></div>
      <div id="update-msg" style="margin-top:8px;font-size:.85rem"></div>
    </div>
    <div class="section"><h2>📋 Update Info</h2>
      <div class="stat-row"><span>Last Update</span><span class="stat-val">${_botState.lastUpdate||'Never'}</span></div>
      <div class="stat-row"><span>Bot Version</span><span class="stat-val">${config.VERSION}</span></div>
      <p style="font-size:.85rem;margin:14px 0 8px;color:var(--text2)">GitHub Webhook URL:</p>
      <code style="background:#090d11;padding:8px 11px;border-radius:6px;display:block;font-size:.78rem;word-break:break-all">http://YOUR_VPS_IP:${port}/admin/webhook/update</code>
    </div>
  </div>
</div>
<script>
async function setAutoUpdate(val){const r=await fetch('/admin/api/autoupdate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:val})});const d=await r.json();const msg=document.getElementById('update-msg');msg.textContent=d.ok?'✅ Auto-update '+(val?'enabled':'disabled'):'❌ '+d.error;msg.className=d.ok?'msg-ok':'err';}
async function runUpdate(){const msg=document.getElementById('update-msg'),out=document.getElementById('update-out');msg.textContent='🔄 Starting update... this may take 60s...';msg.className='';out.style.display='block';out.textContent='Running...';try{const d=await(await fetch('/admin/api/update',{method:'POST'})).json();out.textContent=d.ok?(d.output||'Done.'):('Error: '+d.error+'\n'+(d.stderr||''));msg.textContent=d.ok?'✅ Update complete — bot restarting':'❌ Update failed';msg.className=d.ok?'msg-ok':'err';}catch(e){out.textContent='Network error: '+e.message;}}
</script>`));
    });

    // ── Admin User Management ─────────────────────────────────────
    app.get('/admin/users', async (req, res) => {
        let scannerActive = false;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        let usersHtml = '<tr><td colspan="7" style="text-align:center;color:var(--text2)">No users yet.</td></tr>';
        let totalUsers = 0;
        try {
            const { users, total } = await db.listSaasUsers(1, 100);
            totalUsers = total;
            if (users.length) {
                usersHtml = users.map(u => {
                    const rolePill   = u.role==='admin' ? '<span class="pill admin">admin</span>' : '<span class="pill user">user</span>';
                    const statusPill = u.accountStatus==='active' ? '<span class="pill active-status">active</span>' : '<span class="pill suspended">suspended</span>';
                    const lastLogin  = u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : 'Never';
                    const joined     = new Date(u.createdAt).toLocaleDateString();
                    const suspBtn    = u.accountStatus==='active'
                        ? `<button class="btn btn-danger"  style="padding:3px 9px;font-size:.75rem" onclick="setStatus('${u._id}','suspended')">Suspend</button>`
                        : `<button class="btn btn-success" style="padding:3px 9px;font-size:.75rem" onclick="setStatus('${u._id}','active')">Activate</button>`;
                    return `<tr>
                        <td><strong>${u.username}</strong></td>
                        <td style="color:var(--text2);font-size:.83rem">${u.email}</td>
                        <td>${rolePill}</td>
                        <td>${statusPill}</td>
                        <td style="font-size:.83rem">${joined}</td>
                        <td style="font-size:.83rem">${lastLogin} (${u.loginCount||0}x)</td>
                        <td>${suspBtn}</td>
                    </tr>`;
                }).join('');
            }
        } catch (e) { console.error('Admin users page error:', e.message); }

        res.send(_html('Users', `
${_adminNav('users', _botState.pendingUpdate, scannerActive)}
<div class="wrap">
  <h1>👥 SaaS Users <span style="font-size:.9rem;color:var(--text2);font-weight:400">(${totalUsers} total)</span></h1>
  <div class="section">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <h2 style="margin:0">All Platform Users</h2>
      <div style="font-size:.82rem;color:var(--text2)">Registration is open at <a href="/auth/register">/auth/register</a></div>
    </div>
    <div style="overflow-x:auto">
    <table>
      <thead><tr><th>Username</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th>Last Login</th><th>Action</th></tr></thead>
      <tbody id="users-body">${usersHtml}</tbody>
    </table>
    </div>
  </div>
</div>
<div class="save-toast" id="toast"></div>
<script>
async function setStatus(userId, status) {
  if (!confirm('Change user status to "'+status+'"?')) return;
  try {
    const r = await fetch('/admin/api/users/'+userId+'/status', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({status}) });
    const d = await r.json();
    const t = document.getElementById('toast');
    t.textContent = d.ok ? '✅ Status updated to '+status : '❌ '+d.error;
    t.className = 'save-toast'+(d.ok?'':' err-toast');
    t.style.display = 'block';
    setTimeout(()=>t.style.display='none', 3000);
    if (d.ok) setTimeout(()=>location.reload(), 1200);
  } catch(e) { alert('Network error: ' + e.message); }
}
</script>`));
    });

    // ─────────────────────────────────────────────────────────────
    //  SECTION 3 — ADMIN REST API ENDPOINTS
    // ─────────────────────────────────────────────────────────────

    app.get('/admin/api/status', requireAdminAuth, async (req, res) => {
        let scannerActive = false, tradeCount = 0;
        try { scannerActive = require('./plugins/scanner').getScannerStatus(); } catch (_) {}
        try { tradeCount = await db.Trade.countDocuments({ status: { $in: ['active','pending'] } }); } catch (_) {}
        const uptime = Math.floor((Date.now() - _botState.startTime) / 60000);
        res.json({ waConnected: _botState.waConnected, scannerActive, tradeCount,
            uptime: uptime>=60?`${Math.floor(uptime/60)}h ${uptime%60}m`:`${uptime}m`,
            modules: config.modules, trading: config.trading });
    });

    app.get('/admin/api/health', requireAdminAuth, async (req, res) => {
        try { res.json(await checkApiHealth()); } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/admin/api/logs/stream', requireAdminAuth, (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        _logBuffer.slice(-50).forEach(entry => res.write(`data: ${JSON.stringify(entry)}\n\n`));
        _sseClients.add(res);
        req.on('close', () => _sseClients.delete(res));
    });

    app.post('/admin/api/scanner/:action', requireAdminAuth, async (req, res) => {
        try {
            const action = req.params.action;
            const scanner = require('./plugins/scanner');
            if (action === 'start') {
                const started = typeof scanner.startScannerFromSettings === 'function'
                    ? await scanner.startScannerFromSettings(global._botConn, config.OWNER_NUMBER+'@s.whatsapp.net')
                    : false;
                res.json({ ok: true, started });
            } else if (action === 'stop') {
                const stopped = typeof scanner.stopScannerFromSettings === 'function' ? scanner.stopScannerFromSettings() : false;
                res.json({ ok: true, stopped });
            } else { res.status(400).json({ ok:false, error:'Unknown action' }); }
        } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
    });

    app.post('/admin/api/modules/:name', requireAdminAuth, async (req, res) => {
        try {
            const name = req.params.name.toUpperCase(), enabled = Boolean(req.body.enabled);
            config.toggleModule(name, enabled);
            const dbKey = { AI_MODEL:'aiModel', BYBIT:'bybit', DYNAMIC_WEIGHTS:'dynamicWeights', SMC:'smcEnabled' }[name];
            if (dbKey) await db.updateSettings({ [dbKey]: enabled }).catch(()=>{});
            res.json({ ok:true, module:name, enabled });
        } catch (e) { res.status(400).json({ ok:false, error:e.message }); }
    });

    app.post('/admin/api/params/:key', requireAdminAuth, async (req, res) => {
        try {
            const key = req.params.key, val = parseFloat(req.body.value);
            if (isNaN(val)) throw new Error('Invalid number');
            config.setTradingParam(key, val);
            const dbMap = { DEFAULT_RISK_PCT:'defaultRisk', MIN_SCORE_THRESHOLD:'minScore', MAX_OPEN_TRADES:'maxTrades' };
            if (dbMap[key]) await db.updateSettings({ [dbMap[key]]: val }).catch(()=>{});
            res.json({ ok:true, key, value:val });
        } catch (e) { res.status(400).json({ ok:false, error:e.message }); }
    });

    app.post('/admin/api/promode', requireAdminAuth, async (req, res) => {
        try { config.setProMode(Boolean(req.body.enabled)); await db.updateSettings({ proMode: req.body.enabled }).catch(()=>{}); res.json({ ok:true, proMode: config.modules.PRO_MODE }); }
        catch (e) { res.status(400).json({ ok:false, error:e.message }); }
    });

    app.post('/admin/api/indicators/:key', requireAdminAuth, async (req, res) => {
        try { const val=parseFloat(req.body.value); if(isNaN(val)) throw new Error('Invalid number'); config.setIndicatorParam(req.params.key, val); await db.updateSettings({[`ind_${req.params.key}`]:val}).catch(()=>{}); res.json({ok:true,key:req.params.key,value:val}); }
        catch (e) { res.status(400).json({ ok:false, error:e.message }); }
    });

    app.post('/admin/api/smc/:key', requireAdminAuth, async (req, res) => {
        try { const val=parseFloat(req.body.value); if(isNaN(val)) throw new Error('Invalid number'); config.setSMCParam(req.params.key, val); await db.updateSettings({[`smc_${req.params.key}`]:val}).catch(()=>{}); res.json({ok:true,key:req.params.key,value:val}); }
        catch (e) { res.status(400).json({ ok:false, error:e.message }); }
    });

    app.post('/admin/api/targets/:key', requireAdminAuth, async (req, res) => {
        try { const val=parseFloat(req.body.value); if(isNaN(val)) throw new Error('Invalid number'); config.setTargetParam(req.params.key, val); await db.updateSettings({[`tgt_${req.params.key}`]:val}).catch(()=>{}); res.json({ok:true,key:req.params.key,value:val}); }
        catch (e) { res.status(400).json({ ok:false, error:e.message }); }
    });

    app.post('/admin/api/autoupdate',  requireAdminAuth, (req,res) => { config.setAutoUpdate(Boolean(req.body.enabled)); res.json({ ok:true, enabled:config.updater.ENABLED }); });
    app.post('/admin/api/update',      requireAdminAuth, (req,res) => runUpdate(res));
    app.get('/admin/api/config',       requireAdminAuth, (req,res) => res.json(config.getSnapshot()));
    app.get('/admin/api/trades',       requireAdminAuth, async (req,res) => {
        try { res.json({ ok:true, trades: await db.Trade.find({ status:{$in:['active','pending']} }).lean() }); }
        catch (e) { res.status(500).json({ ok:false, error:e.message }); }
    });

    // ── Admin: update SaaS user status ───────────────────────────
    app.post('/admin/api/users/:id/status', requireAdminAuth, async (req, res) => {
        try {
            const { status } = req.body;
            if (!['active','suspended'].includes(status)) return res.status(400).json({ ok:false, error:'Invalid status' });
            await db.setSaasUserStatus(req.params.id, status);
            res.json({ ok:true, status });
        } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
    });

    // GitHub Webhook
    app.post('/admin/webhook/update', express.raw({ type:'application/json' }), (req, res) => {
        if (!_verifyGithubSig(req, req.body)) return res.status(401).json({ error:'Invalid signature' });
        res.json({ ok:true });
        if (config.updater.ENABLED) { _pushLog('[WEBHOOK] 📦 GitHub push — running auto-update...'); runUpdate(null); }
        else { _botState.pendingUpdate = true; _pushLog('[WEBHOOK] ⚠️ GitHub push — auto-update is OFF.'); }
    });

    // ─────────────────────────────────────────────────────────────
    //  BACKWARD COMPAT — /dashboard/* → /admin/*
    //  Keep old bookmark/webhook URLs working.
    // ─────────────────────────────────────────────────────────────
    app.use('/dashboard', (req, res) => {
        const dest = req.path === '/' || req.path === '' ? '/admin/' : '/admin' + req.path;
        res.redirect(301, dest + (req.search || ''));
    });

    // ═════════════════════════════════════════════════════════════
    //  SECTION 4 — AUTH ROUTES  (/auth/*)
    //  Public login & registration for SaaS users
    // ═════════════════════════════════════════════════════════════

    // ── Registration page ─────────────────────────────────────────
    app.get('/auth/register', (req, res) => {
        const err = req.query.err;
        const errMsg = {
            exists_email:    '❌ An account with that email already exists.',
            exists_username: '❌ That username is already taken.',
            short_password:  '❌ Password must be at least 8 characters.',
            mismatch:        '❌ Passwords do not match.',
            invalid:         '❌ Please fill in all fields correctly.',
            server:          '❌ Server error — please try again.',
        }[err] || '';
        const success = req.query.success ? '<p style="color:var(--green);font-size:.85rem;text-align:center;margin-bottom:12px">✅ Account created! Please log in.</p>' : '';

        res.send(_html('Register', `
<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px">
  <div style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:40px 36px;width:100%;max-width:400px">
    <div style="text-align:center;margin-bottom:28px">
      <div style="font-size:2.2rem;margin-bottom:8px">📊</div>
      <h1 style="font-size:1.4rem;margin-bottom:4px">Create Account</h1>
      <p style="color:var(--text2);font-size:.85rem">Apex-MD Trading Portal</p>
    </div>
    ${success}
    ${errMsg ? `<div style="background:#3a1a1a;border:1px solid var(--red);border-radius:8px;padding:10px 13px;margin-bottom:16px;font-size:.83rem;color:var(--red)">${errMsg}</div>` : ''}
    <form method="POST" action="/auth/register">
      <div class="field">
        <label class="field-label">Username</label>
        <input type="text" name="username" placeholder="e.g. trader_shehan" minlength="3" maxlength="32" autocomplete="username" required>
        <span style="font-size:.73rem;color:var(--text2)">3–32 characters, letters/numbers/underscore</span>
      </div>
      <div class="field">
        <label class="field-label">Email Address</label>
        <input type="email" name="email" placeholder="you@example.com" autocomplete="email" required>
      </div>
      <div class="field">
        <label class="field-label">Password</label>
        <input type="password" name="password" placeholder="Min 8 characters" minlength="8" autocomplete="new-password" required>
      </div>
      <div class="field">
        <label class="field-label">Confirm Password</label>
        <input type="password" name="confirm" placeholder="Repeat password" autocomplete="new-password" required>
      </div>
      <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center;padding:11px;font-size:.95rem;margin-top:6px">
        Create Account →
      </button>
    </form>
    <p style="text-align:center;margin-top:20px;font-size:.82rem;color:var(--text2)">
      Already have an account? <a href="/auth/login">Sign in →</a>
    </p>
  </div>
</div>`));
    });

    app.post('/auth/register', async (req, res) => {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        // Basic rate limit: reuse login limiter for register (8 per 15min)
        if (!saasAuth.loginRateLimiter.check(ip + '_reg')) return res.redirect('/auth/register?err=server');
        try {
            const { username='', email='', password='', confirm='' } = req.body;
            // Validation
            if (!username.trim() || !email.trim() || !password) return res.redirect('/auth/register?err=invalid');
            if (!/^[a-zA-Z0-9_]{3,32}$/.test(username.trim())) return res.redirect('/auth/register?err=invalid');
            if (password.length < 8) return res.redirect('/auth/register?err=short_password');
            if (password !== confirm) return res.redirect('/auth/register?err=mismatch');
            // Uniqueness checks
            const existingEmail = await db.findSaasUserByEmail(email);
            if (existingEmail) return res.redirect('/auth/register?err=exists_email');
            const existingUser = await db.findSaasUserByUsername(username.trim());
            if (existingUser) return res.redirect('/auth/register?err=exists_username');
            // Create
            const passwordHash = await saasAuth.hashPassword(password);
            await db.createSaasUser({ username: username.trim(), email, passwordHash });
            res.redirect('/auth/login?registered=1');
        } catch (e) {
            console.error('[AUTH] Register error:', e.message);
            res.redirect('/auth/register?err=server');
        }
    });

    // ── Login page ────────────────────────────────────────────────
    app.get('/auth/login', (req, res) => {
        const err = req.query.err;
        const registered = req.query.registered ? '<p style="color:var(--green);font-size:.85rem;text-align:center;margin-bottom:12px">✅ Account created! Please sign in.</p>' : '';
        const suspended  = req.query.suspended  ? '<p style="color:var(--yellow);font-size:.85rem;text-align:center;margin-bottom:12px">⚠️ Your account has been suspended. Contact support.</p>' : '';
        const errMsg = {
            invalid:  '❌ Invalid email or password.',
            locked:   '🔒 Too many attempts. Try again in 15 minutes.',
            server:   '❌ Server error — please try again.',
        }[err] || '';
        const nextUrl = req.query.next ? `<input type="hidden" name="next" value="${req.query.next}">` : '';

        res.send(_html('Login', `
<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px">
  <div style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:40px 36px;width:100%;max-width:380px">
    <div style="text-align:center;margin-bottom:28px">
      <div style="font-size:2.2rem;margin-bottom:8px">📊</div>
      <h1 style="font-size:1.4rem;margin-bottom:4px">Sign In</h1>
      <p style="color:var(--text2);font-size:.85rem">Apex-MD Trading Portal</p>
    </div>
    ${registered}${suspended}
    ${errMsg ? `<div style="background:#3a1a1a;border:1px solid var(--red);border-radius:8px;padding:10px 13px;margin-bottom:16px;font-size:.83rem;color:var(--red)">${errMsg}</div>` : ''}
    <form method="POST" action="/auth/login">
      ${nextUrl}
      <div class="field">
        <label class="field-label">Email Address</label>
        <input type="email" name="email" placeholder="you@example.com" autocomplete="email" autofocus required>
      </div>
      <div class="field">
        <label class="field-label">Password</label>
        <input type="password" name="password" placeholder="Your password" autocomplete="current-password" required>
      </div>
      <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center;padding:11px;font-size:.95rem;margin-top:6px">
        Sign In →
      </button>
    </form>
    <p style="text-align:center;margin-top:20px;font-size:.82rem;color:var(--text2)">
      New here? <a href="/auth/register">Create account →</a>
    </p>
    <p style="text-align:center;margin-top:8px;font-size:.75rem;color:var(--text2)">
      Are you the owner? <a href="/admin/login">Admin panel →</a>
    </p>
  </div>
</div>`));
    });

    app.post('/auth/login', async (req, res) => {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        if (!saasAuth.loginRateLimiter.check(ip)) return res.redirect('/auth/login?err=locked');
        try {
            const { email='', password='', next='' } = req.body;
            if (!email || !password) return res.redirect('/auth/login?err=invalid');
            const user = await db.findSaasUserByEmail(email);
            if (!user) return res.redirect('/auth/login?err=invalid');
            if (user.accountStatus === 'suspended') return res.redirect('/auth/login?suspended=1');
            const valid = await saasAuth.verifyPassword(password, user.passwordHash);
            if (!valid) return res.redirect('/auth/login?err=invalid');
            // Success
            saasAuth.loginRateLimiter.reset(ip);
            await db.recordSaasLogin(user._id);
            const token = saasAuth.signUserToken({
                userId:        user._id.toString(),
                username:      user.username,
                role:          user.role,
                accountStatus: user.accountStatus,
                exp:           Date.now() + saasAuth.USER_COOKIE_TTL,
            });
            res.setHeader('Set-Cookie', saasAuth.buildUserCookieHeader(token, saasAuth.USER_COOKIE_TTL));
            const dest = next && next.startsWith('/app') ? next : '/app/';
            res.redirect(dest);
        } catch (e) {
            console.error('[AUTH] Login error:', e.message);
            res.redirect('/auth/login?err=server');
        }
    });

    app.get('/auth/logout', (req, res) => {
        res.setHeader('Set-Cookie', saasAuth.clearUserCookieHeader());
        res.redirect('/auth/login');
    });

    // ═════════════════════════════════════════════════════════════
    //  SECTION 5 — USER PORTAL  (/app/*)
    //  Protected by saasAuth.requireUserAuth middleware
    // ═════════════════════════════════════════════════════════════

    app.use('/app', saasAuth.requireUserAuth);

    // ── App Home ──────────────────────────────────────────────────
    app.get('/app/', async (req, res) => {
        const user = req.saasUser;
        let activeTrades = [], closedCount = 0, winRate = '—';
        try {
            activeTrades = await db.getSaasUserActiveTrades(user.userId);
            const closed = await db.getSaasUserTradeHistory(user.userId, 200);
            closedCount = closed.length;
            if (closed.length > 0) {
                const wins = closed.filter(t => t.result === 'WIN').length;
                winRate = ((wins / closed.length) * 100).toFixed(1) + '%';
            }
        } catch (_) {}

        const tradesHtml = activeTrades.length === 0
            ? '<tr><td colspan="7" style="text-align:center;color:var(--text2);padding:24px">No active trades assigned to your account.</td></tr>'
            : activeTrades.map(t => {
                const dir = t.direction==='LONG' ? '<span class="pill long">LONG</span>' : '<span class="pill short">SHORT</span>';
                const st  = t.status==='pending' ? '<span class="pill pending">PENDING</span>' : '<span class="pill active">ACTIVE</span>';
                const hrs = ((Date.now() - new Date(t.openTime)) / 3600000).toFixed(1);
                return `<tr><td><strong>${t.coin}</strong></td><td>${dir}</td>
                    <td>$${parseFloat(t.entry).toFixed(4)}</td>
                    <td>$${parseFloat(t.tp2||t.tp||0).toFixed(4)}</td>
                    <td>$${parseFloat(t.sl||0).toFixed(4)}</td>
                    <td>${t.leverage||1}x</td><td>${st} · ${hrs}h</td></tr>`;
            }).join('');

        res.send(_html('My Dashboard', `
${_appNav('home', user.username)}
<div class="wrap">
  <h1>👋 Welcome back, ${user.username}</h1>

  <div class="grid">
    <div class="card">
      <div class="card-label">Active Trades</div>
      <div class="card-val blue">${activeTrades.length}</div>
      <div class="card-sub">Open positions</div>
    </div>
    <div class="card">
      <div class="card-label">Closed Trades</div>
      <div class="card-val">${closedCount}</div>
      <div class="card-sub">Completed trades</div>
    </div>
    <div class="card">
      <div class="card-label">Win Rate</div>
      <div class="card-val green">${winRate}</div>
      <div class="card-sub">Historical</div>
    </div>
    <div class="card">
      <div class="card-label">Account</div>
      <div class="card-val" style="font-size:1rem;padding-top:4px"><span class="pill active-status">active</span></div>
      <div class="card-sub">${user.role} account</div>
    </div>
  </div>

  <div class="section">
    <h2>⚡ My Active Trades</h2>
    <p style="font-size:.82rem;color:var(--text2);margin-bottom:14px">
      Trades assigned to your account by the bot. Full history in <a href="/app/trades">My Trades</a>.
    </p>
    <div style="overflow-x:auto">
    <table>
      <thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP</th><th>SL</th><th>Lev</th><th>Status</th></tr></thead>
      <tbody>${tradesHtml}</tbody>
    </table>
    </div>
  </div>

  <div class="section" style="background:linear-gradient(135deg,#0d2137,#161b22)">
    <h2>🔑 API Keys</h2>
    <p style="font-size:.85rem;color:var(--text2);margin-bottom:14px">
      Connect your Binance or Bybit account to enable live trading signals.
    </p>
    <a href="/app/settings" class="btn btn-primary">⚙️ Manage API Keys →</a>
  </div>
</div>`));
    });

    // ── App Trades ────────────────────────────────────────────────
    app.get('/app/trades', async (req, res) => {
        const user = req.saasUser;
        let activeHtml = '<tr><td colspan="8" style="text-align:center;color:var(--text2);padding:24px">No active trades.</td></tr>';
        let closedHtml = '<tr><td colspan="8" style="text-align:center;color:var(--text2);padding:24px">No trade history yet.</td></tr>';
        let totalPnl = 0, wins = 0, totalClosed = 0;
        try {
            const active = await db.getSaasUserActiveTrades(user.userId);
            if (active.length) activeHtml = active.map(t => {
                const dir = t.direction==='LONG' ? '<span class="pill long">LONG</span>' : '<span class="pill short">SHORT</span>';
                const st  = t.status==='pending' ? '<span class="pill pending">PENDING</span>' : '<span class="pill active">ACTIVE</span>';
                const hrs = ((Date.now() - new Date(t.openTime)) / 3600000).toFixed(1);
                return `<tr><td><strong>${t.coin}</strong></td><td>${dir}</td>
                    <td>$${parseFloat(t.entry).toFixed(4)}</td><td>$${parseFloat(t.tp1||0).toFixed(4)}</td>
                    <td>$${parseFloat(t.tp2||t.tp||0).toFixed(4)}</td><td>$${parseFloat(t.sl||0).toFixed(4)}</td>
                    <td>${t.leverage||1}x</td><td>${st} · ${hrs}h</td></tr>`;
            }).join('');
            const closed = await db.getSaasUserTradeHistory(user.userId, 100);
            totalClosed = closed.length;
            if (closed.length) {
                closed.forEach(t => { totalPnl += t.pnlPct||0; if (t.result==='WIN') wins++; });
                closedHtml = closed.map(t => {
                    const dir    = t.direction==='LONG' ? '<span class="pill long">LONG</span>' : '<span class="pill short">SHORT</span>';
                    const result = t.result==='WIN' ? '<span class="pill win">WIN</span>' : t.result==='LOSS' ? '<span class="pill loss">LOSS</span>' : '<span class="pill be">B/E</span>';
                    const pnl    = t.pnlPct ? (t.pnlPct>0?'+':'')+parseFloat(t.pnlPct).toFixed(2)+'%' : '—';
                    const pnlColor = t.pnlPct>0?'var(--green)':t.pnlPct<0?'var(--red)':'var(--text2)';
                    const dt     = t.closedAt ? new Date(t.closedAt).toLocaleDateString() : '—';
                    return `<tr><td><strong>${t.coin}</strong></td><td>${dir}</td>
                        <td>$${parseFloat(t.entry).toFixed(4)}</td>
                        <td>$${parseFloat(t.tp2||t.tp||0).toFixed(4)}</td>
                        <td>$${parseFloat(t.sl||0).toFixed(4)}</td>
                        <td>${result}</td>
                        <td style="color:${pnlColor};font-weight:600">${pnl}</td><td>${dt}</td></tr>`;
                }).join('');
            }
        } catch (_) {}

        const winRate = totalClosed > 0 ? ((wins/totalClosed)*100).toFixed(1) : '—';
        const pnlColor = totalPnl >= 0 ? 'var(--green)' : 'var(--red)';

        res.send(_html('My Trades', `
${_appNav('trades', user.username)}
<div class="wrap">
  <h1>📋 My Trades</h1>
  <div class="grid" style="margin-bottom:20px">
    <div class="card"><div class="card-label">Closed Trades</div><div class="card-val blue">${totalClosed}</div></div>
    <div class="card"><div class="card-label">Win Rate</div><div class="card-val green">${winRate}${winRate!=='—'?'%':''}</div></div>
    <div class="card"><div class="card-label">Total PnL</div><div class="card-val" style="color:${pnlColor}">${totalPnl>=0?'+':''}${totalPnl.toFixed(2)}%</div></div>
  </div>
  <div class="section">
    <h2>⚡ Active & Pending</h2>
    <div style="overflow-x:auto">
    <table><thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP1</th><th>TP2</th><th>SL</th><th>Lev</th><th>Status</th></tr></thead>
    <tbody>${activeHtml}</tbody></table></div>
  </div>
  <div class="section">
    <h2>📜 Trade History (Last 100)</h2>
    <div style="overflow-x:auto">
    <table><thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>TP2</th><th>SL</th><th>Result</th><th>PnL%</th><th>Date</th></tr></thead>
    <tbody>${closedHtml}</tbody></table></div>
  </div>
</div>`));
    });

    // ── App Settings (API Key management) ────────────────────────
    app.get('/app/settings', async (req, res) => {
        const user = req.saasUser;
        let apiKeys = [];
        try {
            const fullUser = await db.getSaasUserById(user.userId);
            if (fullUser) {
                apiKeys = (fullUser.apiKeys || []).map(k => ({
                    _id:      k._id.toString(),
                    label:    k.label,
                    exchange: k.exchange,
                    addedAt:  new Date(k.addedAt).toLocaleDateString(),
                }));
            }
        } catch (_) {}

        const keysHtml = apiKeys.length === 0
            ? '<p style="color:var(--text2);font-size:.88rem;padding:16px 0">No API keys added yet. Add one below to start trading.</p>'
            : `<table style="margin-bottom:16px"><thead><tr><th>Label</th><th>Exchange</th><th>Added</th><th>Action</th></tr></thead><tbody>
            ${apiKeys.map(k => `<tr>
                <td><strong>${k.label}</strong></td>
                <td style="text-transform:capitalize">${k.exchange}</td>
                <td style="font-size:.83rem;color:var(--text2)">${k.addedAt}</td>
                <td><button class="btn btn-danger" style="padding:3px 9px;font-size:.75rem" onclick="removeKey('${k._id}')">Remove</button></td>
            </tr>`).join('')}
            </tbody></table>`;

        const addedMsg    = req.query.added    ? '<p style="color:var(--green);font-size:.83rem;margin-bottom:10px">✅ API key added successfully.</p>' : '';
        const removedMsg  = req.query.removed  ? '<p style="color:var(--green);font-size:.83rem;margin-bottom:10px">✅ API key removed.</p>' : '';
        const keyErrMsg   = req.query.keyerr === 'exists' ? '<p style="color:var(--red);font-size:.83rem;margin-bottom:10px">❌ A key with that label already exists.</p>'
                          : req.query.keyerr === 'invalid' ? '<p style="color:var(--red);font-size:.83rem;margin-bottom:10px">❌ Please fill in all fields.</p>'
                          : req.query.keyerr ? '<p style="color:var(--red);font-size:.83rem;margin-bottom:10px">❌ Error saving key.</p>' : '';

        res.send(_html('API Keys', `
${_appNav('settings', user.username)}
<div class="wrap">
  <h1>🔑 API Key Management</h1>

  <div class="section">
    <h2>🗝️ Your Connected Exchanges</h2>
    <p style="font-size:.82rem;color:var(--text2);margin-bottom:16px">
      API keys are stored encrypted (AES-256-GCM). They are used to receive trading signals.<br>
      <strong style="color:var(--yellow)">⚠️ Never share your secret key with anyone.</strong>
    </p>
    ${addedMsg}${removedMsg}${keyErrMsg}
    ${keysHtml}
  </div>

  <div class="section">
    <h2>➕ Add New API Key</h2>
    <form method="POST" action="/app/api/keys/add" style="max-width:480px">
      <div class="field">
        <label class="field-label">Label</label>
        <input type="text" name="label" placeholder="e.g. Binance Main" required maxlength="40">
      </div>
      <div class="field">
        <label class="field-label">Exchange</label>
        <select name="exchange" style="background:#0d1117;border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text);font-size:.88rem;width:100%">
          <option value="binance">Binance</option>
          <option value="bybit">Bybit</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label">API Key</label>
        <input type="text" name="apiKey" placeholder="Your API key" autocomplete="off" required>
      </div>
      <div class="field">
        <label class="field-label">Secret Key</label>
        <input type="password" name="secretKey" placeholder="Your secret key" autocomplete="off" required>
      </div>
      <button type="submit" class="btn btn-primary">🔒 Save Encrypted Key</button>
    </form>
  </div>

  <div class="section">
    <h2>👤 Account Info</h2>
    <div class="stat-row"><span>Username</span><span class="stat-val">${user.username}</span></div>
    <div class="stat-row"><span>Role</span><span class="stat-val">${user.role}</span></div>
    <div class="stat-row"><span>Account Status</span><span class="stat-val"><span class="pill active-status">active</span></span></div>
  </div>
</div>
<script>
async function removeKey(keyId) {
  if (!confirm('Remove this API key? This cannot be undone.')) return;
  try {
    const r = await fetch('/app/api/keys/' + keyId, { method: 'DELETE' });
    const d = await r.json();
    if (d.ok) location.href = '/app/settings?removed=1';
    else alert('Error: ' + d.error);
  } catch(e) { alert('Network error: ' + e.message); }
}
</script>`));
    });

    // ── App API: Add key ──────────────────────────────────────────
    app.post('/app/api/keys/add', saasAuth.requireUserAuth, async (req, res) => {
        try {
            const user = req.saasUser;
            const { label='', exchange='binance', apiKey='', secretKey='' } = req.body;
            if (!label.trim() || !apiKey.trim() || !secretKey.trim()) return res.redirect('/app/settings?keyerr=invalid');
            // Check label uniqueness for this user
            const fullUser = await db.getSaasUserById(user.userId);
            if (fullUser && fullUser.apiKeys.some(k => k.label === label.trim())) return res.redirect('/app/settings?keyerr=exists');
            // Encrypt and store
            const entry = {
                label:        label.trim(),
                exchange:     exchange === 'bybit' ? 'bybit' : 'binance',
                encApiKey:    saasAuth.encryptApiKey(apiKey.trim()),
                encSecretKey: saasAuth.encryptApiKey(secretKey.trim()),
            };
            await db.addUserApiKey(user.userId, entry);
            res.redirect('/app/settings?added=1');
        } catch (e) {
            console.error('[APP] Add key error:', e.message);
            res.redirect('/app/settings?keyerr=server');
        }
    });

    // ── App API: Remove key ───────────────────────────────────────
    app.delete('/app/api/keys/:keyId', saasAuth.requireUserAuth, async (req, res) => {
        try {
            await db.removeUserApiKey(req.saasUser.userId, req.params.keyId);
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    // ── Root redirect ─────────────────────────────────────────────
    app.get('/', (req, res) => res.redirect('/auth/login'));

    // ─────────────────────────────────────────────────────────────
    //  START SERVER
    // ─────────────────────────────────────────────────────────────
    app.listen(port, () => {
        console.log(`\n🌐 [Server] Running on port ${port}`);
        console.log(`🔐 [Admin]  http://localhost:${port}/admin/`);
        console.log(`👥 [Portal] http://localhost:${port}/app/`);
        console.log(`🔑 [Auth]   http://localhost:${port}/auth/login`);
        console.log(`↩️  [Compat] /dashboard/* → /admin/* (301 redirect)`);
    });

    return { setBotConnected, log };
}

module.exports = { initDashboard, setBotConnected, log };
