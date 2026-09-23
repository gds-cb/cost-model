/*!
 * tools/serve.js —— 本地静态服务器 + 会员价格维护 API
 *
 * 用法：
 *   node tools/serve.js            # 默认 5178 端口
 *   node tools/serve.js 8080
 *
 * 除静态文件外，还提供三个本地 API（仅监听 127.0.0.1，外网访问不到）：
 *   GET  /api/craft-prices    读取 data/craft-prices.local.json 的当前价格
 *   POST /api/craft-prices    写入 data/craft-prices.local.json
 *   POST /api/build-member    重新构建（含会员版）
 *
 * ⚠️ 安全边界：只写 data/craft-prices.local.json 这一个文件，且服务只绑定本机回环地址。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const START_PORT = parseInt(process.argv[2], 10) || 5178;
const PRICES_FILE = path.join(ROOT, 'data', 'craft-prices.local.json');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json; charset=utf-8'
};

function sendJson(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
}

function send(res, code, body, type) {
    res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8' });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > 256 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/** 校验价格表：键必须是合法的 code，值必须是有限非负数字 */
function validatePrices(prices) {
    if (!prices || typeof prices !== 'object' || Array.isArray(prices)) return '价格表必须是对象';
    const bad = [];
    Object.keys(prices).forEach(k => {
        if (!/^[A-Za-z0-9_-]+$/.test(k)) { bad.push(k + '（键名非法）'); return; }
        const v = prices[k];
        if (v === null || v === '') return;                 // 允许清空
        if (typeof v !== 'number' || !isFinite(v) || v < 0) bad.push(k + '（值必须是 ≥0 的数字）');
    });
    if (bad.length) return '校验失败：' + bad.slice(0, 5).join('、');
    return null;
}

/* ---------- API 路由 ---------- */
async function handleApi(req, res, urlPath) {
    if (urlPath === '/api/craft-prices' && req.method === 'GET') {
        let prices = {};
        const exists = fs.existsSync(PRICES_FILE);
        if (exists) {
            try { prices = (JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8')) || {}).prices || {}; }
            catch (e) { return sendJson(res, 500, { ok: false, error: '本地价格文件解析失败：' + e.message }); }
        }
        return sendJson(res, 200, { ok: true, prices: prices, exists: exists });
    }

    if (urlPath === '/api/craft-prices' && req.method === 'POST') {
        let payload;
        try { payload = JSON.parse(await readBody(req)); }
        catch (e) { return sendJson(res, 400, { ok: false, error: '请求不是有效 JSON：' + e.message }); }

        const err = validatePrices(payload.prices);
        if (err) return sendJson(res, 400, { ok: false, error: err });

        let doc = {};
        if (fs.existsSync(PRICES_FILE)) {
            try { doc = JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8')) || {}; } catch (e) { doc = {}; }
        }
        doc.prices = payload.prices;
        doc._上次保存 = new Date().toLocaleString();

        try { fs.writeFileSync(PRICES_FILE, JSON.stringify(doc, null, 2), 'utf8'); }
        catch (e) { return sendJson(res, 500, { ok: false, error: '写入失败：' + e.message }); }

        const n = Object.keys(payload.prices).filter(k => payload.prices[k] !== null && payload.prices[k] !== '').length;
        console.log('  💾 已保存 ' + n + ' 项会员价格 → data/craft-prices.local.json');
        return sendJson(res, 200, { ok: true, saved: n, file: 'data/craft-prices.local.json' });
    }

    if (urlPath === '/api/build-member' && req.method === 'POST') {
        try {
            delete require.cache[require.resolve('./build-site.js')];
            const B = require('./build-site.js');
            const logs = [];
            const origLog = console.log, origWarn = console.warn;
            console.log = function () { logs.push([].join.call(arguments, ' ')); origLog.apply(null, arguments); };
            console.warn = function () { logs.push([].join.call(arguments, ' ')); origWarn.apply(null, arguments); };
            try { B.build({ member: true }); } finally { console.log = origLog; console.warn = origWarn; }
            return sendJson(res, 200, { ok: true, log: logs.join('\n') });
        } catch (e) {
            return sendJson(res, 500, { ok: false, error: e.message });
        }
    }

    return sendJson(res, 404, { ok: false, error: '未知接口：' + urlPath });
}

/* ---------- 主服务 ---------- */
const server = http.createServer(function (req, res) {
    let rel;
    try { rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]); }
    catch (e) { return send(res, 400, 'Bad Request'); }

    if (rel.indexOf('/api/') === 0) {
        handleApi(req, res, rel).catch(e => sendJson(res, 500, { ok: false, error: e.message }));
        return;
    }

    const target = path.normalize(path.join(ROOT, rel));
    if (!target.startsWith(ROOT)) return send(res, 403, 'Forbidden');

    let file = target;
    try {
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
            console.log('404 ' + req.method + ' ' + rel);
            return send(res, 404, 'Not Found: ' + rel);
        }
        const body = fs.readFileSync(file);
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store'
        });
        res.end(body);
        console.log('200 ' + req.method + ' ' + rel);
    } catch (e) {
        console.error('500 ' + rel + ' — ' + e.message);
        send(res, 500, 'Internal Error');
    }
});

let port = START_PORT;
let attempts = 0;

server.on('error', function (err) {
    if (err.code === 'EADDRINUSE' && attempts < 20) {
        attempts++;
        port++;
        console.log('端口 ' + (port - 1) + ' 被占用，尝试 ' + port + ' …');
        server.listen(port, '127.0.0.1');
    } else {
        console.error('启动失败：' + err.message);
        process.exit(1);
    }
});

server.listen(port, '127.0.0.1', function () {
    const base = 'http://127.0.0.1:' + port;
    console.log('');
    console.log('  汽车成本工具箱 —— 本地服务已启动');
    console.log('  ─────────────────────────────────────────────');
    console.log('  落地页    ' + base + '/');
    console.log('  材料库    ' + base + '/materials/index.html');
    console.log('  工艺库    ' + base + '/craft/index.html');
    console.log('  知识库    ' + base + '/kb/index.html');
    console.log('  交流社区  ' + base + '/community/index.html');
    console.log('  注塑件    ' + base + '/injection/index.html');
    console.log('  冲压件    ' + base + '/stamping/index.html');
    console.log('  ─────────────────────────────────────────────');
    console.log('  🔧 会员价格维护  ' + base + '/_admin/index.html');
    console.log('  ─────────────────────────────────────────────');
    console.log('  根目录：' + ROOT);
    console.log('  按 Ctrl+C 停止');
    console.log('');
});
