/*!
 * tools/check-dom.js —— 静态一致性检查
 * 用法：node tools/check-dom.js
 *
 * 检查内容：
 *   1. app.js 里 getElementById('x') 引用的每个 id，是否真的存在于对应 HTML
 *   2. HTML 中是否还残留 CDN 依赖或未替换的图标字体 class
 *   3. 引用的外部资源文件是否真实存在
 *
 * 这类错误在浏览器里表现为「点了没反应」或「控制台报 null」，很难靠肉眼发现。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let problems = 0;

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function exists(p) { return fs.existsSync(path.join(ROOT, p)); }

function collectHtmlIds(html) {
    const ids = new Set();
    const re = /\bid\s*=\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(html))) ids.add(m[1]);
    return ids;
}

/**
 * 收集 JS 中动态创建的 id（形如 modalDiv.innerHTML = `... id="xxx" ...`）。
 * 这类元素不在静态 HTML 里，但运行时确实存在，不能误报为缺失。
 */
function collectJsDefinedIds(js) {
    const ids = new Set();
    const re = /\bid\s*=\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(js))) ids.add(m[1]);
    return ids;
}

/** 收集 getElementById('x') / el('x') 中的字面量 id */
function collectJsIdRefs(js) {
    const refs = new Map(); // id -> [line...]
    const lines = js.split(/\r?\n/);
    const patterns = [
        /getElementById\(\s*['"]([^'"]+)['"]\s*\)/g,
        /\bel\(\s*['"]([^'"]+)['"]\s*\)/g
    ];
    lines.forEach((line, i) => {
        patterns.forEach(p => {
            const re = new RegExp(p.source, 'g');
            let m;
            while ((m = re.exec(line))) {
                if (!refs.has(m[1])) refs.set(m[1], []);
                if (refs.get(m[1]).indexOf(i + 1) === -1) refs.get(m[1]).push(i + 1);
            }
        });
    });
    return refs;
}

function checkPage(name, htmlPath, jsPath) {
    console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(0, 46 - name.length)));
    if (!exists(htmlPath) || !exists(jsPath)) {
        console.log('  ✗ 文件缺失: ' + htmlPath + ' / ' + jsPath);
        problems++;
        return;
    }
    const html = read(htmlPath);
    const js = read(jsPath);
    const htmlIds = collectHtmlIds(html);
    const jsIds = collectJsDefinedIds(js);
    const allIds = new Set([...htmlIds, ...jsIds]);
    const refs = collectJsIdRefs(js);

    let missing = 0;
    refs.forEach((linesAt, id) => {
        if (!allIds.has(id)) {
            console.log('  ✗ 引用了不存在的 id: "' + id + '"（第 ' + linesAt.join(', ') + ' 行）');
            missing++;
        }
    });
    console.log('  · HTML 定义 id ' + htmlIds.size + ' 个 + JS 动态创建 ' + jsIds.size
        + ' 个；代码引用 ' + refs.size + ' 个，缺失 ' + missing + ' 个');
    problems += missing;

    // CDN 残留
    const cdn = html.match(/https?:\/\/cdn\.[^\s"']+/g);
    if (cdn) {
        console.log('  ✗ 仍存在 CDN 依赖（会破坏离线/内网可用性）:');
        [...new Set(cdn)].forEach(u => console.log('      ' + u));
        problems += cdn.length;
    } else {
        console.log('  · 无 CDN 依赖 ✓');
    }

    // 图标字体残留
    const icons = html.match(/class="ti ti-[^"]*"/g);
    if (icons) {
        console.log('  ✗ 仍存在未替换的 tabler 图标: ' + [...new Set(icons)].join(', '));
        problems += icons.length;
    } else {
        console.log('  · 无图标字体依赖 ✓');
    }

    // 外部资源存在性
    const srcs = [...html.matchAll(/(?:src|href)\s*=\s*["'](?!https?:|mailto:|#)([^"']+)["']/g)].map(m => m[1]);
    srcs.forEach(s => {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(htmlPath), s));
        if (!exists(resolved)) {
            console.log('  ✗ 引用的本地资源不存在: ' + s + '（解析为 ' + resolved + '）');
            problems++;
        }
    });
    console.log('  · 本地资源引用 ' + srcs.length + ' 个，全部存在性已校验');
}

console.log('静态一致性检查');

checkPage('注塑件 injection', 'injection/index.html', 'injection/app.js');
checkPage('冲压件 stamping', 'stamping/index.html', 'stamping/app.js');

// 落地页
console.log('\n── 落地页 index.html ' + '─'.repeat(28));
{
    const html = read('index.html');
    const cdn = html.match(/https?:\/\/cdn\.[^\s"']+/g);
    if (cdn) { console.log('  ✗ 落地页仍有 CDN 依赖: ' + cdn.join(', ')); problems += cdn.length; }
    else console.log('  · 无 CDN 依赖 ✓');
    const links = [...html.matchAll(/href\s*=\s*["'](?!https?:|mailto:|#)([^"']+)["']/g)].map(m => m[1]);
    links.forEach(s => {
        if (!exists(s)) { console.log('  ✗ 落地页链接指向不存在的文件: ' + s); problems++; }
    });
    console.log('  · 内部链接 ' + links.length + ' 个，全部存在 ✓');
}

console.log('\n' + '═'.repeat(52));
if (problems) {
    console.log('发现 ' + problems + ' 处问题');
    process.exit(1);
} else {
    console.log('✅ 静态检查全部通过');
}
