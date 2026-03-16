/**
 * ================================================================
 * PAPER TRADE COMMAND (.paper / .pt)
 * ================================================================
 * Analysis reply + .paper → Virtual Binance-style position opens
 * Uses margin setting → calculates leverage, qty, marginUsed
 * .myptrades → Shows all open paper positions with live P&L
 *
 * ✅ FIX: Order type (LIMIT/MARKET) and trade status (pending/active)
 *         are now read directly from the analyzer's orderSuggestion
 *         output in the quoted message — NOT guessed from price proximity.
 *
 *         Priority:
 *           1. Parse "📋 *Order:*" line from the quoted analysis message
 *              (set by analyzer.js → orderSuggestion.type)
 *           2. Fallback: re-derive from live price vs entry (tight 0.3% band)
 *           3. Last resort: MARKET / active (safe default)
 * ================================================================
 */
const { cmd } = require('../lib/commands');
const config  = require('../config');
const db      = require('../lib/database');
const axios   = require('axios');

// ─── Helper: Get live price from Binance ─────────────────────────
async function getLivePrice(coin) {
    try {
        const res = await axios.get(
            `https://api.binance.com/api/v3/ticker/price?symbol=${coin}`,
            { timeout: 5000 }
        );
        return parseFloat(res.data.price);
    } catch { return null; }
}

// ─── Helper: Parse analysis message ──────────────────────────────
/**
 * Extracts all trade parameters from a .future / .spot analysis reply.
 * NEW: also extracts `parsedOrderType` ('LIMIT' | 'MARKET' | null)
 * from the "📋 *Order:*" line that analyzer.js writes via orderSuggestion.
 */
