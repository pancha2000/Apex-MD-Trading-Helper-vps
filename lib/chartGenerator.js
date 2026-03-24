'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ApexIQ  ·  lib/chartGenerator.js  ·  Visual Signal Chart Engine
 * ─────────────────────────────────────────────────────────────────────────
 *  Generates a professional trading chart PNG for WhatsApp/Telegram delivery.
 *
 *  Architecture:
 *  ─────────────
 *  Puppeteer launches a headless Chromium, renders a self-contained HTML
 *  page that draws a candlestick chart using the HTML5 Canvas API, then
 *  screenshots it to a Buffer.  No heavy native bindings (node-canvas)
 *  required — only puppeteer-core or puppeteer.
 *
 *  What gets drawn (in z-order):
 *  ──────────────────────────────
 *  1. Dark grid background          — atmosphere / readability
 *  2. Volume bars (bottom 18%)      — context for institutional moves
 *  3. EMA 21 (cyan)                 — short-term trend bias
 *  4. EMA 50 (orange)               — medium-term trend bias
 *  5. Major Support / Resistance    — Yellow horizontal line (getKeyLevels)
 *  6. FVG shaded zones (blue/red)   — Fair Value Gaps (why price may revisit)
 *  7. Order Block rectangles        — Bullish (blue) / Bearish (purple)
 *  8. OHLCV candlesticks            — core price action
 *  9. Entry line    (white dashed)  — trader's precise entry
 * 10. Take-Profit lines (green)     — TP1, TP2 with labels
 * 11. Stop-Loss line  (red)         — invalidation level
 * 12. Price label badge             — live price callout
 * 13. HUD overlay                  — coin, timeframe, score, direction badge
 * ═══════════════════════════════════════════════════════════════════════════
 */

const fs   = require('fs');
const path = require('path');

// ─── Graceful puppeteer import ─────────────────────────────────────────────
let puppeteer;
try {
    puppeteer = require('puppeteer');
} catch (_) {
    try { puppeteer = require('puppeteer-core'); } catch (_2) {
        throw new Error(
            '[chartGenerator] puppeteer not installed.\n' +
            'Run: npm install puppeteer\n' +
            'Or for lighter install: npm install puppeteer-core chromium'
        );
    }
}

// ─── Chart dimensions ─────────────────────────────────────────────────────
const CHART_W        = 1200;   // px — wide enough for WhatsApp full-width
const CHART_H        = 680;    // px
const PADDING_LEFT   = 68;     // space for Y-axis price labels
const PADDING_RIGHT  = 20;
const PADDING_TOP    = 60;     // HUD space
const PADDING_BOTTOM = 110;    // volume bars + X labels
const VOL_HEIGHT_PCT = 0.18;   // volume panel is 18% of total chart area

// ─── Colours (matches ApexIQ brand vars) ──────────────────────────────────
const COLORS = {
    bg:          '#060d17',
    bgPanel:     '#0b1828',
    grid:        'rgba(28,51,73,0.55)',
    bullCandle:  '#00e676',
    bearCandle:  '#ff3355',
    wickBull:    '#00c853',
    wickBear:    '#c62828',
    ema21:       '#00c8ff',
    ema50:       '#ffab00',
    entry:       '#ffffff',
    tp:          '#00e676',
    sl:          '#ff3355',
    sr:          '#ffd600',           // support / resistance — yellow
    fvgBull:     'rgba(0,200,255,0.13)',
    fvgBear:     'rgba(255,51,85,0.11)',
    fvgBullBrd:  'rgba(0,200,255,0.45)',
    fvgBearBrd:  'rgba(255,51,85,0.38)',
    obBull:      'rgba(0,120,255,0.15)',
    obBear:      'rgba(180,0,255,0.14)',
    obBullBrd:   'rgba(0,120,255,0.6)',
    obBearBrd:   'rgba(180,0,255,0.55)',
    volUp:       'rgba(0,230,118,0.35)',
    volDown:     'rgba(255,51,85,0.30)',
    text:        '#d6eeff',
    text2:       '#5c87a8',
    hud:         'rgba(6,13,23,0.88)',
};

// ─────────────────────────────────────────────────────────────────────────
//  INDICATOR HELPERS  (pure-math, browser-side versions)
//  These run inside the HTML page's <script> block so they don't depend
//  on node modules — Puppeteer injects them via page.evaluate().
// ─────────────────────────────────────────────────────────────────────────

