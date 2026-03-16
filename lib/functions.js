const { getContentType, downloadMediaMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');

/**
 * Message serialize කරන function
 */
async function serialize(msg, conn) {
    // ✅ VALIDATION: Check if msg exists
    if (!msg || typeof msg !== 'object') {
        return null;
    }
    
    // ✅ VALIDATION: Check if msg has key
    if (!msg.key || typeof msg.key !== 'object') {
        return null;
    }
    
    // ✅ VALIDATION: Check remoteJid exists
    if (!msg.key.remoteJid || typeof msg.key.remoteJid !== 'string') {
        console.log('⚠️  Invalid message in serialize - no remoteJid');
        return null;
    }
    
    // Message එකේ type එක හොයන්න
    const type = getContentType(msg.message);
    const m = {};

    // Basic info
    m.key = msg.key;
    m.from = m.key.remoteJid;
    m.fromMe = m.key.fromMe;
    m.id = m.key.id;
    m.isGroup = m.from.endsWith('@g.us');
    m.sender = jidNormalizedUser(m.fromMe ? conn.user.id : m.isGroup ? msg.key.participant : m.from);
    
    // Message content
    m.message = msg.message;
    m.type = type;

    // Text message එකක් නම්
    if (type === 'conversation') {
        m.body = msg.message.conversation;
    } else if (type === 'extendedTextMessage') {
        m.body = msg.message.extendedTextMessage.text;
    } else if (type === 'imageMessage') {
        m.body = msg.message.imageMessage.caption || '';
    } else if (type === 'videoMessage') {
        m.body = msg.message.videoMessage.caption || '';
    } else {
        m.body = '';
    }

    // Quoted message
    m.quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;
    if (m.quoted) {
        const quotedType = getContentType(m.quoted);
        m.quoted.type = quotedType;
        m.quoted.text = m.quoted[quotedType]?.text || m.quoted[quotedType]?.caption || '';
        m.quoted.sender = msg.message.extendedTextMessage.contextInfo.participant;
    }

    // Mentions
    m.mentionedJid = msg.message?.[type]?.contextInfo?.mentionedJid || [];

    // Download media function
    m.download = async () => {
        if (!msg.message) return null;
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        return buffer;
    };

    // React function
    m.react = async (emoji) => {
        return await conn.sendMessage(m.from, {
            react: { text: emoji, key: msg.key }
        });
    };

    return m;
}

/**
 * Buffer එකක් URL එකකින් download කරන්න
 */
async function getBuffer(url, options = {}) {
    try {
        const res = await require('axios').get(url, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0',
                ...options.headers
            },
            ...options
        });
        return res.data;
    } catch (e) {
        console.log('Download Error:', e.message);
        return null;
    }
}

/**
 * JSON data fetch කරන්න
 */
async function fetchJson(url, options = {}) {
    try {
        const res = await require('axios').get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                ...options.headers
            },
            ...options
        });
        return res.data;
    } catch (e) {
        console.log('Fetch Error:', e.message);
        return null;
    }
}

/**
 * Sleep function
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Runtime calculate කරන්න
 */
function runtime(seconds) {
    seconds = Number(seconds);
    var d = Math.floor(seconds / (3600 * 24));
    var h = Math.floor(seconds % (3600 * 24) / 3600);
    var m = Math.floor(seconds % 3600 / 60);
    var s = Math.floor(seconds % 60);
    
    var dDisplay = d > 0 ? d + "d " : "";
    var hDisplay = h > 0 ? h + "h " : "";
    var mDisplay = m > 0 ? m + "m " : "";
    var sDisplay = s > 0 ? s + "s" : "";
    
    return dDisplay + hDisplay + mDisplay + sDisplay;
}

/**
 * File type check කරන්න
 */
function isUrl(url) {
    const regex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi;
    return regex.test(url);
}

/**
 * Group admins ලබා ගන්න
 */
async function getGroupAdmins(participants) {
    const admins = [];
    for (let i of participants) {
        if (i.admin !== null) admins.push(i.id);
    }
    return admins;
}

/**
 * Format number
 */
function formatNumber(n) {
    return n.toLocaleString('en-US');
}

/**
 * Generate random filename
 */
function getRandom(ext) {
    return `${Math.floor(Math.random() * 10000)}${ext}`;
}

module.exports = {
    serialize,
    getBuffer,
    fetchJson,
    sleep,
    runtime,
    isUrl,
    getGroupAdmins,
    formatNumber,
    getRandom
};
