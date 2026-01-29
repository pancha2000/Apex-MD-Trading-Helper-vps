const { proto, downloadContentFromMessage, getContentType } = require('@whiskeysockets/baileys');
const path = require('path'); // Required for path.extname if used

/**
 * Downloads media from a message and returns it as a Buffer.
 * @param {object} messageInstance The message object (m or m.quoted from sms function).
 * @returns {Promise<Buffer|null>} A Promise that resolves to a Buffer or null if an error occurs.
 */
const downloadMediaMessage = async (messageInstance) => {
    if (!messageInstance || !messageInstance.msg || !messageInstance.type) {
        console.error("Invalid messageInstance passed to downloadMediaMessage");
        return null;
    }

    let typeToDownload = messageInstance.type;
    let messageContent = messageInstance.msg;

    // Convert Baileys message type to the string expected by downloadContentFromMessage
    // Example: 'imageMessage' becomes 'image'
    // 'image', 'video', 'audio', 'sticker', 'document'
    const downloadType = typeToDownload.replace('Message', ''); // Simplified this line

    if (!['image', 'video', 'audio', 'sticker', 'document'].includes(downloadType)) {
        console.warn(`Unsupported message type for download: ${typeToDownload}`);
        return null;
    }

    try {
        const stream = await downloadContentFromMessage(messageContent, downloadType);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        return buffer;
    } catch (error) {
        console.error(`Error downloading ${downloadType} media:`, error);
        return null;
    }
};

