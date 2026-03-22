'use strict';
/**
 * APEX-MD · render.js
 * Reads an HTML view file and injects window.__DATA__ as JSON.
 * Supports server-side includes: <!--INCLUDE:app/analysis-detail-->
 */

const fs   = require('fs');
const path = require('path');

const VIEWS_DIR = path.join(__dirname, 'public', 'views');

function renderView(viewPath, data = {}) {
    const fullPath = path.join(VIEWS_DIR, viewPath + '.html');
    let html;
    try {
        html = fs.readFileSync(fullPath, 'utf8');
    } catch (e) {
        return `<!DOCTYPE html><html><body><pre style="color:red;padding:40px">\nView not found: ${viewPath}.html\n${e.message}\n        </pre></body></html>`;
    }

    // Server-side includes: <!--INCLUDE:app/analysis-detail-->
    html = html.replace(/<!--INCLUDE:([^-]+)-->/g, (_, incPath) => {
        try {
            return fs.readFileSync(path.join(VIEWS_DIR, incPath.trim() + '.html'), 'utf8');
        } catch (e) {
            return `<!-- Include failed: ${incPath} -->`;
        }
    });

    const json   = JSON.stringify(data).replace(/<\/script>/gi, '<\\/script>');
    const inject = `<script>window.__DATA__=${json};</script>`;
    if (html.includes('</head>')) return html.replace('</head>', inject + '</head>');
    return html.replace('<body>', '<body>' + inject);
}

module.exports = { renderView };
