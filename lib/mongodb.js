const mongoose = require('mongoose');
const config = require('../config');

// ඔයාගේ පරණ Schema එකේ තිබුණු කිසිම field එකක් අයින් කර නැත
const BotSchema = new mongoose.Schema({
    id: { type: String, unique: true, required: true },
    prefix: { type: String, default: '.' },
    mode: { type: String, default: 'public' },
    aliveMsg: { type: String, default: 'Bot is Alive!' },
    aliveImg: { type: String, default: '' },
    autoRead: { type: Boolean, default: false },
    autoStatusRead: { type: Boolean, default: false },
    antiDelete: { type: Boolean, default: false },
    antiCall: { type: Boolean, default: false }
});

const BotModel = mongoose.model('BotSettings', BotSchema);
let botData = {};

async function connectDB() {
    try {
        let dbUrl = config.MONGODB;

        // Auto Reset පාලනය
        if (config.AUTO_RESET_DB === 'true') {
            const randomID = Math.floor(Math.random() * 10000);
            const newDBName = `APEX_SESSION_${randomID}`;
            
            if (dbUrl.includes('?')) {
                dbUrl = dbUrl.replace(/\/[^/?]*(\?|$)/, `/${newDBName}$1`);
            } else {
                dbUrl = dbUrl.endsWith('/') ? dbUrl + newDBName : dbUrl + '/' + newDBName;
            }
            console.log(`🔄 [DB-RESET] Switched to new DB: ${newDBName}`);
        }

        await mongoose.connect(dbUrl);
        console.log('🗄️ MongoDB Connected ✅');

        let settings = await BotModel.findOne({ id: 'apex_md' });
        if (!settings) {
            settings = await BotModel.create({ id: 'apex_md' });
        }
        botData = settings;

    } catch (err) {
        console.error('❌ Connection Error:', err.message);
    }
}

// පරණ readEnv function එක එලෙසම ඇත
async function readEnv() {
    try {
        const settings = await BotModel.findOne({ id: 'apex_md' });
        if (settings) botData = settings;
    } catch (e) {
        console.log("Env Error");
    }
}

function getBotSettings() {
    return botData;
}

module.exports = { connectDB, readEnv, getBotSettings, BotModel };
