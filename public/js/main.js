/* ═══════════════════════════════════════════════════════════════
   APEX-MD Web Dashboard — Main App (js/main.js)
   ═══════════════════════════════════════════════════════════════ */

// ── Auth guard ────────────────────────────────────────────────────
const token = localStorage.getItem('apex_token');
const currentUser = (() => {
  try { return JSON.parse(localStorage.getItem('apex_user') || '{}'); } catch { return {}; }
})();
if (!token) window.location.href = '/';

// ── Toast system ──────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 3500) {
  const icons = { success:'✅', error:'❌', info:'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]||'•'}</span><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => { el.style.opacity='0'; el.style.transform='translateX(100%)'; el.style.transition='.3s'; setTimeout(()=>el.remove(),300); }, duration);
}

// ── Navigation ────────────────────────────────────────────────────
let currentSection = '';
function navigateTo(section) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.section === section));
  document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === 'sec-' + section));
  currentSection = section;
  document.getElementById('topbarTitle').textContent = NAV_TITLES[section] || 'Dashboard';
  closeSidebar();
  loadSection(section);
}

const NAV_TITLES = {
  dashboard: 'Dashboard',
  analysis:  'Market Analysis',
  paper:     'Paper Trading',
  trades:    'Real Trade Tracking',
  scanner:   'Scanner',
  watchlist: 'Watchlist',
  alerts:    'Price Alerts',
  tools:     'Tools & Calculator',
  settings:  'Bot Settings',
  system:    'System Admin',
  account:   'My Account',
};

// ── Sidebar mobile toggle ─────────────────────────────────────────
function toggleSidebar() {
  document.querySelector('.sidebar').classList.toggle('open');
  document.querySelector('.sidebar-overlay').classList.toggle('visible');
}
function closeSidebar() {
  document.querySelector('.sidebar').classList.remove('open');
  document.querySelector('.sidebar-overlay').classList.remove('visible');
}

// ── Logout ────────────────────────────────────────────────────────
function logout() {
  localStorage.removeItem('apex_token');
  localStorage.removeItem('apex_user');
  window.location.href = '/';
}

// ── Format helpers ────────────────────────────────────────────────
const fmt = {
  price: (v, dec=4)  => v == null ? 'N/A' : '$' + parseFloat(v).toLocaleString('en', {minimumFractionDigits:2, maximumFractionDigits:dec}),
  pnl:   (v, dec=2)  => {
    const n = parseFloat(v);
    return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(dec);
  },
  pct:   (v, dec=2)  => {
    const n = parseFloat(v);
    return (n >= 0 ? '+' : '') + n.toFixed(dec) + '%';
  },
  num:   (v, dec=4)  => v == null ? 'N/A' : parseFloat(v).toFixed(dec),
  time:  (d)         => {
    const dt = new Date(d);
    const h  = ((Date.now() - dt) / 3600000);
    if (h < 1)  return Math.round(h * 60) + 'm ago';
    if (h < 24) return h.toFixed(1) + 'h ago';
    return dt.toLocaleDateString('en', {month:'short',day:'numeric'});
  },
  date:  (d)         => new Date(d).toLocaleString('en', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}),
};

function pnlClass(v) { return parseFloat(v) >= 0 ? 'pos' : 'neg'; }
function dirBadge(d) {
  return d === 'LONG'
    ? '<span class="badge badge-green">▲ LONG</span>'
    : '<span class="badge badge-red">▼ SHORT</span>';
}
function statusBadge(s) {
  if (s === 'active')  return '<span class="badge badge-green">ACTIVE</span>';
  if (s === 'pending') return '<span class="badge badge-gold">PENDING</span>';
  return '<span class="badge badge-gray">CLOSED</span>';
}
function resultBadge(r) {
  if (r === 'WIN')    return '<span class="badge badge-green">WIN</span>';
  if (r === 'LOSS')   return '<span class="badge badge-red">LOSS</span>';
  if (r === 'CANCELLED') return '<span class="badge badge-gray">CANCELLED</span>';
  return '<span class="badge badge-gold">B/E</span>';
}

// ═══════════════════════════════════════════════════════════════
//  SECTION LOADERS
// ═══════════════════════════════════════════════════════════════

function loadSection(section) {
  switch (section) {
    case 'dashboard': loadDashboard(); break;
    case 'paper':     loadPaperTrades(); break;
    case 'trades':    loadRealTrades(); break;
    case 'watchlist': loadWatchlist(); break;
    case 'alerts':    loadAlerts(); break;
    case 'settings':  loadSettings(); break;
    case 'system':    loadSystem(); break;
    case 'account':   loadAccount(); break;
    case 'analysis':  loadAnalysis(); break;
    case 'tools':     /* static content */ break;
  }
}