function parseAnalysisMsg(text) {
    // ── Coin ──────────────────────────────────────────────────────
    const coinMatch = text.match(/([A-Z]{2,10})\s*\/\s*USDT/)
        || text.match(/🪙\s*([A-Z]{2,10})/)
        || text.match(/\b([A-Z]{2,10})USDT\b/);
    if (!coinMatch) return null;
    const coin = (coinMatch[1]).replace('USDT','') + 'USDT';

    // ── Direction ─────────────────────────────────────────────────
    // PRIORITY ORDER (highest → lowest reliability):
    //   1. Emoji+word on header line: "🔴 *SHORT*" or "🟢 *LONG*"
    //      This is written by future.js/spot.js — most reliable.
    //   2. [TARGETS|...] tag — machine-generated, reliable but no direction field.
    //   3. ICT/Smart Entry line pattern.
    //   4. Fallback: full-text LONG/SHORT scan with word-boundary guards.
    //
    // WHY: WhatsApp message encoding can cause regex anchors ($) to behave
    // differently, and reason strings like "Short OB 🔴", "MTF Bear", "3TF Aligned
    // SHORT" can produce false positives. Using the emoji+word pair from the header
    // is the only truly unambiguous signal.
    let direction = 'LONG'; // safe default

    // Method 1 — emoji+word pair (🔴 *SHORT* or 🟢 *LONG*) anywhere in the message
    // Checks for both green/red emoji paired with the direction word.
    // Scans only the first 500 chars (header area) to avoid false hits in reasons.
    const headerText = text.slice(0, 500);
    const emojiDirMatch =
        headerText.match(/🔴\s*\*?\s*SHORT\s*\*?/) ? 'SHORT' :
        headerText.match(/🟢\s*\*?\s*LONG\s*\*?/)  ? 'LONG'  :
        // Fallback: search full text for same pattern
        text.match(/🔴\s*\*?\s*SHORT\s*\*?/)        ? 'SHORT' :
        text.match(/🟢\s*\*?\s*LONG\s*\*?/)         ? 'LONG'  :
        null;

    if (emojiDirMatch) {
        direction = emojiDirMatch;
    } else {
        // Method 2 — ICT / Smart Entry line
        const smartEntryMatch = text.match(/Smart Entry[^\n]*?(LONG|SHORT)/i);
        if (smartEntryMatch) {
            direction = smartEntryMatch[1].toUpperCase();
        } else {
            // Method 3 — explicit header pattern with end-of-line anchor
            const headerLineMatch = text.match(/^\s*(?:🔴|🟢)?\s*\*?(LONG|SHORT)\*?\s*$/im);
            if (headerLineMatch) {
                direction = headerLineMatch[1].toUpperCase();
            } else {
                // Method 4 — full text scan, avoiding reason-string false positives
                // Only match uppercase SHORT/LONG (reason strings use mixed case)
                const fullTextMatch = text.match(/\bSHORT\b(?!\s*OB|\s*Zone|\s*term|\s*Ratio)/)
                    ? 'SHORT'
                    : null;
                if (fullTextMatch) direction = fullTextMatch;
            }
        }
    }

    // ── Entry ─────────────────────────────────────────────────────
    const entryMatch = text.match(/Entry[:\s]*\$?([\d,.]+)/i)
        || text.match(/\[TARGETS\|ENTRY:([\d.]+)/i);
    if (!entryMatch) return null;
    const entry = parseFloat(entryMatch[1].replace(/,/g,''));

    // ── SL ───────────────────────────────────────────────────────
    const slMatch = text.match(/SL[^:]*:\s*\$?([\d,.]+)/i)
        || text.match(/\|SL:([\d.]+)/i);
    if (!slMatch) return null;
    const sl = parseFloat(slMatch[1].replace(/,/g,''));

    // ── TP1 ──────────────────────────────────────────────────────
    const tp1Match = text.match(/TP1[^$]*\$([\d,.]+)/i);
    const tp1 = tp1Match ? parseFloat(tp1Match[1].replace(/,/g,'')) : null;

    // ── TP2 (main TP) ────────────────────────────────────────────
    const tp2Match = text.match(/TP2[^$]*\$([\d,.]+)/i);
    let finalTp = tp2Match ? parseFloat(tp2Match[1].replace(/,/g,'')) : null;
    if (!finalTp) {
        const tgMatch = text.match(/\|TP:([\d.]+)/i);
        if (!tgMatch) return null;
        finalTp = parseFloat(tgMatch[1]);
    }

    // ── TP3 ──────────────────────────────────────────────────────
    const tp3Match = text.match(/TP3[^$]*\$([\d,.]+)/i);
    const tp3 = tp3Match ? parseFloat(tp3Match[1].replace(/,/g,'')) : null;

    // ── Leverage ─────────────────────────────────────────────────
    const levMatch = text.match(/Leverage[:\s]*([\d]+)x/i);
    const analysisLev = levMatch ? parseInt(levMatch[1]) : null;

    // ── Score ────────────────────────────────────────────────────
    const scoreMatch = text.match(/Score[:\s]*([\d]+)\s*\//i);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;

    // ── Timeframe ────────────────────────────────────────────────
    const tfMatch = text.match(/\.(?:future|spot|chart)\s+\w+\s+([\d]+[mhd])/i)
        || text.match(/\b(15m|1h|4h|1d|5m|1w)\b/i);
    const timeframe = tfMatch ? tfMatch[1] : '15m';

    // ── Trade Category (Sniper Edition) ──────────────────────────
    // Reads the MTF classification label produced by analyzer.js
    const categoryMatch = text.match(/(📅 SWING TRADE[^\n]*|🌅 INTRADAY TRADE[^\n]*|⚡ HIGH-PROB SCALP[^\n]*|📊 STANDARD SETUP[^\n]*)/);
    const tradeCategory = categoryMatch ? categoryMatch[1].trim() : null;

    // ── ✅ ORDER TYPE (THE CRITICAL FIX) ─────────────────────────
    // The analyzer writes: 📋 *Order:*    LIMIT ORDER ⏳ — reason
    //                   or 📋 *Order:*    MARKET ORDER 🟢 — reason
    //
    // We read THIS line to determine order type — NOT the live price heuristic.
    //
    // Patterns covered:
    //   future.js  → 📋 *Order:*    LIMIT ORDER ⏳ — ...
    //   spot.js    → 📋 Order: LIMIT ORDER ⏳
    //   any format → as long as "Order" is followed by LIMIT/MARKET
    const orderLineMatch =
        text.match(/📋\s*\*?Order[^:]*:\*?\s*(LIMIT ORDER|MARKET ORDER)/i) ||
        text.match(/Order[^\n:]*:\s*[^\n]*(LIMIT ORDER|MARKET ORDER)/i);

    let parsedOrderType = null;
    if (orderLineMatch) {
        const raw = orderLineMatch[1].toUpperCase();
        parsedOrderType = raw.includes('LIMIT') ? 'LIMIT' : 'MARKET';
    }

    return {
        coin, direction, entry, sl,
        tp1, tp: finalTp, tp3,
        analysisLev, score, timeframe,
        tradeCategory,
        parsedOrderType,   // ← new: 'LIMIT' | 'MARKET' | null
    };
}

// ─── Calculate position sizing (Binance Risk-Based — safe capped version) ────
function calcPosition(margin, entry, sl, direction, analysisLev, freeBalance = null) {
    const available = freeBalance !== null ? freeBalance : margin;
    const slDist    = Math.abs(entry - sl);
    const slDistPct = slDist / entry;

    // 2% risk on TOTAL capital (risk amount stays fixed)
    const riskAmt   = margin * 0.02;
    let quantity    = slDist > 0 ? riskAmt / slDist : 0;

    const rawLev    = slDistPct > 0 ? (riskAmt / slDistPct) / (margin * 0.10) : 10;
    const leverage  = analysisLev || Math.min(Math.ceil(rawLev), 100);
    let marginUsed  = quantity > 0 ? (quantity * entry) / leverage : 0;

    // Cap marginUsed to 20% of available balance per trade (safety rule)
    const maxMargin = available * 0.20;
    if (marginUsed > maxMargin && maxMargin > 0) {
        const scaleFactor = maxMargin / marginUsed;
        quantity   *= scaleFactor;
        marginUsed  = maxMargin;
    }

    // Minimum viable trade check
    const minMargin = 0.50; // $0.50 minimum
    if (marginUsed < minMargin) {
        return { riskAmt: 0, quantity: 0, leverage, marginUsed: 0, slDist, tooSmall: true };
    }

    return { riskAmt, quantity, leverage, marginUsed, slDist, tooSmall: false };
}

// ═══════════════════════════════════════════════════════════════
// CMD 1: .paper  — Open virtual paper trade from analysis reply
// ═══════════════════════════════════════════════════════════════
cmd({
    pattern: 'paper',
    alias: ['pt', 'papertrade'],
    desc: 'Analysis reply + .paper → Virtual Binance-style trade open',
    category: 'crypto',
    react: '🤖',
    filename: __filename
}, async (conn, mek, m, { reply }) => {
    try {
        if (!m.quoted) return await reply('❌ .future / .spot Analysis reply කරලා .paper යවන්න.');

        const text = m.quoted.conversation
            || m.quoted.extendedTextMessage?.text
            || m.quoted.text || m.quoted.body || '';
        if (!text) return await reply('❌ Quoted message read කරගන්න බැරිය.');

        const parsed = parseAnalysisMsg(text);
        if (!parsed) return await reply('❌ Analysis message parse කරගන්න බැරිය.\n(Entry/SL/Coin detect නොවිණ)');

        const {
            coin, direction, entry, sl, tp1, tp, tp3,
            analysisLev, score, timeframe,
            tradeCategory, parsedOrderType,
        } = parsed;

        // Stablecoin guard
        const STABLES = ['USDCUSDT','BUSDUSDT','DAIUSDT','TUSDUSDT','USDPUSDT','FRAXUSDT'];
        if (STABLES.includes(coin)) {
            return await reply(`❌ *${coin.replace('USDT','')} Stablecoin!*\nStablecoins paper trade කරන්න බෑ.`);
        }

        if (!tp) return await reply('❌ TP price detect නොවිණ. .future/.spot analysis message reply කරන්න.');

        // Margin check
        const userMargin = await db.getMargin(m.sender);
        if (!userMargin || userMargin <= 0) {
            return await reply(`❌ Capital set කර නැහැ!\n*.margin <amount>* දාලා capital set කරන්න.\nඋදා: .margin 1000`);
        }

        // Check if already have active/pending paper trade for this coin
        const existing = await db.Trade.findOne({
            userJid: m.sender, coin, isPaper: true, status: { $in: ['active', 'pending'] }
        });
        if (existing) {
            return await reply(
                `⚠️ *${coin} Paper Trade දැනටමත් Open!*\n\n` +
                `Entry: $${existing.entry} | ${existing.direction} | ` +
                `${existing.status === 'pending' ? '⏳ Pending Fill' : '🟢 Active'}\n\n` +
                `*.myptrades* ලෙස current positions බලන්න.`
            );
        }

        // Limit: max 5 open paper trades
        const openCount = await db.Trade.countDocuments({
            userJid: m.sender, isPaper: true, status: { $in: ['active', 'pending'] }
        });
        if (openCount >= 5) {
            return await reply('⚠️ Maximum 5 paper trades open කරන්න පුළුවන්.\n.myptrades ලෙස close/view කරන්න.');
        }

        // Calculate free (available) balance = total - locked in open trades
        const user = await db.getUser(m.sender);
        const openTrades = await db.Trade.find({
            userJid: m.sender, isPaper: true, status: { $in: ['active','pending'] }
        });
        const lockedMargin = openTrades.reduce((s, t) => s + (t.marginUsed || 0), 0);
        const freeBalance  = Math.max(0, (user.paperBalance || userMargin) - lockedMargin);

        if (freeBalance < 1.0) {
            return await reply(
                `❌ *Insufficient Balance!*\n\n` +
                `💰 Total: $${(user.paperBalance || userMargin).toFixed(2)}\n` +
                `🔒 Locked: $${lockedMargin.toFixed(2)} (${openCount} trades)\n` +
                `💵 Free: $${freeBalance.toFixed(2)}\n\n` +
                `⚠️ Free balance ඉතා අඩුයි. Open trades close කරලා retry කරන්න.`
            );
        }

        const { riskAmt, quantity, leverage, marginUsed, tooSmall } = calcPosition(
            userMargin, entry, sl, direction, analysisLev, freeBalance
        );

        if (tooSmall) {
            return await reply(
                `❌ *Position Too Small!*\n\n` +
                `SL distance ඉතා කුඩාය ($${Math.abs(entry-sl).toFixed(6)}).\n` +
                `Minimum $0.50 margin deploy කරන්නට SL distance ප්‍රමාණවත් නැහැ.\n\n` +
                `💡 Wider SL zone ඇති setup එකක් trade කරන්න.`
            );
        }

        // Get live price (used for display and fallback order-type detection)
        const livePrice = await getLivePrice(coin);

        // ═══════════════════════════════════════════════════════════
        // ✅ ORDER TYPE & STATUS DETERMINATION — FIXED LOGIC
        // ═══════════════════════════════════════════════════════════
        //
        // Priority 1 — Analyzer's own orderSuggestion from message
        //   The "📋 *Order:*" line in the analysis was written by the
        //   analyzer using getOrderTypeSuggestion(entryPrice, currentPrice).
        //   This is the most accurate source. Use it when found.
        //
        // Priority 2 — Live price fallback (tighter 0.3% band)
        //   If the message didn't contain the Order line (e.g. a custom
        //   message or an older format), compare live price to entry.
        //   Use a tight 0.3% tolerance so only true at-market entries
        //   classify as MARKET; anything else is a LIMIT.
        //
        // Priority 3 — Safe default: MARKET / active
        //   When no live price is available and the message has no order
        //   line (e.g. a manually typed trade), default to MARKET so the
        //   trade is immediately tracked.
        //
        let orderType;
        let tradeStatus;

        if (parsedOrderType) {
            // ── PRIORITY 1: trust the analyzer's explicit output ──
            orderType   = parsedOrderType;            // 'LIMIT' or 'MARKET'
            tradeStatus = orderType === 'MARKET' ? 'active' : 'pending';
        } else if (livePrice) {
            // ── PRIORITY 2: price-proximity fallback (tighter band) ──
            // Old code used 0.5% which is too wide and always fires.
            // 0.3% means only truly at-market entries become MARKET.
            const priceDiffPct = Math.abs(livePrice - entry) / entry * 100;
            orderType   = priceDiffPct <= 0.3 ? 'MARKET' : 'LIMIT';
            tradeStatus = orderType === 'MARKET' ? 'active' : 'pending';
        } else {
            // ── PRIORITY 3: no live price, no parsed type → safe default ──
            orderType   = 'MARKET';
            tradeStatus = 'active';
        }

        // For active (MARKET) trades, record the actual fill price
        const fillPrice = tradeStatus === 'active' ? (livePrice || entry) : 0;

        // Save trade to database
        await db.saveTrade({
            userJid: m.sender,
            coin, type: 'future', direction,
            // ✅ FIX: tp = final target (TP3), tp2 = second target. Before fix both were TP2.
            entry, tp: tp3 || tp, tp1: tp1 || tp, tp2: tp, sl,
            rrr: `1:${(Math.abs((tp3 || tp) - entry) / Math.abs(entry - sl)).toFixed(2)}`,
            status:    tradeStatus,   // ← 'active' or 'pending' (fixed)
            orderType: orderType,     // ← 'MARKET' or 'LIMIT' (fixed)
            fillPrice: fillPrice,
            isPaper: true,
            leverage, quantity, marginUsed,
            score, timeframe,
        });

        // Build display strings
        const coinBase = coin.replace('USDT','');
        const dirEmoji = direction === 'LONG' ? '🟢' : '🔴';
        const isLong   = direction === 'LONG';
        const qtyStr   = quantity < 1 ? quantity.toFixed(4) : quantity.toFixed(2);
        // SL is always a loss direction
        const slPct    = (Math.abs(entry - sl) / entry * 100).toFixed(2);
        const tpPct    = (Math.abs(tp - entry) / entry * 100).toFixed(2);
        const rrr      = (Math.abs(tp - entry) / Math.abs(entry - sl)).toFixed(2);
        const tp1Pct   = tp1 ? (Math.abs(tp1 - entry) / entry * 100).toFixed(2) : '0.00';
        // For LONG: TPs are above entry (+profit). For SHORT: TPs are below entry (+profit).
        // Validate TP direction — warn if TPs are on the wrong side of entry
        const tp1Valid = tp1 ? (isLong ? tp1 > entry : tp1 < entry) : true;
        const tp2Valid = tp  ? (isLong ? tp  > entry : tp  < entry) : true;
        const tp1Note  = !tp1Valid ? ' ⚠️' : '';
        const tp2Note  = !tp2Valid ? ' ⚠️' : '';

        // ── Order type display lines ──────────────────────────────
        const orderTypeDisplay = orderType === 'MARKET'
            ? '⚡ MARKET ORDER (Active Now)'
            : '⏳ LIMIT ORDER (Pending Fill)';

        const statusDisplay = tradeStatus === 'active'
            ? '🟢 ACTIVE'
            : '🟡 PENDING — Entry ලඟා වෙනකම් trade tracker wait කරයි';

        // ── Live price context line ───────────────────────────────
        let livePriceNote = '';
        if (livePrice) {
            const distPct = (Math.abs(livePrice - entry) / entry * 100).toFixed(2);
            if (tradeStatus === 'pending') {
                const needsDir = direction === 'LONG'
                    ? (livePrice > entry ? '📉 Price drop needed' : '📍 Near entry zone')
                    : (livePrice < entry ? '📈 Price rise needed' : '📍 Near entry zone');
                livePriceNote = `\n💹 Live:       $${livePrice.toFixed(4)} (${distPct}% away — ${needsDir})`;
            } else {
                livePriceNote = `\n💹 Live:       $${livePrice.toFixed(4)} ✅`;
            }
        }

        // ── Trade category note (MTF classification) ─────────────
        const categoryNote = tradeCategory
            ? `\n📋 Type:       ${tradeCategory}`
            : '';

        await reply(`
🤖 *PAPER TRADE OPENED!*
━━━━━━━━━━━━━━━━━━━━━━

🪙 *${coinBase}/USDT* ${dirEmoji} *${direction}*
📊 Score: ${score}/100 | ⏱️ ${timeframe}${categoryNote}

*Position Details:*
📍 Entry:     $${entry}${livePriceNote}
🎯 TP1:       $${tp1 ? tp1.toFixed(4) : 'N/A'} (+${tp1Pct}%)${tp1Note}
🎯 TP2:       $${tp.toFixed(4)} (+${tpPct}%)${tp2Note}
${tp3 ? `🎯 TP3:       $${tp3.toFixed(4)} (+${(Math.abs(tp3 - entry) / entry * 100).toFixed(2)}%)\n` : ''}🛡️ SL:        $${sl} (-${slPct}%)
⚖️ RRR:       1:${rrr}
${!tp1Valid || !tp2Valid ? '\n⚠️ _Warning: TP levels may be on wrong side of entry. Check analysis direction._\n' : ''}

*Virtual Position:*
⚙️ Leverage:  ${leverage}x (Isolated)
📦 Quantity:  ${qtyStr} ${coinBase}
💰 Margin:    $${marginUsed.toFixed(2)} USDT
🛡️ Risk:      $${riskAmt.toFixed(2)} (2% rule)

*Order Type:* ${orderTypeDisplay}
*Status:*     ${statusDisplay}

${tradeStatus === 'pending'
    ? '⏳ _Trade Tracker will auto-activate when price reaches entry zone._'
    : '✅ _Position is live. Trade Tracker is monitoring TP/SL._'}

📊 Live P&L → *.myptrades*
🗑️ Close → *.closepaper ${coin}*`.trim());

        await m.react('✅');
    } catch (e) {
        await reply('❌ Error: ' + e.message);
    }
});

// ═══════════════════════════════════════════════════════════════
// CMD 2: .myptrades — Show open paper positions with LIVE P&L
// ═══════════════════════════════════════════════════════════════
cmd({
    pattern: 'myptrades',
    alias: ['mypapertrades', 'positions', 'openpositions'],
    desc: 'View open paper trade positions with live P&L',
    category: 'crypto',
    react: '📊',
    filename: __filename
}, async (conn, mek, m, { reply }) => {
    try {
        await m.react('⏳');

        const trades = await db.Trade.find({
            userJid: m.sender,
            isPaper: true,
            status: { $in: ['active', 'pending'] }
        }).sort({ openTime: -1 });

        const user = await db.getUser(m.sender);

        if (!trades || trades.length === 0) {
            return await reply(
                `📊 *Open Paper Positions: 0*\n\n` +
                `Virtual trade open කරන්න:\n*.future BTC 15m* → Analysis ගෙන reply + *.paper*`
            );
        }

        // Get all live prices in parallel
        const prices = await Promise.all(
            trades.map(t => getLivePrice(t.coin).catch(() => null))
        );

        let totalPnL = 0;
        let totalMargin = 0;
        let msg = `📊 *OPEN PAPER POSITIONS (${trades.length}/5)*\n`;
        msg += `💰 Virtual Balance: $${user.paperBalance.toFixed(2)}\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

        trades.forEach((t, i) => {
            const livePrice = prices[i];
            const dirEmoji  = t.direction === 'LONG' ? '🟢' : '🔴';
            const coinBase  = t.coin.replace('USDT','');

            let pnlStr = 'N/A', pnlEmoji = '⚪', unrealizedPnL = 0;
            if (livePrice && t.quantity && t.leverage && t.status === 'active') {
                const priceDiff = t.direction === 'LONG'
                    ? livePrice - t.entry
                    : t.entry - livePrice;
                unrealizedPnL = priceDiff * t.quantity;
                totalPnL    += unrealizedPnL;
                totalMargin += (t.marginUsed || 0);
                const pnlPct = t.marginUsed > 0 ? (unrealizedPnL / t.marginUsed * 100) : 0;
                pnlEmoji = unrealizedPnL >= 0 ? '📈' : '📉';
                pnlStr   = `${unrealizedPnL >= 0 ? '+' : ''}$${unrealizedPnL.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`;
            }

            // Distance to TP/SL
            const distToSL = livePrice ? (Math.abs(livePrice - t.sl) / livePrice * 100).toFixed(1) : '?';
            const openTime  = new Date(t.openTime);
            const hoursOpen = ((Date.now() - openTime) / 3600000).toFixed(1);

            // ── Status tag: pending or active (with fill price if filled LIMIT) ──
            const orderTag = t.orderType === 'LIMIT' ? '⏳ LIMIT' : '⚡ MARKET';
            const statusTag = t.status === 'pending'
                ? `${orderTag} ORDER — ⏳ Waiting for Entry Fill`
                : t.orderType === 'LIMIT'
                    ? `${orderTag} ORDER — ✅ Filled @ $${t.fillPrice ? t.fillPrice.toFixed(4) : t.entry}`
                    : `⚡ MARKET ORDER — 🟢 ACTIVE`;

            const tp1Status = t.tp1Hit ? '✅' : '⬜';
            const tp2Status = t.tp2Hit ? '✅' : '⬜';
            const dcaStatus = t.dcaLevel > 0 ? ' | ⚠️ DCA Zone Hit' : '';

            msg += `*${i+1}. ${coinBase}/USDT* ${dirEmoji} ${t.direction} (${t.leverage || '?'}x)\n`;
            msg += `📋 ${statusTag}${dcaStatus}\n`;
            msg += `📍 Entry: $${t.entry} → 💹 Live: ${livePrice ? '$' + livePrice.toFixed(4) : 'N/A'}\n`;

            // For pending trades: show distance and which direction needed
            if (t.status === 'pending' && livePrice) {
                const distToEntry = ((Math.abs(livePrice - t.entry) / t.entry) * 100).toFixed(2);
                const directionNeeded =
                    (t.direction === 'LONG'  && livePrice > t.entry) ? '📉 Waiting for price drop' :
                    (t.direction === 'SHORT' && livePrice < t.entry) ? '📈 Waiting for price rise' :
                    '📍 Near entry zone — may fill soon';
                msg += `⏳ ${distToEntry}% away (${directionNeeded})\n`;
            }

            msg += `${pnlEmoji} *PnL: ${t.status === 'pending' ? '⏳ Pending fill...' : pnlStr}*\n`;
            // ✅ FIX: t.tp = TP3 (final target), t.tp2 = TP2 (intermediate target)
            // Show TP2 and TP3 separately — they should be different values now.
            const tp2Display = t.tp2 && parseFloat(t.tp2) !== parseFloat(t.tp)
                ? parseFloat(t.tp2).toFixed(4)
                : null;
            const tp3Display = parseFloat(t.tp).toFixed(4);
            const distToTP3 = livePrice ? (Math.abs(livePrice - parseFloat(t.tp)) / livePrice * 100).toFixed(1) : '?';

            msg += `🎯 TP1 ${tp1Status} $${parseFloat(t.tp1||t.tp).toFixed(4)} | TP2 ${tp2Status} $${tp2Display || parseFloat(t.tp2||t.tp).toFixed(4)}\n`;
            msg += `🎯 TP3: $${tp3Display} (${distToTP3}% away) | 🛡️ SL: $${parseFloat(t.sl).toFixed(4)} (${distToSL}% away)\n`;
            msg += `💰 Margin: $${(t.marginUsed||0).toFixed(2)} | 📦 Qty: ${(t.quantity||0).toFixed(4)} ${coinBase}\n`;
            msg += `⏱️ Open ${hoursOpen}h | 🆔 ${t._id.toString().slice(-6)}\n\n`;
        });

        const totalPnLEmoji = totalPnL >= 0 ? '📈' : '📉';
        msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `${totalPnLEmoji} *Total Unrealized: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}*\n\n`;
        msg += `🗑️ Close → *.closepaper <COIN>*\n`;
        msg += `📊 Full Stats → *.stats*`;

        await reply(msg);
        await m.react('✅');
    } catch (e) {
        await reply('❌ Error: ' + e.message);
    }
});

// ═══════════════════════════════════════════════════════════════
// CMD 3: .closepaper <COIN> — Manually close paper trade
// ═══════════════════════════════════════════════════════════════
cmd({
    pattern: 'closepaper',
    alias: ['closepapertrade', 'cpt'],
    desc: 'Manually close a paper trade position',
    category: 'crypto',
    react: '🗑️',
    filename: __filename
}, async (conn, mek, m, { reply, args }) => {
    try {
        if (!args[0]) return await reply('❌ Coin ලබා දෙන්න!\nඋදා: .closepaper BTC');

        let coin = args[0].toUpperCase();
        if (!coin.endsWith('USDT')) coin += 'USDT';

        const trade = await db.Trade.findOne({
            userJid: m.sender,
            coin,
            isPaper: true,
            status: { $in: ['active', 'pending'] }
        });

        if (!trade) return await reply(`❌ ${coin} paper trade open නෑ.\n*.myptrades* ලෙස positions බලන්න.`);

        const livePrice = await getLivePrice(coin);
        let paperProfit = 0, result = 'BREAK-EVEN', pnlPct = 0;

        if (trade.status === 'pending') {
            // Close a pending (never-filled) trade — no P&L
            await db.Trade.findByIdAndUpdate(trade._id, {
                status: 'closed',
                result: 'CANCELLED',
                paperProfit: 0,
            });
            const coinBase = coin.replace('USDT','');
            return await reply(
                `🗑️ *PAPER ORDER CANCELLED*\n\n` +
                `🪙 ${coinBase}/USDT | ${trade.direction}\n` +
                `📋 Order Type: ⏳ LIMIT (Never filled)\n` +
                `📍 Intended Entry: $${trade.entry}\n\n` +
                `💰 *PnL: $0.00 (Never activated)*\n` +
                `📊 Result: CANCELLED`
            );
        }

        if (livePrice && trade.quantity) {
            const priceDiff = trade.direction === 'LONG'
                ? livePrice - trade.entry
                : trade.entry - livePrice;
            paperProfit = priceDiff * trade.quantity;
            pnlPct = trade.marginUsed > 0 ? (paperProfit / trade.marginUsed * 100) : 0;
            result  = paperProfit > 0 ? 'WIN' : paperProfit < 0 ? 'LOSS' : 'BREAK-EVEN';
        }

        await db.closeTrade(trade._id, result, pnlPct, paperProfit);
        await db.updatePaperBalance(m.sender, paperProfit, result === 'WIN', result === 'BREAK-EVEN');

        const user      = await db.getUser(m.sender);
        const resEmoji  = result === 'WIN' ? '✅' : result === 'LOSS' ? '❌' : '➖';
        const coinBase  = coin.replace('USDT','');
        const orderTag  = trade.orderType === 'LIMIT' ? '⏳ LIMIT (Filled)' : '⚡ MARKET';

        await reply(`
${resEmoji} *PAPER TRADE CLOSED (Manual)*

🪙 ${coinBase}/USDT | ${trade.direction}
📋 Order: ${orderTag}
📍 Entry:  $${trade.entry}
💹 Close:  ${livePrice ? '$' + livePrice.toFixed(4) : 'N/A'}

💰 *PnL: ${paperProfit >= 0 ? '+' : ''}$${paperProfit.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)*
📊 Result: *${result}*

💼 New Balance: $${user.paperBalance.toFixed(2)}`.trim());

        await m.react('✅');
    } catch (e) {
        await reply('❌ Error: ' + e.message);
    }
});


// ═══════════════════════════════════════════════════════════════
// CMD 4: .paperhistory — Show closed paper trade history + PnL
// ═══════════════════════════════════════════════════════════════
cmd({
    pattern: 'paperhistory',
    alias: ['ph', 'phistory', 'paperstats'],
    desc: 'Closed paper trade history with PnL',
    category: 'crypto',
    react: '📜',
    filename: __filename
}, async (conn, mek, m, { reply, args }) => {
    try {
        await m.react('⏳');
        const limit = parseInt(args[0]) || 10;

        const trades = await db.Trade.find({
            userJid: m.sender,
            isPaper: true,
            status: 'closed'
        }).sort({ _id: -1 }).limit(Math.min(limit, 20));

        const user = await db.getUser(m.sender);
        const startBal = user.paperStartBalance || user.paperBalance || 0;

        if (!trades || trades.length === 0) {
            return await reply(
                '📜 *Paper Trade History*\n\nClosed trades නෑ.\n' +
                'First trade open කරන්න: *.future BTC 15m* → *.paper*'
            );
        }

        let wins = 0, losses = 0, breakEvens = 0, totalPnL = 0;
        let biggestWin = null, biggestLoss = null;

        let msg = `📜 *PAPER TRADE HISTORY (Last ${trades.length})*\n`;
        msg += `💰 Balance: $${user.paperBalance.toFixed(2)} | Start: $${startBal.toFixed(2)}\n`;
        const netPnL = user.paperBalance - startBal;
        msg += `📈 Net: ${netPnL >= 0 ? '+' : ''}$${netPnL.toFixed(2)}\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

        trades.forEach((t, i) => {
            const coinBase = t.coin.replace('USDT', '');
            const dirEmoji = t.direction === 'LONG' ? '🟢' : '🔴';
            const resEmoji = t.result === 'WIN' ? '✅' : t.result === 'LOSS' ? '❌' : t.result === 'CANCELLED' ? '🗑️' : '➖';
            const pnl     = t.paperProfit || 0;
            const pnlStr  = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;
            const pnlPct  = t.marginUsed > 0 ? (pnl / t.marginUsed * 100) : 0;
            const orderTag = t.orderType === 'LIMIT' ? '⏳' : '⚡';

            totalPnL += pnl;
            if      (t.result === 'WIN')   { wins++;       if (!biggestWin  || pnl > biggestWin.pnl)  biggestWin  = { coin: coinBase, pnl }; }
            else if (t.result === 'LOSS')  { losses++;     if (!biggestLoss || pnl < biggestLoss.pnl) biggestLoss = { coin: coinBase, pnl }; }
            else if (t.result !== 'CANCELLED') breakEvens++;

            const openDate = new Date(t.openTime || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

            msg += `${resEmoji} *${coinBase}* ${dirEmoji} ${t.direction} ${orderTag} | ${openDate}\n`;
            msg += `   📍 $${parseFloat(t.entry).toFixed(4)} → `;
            msg += `🎯 $${parseFloat(t.tp || 0).toFixed(4)} | 🛡️ $${parseFloat(t.sl || 0).toFixed(4)}\n`;
            msg += `   💰 PnL: *${pnlStr}* (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%) | ${t.leverage || '?'}x\n\n`;
        });

        const total      = wins + losses + breakEvens;
        const winRate    = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';
        const profitFactor = losses > 0 ? (wins * 3 / (losses * 2)).toFixed(2) : '∞';

        msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `🏆 *Win Rate: ${winRate}%* (${wins}W / ${losses}L / ${breakEvens}BE)\n`;
        msg += `📊 Profit Factor: ${profitFactor}\n`;
        msg += `💰 *Total PnL: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}*\n`;
        if (biggestWin)  msg += `🥇 Best: +$${biggestWin.pnl.toFixed(2)} (${biggestWin.coin})\n`;
        if (biggestLoss) msg += `💀 Worst: $${biggestLoss.pnl.toFixed(2)} (${biggestLoss.coin})\n`;
        msg += `\n💡 *.ph 20* — last 20 trades`;

        await reply(msg);
        await m.react('✅');
    } catch (e) {
        await reply('❌ Error: ' + e.message);
    }
});


// ═══════════════════════════════════════════════════════════════
// CMD 5: .resetpaper [amount] — Paper account reset to chosen amount
// ═══════════════════════════════════════════════════════════════
cmd({
    pattern: 'resetpaper',
    alias: ['paperreset', 'resetpt', 'newpaper'],
    desc: 'Paper trading account සම්පූර්ණයෙන් reset කරන්න',
    category: 'crypto',
    react: '🔄',
    filename: __filename
}, async (conn, mek, m, { reply, args }) => {
    try {
        // Amount — arg ලෙස දීලා නැත්නම් margin use කරනවා
        let resetAmount = 0;
        if (args[0] && !isNaN(parseFloat(args[0]))) {
            resetAmount = parseFloat(args[0]);
        } else {
            resetAmount = await db.getMargin(m.sender) || 100;
        }

        if (resetAmount < 1) {
            return await reply(
                `❌ *Invalid Amount!*\n\n` +
                `Usage: *.resetpaper 500* (amount ලබා දෙන්න)\n` +
                `    හෝ: *.resetpaper* (margin amount use කරනවා)\n\n` +
                `Min: $1`
            );
        }

        // Close all open paper trades first
        const openTrades = await db.Trade.find({
            userJid: m.sender,
            isPaper: true,
            status: { $in: ['active', 'pending'] }
        });

        let closedCount = 0;
        for (const trade of openTrades) {
            try {
                const livePrice = await getLivePrice(trade.coin).catch(() => null);
                let paperProfit = 0;
                if (livePrice && trade.quantity && trade.status === 'active') {
                    const diff = trade.direction === 'LONG'
                        ? livePrice - trade.entry
                        : trade.entry - livePrice;
                    paperProfit = diff * trade.quantity;
                }
                await db.Trade.findByIdAndUpdate(trade._id, {
                    status: 'closed',
                    result: 'MANUAL_RESET',
                    paperProfit: parseFloat(paperProfit.toFixed(2))
                });
                closedCount++;
            } catch(e) { /* skip */ }
        }

        // Reset paper account — balance, start balance, stats, win/loss counters
        await db.setPaperCapital(m.sender, resetAmount);

        // Also update margin if amount provided
        if (args[0] && !isNaN(parseFloat(args[0]))) {
            await db.setMargin(m.sender, resetAmount);
        }

        const closedMsg = closedCount > 0
            ? `\n🗑️ Closed ${closedCount} open position(s)`
            : '';

        await reply(`
🔄 *PAPER ACCOUNT RESET!*
━━━━━━━━━━━━━━━━━━━━━━

✅ Account සම්පූර්ණයෙන් reset විය!
${closedMsg}

💰 *New Balance: $${resetAmount.toFixed(2)}*
📊 Start Capital: $${resetAmount.toFixed(2)}
📈 Net P/L: $0.00 (0%)
🎯 Trades: 0 | Win Rate: 0%

━━━━━━━━━━━━━━━━━━━━━━
💡 *Commands:*
   *.paper* — New trade open කරන්න
   *.stats* — Stats බලන්න
   *.resetpaper 500* — $500 ලෙස reset
   *.resetpaper* — Margin amount ලෙස reset`.trim());

        await m.react('✅');
    } catch (e) {
        await reply('❌ Error: ' + e.message);
    }
});
