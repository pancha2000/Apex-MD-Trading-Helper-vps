/**
 * APEX-MD v6 — Main Menu
 * All commands listed, score guide updated, quick-start included
 */
'use strict';

const { cmd } = require('../lib/commands');
const config = require('../config');
const { runtime } = require('../lib/functions');
const axios = require('axios');

cmd({
    pattern: 'menu',
    alias: ['help', 'start', 'list', 'commands'],
    desc: 'Show full command menu',
    category: 'main',
    react: '📈',
    filename: __filename,
}, async (conn, mek, m, { reply }) => {
    try {
        const uptime = runtime(process.uptime());
        
        let btcLine = '...',
            fngLine = '...';
        try {
            const [btcR, fngR] = await Promise.allSettled([
                axios.get('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT', { timeout: 4000 }),
                axios.get('https://api.alternative.me/fng/', { timeout: 4000 }),
            ]);
            if (btcR.status === 'fulfilled') {
                const b = btcR.value.data;
                const chg = parseFloat(b.priceChangePercent);
                btcLine = `$${parseFloat(b.lastPrice).toLocaleString()} ${chg >= 0 ? '📈' : '📉'} ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
            }
            if (fngR.status === 'fulfilled') {
                const f = fngR.value.data.data[0];
                const v = parseInt(f.value);
                const e = v >= 75 ? '🤑' : v >= 55 ? '😊' : v >= 45 ? '😐' : v >= 25 ? '😨' : '😱';
                fngLine = `${e} ${v} — ${f.value_classification}`;
            }
        } catch (_) {}
        
        const P = config.PREFIX;
        
        const menu = `
╔══════════════════════════════╗
║  🤖 *APEX-MD TRADING BOT v6*  ║
╚══════════════════════════════╝

📛 *${config.BOT_NAME}*
⏱️ Uptime: ${uptime}
🧠 Engine: 70-Factor AI (v4+v5+v6)
🔒 Confirmations: 13-Layer Gate

₿ BTC: ${btcLine}
😱 Fear & Greed: ${fngLine}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 *ANALYSIS*
├ ${P}future BTC 15m    → 70-Factor AI Signal (Full)
├ ${P}future BTC 1h     → 1H timeframe signal
├ ${P}spot ETH 4h       → Spot market signal
├ ${P}chart BTC 15m     → Price chart image
├ ${P}grid BTC          → Grid scalping zones
└ ${P}news              → News + F&G + sentiment

🔍 *SCANNER*
├ ${P}scan              → Manual top 5 scan (instant)
├ ${P}set 1 on          → Auto scanner ON
└ ${P}set 1 off         → Auto scanner OFF

📊 *BACKTESTING* _(ALL 70 indicators)_
├ ${P}backtest BTC 15m  → Full-spectrum single coin test
├ ${P}backtest BTC 1h   → 1H swing backtest
├ ${P}scanbacktest      → Top 20 coins — find best 🆕
├ ${P}scanbacktest 1h   → 1H scanner backtest 🆕
└ ${P}scanbacktest 4h   → 4H swing backtest 🆕

💸 *MARKET INTEL*
├ ${P}fundingalert      → Extreme funding squeeze scanner 🆕
└ ${P}news              → Fear & Greed + crypto news

🤖 *PAPER TRADING* _(Virtual)_
├ ${P}paper             → Open trade (reply to signal)
├ ${P}myptrades         → Live P&L open positions
├ ${P}closepaper BTC    → Close position manually
├ ${P}paperhistory      → Closed trade history
├ ${P}resetpaper 500    → Reset to $500
└ ${P}stats             → Win rate + journal

📋 *REAL TRADE TRACKING*
├ ${P}track             → Track real trade (reply signal)
├ ${P}mytrades          → All active tracked trades
├ ${P}closetrade BTC    → Close tracked trade
└ ${P}deltrade <ID>     → Delete trade by ID

🔔 *PRICE ALERTS*
├ ${P}alert BTC 100000  → Set price alert
├ ${P}myalerts          → View active alerts
└ ${P}delalert <ID>     → Delete alert

👀 *WATCHLIST*
├ ${P}watch BTC ETH SOL → Add coins to watchlist
├ ${P}wlcheck / ${P}wl  → Live prices + quick analysis
└ ${P}unwatch BTC       → Remove from watchlist

🧮 *TOOLS*
├ ${P}calc 100 95 120   → Risk/position calculator
└ ${P}margin 1000       → Set trading capital

⚙️ *SETTINGS* _(Owner only)_
├ ${P}settings          → View all settings panel
├ ${P}set 1 on/off      → Auto scanner
├ ${P}set 2 on/off      → Trailing SL
├ ${P}set 3 on/off      → Strict mode
├ ${P}set 4 on/off      → Auto paper trade
└ ${P}set 5 <n>         → Min RRR (e.g. set 5 3 = 3:1)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🏆 *SIGNAL QUALITY GUIDE (v6 — Max 70)*
🔥🔥 Score 25+/70 = ELITE  — Highest confidence ever
🔥   Score 18+/70 = Strong  — Real money + bigger size
✅   Score 12+/70 = Good    — Paper + small real money
⚠️   Score 8+/70  = Weak    — Paper only (risky)
❌   Below 8      = Skip    — Auto filtered out

🔒 *CONFIRMATION GATE* _(new in v6)_
Confirmations: 0-13 sources checked
✅ ≥2 confirmations = quality signal
❌ 0 confirmations = rejected even if score high

━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📌 *QUICK START:*
1️⃣ ${P}margin 1000       → Set capital
2️⃣ ${P}scanbacktest      → Find best coins
3️⃣ ${P}future BTC 15m    → Get AI signal
4️⃣ Reply + ${P}paper     → Virtual trade open
5️⃣ ${P}myptrades         → Watch live P&L
6️⃣ ${P}set 1 on          → Auto mode ON

📖 ${P}info <command> for detail
_Example: ${P}info future | ${P}info paper_

> _© ${config.BOT_NAME} v6 ${new Date().getFullYear()} | 70-Factor AI | 13-Layer Confirmation_
`.trim();
        
        await reply(menu);
        await m.react('✅');
    } catch (e) {
        await reply('❌ Error: ' + e.message);
    }
});