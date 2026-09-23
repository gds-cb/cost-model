/*!
 * tools/build-site.js —— 静态站点生成器（零依赖）
 *
 * 用法：node tools/build-site.js
 *
 * 生成：
 *   materials/index.html          材料价格库列表页（带搜索/筛选）
 *   materials/<slug>.html         每个牌号的详情页（SEO 长尾）
 *   kb/index.html                 知识库列表页
 *   kb/<slug>.html                文章详情页
 *   sitemap.xml                   站点地图
 *
 * 数据来源：
 *   data/materials.json           材料数据
 *   content/*.md                  文章（Markdown + front matter）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITE_URL = 'https://gds-cb.github.io/cost-model';
const SITE_NAME = '汽车成本工具箱';

/* ============================================================
 * 0. 通用工具
 * ============================================================ */

function esc(s) {
    return String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 生成 URL 安全的 slug：HC340/590DP → hc340-590dp */
function slugify(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'item';
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function writeFile(rel, html) {
    const full = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, html, 'utf8');
    return html.length;
}

/* ============================================================
 * 1. 极简 Markdown 渲染器（只支持我们实际会用的语法）
 *    支持：标题 / 段落 / 粗体 / 斜体 / 行内代码 / 代码块 /
 *          无序列表 / 有序列表 / 引用 / 表格 / 分隔线 / 链接
 * ============================================================ */

function inline(s) {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (m, text, url) {
        const raw = url.trim();
        // 用「黑名单」而不是「白名单」：白名单会把 other.html、payment-terms-cost.html
        // 这类站内相对链接也误伤成 #。这里只拦危险协议。
        const dangerous = /^\s*(javascript|data|vbscript|file|blob):/i.test(raw);
        const safe = dangerous ? '#' : raw;
        const ext = /^https?:/i.test(safe) ? ' target="_blank" rel="noopener"' : '';
        return '<a href="' + safe + '"' + ext + '>' + text + '</a>';
    });
    return t;
}

function isTableRow(line) { return /^\s*\|.*\|\s*$/.test(line); }
function isTableSep(line) { return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.indexOf('-') >= 0; }

function splitRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

function isBlockStart(lines, i) {
    const line = lines[i];
    if (!line || !line.trim()) return true;
    if (/^```/.test(line)) return true;
    if (/^#{1,6}\s/.test(line)) return true;
    if (/^>\s?/.test(line)) return true;
    if (/^\s*[-*+]\s+/.test(line)) return true;
    if (/^\s*\d+\.\s+/.test(line)) return true;
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) return true;
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) return true;
    return false;
}

function renderMarkdown(md) {
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        if (!line.trim()) { i++; continue; }

        // 代码块
        if (/^```/.test(line)) {
            const buf = [];
            i++;
            while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
            i++;
            out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
            continue;
        }

        // 分隔线
        if (/^(-{3,}|\*{3,})$/.test(line.trim())) { out.push('<hr>'); i++; continue; }

        // 标题
        let m = line.match(/^(#{1,6})\s+(.*)$/);
        if (m) {
            const lvl = Math.min(6, m[1].length);
            out.push('<h' + lvl + '>' + inline(m[2]) + '</h' + lvl + '>');
            i++; continue;
        }

        // 表格
        if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
            const head = splitRow(line);
            i += 2;
            const rows = [];
            while (i < lines.length && isTableRow(lines[i])) { rows.push(splitRow(lines[i])); i++; }
            out.push('<table><thead><tr>' + head.map(h => '<th>' + inline(h) + '</th>').join('') + '</tr></thead><tbody>'
                + rows.map(r => '<tr>' + head.map((_, ci) => '<td>' + inline(r[ci] === undefined ? '' : r[ci]) + '</td>').join('') + '</tr>').join('')
                + '</tbody></table>');
            continue;
        }

        // 引用
        if (/^>\s?/.test(line)) {
            const buf = [];
            while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
            out.push('<blockquote>' + renderMarkdown(buf.join('\n')) + '</blockquote>');
            continue;
        }

        // 无序列表
        if (/^\s*[-*+]\s+/.test(line)) {
            const buf = [];
            while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
            out.push('<ul>' + buf.map(t => '<li>' + inline(t) + '</li>').join('') + '</ul>');
            continue;
        }

        // 有序列表
        if (/^\s*\d+\.\s+/.test(line)) {
            const buf = [];
            while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
            out.push('<ol>' + buf.map(t => '<li>' + inline(t) + '</li>').join('') + '</ol>');
            continue;
        }

        // 段落
        const buf = [];
        while (i < lines.length && !isBlockStart(lines, i)) { buf.push(lines[i].trim()); i++; }
        if (buf.length) out.push('<p>' + inline(buf.join(' ')) + '</p>');
        else i++;
    }
    return out.join('\n');
}

/** 解析 front matter（--- 包裹的 key: value 区） */
function parseFrontMatter(raw) {
    const text = String(raw || '').replace(/\r\n/g, '\n');
    const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!m) return { meta: {}, body: text };
    const meta = {};
    m[1].split('\n').forEach(line => {
        const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
        if (kv) meta[kv[1]] = kv[2].trim();
    });
    return { meta: meta, body: text.slice(m[0].length) };
}

/* ============================================================
 * 2. 页面模板
 * ============================================================ */

const NAV = [
    { href: 'index.html', label: '首页' },
    { href: 'materials/index.html', label: '材料价格库' },
    { href: 'craft/index.html', label: '工艺价格库' },
    { href: 'kb/index.html', label: '知识库' },
    { href: 'community/index.html', label: '交流社区' },
    { href: 'injection/index.html', label: '注塑件工具' },
    { href: 'stamping/index.html', label: '冲压件工具' }
];

