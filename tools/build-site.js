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
    { href: 'injection/index.html', label: '注塑件工具' },
    { href: 'stamping/index.html', label: '冲压件工具' }
];

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

function renderMemberCta(site, memberCount) {
    const c = (site && site.memberCta) || {};
    const ways = [];
    if (c.wechat) ways.push('<li>微信：<b>' + esc(c.wechat) + '</b></li>');
    if (c.formUrl) ways.push('<li><a href="' + esc(c.formUrl) + '" target="_blank" rel="noopener">'
        + esc(c.formLabel || '在线表单') + '</a></li>');
    if (c.email) ways.push('<li>邮箱：<a href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a></li>');

    const body = ways.length
        ? '<p>' + esc(c.desc || '') + '</p><ul class="cta-ways">' + ways.join('') + '</ul>'
        : '<p>' + esc(c.desc || '') + '</p>'
        + '<p class="cta-todo">（作者尚未配置联系方式 —— 在 <code>data/site.json</code> 的 '
        + '<code>memberCta</code> 里填微信号 / 表单链接 / 邮箱即可）</p>';

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
        + (unlock ? '' : renderMemberCta(site, memberCount))
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

    const pages = mat.pages.concat(kb.pages);
    if (craftRes) pages.push({ loc: SITE_URL + '/craft/', priority: '0.8' });

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
    let totalFiles = 1 + mat.count + 1 + kb.count + 1 + (craftRes ? 1 : 0) + (memberRes ? 1 : 0);
    let totalBytes = mat.bytes + kb.bytes + sm.bytes + (craftRes ? craftRes.bytes : 0) + (memberRes ? memberRes.bytes : 0);
    console.log('  共生成 ' + totalFiles + ' 个文件，' + Math.round(totalBytes / 1024) + ' KB');

    return { materials: mat, craft: craftRes, kb: kb, sitemap: sm, member: memberRes };
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

module.exports = { build, buildCraft, renderMarkdown, parseFrontMatter, slugify, esc };
