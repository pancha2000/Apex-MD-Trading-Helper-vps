const mongoose = require('mongoose');
const config = require('../config');

// ─── 1. BOT SETTINGS SCHEMA ───
const SettingsSchema = new mongoose.Schema({
    id: { type: String, default: 'bot_settings' },
    strictMode: { type: Boolean, default: true },
    minRRR: { type: Number, default: 1.5 },
    autoSignal: { type: Boolean, default: false },
    partialTp: { type: Boolean, default: true },
    trailingSl: { type: Boolean, default: true },
    paperTrade: { type: Boolean, default: false },
    paperMinScore: { type: Number, default: 5 }
});

// ─── 2. USER SCHEMA (Wallet & Stats) ───
const UserSchema = new mongoose.Schema({
    jid: { type: String, required: true, unique: true },
    margin: { type: Number, default: 0 },
    paperBalance: { type: Number, default: 100 },
    paperStartBalance: { type: Number, default: 100 }, // ✅ FIX 2: Starting balance track
    paperTrades: { type: Number, default: 0 },
    paperWins: { type: Number, default: 0 },
    paperLosses: { type: Number, default: 0 }
});

// ─── 3. TRADE TRACKING SCHEMA ───
const TradeSchema = new mongoose.Schema({
    userJid: String,
    coin: String,
    type: String,
    direction: String,
    entry: Number,
    tp: Number,
    tp1: Number,
    tp2: Number,
    sl: Number,
    rrr: String,
    status: { type: String, default: 'active' }, // active, pending, closed
    result: String, // WIN, LOSS, BREAK-EVEN
    pnlPct: Number,
    tp1Hit: { type: Boolean, default: false },
    isPaper: { type: Boolean, default: false },
    paperProfit: { type: Number, default: 0 },
    // ✅ NEW: Paper trade position details (Binance-style)
    leverage:    { type: Number, default: 1 },
    quantity:    { type: Number, default: 0 },   // coin quantity
    marginUsed:  { type: Number, default: 0 },   // USDT deployed
    openTime:    { type: Date, default: Date.now },
    score:       { type: Number, default: 0 },   // analysis score at open
    timeframe:   { type: String, default: '15m' },
    orderType:   { type: String, default: 'MARKET' }, // MARKET or LIMIT
    tp2Hit:      { type: Boolean, default: false },
    dcaLevel:    { type: Number, default: 0 },   // 0 = no DCA, 1 = DCA1 triggered
    fillPrice:   { type: Number, default: 0 },    // actual fill price for limit orders
    closedAt:    { type: Date, default: null },    // ✅ NEW: when trade was closed
    tp3:         { type: Number, default: 0 },     // ✅ NEW: explicit TP3 field for display
});

// ─── MODELS ───
const Settings = mongoose.model('Settings', SettingsSchema);
const User = mongoose.model('User', UserSchema);
const Trade = mongoose.model('Trade', TradeSchema);

// ─── DATABASE FUNCTIONS ───
async function connect() {
    if (mongoose.connection.readyState === 0) {
        await mongoose.connect(config.MONGODB || 'mongodb://localhost/whatsapp-bot', {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });
        console.log('✅ Database Connected Successfully!');
    }
}

async function getSettings() {
    await connect();
    let settings = await Settings.findOne({ id: 'bot_settings' });
    if (!settings) settings = await Settings.create({ id: 'bot_settings' });
    return settings;
}

async function updateSettings(updates) {
    await connect();
    return await Settings.findOneAndUpdate({ id: 'bot_settings' }, updates, { new: true, upsert: true });
}

async function getUser(jid) {
    await connect();
    let user = await User.findOne({ jid });
    if (!user) user = await User.create({ jid });
    return user;
}

async function getMargin(jid) {
    const user = await getUser(jid);
    return user.margin;
}

async function setMargin(jid, amount) {
    await connect();
    await User.findOneAndUpdate({ jid }, { margin: amount }, { upsert: true });
}

async function updatePaperBalance(jid, pnlAmount, isWin, isBreakEven = false) {
    await connect();
    const user = await getUser(jid);
    user.paperBalance += pnlAmount;
    user.paperTrades += 1;
    // ✅ FIX 4: Break-even trades wins/losses count නොවෙනවා
    if (isWin) user.paperWins += 1;
    else if (!isBreakEven) user.paperLosses += 1;
    await user.save();
    return user;
}

async function saveTrade(data) {
    await connect();
    const trade = new Trade(data);
    return await trade.save();
}

async function closeTrade(id, result, pnlPct, paperProfit = 0) {
    await connect();
    return await Trade.findByIdAndUpdate(id, { status: 'closed', result, pnlPct, paperProfit, closedAt: new Date() });
}

// ==========================================
// ✅ BUG FIXES: NEW FUNCTIONS ADDED BELOW
// ==========================================