// ── DASHBOARD ─────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const [mkt, pos, statsR] = await Promise.allSettled([
      API.market.overview(),
      API.paper.positions(),
      API.stats.get(),
    ]);

    // BTC Market overview
    if (mkt.status === 'fulfilled' && mkt.value) {
      const m = mkt.value;
      document.getElementById('db-btc-price').textContent = m.price ? fmt.price(m.price, 2) : '---';
      const chg = m.change24h;
      const chgEl = document.getElementById('db-btc-change');
      chgEl.textContent = chg != null ? fmt.pct(chg) : '---';
      chgEl.className = 'stat-sub ' + (chg >= 0 ? 'text-green' : 'text-red');
      document.getElementById('db-btc-high').textContent = m.high24h ? fmt.price(m.high24h, 2) : '---';
      document.getElementById('db-btc-low').textContent  = m.low24h  ? fmt.price(m.low24h,  2) : '---';
      if (m.fngValue != null) {
        const fngEl = document.getElementById('db-fng');
        fngEl.textContent = m.fngValue + ' — ' + (m.fngLabel || '');
        const fngVal = parseInt(m.fngValue);
        fngEl.className = 'stat-value sm text-mono ' + (fngVal >= 60 ? 'text-green' : fngVal >= 40 ? 'text-gold' : 'text-red');
      }
    }

    // Paper summary
    if (pos.status === 'fulfilled' && pos.value) {
      const p = pos.value;
      document.getElementById('db-open-count').textContent = p.count || 0;
      const pnlEl = document.getElementById('db-total-pnl');
      pnlEl.textContent = fmt.pnl(p.totalPnL || 0);
      pnlEl.className = 'stat-value text-mono ' + (p.totalPnL >= 0 ? 'text-green' : 'text-red');
      document.getElementById('db-balance').textContent = fmt.price(p.balance || 0, 2);
    }

    // Stats
    if (statsR.status === 'fulfilled' && statsR.value) {
      const { stats, waUser } = statsR.value;
      if (stats) {
        document.getElementById('db-win-rate').textContent = stats.winRate + '%';
        document.getElementById('db-closed').textContent   = stats.total  || 0;
      }
    }

    // Load watchlist prices for dashboard
    loadDashboardPrices();

  } catch(e) { console.error('loadDashboard', e); }
}

async function loadDashboardPrices() {
  try {
    const SYMS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT'];
    const prices = await API.market.prices(SYMS);
    if (!prices || !Array.isArray(prices)) return;
    const grid = document.getElementById('db-prices-grid');
    grid.innerHTML = prices.map(p => `
      <div class="coin-tile">
        <div>
          <div class="coin-symbol">${p.symbol?.replace('USDT','') || ''}</div>
          <div class="coin-change ${p.change24h >= 0 ? 'up' : 'down'}">${fmt.pct(p.change24h || 0)}</div>
        </div>
        <div class="coin-price text-mono ${p.change24h >= 0 ? 'text-green' : 'text-red'}">${fmt.price(p.price, 4)}</div>
      </div>`).join('');
  } catch(e) {}
}

// ── PAPER TRADING ─────────────────────────────────────────────────
async function loadPaperTrades() {
  document.getElementById('pt-positions-body').innerHTML = '<tr><td colspan="10" class="loading-state"><div class="loader"></div> Loading...</td></tr>';
  try {
    const data = await API.paper.positions();
    renderPaperPositions(data);
    // Also load account info
    const acc = await API.account.margin();
    document.getElementById('pt-balance').textContent = fmt.price(data.balance || acc.balance || 0, 2);
    document.getElementById('pt-margin').textContent  = fmt.price(acc.margin || 0, 2);
    document.getElementById('pt-unrealized').textContent = fmt.pnl(data.totalPnL || 0);
    document.getElementById('pt-unrealized').className = 'stat-value text-mono ' + (data.totalPnL >= 0 ? 'text-green' : 'text-red');
    document.getElementById('pt-open-count').textContent = (data.count || 0) + '/5';
  } catch(e) {
    document.getElementById('pt-positions-body').innerHTML = `<tr><td colspan="10"><div class="alert-strip alert-error">❌ ${e.message}</div></td></tr>`;
  }
}

