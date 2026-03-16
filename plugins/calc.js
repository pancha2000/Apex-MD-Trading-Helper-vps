const { cmd } = require('../lib/commands');
const db = require('../lib/database');

// ═══════════════════════════════════════════════════════
// ✅ NEW: .calc - Instant Position Size & Risk Calculator
// Usage: .calc <entry> <sl> <tp> [capital]
//   .calc 100 95 120         → margin.js capital use කරනවා
//   .calc 100 95 120 1000    → custom capital $1000
// ═══════════════════════════════════════════════════════
cmd({
    pattern: "calc",
    alias: ["calculate", "riskCalc", "size"],
    desc: "Instant Position Size & Risk Calculator",
    category: "crypto",
    react: "🧮",
    filename: __filename
},
async (conn, mek, m, { reply, args }) => {
    try {
        if (args.length < 3) {
            return await reply(`❌ නිවැරදිව ලබා දෙන්න!\n\n*📌 Usage:*\n.calc <entry> <sl> <tp> [capital]\n\n*🔢 උදාහරණ:*\n.calc 65000 63000 70000\n.calc 65000 63000 70000 1000\n\n_Capital set කර නොමැත්නම් .margin capital use වෙනවා._`);
        }

        const entry = parseFloat(args[0]);
        const sl    = parseFloat(args[1]);
        const tp    = parseFloat(args[2]);

        if (isNaN(entry) || isNaN(sl) || isNaN(tp)) {
            return await reply('❌ Entry, SL, TP - ඔක්කොම numbers ලෙස දෙන්න!');
        }
        if (sl === entry) return await reply('❌ SL සහ Entry සමාන විය නොහැකිය!');

        // Capital - custom or from db
        let capital = args[3] ? parseFloat(args[3]) : 0;
        if (!capital || isNaN(capital)) {
            capital = await db.getMargin(m.sender) || 0;
        }

        // ─── Direction Detection ───
        const direction = tp > entry ? 'LONG 🟢' : 'SHORT 🔴';
        const isLong = tp > entry;

        // ─── Core Calculations ───
        const risk   = Math.abs(entry - sl);
        const reward = Math.abs(tp - entry);
        const rrr    = reward / risk;

        const riskPct   = (risk / entry) * 100;
        const rewardPct = (reward / entry) * 100;

        // RRR Emoji
        const rrrEmoji = rrr >= 3 ? '🏆' : rrr >= 2 ? '✅' : rrr >= 1.5 ? '⚠️' : '❌';

        // ─── Capital-based Calculations ───
        let capitalSection = '';
        if (capital > 0) {
            const riskAmount2pct = capital * 0.02;  // 2% risk rule
            const riskAmount1pct = capital * 0.01;  // 1% risk rule

            // Position size based on 2% risk
            const posSize2pct = riskAmount2pct / risk;
            const posSize1pct = riskAmount1pct / risk;

            // Leverage needed (10% margin deployment)
            const deployedMargin = capital * 0.10;
            const lev2pct = Math.min(Math.ceil((riskAmount2pct / riskPct * 100) / deployedMargin), 125);
            const lev1pct = Math.min(Math.ceil((riskAmount1pct / riskPct * 100) / deployedMargin), 125);

            // Profit amounts
            const profit2pct = posSize2pct * reward;
            const profit1pct = posSize1pct * reward;

            capitalSection = `
───────────────────────────
*💰 Position Sizing (Capital: $${capital})*

*2% Risk Rule (Recommended):*
🛡️ Risk Amount: $${riskAmount2pct.toFixed(2)}
📦 Position Size: ${posSize2pct.toFixed(4)} units
⚙️ Suggested Leverage: ${lev2pct}x (Isolated)
💵 Margin to Use: $${deployedMargin.toFixed(2)}
💰 Expected Profit: +$${profit2pct.toFixed(2)}

*1% Risk Rule (Conservative):*
🛡️ Risk Amount: $${riskAmount1pct.toFixed(2)}
📦 Position Size: ${posSize1pct.toFixed(4)} units
⚙️ Suggested Leverage: ${lev1pct}x (Isolated)
💰 Expected Profit: +$${profit1pct.toFixed(2)}`;
        } else {
            capitalSection = `\n> 💡 Capital set කිරීමට: *.margin 1000* හෝ *.calc ${entry} ${sl} ${tp} 1000*`;
        }

        // ─── Liquidation Price (Approximate for 10x) ───
        const liqLong  = entry * (1 - 1/10 + 0.005);  // ~10x leverage liq price
        const liqShort = entry * (1 + 1/10 - 0.005);

        const out = `
╔═══════════════════════════╗
║ 🧮 *RISK CALCULATOR*     ║
╚═══════════════════════════╝

📌 Direction: *${direction}*

*📊 Trade Setup:*
📍 Entry:  $${entry}
💰 TP:     $${tp} (+${rewardPct.toFixed(2)}%)
🛑 SL:     $${sl} (-${riskPct.toFixed(2)}%)

*⚖️ Risk/Reward:*
${rrrEmoji} RRR: *1:${rrr.toFixed(2)}*
📈 Reward: $${reward.toFixed(4)} per unit
📉 Risk:   $${risk.toFixed(4)} per unit

*💀 Liquidation Price (est. 10x):*
🔴 Liq (Long):  $${liqLong.toFixed(4)}
🔴 Liq (Short): $${liqShort.toFixed(4)}
${capitalSection}`;

        await reply(out.trim());
        await m.react('✅');
    } catch (e) {
        await reply('❌ Error: ' + e.message);
    }
});