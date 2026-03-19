'use strict';
/**
 * APEX-MD · dashboard-app.js
 * ══════════════════════════════════════════════════════════════
 *  Routes:
 *    GET  /app/              → Dashboard home
 *    GET  /app/trades        → Trade history
 *    GET  /app/settings      → Settings + WA link + API keys
 *    GET  /app/paper         → Paper trading (view + open + close)
 *    GET  /app/watchlist     → Watchlist (add/remove/prices)
 *    GET  /app/alerts        → Price alerts (create/delete)
 *    GET  /app/news          → Market intel (F&G + news)
 *    GET  /app/calc          → Risk/position calculator
 *    POST /app/api/*         → All API endpoints for above pages
 * ══════════════════════════════════════════════════════════════
 */

module.exports = function registerApp({ saasAuth, db, config, axios, _html, _appNav, fmtPrice, fmtPct, scoreColor }, app) {

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

// ══════════════════════════════════════════════════════════════
//  STATS PAGE  GET /app/stats
// ══════════════════════════════════════════════════════════════
app.get('/app/stats', saasAuth.requireUserAuth, async (req, res) => {
    const user = req.saasUser;
    let history = [], paperUser = null;
    try {
        history = await db.getSaasUserTradeHistory(user.userId, 100);
        const fullUser = await db.getSaasUserById(user.userId);
        if (fullUser && fullUser.whatsappJid) {
            paperUser = await db.getUser(fullUser.whatsappJid).catch(() => null);
        }
    } catch(_) {}

    const closed  = history.filter(t => t.result === 'WIN' || t.result === 'LOSS');
    const wins    = closed.filter(t => t.result === 'WIN').length;
    const losses  = closed.filter(t => t.result === 'LOSS').length;
    const wr      = closed.length > 0 ? (wins / closed.length * 100).toFixed(1) : 0;
    const pnlSum  = closed.reduce((s, t) => s + (parseFloat(t.pnlPct) || 0), 0).toFixed(2);
    const longs   = closed.filter(t => t.direction === 'LONG').length;
    const shorts  = closed.filter(t => t.direction === 'SHORT').length;
    const best    = closed.length ? [...closed].sort((a, b) => (b.pnlPct||0) - (a.pnlPct||0))[0] : null;

    const pb      = paperUser ? paperUser.paperBalance : 0;
    const ps      = paperUser ? (paperUser.paperStartBalance || 100) : 100;
    const pProfit = (pb - ps).toFixed(2);
    const pWins   = paperUser ? paperUser.paperWins   : 0;
    const pLosses = paperUser ? paperUser.paperLosses : 0;
    const pTotal  = pWins + pLosses;
    const pWr     = pTotal > 0 ? (pWins / pTotal * 100).toFixed(1) : 0;

    function wrBar(n, col) {
        return '<div style="height:7px;background:var(--border);border-radius:99px;overflow:hidden;margin-top:5px">'
             + '<div style="height:100%;width:' + Math.min(n, 100) + '%;background:' + col + ';border-radius:99px"></div></div>';
    }
    const wrCol  = wr >= 60  ? 'var(--green)' : wr >= 45  ? 'var(--yellow)' : 'var(--red)';
    const pWrCol = pWr >= 60 ? 'var(--green)' : pWr >= 45 ? 'var(--yellow)' : 'var(--red)';

    const histRows = history.slice(0, 50).map(t => {
        const dir = t.direction === 'LONG'
            ? '<span style="color:var(--green)">▲ LONG</span>'
            : '<span style="color:var(--red)">▼ SHORT</span>';
        const resStyle = t.result === 'WIN' ? 'color:var(--green);font-weight:700'
                       : t.result === 'LOSS' ? 'color:var(--red);font-weight:700'
                       : 'color:var(--text2)';
        const pnlCol = (t.pnlPct || 0) >= 0 ? 'var(--green)' : 'var(--red)';
        const pnlStr = t.pnlPct != null
            ? '<span style="color:' + pnlCol + '">' + (t.pnlPct >= 0 ? '+' : '') + parseFloat(t.pnlPct).toFixed(2) + '%</span>'
            : '—';
        const dt = t.openTime ? new Date(t.openTime).toLocaleDateString() : '—';
        return '<tr style="border-bottom:1px solid var(--border)">'
             + '<td style="padding:9px 14px;font-family:var(--font-mono);font-weight:700">' + (t.coin||'').replace('USDT','') + '</td>'
             + '<td style="padding:9px 8px;font-size:.8rem">' + dir + '</td>'
             + '<td style="padding:9px 8px;font-family:var(--font-mono)">' + fmtPrice(t.entry) + '</td>'
             + '<td style="padding:9px 8px;font-family:var(--font-mono);color:var(--green)">' + fmtPrice(t.tp2||t.tp) + '</td>'
             + '<td style="padding:9px 8px;font-family:var(--font-mono);color:var(--red)">' + fmtPrice(t.sl) + '</td>'
             + '<td style="padding:9px 8px"><span style="' + resStyle + '">' + (t.result||'—') + '</span></td>'
             + '<td style="padding:9px 8px;font-family:var(--font-mono)">' + pnlStr + '</td>'
             + '<td style="padding:9px 8px;color:var(--text2);font-size:.78rem">' + dt + '</td>'
             + '</tr>';
    }).join('');

    const pnlColor = parseFloat(pnlSum) >= 0 ? 'var(--green)' : 'var(--red)';
    const pProfitColor = parseFloat(pProfit) >= 0 ? 'var(--green)' : 'var(--red)';

    res.send(_html('Stats & Journal', `
${_appNav('stats', user.username)}
<div class="wrap">
  <h1 class="page-title">📊 Trade Journal <span>Performance Statistics</span></h1>

  <div class="g-stats" style="margin-bottom:20px">
    <div class="stat-card"><div class="stat-label">Total Closed</div><div class="stat-val c-cyan">${closed.length}</div></div>
    <div class="stat-card">
      <div class="stat-label">Win Rate</div>
      <div class="stat-val" style="color:${wrCol}">${wr}%</div>
      ${wrBar(wr, wrCol)}
    </div>
    <div class="stat-card">
      <div class="stat-label">Wins / Losses</div>
      <div class="stat-val"><span style="color:var(--green)">${wins}</span> / <span style="color:var(--red)">${losses}</span></div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Net P&amp;L</div>
      <div class="stat-val" style="color:${pnlColor}">${parseFloat(pnlSum) >= 0 ? '+' : ''}${pnlSum}%</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Long / Short</div>
      <div class="stat-val"><span style="color:var(--green)">${longs}L</span> / <span style="color:var(--red)">${shorts}S</span></div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Best Trade</div>
      <div class="stat-val c-green" style="font-size:.9rem">${best ? best.coin.replace('USDT','') + '  +' + (best.pnlPct||0).toFixed(1) + '%' : '—'}</div>
    </div>
  </div>

  <div class="panel" style="margin-bottom:20px;border-color:rgba(0,200,255,.2)">
    <div class="panel-head"><div class="panel-title">📄 Auto Paper Trading Performance</div></div>
    <div class="panel-body">
      <div class="g-stats" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
        <div class="stat-card"><div class="stat-label">Virtual Balance</div><div class="stat-val c-cyan">$${pb.toFixed(2)}</div></div>
        <div class="stat-card">
          <div class="stat-label">Net Profit</div>
          <div class="stat-val" style="color:${pProfitColor}">${parseFloat(pProfit) >= 0 ? '+' : ''}$${pProfit}</div>
        </div>
        <div class="stat-card"><div class="stat-label">Paper Trades</div><div class="stat-val">${pTotal}</div></div>
        <div class="stat-card">
          <div class="stat-label">Win Rate</div>
          <div class="stat-val" style="color:${pWrCol}">${pWr}%</div>
          ${wrBar(pWr, pWrCol)}
        </div>
        <div class="stat-card">
          <div class="stat-label">W / L</div>
          <div class="stat-val"><span style="color:var(--green)">${pWins}</span> / <span style="color:var(--red)">${pLosses}</span></div>
        </div>
      </div>
      ${!paperUser ? '<div style="color:var(--text2);font-size:.82rem;margin-top:10px">📌 WhatsApp link කරන්න Settings වලින් paper trade data ගන්නට.</div>' : ''}
    </div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <div class="panel-title">📋 Trade History <span style="font-size:.72rem;color:var(--text2);font-weight:400">(Last 50)</span></div>
    </div>
    ${history.length === 0
      ? '<div style="padding:40px;text-align:center;color:var(--text2)">Trades නොමැත. .future හෝ .spot command ලෙස signal ගෙන trade කරන්න.</div>'
      : '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.82rem">'
      + '<thead><tr style="background:var(--card2);color:var(--text2);font-size:.72rem;text-transform:uppercase;letter-spacing:.06em">'
      + '<th style="padding:10px 14px;text-align:left">Coin</th>'
      + '<th style="padding:10px 8px;text-align:left">Dir</th>'
      + '<th style="padding:10px 8px;text-align:left">Entry</th>'
      + '<th style="padding:10px 8px;text-align:left">TP2</th>'
      + '<th style="padding:10px 8px;text-align:left">SL</th>'
      + '<th style="padding:10px 8px;text-align:left">Result</th>'
      + '<th style="padding:10px 8px;text-align:left">P&amp;L</th>'
      + '<th style="padding:10px 8px;text-align:left">Date</th>'
      + '</tr></thead>'
      + '<tbody>' + histRows + '</tbody>'
      + '</table></div>'
    }
  </div>
</div>`));
});

// ══════════════════════════════════════════════════════════════
//  AI CHAT PAGE  GET /app/ai
// ══════════════════════════════════════════════════════════════
app.get('/app/ai', saasAuth.requireUserAuth, (req, res) => {
    const user = req.saasUser;
    res.send(_html('AI Assistant', `
${_appNav('ai', user.username)}
<div class="wrap" style="max-width:860px">
  <h1 class="page-title">🤖 AI Market Assistant <span>GROQ Llama 3 70B · Crypto Expert</span></h1>
  <div class="panel" style="border-color:rgba(124,58,237,.25)">
    <div class="panel-head" style="background:rgba(124,58,237,.06)">
      <div class="panel-title" style="color:#a78bfa">🤖 Apex AI — Crypto Trading Expert</div>
      <div style="font-size:.72rem;color:var(--text2)">Powered by GROQ Llama 3 70B · Sinhala + English</div>
    </div>
    <div id="chat-msgs" style="height:440px;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px">
      <div class="ai-msg ai-bot">
        <div class="ai-avatar">&#x26A1;</div>
        <div class="ai-bubble">&#x1F44B; ආයුබෝවන්! මම Apex AI. Crypto trading, technical analysis, SMC, strategy — ඕනෑ දෙයක් අහන්න.<br><br><em>Examples: "BTC 15m trend?" · "SOL LONG setup?" · "RSI divergence explain"</em></div>
      </div>
    </div>
    <div style="padding:14px 20px;border-top:1px solid var(--border);display:flex;gap:10px">
      <input type="text" id="ai-input" class="inp" placeholder="Message Apex AI..." style="flex:1" maxlength="500">
      <button class="btn btn-primary" id="ai-send" onclick="sendMsg()" style="min-width:80px">Send &#x2191;</button>
    </div>
    <div style="padding:0 20px 14px;display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn btn-ghost btn-sm" onclick="quickQ(this)">BTC market trend?</button>
      <button class="btn btn-ghost btn-sm" onclick="quickQ(this)">SOL short setup?</button>
      <button class="btn btn-ghost btn-sm" onclick="quickQ(this)">Best coins today?</button>
      <button class="btn btn-ghost btn-sm" onclick="quickQ(this)">RSI divergence explain</button>
      <button class="btn btn-ghost btn-sm" onclick="quickQ(this)">Fear and Greed meaning?</button>
      <button class="btn btn-ghost btn-sm" onclick="quickQ(this)">SMC Order Block explain</button>
    </div>
  </div>
</div>
<style>
.ai-msg{display:flex;gap:10px;align-items:flex-start}
.ai-msg.ai-user{flex-direction:row-reverse}
.ai-bubble{max-width:78%;padding:10px 14px;border-radius:12px;font-size:.85rem;line-height:1.6}
.ai-msg.ai-bot .ai-bubble{background:var(--card2);border:1px solid var(--border);border-radius:4px 12px 12px 12px;color:var(--text)}
.ai-msg.ai-user .ai-bubble{background:rgba(0,200,255,.1);border:1px solid rgba(0,200,255,.2);border-radius:12px 4px 12px 12px;color:var(--text)}
.ai-avatar{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.9rem;flex-shrink:0;background:var(--card2);border:1px solid var(--border)}
.ai-dot{width:6px;height:6px;border-radius:50%;background:var(--text2);animation:aibounce .9s infinite;display:inline-block;margin:0 2px}
.ai-dot:nth-child(2){animation-delay:.15s}.ai-dot:nth-child(3){animation-delay:.3s}
@keyframes aibounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}
</style>
<script>
var chatHistory = [
  {role:'system', content:'You are Apex AI, a professional crypto futures trading assistant inside the Apex-MD trading bot. Specialise in futures, SMC (Smart Money Concepts), technical analysis, and risk management. Be concise and practical. Reply in both English and Sinhala naturally. Never give financial advice - give analysis only.'}
];
function appendMsg(role, html) {
  var box = document.getElementById('chat-msgs');
  var div = document.createElement('div');
  div.className = 'ai-msg ' + (role === 'user' ? 'ai-user' : 'ai-bot');
  div.innerHTML = '<div class="ai-avatar">' + (role === 'user' ? '&#x1F464;' : '&#x26A1;') + '</div><div class="ai-bubble">' + html + '</div>';
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
function showTyping() {
  var box = document.getElementById('chat-msgs');
  var d = document.createElement('div');
  d.className = 'ai-msg ai-bot'; d.id = 'ai-typing';
  d.innerHTML = '<div class="ai-avatar">&#x26A1;</div><div class="ai-bubble"><span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span></div>';
  box.appendChild(d); box.scrollTop = box.scrollHeight;
}
function removeTyping() { var t = document.getElementById('ai-typing'); if (t) t.remove(); }
function fmtReply(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\n/g,'<br>')
    .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g,'<strong>$1</strong>');
}
async function sendMsg() {
  var inp = document.getElementById('ai-input');
  var text = inp.value.trim(); if (!text) return;
  inp.value = '';
  document.getElementById('ai-send').disabled = true;
  appendMsg('user', text.replace(/&/g,'&amp;').replace(/</g,'&lt;'));
  chatHistory.push({role:'user', content:text});
  showTyping();
  try {
    var r = await fetch('/app/api/ai-chat', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({messages: chatHistory.slice(-14)})
    });
    var d = await r.json(); removeTyping();
    if (!d.ok) { appendMsg('bot', '&#10060; ' + (d.error || 'Error')); return; }
    chatHistory.push({role:'assistant', content:d.reply});
    appendMsg('bot', fmtReply(d.reply));
  } catch(e) { removeTyping(); appendMsg('bot', 'Network error: ' + e.message); }
  finally { document.getElementById('ai-send').disabled = false; }
}
function quickQ(btn) { document.getElementById('ai-input').value = btn.textContent; sendMsg(); }
document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('ai-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') sendMsg();
  });
});
</script>`));
});

// ── AI Chat API  POST /app/api/ai-chat ────────────────────────
app.post('/app/api/ai-chat', saasAuth.requireUserAuth, async (req, res) => {
    try {
        if (!config.GROQ_API) {
            return res.json({ok:false, error:'GROQ API key නැත. config.env හි GROQ_API add කරන්න.'});
        }
        const {messages = []} = req.body;
        if (!messages.length) return res.status(400).json({ok:false, error:'No messages'});
        const r = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {model:'llama-3.3-70b-versatile', messages:messages.slice(-14), max_tokens:600, temperature:0.5},
            {headers:{Authorization:'Bearer ' + config.GROQ_API}, timeout:20000}
        );
        res.json({ok:true, reply: r.data.choices[0].message.content || ''});
    } catch(e) {
        console.error('[AI Chat]', e.message);
        res.status(500).json({ok:false, error: e.message});
    }
});


}; // end module.exports
