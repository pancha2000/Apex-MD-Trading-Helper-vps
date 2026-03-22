/**
 * APEX-MD · ecosystem.config.js
 * ══════════════════════════════════════════════════════
 *  PM2 dual-process setup:
 *   • ApexDash  — Dashboard (3000 port) — always up
 *   • ApexBot   — WhatsApp bot          — restarts on crash
 *
 *  Setup (first time):
 *    pm2 delete ApexBot ApexDash 2>/dev/null
 *    pm2 start ecosystem.config.js
 *    pm2 save
 *
 *  Individual restart:
 *    pm2 restart ApexDash   ← dashboard only
 *    pm2 restart ApexBot    ← bot only
 * ══════════════════════════════════════════════════════
 */

module.exports = {
    apps: [
        {
            // ── Dashboard (standalone, always up) ──────────────────
            name:             'ApexDash',
            script:           'web-server.js',
            watch:            false,
            max_restarts:     10,
            restart_delay:    3000,
            exp_backoff_restart_delay: 2000,
            error_file:       '/home/ubuntu/.pm2/logs/ApexDash-error.log',
            out_file:         '/home/ubuntu/.pm2/logs/ApexDash-out.log',
            env: {
                NODE_ENV: 'production',
            },
        },
        {
            // ── Bot (WhatsApp + plugins) ────────────────────────────
            name:             'ApexBot',
            script:           'index.js',
            watch:            false,
            max_restarts:     20,           // infinite crash loop වළකන්නා
            restart_delay:    5000,
            exp_backoff_restart_delay: 3000,
            error_file:       '/home/ubuntu/.pm2/logs/ApexBot-error.log',
            out_file:         '/home/ubuntu/.pm2/logs/ApexBot-out.log',
            env: {
                NODE_ENV: 'production',
            },
        },
    ],
};