/** 把站点配置里的相对路径转成当前页面深度可用的路径 */
function siteAsset(p, depth) {
    if (!p) return '';
    if (/^https?:|^data:/.test(p)) return p;
    return '../'.repeat(depth || 0) + String(p).replace(/^\/+/, '');
}

/** @param {string} depth 相对站点根的层级（0=根，1=子目录） */
function layout(opts) {
    const depth = opts.depth || 0;
    const up = depth === 0 ? '' : '../'.repeat(depth);
    const nav = NAV.map(n => {
        const active = opts.active === n.href ? ' class="active"' : '';
        return '<a href="' + up + n.href + '"' + active + '>' + n.label + '</a>';
    }).join('');

    return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n'
        + '<meta charset="UTF-8">\n'
        + '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
        + '<title>' + esc(opts.title) + '</title>\n'
        + (opts.description ? '<meta name="description" content="' + esc(opts.description) + '">\n' : '')
        + (opts.canonical ? '<link rel="canonical" href="' + esc(opts.canonical) + '">\n' : '')
        + '<link rel="stylesheet" href="' + up + 'assets/site.css">\n'
        + (opts.extraHead ? opts.extraHead + '\n' : '')
        + '</head>\n<body>\n'
        + '<header class="site-header"><div class="wrap">'
        + '<a class="brand" href="' + up + 'index.html">🚗 ' + SITE_NAME + '<span>成本与供应链</span></a>'
        + '<nav class="site-nav">' + nav + '</nav>'
        + '</div></header>\n'
        + '<main class="wrap">\n' + opts.content + '\n</main>\n'
        + '<footer class="site-footer"><div class="wrap">'
        + '<p>' + SITE_NAME + ' · 汽车成本估算与供应链工具</p>'
        + '<p>全部计算在浏览器内完成，不依赖外部 CDN、不上传任何数据，可离线与企业内网使用</p>'
        + '<p style="margin-top:8px;">© 2025–2026 · <a href="' + up + 'index.html">返回首页</a></p>'
        + '</div></footer>\n'
        + (opts.script ? '<script>\n' + opts.script + '\n</script>\n' : '')
        + '</body>\n</html>\n';
}

function priceCell(m) {
    if (m.unitPrice === null || m.unitPrice === undefined || m.unitPrice === '') {
        return '<td class="price pending">待补充</td>';
    }
    return '<td class="price">' + esc(m.unitPrice) + '</td>';
}

/* ============================================================
 * 3. 材料价格库
 * ============================================================ */