function renderPaperPositions(data) {
  const tbody = document.getElementById('pt-positions-body');
  if (!data?.trades?.length) {
    tbody.innerHTML = '<tr><td colspan="10"><div class="empty-state"><div class="empty-icon">📭</div><p>No open paper trades</p></div></td></tr>';
    return;
  }
  tbody.innerHTML = data.trades.map(t => {
    const pnlCls = t.unrealizedPnL >= 0 ? 'text-green' : 'text-red';
    const coinBase = t.coinBase || t.coin?.replace('USDT','');
    return `<tr>
      <td><span class="text-mono fw-700">${coinBase}/USDT</span></td>
      <td>${dirBadge(t.direction)}</td>
      <td>${statusBadge(t.status)}</td>
      <td class="text-mono">${fmt.price(t.entry, 4)}</td>
      <td class="text-mono">${t.livePrice ? fmt.price(t.livePrice, 4) : '<span class="text-muted">—</span>'}</td>
      <td class="text-mono ${pnlCls} fw-700">${t.status==='active' ? fmt.pnl(t.unrealizedPnL) : '⏳'}</td>
      <td class="text-mono ${pnlCls}">${t.status==='active' ? fmt.pct(t.pnlPct) : '—'}</td>
      <td class="text-mono">${fmt.price(t.sl, 4)}</td>
      <td class="text-mono text-muted">${t.leverage || '?'}x · $${(t.marginUsed||0).toFixed(2)}</td>
      <td>
        <button class="btn btn-danger btn-sm" onclick="closePaperTrade('${t._id}','${coinBase}')">Close</button>
      </td>
    </tr>`;
  }).join('');
}

async function closePaperTrade(id, coin) {
  if (!confirm(`Close ${coin} paper trade?`)) return;
  try {
    const r = await API.paper.close(id);
    toast(`${coin} closed — ${r.result} | ${fmt.pnl(r.paperProfit)}`, r.result === 'WIN' ? 'success' : r.result === 'LOSS' ? 'error' : 'info');
    loadPaperTrades();
  } catch(e) { toast(e.message, 'error'); }
}

async function openPaperTrade() {
  const coin  = document.getElementById('pt-coin').value.trim();
  const dir   = document.getElementById('pt-dir').value;
  const entry = document.getElementById('pt-entry').value;
  const sl    = document.getElementById('pt-sl').value;
  const tp    = document.getElementById('pt-tp').value;
  const tp1   = document.getElementById('pt-tp1').value;
  const lev   = document.getElementById('pt-lev').value;
  const tf    = document.getElementById('pt-tf').value;
  if (!coin || !dir || !entry || !sl || !tp) return toast('Fill all required fields', 'error');
  try {
    const r = await API.paper.open({ coin, direction: dir, entry, sl, tp, tp1: tp1||tp, leverage: lev||null, timeframe: tf||'15m' });
    toast(`${coin.toUpperCase()} ${dir} trade opened! ${r.orderType} | Margin: $${(r.marginUsed||0).toFixed(2)}`, 'success');
    document.getElementById('pt-open-form').reset();
    loadPaperTrades();
  } catch(e) { toast(e.message, 'error'); }
}

async function resetPaperAccount() {
  const amt = parseFloat(document.getElementById('pt-reset-amt').value);
  if (!amt || amt < 1) return toast('Enter valid amount', 'error');
  if (!confirm(`Reset paper account to $${amt}?`)) return;
  try {
    await API.paper.reset(amt);
    toast(`Paper account reset to $${amt}`, 'success');
    loadPaperTrades();
  } catch(e) { toast(e.message, 'error'); }
}

async function loadPaperHistory() {
  const tbody = document.getElementById('ph-body');
  tbody.innerHTML = '<tr><td colspan="8" class="loading-state"><div class="loader"></div> Loading...</td></tr>';
  try {
    const data = await API.paper.history(20);
    // Stats row
    document.getElementById('ph-wins').textContent    = data.wins   || 0;
    document.getElementById('ph-losses').textContent  = data.losses || 0;
    document.getElementById('ph-winrate').textContent = data.winRate + '%';
    document.getElementById('ph-total-pnl').textContent = fmt.pnl(data.totalPnL || 0);
    document.getElementById('ph-total-pnl').className = 'fw-700 ' + (data.totalPnL >= 0 ? 'text-green' : 'text-red');

    if (!data.trades?.length) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">📜</div><p>No closed trades yet</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = data.trades.map(t => `<tr>
      <td class="text-mono fw-700">${t.coin?.replace('USDT','')}/USDT</td>
      <td>${dirBadge(t.direction)}</td>
      <td>${resultBadge(t.result)}</td>
      <td class="text-mono">${fmt.price(t.entry, 4)}</td>
      <td class="text-mono">${fmt.price(t.tp, 4)}</td>
      <td class="text-mono">${fmt.price(t.sl, 4)}</td>
      <td class="text-mono ${t.paperProfit >= 0 ? 'text-green' : 'text-red'} fw-700">${fmt.pnl(t.paperProfit||0)}</td>
      <td class="text-muted">${fmt.time(t.openTime)}</td>
    </tr>`).join('');
  } catch(e) { toast(e.message, 'error'); }
}

// ── REAL TRADES ───────────────────────────────────────────────────
async function loadRealTrades() {
  const tbody = document.getElementById('rt-body');
  tbody.innerHTML = '<tr><td colspan="8" class="loading-state"><div class="loader"></div> Loading...</td></tr>';
  try {
    const trades = await API.trades.list();
    if (!trades?.length) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">📋</div><p>No active tracked trades</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = trades.map(t => `<tr>
      <td class="text-mono fw-700">${t.coin?.replace('USDT','')||t.coin}/USDT</td>
      <td>${dirBadge(t.direction)}</td>
      <td>${statusBadge(t.status)}</td>
      <td class="text-mono">${fmt.price(t.entry, 4)}</td>
      <td class="text-mono">${fmt.price(t.tp, 4)}</td>
      <td class="text-mono">${fmt.price(t.sl, 4)}</td>
      <td>${t.rrr || '—'}</td>
      <td>
        <button class="btn btn-success btn-sm" onclick="closeRealTrade('${t._id}','WIN')">✅ Win</button>
        <button class="btn btn-danger btn-sm mt-8" onclick="closeRealTrade('${t._id}','LOSS')">❌ Loss</button>
        <button class="btn btn-outline btn-sm mt-8" onclick="deleteRealTrade('${t._id}')">🗑️</button>
      </td>
    </tr>`).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="alert-strip alert-error">❌ ${e.message}</div></td></tr>`;
  }
}

