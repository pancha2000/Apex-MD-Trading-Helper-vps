require('dotenv').config({ path: './config.env' }); // Database passwords ලෝඩ් කරනවා
const config = require('./config');
const db = require('./lib/database');

async function makeAdmin() {
    try {
        console.log('⏳ Connecting to Database... (තත්පර 3ක් ඉන්න)');
        
        // Database එක කනෙක්ට් වෙනකන් තත්පර 3ක් ඉන්නවා
        await new Promise(resolve => setTimeout(resolve, 3000));

        // 🚨 පහළ තියෙන නම වෙනස් කරන්න 🚨
        const usernameToPromote = 'shehan_vimukthi'; 
        
        const user = await db.User.findOne({ username: usernameToPromote });
        
        if (!user) {
            console.log(`❌ User '${usernameToPromote}' not found! නම හරියටම දුන්නද බලන්න.`);
            process.exit(1);
        }
        
        user.role = 'admin';
        await user.save();
        
        console.log(`✅ Success! ${usernameToPromote} is now a SUPER ADMIN! 🔥`);
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

makeAdmin();
