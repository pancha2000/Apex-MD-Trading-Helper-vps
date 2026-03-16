const { cmd } = require('../lib/commands');
const binance = require('../lib/binance');
const indicators = require('../lib/indicators');
const axios = require('axios');

cmd({
    pattern: "chart",
    desc: "Generate Visual Trading Chart",
    category: "crypto",
    react: "🖼️",
    filename: __filename
},
async (conn, mek, m, { reply, args }) => {
    try {
        if (!args[0]) return await reply('❌ Coin එක ලබා දෙන්න! උදා: .chart BTC 15m');
        let coin = args[0].toUpperCase();
        if (!coin.endsWith('USDT')) coin += 'USDT';
        let timeframe = args[1] ? args[1].toLowerCase() : '15m';

        await m.react('⏳');
        await reply(`⏳ *${coin} හි Chart එක නිර්මාණය කරමින් පවතී...*`);

        const candles = await binance.getKlineData(coin, timeframe, 100);
        const recentCandles = candles.slice(-60);
        
        let labels = [];
        let prices = [];
        let ema50Data = [];

        const fullEma50 = indicators.calculateEMA(candles, 50, true); 
        const recentEma50 = fullEma50.slice(-60);

        recentCandles.forEach((c, i) => {
            let date = new Date(parseInt(c[0])); 
            labels.push(`${date.getHours()}:${date.getMinutes()}`);
            prices.push(parseFloat(c[4]));
            ema50Data.push(parseFloat(recentEma50[i]));
        });

        const chartConfig = {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Price (මිල)',
                        data: prices,
                        borderColor: '#00E676', 
                        backgroundColor: 'rgba(0, 230, 118, 0.1)',
                        borderWidth: 2,
                        fill: true,
                        pointRadius: 0
                    },
                    {
                        label: 'EMA 50 (Trend)',
                        data: ema50Data,
                        borderColor: '#FF1744', 
                        borderWidth: 2,
                        borderDash: [5, 5],
                        fill: false,
                        pointRadius: 0
                    }
                ]
            },
            options: {
                title: { display: true, text: `${coin} - ${timeframe} Chart`, fontColor: '#ffffff', fontSize: 18 },
                legend: { labels: { fontColor: '#ffffff' } },
                scales: {
                    xAxes: [{ ticks: { fontColor: '#aaaaaa', maxTicksLimit: 10 }, gridLines: { color: '#333333' } }],
                    yAxes: [{ ticks: { fontColor: '#aaaaaa' }, gridLines: { color: '#333333' } }]
                },
                layout: { padding: 10 }
            }
        };

        const response = await axios.post('https://quickchart.io/chart', {
            chart: chartConfig,
            width: 800,
            height: 400,
            backgroundColor: '#1E1E1E'
        }, { responseType: 'arraybuffer' });

        const buffer = Buffer.from(response.data, 'binary');

        // ✅ FIX: නිවැරදි JID එක ලබා ගැනීම (Error එක හැදුවේ මෙතනයි)
        const targetJid = mek.key.remoteJid || m.chat || m.from;

        await conn.sendMessage(targetJid, { 
            image: buffer, 
            caption: `📊 *${coin} - ${timeframe} Analysis Chart*\n\n🟢 කොළ පැහැය: Market Price\n🔴 රතු ඉරි: EMA 50 Trend Line\n\n_මිල EMA 50 ට වඩා ඉහළින් ඇත්නම් එය Uptrend එකකි._` 
        }, { quoted: mek });

        await m.react('✅');
    } catch (e) {
        await reply('❌ Chart එක සෑදීමේදී දෝෂයක්: ' + e.message);
    }
});