function buildMaterials(data) {
    const list = data.materials.slice().sort((a, b) => {
        const order = { sheet: 0, polymer: 1, other: 2 };
        const ko = (order[a.kind] === undefined ? 9 : order[a.kind]) - (order[b.kind] === undefined ? 9 : order[b.kind]);
        return ko !== 0 ? ko : String(a.code).localeCompare(String(b.code));
    });

    // 优先用显式 slug（中文名 slugify 后会变成空，回落成 item）
    list.forEach(m => { m._slug = m.slug || slugify(m.code); });

    // 兜底告警：slug 回落成默认值说明牌号里有全中文名，应补 slug 字段
    const fallbackCodes = list.filter(m => m._slug === 'item').map(m => m.code);
    if (fallbackCodes.length) {
        console.warn('  ⚠️  以下牌号 slug 回落成了 item，请在 data/materials.json 里补 "slug" 字段：'
            + fallbackCodes.join('、'));
    }

    const withPrice = list.filter(m => m.unitPrice !== null && m.unitPrice !== undefined).length;
    const kinds = data.kinds || {};

    /* ---------- 列表页 ---------- */
    const rows = list.map(m =>
        '<tr data-kind="' + esc(m.kind) + '" data-search="' + esc((m.code + ' ' + m.category + ' ' + (m.application || '') + ' ' + (m.spec || '')).toLowerCase()) + '">'
        + '<td><a class="code code-link" href="' + m._slug + '.html">' + esc(m.code) + '</a></td>'
        + '<td><span class="tag ' + esc(m.kind) + '">' + esc(kinds[m.kind] || m.kind) + '</span></td>'
        + '<td>' + esc(m.category) + '</td>'
        + '<td class="muted">' + esc(m.spec || '—') + '</td>'
        + '<td class="num">' + esc(m.density) + '</td>'
        + priceCell(m)
        + '<td class="muted">' + esc(m.application || '—') + '</td>'
        + '<td class="muted">' + esc(m.updatedAt || '—') + '</td>'
        + '</tr>').join('');

    const filterOpts = Object.keys(kinds).map(k =>
        '<option value="' + esc(k) + '">' + esc(kinds[k]) + '</option>').join('');

    const script = [
        'var q = document.getElementById("q");',
        'var kf = document.getElementById("kf");',
        'var rows = [].slice.call(document.querySelectorAll("table.data tbody tr"));',
        'var cnt = document.getElementById("cnt");',
        'function apply() {',
        '  var s = (q.value || "").trim().toLowerCase();',
        '  var k = kf.value;',
        '  var n = 0;',
        '  rows.forEach(function (tr) {',
        '    var hit = (!s || tr.getAttribute("data-search").indexOf(s) >= 0) && (!k || tr.getAttribute("data-kind") === k);',
        '    tr.style.display = hit ? "" : "none";',
        '    if (hit) n++;',
        '  });',
        '  cnt.textContent = "显示 " + n + " / " + rows.length + " 个牌号";',
        '}',
        'q.addEventListener("input", apply);',
        'kf.addEventListener("change", apply);',
        'apply();'
    ].join('\n');

    const content =
        '<div class="page-head">'
        + '<h1>🔩 ' + esc(data.title || '汽车常用材料价格库') + '</h1>'
        + '<p class="lead">按<strong>汽车行业常用牌号</strong>整理的材料参考库：密度、规格、典型应用，以及价格与来源。'
        + '共收录 ' + list.length + ' 个牌号，其中 ' + withPrice + ' 个已录入价格。</p>'
        + '</div>'
        + '<div class="notice">⚠️ ' + esc(data.disclaimer || '') + '</div>'
        + '<div class="toolbar">'
        + '<input type="search" id="q" placeholder="搜索牌号 / 类别 / 应用，如 DC01、双相钢、保险杠…">'
        + '<select id="kf"><option value="">全部类型</option>' + filterOpts + '</select>'
        + '<span class="count" id="cnt"></span>'
        + '</div>'
        + '<div class="table-scroll"><table class="data"><thead><tr>'
        + '<th>牌号</th><th>类型</th><th>材料类别</th><th>规格</th><th>密度 g/cm³</th><th>单价 元/kg</th><th>典型应用</th><th>更新日期</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
        + '<div class="notice info" style="margin-top:20px;">💡 想用这些材料直接算成本？'
        + '<a href="../injection/index.html">注塑件成本模型</a> · <a href="../stamping/index.html">冲压件成本模型</a>'
        + ' —— 两个工具都能「批量导入价」把这里的价格一次性刷进去。</div>';

    const listHtml = layout({
        title: (data.title || '材料价格库') + ' · ' + SITE_NAME,
        description: '汽车行业常用材料牌号参考库：' + list.length + ' 个牌号的密度、规格、典型应用与价格来源，覆盖冷轧/热轧钢板、双相钢、工程塑料与压铸铝合金。',
        canonical: SITE_URL + '/materials/',
        depth: 1,
        active: 'materials/index.html',
        content: content,
        script: script
    });

    let bytes = writeFile('materials/index.html', listHtml);
    const pages = [];

    /* ---------- 详情页 ---------- */
    list.forEach(m => {
        const hasPrice = m.unitPrice !== null && m.unitPrice !== undefined && m.unitPrice !== '';
        const title = m.code + '（' + m.category + '）密度、规格、价格与典型应用';
        const kvRows = [
            ['牌号', m.code],
            ['类型', kinds[m.kind] || m.kind],
            ['材料类别', m.category],
            ['规格', m.spec || '—'],
            ['密度', m.density + ' g/cm³'],
            ['参考单价', hasPrice ? m.unitPrice + ' 元/kg' : '待补充'],
            ['典型应用', m.application || '—'],
            ['常见工艺', m.process || '—']
        ];
        if (m.note) kvRows.push(['说明', m.note]);
        kvRows.push(['数据来源', m.source || '—']);
        kvRows.push(['更新日期', m.updatedAt || '—']);
        const kv = kvRows.map(kvItem => '<dt>' + esc(kvItem[0]) + '</dt><dd>' + esc(kvItem[1]) + '</dd>').join('');

        const toolLink = m.kind === 'polymer'
            ? '<a href="../injection/index.html">注塑件成本模型</a> 估算这个材料的零件成本'
            : (m.kind === 'sheet'
                ? '<a href="../stamping/index.html">冲压件成本模型</a> 估算这个材料的零件成本'
                : '<a href="../injection/index.html">注塑件模型</a> 或 <a href="../stamping/index.html">冲压件模型</a>');

        const content2 =
            '<div class="page-head">'
            + '<p style="font-size:.8rem;color:#94a3b8;margin-bottom:6px;"><a href="index.html" style="color:#2563eb;text-decoration:none;">← 材料价格库</a></p>'
            + '<h1>' + esc(m.code) + '</h1>'
            + '<p class="lead">' + esc(m.category) + (m.application ? ' · ' + esc(m.application) : '') + '</p>'
            + '</div>'
            + '<div class="card" style="max-width:720px;">'
            + '<dl class="kv">' + kv + '</dl>'
            + '</div>'
            + (hasPrice ? '' : '<div class="notice" style="margin-top:16px;max-width:720px;">该牌号的价格尚未收录，目前只提供材料属性。'
                + '你可以在工具中录入实价后导出，再用 <code>node tools/sync-materials.js &lt;导出文件&gt;</code> 同步到本页。</div>')
            + '<div class="notice info" style="margin-top:16px;max-width:720px;">🔧 ' + toolLink + '。</div>'
            + '<p style="margin-top:26px;font-size:.82rem;color:#94a3b8;">数据来源：' + esc(m.source || '未标注')
            + (m.updatedAt ? ' · 更新于 ' + esc(m.updatedAt) : '') + '</p>';

        const html = layout({
            title: title + ' · ' + SITE_NAME,
            description: m.code + '（' + m.category + '）密度 ' + m.density + ' g/cm³，规格 ' + (m.spec || '—')
                + '，典型应用：' + (m.application || '—') + '。' + (hasPrice ? '参考单价 ' + m.unitPrice + ' 元/kg。' : ''),
            canonical: SITE_URL + '/materials/' + m._slug + '.html',
            depth: 1,
            active: 'materials/index.html',
            content: content2
        });

        bytes += writeFile('materials/' + m._slug + '.html', html);
        pages.push({ loc: SITE_URL + '/materials/' + m._slug + '.html', priority: '0.7' });
    });

    return { bytes: bytes, pages: pages, count: list.length, withPrice: withPrice };
}

/* ============================================================
 * 4. 知识库
 * ============================================================ */

