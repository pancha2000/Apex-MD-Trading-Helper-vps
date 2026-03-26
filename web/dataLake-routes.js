'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD  ·  web/dataLake-routes.js
 *  ──────────────────────────────────────────────────────────────
 *  All Data Lake API & page routes.
 *  Register in web/server.js exactly like scanner-routes.js.
 *
 *  Page routes
 *  ───────────
 *    GET  /app/datalake            → dashboard UI
 *
 *  API routes
 *  ──────────
 *    GET  /app/api/datalake/status           → all tracked coins + stats
 *    POST /app/api/datalake/add-coin         → add coin to registry
 *    POST /app/api/datalake/remove-coin      → remove coin + data
 *    POST /app/api/datalake/sync             → sync single coin
 *    POST /app/api/datalake/sync-all         → sync all coins
 *    GET  /app/api/datalake/sync-stream/:id  → SSE progress stream
 *    GET  /app/api/datalake/candles          → get candles for analysis
 *    POST /app/api/datalake/temp-session     → create temp session
 *    POST /app/api/datalake/temp-session/refresh → refresh temp
 *    DELETE /app/api/datalake/temp-session   → cleanup temp session
 * ════════════════════════════════════════════════════════════════
 */

const lake = require('../lib/dataLakeManager');

module.exports = function registerDataLake({ saasAuth, renderView }, app) {

// ════════════════════════════════════════════════════════════════
//  PAGE ROUTE
// ════════════════════════════════════════════════════════════════

app.get('/app/datalake', saasAuth.requireUserAuth, (req, res) => {
    res.send(renderView('app/datalake', { username: req.saasUser.username }));
});

// ════════════════════════════════════════════════════════════════
//  STATUS — full overview of the lake
// ════════════════════════════════════════════════════════════════

app.get('/app/api/datalake/status', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const status = await lake.getStatus();
        res.json({ ok: true, ...status });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════
//  ADD COIN
//  Body: { symbol, startDate, timeframes? }
// ════════════════════════════════════════════════════════════════

app.post('/app/api/datalake/add-coin', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const { symbol, startDate, timeframes } = req.body || {};
        if (!symbol) return res.json({ ok: false, error: 'symbol is required' });
        if (!startDate) return res.json({ ok: false, error: 'startDate is required' });

        const coin = await lake.addCoin(symbol, startDate, timeframes);
        res.json({ ok: true, coin });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════
//  REMOVE COIN
//  Body: { symbol }
// ════════════════════════════════════════════════════════════════

app.post('/app/api/datalake/remove-coin', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const { symbol } = req.body || {};
        if (!symbol) return res.json({ ok: false, error: 'symbol is required' });

        const result = await lake.removeCoin(symbol);
        res.json({ ok: true, ...result });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════
//  SYNC SINGLE COIN  (async — client subscribes to SSE stream)
//  Body: { symbol }
//  Returns syncId immediately; progress via /sync-stream/:syncId
// ════════════════════════════════════════════════════════════════

app.post('/app/api/datalake/sync', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const { symbol } = req.body || {};
        if (!symbol) return res.json({ ok: false, error: 'symbol is required' });

        const syncId = `sync_${symbol.toUpperCase()}_${Date.now()}`;
        // Fire and forget — client watches SSE stream for progress
        lake.syncCoin(symbol, syncId).catch(console.error);
        res.json({ ok: true, syncId });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════
//  SYNC ALL  (async)
// ════════════════════════════════════════════════════════════════

app.post('/app/api/datalake/sync-all', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const syncId = `syncall_${Date.now()}`;
        lake.syncAll(syncId).catch(console.error);
        res.json({ ok: true, syncId });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════
//  SSE PROGRESS STREAM
//  Client opens this as an EventSource; events arrive in real time.
//  The stream auto-closes after 'done' or 'done_all' or 5 min timeout.
// ════════════════════════════════════════════════════════════════

app.get('/app/api/datalake/sync-stream/:syncId', saasAuth.requireUserAuth, (req, res) => {
    const { syncId } = req.params;

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');   // Nginx: disable buffering
    res.flushHeaders();

    function send(data) {
        try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
    }

    // Safety timeout — close stream after 5 minutes regardless
    const timeout = setTimeout(() => {
        lake.offProgress(syncId);
        send({ type: 'timeout' });
        res.end();
    }, 5 * 60_000);

    lake.onProgress(syncId, (event) => {
        send(event);
        if (event.type === 'done' || event.type === 'done_all' ||
            event.type === 'error' || event.type === 'timeout') {
            clearTimeout(timeout);
            lake.offProgress(syncId);
            setTimeout(() => res.end(), 500);
        }
    });

    req.on('close', () => {
        clearTimeout(timeout);
        lake.offProgress(syncId);
    });
});

// ════════════════════════════════════════════════════════════════
//  GET CANDLES  (used by analysis pages)
//  Query: coin, timeframe, limit, sessionId?
// ════════════════════════════════════════════════════════════════

app.get('/app/api/datalake/candles', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const { coin, timeframe, limit, sessionId } = req.query;
        if (!coin || !timeframe) return res.json({ ok: false, error: 'coin and timeframe are required' });

        const result = await lake.getCandles(
            coin, timeframe, parseInt(limit) || 500, sessionId || null
        );
        res.json({ ok: true, ...result });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════
//  CREATE TEMP SESSION
//  Body: { coin }
//  Used when user analyses a coin not in the lake.
//  Returns sessionId — include in subsequent candle requests.
// ════════════════════════════════════════════════════════════════

app.post('/app/api/datalake/temp-session', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const { coin, timeframe, limit } = req.body || {};
        if (!coin) return res.json({ ok: false, error: 'coin is required' });

        const tf  = timeframe || '15m';
        const lim = parseInt(limit) || 500;
        const result = await lake.getCandles(coin, tf, lim, null);
        res.json({ ok: true, ...result });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════
//  REFRESH TEMP SESSION  (market moved — re-fetch latest candles)
//  Body: { sessionId, timeframe, limit? }
// ════════════════════════════════════════════════════════════════

app.post('/app/api/datalake/temp-session/refresh', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const { sessionId, timeframe, limit } = req.body || {};
        if (!sessionId || !timeframe) return res.json({ ok: false, error: 'sessionId and timeframe are required' });

        const result = await lake.refreshTempSession(sessionId, timeframe, parseInt(limit) || 500);
        res.json({ ok: true, ...result });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════
//  DELETE TEMP SESSION  (trade closed — free ephemeral data)
//  Body: { sessionId }
// ════════════════════════════════════════════════════════════════

app.delete('/app/api/datalake/temp-session', saasAuth.requireUserAuth, async (req, res) => {
    try {
        const { sessionId } = req.body || {};
        if (!sessionId) return res.json({ ok: false, error: 'sessionId is required' });

        const result = await lake.deleteTempSession(sessionId);
        res.json({ ok: true, ...result });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

// ─── Module loaded log ───────────────────────────────────────────
console.log('[Dashboard] ✅ Data Lake routes registered (/app/datalake)');

};  // end registerDataLake
