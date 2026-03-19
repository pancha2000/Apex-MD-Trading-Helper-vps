'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD v7 PRO  ·  lib/database.js
 *  ──────────────────────────────────────────────────────────────
 *  SAAS UPGRADE — Schema additions:
 *    • SaasUser  — platform accounts (email/password/role)
 *    • WaUser    — existing WhatsApp wallet users (unchanged, jid-based)
 *    • Trade     — added optional userId for per-user ownership
 *    • Settings  — unchanged
 *  ⚠️  Existing exports are 100% backward-compatible.
 *      All old callers keep working without any changes.
 * ════════════════════════════════════════════════════════════════
 */

const mongoose = require('mongoose');
const config   = require('../config');

// ─────────────────────────────────────────────────────────────────
//  1. BOT SETTINGS SCHEMA  (unchanged)
// ─────────────────────────────────────────────────────────────────
const SettingsSchema = new mongoose.Schema({
    id:            { type: String,  default: 'bot_settings' },
    strictMode:    { type: Boolean, default: true  },
    minRRR:        { type: Number,  default: 1.5   },
    autoSignal:    { type: Boolean, default: false },
    partialTp:     { type: Boolean, default: true  },
    trailingSl:    { type: Boolean, default: true  },
    paperTrade:    { type: Boolean, default: false },
    paperMinScore: { type: Number,  default: 5     },
});

// ─────────────────────────────────────────────────────────────────
//  2. WHATSAPP WALLET USER SCHEMA  (renamed WaUser internally;
//     exported as both WaUser + User alias for backward compat)
// ─────────────────────────────────────────────────────────────────
const WaUserSchema = new mongoose.Schema({
    jid:               { type: String, required: true, unique: true },
    margin:            { type: Number, default: 0   },
    paperBalance:      { type: Number, default: 100 },
    paperStartBalance: { type: Number, default: 100 },
    paperTrades:       { type: Number, default: 0   },
    paperWins:         { type: Number, default: 0   },
    paperLosses:       { type: Number, default: 0   },
});

// ─────────────────────────────────────────────────────────────────
//  3. SAAS PLATFORM USER SCHEMA  ← NEW
// ─────────────────────────────────────────────────────────────────
/**
 * apiKeys stores encrypted Binance / Bybit credentials.
 * Encryption/decryption is handled by lib/saas-auth.js (AES-256-GCM).
 * Keys are NEVER stored in plaintext — only opaque ciphertext.
 *
 * One encrypted key entry shape:
 *   { label, exchange, encApiKey: '<iv:enc:tag>', encSecretKey: '<iv:enc:tag>' }
 */
const ApiKeyEntrySchema = new mongoose.Schema({
    label:        { type: String, required: true },
    exchange:     { type: String, enum: ['binance','bybit'], default: 'binance' },
    encApiKey:    { type: String, required: true },   // AES-256-GCM ciphertext
    encSecretKey: { type: String, required: true },   // AES-256-GCM ciphertext
    addedAt:      { type: Date,   default: Date.now },
}, { _id: true });

const SaasUserSchema = new mongoose.Schema({
    // ── Identity
    username:      { type: String,  required: true, unique: true, trim: true, minlength: 3, maxlength: 32 },
    email:         { type: String,  required: true, unique: true, lowercase: true, trim: true },

    // ── Auth  (scrypt hash via saas-auth.js — NEVER plaintext)
    passwordHash:  { type: String,  required: true },

    // ── Roles & Access
    role:          { type: String,  enum: ['user','admin'],                    default: 'user'   },
    accountStatus: { type: String,  enum: ['active','suspended','pending'],    default: 'active' },

    // ── API Keys  (encrypted sub-documents)
    apiKeys:       { type: [ApiKeyEntrySchema], default: [] },

    // ── Meta
    createdAt:     { type: Date,    default: Date.now },
    lastLoginAt:   { type: Date,    default: null  },
    loginCount:    { type: Number,  default: 0     },
    displayName:   { type: String,  default: ''    },
    timezone:      { type: String,  default: 'UTC' },

    // ── WhatsApp Linking
    whatsappJid:      { type: String, default: null, index: true }, // e.g. "94771234567@s.whatsapp.net"
    whatsappLinkedAt: { type: Date,   default: null },
    tradingMode:      { type: String, default: 'signals_only' }, // signals_only | auto_trade
});

SaasUserSchema.index({ username: 'text', email: 'text' });

