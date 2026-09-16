/*!
 * tools/serve.js —— 零依赖本地静态服务器
 *
 * 用途：本地预览 / 内网共享。
 * 为什么需要它：子页面通过相对路径加载 ../assets/*.js，
 * 且 localStorage 需要非 opaque 源，所以不能直接 file:// 打开子页面。
 *
 * 用法：
 *   node tools/serve.js            # 默认 5178 端口
 *   node tools/serve.js 8080       # 指定端口
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const START_PORT = parseInt(process.argv[2], 10) || 5178;

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
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8'
};

function send(res, code, body, type) {
    res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8' });
    res.end(body);
}

const server = http.createServer((req, res) => {
    let rel;
    try {
        rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    } catch (e) {
        return send(res, 400, 'Bad Request');
    }

    // 防目录穿越
    const target = path.normalize(path.join(ROOT, rel));
    if (!target.startsWith(ROOT)) return send(res, 403, 'Forbidden');

    let file = target;
    try {
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
            file = path.join(file, 'index.html');
        }
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

server.on('error', err => {
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

server.listen(port, '127.0.0.1', () => {
    const base = 'http://127.0.0.1:' + port;
    console.log('');
    console.log('  汽车成本计算工具箱 —— 本地服务已启动');
    console.log('  ─────────────────────────────────────────────');
    console.log('  落地页    ' + base + '/');
    console.log('  注塑件    ' + base + '/injection/index.html');
    console.log('  冲压件    ' + base + '/stamping/index.html');
    console.log('  ─────────────────────────────────────────────');
    console.log('  根目录：' + ROOT);
    console.log('  按 Ctrl+C 停止');
    console.log('');
});
