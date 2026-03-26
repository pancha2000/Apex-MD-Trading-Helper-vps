'use strict';
/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD  ·  models/BotStatus.js
 *  ──────────────────────────────────────────────────────────────
 *  Single-document collection that replaces _bot_status.json.
 *  Eliminates file-lock race conditions between ApexBot & ApexDash.
 *
 *  Collection contains exactly ONE document (id: 'singleton').
 *  Both PM2 processes share it via MongoDB — atomic, no file I/O.
 * ════════════════════════════════════════════════════════════════
 */

const mongoose = require('mongoose');

const BotStatusSchema = new mongoose.Schema({
    _id:       { type: String,  default: 'singleton' },
    online:    { type: Boolean, default: false },
    updatedAt: { type: Date,    default: Date.now },
}, {
    collection:  'botstatus',
    versionKey:  false,
    timestamps:  false,
});

const BotStatus = mongoose.models.BotStatus
    || mongoose.model('BotStatus', BotStatusSchema);

module.exports = BotStatus;