async function getActiveTrades(jid) {
    await connect();
    // ✅ FIX: isPaper: false - real trades only
    return await Trade.find({ userJid: jid, status: { $in: ['active', 'pending'] }, isPaper: false });
}

// ✅ FIX 6: Paper trades වෙනම ගැනීමට function
async function getActivePaperTrades(jid) {
    await connect();
    return await Trade.find({ userJid: jid, status: { $in: ['active', 'pending'] }, isPaper: true });
}

async function deleteTrade(id) {
    await connect();
    try {
        const result = await Trade.findByIdAndDelete(id);
        return result != null;
    } catch (e) {
        return false;
    }
}

async function getTradeStats(jid) {
    await connect();
    // ✅ වෙනස්කම: isPaper: false එක් කළා
    const activeTrades = await Trade.countDocuments({ userJid: jid, status: { $in: ['active', 'pending'] }, isPaper: false });
    const closedTrades = await Trade.find({ userJid: jid, status: 'closed', isPaper: false }).sort({ _id: -1 });
    
    let wins = 0, losses = 0, totalPnl = 0;
    let best = null, worst = null;
    let currentStreakType = null, currentStreakCount = 0, maxStreak = 0;
    let recent = [];
    
    for (let i = 0; i < closedTrades.length; i++) {
        const t = closedTrades[i];
        // අලුත්ම Trades 5
        if (recent.length < 5) {
            let resIcon = t.result === 'WIN' ? '🟢' : t.result === 'LOSS' ? '🔴' : '⚪';
            let pnlStr = t.pnlPct ? (t.pnlPct > 0 ? '+' : '') + t.pnlPct.toFixed(2) + '%' : '';
            recent.push(`${resIcon} ${t.coin} (${t.direction}) ${pnlStr}`);
        }

        if (t.result === 'WIN') wins++;
        else if (t.result === 'LOSS') losses++;
        
        let pnl = t.pnlPct || 0;
        totalPnl += pnl;

        if (!best || pnl > best.pnlPct) best = t;
        if (!worst || pnl < worst.pnlPct) worst = t;

        // Streak ගණනය කිරීම
        if (i === 0) currentStreakType = t.result;
        if (t.result === currentStreakType && currentStreakType === 'WIN') {
            currentStreakCount++;
            if (currentStreakCount > maxStreak) maxStreak = currentStreakCount;
        } else if (t.result === 'WIN') {
            currentStreakType = 'WIN';
            currentStreakCount = 1;
        } else {
            currentStreakType = t.result;
            currentStreakCount = 0;
        }
    }

    const totalClosed = wins + losses;
    const winRate = totalClosed > 0 ? ((wins / totalClosed) * 100).toFixed(2) : 0;
    
    return {
        active: activeTrades,
        total: closedTrades.length,
        wins, losses, winRate,
        totalPnl: totalPnl.toFixed(2),
        best, worst,
        currentStreak: currentStreakCount > 0 ? 'WIN' : (losses > 0 ? 'LOSS' : 'NONE'),
        maxStreak, recent
    };
}

// ✅ NEW: Paper Capital set කිරීම
async function setPaperCapital(jid, amount) {
    await connect();
    const user = await getUser(jid);
    user.paperBalance = amount;
    user.paperStartBalance = amount;
    user.paperTrades = 0;
    user.paperWins = 0;
    user.paperLosses = 0;
    await user.save();
    return user;
}

// ✅ NEW: Funding Rate ගැනීම (future.js ට)
async function getFundingRate(coin) {
    try {
        const axios = require('axios');
        const res = await axios.get(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${coin}&limit=1`);
        if (res.data && res.data.length > 0) {
            const rate = parseFloat(res.data[0].fundingRate) * 100;
            const emoji = rate > 0.05 ? '🔴' : rate < -0.05 ? '🟢' : '⚪';
            return `${emoji} ${rate.toFixed(4)}% (${rate > 0.05 ? 'Longs pay Shorts' : rate < -0.05 ? 'Shorts pay Longs' : 'Neutral'})`;
        }
        return 'N/A';
    } catch(e) { return 'N/A'; }
}

module.exports = {
    connect,
    connectDB: connect,
    getSettings,
    updateSettings,
    getUser,
    getMargin,
    setMargin,
    saveMargin: setMargin, // ✅ FIX: margin.js එකේ තිබුණු නම මෙතනින් හැදුවා
    updatePaperBalance,
    saveTrade,
    closeTrade,
    getActiveTrades, // ✅ FIX: mytrades වලට
    getActivePaperTrades, // ✅ FIX 6: paper trades list
    setPaperCapital,     // ✅ NEW: .papercapital command
    getFundingRate,      // ✅ NEW: funding rate
    deleteTrade,     // ✅ FIX: deltrade වලට
    getTradeStats,   // ✅ FIX: stats වලට
    Trade,
    User
};