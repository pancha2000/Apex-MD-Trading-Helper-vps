'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  plugins/link.js  —  WhatsApp Account Linking
 *  ──────────────────────────────────────────────────────────────
 *  Commands:
 *    .link <TOKEN>   — Link this WA number to a web portal account
 *    .unlink         — Unlink this WA number from web portal
 *    .linkstatus     — Check if this number is linked
 *
 *  Flow:
 *    1. User logs into web portal → Settings → Generate Token
 *    2. Web portal creates a LinkToken doc (TTL: 15 min)
 *    3. User sends ".link LINK-XXXXXX" here on WhatsApp
 *    4. Bot finds the token → saves whatsappJid to SaasUser
 *    5. Token is burned (single-use)
 * ════════════════════════════════════════════════════════════════
 */

const { cmd }  = require('../lib/commands');
const db       = require('../lib/database');

// ─── Helper: extract clean JID (number only, no device suffix) ───
// Baileys sender JIDs can be "94771234567:5@s.whatsapp.net" (multi-device)
// We normalise to "94771234567@s.whatsapp.net" for consistent storage.
function normaliseJid(jid = '') {
    if (!jid) return jid;
    const [user, server] = jid.split('@');
    const number = user.split(':')[0];   // strip :5 device suffix
    return number + '@' + (server || 's.whatsapp.net');
}

// ════════════════════════════════════════════════════════════════
//  .link <TOKEN>
// ════════════════════════════════════════════════════════════════
cmd({
    pattern:  'link',
    alias:    ['connectweb', 'linkweb'],
    desc:     'Link your WhatsApp to your Apex-MD web account',
    category: 'account',
    use:      '.link LINK-XXXXXX',
    react:    '🔗',
    filename: __filename,
}, async (conn, mek, m, { reply, args, from }) => {
    try {
        // ── 1. Get the token from the message ─────────────────────
        const rawToken = (args[0] || '').trim().toUpperCase();

        if (!rawToken) {
            return await reply(
`╔══════════════════════════════╗
║  🔗  *APEX-MD Account Linking*  ║
╚══════════════════════════════╝

To link your WhatsApp to your web account:

*Step 1* → Login to the web portal
*Step 2* → Go to ⚙️ Settings
*Step 3* → Click *"Generate Linking Token"*
*Step 4* → Send this command:
  *.link LINK-XXXXXX*

⏳ Token expires in *15 minutes* after generating.`
            );
        }

        // Validate token format (LINK- followed by 6 hex chars)
        if (!/^LINK-[A-F0-9]{6}$/.test(rawToken)) {
            return await reply(
`❌ *Invalid token format.*

Token must look like: *LINK-A3F9B2*

Generate a fresh token at:
⚙️ Web Portal → Settings → Generate Linking Token`
            );
        }

        // ── 2. Get the sender's JID ───────────────────────────────
        const senderJid = normaliseJid(mek.sender || from);

        // ── 3. Check if this number is already linked ─────────────
        const alreadyLinked = await db.getSaasUserByWhatsapp(senderJid);
        if (alreadyLinked) {
            return await reply(
`⚠️ *Already Linked*

This WhatsApp number is already connected to:
👤 *${alreadyLinked.username}*

To link to a different account, first unlink:
  *.unlink*`
            );
        }

        // ── 4. React to show processing ───────────────────────────
        await mek.react('⏳');

        // ── 5. Consume the token ──────────────────────────────────
        const user = await db.consumeLinkToken(rawToken, senderJid);

        if (!user) {
            await mek.react('❌');
            return await reply(
`❌ *Token Invalid or Expired*

Possible reasons:
• Token already used
• Token expired (15 min limit)
• Wrong token format

Please generate a *new token* at:
⚙️ Web Portal → Settings → Generate Linking Token`
            );
        }

        // ── 6. Success! ───────────────────────────────────────────
        await mek.react('✅');

        const linkedNumber = senderJid.replace('@s.whatsapp.net', '');
        const timestamp    = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Colombo', hour12: true });

        await reply(
`╔══════════════════════════════════╗
║  ✅  *WhatsApp Linked Successfully!*  ║
╚══════════════════════════════════╝

👤 *Account:* ${user.username}
📧 *Email:* ${user.email}
📱 *Number:* +${linkedNumber}
🕐 *Linked at:* ${timestamp}

━━━━━━━━━━━━━━━━━━━━
You will now receive:
  📊 Trade signals
  🎯 TP/SL alerts
  📈 Daily P&L reports

Use *.unlink* to disconnect anytime.
━━━━━━━━━━━━━━━━━━━━`
        );

    } catch (e) {
        console.error('[LINK] Error:', e.message);
        await mek.react('❌');
        await reply('❌ Server error during linking. Please try again.\n\n_Error: ' + e.message + '_');
    }
});

// ════════════════════════════════════════════════════════════════
//  .unlink
// ════════════════════════════════════════════════════════════════
cmd({
    pattern:  'unlink',
    alias:    ['disconnectweb', 'unlinkweb'],
    desc:     'Unlink your WhatsApp from your Apex-MD web account',
    category: 'account',
    use:      '.unlink',
    react:    '🔓',
    filename: __filename,
}, async (conn, mek, m, { reply, from }) => {
    try {
        const senderJid = normaliseJid(mek.sender || from);
        const user      = await db.getSaasUserByWhatsapp(senderJid);

        if (!user) {
            return await reply(
`⚠️ *Not Linked*

This WhatsApp number is not linked to any web account.

To link, use:
  *.link LINK-XXXXXX*

Generate a token at ⚙️ Web Portal → Settings.`
            );
        }

        await mek.react('⏳');
        await db.unlinkWhatsapp(user._id);
        await mek.react('✅');

        await reply(
`🔓 *WhatsApp Unlinked*

Your number has been disconnected from:
👤 *${user.username}*

You will no longer receive signals on WhatsApp.

To re-link anytime:
  *.link LINK-XXXXXX*`
        );

    } catch (e) {
        console.error('[UNLINK] Error:', e.message);
        await mek.react('❌');
        await reply('❌ Error: ' + e.message);
    }
});

// ════════════════════════════════════════════════════════════════
//  .linkstatus
// ════════════════════════════════════════════════════════════════
cmd({
    pattern:  'linkstatus',
    alias:    ['linkcheck', 'webstatus'],
    desc:     'Check if your WhatsApp is linked to a web account',
    category: 'account',
    use:      '.linkstatus',
    react:    '🔍',
    filename: __filename,
}, async (conn, mek, m, { reply, from }) => {
    try {
        const senderJid = normaliseJid(mek.sender || from);
        const user      = await db.getSaasUserByWhatsapp(senderJid);

        if (!user) {
            return await reply(
`📊 *Link Status: Not Linked*

This WhatsApp number is not connected to any web account.

Use *.link LINK-XXXXXX* to connect.`
            );
        }

        const linkedAt = user.whatsappLinkedAt
            ? new Date(user.whatsappLinkedAt).toLocaleString('en-GB', { timeZone: 'Asia/Colombo', hour12: true })
            : 'Unknown';

        await reply(
`📊 *Link Status: Connected ✅*

👤 *Account:*  ${user.username}
📧 *Email:*    ${user.email}
🏷️ *Role:*     ${user.role}
🔗 *Linked:*   ${linkedAt}

Use *.unlink* to disconnect.`
        );

    } catch (e) {
        console.error('[LINKSTATUS] Error:', e.message);
        await reply('❌ Error: ' + e.message);
    }
});
