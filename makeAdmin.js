require('dotenv').config({ path: './config.env' });
const mongoose = require('mongoose');
const config = require('./config');
const db = require('./lib/database');

async function makeAdmin() {
    try {
        // Database Link එක හොයාගන්නවා
        const mongoURI = process.env.MONGODB_URI || process.env.MONGO_URL || process.env.DATABASE_URL || config.MONGODB_URI;
        
        if (!mongoURI) {
            console.log('❌ Database URL එක හොයාගන්න බැරි වුණා!');
            process.exit(1);
        }

        console.log('⏳ Connecting to Database...');
        
        // කෙලින්ම Database එකට කනෙක්ට් වෙනවා
        await mongoose.connect(mongoURI);
        console.log('✅ Database Connected Successfully!');

        // 🚨 පහළ තියෙන නම ඔයාගේ වෙබ්සයිට් එකේ Username එකට වෙනස් කරන්න 🚨
        const usernameToPromote = 'ඔයාගේ_Username_එක_මෙතන_ගහන්න'; 
        
        const user = await db.User.findOne({ username: usernameToPromote });
        
        if (!user) {
            console.log(`❌ User '${usernameToPromote}' not found! නම හරියටම දුන්නද බලන්න.`);
            process.exit(1);
        }
        
        user.role = 'admin';
        await user.save();
        
        console.log(`👑 Success! ${usernameToPromote} is now a SUPER ADMIN! 🔥`);
        
        // වැඩේ ඉවර වුණාම කනෙක්ෂන් එක ක්ලෝස් කරනවා
        await mongoose.disconnect();
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

makeAdmin();
