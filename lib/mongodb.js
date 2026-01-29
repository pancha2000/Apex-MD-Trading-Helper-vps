const mongoose = require('mongoose');
const config = require('../config');

// ඩේටාබේස් එකේ සෙටින්ග්ස් සේව් කරන ආකෘතිය (Schema) - කිසිවක් අඩු කර නැත
const BotSchema = new mongoose.Schema({
    id: { type: String, unique: true, required: true },
    prefix: { type: String, default: '.' },
    mode: { type: String, default: 'public' },
    aliveMsg: { type: String, default: 'Bot is Alive!' },
    aliveImg: { type: String, default: '' },
    autoRead: { type: Boolean, default: false },
    autoStatusRead: { type: Boolean, default: false }
});

const BotModel = mongoose.model('BotSettings', BotSchema);
let botData = {};

/**
 * MongoDB සම්බන්ධ කිරීමේ ශ්‍රිතය
 * AUTO_RESET_DB පරීක්ෂා කර අලුත් DB එකක් සාදයි
 */
async function connectDB() {
    try {
        let dbUrl = config.MONGODB;

        // config.js එකේ AUTO_RESET_DB "true" නම් පමණක් ක්‍රියාත්මක වේ
        if (config.AUTO_RESET_DB === 'true') {
            const randomID = Math.floor(Math.random() * 10000);
            const newDBName = `APEX_SESSION_${randomID}`;
            
            // පවතින URL එකට අලුත් DB නමක් එකතු කිරීම
            if (dbUrl.includes('?')) {
                dbUrl = dbUrl.replace(/\/[^/?]*(\?|$)/, `/${newDBName}$1`);
            } else {
                dbUrl = dbUrl.endsWith('/') ? dbUrl + newDBName : dbUrl + '/' + newDBName;
            }
            console.log(`🔄 [DB-RESET] Creating new isolated database: ${newDBName}`);
        }

        await mongoose.connect(dbUrl);
        console.log('🗄️ MongoDB Connected Successfully ✅');

        // මුලින්ම සෙටින්ග්ස් තිබේදැයි පරීක්ෂා කර ලෝඩ් කිරීම
        let settings = await BotModel.findOne({ id: 'apex_md' });
        if (!settings) {
            settings = await BotModel.create({ id: 'apex_md' });
        }
        botData = settings;

    } catch (err) {
        console.error('❌ MongoDB Connection Error:', err.message);
    }
}

/**
 * පද්ධති සෙටින්ග්ස් (Environment) කියවීම
 */
async function readEnv() {
    try {
        const settings = await BotModel.findOne({ id: 'apex_md' });
        if (settings) {
            botData = settings;
        }
    } catch (e) {
        console.log("❌ Error reading Database Env");
    }
}

/**
 * දැනට පවතින සෙටින්ග්ස් අනෙකුත් ෆයිල් වලට ලබා දීම
 */
function getBotSettings() {
    return botData;
}

module.exports = { connectDB, readEnv, getBotSettings, BotModel };