async function addRealTrade() {
  const coin  = document.getElementById('rt-coin').value.trim();
  const dir   = document.getElementById('rt-dir').value;
  const entry = document.getElementById('rt-entry').value;
  const sl    = document.getElementById('rt-sl').value;
  const tp    = document.getElementById('rt-tp').value;
  if (!coin || !dir || !entry || !sl || !tp) return toast('Fill all fields', 'error');
  const slD = Math.abs(parseFloat(entry) - parseFloat(sl));
  const tpD = Math.abs(parseFloat(tp) - parseFloat(entry));
  const rrr = slD > 0 ? '1:' + (tpD / slD).toFixed(2) : '1:1';
  try {
    await API.trades.add({ coin, direction:dir, entry, sl, tp, rrr });
    toast(`${coin.toUpperCase()} trade added`, 'success');
    document.getElementById('rt-add-form').reset();
    loadRealTrades();
  } catch(e) { toast(e.message, 'error'); }
}

async function closeRealTrade(id, result) {
  if (!confirm(`Mark trade as ${result}?`)) return;
  try {
    await API.trades.close(id, result, result === 'WIN' ? 10 : -10);
    toast(`Trade closed as ${result}`, result === 'WIN' ? 'success' : 'error');
    loadRealTrades();
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteRealTrade(id) {
  if (!confirm('Delete this trade?')) return;
  try {
    await API.trades.delete(id);
    toast('Trade deleted', 'info');
    loadRealTrades();
  } catch(e) { toast(e.message, 'error'); }
}

// ── WATCHLIST ─────────────────────────────────────────────────────
async function loadWatchlist() {
  const grid = document.getElementById('wl-grid');
  grid.innerHTML = '<div class="loading-state"><div class="loader"></div> Loading prices...</div>';
  try {
    const list = await API.watchlist.list();
    if (!list?.length) {
      grid.innerHTML = '<div class="empty-state"><div class="empty-icon">👀</div><p>Watchlist is empty. Add coins below.</p></div>';
      return;
    }
    grid.innerHTML = list.map(item => `
      <div class="coin-tile" style="flex-direction:column;align-items:flex-start;gap:8px">
        <div class="flex-between" style="width:100%">
          <div>
            <div class="coin-symbol">${item.coin?.replace('USDT','')}/USDT</div>
            <div class="coin-change ${(item.change24h||0) >= 0 ? 'up' : 'down'}">${fmt.pct(item.change24h||0)}</div>
          </div>
          <div style="text-align:right">
            <div class="coin-price text-mono ${(item.change24h||0) >= 0 ? 'text-green' : 'text-red'}">${item.error ? '—' : fmt.price(item.price, 4)}</div>
            <button class="btn btn-outline btn-sm mt-8" onclick="removeFromWatchlist('${item.coin}')">Remove</button>
          </div>
        </div>
        ${!item.error ? `<div style="width:100%;display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px;color:var(--text2)">
          <span>H: <span class="text-mono">${fmt.price(item.high24h, 4)}</span></span>
          <span>L: <span class="text-mono">${fmt.price(item.low24h, 4)}</span></span>
        </div>` : ''}
      </div>`).join('');
  } catch(e) {
    grid.innerHTML = `<div class="alert-strip alert-error">❌ ${e.message}</div>`;
  }
}

async function addToWatchlist() {
  const input = document.getElementById('wl-add-input').value.trim();
  if (!input) return toast('Enter coin symbol', 'error');
  const coins = input.split(',').map(c => c.trim()).filter(Boolean);
  try {
    await API.watchlist.add(coins);
    toast(`Added: ${coins.join(', ')}`, 'success');
    document.getElementById('wl-add-input').value = '';
    loadWatchlist();
  } catch(e) { toast(e.message, 'error'); }
}

async function removeFromWatchlist(coin) {
  try {
    await API.watchlist.remove(coin);
    toast(`${coin} removed`, 'info');
    loadWatchlist();
  } catch(e) { toast(e.message, 'error'); }
}

// ── ALERTS ────────────────────────────────────────────────────────
async function loadAlerts() {
  const tbody = document.getElementById('al-body');
  tbody.innerHTML = '<tr><td colspan="5" class="loading-state"><div class="loader"></div></td></tr>';
  try {
    const list = await API.alerts.list();
    if (!list?.length) {
      tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">🔔</div><p>No active alerts</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = list.map(a => `<tr>
      <td class="text-mono fw-700">${a.coin?.replace('USDT','')}</td>
      <td class="text-mono">${fmt.price(a.targetPrice, 4)}</td>
      <td><span class="badge ${a.direction === 'above' ? 'badge-green' : 'badge-red'}">${a.direction || '—'}</span></td>
      <td><span class="badge badge-blue">ACTIVE</span></td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteAlert('${a._id}')">Delete</button></td>
    </tr>`).join('');
  } catch(e) { toast(e.message, 'error'); }
}

async function addAlert() {
  const coin  = document.getElementById('al-coin').value.trim();
  const price = document.getElementById('al-price').value;
  if (!coin || !price) return toast('Coin and price required', 'error');
  try {
    const r = await API.alerts.add(coin, price);
    toast(`Alert set: ${coin} at ${fmt.price(price)} (${r.direction})`, 'success');
    document.getElementById('al-coin').value = '';
    document.getElementById('al-price').value = '';
    loadAlerts();
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteAlert(id) {
  try {
    await API.alerts.delete(id);
    toast('Alert deleted', 'info');
    loadAlerts();
  } catch(e) { toast(e.message, 'error'); }
}

// ── ANALYSIS ─────────────────────────────────────────────────────
async function loadAnalysis() {
  // Load some live prices for the analysis section
  const coins = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT'];
  try {
    const prices = await API.market.prices(coins);
    const grid = document.getElementById('an-prices');
    if (grid && prices) {
      grid.innerHTML = prices.map(p => `
        <div class="coin-tile">
          <div>
            <div class="coin-symbol">${p.symbol?.replace('USDT','')||''}</div>
            <div class="coin-change ${p.change24h >= 0 ? 'up' : 'down'}">${fmt.pct(p.change24h||0)} (24h)</div>
          </div>
          <div>
            <div class="coin-price text-mono">${fmt.price(p.price, 4)}</div>
            <div style="font-size:11px;color:var(--text2);font-family:'Space Mono',monospace">
              H: ${fmt.price(p.high24h,2)} / L: ${fmt.price(p.low24h,2)}
            </div>
          </div>
        </div>`).join('');
    }
  } catch(e) {}
}

// ── TOOLS (Position Calculator) ───────────────────────────────────
function calcPosition() {
  const capital  = parseFloat(document.getElementById('calc-capital').value) || 0;
  const entry    = parseFloat(document.getElementById('calc-entry').value)   || 0;
  const sl       = parseFloat(document.getElementById('calc-sl').value)      || 0;
  const riskPct  = parseFloat(document.getElementById('calc-risk').value)    || 2;
  const leverage = parseFloat(document.getElementById('calc-lev').value)     || 10;

  if (!capital || !entry || !sl) { toast('Fill capital, entry and SL', 'error'); return; }

  const slDist   = Math.abs(entry - sl);
  const riskAmt  = capital * riskPct / 100;
  const qty      = slDist > 0 ? riskAmt / slDist : 0;
  const margin   = qty > 0 ? (qty * entry) / leverage : 0;
  const slPct    = (slDist / entry * 100).toFixed(2);

  document.getElementById('calc-qty').textContent    = qty.toFixed(4);
  document.getElementById('calc-margin').textContent = '$' + margin.toFixed(2);
  document.getElementById('calc-risk-amt').textContent = '$' + riskAmt.toFixed(2);
  document.getElementById('calc-sl-pct').textContent = slPct + '%';

  // RRR table
  const rrrBody = document.getElementById('calc-rrr-body');
  rrrBody.innerHTML = [1.5, 2, 2.5, 3, 4, 5].map(r => {
    const tp = entry > sl ? entry + slDist * r : entry - slDist * r;
    const profit = slDist * r * qty;
    return `<tr>
      <td>1:${r}</td>
      <td class="text-mono">${fmt.price(tp, 4)}</td>
      <td class="text-green text-mono">+$${profit.toFixed(2)}</td>
      <td class="text-green text-mono">+${(profit / margin * 100).toFixed(1)}%</td>
    </tr>`;
  }).join('');
}

// ── SETTINGS ─────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const s = await API.settings.get();
    const toggles = [
      ['autoSignal', 'Auto Scanner', 'Automatically scan and send signals'],
      ['trailingSl',  'Trailing SL',  'Move stop loss to lock profits'],
      ['strictMode',  'Strict Mode',  'Only high-confidence signals'],
      ['partialTp',   'Partial TP Alerts', 'Notify at each TP level'],
      ['paperTrade',  'Auto Paper Trade', 'Auto-open paper trades on signals'],
    ];
    const container = document.getElementById('settings-toggles');
    container.innerHTML = toggles.map(([key, name, desc]) => `
      <div class="toggle-wrap">
        <div class="toggle-info">
          <div class="toggle-name">${name}</div>
          <div class="toggle-desc">${desc}</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="st-${key}" ${s[key] ? 'checked' : ''} onchange="updateSetting('${key}', this.checked)"/>
          <span class="toggle-slider"></span>
        </label>
      </div>`).join('');

    document.getElementById('st-minRRR').value = s.minRRR || 1.5;
    document.getElementById('st-paperMinScore').value = s.paperMinScore || 5;

    // Load config snapshot (admin only)
    if (API.isAdmin()) {
      try {
        const cfg = await API.config.snapshot();
        renderConfigSnapshot(cfg);
      } catch(e) {}
    }
  } catch(e) { toast(e.message, 'error'); }
}

async function updateSetting(key, value) {
  try {
    await API.settings.update({ [key]: value });
    toast(`${key} updated`, 'success');
  } catch(e) { toast(e.message, 'error'); loadSettings(); }
}

async function updateRRR() {
  const v = parseFloat(document.getElementById('st-minRRR').value);
  if (!v || v < 0.5 || v > 10) return toast('RRR must be between 0.5 and 10', 'error');
  try {
    await API.settings.update({ minRRR: v });
    toast(`Min RRR set to ${v}x`, 'success');
  } catch(e) { toast(e.message, 'error'); }
}

async function updatePaperScore() {
  const v = parseInt(document.getElementById('st-paperMinScore').value);
  if (isNaN(v) || v < 0) return toast('Invalid score', 'error');
  try {
    await API.settings.update({ paperMinScore: v });
    toast(`Min paper score set to ${v}`, 'success');
  } catch(e) { toast(e.message, 'error'); }
}

function renderConfigSnapshot(cfg) {
  const el = document.getElementById('cfg-modules');
  if (!el) return;
  el.innerHTML = Object.entries(cfg.modules || {}).map(([k, v]) => `
    <div class="toggle-wrap">
      <div class="toggle-info">
        <div class="toggle-name" style="font-size:13px">${k}</div>
      </div>
      <label class="toggle">
        <input type="checkbox" ${v ? 'checked' : ''} onchange="updateModule('${k}', this.checked)"/>
        <span class="toggle-slider"></span>
      </label>
    </div>`).join('');

  const tEl = document.getElementById('cfg-trading');
  if (tEl) tEl.innerHTML = Object.entries(cfg.trading || {}).map(([k,v]) => `
    <div class="flex-between" style="padding:8px 0; border-bottom:1px solid var(--border)">
      <span class="text-muted" style="font-size:12px;font-family:'Space Mono',monospace">${k}</span>
      <input type="number" value="${v}" step="0.1" style="width:80px;background:rgba(0,0,0,0.4);border:1px solid var(--border);border-radius:6px;padding:4px 8px;color:var(--text);font-size:12px;font-family:'Space Mono',monospace;outline:none" onchange="updateTradingParam('${k}', this.value)"/>
    </div>`).join('');
}

async function updateModule(mod, enabled) {
  try {
    await API.config.setModule(mod, enabled);
    toast(`${mod} → ${enabled ? 'ON' : 'OFF'}`, 'success');
  } catch(e) { toast(e.message, 'error'); }
}

async function updateTradingParam(key, value) {
  try {
    await API.config.setTrading(key, value);
    toast(`${key} = ${value}`, 'success');
  } catch(e) { toast(e.message, 'error'); }
}

// ── SYSTEM (admin) ────────────────────────────────────────────────
async function loadSystem() {
  if (!API.isAdmin()) {
    document.getElementById('sec-system').innerHTML = '<div class="alert-strip alert-error">❌ Admin access required</div>';
    return;
  }
  loadSystemInfo();
  loadUserManagement();
  loadSystemSummary();
}

async function loadSystemInfo() {
  try {
    const info = await API.system.info();
    const el = document.getElementById('sys-info');
    if (!el) return;
    el.innerHTML = `
      <div class="grid grid-4" style="margin-bottom:16px">
        <div class="stat-card"><div class="stat-label">Bot Name</div><div class="stat-value sm text-mono">${info.botName||'N/A'}</div></div>
        <div class="stat-card"><div class="stat-label">Version</div><div class="stat-value sm text-mono">${info.version||'N/A'}</div></div>
        <div class="stat-card"><div class="stat-label">Uptime</div><div class="stat-value sm text-mono">${info.uptimeStr||'N/A'}</div></div>
        <div class="stat-card"><div class="stat-label">Node.js</div><div class="stat-value sm text-mono">${info.nodeVersion||'N/A'}</div></div>
      </div>
      <div class="grid grid-3">
        <div class="stat-card"><div class="stat-label">Platform</div><div class="stat-value sm text-mono">${info.platform} / ${info.arch}</div><div class="stat-sub">${info.cpuCount} CPU cores</div></div>
        <div class="stat-card green"><div class="stat-label">Total RAM</div><div class="stat-value sm text-mono">${info.totalMem} MB</div><div class="stat-sub">Used: ${info.usedMem} MB</div></div>
        <div class="stat-card"><div class="stat-label">Free RAM</div><div class="stat-value sm text-mono">${info.freeMem} MB</div><div class="stat-sub">PID: ${info.pid}</div></div>
      </div>`;
  } catch(e) {}
}

async function loadSystemSummary() {
  try {
    const s = await API.system.summary();
    const el = document.getElementById('sys-summary');
    if (!el) return;
    el.innerHTML = `
      <div class="grid grid-4">
        <div class="stat-card"><div class="stat-label">Total Users</div><div class="stat-value text-mono">${s.users||0}</div><div class="stat-icon">👥</div></div>
        <div class="stat-card gold"><div class="stat-label">Total Trades</div><div class="stat-value text-mono">${s.total||0}</div><div class="stat-icon">📊</div></div>
        <div class="stat-card green"><div class="stat-label">Open Trades</div><div class="stat-value text-mono">${s.open||0}</div><div class="stat-icon">🔵</div></div>
        <div class="stat-card"><div class="stat-label">Paper Trades</div><div class="stat-value text-mono">${s.paper||0}</div><div class="stat-icon">🤖</div></div>
      </div>`;
  } catch(e) {}
}

async function loadUserManagement() {
  const tbody = document.getElementById('users-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" class="loading-state"><div class="loader"></div></td></tr>';
  try {
    const users = await API.system.users();
    if (!users?.length) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">👥</div><p>No users</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = users.map(u => `<tr>
      <td><span class="user-row-avatar">${(u.displayName||u.username||'?')[0].toUpperCase()}</span></td>
      <td><div class="fw-700" style="font-size:13px">${u.displayName||u.username}</div><div class="text-muted" style="font-size:11px;font-family:'Space Mono',monospace">@${u.username}</div></td>
      <td class="text-muted" style="font-size:12px;font-family:'Space Mono',monospace">${u.email}</td>
      <td><span class="badge ${u.role==='admin'?'badge-gold':'badge-blue'}">${u.role}</span></td>
      <td><span class="badge ${u.accountStatus==='active'?'badge-green':u.accountStatus==='suspended'?'badge-red':'badge-gray'}">${u.accountStatus}</span></td>
      <td class="text-muted" style="font-size:11px">${u.lastLoginAt ? fmt.date(u.lastLoginAt) : 'Never'}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-outline btn-sm" onclick="toggleUserStatus('${u._id}','${u.accountStatus}')">${u.accountStatus==='suspended'?'Activate':'Suspend'}</button>
        <button class="btn btn-gold btn-sm" onclick="toggleUserRole('${u._id}','${u.role}')">${u.role==='admin'?'→ User':'→ Admin'}</button>
        <button class="btn btn-outline btn-sm" onclick="showResetPw('${u._id}')">Reset PW</button>
        ${u._id !== currentUser.id ? `<button class="btn btn-danger btn-sm" onclick="deleteUser('${u._id}','${u.username}')">Delete</button>` : ''}
      </td>
    </tr>`).join('');
  } catch(e) { toast(e.message, 'error'); }
}

async function toggleUserStatus(id, current) {
  const newStatus = current === 'suspended' ? 'active' : 'suspended';
  try {
    await API.system.updateUser(id, { accountStatus: newStatus });
    toast(`User ${newStatus}`, 'success');
    loadUserManagement();
  } catch(e) { toast(e.message, 'error'); }
}

async function toggleUserRole(id, current) {
  const newRole = current === 'admin' ? 'user' : 'admin';
  if (!confirm(`Change role to ${newRole}?`)) return;
  try {
    await API.system.updateUser(id, { role: newRole });
    toast(`Role changed to ${newRole}`, 'success');
    loadUserManagement();
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteUser(id, name) {
  if (!confirm(`Delete user "${name}"? This cannot be undone.`)) return;
  try {
    await API.system.deleteUser(id);
    toast(`User ${name} deleted`, 'info');
    loadUserManagement();
  } catch(e) { toast(e.message, 'error'); }
}

function showResetPw(id) {
  const pw = prompt('Enter new password (min 6 chars):');
  if (!pw || pw.length < 6) return toast('Password too short', 'error');
  API.system.resetPw(id, pw)
    .then(() => toast('Password reset', 'success'))
    .catch(e => toast(e.message, 'error'));
}

// ── ACCOUNT ───────────────────────────────────────────────────────
async function loadAccount() {
  try {
    const [acc, meData] = await Promise.allSettled([API.account.margin(), API.auth.me()]);
    if (acc.status === 'fulfilled') {
      document.getElementById('acc-margin').value = acc.value?.margin || 0;
      document.getElementById('acc-balance').textContent = fmt.price(acc.value?.balance || 0, 2);
      const net = (acc.value?.balance || 0) - (acc.value?.startBalance || 0);
      const netEl = document.getElementById('acc-net');
      netEl.textContent = fmt.pnl(net);
      netEl.className = net >= 0 ? 'text-green text-mono' : 'text-red text-mono';
      document.getElementById('acc-trades').textContent = acc.value?.trades || 0;
      document.getElementById('acc-wins').textContent   = acc.value?.wins   || 0;
      document.getElementById('acc-losses').textContent = acc.value?.losses || 0;
    }
    if (meData.status === 'fulfilled') {
      const u = meData.value;
      document.getElementById('acc-username').textContent = u.username || '—';
      document.getElementById('acc-email').textContent    = u.email || '—';
      document.getElementById('acc-role').textContent     = u.role || '—';
      document.getElementById('acc-display').value = u.displayName || '';
      document.getElementById('acc-login-count').textContent = u.loginCount || 0;
    }
  } catch(e) {}
}

async function setMargin() {
  const v = parseFloat(document.getElementById('acc-margin').value);
  if (!v || v < 1) return toast('Enter valid amount', 'error');
  try {
    await API.account.setMargin(v);
    toast(`Capital set to $${v}`, 'success');
    loadAccount();
  } catch(e) { toast(e.message, 'error'); }
}

async function changePassword() {
  const cur = document.getElementById('acc-pw-current').value;
  const nw  = document.getElementById('acc-pw-new').value;
  const cf  = document.getElementById('acc-pw-confirm').value;
  if (!cur || !nw) return toast('All fields required', 'error');
  if (nw !== cf) return toast('Passwords do not match', 'error');
  if (nw.length < 6) return toast('Password min 6 chars', 'error');
  try {
    await API.account.password(cur, nw);
    toast('Password changed!', 'success');
    document.getElementById('acc-pw-current').value = '';
    document.getElementById('acc-pw-new').value = '';
    document.getElementById('acc-pw-confirm').value = '';
  } catch(e) { toast(e.message, 'error'); }
}

// ── BTC price in topbar ────────────────────────────────────────────
async function refreshTopbarBTC() {
  try {
    const d = await API.market.overview();
    if (!d) return;
    document.getElementById('tb-btc-price').textContent = d.price ? '$' + parseFloat(d.price).toLocaleString('en',{minimumFractionDigits:0,maximumFractionDigits:0}) : '—';
    const chgEl = document.getElementById('tb-btc-change');
    chgEl.textContent  = d.change24h != null ? (d.change24h >= 0 ? '+' : '') + d.change24h.toFixed(2) + '%' : '';
    chgEl.className    = 'change ' + (d.change24h >= 0 ? 'up' : 'down');
  } catch(e) {}
}

// ── INIT ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Set user info in sidebar
  document.getElementById('sb-user-name').textContent = currentUser.displayName || currentUser.username || 'User';
  document.getElementById('sb-user-role').textContent = currentUser.role || 'user';

  // Hide system nav if not admin
  if (currentUser.role !== 'admin') {
    document.getElementById('nav-system')?.closest('.nav-item')?.remove();
    document.getElementById('nav-system-section')?.remove();
  }

  // Start on dashboard
  navigateTo('dashboard');

  // Refresh BTC price every 30s
  refreshTopbarBTC();
  setInterval(refreshTopbarBTC, 30000);
});
