/* ═══════════════════════════════════════════════════════════
   APEX-MD  ·  user.js  ·  User Portal Shared Logic
   ═══════════════════════════════════════════════════════════ */

/* ── Nav Render ───────────────────────────────────────────── */
function renderUserNav(active) {
    // Nav grouped by category — separators shown as dividers in mobile menu
    const links = [
        // ── Main ──
        { href: '/app/',          key: 'home',      label: '🏠 Dashboard' },
        // ── Analysis ──
        { href: '/app/scanner',   key: 'scanner',   label: '⚡ Scanner' },
        { href: '/app/market',    key: 'market',    label: '🔍 Market Scan' },
        { href: '/app/heatmap',   key: 'heatmap',   label: '🌡️ Heatmap' },
        { href: '/app/compare',   key: 'compare',   label: '⚖️ Compare' },
        { href: '/app/funding',   key: 'funding',   label: '💸 Funding' },
        { href: '/app/news',      key: 'news',      label: '📰 Intel' },
        // ── Trading ──
        { href: '/app/trades',    key: 'trades',    label: '📋 Trades' },
        { href: '/app/paper',     key: 'paper',     label: '📄 Paper' },
        { href: '/app/tracks',    key: 'tracks',    label: '🎯 Tracks' },
        { href: '/app/alerts',    key: 'alerts',    label: '🔔 Alerts' },
        { href: '/app/watchlist', key: 'watchlist', label: '👁 Watchlist' },
        { href: '/app/portfolio', key: 'portfolio', label: '💼 Portfolio' },
        // ── Tools ──
        { href: '/app/backtest',  key: 'backtest',  label: '🧪 Backtest' },
        { href: '/app/journal',   key: 'journal',   label: '📓 Journal' },
        { href: '/app/stats',     key: 'stats',     label: '📊 Stats' },
        { href: '/app/calc',      key: 'calc',      label: '🧮 Calc' },
        { href: '/app/grid',      key: 'grid',      label: '🕸 Grid' },
        { href: '/app/ai',        key: 'ai',        label: '🤖 AI Chat' },
        // ── Account ──
        { href: '/app/settings',  key: 'settings',  label: '⚙️ Settings' },
        { href: '/app/system',    key: 'system',    label: '💻 System' },
    ];
    const user = window._apexUser || {};

    // ── Category groups for organized drawer ──────────────
    const GROUPS = [
        { label: 'Analysis', keys: ['scanner','market','heatmap','compare','funding','news'] },
        { label: 'Trading',  keys: ['trades','paper','tracks','alerts','watchlist','portfolio'] },
        { label: 'Tools',    keys: ['backtest','journal','stats','calc','grid','ai'] },
        { label: 'Account',  keys: ['settings','system'] },
    ];
    const aboutLinks = [
        { href: '/',        label: '🏠 About Us' },
        { href: '/privacy', label: '🔒 Privacy Policy' },
        { href: '/terms',   label: '📄 Terms of Service' },
    ];

    function buildDrawerHTML() {
        let html = '';
        const sep = (label, extra='') => `<div style="font-size:.62rem;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.1em;padding:10px 20px 3px;margin-top:6px${extra}">${label}</div>`;
        // Home first
        const home = links.find(l => l.key === 'home');
        if (home) html += `<a href="${home.href}" onclick="_navClose()" class="nav-link${active===home.key?' active':''}">${home.label}</a>`;
        // Category groups
        GROUPS.forEach(g => {
            const gl = links.filter(l => g.keys.includes(l.key));
            if (!gl.length) return;
            html += sep(g.label);
            gl.forEach(l => { html += `<a href="${l.href}" onclick="_navClose()" class="nav-link${active===l.key?' active':''}">${l.label}</a>`; });
        });
        // About section
        html += sep('About', ';border-top:1px solid rgba(255,255,255,.07);margin-top:10px');
        aboutLinks.forEach(l => { html += `<a href="${l.href}" onclick="_navClose()" class="nav-link" style="font-size:.82rem;opacity:.8">${l.label}</a>`; });
        // Footer
        html += `<div style="padding:10px 16px 4px;margin-top:4px;border-top:1px solid rgba(255,255,255,.07)">`;
        if (user.username) html += `<div style="font-size:.75rem;color:var(--text2);padding:2px 0 8px;font-family:var(--font-mono)">👤 ${user.username}</div>`;
        html += `<a href="/auth/logout" class="nav-btn" style="justify-content:center">Logout →</a></div>`;
        return html;
    }

    // ── Nav bar ──────────────────────────────────────────
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

    // ── Drawer appended to <body> — escapes nav stacking context ──
    let existing = document.getElementById('nav-links');
    if (existing) existing.remove();

    const drawer = document.createElement('div');
    drawer.id = 'nav-links';
    drawer.className = 'nav-links';
    drawer.innerHTML = buildDrawerHTML();
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
