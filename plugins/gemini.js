const { cmd } = require('../lib/commands');
const config = require('../config');
const axios = require('axios');

async function callGemini(prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.GEMINI_API}`;
    const response = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }]
    });
    return response.data.candidates[0].content.parts[0].text;
}

cmd({
    pattern: "ai",
    alias: ["gemini", "gpt", "ask"],
    desc: "Chat with AI (Gemini)",
    category: "ai",
    react: "🤖",
    filename: __filename
},
async (conn, mek, m, { reply, text }) => {
    try {
        if (!text) return await reply('❌ කරුණාකර question එකක් ඇහුවන්න!\n\nExample: .ai What is AI?');
        if (!config.GEMINI_API) return await reply('❌ GEMINI_API key එක config.env එකේ නැහැ!');

        await m.react('🤔');
        const aiResponse = await callGemini(text);

        await reply(`
╔═══════════════════════════╗
║      🤖 *AI RESPONSE*     ║
╚═══════════════════════════╝

${aiResponse}

> *Powered by Google Gemini 2.0*
`);
        await m.react('✅');

    } catch (e) {
        await m.react('❌');
        await reply('❌ Error: ' + (e.response?.data?.error?.message || e.message));
        console.log('AI error:', e);
    }
});

cmd({
    pattern: "chatgpt",
    alias: ["gpt3", "openai"],
    desc: "Chat with ChatGPT",
    category: "ai",
    react: "🧠",
    filename: __filename
},
async (conn, mek, m, { reply, text }) => {
    try {
        if (!text) return await reply('❌ කරුණාකර question එකක් ඇහුවන්න!\n\nExample: .chatgpt Explain quantum physics');
        if (!config.OPENAI_API) return await reply('❌ OPENAI_API key එක config.env එකේ නැහැ!\n\nFree alternative: Use .ai command');

        await m.react('🤔');
        const { Configuration, OpenAIApi } = require('openai');
        const openai = new OpenAIApi(new Configuration({ apiKey: config.OPENAI_API }));
        const completion = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: text }],
        });

        await reply(`
╔═══════════════════════════╗
║    🧠 *CHATGPT RESPONSE*  ║
╚═══════════════════════════╝

${completion.data.choices[0].message.content}

> *Powered by OpenAI*
`);
        await m.react('✅');

    } catch (e) {
        await m.react('❌');
        await reply('❌ Error: ' + e.message + '\n\nTip: Use .ai command as free alternative!');
        console.log('ChatGPT error:', e);
    }
});
