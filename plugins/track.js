const { cmd } = require('../lib/commands');
const db = require('../lib/database');

cmd({
    pattern: "track",
    desc: "Save and track a crypto trade",
    category: "crypto",
    react: "🎯",
    filename: __filename
},
async (conn, mek, m, { reply }) => {
    try {
        if (!m.quoted) return await reply('❌ AI Analysis message එකට Reply කරමින් .track යවන්න.');

        const quotedText = m.quoted.conversation || m.quoted.extendedTextMessage?.text || m.quoted.text || m.quoted.body || "";
        if (!quotedText) return await reply('❌ Quoted message කියවීමට නොහැකිය.');

        // ✅ FIX 1: Coin match - /USDT format සහ plain coin name දෙකම support
        const coinMatch = quotedText.match(/([A-Z]{2,10})\s*\/\s*USDT/) 
            || quotedText.match(/\[TARGETS\|ENTRY:[0-9.]+\|TP:[0-9.]+\|SL:[0-9.]+\]\s*\(([A-Z]{2,10})USDT\)/)
            || quotedText.match(/🪙\s*([A-Z]{2,10})\s*\/\s*USDT/)
            || quotedText.match(/\b([A-Z]{2,10})USDT\b/);
        
        if (!coinMatch) {
            if (quotedText.includes("⏳")) {
                return await reply('❌ කරුණාකර "⏳ Loading..." මැසේජ් එකට නොව, අවසාන Analysis Report එකට Reply කර .track යවන්න.');
            }
            return await reply('❌ නිවැරදි Analysis message එකක් නොවේ. (Coin එක සොයාගැනීමට නොහැක)');
        }
        
        const coin = (coinMatch[1] || coinMatch[2]).replace('USDT', '') + 'USDT';
        const type = quotedText.includes('SPOT') ? 'spot' : 'future';

        // ✅ FIX 2: Format 3ක් support කරනවා:
        //   Format A (NEW): "[TARGETS|ENTRY:x|TP1:x|TP2:x|TP3:x|SL:x]"  (future.js new style)
        //   Format B (OLD): "[TARGETS|ENTRY:x|TP:x|SL:x]"                (future.js/spot.js old style)
        //   Format C:       "ENTRY: $1234 | TP: $1300 | SL: $1200"       (plain text style)

        // Format A — new full tag
        const newTagMatch = quotedText.match(
            /\[TARGETS\|ENTRY:([\d.]+)\|TP1:([\d.]+)\|TP2:([\d.]+)\|TP3:([\d.]+)\|SL:([\d.]+)\]/i
        );

        // Format B — old tag
        const oldTagMatch = quotedText.match(
            /\[TARGETS\|ENTRY:([\d,.]+)\|TP:([\d,.]+)\|SL:([\d,.]+)\]/i
        );

        // Format C — plain text
        const plainMatch = quotedText.match(
            /ENTRY:\s*\$([\d,.]+)\s*\|\s*TP:\s*\$([\d,.]+)\s*\|\s*SL:\s*\$([\d,.]+)/i
        );

        if (!newTagMatch && !oldTagMatch && !plainMatch) {
            return await reply('❌ Entry, TP, SL අගයන් සොයාගැනීමට නොහැක. (Track data නොමැත)');
        }

        let entry, tp, tp1, tp2, sl;

        if (newTagMatch) {
            // Format A — all TP levels directly from tag
            entry = parseFloat(newTagMatch[1]);
            tp1   = parseFloat(newTagMatch[2]);
            tp2   = parseFloat(newTagMatch[3]);
            tp    = parseFloat(newTagMatch[4]); // TP3 = final target
            sl    = parseFloat(newTagMatch[5]);
        } else {
            // Format B or C — extract entry/tp/sl, then parse TP1/TP2 from message body
            const raw = oldTagMatch || plainMatch;
            entry = parseFloat(raw[1].replace(/,/g, ''));
            tp    = parseFloat(raw[2].replace(/,/g, ''));
            sl    = parseFloat(raw[3].replace(/,/g, ''));

            // Try to extract TP1 and TP2 from message text (future.js shows them explicitly)
            const tp1Match = quotedText.match(/🎯\s*\*?TP1:\*?\s*\$?([\d,.]+)/i)
                          || quotedText.match(/TP1[^$]*\$?([\d,.]+)/i);
            const tp2Match = quotedText.match(/🎯\s*\*?TP2:\*?\s*\$?([\d,.]+)/i)
                          || quotedText.match(/TP2[^$]*\$?([\d,.]+)/i);

            tp1 = tp1Match ? parseFloat(tp1Match[1].replace(/,/g, '')) : null;
            tp2 = tp2Match ? parseFloat(tp2Match[1].replace(/,/g, '')) : null;
        }

        // ✅ FIX: Direction detection — must match explicit header line only.
        // Old code checked quotedText.includes('Bearish') which falsely matched
        // reason strings like "MACD Bear", "Bearish OB" even in LONG signals.
        // Now we extract from the explicit direction header line only.
        let direction = 'LONG';
        const dirLineMatch = quotedText.match(/\*?(LONG|SHORT)\*?\s*(?:🟢|🔴)|\b(LONG|SHORT)\b.*?(?:📊|Signal|Direction)/i)
            || quotedText.match(/Smart Entry[^\n]*(LONG|SHORT)/i)
            || quotedText.match(/🔴\s*\*?SHORT\*?|🟢\s*\*?LONG\*?/);
        if (dirLineMatch) {
            const matched = (dirLineMatch[1] || dirLineMatch[2] || dirLineMatch[0] || '').toUpperCase();
            direction = matched.includes('SHORT') ? 'SHORT' : 'LONG';
        } else if (/\[TARGETS\|.*?\]/.test(quotedText)) {
            // For tagged messages, check explicit SHORT tag
            direction = quotedText.includes('SHORT') && !quotedText.match(/Bear(?:ish)?\s+OB|MTF\s+Bear|MACD\s+Bear/) ? 'SHORT' : 'LONG';
        }

        const rrrMatch = quotedText.match(/RRR.*?(1:[\d.]+)/);
        const rrr = rrrMatch ? rrrMatch[1] : 'N/A';

        const isLimit = quotedText.includes('LIMIT ORDER') || quotedText.includes('PENDING') || quotedText.includes('Limit Order set');
        const initialStatus = isLimit ? 'pending' : 'active';

        await db.saveTrade({
            userJid: m.sender,
            coin, type, direction, entry, tp, tp1, tp2, sl, rrr,
            status: initialStatus
        });

        const statusMsg = isLimit 
            ? `⏳ *Pending Order:* Market එක $${entry} වෙත පැමිණි පසු Trade එක Auto-Active වනු ඇත.` 
            : `🟢 *Active Order:* Trade එක දැන් සිටම Track වේ.`;

        const tp2Line = tp2 ? `\n💰 TP2: $${tp2}` : '';
        const tp1Line = tp1 ? `\n🎯 TP1: $${tp1}` : '';

        await reply(`✅ *Trade Successfully Tracked!*\n\n🪙 ${coin} (${type.toUpperCase()} | ${direction})\n📍 Entry: $${entry}${tp1Line}${tp2Line}\n🏆 TP3: $${tp}\n🛑 SL: $${sl}\n\n${statusMsg}`);
        await m.react('✅');
    } catch (e) {
        await reply('❌ Error: ' + e.message);
    }
});