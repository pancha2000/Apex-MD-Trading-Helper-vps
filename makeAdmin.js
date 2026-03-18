'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  makeAdmin.js  —  One-time Super Admin promotion script
 *  ──────────────────────────────────────────────────────────────
 *  Usage:
 *    node makeAdmin.js
 *
 *  What it does:
 *    1. Loads MONGODB URI from config.env (same as the main bot)
 *    2. Connects to MongoDB
 *    3. Finds the SaasUser with username "shehan_vimukthi"
 *    4. Sets role → 'admin'  and  accountStatus → 'active'
 *    5. Prints the result and disconnects cleanly
 *
 *  Safe to re-run — idempotent (already-admin stays admin).
 * ════════════════════════════════════════════════════════════════
 */

require('dotenv').config({ path: './config.env' });

const mongoose = require('mongoose');

// ─── Target username ────────────────────────────────────────────
const TARGET_USERNAME = 'shehan_vimukthi';

// ─── Inline SaasUser schema (mirrors lib/database.js exactly) ───
// We define it here so this script has zero dependency on the bot's
// other modules — safe to run even if config.js has issues.
const SaasUserSchema = new mongoose.Schema({
    username:      String,
    email:         String,
    passwordHash:  String,
    role:          { type: String, enum: ['user', 'admin'], default: 'user' },
    accountStatus: { type: String, enum: ['active', 'suspended', 'pending'], default: 'active' },
    apiKeys:       { type: Array,  default: [] },
    createdAt:     { type: Date,   default: Date.now },
    lastLoginAt:   Date,
    loginCount:    Number,
    displayName:   String,
    timezone:      String,
});

async function main() {
    const MONGO_URI = process.env.MONGODB;

    if (!MONGO_URI) {
        console.error('❌  MONGODB variable not found in config.env');
        console.error('    Make sure config.env is in the same folder as makeAdmin.js');
        process.exit(1);
    }

    console.log('🔌  Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI, {
        useNewUrlParser:    true,
        useUnifiedTopology: true,
    });
    console.log('✅  Connected.\n');

    // Use existing model if already registered (hot-reload safety), else create
    const SaasUser = mongoose.models.SaasUser || mongoose.model('SaasUser', SaasUserSchema);

    // ── Find the target user ──────────────────────────────────────
    const user = await SaasUser.findOne({ username: TARGET_USERNAME });

    if (!user) {
        console.error(`❌  User "${TARGET_USERNAME}" not found in the SaasUser collection.`);
        console.error('    Make sure you registered with that exact username at /auth/register');
        await mongoose.disconnect();
        process.exit(1);
    }

    console.log('👤  Found user:');
    console.log(`    Username : ${user.username}`);
    console.log(`    Email    : ${user.email}`);
    console.log(`    Role     : ${user.role}  →  admin`);
    console.log(`    Status   : ${user.accountStatus}  →  active\n`);

    // ── Promote ───────────────────────────────────────────────────
    if (user.role === 'admin') {
        console.log('ℹ️   Already admin — no changes needed.');
    } else {
        user.role          = 'admin';
        user.accountStatus = 'active';
        await user.save();
        console.log(`🎉  SUCCESS — "${TARGET_USERNAME}" is now Super Admin!`);
        console.log('    Log in at /auth/login and go to /admin/ to access the panel.');
    }

    await mongoose.disconnect();
    console.log('\n🔌  Disconnected from MongoDB. Done.');
}

main().catch(err => {
    console.error('❌  Unexpected error:', err.message);
    mongoose.disconnect().finally(() => process.exit(1));
});
