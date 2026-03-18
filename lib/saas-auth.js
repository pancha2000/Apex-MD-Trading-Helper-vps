'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  APEX-MD v7 PRO  ·  lib/saas-auth.js
 *  ──────────────────────────────────────────────────────────────
 *  SaaS authentication utilities — dependency-light.
 *  Zero third-party packages: uses Node.js built-in `crypto` only.
 *
 *  Provides:
 *    • scrypt password hashing / verification
 *    • AES-256-GCM API key encryption / decryption
 *    • HMAC-based session token sign / verify
 *    • Rate-limiter factory (shared by auth routes)
 * ════════════════════════════════════════════════════════════════
 */

const crypto = require('crypto');
const config = require('../config');

// ─── scrypt tuning  ─────────────────────────────────────────────
// N=16384 is the OWASP minimum for interactive logins on 2024 hardware.
// Increase N to 65536 for higher security if CPU budget allows.
const SCRYPT_N   = 16384;
const SCRYPT_R   = 8;
const SCRYPT_P   = 1;
const SCRYPT_LEN = 64;   // output key length in bytes

/**
 * Hash a plaintext password using scrypt.
 * Returns a single string:  "<hex-salt>:<hex-hash>"
 * Store this string in SaasUser.passwordHash.
 */
function hashPassword(password) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16).toString('hex');
        crypto.scrypt(password, salt, SCRYPT_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, key) => {
            if (err) return reject(err);
            resolve(salt + ':' + key.toString('hex'));
        });
    });
}

/**
 * Verify a plaintext password against a stored hash string.
 * Returns true / false.  Timing-safe.
 */
function verifyPassword(password, storedHash) {
    return new Promise((resolve, reject) => {
        const [salt, hash] = storedHash.split(':');
        if (!salt || !hash) return resolve(false);
        crypto.scrypt(password, salt, SCRYPT_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, key) => {
            if (err) return reject(err);
            try {
                resolve(crypto.timingSafeEqual(Buffer.from(hash, 'hex'), key));
            } catch { resolve(false); }
        });
    });
}

// ─── AES-256-GCM key (derived from DASHBOARD_SECRET)  ───────────
// The same master secret that protects admin sessions also encrypts
// user API keys.  Rotating DASHBOARD_SECRET will invalidate all
// stored encrypted keys — document this in your ops runbook.
const ENC_KEY = crypto
    .createHash('sha256')
    .update(config.DASHBOARD_SECRET || 'apex-fallback-enc-key-change-me')
    .digest();  // 32-byte key

/**
 * Encrypt a plaintext string (e.g. Binance API key).
 * Returns "<iv-hex>:<ciphertext-hex>:<authtag-hex>".
 */
function encryptApiKey(plaintext) {
    const iv     = crypto.randomBytes(12);             // 96-bit IV recommended for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
    const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag    = cipher.getAuthTag();
    return [iv.toString('hex'), enc.toString('hex'), tag.toString('hex')].join(':');
}

/**
 * Decrypt a string produced by encryptApiKey().
 * Throws on tampered/invalid ciphertext (GCM auth failure).
 */
function decryptApiKey(stored) {
    const [ivHex, encHex, tagHex] = stored.split(':');
    const iv       = Buffer.from(ivHex,  'hex');
    const enc      = Buffer.from(encHex, 'hex');
    const tag      = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc).toString('utf8') + decipher.final('utf8');
}

// ─── Session tokens (HMAC-SHA256, same approach as admin panel)  ─
const USER_COOKIE_NAME = 'apex_user_session';
const USER_COOKIE_TTL  = 8 * 60 * 60 * 1000;  // 8 hours in ms
const _hmacSecret      = config.DASHBOARD_SECRET || 'apex-fallback-session-key-change-me';

/**
 * Sign a payload into a base64url.HMAC token.
 * payload should include: { userId, username, role, exp }
 */
function signUserToken(payload) {
    const data = JSON.stringify(payload);
    const sig  = crypto.createHmac('sha256', _hmacSecret).update(data).digest('hex');
    return Buffer.from(data).toString('base64url') + '.' + sig;
}