// ─────────────────────────────────────────────────────────────────
//  4. TRADE TRACKING SCHEMA
//     userId added (optional) — backward compat: old trades have null
// ─────────────────────────────────────────────────────────────────
const TradeSchema = new mongoose.Schema({
    // NEW: SaaS user ownership (null = legacy WhatsApp-only trade)
    userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'SaasUser', default: null, index: true },

    // Original fields (all unchanged)
    userJid:     String,
    coin:        String,
    type:        String,
    direction:   String,
    entry:       Number,
    tp:          Number,
    tp1:         Number,
    tp2:         Number,
    sl:          Number,
    rrr:         String,
    status:      { type: String,  default: 'active' },
    result:      String,
    pnlPct:      Number,
    tp1Hit:      { type: Boolean, default: false },
    isPaper:     { type: Boolean, default: false },
    paperProfit: { type: Number,  default: 0 },
    leverage:    { type: Number,  default: 1 },
    quantity:    { type: Number,  default: 0 },
    marginUsed:  { type: Number,  default: 0 },
    openTime:    { type: Date,    default: Date.now },
    score:       { type: Number,  default: 0 },
    timeframe:   { type: String,  default: '15m' },
    orderType:   { type: String,  default: 'MARKET' },
    tp2Hit:      { type: Boolean, default: false },
    dcaLevel:    { type: Number,  default: 0 },
    fillPrice:   { type: Number,  default: 0 },
    closedAt:    { type: Date,    default: null },
    tp3:         { type: Number,  default: 0 },
});


// ─────────────────────────────────────────────────────────────────
//  5. WHATSAPP LINK TOKEN SCHEMA  ← NEW
//  Short-lived token generated in the web portal, consumed by the
//  WhatsApp .link command.  TTL index auto-deletes expired docs.
// ─────────────────────────────────────────────────────────────────
const LinkTokenSchema = new mongoose.Schema({
    token:     { type: String, required: true, unique: true },   // e.g. "LINK-A3F9B2"
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'SaasUser', required: true },
    createdAt: { type: Date, default: Date.now, expires: 900 },  // auto-delete after 15 min
});

// ─────────────────────────────────────────────────────────────────
//  MODELS  (hot-reload safe — guard against OverwriteModelError)
// ─────────────────────────────────────────────────────────────────
const Settings   = mongoose.models.Settings   || mongoose.model('Settings',   SettingsSchema);
const WaUser     = mongoose.models.WaUser     || mongoose.model('WaUser',     WaUserSchema);
const SaasUser   = mongoose.models.SaasUser   || mongoose.model('SaasUser',   SaasUserSchema);
const Trade      = mongoose.models.Trade      || mongoose.model('Trade',      TradeSchema);
const LinkToken  = mongoose.models.LinkToken  || mongoose.model('LinkToken',  LinkTokenSchema);

// ─────────────────────────────────────────────────────────────────
//  CONNECTION
// ─────────────────────────────────────────────────────────────────
async function connect() {
    if (mongoose.connection.readyState === 0) {
        await mongoose.connect(config.MONGODB || 'mongodb://localhost/whatsapp-bot', {
            useNewUrlParser: true, useUnifiedTopology: true,
        });
        console.log('✅ Database Connected Successfully!');
    }
}

// ─────────────────────────────────────────────────────────────────
//  SETTINGS  (unchanged)
// ─────────────────────────────────────────────────────────────────
async function getSettings() {
    await connect();
    let s = await Settings.findOne({ id: 'bot_settings' });
    if (!s) s = await Settings.create({ id: 'bot_settings' });
    return s;
}
async function updateSettings(updates) {
    await connect();
    return await Settings.findOneAndUpdate({ id: 'bot_settings' }, updates, { new: true, upsert: true });
}

// ─────────────────────────────────────────────────────────────────
//  WA-USER FUNCTIONS  (unchanged)
// ─────────────────────────────────────────────────────────────────
async function getUser(jid) {
    await connect();
    let u = await WaUser.findOne({ jid });
    if (!u) u = await WaUser.create({ jid });
    return u;
}
async function getMargin(jid)          { return (await getUser(jid)).margin; }
async function setMargin(jid, amount)  {
    await connect();
    await WaUser.findOneAndUpdate({ jid }, { margin: amount }, { upsert: true });
}
async function updatePaperBalance(jid, pnlAmount, isWin, isBreakEven = false) {
    await connect();
    const u = await getUser(jid);
    u.paperBalance += pnlAmount;
    u.paperTrades  += 1;
    if      (isWin)        u.paperWins   += 1;
    else if (!isBreakEven) u.paperLosses += 1;
    await u.save();
    return u;
}
async function setPaperCapital(jid, amount) {
    await connect();
    const u = await getUser(jid);
    u.paperBalance = amount; u.paperStartBalance = amount;
    u.paperTrades = 0; u.paperWins = 0; u.paperLosses = 0;
    await u.save();
    return u;
}

