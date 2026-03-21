'use strict';
/**
 * makeAdmin.js — Promote user to admin by email
 * Usage: node makeAdmin.js
 */

require('dotenv').config({ path: './config.env' });
const mongoose = require('mongoose');

// ─── Protected permanent admin ───────────────────────────────────
const TARGET_EMAIL = 'cdilrukshi52@gmail.com';

const SaasUserSchema = new mongoose.Schema({
    username:      String,
    email:         String,
    passwordHash:  String,
    role:          { type: String, enum: ['user', 'admin'], default: 'user' },
    accountStatus: { type: String, enum: ['active', 'suspended', 'pending'], default: 'active' },
    tier:          { type: String, enum: ['free', 'vip'], default: 'free' },
    apiKeys:       { type: Array, default: [] },
    createdAt:     { type: Date,  default: Date.now },
    lastLoginAt:   Date,
    loginCount:    Number,
});

async function main() {
    const MONGO_URI = process.env.MONGODB;
    if (!MONGO_URI) { console.error('❌ MONGODB not found in config.env'); process.exit(1); }

    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected.\n');

    const SaasUser = mongoose.models.SaasUser || mongoose.model('SaasUser', SaasUserSchema);

    const user = await SaasUser.findOne({ email: TARGET_EMAIL });
    if (!user) {
        console.error(`❌ Email "${TARGET_EMAIL}" not found.`);
        console.error('   First register at /auth/register with this email.');
        await mongoose.disconnect(); process.exit(1);
    }

    console.log(`👤 Found: ${user.username} (${user.email})`);
    console.log(`   Role: ${user.role} → admin`);

    user.role          = 'admin';
    user.accountStatus = 'active';
    user.tier          = 'vip';
    await user.save();

    console.log(`\n🎉 SUCCESS — "${user.username}" is now Permanent Admin + VIP!`);
    console.log('   Login at /auth/login → /admin/');
    await mongoose.disconnect();
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    mongoose.disconnect().finally(() => process.exit(1));
});