/**
 * Verify and decode a user session token.
 * Returns decoded payload or null on failure / expiry.
 */
function verifyUserToken(token) {
    try {
        if (!token) return null;
        const [dataPart, sig] = token.split('.');
        if (!dataPart || !sig) return null;
        const data     = Buffer.from(dataPart, 'base64url').toString();
        const expected = crypto.createHmac('sha256', _hmacSecret).update(data).digest('hex');
        // Constant-time comparison — pad lengths if needed
        const sigBuf = Buffer.from(sig.padEnd(expected.length, '0'));
        const expBuf = Buffer.from(expected);
        if (sigBuf.length !== expBuf.length) return null;
        if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
        const payload = JSON.parse(data);
        if (payload.exp < Date.now()) return null;
        return payload;
    } catch { return null; }
}

/**
 * Build a Set-Cookie header string for the user session.
 */
function buildUserCookieHeader(token, ttlMs) {
    return `${USER_COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}; SameSite=Strict`;
}

/**
 * Build a clearing Set-Cookie header (logout).
 */
function clearUserCookieHeader() {
    return `${USER_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`;
}

// ─── Simple in-process rate limiter factory  ─────────────────────
/**
 * Returns a rate-limiter object { check(ip), reset(ip) }.
 * @param {number} maxAttempts   max tries in the window
 * @param {number} windowMs      rolling window in milliseconds
 */
function createRateLimiter(maxAttempts, windowMs) {
    const store = new Map();
    return {
        check(ip) {
            const now  = Date.now();
            const data = store.get(ip) || { count: 0, first: now };
            if (now - data.first > windowMs) {
                store.set(ip, { count: 1, first: now });
                return true;
            }
            if (data.count >= maxAttempts) return false;
            data.count++;
            store.set(ip, data);
            return true;
        },
        reset(ip) { store.delete(ip); },
    };
}

// Pre-built limiter for /auth/login: 8 attempts per 15 minutes
const loginRateLimiter = createRateLimiter(8, 15 * 60 * 1000);

// ─── Cookie parser helper  ───────────────────────────────────────
function parseCookies(header) {
    const out = {};
    if (!header) return out;
    header.split(';').forEach(p => {
        const [k, ...v] = p.trim().split('=');
        out[k.trim()] = decodeURIComponent(v.join('='));
    });
    return out;
}

// ─── Express middleware  ─────────────────────────────────────────
/**
 * requireUserAuth — protect /app/* routes.
 * Reads apex_user_session cookie, decodes it, attaches req.saasUser.
 * On failure redirects to /auth/login (or 401 for API routes).
 */
function requireUserAuth(req, res, next) {
    const cookies = parseCookies(req.headers.cookie);
    const payload = verifyUserToken(cookies[USER_COOKIE_NAME]);
    if (!payload) {
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
        return res.redirect('/auth/login?next=' + encodeURIComponent(req.originalUrl));
    }
    if (payload.accountStatus === 'suspended') {
        return res.redirect('/auth/login?suspended=1');
    }
    req.saasUser = payload;   // { userId, username, role, accountStatus, exp }
    next();
}

/**
 * requireAdminRole — further restrict an already-authed user to role=admin.
 * Use AFTER requireUserAuth.
 */
function requireAdminRole(req, res, next) {
    if (!req.saasUser || req.saasUser.role !== 'admin') {
        return res.status(403).send('Access denied');
    }
    next();
}

module.exports = {
    // Password
    hashPassword,
    verifyPassword,
    // API key encryption
    encryptApiKey,
    decryptApiKey,
    // Tokens
    signUserToken,
    verifyUserToken,
    buildUserCookieHeader,
    clearUserCookieHeader,
    USER_COOKIE_NAME,
    USER_COOKIE_TTL,
    // Rate limiting
    loginRateLimiter,
    createRateLimiter,
    // Middleware
    requireUserAuth,
    requireAdminRole,
    // Util
    parseCookies,
};