// ─────────────────────────────────────────────────────────────────
//  SAAS USER FUNCTIONS  ← NEW
// ─────────────────────────────────────────────────────────────────

/** Create a new SaaS platform user. data = { username, email, passwordHash, role? } */
async function createSaasUser(data) {
    await connect();
    return await SaasUser.create({
        username: data.username, email: data.email.toLowerCase().trim(),
        passwordHash: data.passwordHash, role: data.role || 'user',
    });
}

/** Find SaaS user by email (for login). */
async function findSaasUserByEmail(email) {
    await connect();
    return await SaasUser.findOne({ email: email.toLowerCase().trim() });
}

/** Find SaaS user by username. */
async function findSaasUserByUsername(username) {
    await connect();
    return await SaasUser.findOne({ username: username.trim() });
}

/** Get SaaS user by Mongoose _id. */
async function getSaasUserById(id) {
    await connect();
    return await SaasUser.findById(id);
}

/** Record successful login. */
async function recordSaasLogin(userId) {
    await connect();
    await SaasUser.findByIdAndUpdate(userId, { lastLoginAt: new Date(), $inc: { loginCount: 1 } });
}

/** Admin: list all users (paginated, passwords stripped). */
async function listSaasUsers(page = 1, limit = 50) {
    await connect();
    const skip = (page - 1) * limit;
    const [users, total] = await Promise.all([
        SaasUser.find({}, '-passwordHash -apiKeys').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        SaasUser.countDocuments(),
    ]);
    return { users, total, page, pages: Math.ceil(total / limit) };
}

/** Admin: update user accountStatus ('active' | 'suspended'). */
async function setSaasUserStatus(userId, status) {
    await connect();
    return await SaasUser.findByIdAndUpdate(userId, { accountStatus: status }, { new: true });
}

/** Add encrypted API key. encApiKey and encSecretKey must be pre-encrypted. */
async function addUserApiKey(userId, keyEntry) {
    await connect();
    return await SaasUser.findByIdAndUpdate(userId, { $push: { apiKeys: keyEntry } }, { new: true });
}

/** Remove API key by sub-doc _id. */
async function removeUserApiKey(userId, keyId) {
    await connect();
    return await SaasUser.findByIdAndUpdate(userId, { $pull: { apiKeys: { _id: keyId } } }, { new: true });
}

// ─────────────────────────────────────────────────────────────────
//  TRADE FUNCTIONS  (all unchanged — userId stored if provided)
// ─────────────────────────────────────────────────────────────────
async function saveTrade(data)  { await connect(); return await new Trade(data).save(); }
async function closeTrade(id, result, pnlPct, paperProfit = 0) {
    await connect();
    return await Trade.findByIdAndUpdate(id, { status:'closed', result, pnlPct, paperProfit, closedAt: new Date() });
}
async function getActiveTrades(jid) {
    await connect();
    return await Trade.find({ userJid: jid, status: { $in: ['active','pending'] }, isPaper: false });
}
async function getActivePaperTrades(jid) {
    await connect();
    return await Trade.find({ userJid: jid, status: { $in: ['active','pending'] }, isPaper: true });
}
async function deleteTrade(id) {
    await connect();
    try { return (await Trade.findByIdAndDelete(id)) != null; } catch { return false; }
}

/** NEW: Active trades owned by a SaaS userId. */
async function getSaasUserActiveTrades(userId) {
    await connect();
    return await Trade.find({ userId, status: { $in: ['active','pending'] } }).lean();
}

/** NEW: Closed trade history for a SaaS user (newest first). */
async function getSaasUserTradeHistory(userId, limit = 50) {
    await connect();
    return await Trade.find({ userId, status: 'closed' }).sort({ closedAt: -1 }).limit(limit).lean();
}

