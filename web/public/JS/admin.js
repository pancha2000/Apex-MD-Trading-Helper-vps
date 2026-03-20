/* ═══════════════════════════════════════════════════════════
   APEX-MD  ·  admin.js  ·  Admin Panel Shared Logic
   ═══════════════════════════════════════════════════════════ */

/* ── Nav Render ───────────────────────────────────────────── */
function renderAdminNav(active) {
    const links = [
        { href: '/admin/',         key: 'home',     label: '📊 Dashboard' },
        { href: '/admin/users',    key: 'users',    label: '👥 Users' },
        { href: '/admin/settings', key: 'settings', label: '⚙️ Settings' },
        { href: '/admin/updater',  key: 'updater',  label: '🔄 Updater',  badge: 'upd-badge' },
    ];

    document.getElementById('nav-root').innerHTML = `
    <nav class="nav">
        <div class="nav-logo">
            <span>⚡</span> Apex-MD
            <span class="nav-logo-badge" style="background:linear-gradient(135deg,#3d1a1a,#5c2020);color:#ff6b6b">ADMIN</span>
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
    drawer.innerHTML = `
        ${links.map(l => `
        <a href="${l.href}" onclick="_navClose()" class="nav-link${active === l.key ? ' active' : ''}">
            ${l.label}
            ${l.badge === 'upd-badge'  ? '<span id="update-badge" class="nav-badge" style="display:none">!</span>' : ''}
        </a>`).join('')}
        <a href="/auth/logout" class="nav-btn">Logout →</a>
    `;
    document.body.appendChild(drawer);

    // ── Overlay ───────────────────────────────────────────────────
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
    const l  = document.getElementById('nav-links');
    const h  = document.getElementById('nav-hbg');
    const ov = document.getElementById('nav-overlay');
    if (!l) return;
    const isOpen = l.classList.toggle('open');
    if (h)  h.classList.toggle('open', isOpen);
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

/* ── Signal Toast ─────────────────────────────────────────── */
function showSignalToast(sig) {
    const old = document.getElementById('sig-toast');
    if (old) old.remove();
    const isLong = sig.direction === 'LONG';
    const el = document.createElement('div');
    el.id = 'sig-toast';
    el.className = 'signal-toast ' + (isLong ? 'long-toast' : 'short-toast');
    el.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div style="font-family:var(--font-head);font-weight:700;font-size:.95rem;color:#fff">
                ${isLong ? '🟢' : '🔴'} ${sig.coin} ${sig.direction}
            </div>
            <div style="font-size:.7rem;color:var(--text2);font-family:var(--font-mono)">${sig.score}/100</div>
        </div>
        <div style="font-size:.78rem;color:var(--text2);font-family:var(--font-mono)">
            Entry: <span style="color:var(--accent)">$${parseFloat(sig.price||0).toFixed(4)}</span>
            &nbsp;|&nbsp; SL: <span style="color:var(--red)">$${parseFloat(sig.sl||0).toFixed(4)}</span>
        </div>
        <div style="font-size:.7rem;color:var(--text2);margin-top:6px">New signal via Apex-MD 🚀</div>`;
    document.body.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .5s'; el.style.opacity = '0'; }, 7000);
    setTimeout(() => el.remove(), 7600);
}

/* ── Signal SSE Stream ────────────────────────────────────── */
(function initSignalStream() {
    try {
        const es = new EventSource('/admin/api/signals/stream');
        es.onmessage = e => {
            try {
                const sig = JSON.parse(e.data);
                showSignalToast(sig);
                const badge = document.getElementById('signal-count-badge');
                if (badge) {
                    const n = parseInt(badge.textContent || '0') + 1;
                    badge.textContent = n;
                    badge.style.display = 'flex';
                }
            } catch (_) {}
        };
    } catch (_) {}
})();

/* ── Status Polling ───────────────────────────────────────── */
function pollStatus() {
    fetch('/admin/api/status').then(r => r.json()).then(d => {
        const scanBadge = document.getElementById('scanner-on-badge');
        if (scanBadge) { scanBadge.style.display = d.scannerActive ? 'flex' : 'none'; }
        const updBadge = document.getElementById('update-badge');
        if (updBadge) { updBadge.style.display = d.pendingUpdate ? 'flex' : 'none'; }
    }).catch(() => {});
}
setInterval(pollStatus, 30000);
pollStatus();

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
