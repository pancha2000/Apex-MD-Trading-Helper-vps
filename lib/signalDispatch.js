'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  lib/signalDispatch.js  —  Per-User Signal Dispatcher
 *  ──────────────────────────────────────────────────────────────
 *  Central gateway between the scanner and trade execution.
 *  Checks each user's tradingMode before acting:
 *
 *    'signals_only'  → send WhatsApp + Web alert only
 *    'auto_trade'    → send alert AND execute on Binance
 *
 *  HOW TO USE (in scanner.js or any plugin):
 *
 *    const { dispatchSignal } = require('../lib/signalDispatch');
 *
 *    await dispatchSignal(conn, setup, userJid);
 *
 *  The function handles everything else internally.
 * ════════════════════════════════════════════════════════════════
 */

const db = require('./database');

// ─── Binance execution stub ────────────────────────────────────
// Replace this with your real Binance Futures order placement
// when you're ready to go live.  Keep the same function signature.
//
// Returns: { ok: boolean, orderId?: string, error?: string }
async function _executeBinanceOrder(apiKey, secretKey, setup) {
    // ┌─────────────────────────────────────────────────────────┐
    // │  TODO: Paste your Binance Futures order code here.      │
    // │                                                         │
    // │  Example using node-binance-api or axios directly:      │
    // │                                                         │
    // │  const res = await axios.post(                          │
    // │    'https://fapi.binance.com/fapi/v1/order',            │
    // │    { symbol: setup.coin+'USDT', side: setup.side,       │
    // │      type: 'MARKET', quantity: setup.qty },             │
    // │    { headers: { 'X-MBX-APIKEY': apiKey },               │
    // │      params:  { signature: <HMAC-SHA256> } }            │
    // │  );                                                     │
    // │  return { ok: true, orderId: res.data.orderId };        │
    // └─────────────────────────────────────────────────────────┘

    // Placeholder — logs intent but does NOT place a real order yet
    console.log(`[DISPATCH] 🔧 Binance execution stub called for ${setup.coin} ${setup.direction}`);
    console.log(`[DISPATCH]    API key (truncated): ${apiKey.slice(0, 8)}...`);
    return { ok: false, error: 'Binance execution not implemented yet — signals_only fallback' };
}

// ─── Build the WhatsApp alert message ─────────────────────────
function _buildAlertMessage(setup, mode) {
    const modeTag = mode === 'auto_trade'
        ? '\n🤖 _Auto Trade mode: order placed on Binance_'
        : '\n📡 _Signals Only mode: act manually on exchange_';

    const dir   = setup.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
    const order = setup.orderType
        ? (setup.orderType.includes('LIMIT') ? ' ⏳ LIMIT' : ' ⚡ MARKET')
        : '';

    return (
`╔══════════════════════════════════╗
║  🚀  *APEX-MD TRADE SIGNAL*  🚀  ║
╚══════════════════════════════════╝

🪙 *${setup.coin}/USDT*  ${dir}${order}
⭐ Score: *${setup.score}*
📍 Entry:  *$${setup.price}*
🎯 TP1:    *$${setup.tp1 || '—'}*
🎯 TP2:    *$${setup.tp2 || '—'}*
🎯 TP3:    *$${setup.tp3 || '—'}*
🛑 SL:     *$${setup.sl}*

✔️ ${setup.reasons}
${modeTag}

_💡 Full analysis: .future ${setup.coin} 15m_`
    );
}

// ─── Core dispatcher ──────────────────────────────────────────

/**
 * Dispatch a signal to one user, respecting their tradingMode.
 *
 * @param {object} conn      Baileys WA connection
 * @param {object} setup     Signal object from getTopDownSetups()
 * @param {string} userJid   WhatsApp JID of the recipient
 * @param {object} [saasUser] Pre-fetched SaasUser doc (optional — saves a DB query)
 */
