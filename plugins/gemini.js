/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD v7.1  ·  plugins/gemini.js
 *  ──────────────────────────────────────────────────────────────
 *  ✅ FIX: .chatgpt command now uses GROQ API (llama3-70b) instead
 *          of OpenAI — no extra npm package, uses existing GROQ_API key.
 *          Original .ai command (Gemini) unchanged.
 * ════════════════════════════════════════════════════════════════
 */

'use strict';

const { cmd } = require('../lib/commands');
const config  = require('../config');
const axios   = require('axios');

// ─── Gemini helper ────────────────────────────────────────────
async function callGemini(prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.GEMINI_API}`;
    const response = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }]
    }, { timeout: 20000 });
    return response.data.candidates[0].content.parts[0].text;
}

// ─── GROQ helper (replaces broken OpenAI dep) ────────────────
async function callGroq(prompt, model = 'llama3-70b-8192') {
    const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 1024,
        },
        {
            headers: {
                'Authorization': `Bearer ${config.GROQ_API}`,
                'Content-Type': 'application/json',
            },
            timeout: 25000,
        }
    );
    return response.data.choices[0].message.content;
}

// ══════════════════════════════════════════════════════════════
//  .ai — Chat with Google Gemini
// ══════════════════════════════════════════════════════════════
cmd({
    pattern: 'ai',
    alias:   ['gemini', 'gpt', 'ask'],
    desc:    'Chat with AI (Gemini 2.0 Flash)',
    category: 'ai',
    react:   '🤖',
    filename: __filename,
},
async (conn, mek, m, { reply, text }) => {
    try {
        if (!text) return await reply('❌ කරුණාකර question එකක් ඇහුවන්න!\n\nExample: .ai What is Bitcoin?');
        if (!config.GEMINI_API) return await reply('❌ GEMINI_API key එක config.env එකේ නැහැ!');

        await m.react('🤔');
        const aiResponse = await callGemini(text);

        await reply(
`╔═══════════════════════════╗
║      🤖 *AI RESPONSE*     ║
╚═══════════════════════════╝

${aiResponse}

> *Powered by Google Gemini 2.0 Flash*`
        );
        await m.react('✅');

    } catch (e) {
        await m.react('❌');
        await reply('❌ Gemini Error: ' + (e.response?.data?.error?.message || e.message));
        console.log('[gemini] .ai error:', e.message);
    }
});

// ══════════════════════════════════════════════════════════════
//  .chatgpt — Chat with GROQ (Llama 3 70B) — ✅ FIXED
//  Previously used OpenAI package which was not installed.
//  Now uses the GROQ_API key that's already configured.
// ══════════════════════════════════════════════════════════════
cmd({
    pattern: 'chatgpt',
    alias:   ['gpt3', 'llama', 'groqai'],
    desc:    'Chat with GROQ AI (Llama 3 70B)',
    category: 'ai',
    react:   '🧠',
    filename: __filename,
},
async (conn, mek, m, { reply, text }) => {
    try {
        if (!text) return await reply('❌ කරුණාකර question එකක් ඇහුවන්න!\n\nExample: .chatgpt Explain DeFi in simple terms');
        if (!config.GROQ_API) return await reply('❌ GROQ_API key එක config.env එකේ නැහැ!\n\nFree alternative: Use .ai command (Gemini)');

        await m.react('🤔');
        const response = await callGroq(text);

        await reply(
`╔═══════════════════════════╗
║    🧠 *GROQ AI RESPONSE*  ║
╚═══════════════════════════╝

${response}

> *Powered by GROQ · Llama 3 70B*`
        );
        await m.react('✅');

    } catch (e) {
        await m.react('❌');
        const errMsg = e.response?.data?.error?.message || e.message;
        await reply(`❌ GROQ Error: ${errMsg}\n\nTip: .ai command (Gemini) use කරන්න!`);
        console.log('[gemini] .chatgpt error:', e.message);
    }
});

// ══════════════════════════════════════════════════════════════
//  .analyze — Ask AI about a crypto setup (market context)
// ══════════════════════════════════════════════════════════════
cmd({
    pattern: 'analyze',
    alias:   ['aimarket', 'marketai'],
    desc:    'Ask AI about current crypto market or a coin',
    category: 'ai',
    react:   '📊',
    filename: __filename,
},
async (conn, mek, m, { reply, text }) => {
    try {
        if (!text) return await reply('❌ Coin හෝ question ලබා දෙන්න!\n\nExample: .analyze BTC current market structure');
        if (!config.GROQ_API && !config.GEMINI_API) return await reply('❌ GROQ_API හෝ GEMINI_API key නැහැ!');

        await m.react('⏳');

        const prompt = `You are an expert crypto trader and market analyst. 
Answer this trading question concisely and practically: ${text}
Focus on actionable insights, key levels, and risk management.`;

        let response;
        if (config.GROQ_API) {
            response = await callGroq(prompt);
        } else {
            response = await callGemini(prompt);
        }

        await reply(
`╔═══════════════════════════╗
║  📊 *MARKET AI ANALYSIS*  ║
╚═══════════════════════════╝

${response}

> *Powered by ${config.GROQ_API ? 'GROQ Llama 3' : 'Google Gemini'}*
> ⚠️ _AI analysis is not financial advice._`
        );
        await m.react('✅');

    } catch (e) {
        await m.react('❌');
        await reply('❌ AI Error: ' + (e.response?.data?.error?.message || e.message));
        console.log('[gemini] .analyze error:', e.message);
    }
});