/**
 * Calculate EMA array from a series of close prices.
 * @param {number[]} closes
 * @param {number}   period
 * @returns {number[]}  same length as closes (first period-1 values are 0)
 */
function _calcEMAArr(closes, period) {
    const k   = 2 / (period + 1);
    const out  = new Array(closes.length).fill(0);
    let sum = 0;
    for (let i = 0; i < period && i < closes.length; i++) sum += closes[i];
    let ema = sum / period;
    out[period - 1] = ema;
    for (let i = period; i < closes.length; i++) {
        ema = (closes[i] - ema) * k + ema;
        out[i] = ema;
    }
    return out;
}

/**
 * Find the dominant Support / Resistance level closest to a reference price
 * by counting how many candle highs/lows cluster near each price level.
 * Returns the single most-tested level.
 */
function _findKeyLevel(candles, refPrice) {
    const levels = {};
    const BUCKET = 0.003; // 0.3% bucket width

    for (const c of candles) {
        for (const price of [c.high, c.low]) {
            const bucket = Math.round(price / (refPrice * BUCKET));
            levels[bucket] = (levels[bucket] || 0) + 1;
        }
    }

    // Find the bucket with the most touches (excluding current price ±0.5%)
    let bestBucket = null, bestCount = 0;
    for (const [b, cnt] of Object.entries(levels)) {
        const lvlPrice = parseInt(b) * refPrice * BUCKET;
        if (Math.abs(lvlPrice - refPrice) / refPrice < 0.005) continue; // skip current price
        if (cnt > bestCount) { bestCount = cnt; bestBucket = b; }
    }
    return bestBucket ? parseInt(bestBucket) * refPrice * BUCKET : null;
}

// ─────────────────────────────────────────────────────────────────────────
//  MAIN EXPORT — generateSignalChart()
// ─────────────────────────────────────────────────────────────────────────

/**
 * Generate a PNG chart buffer for a triggered signal.
 *
 * @param {object}   opts
 * @param {string}     opts.coin         — e.g. 'BTCUSDT'
 * @param {string}     opts.timeframe    — e.g. '15m'
 * @param {string}     opts.direction    — 'LONG' | 'SHORT'
 * @param {number}     opts.entry        — entry price
 * @param {number}     opts.tp1          — take profit 1
 * @param {number}     opts.tp2          — take profit 2 (optional)
 * @param {number}     opts.sl           — stop loss
 * @param {number}     opts.score        — signal score (0–100)
 * @param {Array[]}    opts.candles      — Binance OHLCV arrays [time,o,h,l,c,v]
 * @param {object[]}   [opts.orderBlocks]— [{ type:'bullish'|'bearish', high, low }]
 * @param {object[]}   [opts.fvgs]       — [{ type:'bull'|'bear', upper, lower }]
 * @param {string}     [opts.reasons]    — brief signal reasoning text
 * @param {string}     [opts.outputPath] — if provided, saves PNG to disk too
 *
 * @returns {Promise<Buffer>}  PNG image buffer
 */
async function generateSignalChart(opts) {
    const {
        coin, timeframe, direction, entry, tp1, tp2, sl, score,
        candles: rawCandles, orderBlocks = [], fvgs = [],
        reasons = '', outputPath = null,
    } = opts;

    if (!rawCandles || rawCandles.length < 20) {
        throw new Error('[chartGenerator] Need at least 20 candles');
    }

    // ── 1. Normalise candle data to objects ────────────────────────────────
    //  Binance returns arrays: [openTime, open, high, low, close, volume, ...]
    const candles = rawCandles.slice(-70).map(c => ({
        time:   parseInt(c[0]),
        open:   parseFloat(c[1]),
        high:   parseFloat(c[2]),
        low:    parseFloat(c[3]),
        close:  parseFloat(c[4]),
        volume: parseFloat(c[5]),
    }));

    // ── 2. Compute indicators server-side (passed to page as JSON) ─────────
    const closes  = candles.map(c => c.close);
    const ema21   = _calcEMAArr(closes, 21);
    const ema50   = _calcEMAArr(closes, 50);
    const srLevel = _findKeyLevel(candles, closes[closes.length - 1]);

    // ── 3. Build self-contained HTML page ─────────────────────────────────
    const pageHTML = _buildChartHTML({
        coin, timeframe, direction, entry, tp1, tp2, sl, score, reasons,
        candles, ema21, ema50, srLevel, orderBlocks, fvgs,
    });

    // ── 4. Launch Puppeteer, render, screenshot ────────────────────────────
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',  // needed for VPS low-RAM environments
                '--disable-gpu',
                `--window-size=${CHART_W},${CHART_H}`,
            ],
        });

        const page = await browser.newPage();
        await page.setViewport({ width: CHART_W, height: CHART_H, deviceScaleFactor: 1.5 });
        await page.setContent(pageHTML, { waitUntil: 'networkidle0' });

        // Wait for the canvas drawing to complete
        await page.waitForFunction(() => window.__chartDone === true, { timeout: 8000 });

        const buffer = await page.screenshot({
            type:     'png',
            clip:     { x: 0, y: 0, width: CHART_W, height: CHART_H },
            omitBackground: false,
        });

        if (outputPath) {
            fs.writeFileSync(outputPath, buffer);
        }

        return buffer;

    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// ─────────────────────────────────────────────────────────────────────────