function buildKb() {
    const dir = path.join(ROOT, 'content');
    const articles = [];

    if (fs.existsSync(dir)) {
        fs.readdirSync(dir).filter(f => /\.md$/i.test(f)).forEach(file => {
            const raw = fs.readFileSync(path.join(dir, file), 'utf8');
            const fm = parseFrontMatter(raw);
            const meta = fm.meta || {};
            const slug = meta.slug || slugify(file.replace(/\.md$/i, ''));
            articles.push({
                slug: slug,
                file: file,
                title: meta.title || file.replace(/\.md$/i, ''),
                date: meta.date || '',
                tags: meta.tags ? meta.tags.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [],
                summary: meta.summary || '',
                body: fm.body
            });
        });
    }

    articles.sort((a, b) => String(b.date).localeCompare(String(a.date)));

    const seen = {};
    articles.forEach(a => {
        if (seen[a.slug]) throw new Error('文章 slug 重复：' + a.slug + '（文件 ' + a.file + '）');
        seen[a.slug] = true;
    });

    let bytes = 0;
    const pages = [];

    /* ---------- 列表页 ---------- */
    const cards = articles.length
        ? '<div class="article-list">' + articles.map(a =>
            '<a class="article-card" href="' + a.slug + '.html">'
            + '<h3>' + esc(a.title) + '</h3>'
            + (a.summary ? '<p class="summary">' + esc(a.summary) + '</p>' : '')
            + '<div class="meta"><span>' + esc(a.date) + '</span>'
            + a.tags.map(t => '<span>#' + esc(t) + '</span>').join('')
            + '</div></a>').join('') + '</div>'
        : '<div class="empty">还没有文章。在 <code>content/</code> 目录下新建 <code>.md</code> 文件，然后重新运行构建即可。</div>';

    bytes += writeFile('kb/index.html', layout({
        title: '成本知识库 · ' + SITE_NAME,
        description: '汽车成本方法论与实战拆解：零件成本构成、报价逻辑、降本思路与供应链观察。',
        canonical: SITE_URL + '/kb/',
        depth: 1,
        active: 'kb/index.html',
        content: '<div class="page-head"><h1>📚 成本知识库</h1>'
            + '<p class="lead">汽车成本的<strong>方法论</strong>与<strong>实战拆解</strong>：零件成本由哪些块构成、报价怎么算才不亏、降本从哪里下手。</p></div>'
            + cards
    }));
    pages.push({ loc: SITE_URL + '/kb/', priority: '0.8' });

    /* ---------- 文章详情 ---------- */
    articles.forEach(a => {
        const metaLine = [a.date].concat(a.tags.map(t => '#' + t)).filter(Boolean).join(' · ');
        bytes += writeFile('kb/' + a.slug + '.html', layout({
            title: a.title + ' · ' + SITE_NAME,
            description: a.summary || a.title,
            canonical: SITE_URL + '/kb/' + a.slug + '.html',
            depth: 1,
            active: 'kb/index.html',
            content: '<div class="page-head">'
                + '<p style="font-size:.8rem;color:#94a3b8;margin-bottom:6px;"><a href="index.html" style="color:#2563eb;text-decoration:none;">← 知识库</a></p>'
                + '<h1>' + esc(a.title) + '</h1>'
                + (metaLine ? '<p class="lead" style="font-size:.8rem;color:#94a3b8;">' + esc(metaLine) + '</p>' : '')
                + '</div>'
                + '<article class="prose">' + renderMarkdown(a.body) + '</article>'
                + '<div class="notice info" style="margin-top:32px;max-width:780px;">🔧 想直接算一算？'
                + '<a href="../injection/index.html">注塑件成本模型</a> · <a href="../stamping/index.html">冲压件成本模型</a></div>'
        }));
        pages.push({ loc: SITE_URL + '/kb/' + a.slug + '.html', priority: '0.7' });
    });

    return { bytes: bytes, pages: pages, count: articles.length };
}

/* ============================================================
 * 4b. 工艺价格库（含会员门禁）
 *
 * 门禁设计原则：只锁「工具里算不出来」的数据。
 * 能从免费工具推导的（如冲压冲次费 = 机时费率 ÷ (SPM×60)）一律公开 ——
 * 给客户能自己算出来的数据加锁，等于告诉他你在收智商税。
 *
 * ⚠️ 前端门禁只能挡住普通用户。真正的会员数据不进公开仓库，
 *    只存在于本地 data/craft-prices.local.json（已 gitignore）。
 * ============================================================ */

function renderMemberCta(site, memberCount, depth) {
    const c = (site && site.memberCta) || {};
    const ways = [];
    if (c.wechat) ways.push('<li>微信号：<b>' + esc(c.wechat) + '</b></li>');
    if (c.formUrl) ways.push('<li><a href="' + esc(c.formUrl) + '" target="_blank" rel="noopener">'
        + esc(c.formLabel || '在线表单') + '</a></li>');
    if (c.email) ways.push('<li>邮箱：<a href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a></li>');

    const qr = c.wechatQr
        ? '<div class="qr-box"><img class="qr-img" src="' + esc(siteAsset(c.wechatQr, depth))
        + '" alt="微信二维码" loading="lazy">'
        + (c.wechatNote ? '<div class="qr-note">' + esc(c.wechatNote) + '</div>' : '')
        + '</div>'
        : '';

    const hasAny = ways.length > 0 || qr;
    const body = hasAny
        ? '<p>' + esc(c.desc || '') + '</p>'
        + qr
        + (ways.length ? '<ul class="cta-ways">' + ways.join('') + '</ul>' : '')
        : '<p>' + esc(c.desc || '') + '</p>'
        + '<p class="cta-todo">（作者尚未配置联系方式 —— 在 <code>data/site.json</code> 的 '
        + '<code>memberCta</code> 里填微信号 / 二维码 / 表单链接 / 邮箱即可）</p>';

    return '<div class="cta"><h3>🔓 ' + esc(c.title || '解锁会员区')
        + ' <span class="cta-n">' + memberCount + ' 项经验价格</span></h3>' + body + '</div>';
}