async function getTradeStats(jid) {
    await connect();
    const activeTrades = await Trade.countDocuments({ userJid: jid, status: { $in: ['active','pending'] }, isPaper: false });
    const closedTrades = await Trade.find({ userJid: jid, status: 'closed', isPaper: false }).sort({ _id: -1 });
    let wins=0, losses=0, totalPnl=0, best=null, worst=null;
    let currentStreakType=null, currentStreakCount=0, maxStreak=0, recent=[];
    for (let i = 0; i < closedTrades.length; i++) {
        const t = closedTrades[i];
        if (recent.length < 5) {
            const ri = t.result==='WIN' ? '🟢' : t.result==='LOSS' ? '🔴' : '⚪';
            const ps = t.pnlPct ? (t.pnlPct>0?'+':'')+t.pnlPct.toFixed(2)+'%' : '';
            recent.push(`${ri} ${t.coin} (${t.direction}) ${ps}`);
        }
        if (t.result==='WIN') wins++; else if (t.result==='LOSS') losses++;
        const pnl = t.pnlPct || 0; totalPnl += pnl;
        if (!best  || pnl > best.pnlPct)  best  = t;
        if (!worst || pnl < worst.pnlPct) worst = t;
        if (i===0) currentStreakType = t.result;
        if (t.result===currentStreakType && currentStreakType==='WIN') {
            currentStreakCount++; if (currentStreakCount>maxStreak) maxStreak=currentStreakCount;
        } else if (t.result==='WIN') { currentStreakType='WIN'; currentStreakCount=1; }
        else { currentStreakType=t.result; currentStreakCount=0; }
    }
    const totalClosed = wins+losses;
    return {
        active: activeTrades, total: closedTrades.length, wins, losses,
        winRate: totalClosed>0 ? ((wins/totalClosed)*100).toFixed(2) : 0,
        totalPnl: totalPnl.toFixed(2), best, worst,
        currentStreak: currentStreakCount>0?'WIN':(losses>0?'LOSS':'NONE'),
        maxStreak, recent,
    };
}

async function getFundingRate(coin) {
    try {
        const axios = require('axios');
        const res = await axios.get(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${coin}&limit=1`);
        if (res.data?.length > 0) {
            const rate  = parseFloat(res.data[0].fundingRate) * 100;
            const emoji = rate > 0.05 ? '🔴' : rate < -0.05 ? '🟢' : '⚪';
            return `${emoji} ${rate.toFixed(4)}% (${rate>0.05?'Longs pay Shorts':rate<-0.05?'Shorts pay Longs':'Neutral'})`;
        }
        return 'N/A';
    } catch { return 'N/A'; }
}


// ─────────────────────────────────────────────────────────────────
//  WHATSAPP LINK TOKEN FUNCTIONS  ← NEW
// ─────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random linking token and store it.
 * Returns the token string (e.g. "LINK-A3F9B2").
 * Deletes any existing unused token for this user first.
 */
async function createLinkToken(userId) {
    await connect();
    // Remove any old token this user may have
    await LinkToken.deleteMany({ userId });
    const token = 'LINK-' + require('crypto').randomBytes(3).toString('hex').toUpperCase();
    await LinkToken.create({ token, userId });
    return token;
}

/**
 * Consume a link token — find it, link the WhatsApp JID to the user,
 * then delete the token so it can't be reused.
 * Returns the updated SaasUser or null if token is invalid/expired.
 */
async function consumeLinkToken(token, whatsappJid) {
    await connect();
    const doc = await LinkToken.findOne({ token: token.trim().toUpperCase() });
    if (!doc) return null;   // expired or never existed
    // Save JID to the SaasUser
    const user = await SaasUser.findByIdAndUpdate(
        doc.userId,
        { whatsappJid, whatsappLinkedAt: new Date() },
        { new: true }
    );
    // Burn the token — one use only
    await LinkToken.deleteOne({ _id: doc._id });
    return user;
}

/**
 * Find a SaasUser by their linked WhatsApp JID.
 */
async function getSaasUserByWhatsapp(whatsappJid) {
    await connect();
    return await SaasUser.findOne({ whatsappJid });
}

/**
 * Unlink a WhatsApp number from a SaaS user account.
 */
async function unlinkWhatsapp(userId) {
    await connect();
    return await SaasUser.findByIdAndUpdate(
        userId,
        { whatsappJid: null, whatsappLinkedAt: null },
        { new: true }
    );
}

// ─────────────────────────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────────────────────────

async function setTradingMode(userId, mode) {
    await connect();
    await SaasUser.findByIdAndUpdate(userId, { tradingMode: mode });
}
module.exports = {
    connect, connectDB: connect,
    getSettings, updateSettings,
    // WA users (original API — 100% backward compat)
    getUser, getMargin, setMargin, saveMargin: setMargin,
    updatePaperBalance, setPaperCapital,
    // Trades
    saveTrade, closeTrade, getActiveTrades, getActivePaperTrades,
    deleteTrade, getTradeStats, getFundingRate,
    // ── NEW: SaaS users
    createSaasUser, findSaasUserByEmail, findSaasUserByUsername,
    getSaasUserById, recordSaasLogin, listSaasUsers, setSaasUserStatus,
    addUserApiKey, removeUserApiKey,
    // ── NEW: SaaS trades
    getSaasUserActiveTrades, getSaasUserTradeHistory,
    // ── NEW: WhatsApp linking
    createLinkToken,
    consumeLinkToken,
    getSaasUserByWhatsapp,
    unlinkWhatsapp,
    setTradingMode,

    // Models
    Trade, WaUser, SaasUser, LinkToken,
    User: WaUser,  // ← backward-compat alias (old code used db.User)
};
