/* ═══════════════════════════════════════════════════════════
   APEX-MD  ·  user.js  ·  User Portal Shared Logic
   ═══════════════════════════════════════════════════════════ */

/* ── Nav Render ───────────────────────────────────────────── */
function renderUserNav(active) {
    const links = [
        { href: '/app/',          key: 'home',      label: 'Dashboard' },
        { href: '/app/market',    key: 'market',    label: '🔍 Scan' },
        { href: '/app/scanner',   key: 'scanner',   label: '⚡ Scanner' },
        { href: '/app/paper',     key: 'paper',     label: '📄 Paper' },
        { href: '/app/watchlist', key: 'watchlist', label: '👁 Watch' },
        { href: '/app/alerts',    key: 'alerts',    label: '🔔 Alerts' },
        { href: '/app/news',      key: 'news',      label: '📰 Intel' },
        { href: '/app/calc',      key: 'calc',      label: '🧮 Calc' },
        { href: '/app/stats',     key: 'stats',     label: '📊 Stats' },
        { href: '/app/ai',        key: 'ai',        label: '🤖 AI' },
        { href: '/app/grid',      key: 'grid',      label: '🕸 Grid' },
        { href: '/app/funding',   key: 'funding',   label: '💸 Rates' },
        { href: '/app/tracks',    key: 'tracks',    label: '🎯 Tracks' },
        { href: '/app/system',    key: 'system',    label: '💻 System' },
        { href: '/app/trades',    key: 'trades',    label: 'Trades' },
        { href: '/app/settings',  key: 'settings',  label: '⚙️' },
    ];
    const user = window._apexUser || {};
    const linkHtml = links.map(l => `
        <a href="${l.href}" onclick="_navClose()" class="nav-link${active === l.key ? ' active' : ''}">
            ${l.label}
        </a>`).join('');

    // ── Nav bar (without the dropdown links) ──────────────
    document.getElementById('nav-root').innerHTML = `
    <nav class="nav">
        <div class="nav-logo">
            <span>⚡</span> Apex-MD
            <span class="nav-logo-badge" style="background:linear-gradient(135deg,#1a3349,#254560);color:var(--text3)">PORTAL</span>
        </div>
        <button class="nav-hamburger" id="nav-hbg" onclick="_navToggle()" aria-label="Menu">
            <span></span><span></span><span></span>
        </button>
    </nav>`;

    // ── Move nav-links to <body> so it escapes nav stacking context ──
    // This is the key fix: nav has z-index:200 stacking context,
    // so any child can never appear above other z-index elements.
    // Moving to body makes z-index:10000 actually work.
    let existing = document.getElementById('nav-links');
    if (existing) existing.remove();

    const drawer = document.createElement('div');
    drawer.id = 'nav-links';
    drawer.className = 'nav-links';
    drawer.innerHTML = `
        ${linkHtml}
        ${user.username ? `<span style="font-size:.78rem;color:var(--text2);padding:0 5px;font-family:var(--font-mono)">👤 ${user.username}</span>` : ''}
        <a href="/auth/logout" class="nav-btn">Logout →</a>
    `;
    document.body.appendChild(drawer);

    // ── Dim overlay ───────────────────────────────────────
    let ov = document.getElementById('nav-overlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'nav-overlay';
        ov.onclick = _navClose;
        document.body.appendChild(ov);
    }
}

/* ── Nav Toggle ───────────────────────────────────────────── */
function _navToggle() {
    const l = document.getElementById('nav-links');
    const h = document.getElementById('nav-hbg');
    const ov = document.getElementById('nav-overlay');
    if (!l) return;
    const isOpen = l.classList.toggle('open');
    if (h) h.classList.toggle('open', isOpen);
    if (ov) ov.classList.toggle('open', isOpen);
}
function _navClose() {
    const l  = document.getElementById('nav-links');
    const h  = document.getElementById('nav-hbg');
    const ov = document.getElementById('nav-overlay');
    if (l)  l.classList.remove('open');
    if (h)  h.classList.remove('open');
    if (ov) ov.classList.remove('open');
}
document.addEventListener('click', function(e) {
    const l = document.getElementById('nav-links');
    const h = document.getElementById('nav-hbg');
    if (l && h && l.classList.contains('open') && !l.contains(e.target) && !h.contains(e.target)) _navClose();
});

/* ── Toast ────────────────────────────────────────────────── */
function showToast(msg, type = 'ok') {
    let t = document.getElementById('toast-global');
    if (!t) {
        t = document.createElement('div');
        t.id = 'toast-global';
        t.className = 'toast';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'toast' + (type === 'err' ? ' err' : type === 'info' ? ' info' : '');
    t.style.display = 'block';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.display = 'none'; }, 3200);
}

/* ── Format Helpers ───────────────────────────────────────── */
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
function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60)    return s + 's ago';
    if (s < 3600)  return Math.floor(s/60) + 'm ago';
    if (s < 86400) return Math.floor(s/3600) + 'h ago';
    return Math.floor(s/86400) + 'd ago';
}

/* ── API Helper ───────────────────────────────────────────── */
async function apiFetch(url, opts = {}) {
    const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
}