/**
 * @param {Object} craft   craft-prices.json
 * @param {Object} site    site.json
 * @param {Object} opts    { unlock:boolean, localPrices:{} }
 */
function buildCraft(craft, site, opts) {
    opts = opts || {};
    const unlock = !!opts.unlock;
    const localPrices = opts.localPrices || {};
    const cats = craft.categories || {};

    // 合并本地价格（会员区经验价只存在本地文件里）
    const items = (craft.items || []).map(it => {
        const merged = Object.assign({}, it);
        const p = localPrices[it.code];
        if (p !== undefined && p !== null && p !== '') merged.unitPrice = p;
        return merged;
    });

    const memberItems = items.filter(i => i.visibility === 'member');
    const memberCount = memberItems.length;
    const publicCount = items.length - memberCount;
    const priced = items.filter(i => i.unitPrice !== null && i.unitPrice !== undefined && i.unitPrice !== '').length;

    const groups = Object.keys(cats).map(cat => {
        const list = items.filter(i => i.category === cat);
        if (!list.length) return '';
        const rows = list.map(it => {
            const locked = !unlock && it.visibility === 'member';
            const hasPrice = it.unitPrice !== null && it.unitPrice !== undefined && it.unitPrice !== '';
            const priceHtml = locked
                ? '<td class="price locked">🔒 会员可见</td>'
                : (hasPrice
                    ? '<td class="price">' + esc(it.unitPrice) + '</td>'
                    : '<td class="price pending">待补充</td>');
            return '<tr' + (locked ? ' class="locked"' : '') + '>'
                + '<td><strong>' + esc(it.name) + '</strong>'
                + (locked ? ' <span class="lock-tag">会员</span>' : '') + '</td>'
                + '<td class="muted">' + esc(it.unit || '—') + '</td>'
                + priceHtml
                + '<td class="muted">' + esc(it.basis || '—')
                + (it.note ? '<br><span class="cell-note">' + esc(it.note) + '</span>' : '')
                + '</td>'
                + '</tr>';
        }).join('');

        return '<h2 class="group-h">' + esc(cats[cat])
            + ' <span class="group-n">' + list.length + ' 项</span></h2>'
            + '<div class="table-scroll"><table class="data"><thead><tr>'
            + '<th style="width:26%">工艺 / 物料</th>'
            + '<th style="width:13%">计价单位</th>'
            + '<th style="width:14%">参考单价</th>'
            + '<th>计价基准与说明</th>'
            + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    }).join('');

    const banner = '<div class="notice info">'
        + '共 <b>' + items.length + '</b> 项：<b>' + publicCount + '</b> 项公开'
        + '（工具里可推导或已内置）、<b>' + memberCount + '</b> 项会员可见'
        + '（需项目经验积累的经验价格）'
        + (unlock ? '。<b>当前为会员版，全部解锁。</b>' : '。')
        + '</div>';

    const content = '<div class="page-head">'
        + '<h1>🛠️ ' + esc(craft.title || '常用工艺核算价格库') + '</h1>'
        + '<p class="lead">' + esc(craft.intro || '') + '</p>'
        + '</div>'
        + banner
        + '<div class="notice" style="margin-top:12px;">⚠️ ' + esc(craft.disclaimer || '') + '</div>'
        + '<div style="margin-top:24px;">' + groups + '</div>'
        + (unlock ? '' : renderMemberCta(site, memberCount, 1))
        + '<div class="notice info" style="margin-top:24px;">🔧 这些费率可以直接填进工具：'
        + '<a href="../injection/index.html">注塑件成本模型</a> · '
        + '<a href="../stamping/index.html">冲压件成本模型</a> 的「费率与税费 / 表面处理库」区。</div>';

    const html = layout({
        title: (craft.title || '工艺价格库') + ' · ' + SITE_NAME,
        description: '汽车常用工艺核算价格库：表面处理（喷漆/电泳/镀铝/软包覆/UV硬化）、冲压冲次费、'
            + '压铸与铸件毛坯、线束物料、机加工费率，含计价单位与计价基准。',
        canonical: unlock ? null : SITE_URL + '/craft/',
        depth: 1,
        active: 'craft/index.html',
        content: content
    });

    return {
        html: html,
        count: items.length,
        publicCount: publicCount,
        memberCount: memberCount,
        priced: priced
    };
}

/* ============================================================
 * 4c. 交流社区
 *
 * 刻意不自建论坛：B2B 冷启动阶段，空论坛比没有论坛更伤信任。
 * 交流放在微信生态里 —— 因为工程师本来就在微信上，不在论坛上。
 * ============================================================ */

