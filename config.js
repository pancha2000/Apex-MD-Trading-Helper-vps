const fs = require('fs');

// Load .env file
if (fs.existsSync('./config.env')) {
    require('dotenv').config({ path: './config.env' });
}

// Optimized Configuration
const config = {
    SESSION_ID: process.env.SESSION_ID || "",
    BOT_NAME: process.env.BOT_NAME || "CRYPTO AI BOT",
    VERSION: "1.0.0",
    
    // Database
    MONGODB: process.env.MONGODB || "",
    
    // Bot Settings
    PREFIX: process.env.PREFIX || ".",
    MODE: process.env.MODE || "public", 
    
    // Owner Info
    OWNER_NAME: process.env.OWNER_NAME || "Owner",
    OWNER_NUMBER: process.env.OWNER_NUMBER || "",
    SUDO: process.env.SUDO || "",
    
    // API Keys (ඉතා වැදගත්)
    GEMINI_API: process.env.GEMINI_API || "",
    BINANCE_API: process.env.BINANCE_API || "", // 👈 අලුතින් එකතු කළ Binance Key එක
    GROQ_API: process.env.GROQ_API || "",
    
    // Optional API Keys
    LUNAR_API: process.env.LUNAR_API || null,      // Social volume signals
    
    // Check Owner Function
    isOwner: (sender) => {
        const ownerNum = process.env.OWNER_NUMBER || "";
        const sudoNums = process.env.SUDO || "";
        const senderNum = sender.split('@')[0];
        return senderNum === ownerNum || sudoNums.includes(senderNum);
    }
};

module.exports = config;
