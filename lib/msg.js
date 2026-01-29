const { proto, getContentType } = require('@whiskeysockets/baileys');

const sms = (conn, m) => {
    if (!m) return m;
    let M = proto.WebMessageInfo;
    
    if (m.key) {
        m.id = m.key.id;
        m.isBaileys = m.id.startsWith('BAE5') && m.id.length === 16;
        m.chat = m.key.remoteJid;
        m.fromMe = m.key.fromMe;
        m.isGroup = m.chat.endsWith('@g.us');
        m.sender = m.fromMe ? (conn.user.id.split(":")[0] + "@s.whatsapp.net" || conn.user.id) : (m.key.participant || m.key.remoteJid);
    }

    if (m.message) {
        m.mtype = getContentType(m.message);
        m.msg = (m.mtype == 'viewOnceMessage' ? m.message[m.mtype].message[getContentType(m.message[m.mtype].message)] : m.message[m.mtype]);
        
        // Body (Text) detection
        if (m.mtype === 'conversation') {
            m.body = m.message.conversation;
        } else if (m.mtype === 'imageMessage') {
            m.body = m.message.imageMessage.caption;
        } else if (m.mtype === 'videoMessage') {
            m.body = m.message.videoMessage.caption;
        } else if (m.mtype === 'extendedTextMessage') {
            m.body = m.message.extendedTextMessage.text;
        } else if (m.mtype === 'buttonsResponseMessage') {
            m.body = m.message.buttonsResponseMessage.selectedButtonId;
        } else if (m.mtype === 'listResponseMessage') {
            m.body = m.message.listResponseMessage.singleSelectReply.selectedRowId;
        } else if (m.mtype === 'templateButtonReplyMessage') {
            m.body = m.message.templateButtonReplyMessage.selectedId;
        } else {
            m.body = '';
        }
        
        m.quoted = m.msg.contextInfo ? m.msg.contextInfo.quotedMessage : null;
        m.mentionUser = m.msg.contextInfo ? m.msg.contextInfo.mentionedJid : [];
        
        // Reply function
        m.reply = (text, options) => {
            conn.sendMessage(m.chat, { text: text }, { quoted: m, ...options });
        };
    }
    return m;
};

module.exports = { sms };
