/*!
 * tools/test-build.js —— 静态站点生成器测试
 * 用法：node tools/test-build.js
 *
 * 重点覆盖 Markdown 渲染器。中文内容里混着表格、代码、链接是常态，
 * 渲染器漏掉一种语法，页面上就会露出 ** 或 | 这种原始符号，很难看。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const B = require('./build-site.js');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];

function eq(actual, expected, label) {
    const ok = String(actual) === String(expected);
    if (ok) pass++; else { fail++; failures.push(label + '\n    期望 ' + JSON.stringify(expected) + '\n    实际 ' + JSON.stringify(actual)); }
}
function ok(cond, label, extra) {
    if (cond) pass++; else { fail++; failures.push(label + (extra ? '\n    ' + extra : '')); }
}
function has(haystack, needle, label) {
    ok(String(haystack).indexOf(needle) >= 0, label, '未找到：' + needle);
}
function notHas(haystack, needle, label) {
    ok(String(haystack).indexOf(needle) < 0, label, '不该出现：' + needle);
}
function section(n) { console.log('\n── ' + n + ' ' + '─'.repeat(Math.max(0, 46 - n.length))); }

/* ============================================================
 * 1. esc —— HTML 转义
 * ============================================================ */
section('HTML 转义');
eq(B.esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;', '转义标签');
eq(B.esc('a & b "c"'), 'a &amp; b &quot;c&quot;', '转义 & 和引号');
eq(B.esc(null), '', 'null 安全');
eq(B.esc(undefined), '', 'undefined 安全');
eq(B.esc(0), '0', '数字正常处理');

/* ============================================================
 * 2. slugify —— URL 安全
 * ============================================================ */
section('slug 生成');
eq(B.slugify('DC01'), 'dc01', '基本转换');
eq(B.slugify('HC340/590DP'), 'hc340-590dp', '斜杠转连字符（牌号里很常见）');
eq(B.slugify('PP+EPDM-T20'), 'pp-epdm-t20', '加号处理');
eq(B.slugify('PC/ABS'), 'pc-abs', '斜杠');
eq(B.slugify('22MnB5'), '22mnb5', '数字开头');
eq(B.slugify('  多余   空格  '), 'item', '全非法字符时回落默认值');
eq(B.slugify(''), 'item', '空串安全');
eq(B.slugify('a--b'), 'a-b', '连续连字符合并');

/* ============================================================
 * 3. front matter 解析
 * ============================================================ */
section('front matter');
{
    const r = B.parseFrontMatter('---\ntitle: 测试标题\nslug: test-slug\ndate: 2026-03-01\ntags: a, b\n---\n\n正文内容');
    eq(r.meta.title, '测试标题', '解析 title');
    eq(r.meta.slug, 'test-slug', '解析 slug');
    eq(r.meta.tags, 'a, b', '解析 tags');
    has(r.body, '正文内容', '正文保留');
    notHas(r.body, '---', '正文不含分隔线');
}
{
    const r = B.parseFrontMatter('没有 front matter 的内容');
    eq(Object.keys(r.meta).length, 0, '无 front matter 时 meta 为空');
    eq(r.body, '没有 front matter 的内容', '正文完整保留');
}
eq(B.parseFrontMatter(null).body, '', 'null 安全');

/* ============================================================
 * 4. Markdown 渲染 —— 块级
 * ============================================================ */
section('Markdown · 块级');
{
    const h = B.renderMarkdown('# 一级\n## 二级\n### 三级');
    has(h, '<h1>一级</h1>', 'h1');
    has(h, '<h2>二级</h2>', 'h2');
    has(h, '<h3>三级</h3>', 'h3');
}
{
    const h = B.renderMarkdown('这是第一段。\n\n这是第二段。');
    eq((h.match(/<p>/g) || []).length, 2, '两个段落');
}
{
    const h = B.renderMarkdown('段落里的换行\n应该合并成一行');
    has(h, '段落里的换行 应该合并成一行', '段落内换行合并');
}
{
    const h = B.renderMarkdown('- 甲\n- 乙\n- 丙');
    has(h, '<ul><li>甲</li><li>乙</li><li>丙</li></ul>', '无序列表');
}
{
    const h = B.renderMarkdown('1. 第一\n2. 第二');
    has(h, '<ol><li>第一</li><li>第二</li></ol>', '有序列表');
}
{
    const h = B.renderMarkdown('> 引用第一行\n> 引用第二行');
    has(h, '<blockquote>', '引用块');
    has(h, '引用第一行', '引用内容');
}
{
    const h = B.renderMarkdown('上面\n\n---\n\n下面');
    has(h, '<hr>', '分隔线');
}
{
    const h = B.renderMarkdown('```\nconst a = 1 < 2;\n```');
    has(h, '<pre><code>', '代码块');
    has(h, 'const a = 1 &lt; 2;', '代码块内转义');
}
{
    const h = B.renderMarkdown('| 列A | 列B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |');
    has(h, '<table>', '表格');
    has(h, '<th>列A</th>', '表头');
    eq((h.match(/<tr>/g) || []).length, 3, '一行表头 + 两行数据');
    has(h, '<td>1</td>', '数据单元格');
}
{
    // 表格里缺列时应补空，而不是崩掉
    const h = B.renderMarkdown('| A | B | C |\n|---|---|---|\n| 1 |');
    eq((h.match(/<td>/g) || []).length, 3, '缺列自动补空单元格');
}

/* ============================================================
 * 5. Markdown 渲染 —— 行内
 * ============================================================ */
section('Markdown · 行内');
has(B.renderMarkdown('这是 **粗体** 文字'), '<strong>粗体</strong>', '粗体');
has(B.renderMarkdown('这是 *斜体* 文字'), '<em>斜体</em>', '斜体');
has(B.renderMarkdown('这是 `code` 片段'), '<code>code</code>', '行内代码');
has(B.renderMarkdown('[链接](https://a.com)'), '<a href="https://a.com" target="_blank" rel="noopener">链接</a>', '外部链接带新窗口');
has(B.renderMarkdown('[站内](other.html)'), '<a href="other.html">站内</a>', '站内链接不带 target');
has(B.renderMarkdown('[上级](../index.html)'), '<a href="../index.html">上级</a>', '相对路径链接');
has(B.renderMarkdown('[锚点](#section)'), '<a href="#section">锚点</a>', '锚点链接');
has(B.renderMarkdown('[邮件](mailto:a@b.com)'), '<a href="mailto:a@b.com">邮件</a>', 'mailto 链接');
{
    // 危险协议应被拦掉
    const h = B.renderMarkdown('[点我](javascript:alert(1))');
    notHas(h, 'javascript:', '拦截 javascript: 协议');
}
{
    // 行内标记中的 HTML 必须被转义
    const h = B.renderMarkdown('**<img src=x onerror=alert(1)>**');
    notHas(h, '<img', '行内 HTML 被转义');
    has(h, '&lt;img', '转义后保留可见文本');
}
{
    const h = B.renderMarkdown('| 表头 |\n|---|\n| **粗体** |');
    has(h, '<strong>粗体</strong>', '表格单元格内支持行内标记');
}

/* ============================================================
 * 6. 组合场景（模拟真实文章）
 * ============================================================ */
section('组合场景');
{
    const md = [
        '---', 'title: 测试', '---', '',
        '## 小节', '',
        '普通段落，含 **重点** 和 `代码`。', '',
        '| 成本块 | 金额 |', '|---|---|', '| 材料费 | 2.13 |', '',
        '> 提示引用', '',
        '1. 第一点', '2. 第二点', '',
        '```', 'raw <tag>', '```'
    ].join('\n');
    const fm = B.parseFrontMatter(md);
    const h = B.renderMarkdown(fm.body);
    has(h, '<h2>小节</h2>', '标题');
    has(h, '<strong>重点</strong>', '粗体');
    has(h, '<code>代码</code>', '行内代码');
    has(h, '<table>', '表格');
    has(h, '<blockquote>', '引用');
    has(h, '<ol>', '有序列表');
    has(h, 'raw &lt;tag&gt;', '代码块转义');
    notHas(h, '**', '无残留粗体标记');
    notHas(h, '`', '无残留反引号');
}

/* ============================================================
 * 7. 工艺价格库与会员门禁
 * ============================================================ */
section('工艺价格库');
const CRAFT = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'craft-prices.json'), 'utf8'));
{
    ok(CRAFT.items.length > 0, '有工艺条目', '实际 ' + CRAFT.items.length);

    eq(CRAFT.items.filter(i => !CRAFT.categories[i.category]).length, 0,
        '每项的 category 都在 categories 中定义');

    eq(CRAFT.items.filter(i => i.visibility !== 'public' && i.visibility !== 'member').length, 0,
        'visibility 只能是 public 或 member');

    const codes = CRAFT.items.map(i => i.code);
    eq(codes.filter((c, i) => codes.indexOf(c) !== i).length, 0, 'code 无重复');

    eq(CRAFT.items.filter(i => !i.unit).length, 0, '每项都有计价单位');
    eq(CRAFT.items.filter(i => !i.basis).length, 0, '每项都有计价基准（这是这个库的核心价值）');
    eq(CRAFT.items.filter(i => !i.name).length, 0, '每项都有名称');
}
{
    // ⭐ 公开数据必须自洽：冲压冲次费 = 机时费率 ÷ (SPM × 60)
    // 如果和工具里的设备费率表对不上，客户一算就发现矛盾
    const DB = require('../assets/cost-db.js');
    const eqs = DB.DEFAULTS.equipment.filter(e => e.kind === 'stamping');
    const mismatch = [];
    CRAFT.items.filter(i => i.code.indexOf('ST-STROKE-') === 0).forEach(it => {
        const ton = parseInt(it.code.replace('ST-STROKE-', ''), 10);
        const eq = eqs.filter(e => e.tonnage === ton)[0];
        if (!eq) { mismatch.push(it.code + '（找不到对应设备）'); return; }
        const expect = eq.hourlyRate / (eq.spm * 60);
        if (Math.abs(expect - it.unitPrice) > 0.0001) {
            mismatch.push(it.code + ' 应为 ' + expect.toFixed(4) + '，实际 ' + it.unitPrice);
        }
    });
    ok(mismatch.length === 0, '冲压冲次费与设备费率表推算一致'
        + (mismatch.length ? '：' + mismatch.join('；') : ''), mismatch.join('；'));
}
{
    // 门禁核心：会员价格绝不能出现在公开版 HTML 里
    const FAKE = { 'SF-CED': 12.34, 'CA-STEEL-BLANK': 7.89 };
    const pub = B.buildCraft(CRAFT, {}, { localPrices: FAKE });
    notHas(pub.html, '12.34', '公开版不泄露会员价格 SF-CED');
    notHas(pub.html, '7.89', '公开版不泄露会员价格 CA-STEEL-BLANK');
    has(pub.html, '🔒 会员可见', '公开版显示锁定标记');
    has(pub.html, '解锁会员区', '公开版有会员 CTA');
    has(pub.html, 'data/site.json', '未配置联系方式时提示去哪里配');

    const mem = B.buildCraft(CRAFT, {}, { unlock: true, localPrices: FAKE });
    has(mem.html, '12.34', '会员版包含会员价格');
    notHas(mem.html, '🔒 会员可见', '会员版无锁定标记');
    notHas(mem.html, '解锁会员区', '会员版无 CTA');

    ok(pub.memberCount > 0, '存在会员专属条目', '实际 ' + pub.memberCount + ' 项');
    eq(pub.count, pub.publicCount + pub.memberCount, '公开项 + 会员项 = 总项数');
}
{
    // 联系方式配置后，CTA 应显示对应渠道
    const site = { memberCta: { wechat: 'test_wx', formUrl: 'https://e.com/f', email: 'a@b.com' } };
    const r = B.buildCraft(CRAFT, site, {});
    has(r.html, 'test_wx', 'CTA 显示微信号');
    has(r.html, 'https://e.com/f', 'CTA 显示表单链接');
    has(r.html, 'mailto:a@b.com', 'CTA 显示邮箱');
    notHas(r.html, 'data/site.json', '已配置时不显示「去哪里配」提示');
}
{
    // 二维码渠道：路径必须按页面深度转成相对路径
    const site = { memberCta: { wechatQr: 'assets/wechat-qr.png', wechatNote: '扫码加微信' } };
    const r = B.buildCraft(CRAFT, site, {});
    has(r.html, 'src="../assets/wechat-qr.png"', 'CTA 里二维码用相对路径（页面在子目录）');
    has(r.html, '扫码加微信', 'CTA 显示扫码说明');
    notHas(r.html, 'src="assets/wechat-qr.png"', '不能出现根相对路径（子页面会 404）');
}

