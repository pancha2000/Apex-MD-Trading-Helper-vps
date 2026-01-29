const fs = require('fs');
if (fs.existsSync('config.env')) {
    require('dotenv').config({ path: './config.env' });
}

module.exports = {
    // =================== Bot Info ===============================
    SESSION_ID: process.env.SESSION_ID || "nuYCSZQA#Pc_Upj0_WJMv_KbrsVH1mVSxTxkvFavKilM1B6vlQLQ",
    MONGODB: process.env.MONGODB || "mongodb+srv://realpancha:2006.Shehan@cluster0.jh6kzmp.mongodb.net/APEX_V4?retryWrites=true&w=majority",
    
    // =================== Settings ===============================
    PREFIX: process.env.PREFIX || ".",
    MODE: process.env.MODE || "public",
    
    // =================== Owner Info =============================
    OWNER_NAME: process.env.OWNER_NAME || "Shehan Vimukthi",
    OWNER_CONTACT: process.env.OWNER_CONTACT || "94701391585", // wa.me කෑල්ල අයින් කරන්න
    
    // =================== Other =================================
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || "AIzaSyCItRq9qKhyDo5ZjO_ZBtRC1Z-Y3UD9Ma0",
    ALIVE_IMG: process.env.ALIVE_IMG || "https://telegra.ph/file/ad25b2227fa2a1a01b707.jpg",
    ALIVE_MSG: process.env.ALIVE_MSG || "*BOT IS RUNNING SUCCESSFULLY* ✅"
    // =================== Control Panel ==========================
    // බොට් Restart වෙන හැම පාරම Database එක අලුත් කරගන්න (true/false)
    AUTO_RESET_DB: process.env.AUTO_RESET_DB || "true",
    
    // Terminal එකේ මැසේජ් විස්තර පෙන්වන්න (true/false)
    DEBUG_MODE: process.env.DEBUG_MODE || "true",

};