function buildCommunity(site) {
    const c = (site && site.community) || {};

    const groups = (c.groups || []).map(g =>
        '<div class="entry-card"><div class="entry-head"><h3>' + esc(g.name) + '</h3>'
        + (g.tag ? '<span class="entry-tag">' + esc(g.tag) + '</span>' : '') + '</div>'
        + '<p>' + esc(g.desc) + '</p></div>').join('');

    const channels = [];
    if (c.wechatQr) {
        channels.push('<div class="qr-box"><img class="qr-img" src="' + esc(siteAsset(c.wechatQr, 1))
            + '" alt="微信二维码" loading="lazy">'
            + (c.wechatNote ? '<div class="qr-note">' + esc(c.wechatNote) + '</div>' : '') + '</div>');
    }
    if (c.planetUrl) {
        channels.push('<div class="entry-card"><div class="entry-head"><h3>' + esc(c.planetLabel || '知识星球')
            + '</h3><span class="entry-tag">会员</span></div><p>' + esc(c.planetNote || '') + '</p>'
            + '<p><a href="' + esc(c.planetUrl) + '" target="_blank" rel="noopener">前往 →</a></p></div>');
    }
    if (c.officialAccount) {
        channels.push('<div class="entry-card"><div class="entry-head"><h3>公众号</h3></div><p>'
            + esc(c.officialAccountNote || '') + '</p><p><b>' + esc(c.officialAccount) + '</b></p></div>');
    }

    const rules = (c.rules || []).length
        ? '<h2 class="group-h">群规 <span class="group-n">' + c.rules.length + ' 条</span></h2>'
        + '<div class="card"><ol class="rule-list">' + c.rules.map(r => '<li>' + esc(r) + '</li>').join('') + '</ol></div>'
        : '';

    const content = '<div class="page-head">'
        + '<h1>💬 交流社区</h1>'
        + '<p class="lead">' + esc(c.intro || '') + '</p>'
        + '</div>'
        + '<div class="notice info">交流在<b>微信</b>里进行 —— 因为工程师本来就在微信上，不在论坛上。'
        + '这里只放入口，不建一个没人说话的论坛。</div>'
        + (groups ? '<div class="entry-grid">' + groups + '</div>' : '')
        + '<h2 class="group-h">怎么加入</h2>'
        + '<div class="entry-grid">' + (channels.length ? channels.join('')
            : '<div class="cta-todo">（作者尚未配置交流入口 —— 在 <code>data/site.json</code> 的 '
            + '<code>community</code> 里填二维码 / 星球链接即可）</div>') + '</div>'
        + rules
        + '<div class="notice" style="margin-top:26px;">⚠️ 在群里分享报价与项目数据时请<b>自行脱敏</b>，'
        + '不要贴客户名、供应商名与具体成交价。保护别人，也是保护你自己。</div>';

    return {
        html: layout({
            title: '交流社区 · ' + SITE_NAME,
            description: '汽车成本同行交流：报价经验、工艺问题、行业行情。免费交流群与会员专属渠道。',
            canonical: SITE_URL + '/community/',
            depth: 1,
            active: 'community/index.html',
            content: content
        }),
        groupCount: (c.groups || []).length,
        channelCount: channels.length
    };
}

/* ============================================================
 * 4d. 会员价格维护界面（本地工具，不进仓库）
 *
 * 只在本地服务器下可用（依赖 /api/craft-prices 写文件）。
 * 保存的文件是 data/craft-prices.local.json —— 已 gitignore。
 * ============================================================ */

const ADMIN_CSS = [
    '.adm-toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:18px 0;position:sticky;top:62px;background:#f6f8fb;padding:12px 0;z-index:20;border-bottom:1px solid #e6ecf3}',
    '.adm-btn{border:none;border-radius:10px;padding:9px 18px;font-size:.84rem;font-family:inherit;cursor:pointer;font-weight:600}',
    '.adm-btn.p{background:#2563eb;color:#fff}',
    '.adm-btn.g{background:#059669;color:#fff}',
    '.adm-btn.o{background:#fff;color:#334155;border:1px solid #cbd5e1}',
    '.adm-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.adm-count{margin-left:auto;font-size:.82rem;color:#64748b}',
    '.adm-count b{color:#059669}',
    'table.adm{width:100%;border-collapse:collapse;font-size:.83rem;background:#fff;border-radius:14px;overflow:hidden}',
    'table.adm th{background:#f8fafc;color:#64748b;text-align:left;padding:10px 12px;border-bottom:1px solid #e6ecf3;font-weight:600}',
    'table.adm td{padding:8px 12px;border-bottom:1px solid #f1f5f9;vertical-align:middle}',
    'table.adm tr.member-row{background:#fdfcff}',
    'table.adm tr.done{background:#f0fdf4}',
    'table.adm input[type=number]{width:130px;padding:7px 10px;border:1px solid #cbd5e1;border-radius:9px;font-size:.84rem;font-family:inherit}',
    'table.adm input[type=number]:focus{outline:none;border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.12)}',
    'table.adm .ro{color:#94a3b8}',
    'table.adm .cat{display:inline-block;font-size:.68rem;color:#94a3b8;background:#f1f5f9;padding:1px 7px;border-radius:8px;margin-right:5px}',
    '.adm-status{margin-top:16px;padding:14px 18px;border-radius:12px;font-size:.83rem;line-height:1.7;white-space:pre-wrap;display:none}',
    '.adm-status.ok{display:block;background:#f0fdf4;border:1px solid #bbf7d0;color:#15803d}',
    '.adm-status.err{display:block;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c}',
    '.adm-status.work{display:block;background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8}'
].join('\n');