/* ============================================================
 * 7b. 交流社区
 * ============================================================ */
section('交流社区');
{
    const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'site.json'), 'utf8'));
    const r = B.buildCommunity(site);
    has(r.html, '交流社区', '页面标题');
    has(r.html, 'src="../assets/wechat-qr.png"', '显示二维码（相对路径正确）');
    has(r.html, '<ol class="rule-list">', '显示群规列表');
    has(r.html, site.community.rules[0].slice(0, 6), '群规内容被渲染');
    notHas(r.html, '<script>alert', '无注入内容');

    ok(r.groupCount > 0, '列出了交流群', '实际 ' + r.groupCount + ' 个');

    // 二维码图片必须真实存在
    if (site.community.wechatQr) {
        ok(fs.existsSync(path.join(ROOT, site.community.wechatQr)),
            '二维码图片存在：' + site.community.wechatQr);
    }
    if (site.memberCta.wechatQr) {
        ok(fs.existsSync(path.join(ROOT, site.memberCta.wechatQr)),
            '会员 CTA 的二维码图片存在：' + site.memberCta.wechatQr);
    }
}

/* ============================================================
 * 7c. 会员价格维护台
 * ============================================================ */
section('价格维护台');
{
    const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'site.json'), 'utf8'));
    const memberN = CRAFT.items.filter(i => i.visibility === 'member').length;

    const html = B.buildAdmin(CRAFT, { 'SF-CED': 12.5 });
    has(html, '/api/craft-prices', '接入了保存接口');
    has(html, '/api/build-member', '接入了构建接口');
    has(html, 'data-code="SF-CED"', '会员项渲染为输入框');
    has(html, 'value="12.5"', '已有本地价格被回填');
    has(html, 'data/site.json'.replace('site.json', 'craft-prices.local.json'),
        '说明了数据写到哪个文件');

    // 输入框数量必须等于会员项数量（不多不少）
    const inputs = (html.match(/<input type="number"[^>]*data-code=/g) || []).length;
    eq(inputs, memberN, '输入框数量 = 会员项数量（' + memberN + '）');

    // 公开项不应有输入框
    const pubCodes = CRAFT.items.filter(i => i.visibility === 'public').map(i => i.code);
    const leaked = pubCodes.filter(c => html.indexOf('data-code="' + c + '"') >= 0);
    eq(leaked.length, 0, '公开项没有输入框（只读）'
        + (leaked.length ? '：' + leaked.join(', ') : ''));

    // 维护台不能被搜索引擎收录
    notHas(html, '<link rel="canonical"', '维护台不设 canonical');
}
{
    // 端到端：构建必须产出 community/ 与 _admin/，且 _admin 不进 sitemap
    const r = B.build({ member: true });
    ok(fs.existsSync(path.join(ROOT, 'community', 'index.html')), 'community/index.html 已生成');
    ok(fs.existsSync(path.join(ROOT, '_admin', 'index.html')), '_admin/index.html 已生成');
    ok(fs.existsSync(path.join(ROOT, '_member', 'index.html')), '_member/index.html 已生成（会员版）');

    const sm = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
    notHas(sm, '_admin', 'sitemap 不含维护台（本地工具不该被索引）');
    notHas(sm, '_member', 'sitemap 不含会员版');
    has(sm, '/community/', 'sitemap 含交流社区');

    // 清理构建产物，避免把测试生成的会员版留在仓库里
    fs.rmSync(path.join(ROOT, '_member'), { recursive: true, force: true });
}

