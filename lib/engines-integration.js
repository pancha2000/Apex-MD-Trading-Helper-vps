'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ApexIQ  ·  lib/engines-integration.js
 * ─────────────────────────────────────────────────────────────────────────
 *  This file shows exactly WHERE and HOW to wire the three new engines
 *  into your existing ApexIQ codebase.  Copy the relevant snippets into
 *  the appropriate files listed below.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/*
══════════════════════════════════════════════════════════════════════════════
  STEP 1  ·  npm install
══════════════════════════════════════════════════════════════════════════════

  npm install puppeteer node-cron

  Puppeteer downloads Chromium (~170 MB) automatically.
  If your VPS has very limited disk space, use puppeteer-core + chromium:
    npm install puppeteer-core chromium
  Then in chartGenerator.js, change the puppeteer.launch() call to:
    const chromium  = require('chromium');
    puppeteer.launch({ executablePath: chromium.path, ... })

══════════════════════════════════════════════════════════════════════════════
  STEP 2  ·  lib/database.js  — add cooldown field + schema patch
══════════════════════════════════════════════════════════════════════════════
*/

// ── Add to the TOP of database.js, before SaasUser model is compiled: ──────
function _step2_databaseJs_snippet() {
    /*
    const { patchUserSchemaForCooldown } = require('./riskGates');

    // Add this BEFORE:
    //   const SaasUser = mongoose.models.SaasUser || mongoose.model('SaasUser', SaasUserSchema);
    patchUserSchemaForCooldown(SaasUserSchema);

    // Also expose the Trade model so riskGates.js can query it directly:
    module.exports = {
        // ... existing exports ...
        Trade,           // ← add this if not already exported
        updateSaasUser,  // ← add this if not already exported
    };
    */
}

/*
══════════════════════════════════════════════════════════════════════════════
  STEP 3  ·  lib/signalDispatch.js  — add risk gates + chart generation
══════════════════════════════════════════════════════════════════════════════
  Find the dispatchSignal() function and add the gate check + chart call.
*/

// ── Complete updated dispatchSignal function ─────────────────────────────────
async function dispatchSignal_withGatesAndChart(conn, setup, userJid, opts = {}) {
    const db      = require('./database');
    const binance = require('./binance');
    const gates   = require('./riskGates');
    const chart   = require('./chartGenerator');

    // ── A. Load full user document ─────────────────────────────────────────
    const user = await db.getSaasUserByWhatsapp(userJid).catch(() => null);

    // ── B. Run Risk Gates ──────────────────────────────────────────────────
    const gateResult = await gates.runAllGates(setup, user, { binance, db });

    if (!gateResult.passed) {
        // Signal was blocked — log the reason (do NOT send to user)
        console.log(`[Dispatch] 🚫 Signal blocked for ${userJid}: ${gateResult.reason}`);
        // Optional: notify admin
        // await conn.sendMessage(ADMIN_JID, { text: `🚫 Gate: ${gateResult.reason}` });
        return { dispatched: false, reason: gateResult.reason };
    }

    // ── C. Attach any gate warnings to the message ─────────────────────────
    const warningLines = gateResult.warnings.length
        ? '\n\n⚠️ ' + gateResult.warnings.join('\n⚠️ ')
        : '';

    // ── D. Attempt Chart Generation ────────────────────────────────────────
    let chartBuffer = null;
    try {
        const candles = await binance.getKlineData(setup.coin, setup.timeframe || '15m', 100);

        // Fetch order blocks + FVGs from your existing analyzer result (if available)
        const orderBlocks = setup.orderBlocks || [];
        const fvgs        = setup.fvgs        || [];

        chartBuffer = await chart.generateSignalChart({
            coin:        setup.coin,
            timeframe:   setup.timeframe || '15m',
            direction:   setup.direction,
            entry:       setup.price || setup.entry,
            tp1:         setup.tp1,
            tp2:         setup.tp2,
            sl:          setup.sl,
            score:       setup.score,
            candles,
            orderBlocks,
            fvgs,
            reasons:     setup.reasons || '',
        });
    } catch (chartErr) {
        console.warn('[Dispatch] Chart generation failed (signal sent without chart):', chartErr.message);
    }

    // ── E. Build message text ──────────────────────────────────────────────
    const isLong   = setup.direction === 'LONG';
    const modeTag  = user?.tradingMode === 'auto_trade'
        ? '\n🤖 _Auto Trade mode_'
        : '\n📡 _Signals Only mode_';

    const text = `╔══════════════════════════════════╗
║  🚀  *APEXIQ TRADE SIGNAL*  🚀  ║
╚══════════════════════════════════╝

🪙 *${setup.coin}*  ${isLong ? '🟢 LONG ▲' : '🔴 SHORT ▼'}
⭐ Score: *${setup.score}*
📍 Entry:  *$${setup.price || setup.entry}*
🎯 TP1:    *$${setup.tp1 || '—'}*
🎯 TP2:    *$${setup.tp2 || '—'}*
🛑 SL:     *$${setup.sl}*
${modeTag}

✔️ ${setup.reasons}${warningLines}

_💡 Analysis: .future ${setup.coin.replace('USDT','')} 15m_`;

    // ── F. Send message (chart if available, else text only) ───────────────
    if (chartBuffer) {
        await conn.sendMessage(userJid, {
            image:    chartBuffer,
            mimetype: 'image/png',
            caption:  text,
        });
    } else {
        await conn.sendMessage(userJid, { text });
    }

    return { dispatched: true, gateResult };
}