const sms = (conn, m) => {
    if (m.key) {
        m.id = m.key.id;
        m.chat = m.key.remoteJid;
        m.fromMe = m.key.fromMe;
        m.isGroup = m.chat.endsWith('@g.us');
        
        // --- `m.sender` හැසිරවීම සඳහා වැඩි දියුණු කිරීම ---
        // 'm.key.participant' හිස් විය හැකි අවස්ථා වලදී 'm.key.remoteJid' වෙත යොමු වේ.
        // මෙය 'm.sender' හිස්වීම වලක්වයි, එමගින් 'index.js' හි '.split()' දෝෂය නිරාකරණය කරයි.
        m.sender = m.fromMe 
            ? (conn.user.id.split(':')[0] + '@s.whatsapp.net' || conn.user.id) 
            : (m.key.participant || m.key.remoteJid);
        // --- `m.sender` වැඩි දියුණු කිරීම අවසානය ---
    }

    if (m.message) {
        m.type = getContentType(m.message);
        if (m.type === 'viewOnceMessageV2' || m.type === 'viewOnceMessageV2Extension'){ // Handle new V2 view once
            m.msg = m.message[m.type].message;
            m.type = getContentType(m.msg); // Get the actual type from the inner message
        } else if (m.type === 'ephemeralMessage') { // Handle ephemeral messages
            m.msg = m.message.ephemeralMessage.message;
            m.type = getContentType(m.msg);
        } else {
            m.msg = m.message[m.type];
        }

        if (m.msg) {
            const contextInfo = m.msg.contextInfo;
            m.mentionUser = [];
            if (contextInfo) {
                if (contextInfo.mentionedJid) {
                    m.mentionUser.push(...contextInfo.mentionedJid);
                }
                // contextInfo.participant is for quoted message sender, not direct mentions
            }

            m.body = (m.type === 'conversation' && m.msg) ? m.msg :
                     (m.type === 'extendedTextMessage' && m.msg.text) ? m.msg.text :
                     (m.type === 'imageMessage' && m.msg.caption) ? m.msg.caption :
                     (m.type === 'videoMessage' && m.msg.caption) ? m.msg.caption :
                     (m.type === 'templateButtonReplyMessage' && m.msg.selectedId) ? m.msg.selectedId :
                     (m.type === 'buttonsResponseMessage' && m.msg.selectedButtonId) ? m.msg.selectedButtonId :
                     (m.type === 'listResponseMessage' && m.msg.singleSelectReply && m.msg.singleSelectReply.selectedRowId) ? m.msg.singleSelectReply.selectedRowId :
                     ''; // Default to empty string if no body found

            m.quoted = null;
            if (contextInfo && contextInfo.quotedMessage) {
                m.quoted = { msg: contextInfo.quotedMessage }; // Basic structure
                m.quoted.type = getContentType(m.quoted.msg);
                m.quoted.id = contextInfo.stanzaId;
                // --- `m.quoted.sender` හැසිරවීම ---
                // `contextInfo.participant` යනු quoted message එකේ original sender වේ.
                // මෙය සමහර විට හිස් විය හැක (උදා: quoted message එකේ sender කණ්ඩායමෙන් ඉවත් වී ඇත්නම්).
                // එය හිස් නම් 'null' ලෙස පවතී, 'index.js' හෝ plugin වලදී මෙය පරීක්ෂා කළ යුතුය.
                m.quoted.sender = contextInfo.participant; 
                // --- `m.quoted.sender` හැසිරවීම අවසානය ---

                m.quoted.fromMe = m.quoted.sender && conn.user && conn.user.id ? m.quoted.sender.split('@')[0] === conn.user.id.split(':')[0] : false;

                // Process the actual content of the quoted message
                if (m.quoted.type === 'viewOnceMessageV2' || m.quoted.type === 'viewOnceMessageV2Extension') {
                    m.quoted.msg = m.quoted.msg[m.quoted.type].message;
                    m.quoted.type = getContentType(m.quoted.msg);
                } else if (m.quoted.type === 'ephemeralMessage') {
                     m.quoted.msg = m.quoted.msg.ephemeralMessage.message;
                     m.quoted.type = getContentType(m.quoted.msg);
                } else {
                    m.quoted.msg = m.quoted.msg[m.quoted.type];
                }

                m.quoted.mentionUser = [];
                if (m.quoted.msg && m.quoted.msg.contextInfo && m.quoted.msg.contextInfo.mentionedJid) {
                    m.quoted.mentionUser.push(...m.quoted.msg.contextInfo.mentionedJid);
                }

                m.quoted.body = (m.quoted.type === 'conversation' && m.quoted.msg) ? m.quoted.msg :
                                (m.quoted.type === 'extendedTextMessage' && m.quoted.msg.text) ? m.quoted.msg.text :
                                ''; // Add more types as needed for quoted body

                m.quoted.fakeObj = proto.WebMessageInfo.fromObject({
                    key: {
                        remoteJid: m.chat,
                        fromMe: m.quoted.fromMe,
                        id: m.quoted.id,
                        participant: m.quoted.sender // participant හිස් විය හැකි බැවින්, මෙහි m.quoted.sender හිස් නම් Baileys මෙය හසුරුවනු ඇත.
                    },
                    message: contextInfo.quotedMessage // Use the original quotedMessage for fakeObj
                });

                m.quoted.download = () => downloadMediaMessage(m.quoted); // Pass the processed m.quoted
                m.quoted.delete = () => conn.sendMessage(m.chat, { delete: m.quoted.fakeObj.key });
                m.quoted.react = (emoji) => conn.sendMessage(m.chat, { react: { text: emoji, key: m.quoted.fakeObj.key } });
            }
        }
        m.download = () => downloadMediaMessage(m); // Pass the main message 'm'
    }

    m.reply = (teks, id = m.chat, options = {}) => {
        const mention = options.mentions || (m.sender ? [m.sender] : []);
        return conn.sendMessage(id, { text: teks, mentions: mention }, { quoted: m });
    };
    m.replyS = (stik, id = m.chat, option = { mentions: [m.sender] }) => conn.sendMessage(id, { sticker: stik, mentions: option.mentions }, { quoted: m })
    m.replyImg = (img, teks, id = m.chat, option = { mentions: [m.sender] }) => conn.sendMessage(id, { image: img, caption: teks, mentions: option.mentions }, { quoted: m })
    m.replyVid = (vid, teks, id = m.chat, option = { mentions: [m.sender], gif: false }) => conn.sendMessage(id, { video: vid, caption: teks, gifPlayback: option.gif, mentions: option.mentions }, { quoted: m })
    m.replyAud = (aud, id = m.chat, option = { mentions: [m.sender], ptt: false }) => conn.sendMessage(id, { audio: aud, ptt: option.ptt, mimetype: 'audio/mpeg', mentions: option.mentions }, { quoted: m })
    m.replyDoc = (doc, id = m.chat, option = { mentions: [m.sender], filename: 'undefined.pdf', mimetype: 'application/pdf' }) => conn.sendMessage(id, { document: doc, mimetype: option.mimetype, fileName: option.filename, mentions: option.mentions }, { quoted: m })
    m.replyContact = (name, info, number) => {
        var vcard = 'BEGIN:VCARD\n' + 'VERSION:3.0\n' + 'FN:' + name + '\n' + 'ORG:' + info + ';\n' + 'TEL;type=CELL;type=VOICE;waid=' + number + ':+' + number + '\n' + 'END:VCARD'
        conn.sendMessage(m.chat, { contacts: { displayName: name, contacts: [{ vcard }] } }, { quoted: m })
    }

    m.react = (emoji) => conn.sendMessage(m.chat, { react: { text: emoji, key: m.key } });

    return m;
};

module.exports = { sms, downloadMediaMessage };