const axios = require('axios');
const path = require('path'); // For getRandom if used with file extensions

const getBuffer = async (url, options) => {
    try {
        options = options || {};
        const res = await axios({
            method: 'get',
            url,
            headers: {
                'DNT': 1,
                'Upgrade-Insecure-Request': 1,
                ...(options.headers || {})
            },
            ...options,
            responseType: 'arraybuffer'
        });
        return res.data;
    } catch (e) {
        console.error(`Error in getBuffer for URL ${url}:`, e.message);
        return null; // Return null on error
    }
};

const getGroupAdmins = (participants) => {
    const admins = [];
    if (!Array.isArray(participants)) return admins; // Basic validation
    for (const i of participants) {
        // In newer Baileys versions, admin status might be 'admin', 'superadmin', or null/undefined
        if (i.admin === 'admin' || i.admin === 'superadmin') {
            admins.push(i.id);
        }
    }
    return admins;
};

const getRandom = (ext) => {
    const extension = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : '';
    return `${Math.floor(Math.random() * 1000000)}${extension}`; // Increased range for randomness
};

const h2k = (eco) => {
    if (isNaN(eco) || eco === null) return eco; // Handle non-numeric or null inputs
    const num = Number(eco);
    if (Math.abs(num) < 1000) return num.toString(); // Return as is if less than 1000

    const lyrik = ['', 'K', 'M', 'B', 'T', 'P', 'E'];
    const ma = Math.floor(Math.log10(Math.abs(num)) / 3);

    if (ma < 0 || ma >= lyrik.length) return num.toString(); // Handle very small or very large numbers beyond defined suffixes

    const ppo = lyrik[ma];
    const scale = Math.pow(10, ma * 3);
    const scaled = num / scale;
    let formatt = scaled.toFixed(1);

    if (/\.0$/.test(formatt)) {
        formatt = formatt.substr(0, formatt.length - 2);
    }
    return formatt + ppo;
};

const isUrl = (url) => {
    if (typeof url !== 'string') return false;
    try {
        // More robust URL validation using the URL constructor
        new URL(url);
        // Basic regex check can also be kept if specific patterns are needed
        // but URL constructor handles more edge cases for general validity.
        return /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/.test(url);
    } catch (_) {
        return false;
    }
};

const Json = (string) => {
    try {
        return JSON.stringify(string, null, 2);
    } catch (e) {
        console.error("Error stringifying JSON:", e);
        return "{}"; // Return an empty JSON object string on error
    }
};

const runtime = (seconds) => {
    seconds = Number(seconds);
    if (isNaN(seconds) || seconds < 0) return 'Invalid time';

    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const dDisplay = d > 0 ? d + (d === 1 ? ' day, ' : ' days, ') : '';
    const hDisplay = h > 0 ? h + (h === 1 ? ' hour, ' : ' hours, ') : '';
    const mDisplay = m > 0 ? m + (m === 1 ? ' minute, ' : ' minutes, ') : '';
    const sDisplay = s > 0 ? s + (s === 1 ? ' second' : ' seconds') : (dDisplay || hDisplay || mDisplay ? '' : '0 seconds'); // Show 0 seconds if no other units

    let result = (dDisplay + hDisplay + mDisplay + sDisplay).trim();
    if (result.endsWith(',')) {
        result = result.slice(0, -1); // Remove trailing comma
    }
    return result || '0 seconds'; // Ensure something is always returned
};

const sleep = async (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
};

const fetchJson = async (url, options) => {
    try {
        options = options || {};
        const res = await axios({
            method: 'GET',
            url: url,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.69 Safari/537.36',
                ...(options.headers || {})
            },
            ...options
        });
        return res.data;
    } catch (err) {
        console.error(`Error in fetchJson for URL ${url}:`, err.message);
        return null; // Return null on error
    }
};

module.exports = { getBuffer, getGroupAdmins, getRandom, h2k, isUrl, Json, runtime, sleep, fetchJson };