//  HTML PAGE BUILDER
//  Generates a complete self-contained HTML page.
//  All chart rendering happens in a <script> block inside the page so
//  Puppeteer can screenshot it after the Canvas has been painted.
// ─────────────────────────────────────────────────────────────────────────

function _buildChartHTML(d) {
    const isLong  = d.direction === 'LONG';
    const dirColor = isLong ? COLORS.tp : COLORS.sl;
    const dirLabel = isLong ? 'LONG ▲' : 'SHORT ▼';

    // Serialise data for the browser script
    const DATA = JSON.stringify({
        candles:     d.candles,
        ema21:       d.ema21,
        ema50:       d.ema50,
        srLevel:     d.srLevel,
        orderBlocks: d.orderBlocks,
        fvgs:        d.fvgs,
        entry:       d.entry,
        tp1:         d.tp1,
        tp2:         d.tp2 || null,
        sl:          d.sl,
        isLong:      isLong,
    });

    return /* html */`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${CHART_W}px; height:${CHART_H}px; background:${COLORS.bg}; overflow:hidden; }
  canvas { display:block; }
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Syne:wght@700;800&display=swap');
</style>
</head>
<body>
<canvas id="c" width="${CHART_W}" height="${CHART_H}"></canvas>
<script>
// ── Data injected by Node.js ────────────────────────────────────────────
const DATA = ${DATA};
const C    = ${JSON.stringify(COLORS)};
const W    = ${CHART_W}, H = ${CHART_H};
const PL   = ${PADDING_LEFT}, PR = ${PADDING_RIGHT};
const PT   = ${PADDING_TOP},  PB = ${PADDING_BOTTOM};
const VH_PCT = ${VOL_HEIGHT_PCT};

// ── Chart geometry ──────────────────────────────────────────────────────
const chartX  = PL;
const chartY  = PT;
const chartW  = W - PL - PR;
const chartH  = H - PT - PB;
const volH    = chartH * VH_PCT;
const priceH  = chartH - volH;

// ── Canvas context ──────────────────────────────────────────────────────
const canvas = document.getElementById('c');
const ctx    = canvas.getContext('2d');

// ── Price domain ────────────────────────────────────────────────────────
const allPrices = DATA.candles.flatMap(c => [c.high, c.low]);
// Include signal lines in domain so they're always visible
[DATA.entry, DATA.tp1, DATA.tp2, DATA.sl].forEach(p => { if(p) allPrices.push(p); });
DATA.orderBlocks.forEach(ob => { allPrices.push(ob.high, ob.low); });
DATA.fvgs.forEach(f => { allPrices.push(f.upper, f.lower); });
if (DATA.srLevel) allPrices.push(DATA.srLevel);

const domMin = Math.min(...allPrices) * 0.9985;
const domMax = Math.max(...allPrices) * 1.0015;
const domRange = domMax - domMin;

// ── Coordinate mappers ──────────────────────────────────────────────────
const toY  = price => chartY + priceH - ((price - domMin) / domRange) * priceH;
const toX  = idx   => chartX + (idx / (DATA.candles.length - 1)) * chartW;
const volMax = Math.max(...DATA.candles.map(c => c.volume));
const toVolH = vol => (vol / volMax) * volH * 0.9;

// ── Price formatter ─────────────────────────────────────────────────────
function fmtP(n) {
    if (!n) return '—';
    if (n >= 10000) return n.toFixed(2);
    if (n >= 1)     return n.toFixed(4);
    return n.toFixed(6);
}

// ════════════════════════════════════════════════════════════════════════
//  DRAW FUNCTIONS
// ════════════════════════════════════════════════════════════════════════

// ── Background ──────────────────────────────────────────────────────────
function drawBackground() {
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    // Grid lines (price)
    ctx.strokeStyle = C.grid;
    ctx.lineWidth   = 0.5;
    const steps = 7;
    for (let i = 0; i <= steps; i++) {
        const y = chartY + (i / steps) * priceH;
        ctx.beginPath(); ctx.moveTo(chartX, y); ctx.lineTo(chartX + chartW, y); ctx.stroke();
        const price = domMax - (i / steps) * domRange;
        ctx.fillStyle  = C.text2;
        ctx.font       = '11px JetBrains Mono, monospace';
        ctx.textAlign  = 'right';
        ctx.fillText(fmtP(price), chartX - 4, y + 4);
    }
    // Vertical grid (time)
    const vSteps = 8;
    for (let i = 0; i <= vSteps; i++) {
        const x = chartX + (i / vSteps) * chartW;
        ctx.beginPath(); ctx.moveTo(x, chartY); ctx.lineTo(x, chartY + priceH + volH); ctx.stroke();
        const idx = Math.round((i / vSteps) * (DATA.candles.length - 1));
        if (DATA.candles[idx]) {
            const d   = new Date(DATA.candles[idx].time);
            const lbl = \`\${d.getMonth()+1}/\${d.getDate()} \${String(d.getHours()).padStart(2,'0')}:\${String(d.getMinutes()).padStart(2,'0')}\`;
            ctx.fillStyle = C.text2;
            ctx.textAlign = 'center';
            ctx.font      = '10px JetBrains Mono, monospace';
            ctx.fillText(lbl, x, chartY + priceH + volH + 16);
        }
    }
}

// ── Volume bars ──────────────────────────────────────────────────────────
function drawVolume() {
    const barW = Math.max(1, (chartW / DATA.candles.length) * 0.7);
    DATA.candles.forEach((c, i) => {
        const x  = toX(i);
        const bh = toVolH(c.volume);
        const y  = chartY + priceH + volH - bh;
        ctx.fillStyle = c.close >= c.open ? C.volUp : C.volDown;
        ctx.fillRect(x - barW / 2, y, barW, bh);
    });
}

// ── EMA lines ────────────────────────────────────────────────────────────
function drawEMA(emaArr, color, label, dashed = false) {
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.setLineDash(dashed ? [5, 4] : []);
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    let started = false;
    emaArr.forEach((v, i) => {
        if (!v) return;
        if (!started) { ctx.moveTo(toX(i), toY(v)); started = true; }
        else            ctx.lineTo(toX(i), toY(v));
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // Label at right edge
    const lastVal = [...emaArr].reverse().find(v => v > 0);
    if (lastVal) {
        ctx.fillStyle = color;
        ctx.font      = '11px JetBrains Mono, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(label, chartX + chartW + 3, toY(lastVal) + 4);
    }
}

// ── Fair Value Gaps ───────────────────────────────────────────────────────
//  FVGs represent imbalances where price moved so fast that no transactions
//  occurred in the gap. Price tends to revisit (fill) these zones.
//  Visual: shaded rectangle spanning the full visible chart width.
function drawFVGs() {
    DATA.fvgs.forEach(fvg => {
        const y1 = toY(fvg.upper);
        const y2 = toY(fvg.lower);
        const h  = Math.abs(y2 - y1);
        const isBull = fvg.type === 'bull' || fvg.type === 'bullish';

        // Filled rectangle
        ctx.fillStyle   = isBull ? C.fvgBull : C.fvgBear;
        ctx.fillRect(chartX, Math.min(y1, y2), chartW, h);

        // Dashed border top & bottom to emphasise zone boundaries
        ctx.strokeStyle = isBull ? C.fvgBullBrd : C.fvgBearBrd;
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 4]);
        [y1, y2].forEach(y => {
            ctx.beginPath();
            ctx.moveTo(chartX, y);
            ctx.lineTo(chartX + chartW, y);
            ctx.stroke();
        });
        ctx.setLineDash([]);

        // Label
        ctx.fillStyle = isBull ? C.fvgBullBrd : C.fvgBearBrd;
        ctx.font      = 'bold 10px JetBrains Mono, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(isBull ? 'FVG ▲' : 'FVG ▼', chartX + 4, Math.min(y1, y2) - 3);
    });
}

// ── Order Blocks ──────────────────────────────────────────────────────────
//  OBs are the last opposing candle before a strong move. They represent
//  unfilled institutional orders — price frequently returns to these zones.
//  Visual: solid shaded rectangle with a distinct left edge accent bar.
function drawOrderBlocks() {
    DATA.orderBlocks.forEach(ob => {
        const isBull = ob.type === 'bullish';
        const y1 = toY(ob.high);
        const y2 = toY(ob.low);
        const h  = Math.abs(y2 - y1);
        const yTop = Math.min(y1, y2);

        // Main fill
        ctx.fillStyle = isBull ? C.obBull : C.obBear;
        ctx.fillRect(chartX, yTop, chartW, h);

        // Left-edge accent bar (3px wide)
        ctx.fillStyle = isBull ? C.obBullBrd : C.obBearBrd;
        ctx.fillRect(chartX, yTop, 3, h);

        // Solid border lines
        ctx.strokeStyle = isBull ? C.obBullBrd : C.obBearBrd;
        ctx.lineWidth   = 1;
        [y1, y2].forEach(y => {
            ctx.beginPath();
            ctx.moveTo(chartX + 3, y);
            ctx.lineTo(chartX + chartW, y);
            ctx.stroke();
        });

        // Label badge
        const badgeX = chartX + 8;
        const badgeY = yTop + h / 2;
        ctx.font        = 'bold 11px Syne, sans-serif';
        ctx.fillStyle   = isBull ? C.obBullBrd : C.obBearBrd;
        ctx.textAlign   = 'left';
        ctx.fillText(isBull ? '📦 Bullish OB' : '📦 Bearish OB', badgeX, badgeY + 4);
    });
}

// ── Support / Resistance ──────────────────────────────────────────────────
function drawSR() {
    if (!DATA.srLevel) return;
    const y = toY(DATA.srLevel);
    // Glow effect: draw same line 3x with decreasing opacity
    [0.08, 0.15, 0.6].forEach((alpha, i) => {
        ctx.strokeStyle = C.sr;
        ctx.lineWidth   = (3 - i) * 1.5;
        ctx.globalAlpha = alpha;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(chartX, y);
        ctx.lineTo(chartX + chartW, y);
        ctx.stroke();
    });
    ctx.globalAlpha = 1;
    // Label
    ctx.fillStyle = C.sr;
    ctx.font      = 'bold 11px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(\`S/R \${fmtP(DATA.srLevel)}\`, chartX + chartW - 6, y - 4);
}

// ── Candlesticks ──────────────────────────────────────────────────────────
function drawCandles() {
    const barW = Math.max(2, (chartW / DATA.candles.length) * 0.75);
    DATA.candles.forEach((c, i) => {
        const x    = toX(i);
        const yO   = toY(c.open);
        const yC   = toY(c.close);
        const yH   = toY(c.high);
        const yL   = toY(c.low);
        const bull = c.close >= c.open;
        const bodyH = Math.max(1, Math.abs(yO - yC));
        const bodyY = Math.min(yO, yC);

        // Wick
        ctx.strokeStyle = bull ? C.wickBull : C.wickBear;
        ctx.lineWidth   = Math.max(1, barW * 0.15);
        ctx.beginPath();
        ctx.moveTo(x, yH); ctx.lineTo(x, yL);
        ctx.stroke();

        // Body
        ctx.fillStyle = bull ? C.bullCandle : C.bearCandle;
        ctx.fillRect(x - barW / 2, bodyY, barW, bodyH);
    });
}

// ── Signal Lines ──────────────────────────────────────────────────────────
function drawSignalLine(price, color, label, dashed = true) {
    if (!price) return;
    const y = toY(price);

    // Glow underneath
    ctx.strokeStyle = color;
    ctx.lineWidth   = 4;
    ctx.globalAlpha = 0.12;
    ctx.beginPath(); ctx.moveTo(chartX, y); ctx.lineTo(chartX + chartW, y); ctx.stroke();

    // Main line
    ctx.globalAlpha = 1;
    ctx.lineWidth   = 1.5;
    ctx.setLineDash(dashed ? [8, 5] : []);
    ctx.beginPath(); ctx.moveTo(chartX, y); ctx.lineTo(chartX + chartW, y); ctx.stroke();
    ctx.setLineDash([]);

    // Label pill
    const PILL_W = 120, PILL_H = 20;
    const pillX  = chartX + chartW - PILL_W - 4;
    const pillY  = y - PILL_H / 2;
    ctx.fillStyle   = color;
    ctx.globalAlpha = 0.18;
    _roundRect(pillX, pillY, PILL_W, PILL_H, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1;
    _roundRect(pillX, pillY, PILL_W, PILL_H, 4);
    ctx.stroke();

    ctx.fillStyle  = color;
    ctx.font       = 'bold 11px JetBrains Mono, monospace';
    ctx.textAlign  = 'right';
    ctx.fillText(\`\${label}: \${fmtP(price)}\`, pillX + PILL_W - 6, y + 4);
}

function _roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// ── HUD Overlay ───────────────────────────────────────────────────────────
function drawHUD() {
    const isLong   = DATA.isLong;
    const dirColor = isLong ? C.tp : C.sl;
    const dirLabel = isLong ? 'LONG  ▲' : 'SHORT ▼';

    // Top bar background
    ctx.fillStyle   = C.hud;
    ctx.fillRect(0, 0, W, PT);

    // Coin + timeframe
    ctx.font      = 'bold 20px Syne, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText('${d.coin.replace('USDT', '')} / USDT', PL, 36);

    ctx.font      = '13px JetBrains Mono, monospace';
    ctx.fillStyle = C.text2;
    ctx.fillText('${d.timeframe.toUpperCase()}', PL + 148, 36);

    // Direction badge
    ctx.fillStyle   = dirColor;
    ctx.globalAlpha = 0.15;
    _roundRect(W / 2 - 70, 12, 140, 32, 6); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = dirColor; ctx.lineWidth = 1;
    _roundRect(W / 2 - 70, 12, 140, 32, 6); ctx.stroke();
    ctx.font      = 'bold 16px Syne, sans-serif';
    ctx.fillStyle = dirColor;
    ctx.textAlign = 'center';
    ctx.fillText(dirLabel, W / 2, 33);

    // Score badge (right side)
    ctx.textAlign = 'right';
    ctx.font      = 'bold 14px JetBrains Mono, monospace';
    ctx.fillStyle = C.ema21;
    ctx.fillText('Score: ${d.score}', W - PR - 4, 24);

    // Reasons text
    ctx.font      = '11px JetBrains Mono, monospace';
    ctx.fillStyle = C.text2;
    ctx.fillText(\`${d.reasons.slice(0, 80)}\`, W - PR - 4, 44);

    // ApexIQ watermark
    ctx.globalAlpha = 0.22;
    ctx.textAlign   = 'left';
    ctx.font        = 'bold 12px Syne, sans-serif';
    ctx.fillStyle   = C.text2;
    ctx.fillText('ApexIQ.trading', PL, H - 8);
    ctx.globalAlpha = 1;
}

// ══════════════════════════════════════════════════════════════════════════
//  RENDER PIPELINE
// ══════════════════════════════════════════════════════════════════════════
(function render() {
    try {
        drawBackground();
        drawVolume();
        drawEMA(DATA.ema50, C.ema50, 'EMA50');
        drawEMA(DATA.ema21, C.ema21, 'EMA21', true);
        drawFVGs();
        drawOrderBlocks();
        drawSR();
        drawCandles();
        // Signal lines (drawn on top of candles for maximum clarity)
        drawSignalLine(DATA.sl,    C.sl,    'SL',    false);
        drawSignalLine(DATA.entry, C.entry, 'Entry', true);
        drawSignalLine(DATA.tp1,   C.tp,    'TP1',   false);
        if (DATA.tp2) drawSignalLine(DATA.tp2, C.tp, 'TP2', false);
        drawHUD();
        window.__chartDone = true;   // signals Puppeteer we're done
    } catch(err) {
        document.body.style.background = 'red';
        document.body.innerText = err.message;
        window.__chartDone = true;
    }
})();
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────
//  UTILITY: send chart via WhatsApp (Baileys)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Helper: generate chart buffer and send as image via Baileys conn.
 * @param {object} conn        — Baileys connection
 * @param {string} jid         — recipient JID
 * @param {object} signalOpts  — same as generateSignalChart opts
 * @param {string} caption     — message caption
 */
async function sendChartToWhatsApp(conn, jid, signalOpts, caption = '') {
    const buffer = await generateSignalChart(signalOpts);
    await conn.sendMessage(jid, {
        image:    buffer,
        mimetype: 'image/png',
        caption:  caption || `📊 ${signalOpts.coin} ${signalOpts.direction} Chart\nEntry: $${signalOpts.entry}`,
    });
}

// ─────────────────────────────────────────────────────────────────────────

module.exports = {
    generateSignalChart,
    sendChartToWhatsApp,
    // Export helpers for unit tests
    _calcEMAArr,
    _findKeyLevel,
};
