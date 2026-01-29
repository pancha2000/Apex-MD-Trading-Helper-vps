const fs = require('fs');
if (fs.existsSync('config.env')) require('dotenv').config({ path: './config.env' });

module.exports = {
    // =================== අනිවාර්යයෙන් පිරවිය යුතුයි ===================
    SESSION_ID: process.env.SESSION_ID || "ඔයාගේ_නව_සෙෂන්_ID_එක",
    MONGODB: process.env.MONGODB || "mongodb+srv://realpancha:2006.Shehan@cluster0.jh6kzmp.mongodb.net/APEX_NEW?retryWrites=true&w=majority",
    
    // =================== බොට්ගේ තොරතුරු ============================
    PREFIX: process.env.PREFIX || ".",
    MODE: process.env.MODE || "public",
    OWNER_NAME: process.env.OWNER_NAME || "Shehan Vimukthi",
    OWNER_CONTACT: process.env.OWNER_CONTACT || "94701391585",
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || "AIzaSyCItRq9qKhyDo5ZjO_ZBtRC1Z-Y3UD9Ma0",
    
    // =================== Alive තොරතුරු ==============================
    ALIVE_IMG: process.env.ALIVE_IMG || "https://telegra.ph/file/ad25b2227fa2a1a01b707.jpg",
    ALIVE_MSG: process.env.ALIVE_MSG || "I am APEX-MD, always ready to help! ✅"
};