const ADMIN_JS = [
    'var inputs = [].slice.call(document.querySelectorAll("input[data-code]"));',
    'var statusEl = document.getElementById("status");',
    'var countEl = document.getElementById("count");',
    'var saveBtn = document.getElementById("save");',
    'var buildBtn = document.getElementById("build");',
    '',
    'function setStatus(kind, msg) {',
    '  statusEl.className = "adm-status " + kind;',
    '  statusEl.textContent = msg;',
    '}',
    '',
    'function refreshCount() {',
    '  var n = 0;',
    '  inputs.forEach(function (i) {',
    '    var tr = i.closest("tr");',
    '    if (i.value.trim() !== "") { n++; tr.className = "member-row done"; }',
    '    else { tr.className = "member-row"; }',
    '  });',
    '  countEl.innerHTML = "会员区已填 <b>" + n + "</b> / " + inputs.length + " 项";',
    '}',
    '',
    'function collect() {',
    '  var prices = {};',
    '  inputs.forEach(function (i) {',
    '    var v = i.value.trim();',
    '    prices[i.getAttribute("data-code")] = v === "" ? null : Number(v);',
    '  });',
    '  return prices;',
    '}',
    '',
    'function post(url, body) {',
    '  return fetch(url, {',
    '    method: "POST",',
    '    headers: { "Content-Type": "application/json" },',
    '    body: JSON.stringify(body || {})',
    '  }).then(function (r) { return r.json(); });',
    '}',
    '',
    'function doSave() {',
    '  saveBtn.disabled = true; buildBtn.disabled = true;',
    '  setStatus("work", "正在保存…");',
    '  post("/api/craft-prices", { prices: collect() }).then(function (j) {',
    '    saveBtn.disabled = false; buildBtn.disabled = false;',
    '    if (!j.ok) { setStatus("err", "保存失败：" + j.error); return; }',
    '    setStatus("ok", "已保存 " + j.saved + " 项到 " + j.file + "\\n（该文件不进公开仓库，你的经验价只在本机）");',
    '  }).catch(function (e) {',
    '    saveBtn.disabled = false; buildBtn.disabled = false;',
    '    setStatus("err", "请求失败：" + e.message + "\\n请确认是通过 npm run serve 打开的页面");',
    '  });',
    '}',
    '',
    'function doBuild() {',
    '  saveBtn.disabled = true; buildBtn.disabled = true;',
    '  setStatus("work", "正在保存并构建…");',
    '  post("/api/craft-prices", { prices: collect() }).then(function (j) {',
    '    if (!j.ok) throw new Error(j.error);',
    '    return post("/api/build-member");',
    '  }).then(function (j) {',
    '    saveBtn.disabled = false; buildBtn.disabled = false;',
    '    if (!j.ok) { setStatus("err", "构建失败：" + j.error); return; }',
    '    setStatus("ok", "✅ 构建完成\\n\\n" + j.log + "\\n\\n会员版页面：_member/index.html");',
    '  }).catch(function (e) {',
    '    saveBtn.disabled = false; buildBtn.disabled = false;',
    '    setStatus("err", "出错：" + e.message);',
    '  });',
    '}',
    '',
    'function doReload() { location.reload(); }',
    '',
    'saveBtn.onclick = doSave;',
    'buildBtn.onclick = doBuild;',
    'document.getElementById("reload").onclick = doReload;',
    'inputs.forEach(function (i) { i.addEventListener("input", refreshCount); });',
    'refreshCount();',
    '',
    '// 页面打开时，如果本地文件还没建立，提示一下',
    'fetch("/api/craft-prices").then(function (r) { return r.json(); }).then(function (j) {',
    '  if (j.ok && !j.exists) {',
    '    setStatus("work", "data/craft-prices.local.json 尚未创建 —— 填好价格点「保存」会自动创建。");',
    '  }',
    '}).catch(function () {});'
].join('\n');

function buildAdmin(craft, localPrices) {
    const items = craft.items || [];
    const cats = craft.categories || {};
    const memberN = items.filter(i => i.visibility === 'member').length;

    const rows = items.map(it => {
        const isMember = it.visibility === 'member';
        const local = localPrices[it.code];
        const hasLocal = local !== undefined && local !== null && local !== '';
        const base = it.unitPrice !== null && it.unitPrice !== undefined ? it.unitPrice : '';
        const val = hasLocal ? local : base;

        const cell = isMember
            ? '<input type="number" step="0.0001" min="0" data-code="' + esc(it.code)
              + '" value="' + esc(hasLocal ? local : '') + '" placeholder="' + esc(base === '' ? '待填' : base) + '">'
            : '<span class="ro">' + esc(base === '' ? '待补充' : base) + '</span>';

        return '<tr class="' + (isMember ? 'member-row' : '') + '">'
            + '<td><span class="cat">' + esc(cats[it.category] || '') + '</span>'
            + '<strong>' + esc(it.name) + '</strong>'
            + (isMember ? ' <span class="lock-tag">会员</span>' : '')
            + '<div class="muted" style="font-size:.72rem;color:#94a3b8">' + esc(it.code) + '</div></td>'
            + '<td class="muted">' + esc(it.unit || '—') + '</td>'
            + '<td>' + cell + '</td>'
            + '<td class="muted" style="font-size:.76rem">' + esc(it.basis || '') + '</td>'
            + '</tr>';
    }).join('');

    const content = '<div class="page-head">'
        + '<h1>🔧 会员价格维护</h1>'
        + '<p class="lead">在这里填写工艺价格库<b>会员区</b>的经验价格。公开区的值来自免费工具，是只读的。</p>'
        + '</div>'
        + '<div class="notice info">'
        + '这个页面只在本地服务器下工作（<code>npm run serve</code>）。保存时写入 '
        + '<code>data/craft-prices.local.json</code> —— <b>该文件已在 .gitignore 中排除，不会进公开仓库</b>，'
        + '所以你的经验价格只留在本机。'
        + '</div>'
        + '<div class="adm-toolbar">'
        + '<button class="adm-btn p" id="save">💾 保存</button>'
        + '<button class="adm-btn g" id="build">🔨 保存并生成会员版</button>'
        + '<button class="adm-btn o" id="reload">↻ 重新加载</button>'
        + '<span class="adm-count" id="count"></span>'
        + '</div>'
        + '<div id="status" class="adm-status"></div>'
        + '<div class="table-scroll" style="margin-top:16px;">'
        + '<table class="adm"><thead><tr>'
        + '<th style="width:30%">工艺 / 物料</th><th style="width:12%">单位</th>'
        + '<th style="width:16%">单价</th><th>计价基准</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
        + '<div class="notice" style="margin-top:20px;">💡 会员区共 <b>' + memberN + '</b> 项。'
        + '填完点「保存并生成会员版」，会同时更新公开页（显示 🔒 与项数）和生成 '
        + '<code>_member/index.html</code>（解锁版，用于交付给会员）。</div>';

    return layout({
        title: '会员价格维护 · ' + SITE_NAME,
        depth: 1,
        active: '',
        extraHead: '<style>\n' + ADMIN_CSS + '\n</style>',
        content: content,
        script: ADMIN_JS
    });
}