/* ============================================================
 * 8. 真实构建（端到端）
 * ============================================================ */
section('真实构建');
{
    let result = null;
    let err = null;
    try { result = B.build(); } catch (e) { err = e; }
    ok(!err, 'build() 执行成功', err && err.message);

    if (result) {
        ok(result.materials.count > 0, '生成了材料页', '实际 ' + result.materials.count + ' 个');
        ok(result.kb.count > 0, '生成了文章', '实际 ' + result.kb.count + ' 篇');
        ok(result.sitemap.count > result.materials.count, 'sitemap 覆盖所有页面');

        // 文件真的落盘了
        ok(fs.existsSync(path.join(ROOT, 'materials', 'index.html')), 'materials/index.html 已生成');
        ok(fs.existsSync(path.join(ROOT, 'kb', 'index.html')), 'kb/index.html 已生成');
        ok(fs.existsSync(path.join(ROOT, 'sitemap.xml')), 'sitemap.xml 已生成');

        // 每个材料都应有详情页，且页内不含未渲染标记
        const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'materials.json'), 'utf8'));
        let missing = 0, dirty = 0;
        data.materials.forEach(m => {
            const p = path.join(ROOT, 'materials', (m.slug || B.slugify(m.code)) + '.html');
            if (!fs.existsSync(p)) { missing++; return; }
            const html = fs.readFileSync(p, 'utf8');
            if (/\*\*|^\s*\|/m.test(html)) dirty++;
        });
        eq(missing, 0, '每个牌号都有详情页');
        eq(dirty, 0, '详情页没有残留 Markdown 标记');

        // slug 必须唯一，且不能回落成默认值
        // （中文名 slugify 后会变成空 → 回落成 item，这正是本轮修的 bug）
        const slugs = {};
        const dup = [], fallback = [], badSlug = [];
        data.materials.forEach(m => {
            const s = m.slug || B.slugify(m.code);
            if (slugs[s]) dup.push(s);
            slugs[s] = true;
            if (s === 'item') fallback.push(m.code);
            if (!/^[a-z0-9-]+$/.test(s)) badSlug.push(m.code + ' → ' + s);
        });
        eq(dup.length, 0, '牌号 slug 无重复' + (dup.length ? '：' + dup.join(', ') : ''));
        eq(fallback.length, 0, '没有牌号的 slug 回落到默认值 item'
            + (fallback.length ? '：' + fallback.join(', ') : ''));
        eq(badSlug.length, 0, '所有 slug 都是 URL 友好的小写 ASCII'
            + (badSlug.length ? '：' + badSlug.join('; ') : ''));

        // 列表页要包含搜索框与筛选（否则搜索功能是死的）
        const listHtml = fs.readFileSync(path.join(ROOT, 'materials', 'index.html'), 'utf8');
        has(listHtml, 'id="q"', '列表页有搜索框');
        has(listHtml, 'id="kf"', '列表页有类型筛选');
        has(listHtml, 'data-search=', '列表页每行带搜索索引');

        // 文章链接必须真实存在
        const kbIndex = fs.readFileSync(path.join(ROOT, 'kb', 'index.html'), 'utf8');
        const links = [...kbIndex.matchAll(/href="([^"]+\.html)"/g)].map(m => m[1]);
        let broken = 0;
        links.forEach(l => {
            if (l.startsWith('http')) return;
            if (!fs.existsSync(path.join(ROOT, 'kb', l))) broken++;
        });
        eq(broken, 0, '知识库列表里的文章链接全部有效');

        // 文章正文里的站内链接必须真实存在 —— 这次的链接 bug 就属于这一类
        const deadLinks = [];
        fs.readdirSync(path.join(ROOT, 'content')).filter(f => /\.md$/i.test(f)).forEach(f => {
            const raw = fs.readFileSync(path.join(ROOT, 'content', f), 'utf8');
            const body = B.parseFrontMatter(raw).body;
            [...body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].forEach(m => {
                const url = m[1].trim();
                if (/^(https?:|mailto:|#)/i.test(url)) return;
                if (!fs.existsSync(path.join(ROOT, 'kb', url))) deadLinks.push(f + ' → ' + url);
            });
        });
        eq(deadLinks.length, 0, '文章正文里的站内链接全部有效'
            + (deadLinks.length ? '：' + deadLinks.join('; ') : ''));
    }
}

/* ============================================================
 * 汇总
 * ============================================================ */
console.log('\n' + '═'.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
    console.log('\n失败详情：');
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
} else {
    console.log('✅ 全部通过');
}
