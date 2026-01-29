const mongoose = require('mongoose');
const config = require('../config');

// සියලුම පරණ Schema Fields එලෙසම ඇත
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
let isConnected = false; // සම්බන්ධතාවය පරීක්ෂා කිරීමට

async function connectDB() {
    if (isConnected) return; // දැනටමත් සම්බන්ධ වී ඇත්නම් නැවත සම්බන්ධ නොවේ

    try {
        let dbUrl = config.MONGODB;

        if (config.AUTO_RESET_DB === 'true') {
            const randomID = Math.floor(Math.random() * 10000);
            const newDBName = `APEX_SESSION_${randomID}`;
            
            if (dbUrl.includes('?')) {
                dbUrl = dbUrl.replace(/\/[^/?]*(\?|$)/, `/${newDBName}$1`);
            } else {
                dbUrl = dbUrl.endsWith('/') ? dbUrl + newDBName : dbUrl + '/' + newDBName;
            }
            console.log(`🔄 [DB-RESET] Target DB: ${newDBName}`);
        }

        await mongoose.connect(dbUrl, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });
        
        isConnected = true;
        console.log('🗄️ MongoDB Connected ✅');

        let settings = await BotModel.findOne({ id: 'apex_md' });
        if (!settings) {
            settings = await BotModel.create({ id: 'apex_md' });
        }
        botData = settings;

    } catch (err) {
        console.error('❌ MongoDB Connection Error:', err.message);
    }
}

async function readEnv() {
    try {
        const settings = await BotModel.findOne({ id: 'apex_md' });
        if (settings) botData = settings;
    } catch (e) {
        console.log("Database Read Error");
    }
}

function getBotSettings() {
    return botData;
}

module.exports = { connectDB, readEnv, getBotSettings, BotModel };
