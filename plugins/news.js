const { cmd } = require('../lib/commands');
const axios = require('axios');

// ═══════════════════════════════════════════════════════
// ✅ NEW: .news - Latest Crypto News (Top 5)
// ═══════════════════════════════════════════════════════
cmd({
    pattern: "news",
    alias: ["cryptonews", "marketnews"],
    desc: "Latest Crypto News & Market Sentiment",
    category: "crypto",
    react: "📰",
    filename: __filename
},
async (conn, mek, m, { reply }) => {
    try {
        await m.react('⏳');

        // ─── 1. Crypto News (CryptoCompare) ───
        let newsItems = [];
        try {
            const newsRes = await axios.get('https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=latest', { timeout: 8000 });
            newsItems = newsRes.data.Data.slice(0, 5);
        } catch (e) {
            return await reply('❌ News ලබාගැනීමේ දෝෂයක් ඇත. CryptoCompare API fail විය.');
        }

        // ─── 2. Fear & Greed Index ───
        let fng = 'Unknown';
        let fngEmoji = '⚪';
        try {
            const fngRes = await axios.get('https://api.alternative.me/fng/', { timeout: 5000 });
            const val = parseInt(fngRes.data.data[0].value);
            const classification = fngRes.data.data[0].value_classification;
            fngEmoji = val >= 75 ? '🤑' : val >= 55 ? '😊' : val >= 45 ? '😐' : val >= 25 ? '😨' : '😱';
            fng = `${fngEmoji} ${val} - ${classification}`;
        } catch (e) { }

        // ─── 3. BTC Dominance (approximate via CoinGecko) ───
        let btcDom = 'N/A';
        try {
            const cgRes = await axios.get('https://api.coingecko.com/api/v3/global', { timeout: 5000 });
            const dom = cgRes.data.data.market_cap_percentage.btc;
            btcDom = `${dom.toFixed(1)}%`;
        } catch (e) { }

        // ─── 4. Format Output ───
        let newsMsg = '';
        newsItems.forEach((n, i) => {
            // Sentiment detection from title
            const title = n.title;
            const isBull = /bull|surge|soar|rally|gain|rise|pump|ath|record|green/i.test(title);
            const isBear = /bear|crash|drop|fall|plunge|dump|red|warning|fear|ban|hack/i.test(title);
            const sentEmoji = isBull ? '🟢' : isBear ? '🔴' : '⚪';
            const source = n.source_info?.name || n.source || 'Unknown';
            const timeAgo = Math.round((Date.now() / 1000 - n.published_on) / 60);
            const timeStr = timeAgo < 60 ? `${timeAgo}m ago` : `${Math.round(timeAgo/60)}h ago`;

            newsMsg += `${sentEmoji} *${i+1}. ${title}*\n`;
            newsMsg += `   📌 ${source} | ⏰ ${timeStr}\n\n`;
        });

        const out = `
╔═══════════════════════════╗
║  📰 *CRYPTO NEWS FEED*   ║
╚═══════════════════════════╝

*📊 Market Pulse:*
😱 Fear & Greed: ${fng}
₿ BTC Dominance: ${btcDom}

───────────────────────────
*🗞️ Latest News (Top 5):*

${newsMsg.trim()}
───────────────────────────
> 🟢 Bullish  🔴 Bearish  ⚪ Neutral`;

        await reply(out.trim());
        await m.react('✅');
    } catch (e) {
        await reply('❌ Error: ' + e.message);
    }
});