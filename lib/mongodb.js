const mongoose = require('mongoose');
const config = require('../config');

// Bot Settings සඳහා Schema එක
const BotSchema = new mongoose.Schema({
    id: { type: String, unique: true, required: true },
    prefix: { type: String, default: '.' },
    mode: { type: String, default: 'public' },
    aliveMsg: { type: String, default: 'I am alive now! ✅' },
    aliveImg: { type: String, default: 'https://telegra.ph/file/ad25b2227fa2a1a01b707.jpg' }
});

const BotModel = mongoose.model('BotSettings', BotSchema);

let botData = {};

/**
 * MongoDB වෙත සම්බන්ධ වීම
 */
async function connectDB() {
    try {
        await mongoose.connect(config.MONGODB);
        console.log('🗄️ MongoDB Connected Successfully ✅');
        
        // මුලින්ම settings ලෝඩ් කරගමු
        let settings = await BotModel.findOne({ id: 'apex_md' });
        if (!settings) {
            settings = await BotModel.create({ id: 'apex_md' });
        }
        botData = settings;
    } catch (err) {
        console.error('❌ MongoDB Connection Error:', err.message);
        // Database නැතුව වුණත් බොට් වැඩ කරන්න default settings දාමු
        botData = { prefix: config.PREFIX, mode: config.MODE };
    }
}

/**
 * Settings කියවීමට
 */
async function readEnv() {
    const settings = await BotModel.findOne({ id: 'apex_md' });
    if (settings) botData = settings;
}

/**
 * දැනට තියෙන Settings ලබා ගැනීමට
 */
function getBotSettings() {
    return botData;
}

/**
 * Settings Update කිරීමට (උදා: .setprefix වැනි විධානයන් සඳහා)
 */
async function updateSetting(key, value) {
    botData[key] = value;
    await BotModel.updateOne({ id: 'apex_md' }, { [key]: value });
}

module.exports = { connectDB, readEnv, getBotSettings, updateSetting };