/*
══════════════════════════════════════════════════════════════════════════════
  STEP 4  ·  plugins/backtest.js  — upgrade to pro engine
══════════════════════════════════════════════════════════════════════════════
  Replace the section that currently compiles win/loss stats with:
*/

async function backtestPlugin_upgradedSection(rawTrades, coin, timeframe, reply) {
    const engine = require('./backtestEngine');

    try {
        // Get fee/slippage settings from your existing db.getBacktestSettings()
        const db       = require('./database');
        const settings = await db.getBacktestSettings().catch(() => ({}));

        const result = await engine.runFullBacktest(rawTrades, {
            feePct:       settings.backtestFeePct      || 0.04,
            slippagePct:  settings.backtestSlippagePct || 0.10,
            slipPctExit:  0.05,
            startCapital: 10_000,
            riskPct:      1.0,
            runMC:        true,
            mcRuns:       1000,
            onProgress:   (pct) => console.log(`[Backtest] Monte Carlo: ${pct}%`),
        });

        const report = engine.formatBacktestReport(coin, timeframe, result);
        await reply(report);

        // Return result for further processing
        return result;

    } catch (err) {
        await reply(`❌ Pro Backtest failed: ${err.message}`);
        throw err;
    }
}

/*
══════════════════════════════════════════════════════════════════════════════
  STEP 5  ·  web/app-routes.js  — add dashboard endpoints
══════════════════════════════════════════════════════════════════════════════
  Add these API routes to expose the engines to the web dashboard.
*/

