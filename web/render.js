'use strict';
/**
 * ApexIQ · render.js
 * Reads an HTML view file, injects window.__DATA__ as JSON,
 * and automatically adds Open Graph / SEO meta tags to every page
 * so Google search preview shows correct title, description, logo.
 *
 * Author: Shehan Vimukthi
 */

const fs   = require('fs');
const path = require('path');

const VIEWS_DIR  = path.join(__dirname, 'public', 'views');
const SITE_URL   = process.env.SITE_URL || 'https://apexiq.trading';
const SITE_NAME  = 'ApexIQ';
const SITE_AUTHOR = 'Shehan Vimukthi';
const SITE_DESC  = 'ApexIQ — AI-powered crypto trading intelligence. Real-time market analysis, 70-factor signal scanning, paper trading and automated alerts.';
const OG_IMAGE   = `${SITE_URL}/logo.svg`;

// Per-view title + description overrides
const PAGE_META = {
    'public/landing':  { title: 'ApexIQ — AI-Powered Crypto Trading Platform', description: SITE_DESC },
    'public/privacy':  { title: 'Privacy Policy · ApexIQ', description: 'Privacy policy for ApexIQ.' },
    'public/terms':    { title: 'Terms of Service · ApexIQ', description: 'Terms of service for ApexIQ.' },
    'auth/login':      { title: 'Sign In · ApexIQ', description: 'Sign in to your ApexIQ account.' },
    'auth/register':   { title: 'Create Account · ApexIQ', description: 'Join ApexIQ — AI crypto trading intelligence.' },
    'app/scanner':     { title: 'Scanner · ApexIQ', description: 'AI-powered 70-factor crypto signal scanner.' },
    'app/paper':       { title: 'Paper Trading · ApexIQ', description: 'Simulate futures trades risk-free with ApexIQ.' },
    'app/home':        { title: 'Dashboard · ApexIQ', description: 'Your ApexIQ real-time trading dashboard.' },
    'app/backtest':    { title: 'Backtest · ApexIQ', description: 'Strategy backtesting on ApexIQ.' },
    'app/brain':       { title: 'Predictive Brain · ApexIQ', description: 'AI-powered predictive SMC trading signals with Auto-Pilot strategy selection.' },
    'app/stats':       { title: 'Stats · ApexIQ', description: 'Trading performance stats on ApexIQ.' },
    'app/datalake':    { title: 'Data Lake · ApexIQ', description: 'Local historical OHLCV data lake for AI-powered crypto analysis.' },
    'admin/dashboard': { title: 'Admin · ApexIQ', description: 'ApexIQ admin dashboard.' },
};

function buildOGMeta(viewPath, reqUrl) {
    const m     = PAGE_META[viewPath] || {};
    const title = m.title       || 'ApexIQ — AI Trading Intelligence';
    const desc  = m.description || SITE_DESC;
    const url   = reqUrl ? `${SITE_URL}${reqUrl}` : SITE_URL;

    return `
  <!-- ── ApexIQ SEO & Open Graph (auto-injected by render.js) ── -->
  <meta name="author"            content="${SITE_AUTHOR}">
  <meta name="application-name" content="${SITE_NAME}">
  <meta name="theme-color"      content="#00e5ff">
  <meta name="description"      content="${desc}">
  <link rel="canonical"         href="${url}">
  <!-- Open Graph — controls Google / Discord / WhatsApp preview -->
  <meta property="og:type"        content="website">
  <meta property="og:site_name"   content="${SITE_NAME}">
  <meta property="og:title"       content="${title}">
  <meta property="og:description" content="${desc}">
  <meta property="og:url"         content="${url}">
  <meta property="og:image"       content="${OG_IMAGE}">
  <!-- Twitter / X Card -->
  <meta name="twitter:card"        content="summary">
  <meta name="twitter:title"       content="${title}">
  <meta name="twitter:description" content="${desc}">
  <meta name="twitter:image"       content="${OG_IMAGE}">
  <!-- ── end SEO ── -->`;
}

function renderView(viewPath, data = {}, reqUrl = '') {
    const fullPath = path.join(VIEWS_DIR, viewPath + '.html');
    let html;
    try {
        html = fs.readFileSync(fullPath, 'utf8');
    } catch (e) {
        return `<!DOCTYPE html><html><body><pre style="color:red;padding:40px">
View not found: ${viewPath}.html\n${e.message}
        </pre></body></html>`;
    }

    // Safety-net: replace any remaining old name references in HTML
    html = html
        .replace(/Apex-MD/g,  'ApexIQ')
        .replace(/APEX-MD/g,  'APEXIQ')
        .replace(/apex-md/g,  'apexiq')
        .replace(/apextradingfree\.duckdns\.org/g, 'apexiq.trading')
        .replace(/apextradingfree/g, 'apexiq');

    // Inject data script
    const json       = JSON.stringify(data).replace(/<\/script>/gi, '<\\/script>');
    const dataScript = `<script>window.__DATA__=${json};</script>`;

    // Inject OG meta + data into </head>
    const ogMeta = buildOGMeta(viewPath, reqUrl);
    if (html.includes('</head>')) {
        return html.replace('</head>', `${ogMeta}\n${dataScript}\n</head>`);
    }
    return html.replace('<body>', `<body>${dataScript}`);
}

module.exports = { renderView };