/* ============================================================
 * 5. sitemap
 * ============================================================ */

function buildSitemap(pages) {
    const all = [
        { loc: SITE_URL + '/', priority: '1.0' },
        { loc: SITE_URL + '/injection/index.html', priority: '0.9' },
        { loc: SITE_URL + '/stamping/index.html', priority: '0.9' }
    ].concat(pages);

    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + all.map(p => '  <url><loc>' + esc(p.loc) + '</loc><priority>' + p.priority + '</priority></url>').join('\n')
        + '\n</urlset>\n';

    return { bytes: writeFile('sitemap.xml', xml), count: all.length };
}

/* ============================================================
 * 6. 主流程
 * ============================================================ */

function loadOptional(rel, fallback) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) return fallback;
    try { return readJson(p); } catch (e) { throw new Error('解析失败 ' + rel + '：' + e.message); }
}

function build(opts) {
    opts = opts || {};

    const data = readJson(path.join(ROOT, 'data', 'materials.json'));
    const craft = loadOptional(path.join('data', 'craft-prices.json'), null);
    const site = loadOptional(path.join('data', 'site.json'), {});
    const localAll = loadOptional(path.join('data', 'craft-prices.local.json'), {}) || {};
    const localPrices = localAll.prices || {};

    console.log('构建静态站点' + (opts.member ? '（含会员版）' : '') + '\n' + '─'.repeat(56));

    const mat = buildMaterials(data);
    console.log('  材料价格库    ' + mat.count + ' 个牌号（' + mat.withPrice + ' 个有价） → materials/');
    console.log('                ' + mat.count + ' 个详情页');

    let craftRes = null;
    if (craft && craft.items) {
        const r = buildCraft(craft, site, { localPrices: localPrices });
        craftRes = { bytes: writeFile('craft/index.html', r.html), count: r.count, publicCount: r.publicCount, memberCount: r.memberCount, priced: r.priced };
        console.log('  工艺价格库    ' + r.count + ' 项（公开 ' + r.publicCount + ' / 会员 ' + r.memberCount
            + '，已填价 ' + r.priced + '） → craft/');
    }

    const kb = buildKb();
    console.log('  知识库        ' + kb.count + ' 篇文章 → kb/');

    const comm = buildCommunity(site);
    const commBytes = writeFile('community/index.html', comm.html);
    console.log('  交流社区      ' + comm.groupCount + ' 个群 · ' + comm.channelCount + ' 个入口 → community/');

    // ---- 会员价格维护界面（本地工具，_admin/ 已 gitignore）----
    let adminRes = null;
    if (craft && craft.items) {
        const adminHtml = buildAdmin(craft, localPrices);
        adminRes = { bytes: writeFile('_admin/index.html', adminHtml) };
        console.log('  价格维护台    _admin/index.html（本地可用，依赖 npm run serve）');
    }

    const pages = mat.pages.concat(kb.pages);
    if (craftRes) pages.push({ loc: SITE_URL + '/craft/', priority: '0.8' });
    pages.push({ loc: SITE_URL + '/community/', priority: '0.7' });

    const sm = buildSitemap(pages);
    console.log('  站点地图      ' + sm.count + ' 条 URL → sitemap.xml');

    // ---- 会员版（不进仓库，只用于交付给会员）----
    let memberRes = null;
    if (opts.member && craft && craft.items) {
        const m = buildCraft(craft, site, { unlock: true, localPrices: localPrices });
        const filled = Object.keys(localPrices).length;
        memberRes = { bytes: writeFile('_member/index.html', m.html), filled: filled };
        console.log('─'.repeat(56));
        console.log('  会员版        _member/index.html（已解锁 ' + m.memberCount + ' 项会员数据，'
            + '其中 ' + filled + ' 项来自本地价格文件）');
        if (!filled) {
            console.log('  ⚠️  提示：data/craft-prices.local.json 还没有价格，会员版里会员区是空的。');
            console.log('     复制 data/craft-prices.local.example.json 填写后重新构建。');
        }
    }

    console.log('─'.repeat(56));
    let totalFiles = 1 + mat.count + 1 + kb.count + 1 + (craftRes ? 1 : 0) + (memberRes ? 1 : 0) + 1 + (adminRes ? 1 : 0);
    let totalBytes = mat.bytes + kb.bytes + sm.bytes + commBytes + (adminRes ? adminRes.bytes : 0)
        + (craftRes ? craftRes.bytes : 0) + (memberRes ? memberRes.bytes : 0);
    console.log('  共生成 ' + totalFiles + ' 个文件，' + Math.round(totalBytes / 1024) + ' KB');

    return { materials: mat, craft: craftRes, kb: kb, community: comm, admin: adminRes, sitemap: sm, member: memberRes };
}

if (require.main === module) {
    try {
        build({ member: process.argv.indexOf('--member') >= 0 });
        console.log('\n✅ 构建完成');
    } catch (e) {
        console.error('\n❌ 构建失败：' + e.message);
        process.exit(1);
    }
}

module.exports = { build, buildCraft, buildCommunity, buildAdmin, renderMarkdown, parseFrontMatter, slugify, esc };