function _step5_appRoutes_snippet(app, saasAuth, db, binance) {
    const gates  = require('./riskGates');
    const engine = require('./backtestEngine');
    const chart  = require('./chartGenerator');

    // ── Risk gate status endpoint ─────────────────────────────────────────
    app.get('/app/api/risk-status', saasAuth.requireUserAuth, async (req, res) => {
        try {
            const user   = await db.getSaasUserById(req.saasUser.userId);
            const btcCtx = await gates.getBTCContextCached(binance);

            // Compute daily PnL for the user
            const dailyPnl = await gates._getDailyPaperPnL
                ? await gates._getDailyPaperPnL(user._id, db)
                : 0;

            const inCooldown = user.cooldownUntil && new Date() < new Date(user.cooldownUntil);
            const maxLoss    = -(user.maxDailyLossPct ?? 5);

            res.json({
                ok: true,
                btcContext:   btcCtx,
                dailyPnl:     parseFloat((dailyPnl || 0).toFixed(2)),
                cooldown: {
                    active:   inCooldown,
                    until:    user.cooldownUntil || null,
                },
                gateStatus: {
                    correlationArmed: btcCtx.score <= gates.BTC_DUMP_THRESHOLD,
                    dailyLimitPct:    maxLoss,
                    dailyLimitNearPct: (dailyPnl / maxLoss) * 100,
                },
            });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ── Reset cooldown (admin or user action) ─────────────────────────────
    app.post('/app/api/risk/reset-cooldown', saasAuth.requireUserAuth, async (req, res) => {
        try {
            const user = await db.getSaasUserById(req.saasUser.userId);
            await db.updateSaasUser(user._id, { cooldownUntil: null });
            res.json({ ok: true, message: 'Cooldown reset. Trade responsibly! 🧠' });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ── Generate chart preview (for dashboard) ────────────────────────────
    app.post('/app/api/chart/preview', saasAuth.requireUserAuth, async (req, res) => {
        try {
            const { coin, timeframe, direction, entry, tp1, tp2, sl, score } = req.body;
            if (!coin || !entry || !sl)
                return res.status(400).json({ ok: false, error: 'coin, entry, sl required' });

            const candles = await binance.getKlineData(
                coin.endsWith('USDT') ? coin : coin + 'USDT',
                timeframe || '15m',
                100
            );
            const buffer = await chart.generateSignalChart({
                coin, timeframe: timeframe || '15m', direction: direction || 'LONG',
                entry: parseFloat(entry), tp1: parseFloat(tp1), tp2: tp2 ? parseFloat(tp2) : null,
                sl: parseFloat(sl), score: score || 0, candles,
            });
            res.set('Content-Type', 'image/png');
            res.send(buffer);
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
}

/*
══════════════════════════════════════════════════════════════════════════════
  STEP 6  ·  Quick standalone test  (node lib/engines-integration.js)
══════════════════════════════════════════════════════════════════════════════
*/
if (require.main === module) {
    (async () => {
        console.log('Testing backtestEngine Monte Carlo...');
        const engine = require('./backtestEngine');

        // Simulated trade history (20 trades)
        const mockTrades = [
            { direction:'LONG',  entry:100, tp1:108, tp2:115, sl:95, result:'WIN',  leverage:5 },
            { direction:'LONG',  entry:200, tp1:210, tp2:220, sl:192, result:'WIN',  leverage:5 },
            { direction:'SHORT', entry:300, tp1:285, tp2:275, sl:310, result:'LOSS', leverage:5 },
            { direction:'LONG',  entry:150, tp1:162, tp2:170, sl:143, result:'WIN',  leverage:5 },
            { direction:'SHORT', entry:250, tp1:235, tp2:225, sl:260, result:'WIN',  leverage:5 },
            { direction:'LONG',  entry:180, tp1:192, tp2:200, sl:173, result:'LOSS', leverage:5 },
            { direction:'LONG',  entry:90,  tp1:98,  tp2:105, sl:85,  result:'WIN',  leverage:5 },
            { direction:'SHORT', entry:400, tp1:380, tp2:370, sl:412, result:'WIN',  leverage:5 },
            { direction:'LONG',  entry:120, tp1:130, tp2:138, sl:114, result:'LOSS', leverage:5 },
            { direction:'LONG',  entry:210, tp1:224, tp2:232, sl:202, result:'WIN',  leverage:5 },
            { direction:'SHORT', entry:350, tp1:333, tp2:325, sl:362, result:'LOSS', leverage:5 },
            { direction:'LONG',  entry:175, tp1:188, tp2:196, sl:168, result:'WIN',  leverage:5 },
            { direction:'SHORT', entry:280, tp1:266, tp2:258, sl:290, result:'WIN',  leverage:5 },
            { direction:'LONG',  entry:95,  tp1:103, tp2:110, sl:90,  result:'WIN',  leverage:5 },
            { direction:'SHORT', entry:420, tp1:399, tp2:388, sl:434, result:'LOSS', leverage:5 },
            { direction:'LONG',  entry:160, tp1:172, tp2:180, sl:153, result:'WIN',  leverage:5 },
            { direction:'SHORT', entry:310, tp1:295, tp2:285, sl:322, result:'WIN',  leverage:5 },
            { direction:'LONG',  entry:130, tp1:140, tp2:148, sl:124, result:'LOSS', leverage:5 },
            { direction:'LONG',  entry:240, tp1:256, tp2:265, sl:231, result:'WIN',  leverage:5 },
            { direction:'SHORT', entry:370, tp1:352, tp2:342, sl:382, result:'WIN',  leverage:5 },
        ];

        try {
            const result = await engine.runFullBacktest(mockTrades, {
                mcRuns: 500,  // faster for test
                onProgress: p => process.stdout.write(`\rMonte Carlo: ${p}%  `),
            });
            console.log('\n\n' + engine.formatBacktestReport('TEST', '15m', result));
        } catch (err) {
            console.error('Test failed:', err.message);
        }
    })();
}

module.exports = {
    dispatchSignal_withGatesAndChart,
    backtestPlugin_upgradedSection,
};
