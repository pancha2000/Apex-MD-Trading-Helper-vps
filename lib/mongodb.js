const mongoose = require('mongoose');
const config = require('../config');

// Bot Settings Schema
const BotSchema = new mongoose.Schema({
    id: { type: String, unique: true, required: true },
    prefix: { type: String, default: '.' },
    mode: { type: String, default: 'public' },
    aliveMsg: { type: String, default: 'Bot is Alive!' },
    aliveImg: { type: String, default: '' }
});

const BotModel = mongoose.model('BotSettings', BotSchema);
let botData = {};

async function connectDB() {
    try {
        let dbUrl = config.MONGODB;

        // Auto Reset On නම්, හැම පාරම අලුත් නමක් හදමු
        if (config.AUTO_RESET_DB === 'true') {
            const randomID = Math.floor(Math.random() * 10000);
            const newDBName = `APEX_SESSION_${randomID}`;
            
            // URL එකේ තියෙන පරණ නම අයින් කරලා අලුත් නම දානවා
            if (dbUrl.includes('?')) {
                // Query params තියෙනවනම් ඊට කලින් නම ඔබනවා
                dbUrl = dbUrl.replace(/\/[^/?]*(\?|$)/, `/${newDBName}$1`);
            } else {
                // නිකන්ම අන්තිමට නම එකතු කරනවා
                dbUrl = dbUrl.endsWith('/') ? dbUrl + newDBName : dbUrl + '/' + newDBName;
            }
            console.log(`🔄 Auto Reset ON: Creating new DB -> ${newDBName}`);
        }

        await mongoose.connect(dbUrl);
        console.log('🗄️ MongoDB Connected Successfully ✅');

        // Settings Load කිරීම
        let settings = await BotModel.findOne({ id: 'apex_md' });
        if (!settings) {
            settings = await BotModel.create({ id: 'apex_md' });
        }
        botData = settings;

    } catch (err) {
        console.error('❌ MongoDB Error:', err.message);
    }
}

async function readEnv() {
    try {
        const settings = await BotModel.findOne({ id: 'apex_md' });
        if (settings) botData = settings;
    } catch (e) {
        console.log("Env Read Error");
    }
}

function getBotSettings() {
    return botData;
}

module.exports = { connectDB, readEnv, getBotSettings };
