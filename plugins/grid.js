const { cmd } = require('../lib/commands');
const binance = require('../lib/binance');
const indicators = require('../lib/indicators');

cmd({
    pattern: "grid",
    alias: ["dca", "scalp"],
    desc: "Grid Trading Bot (For Choppy/Sideways Markets)",
    category: "crypto",
    react: "🕸️",
    filename: __filename
},
async (conn, mek, m, { reply, args }) => {
    try {
        if (!args[0]) return await reply('❌ Coin එක ලබා දෙන්න! උදා: .grid SOL 15m');
        let coin = args[0].toUpperCase();
        if (!coin.endsWith('USDT')) coin += 'USDT';
        let timeframe = args[1] ? args[1].toLowerCase() : '15m';

        await m.react('⏳');
        const candles = await binance.getKlineData(coin, timeframe, 100);
        const currentPrice = parseFloat(candles[candles.length - 1][4]);

        // ADX පරික්ෂාව (Grid හරියන්නේ Choppy මාකට් එකටයි)
        const adxData = indicators.calculateADX(candles.slice(-50));
        let warning = "";
        if (adxData.isStrong) {
            warning = `\n⚠️ *අවවාදයයි:* ADX අගය ඉහළයි (${adxData.value}). Market එක එක පැත්තකට වේගයෙන් ගමන් කරයි (Trending). Grid Trading කිරීම අවදානම් විය හැක!`;
        }

        // Support සහ Resistance සෙවීම
        let highs = candles.slice(-50).map(c => parseFloat(c[2]));
        let lows = candles.slice(-50).map(c => parseFloat(c[3]));
        let resistance = Math.max(...highs);
        let support = Math.min(...lows);

        // Grid Levels 5ක් සෑදීම
        let gridStep = (resistance - support) / 5;
        let grids = [];
        for (let i = 0; i <= 5; i++) {
            grids.push((support + (gridStep * i)).toFixed(4));
        }

        const msg = `
╔═══════════════════════════╗
║ 🕸️ *GRID SCALPING ZONES* ║
╚═══════════════════════════╝

🪙 ${coin} | Price: $${currentPrice.toFixed(4)}
📊 Market Type: ${adxData.isStrong ? "Trending 🚀" : "Choppy/Sideways ⚖️"}${warning}

*🎯 Grid Levels (Buy Low, Sell High):*
🔴 Resistance: $${grids[5]} (Strong Sell / Short)
🟠 Grid 4:     $${grids[4]} (Take Profit Zone)
🟡 Grid 3:     $${grids[3]} (Neutral / Wait)
🟢 Grid 2:     $${grids[2]} (Buy Zone / DCA 1)
🔵 Support:    $${grids[0]} (Strong Buy / DCA 2)

*💡 පාවිච්චි කරන ආකාරය:*
Market එක පැත්තකට (Sideways) යන දිනවලදී, 'Grid 2' සහ 'Support' මට්ටම් වලින් Buy/Long කර, 'Grid 4' සහ 'Resistance' මට්ටම් වලින් විකුණා ලාභ (Scalp) ලබාගන්න.`;

        await reply(msg.trim());
        await m.react('✅');
    } catch (e) {
        await reply('❌ Error: ' + e.message);
    }
});
