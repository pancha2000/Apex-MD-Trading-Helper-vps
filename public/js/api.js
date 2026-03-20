/* ═══════════════════════════════════════════════════════════════
   APEX-MD Web Dashboard — API Client (js/api.js)
   All fetch calls go through here
   ═══════════════════════════════════════════════════════════════ */

const API = (() => {
  function getToken() { return localStorage.getItem('apex_token') || ''; }
  function getUser()  { try { return JSON.parse(localStorage.getItem('apex_user') || '{}'); } catch { return {}; } }

  async function request(method, url, body = null) {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + getToken(),
      },
    };
    if (body !== null) opts.body = JSON.stringify(body);
    try {
      const r    = await fetch(url, opts);
      const data = await r.json();
      if (r.status === 401) {
        localStorage.removeItem('apex_token');
        localStorage.removeItem('apex_user');
        window.location.href = '/';
        return null;
      }
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      return data;
    } catch (e) {
      if (e.message.includes('Failed to fetch')) throw new Error('Connection error — is the server running?');
      throw e;
    }
  }

  return {
    getUser,
    isAdmin: () => getUser().role === 'admin',

    // ── Auth ───────────────────────────────────────────────────
    auth: {
      me:       ()        => request('GET',  '/api/auth/me'),
      login:    (u, p)    => request('POST', '/api/auth/login',    { username:u, password:p }),
      register: (d)       => request('POST', '/api/auth/register', d),
    },

    // ── Market ────────────────────────────────────────────────
    market: {
      overview: ()        => request('GET',  '/api/market/overview'),
      prices:   (syms)    => request('GET',  `/api/market/prices?symbols=${(syms||[]).join(',')}`),
    },

    // ── Paper Trades ──────────────────────────────────────────
    paper: {
      positions: ()       => request('GET',  '/api/paper/positions'),
      history:   (lim)    => request('GET',  `/api/paper/history?limit=${lim||20}`),
      open:      (data)   => request('POST', '/api/paper/open',    data),
      close:     (id)     => request('POST', `/api/paper/close/${id}`),
      reset:     (amt)    => request('POST', '/api/paper/reset',   { amount: amt }),
    },

    // ── Account ───────────────────────────────────────────────
    account: {
      margin:     ()      => request('GET',  '/api/account/margin'),
      setMargin:  (amt)   => request('POST', '/api/account/margin', { amount: amt }),
      password:   (c,n)   => request('POST', '/api/account/password', { currentPassword:c, newPassword:n }),
    },

    // ── Real Trades ───────────────────────────────────────────
    trades: {
      list:    ()         => request('GET',  '/api/trades'),
      add:     (data)     => request('POST', '/api/trades/add', data),
      close:   (id, r, p) => request('POST', `/api/trades/${id}/close`, { result:r, pnlPct:p }),
      delete:  (id)       => request('DELETE', `/api/trades/${id}`),
    },

    // ── Watchlist ─────────────────────────────────────────────
    watchlist: {
      list:   ()          => request('GET',  '/api/watchlist'),
      add:    (coins)     => request('POST', '/api/watchlist', { coins }),
      remove: (coin)      => request('DELETE', `/api/watchlist/${coin}`),
    },

    // ── Alerts ────────────────────────────────────────────────
    alerts: {
      list:   ()          => request('GET',  '/api/alerts'),
      add:    (c, p)      => request('POST', '/api/alerts', { coin:c, price:p }),
      delete: (id)        => request('DELETE', `/api/alerts/${id}`),
    },

    // ── Stats ─────────────────────────────────────────────────
    stats:  {
      get: ()             => request('GET',  '/api/stats'),
    },

    // ── Settings ──────────────────────────────────────────────
    settings: {
      get:    ()          => request('GET',  '/api/settings'),
      update: (data)      => request('POST', '/api/settings', data),
    },

    // ── Config (admin) ────────────────────────────────────────
    config: {
      snapshot:  ()       => request('GET',  '/api/config/snapshot'),
      setModule: (m, e)   => request('POST', '/api/config/module',  { module:m, enabled:e }),
      setTrading:(k, v)   => request('POST', '/api/config/trading', { key:k, value:v }),
    },

    // ── System (admin) ────────────────────────────────────────
    system: {
      info:    ()         => request('GET',  '/api/system/info'),
      users:   ()         => request('GET',  '/api/system/users'),
      summary: ()         => request('GET',  '/api/system/trades-summary'),
      updateUser: (id, d) => request('PATCH', `/api/system/users/${id}`, d),
      deleteUser: (id)    => request('DELETE', `/api/system/users/${id}`),
      resetPw:    (id, p) => request('POST', `/api/system/users/${id}/password`, { password:p }),
    },
  };
})();
