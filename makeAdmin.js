const db = require('./lib/database'); // Database එකට කනෙක්ට් වීම

async function makeAdmin() {
    try {
        // මෙතන ඔයාගේ නම දෙන්න (උදා: 'apex_owner')
        const usernameToPromote = 'shehan_vimukthi'; 
        
        const user = await db.User.findOne({ username: usernameToPromote });
        
        if (!user) {
            console.log('❌ User not found! නම හරියටම දුන්නද බලන්න.');
            process.exit(1);
        }
        
        user.role = 'admin'; // Role එක Admin කිරීම
        await user.save();
        
        console.log(`✅ Success! ${usernameToPromote} is now a SUPER ADMIN! 🔥`);
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

makeAdmin();
