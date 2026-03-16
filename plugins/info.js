/**
 * .info - Complete command guide (brief, user-friendly)
 */
const { cmd } = require('../lib/commands');
const config  = require('../config');

cmd({
    pattern: 'info',
    alias: ['guide', 'help2', 'commands'],
    desc: 'All commands with brief description',
    category: 'main',
    react: '📖',
    filename: __filename
}, async (conn, mek, m, { reply, args }) => {
    const P = config.PREFIX;

    // Specific command detail
    if (args[0]) {
        const details = {
            future: `*📖 .future — Futures AI Signal*\n\nUsage: ${P}future <coin> <timeframe>\n\nඋදා:\n${P}future BTC 15m   → Scalp (15-30 min)\n${P}future ETH 1h    → Intraday (2-4 hr)\n${P}future SOL 4h    → Swing (1-3 day)\n\nOutput:\n✅ 17-Factor Technical Score\n✅ Entry Zone (OB/Fib/Harmonic)\n✅ TP1, TP2, TP3 (Fib Extensions)\n✅ Smart SL (Swing Low/High)\n✅ Sentiment Layer (F&G + News)\n✅ 8-Factor Entry Confirmation\n✅ Position Size + Leverage\n✅ Whale Walls + Funding Rate\n\nSignal ලැබුවාට පස්සේ:\n↪️ Reply + ${P}paper → Virtual trade\n↪️ Reply + ${P}track → Real track`,

            spot: `*📖 .spot — Spot AI Signal*\n\nUsage: ${P}spot <coin> <timeframe>\n\nඋදා:\n${P}spot BTC 4h   → Mid-term\n${P}spot ETH 1d   → Long-term\n\nOutput:\n✅ 17-Factor Score\n✅ TP1, TP2, TP3, SL levels\n✅ 2% Capital risk sizing\n✅ Sentiment confirmation`,

            paper: `*📖 .paper — Virtual Paper Trade*\n\n1. ${P}future BTC 15m → Analysis ගන්න\n2. Analysis reply කරන්න\n3. ${P}paper යවන්න\n\nBot automatically:\n✅ Entry, TP, SL parse කරයි\n✅ 2% risk rule = quantity calculate\n✅ Leverage auto-set\n✅ Virtual position open වෙයි\n✅ Live P&L track කරයි\n\n${P}myptrades → Open positions + live P&L\n${P}closepaper BTC → Manual close`,

            track: `*📖 .track — Real Trade Tracker*\n\n1. Analysis reply කරන්න\n2. ${P}track යවන්න\n\nBot automatically:\n✅ Entry, TP, SL save\n✅ Price hit notify\n✅ Trailing SL move\n✅ Win/Loss record`,

            scanner: `*📖 Scanner — Auto Trading*\n\n${P}scanstart → Auto mode ON\n• Top 30 coins scan\n• Score ≥5 coins notify\n• Auto paper trades (set 6 on)\n• TP/SL auto-track\n• Daily midnight summary\n\n${P}superscan → Manual scan now\n${P}scanstop  → Stop`,

            alert: `*📖 .alert — Price Alerts*\n\nUsage:\n${P}alert BTC 100000          → auto\n${P}alert BTC above 100000    → above\n${P}alert BTC below 90000     → below\n\n${P}myalerts     → all alerts\n${P}delalert ID  → delete\n${P}clearalerts  → clear all\n\nEvery 30s check!`,

            calc: `*📖 .calc — Position Calculator*\n\nUsage: ${P}calc <entry> <sl> <tp> [capital]\n\nඋදා:\n${P}calc 65000 63000 70000\n${P}calc 65000 63000 70000 1000\n\nOutput:\n✅ Risk/Reward Ratio\n✅ 1% + 2% risk position sizes\n✅ Leverage suggestion\n✅ Liquidation price`,

            watch: `*📖 .watch — Watchlist*\n\n${P}watch BTC ETH SOL → Add (max 15)\n${P}watch             → Prices + 24h change\n${P}wlcheck           → Quick price check\n${P}unwatch BTC       → Remove\n${P}clearwatch        → Clear all`,

            backtest: `*📖 .backtest — Strategy Backtest*\n\nUsage: ${P}backtest <coin> <timeframe>\n\nඋදා: ${P}backtest BTC 15m\n\n1000 historical candles analyze කරලා:\n✅ Win Rate\n✅ Profit Factor\n✅ Max Consecutive Loss\n✅ LONG vs SHORT breakdown`,

            news: `*📖 .news — Crypto News*\n\nOutput:\n✅ Top 5 latest headlines\n✅ Fear & Greed Index\n✅ BTC Dominance\n✅ Sentiment (Bullish/Bearish/Neutral)`,
        };

        const key = args[0].toLowerCase().replace(/^\./, '');
        if (details[key]) return await reply(details[key]);
        return await reply(`❌ "${args[0]}" command ගැන guide නෑ.\n${P}info ලෙස full list බලන්න.`);
    }

    // Full command list
    const infoMsg = `
╔═══════════════════════════════╗
║   📖 *APEX-MD COMMAND GUIDE*   ║
╚═══════════════════════════════╝

*Details:* ${P}info <command>
*Example:* ${P}info future

━━━━ 📊 ANALYSIS ━━━━
${P}future BTC 15m   → Futures AI signal (17-factor)
${P}spot ETH 4h      → Spot AI signal
${P}backtest SOL 1h  → Historical strategy test
${P}chart BTC 15m    → Price chart image
${P}grid BTC         → Grid scalping zones
${P}news             → Crypto news + sentiment

━━━━ 🤖 PAPER TRADING ━━━━
${P}paper            → Open virtual trade (reply to analysis)
${P}myptrades        → Open positions + live P&L 🆕
${P}closepaper BTC   → Manually close position 🆕
${P}papercapital 500 → Set virtual balance
${P}stats            → Full performance journal

━━━━ 📋 TRADE TRACKING ━━━━
${P}track            → Track real trade (reply to analysis)
${P}mytrades         → View all tracked trades
${P}deltrade <ID>    → Delete a tracked trade

━━━━ 🔍 SCANNER ━━━━
${P}scanstart        → Auto scanner ON (owner)
${P}scanstop         → Auto scanner OFF (owner)
${P}superscan        → Manual top 5 scan

━━━━ 🔔 ALERTS & WATCHLIST ━━━━
${P}alert BTC 100000 → Set price alert
${P}myalerts         → View alerts
${P}delalert <ID>    → Delete alert
${P}clearalerts      → Clear all
${P}watch BTC ETH    → Add to watchlist
${P}wlcheck          → Live prices
${P}unwatch BTC      → Remove from watchlist

━━━━ 🧮 TOOLS ━━━━
${P}calc 100 95 120  → Risk/reward calculator
${P}margin 1000      → Set trading capital
${P}future BTC 15m   → then .paper/.track

━━━━ ⚙️ SETTINGS (Owner) ━━━━
${P}settings         → View all settings
${P}set 1 on/off     → Auto Signals
${P}set 2 on/off     → Trailing SL
${P}set 3 on/off     → Strict Mode
${P}set 4 on/off     → Partial TP Alerts
${P}set 5 1.5        → Min RRR
${P}set 6 on/off     → Auto Paper Trading
${P}set 7 6          → Paper Min Score

> _Powered by Groq AI + Binance Data_`;

    await reply(infoMsg.trim());
    await m.react('✅');
});
