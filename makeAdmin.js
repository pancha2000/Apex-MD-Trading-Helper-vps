const mongoose = require('mongoose');
// db ෆයිල් එක ලෝඩ් කරගන්නවා
const db = require('./lib/database'); 

async function makeAdmin() {
    try {
        // 🚨 1. මෙතනට ඔයාගේ ඇත්තම MongoDB URL එක දාන්න (Quotes ඇතුළේ) 🚨
        const mongoURI = 'mongodb+srv://realpancha:2006.Shehan@cluster0.jh6kzmp.mongodb.net/APEX_V4?retryWrites=true&w=majority'; 
        
        console.log('⏳ Connecting to Database...');
        
        // කෙලින්ම Database එකට කනෙක්ට් වෙනවා
        await mongoose.connect(mongoURI);
        console.log('✅ Database Connected Successfully!');

        // 🚨 2. පහළ තියෙන නම ඔයාගේ වෙබ්සයිට් එකේ Username එකට වෙනස් කරන්න 🚨
        const usernameToPromote = 'shehan_vimukthi'; 
        
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