async function dispatchSignal(conn, setup, userJid, saasUser = null) {
    try {
        // ── 1. Resolve the SaaS user record ───────────────────────
        const user = saasUser || await db.getSaasUserByWhatsapp(userJid);

        // User not linked to web portal — treat as signals_only (safe default)
        const mode = user?.tradingMode || 'signals_only';
        const accountStatus = user?.accountStatus || 'active';

        // Skip suspended accounts entirely
        if (accountStatus === 'suspended') {
            console.log(`[DISPATCH] ⏭️  Skipping ${userJid} — account suspended`);
            return { sent: false, reason: 'suspended' };
        }

        console.log(`[DISPATCH] 📤 ${setup.coin} ${setup.direction} → ${userJid} (mode: ${mode})`);

        // ── 2. Auto-Trade path ─────────────────────────────────────
        let orderResult = null;
        if (mode === 'auto_trade') {
            // Require API keys
            if (!user || !user.apiKeys || user.apiKeys.length === 0) {
                console.warn(`[DISPATCH] ⚠️  auto_trade but no API keys for ${userJid} — falling back to signal`);
                // Fall through to signal-only send
            } else {
                // Use the first Binance key (or let user select in future)
                const { decryptApiKey } = require('./saas-auth');
                const keyEntry   = user.apiKeys.find(k => k.exchange === 'binance') || user.apiKeys[0];
                const apiKey     = decryptApiKey(keyEntry.encApiKey);
                const secretKey  = decryptApiKey(keyEntry.encSecretKey);

                orderResult = await _executeBinanceOrder(apiKey, secretKey, setup);

                if (orderResult.ok) {
                    console.log(`[DISPATCH] ✅ Binance order placed: ${orderResult.orderId}`);
                } else {
                    console.warn(`[DISPATCH] ❌ Binance order failed: ${orderResult.error} — signal sent anyway`);
                }
            }
        }

        // ── 3. Always send WhatsApp alert ─────────────────────────
        const alertMsg = _buildAlertMessage(setup, mode);
        await conn.sendMessage(userJid, { text: alertMsg });

        // ── 4. Save trade record to DB (linked to SaaS userId) ────
        if (user) {
            try {
                const livePrice = parseFloat(setup.price);
                await db.saveTrade({
                    userId:    user._id,
                    userJid:   userJid,
                    coin:      setup.coin + 'USDT',
                    type:      'future',
                    direction: setup.direction,
                    entry:     livePrice,
                    tp:        setup.tp2  || setup.tp3,
                    tp1:       setup.tp1,
                    tp2:       setup.tp2,
                    tp3:       setup.tp3,
                    sl:        setup.sl,
                    status:    'active',
                    isPaper:   false,
                    score:     setup.rawScore || 0,
                    timeframe: '15m',
                    orderType: setup.orderType || 'MARKET',
                    // If order succeeded, note the execution
                    ...(orderResult?.ok ? { fillPrice: livePrice } : {}),
                });
            } catch (saveErr) {
                console.warn('[DISPATCH] Trade save failed:', saveErr.message);
            }
        }

        return { sent: true, mode, orderResult };

    } catch (e) {
        console.error('[DISPATCH] Error dispatching signal:', e.message);
        // Last-resort: try to send a plain alert so user isn't left dark
        try { await conn.sendMessage(userJid, { text: `📡 Signal: ${setup.coin} ${setup.direction} @ $${setup.price}` }); } catch (_) {}
        return { sent: false, error: e.message };
    }
}

/**
 * Broadcast a signal to ALL linked SaaS users.
 * Used by runSignalScan() as a drop-in replacement for the
 * single _ownerJidRef sendMessage call.
 *
 * @param {object} conn    Baileys WA connection
 * @param {object} setup   Single signal from getTopDownSetups()
 * @param {string} ownerJid  Always sent to owner regardless of DB
 */
async function broadcastSignal(conn, setup, ownerJid) {
    const results = [];

    // ── Always alert the owner ─────────────────────────────────
    try {
        await conn.sendMessage(ownerJid, { text: _buildAlertMessage(setup, 'signals_only') });
        results.push({ jid: ownerJid, sent: true, mode: 'owner' });
    } catch (e) {
        console.error('[DISPATCH] Owner send failed:', e.message);
    }

    // ── Alert all linked active users ──────────────────────────
    try {
        const { users } = await db.listSaasUsers(1, 200);
        const linked = users.filter(u =>
            u.whatsappJid &&
            u.accountStatus === 'active' &&
            u.whatsappJid !== ownerJid   // owner already sent above
        );

        for (const userSummary of linked) {
            // Fetch full user doc (need tradingMode + apiKeys)
            const fullUser = await db.getSaasUserById(userSummary._id);
            if (!fullUser) continue;
            const r = await dispatchSignal(conn, setup, fullUser.whatsappJid, fullUser);
            results.push({ jid: fullUser.whatsappJid, ...r });
        }
    } catch (e) {
        console.error('[DISPATCH] Broadcast loop error:', e.message);
    }

    return results;
}

module.exports = { dispatchSignal, broadcastSignal };
