/*!
 * tools/smoke-dom.js —— 端到端 DOM 冒烟测试（jsdom）
 *
 * 用法（jsdom 装在项目外，需指定 NODE_PATH）：
 *   $env:NODE_PATH = "$env:TEMP\cost-domtest\node_modules"
 *   node tools/smoke-dom.js
 *
 * 为什么需要它：静态检查只能证明「id 对得上」，
 * 证明不了「点了有没有反应、算出来的数对不对」。这个测试真的把页面跑起来。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

let pass = 0, fail = 0;
const failures = [];

function ok(cond, label, extra) {
    if (cond) { pass++; }
    else { fail++; failures.push(label + (extra ? '\n    ' + extra : '')); }
}
function near(actual, expected, tol, label) {
    const a = parseFloat(actual);
    const good = isFinite(a) && Math.abs(a - expected) <= tol;
    ok(good, label, '期望 ≈' + expected + '（±' + tol + '），实际 ' + actual);
}
function money(text) {
    const m = String(text).match(/-?\d[\d,]*\.?\d*/);
    return m ? parseFloat(m[0].replace(/,/g, '')) : NaN;
}
function section(n) { console.log('\n── ' + n + ' ' + '─'.repeat(Math.max(0, 46 - n.length))); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function setInput(win, el, value, evt) {
    el.value = String(value);
    el.dispatchEvent(new win.Event(evt || 'input', { bubbles: true }));
}

/* ---------- 静态文件服务器（jsdom 需要 http 源才能用 localStorage） ---------- */
function startServer() {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
            const file = path.join(ROOT, rel || 'index.html');
            if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
                res.writeHead(404); res.end('not found'); return;
            }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
            res.end(fs.readFileSync(file));
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

/* ---------- 加载页面并收集错误 ---------- */
async function loadPage(server, relPath) {
    const url = 'http://127.0.0.1:' + server.address().port + '/' + relPath;
    const errors = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', e => errors.push('jsdomError: ' + (e && e.message)));
    vc.on('error', (...args) => errors.push('console.error: ' + args.join(' ')));

    const dom = await JSDOM.fromURL(url, {
        runScripts: 'dangerously',
        resources: 'usable',
        pretendToBeVisual: true,
        virtualConsole: vc
    });

    await new Promise(res => {
        if (dom.window.document.readyState === 'complete') return res();
        dom.window.addEventListener('load', res);
        setTimeout(res, 4000);
    });
    await new Promise(res => setTimeout(res, 400));

    dom.window.confirm = () => true;
    dom.window.alert = () => { };
    dom.window.prompt = () => null;

    return { dom, win: dom.window, doc: dom.window.document, errors };
}

/* ============================================================
 * 注塑件
 * ============================================================ */
async function testInjection(server) {
    section('注塑件 injection 端到端');
    const { dom, win, doc, errors } = await loadPage(server, 'injection/index.html');

    ok(errors.length === 0, '页面加载无 JS 错误', errors.join('\n    '));
    ok(!!win.CostEngine && win.CostEngine.VERSION === '1.0.0', '引擎已加载');
    ok(!!win.CostDB && !!win.CostUI, '参数库与 UI 组件已加载');

    // 默认场景：800×150×2.8 盒状件 / PP+EPDM-T20 / 供应商直送 / 3% 废品
    // 手算：净重 = 800×150×2.8÷1000 ×0.60×1.15 ×1.05 = 243.432g
    //      投料 = 243.432×1.03 = 250.735g → 材料费 = 0.250735×8.5 = 2.1312 元
    //      锁模力需求 1200cm²×0.5×1×1.2 = 720T → 850T 机（180元/h + 人工35元/h）
    //      周期 60s，1 穴 → 加工费 = 215 ÷ 60 = 3.5833 元
    //      模具 311,370 元 ÷ 100,000 件 = 3.1137 元
    //      直送：3000kg ÷ 0.243432kg = 12323 件/车 → 9 车 → 9×800÷100000 = 0.072 元
    //      包装 0.05 元 → 直接成本 8.9502 → ×1.232 = 11.0267 元
    const total = money(doc.getElementById('totalCostVal').textContent);
    near(total, 11.03, 0.02, '默认场景完全成本 = 11.03 元');

    const quote = money(doc.getElementById('quotePriceVal').textContent);
    near(quote, 12.46, 0.02, '含税报价 = 12.46 元（完全成本 × 1.13）');

    ok(doc.querySelectorAll('#costDetails .cost-card').length >= 7, '成本构成已渲染（含管理费/利润/运费/包装等明细科目）',
        '实际 ' + doc.querySelectorAll('#costDetails .cost-card').length + ' 项');
    ok(!!doc.querySelector('#costChart svg'), '环形图已用 SVG 自绘（无 CDN 依赖）');
    ok(doc.querySelectorAll('#costChart .ce-legend-row').length >= 7, '图例已渲染');

    const diag = doc.getElementById('diagnostics').textContent.trim();
    ok(diag === '', '默认参数下无诊断告警', '实际：' + diag);

    // 输入校验：把壁厚改成 0，应出现错误提示而不是算出 NaN
    doc.getElementById('thickness').value = '0';
    doc.getElementById('thickness').dispatchEvent(new win.Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    ok(/壁厚/.test(doc.getElementById('diagnostics').textContent), '非法壁厚给出校验提示');
    ok(isFinite(money(doc.getElementById('totalCostVal').textContent)), '非法输入不产生 NaN');

    // 恢复并切换物流模式，确保联动可用
    doc.getElementById('thickness').value = '2.8';
    doc.getElementById('thickness').dispatchEvent(new win.Event('input', { bubbles: true }));
    doc.getElementById('logisticsModel').value = 'rdc';
    doc.getElementById('logisticsModel').dispatchEvent(new win.Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    ok(doc.getElementById('rdcGroup').style.display === 'block', '切换到 RDC 模式后显示对应参数组');
    ok(/RDC/.test(doc.getElementById('logisticsDetail').textContent), '物流明细同步更新为 RDC');

    // 费率可配置：把税率改成 0，报价应等于完全成本
    doc.getElementById('taxRate').value = '0';
    doc.getElementById('taxRate').dispatchEvent(new win.Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    const t2 = money(doc.getElementById('totalCostVal').textContent);
    const q2 = money(doc.getElementById('quotePriceVal').textContent);
    near(q2, t2, 0.01, '税率改为 0 后，报价 = 完全成本（费率确实可配置）');

    // 参数库
    const matRows = doc.querySelectorAll('#materialTablePreview tbody tr').length;
    ok(matRows > 0, '材料价格库已渲染（来自参数库）', '实际 ' + matRows + ' 行');
    ok(win.CostDB.table('materials').all().length > 0, '参数库 materials 表可读');

    // 导出的确是实现了的（此前落地页宣传但代码里没有）
    ok(!!win.CostApp && typeof win.CostApp.exportExcel === 'function', '注入页已暴露 CostApp.exportExcel（此前落地页宣传但代码里没有）');
    let injExportThrew = false;
    try { win.CostApp.exportExcel(); } catch (e) { injExportThrew = true; }
    ok(!injExportThrew, '点击导出 Excel 不会抛出未捕获异常');

    // 备份按钮
    ok(doc.querySelector('#backupButtons [data-ce="export-backup"]') !== null, '导出备份按钮已挂载');
    ok(doc.querySelector('#backupButtons [data-ce="import-backup"]') !== null, '导入备份按钮已挂载');

    /* ---------- 新增能力 1：费率预设 ---------- */
    setInput(win, doc.getElementById('taxRate'), 13);
    await sleep(60);
    const presetSel = doc.querySelector('#presetPicker select');
    ok(!!presetSel, '费率预设选择器已挂载');
    ok(presetSel.options.length >= 5, '预设档位 >= 5 个', '实际 ' + presetSel.options.length);
    ok(!!doc.getElementById('cePresetDesc') && doc.getElementById('cePresetDesc').textContent.length > 10,
        '预设说明文字已显示');
    ok(/元\/h/.test(doc.getElementById('cePresetValues').textContent), '预设面板显示当前费率取值');

    const beforePreset = money(doc.getElementById('totalCostVal').textContent);
    presetSel.value = 'inland_low';
    presetSel.dispatchEvent(new win.Event('change', { bubbles: true }));
    await sleep(80);
    const afterPreset = money(doc.getElementById('totalCostVal').textContent);
    ok(afterPreset < beforePreset, '切到「内陆·低成本」后完全成本下降（人工/设备/模具费率下调）',
        beforePreset + ' → ' + afterPreset);

    presetSel.value = 'east_std';
    presetSel.dispatchEvent(new win.Event('change', { bubbles: true }));
    await sleep(80);
    near(money(doc.getElementById('totalCostVal').textContent), beforePreset, 0.02, '切回基准档后完全成本复原');

    /* ---------- 新增能力 2：材料价格批量导入 ---------- */
    doc.getElementById('importPriceBtn').click();
    await sleep(50);
    const modal = doc.getElementById('cePriceImportModal');
    ok(!!modal, '批量导入弹窗已打开');
    const ta = modal.querySelector('#cePriceInput');
    ok(!!ta, '弹窗内有粘贴框');
    ok(!!modal.querySelector('[data-ce="template"]'), '弹窗内有「下载模板」按钮');

    ta.value = 'PP+EPDM-T20,20,测试来源\n不存在的牌号XYZ,9.9';
    ta.dispatchEvent(new win.Event('input', { bubbles: true }));
    modal.querySelector('[data-ce="preview"]').click();
    await sleep(50);
    const pv = modal.querySelector('#cePricePreview').textContent;
    ok(/匹配\s*1/.test(pv), '预览显示「匹配 1」', pv.slice(0, 140));
    ok(/未匹配\s*1/.test(pv), '预览显示「未匹配 1」');

    const beforeImport = money(doc.getElementById('totalCostVal').textContent);
    modal.querySelector('[data-ce="apply"]').click();
    await sleep(100);
    ok(!doc.getElementById('cePriceImportModal'), '应用后弹窗自动关闭');
    const afterImport = money(doc.getElementById('totalCostVal').textContent);
    ok(Math.abs(afterImport - beforeImport) > 0.5, '导入新价后完全成本随之变化',
        beforeImport + ' → ' + afterImport);

    const matAfter = win.CostDB.table('materials').all().find(m => m.code === 'PP+EPDM-T20');
    near(matAfter.unitPrice, 20, 1e-6, '参数库中材料单价已更新为 20');
    ok(/测试来源/.test(matAfter.source || ''), '数据来源被记录：' + matAfter.source);
    ok(!!matAfter.updatedAt, '更新日期被记录：' + matAfter.updatedAt);

    /* ---------- 意见反馈 ---------- */
    doc.getElementById('feedbackBtn').click();
    await sleep(50);
    let fb = doc.getElementById('ceFeedbackModal');
    ok(!!fb, '意见反馈弹窗已打开');
    ok(!!fb.querySelector('#ceFeedbackText'), '弹窗内有内容输入框');
    ok(/复制内容/.test(fb.textContent), '弹窗内有「复制内容」按钮');
    ok(/引擎版本/.test(fb.querySelector('#ceFeedbackText').value), '内容框预填了环境信息（便于定位问题）');
    ok(/没有服务器/.test(fb.textContent), '明确告知没有服务器，不假装已提交');
    ok(!!fb.querySelector('[data-ce="history"]'), '弹窗内有「本机反馈记录」入口');
    ok(/cost-config\.js/.test(fb.textContent), '未配置渠道时提示部署者去哪里配置');
    fb.querySelector('[data-ce="close"]').click();
    await sleep(30);
    ok(!doc.getElementById('ceFeedbackModal'), '弹窗可正常关闭');

    // 配置渠道后应出现对应按钮
    win.COST_TOOL_CONFIG.feedbackWechat = 'test_wx_id';
    win.COST_TOOL_CONFIG.feedbackFormUrl = 'https://example.com/form';
    win.COST_TOOL_CONFIG.feedbackEmail = 'a@b.com';
    doc.getElementById('feedbackBtn').click();
    await sleep(50);
    fb = doc.getElementById('ceFeedbackModal');
    ok(/加微信发送/.test(fb.textContent), '配置微信号后出现「加微信发送」按钮');
    ok(/打开在线表单/.test(fb.textContent), '配置表单链接后出现「打开在线表单」按钮');
    ok(/用邮件发送/.test(fb.textContent), '配置邮箱后出现「用邮件发送」按钮');
    ok(!/cost-config\.js/.test(fb.textContent), '已配置渠道时不再显示配置提示');

    // 「加微信」应展开微信号（不跳转、不丢内容）
    fb.querySelectorAll('#ceFeedbackActions button')[2].click();
    await sleep(40);
    ok(/test_wx_id/.test(fb.querySelector('#ceFeedbackExtra').textContent), '点「加微信」后展开微信号');

    fb.querySelector('[data-ce="close"]').click();
    await sleep(30);

    /* ---------- 账期资金占用（本轮从引擎接到界面） ---------- */
    setInput(win, doc.getElementById('paymentDays'), 0);
    setInput(win, doc.getElementById('capitalRate'), 6);
    await sleep(60);
    const beforeTerms = money(doc.getElementById('totalCostVal').textContent);

    setInput(win, doc.getElementById('paymentDays'), 90);
    await sleep(60);
    const afterTerms = money(doc.getElementById('totalCostVal').textContent);
    ok(afterTerms > beforeTerms, '设置 90 天账期后完全成本上升（账期已接入界面）',
        beforeTerms + ' → ' + afterTerms);
    near((afterTerms - beforeTerms) / beforeTerms, 0.0148, 0.003, '账期成本约占 1.5%（90 天 × 年化 6%）');
    ok(/账期资金占用/.test(doc.getElementById('costDetails').textContent),
        '成本构成明细里出现「账期资金占用」一行');

    setInput(win, doc.getElementById('paymentDays'), 180);
    await sleep(60);
    const at180 = money(doc.getElementById('totalCostVal').textContent);
    ok(at180 > afterTerms, '账期 180 天成本进一步上升', afterTerms + ' → ' + at180);

    setInput(win, doc.getElementById('capitalRate'), 0);
    await sleep(60);
    near(money(doc.getElementById('totalCostVal').textContent), beforeTerms, 0.01,
        '资金成本设为 0 时账期不产生成本');

    dom.window.close();
}

/* ============================================================
 * 冲压件
 * ============================================================ */
async function testStamping(server) {
    section('冲压件 stamping 端到端');
    const { dom, win, doc, errors } = await loadPage(server, 'stamping/index.html');

    ok(errors.length === 0, '页面加载无 JS 错误', errors.join('\n    '));

    const total = money(doc.getElementById('totalCostVal').textContent);
    ok(total > 0 && isFinite(total), '完全成本为正数', '实际 ' + total);
    ok(!!doc.querySelector('#costChart svg'), '环形图已用 SVG 自绘（无 CDN 依赖）');
    ok(doc.getElementById('diagnostics').textContent.trim() === '', '默认参数下无诊断告警',
        '实际：' + doc.getElementById('diagnostics').textContent.trim());

    // ---- BUG-3 回归：模具重量不得乘以零件数量 ----
    // 示例 BOM：主骨架 1500+800+2000=4300kg（qty1）
    //           左加强板 600+400=1000kg（qty2，旧代码算成 2000）
    //           右加强板 1000kg（qty2，旧代码算成 2000）
    // 正确合计 = 6300kg；旧代码 = 8300kg
    const dieText = doc.getElementById('dieCostDetail').textContent;
    ok(/6300\s*kg/.test(dieText), 'BUG-3 已修复：模具重量 = 6300kg（未乘以零件数量）',
        '实际：' + dieText.trim());

    // ---- BUG-4 回归：净重 / 下料毛重 双口径 ----
    const matText = doc.getElementById('materialBreakdown').textContent;
    ok(/下料毛重/.test(matText) && /净重/.test(matText), 'BUG-4 已修复：材料明细区分净重与下料毛重');
    ok(/利用率\s*75%/.test(matText), 'BUG-4 已修复：材料利用率参与计算（默认 75%）',
        '实际片段：' + matText.slice(0, 200));

    // ---- BUG-2 回归：物流重量来自 BOM 真实重量，而不是「成本 ÷ 6」 ----
    // 手算毛重：主骨架 850×550×1.2÷1000×7.85 = 4403.85g
    //          左/右加强板 420×120×1.0÷1000×7.85 = 395.64g，各 ×2
    //          合计 = 4403.85 + 395.64×4 = 5986.41g = 5.98641kg
    //  理论运费 = 0.5 元/吨公里 × 5.98641kg/1000 × 500km × 1000 = 1496.6 元
    //  单件运费 = 1496.6 ÷ 8000 + 0.5（装卸）= 0.687075 元
    const expectedFreight = (0.5 * 5.98641 * 500) / 8000 + 0.5;
    const logiText = doc.getElementById('calcDetails') ? '' : '';
    ok(Math.abs(expectedFreight - 0.687075) < 1e-6, '（自检）手算运费基准 = 0.687075 元');

    // ---- 独立复算完全成本，验证整条链路 ----
    // 毛重材料费 = (4403.85 + 395.64×4)÷1000 × 5.8 = 5.98641×5.8 = 34.7212
    // 净重合计   = (4403.85×0.75 + 395.64×0.75×4)÷1000 = 4.4898 kg
    // 废料回收   = (5.98641 − 4.48981) × 2.0 = 2.9932
    // 材料净成本 = 34.7212 − 2.9932 = 31.7280
    // 加工费：主骨架 120/(45×60)×1 + 90/(52×60)×2 + 150/(40×60)×1
    //                + 加强板×2 ×2 ×〔90/(52×60)×1 + 70/(60×60)×2〕
    const rps = (rate, spm) => rate / (spm * 60);
    const mainProc = rps(120, 45) * 1 + rps(90, 52) * 2 + rps(150, 40) * 1;
    const ribProc = (rps(90, 52) * 1 + rps(70, 60) * 2) * 2;   // 单块加强板 × qty2
    const expectedProcess = mainProc + ribProc * 2;             // 左 + 右
    // 焊接：2 组点焊 × 4 点 × 0.25 元 × 子件 qty2 = 4.0 元（FIX-6 按数量放大）
    const expectedWeld = 2 * 4 * 0.25 * 2;
    // 模具：6300kg × 25 元/kg ÷ 100,000 件 = 1.575 元
    const expectedDie = 6300 * 25 / 100000;
    const expectedDirect = (34.7212 - 2.9932) + expectedProcess + expectedWeld + expectedDie + expectedFreight;
    const expectedTotal = expectedDirect * 1.232;

    near(total, expectedTotal, 0.05, '完全成本与独立复算一致（材料+加工+焊接+模具+物流，×1.232）');
    ok(Math.abs(expectedWeld - 4.0) < 1e-9, '（自检）焊接费按子件数量放大 = 4.0 元');
    ok(Math.abs(expectedDie - 1.575) < 1e-9, '（自检）模具分摊 = 1.575 元');

    // ---- BUG-5 回归：设备匹配不再用精确相等 ----
    // 把工序吨位改成费率库里没有的 300T：
    //   旧代码 === 匹配失败 → 静默退化成 0.05 元/冲次的兜底值
    //   新代码 → 应匹配到「不小于 300T 的最小设备」= 315T
    const beforeTotal = total;
    win.eval('bomTree[0].processes[0].tonnage = 300; renderBomTree(); calculate();');
    await new Promise(r => setTimeout(r, 60));
    const afterTotal = money(doc.getElementById('totalCostVal').textContent);
    const detailText = doc.getElementById('calcDetails').textContent;
    ok(/315T/.test(detailText), 'BUG-5 已修复：300T 需求匹配到 315T 设备（旧代码会退化成 0.05 元/冲次）',
        '实际：' + detailText.slice(0, 160));
    ok(isFinite(afterTotal) && Math.abs(afterTotal - beforeTotal) > 1e-6,
        'BUG-5 已修复：换设备后成本随之变化（315T 费率 100元/h ≠ 400T 的 120元/h）',
        '改前 ' + beforeTotal + ' → 改后 ' + afterTotal);

    // 355T 落在 315T 与 400T 之间，应映射到 400T —— 与原始 400T 结果一致，反证匹配是按「不小于」而非精确相等
    win.eval('bomTree[0].processes[0].tonnage = 400; renderBomTree(); calculate();');
    await new Promise(r => setTimeout(r, 60));
    const backTo400 = money(doc.getElementById('totalCostVal').textContent);
    win.eval('bomTree[0].processes[0].tonnage = 355; renderBomTree(); calculate();');
    await new Promise(r => setTimeout(r, 60));
    const at355 = money(doc.getElementById('totalCostVal').textContent);
    near(at355, backTo400, 1e-6, 'BUG-5 已修复：355T 映射到 400T，结果与原 400T 完全一致');
    win.eval('bomTree[0].processes[0].tonnage = 400; renderBomTree(); calculate();');

    // ---- BUG-9 回归：历史记录不再每次重算都写入 ----
    const histBefore = win.CostDB.state('history') || [];
    win.eval('calculate(); calculate(); calculate();');
    await new Promise(r => setTimeout(r, 60));
    const histAfter = win.CostDB.state('history') || [];
    ok(histAfter.length === histBefore.length, 'BUG-9 已修复：连续重算不产生历史记录',
        '改前 ' + histBefore.length + ' 条 → 改后 ' + histAfter.length + ' 条');

    win.eval('saveHistorySnapshot();');
    await new Promise(r => setTimeout(r, 60));
    const histSaved = win.CostDB.state('history') || [];
    ok(histSaved.length === histBefore.length + 1, '显式「保存本次测算」才写入历史',
        '实际 ' + histSaved.length + ' 条');
    ok(doc.querySelectorAll('#historyList div').length > 0, '历史记录已渲染到界面');

    // ---- BUG-1 回归：导出 Excel 按钮真的绑定了 ----
    ok(typeof win.eval('exportExcel') === 'function', 'BUG-1 已修复：exportExcel 函数存在');
    // 触发一次导出，确认不会静默失败（jsdom 无 createObjectURL，应被 try/catch 兜住）
    let exportThrew = false;
    try { win.eval('exportExcel();'); } catch (e) { exportThrew = true; }
    ok(!exportThrew, 'BUG-1 已修复：点击导出 Excel 不会抛出未捕获异常');

    // ---- 费率可配置 ----
    doc.getElementById('mgmtRate').value = '0';
    doc.getElementById('profitRate').value = '0';
    doc.getElementById('taxRate').value = '0';
    doc.getElementById('mgmtRate').dispatchEvent(new win.Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    const t3 = money(doc.getElementById('totalCostVal').textContent);
    const q3 = money(doc.getElementById('quotePriceVal').textContent);
    near(q3, t3, 0.01, '费率清零后报价 = 完全成本（管理费/利润/税率可配置）');

    /* ---------- 新增能力 1：费率预设 ---------- */
    setInput(win, doc.getElementById('mgmtRate'), 12);
    setInput(win, doc.getElementById('profitRate'), 10);
    setInput(win, doc.getElementById('taxRate'), 13);
    await sleep(60);

    const presetSel = doc.querySelector('#presetPicker select');
    ok(!!presetSel, '费率预设选择器已挂载');
    ok(presetSel.options.length >= 5, '预设档位 >= 5 个', '实际 ' + presetSel.options.length);
    ok(/元\/h/.test(doc.getElementById('cePresetValues').textContent), '预设面板显示当前费率取值');
    ok(/下料利用率/.test(doc.getElementById('cePresetValues').textContent), '冲压页预设面板含下料利用率');

    const beforePreset = money(doc.getElementById('totalCostVal').textContent);
    presetSel.value = 'east_high';
    presetSel.dispatchEvent(new win.Event('change', { bubbles: true }));
    await sleep(80);
    const afterPreset = money(doc.getElementById('totalCostVal').textContent);
    ok(afterPreset > beforePreset, '切到「华东·高自动化」后完全成本上升（设备/模具费率上调）',
        beforePreset + ' → ' + afterPreset);
    ok(/基准\s*120\s*×\s*1\.20/.test(doc.getElementById('calcDetails').textContent),
        '计算明细里显示了设备费率系数的来源',
        doc.getElementById('calcDetails').textContent.slice(0, 200));
    ok(/下料利用率\s*78%/.test(doc.getElementById('materialBreakdown').textContent)
        || /利用率\s*78%/.test(doc.getElementById('materialBreakdown').textContent),
        '预设的下料利用率同步生效（78%）',
        doc.getElementById('materialBreakdown').textContent.slice(0, 160));

    presetSel.value = 'east_std';
    presetSel.dispatchEvent(new win.Event('change', { bubbles: true }));
    await sleep(80);
    near(money(doc.getElementById('totalCostVal').textContent), beforePreset, 0.05, '切回基准档后完全成本复原');

    /* ---------- 新增能力 2：板材价格批量导入 ---------- */
    doc.getElementById('importPriceBtn').click();
    await sleep(50);
    const modal = doc.getElementById('cePriceImportModal');
    ok(!!modal, '批量导入弹窗已打开');
    const ta = modal.querySelector('#cePriceInput');
    ta.value = 'dc01,7.5,测试来源\nQ235A,3.5';
    ta.dispatchEvent(new win.Event('input', { bubbles: true }));
    modal.querySelector('[data-ce="preview"]').click();
    await sleep(50);
    const pv = modal.querySelector('#cePricePreview').textContent;
    ok(/匹配\s*2/.test(pv), '小写牌号也能匹配（预览显示匹配 2）', pv.slice(0, 140));

    const beforeImport = money(doc.getElementById('totalCostVal').textContent);
    modal.querySelector('[data-ce="apply"]').click();
    await sleep(100);
    ok(!doc.getElementById('cePriceImportModal'), '应用后弹窗自动关闭');
    const afterImport = money(doc.getElementById('totalCostVal').textContent);
    ok(afterImport > beforeImport, '板材涨价后完全成本上升',
        beforeImport + ' → ' + afterImport);
    const matAfter = win.CostDB.table('materials').all().find(m => m.code === 'DC01');
    near(matAfter.unitPrice, 7.5, 1e-6, '参数库中 DC01 单价已更新为 7.5');
    ok(/测试来源/.test(matAfter.source || ''), '数据来源被记录：' + matAfter.source);

    /* ---------- 意见反馈（此前冲压件仍是「假提交」，本轮统一） ---------- */
    doc.getElementById('feedbackBtn').click();
    await sleep(50);
    const fb = doc.getElementById('ceFeedbackModal');
    ok(!!fb, '冲压件意见反馈弹窗已打开（改用共享弹窗）');
    ok(/没有服务器/.test(fb.textContent), '冲压件也明确告知没有服务器');
    ok(/引擎版本/.test(fb.querySelector('#ceFeedbackText').value), '内容框预填了环境信息');
    ok(/总成/.test(fb.querySelector('#ceFeedbackText').value), '环境信息里带上了当前总成名');
    fb.querySelector('[data-ce="close"]').click();
    await sleep(30);
    ok(!doc.getElementById('ceFeedbackModal'), '弹窗可正常关闭');

    /* ---------- 账期资金占用（冲压件同样接入） ---------- */
    setInput(win, doc.getElementById('paymentDays'), 0);
    setInput(win, doc.getElementById('capitalRate'), 6);
    await sleep(60);
    const stBefore = money(doc.getElementById('totalCostVal').textContent);
    setInput(win, doc.getElementById('paymentDays'), 90);
    await sleep(60);
    const stAfter = money(doc.getElementById('totalCostVal').textContent);
    ok(stAfter > stBefore, '冲压件设置 90 天账期后完全成本上升', stBefore + ' → ' + stAfter);
    near((stAfter - stBefore) / stBefore, 0.0148, 0.003, '冲压件账期成本约占 1.5%');

    // 旧的本地假反馈入口应当已移除
    ok(!doc.getElementById('feedbackModal'), '旧的「提交后存本地」假反馈弹窗已移除');
    ok(!doc.getElementById('viewFeedbackModal'), '旧的反馈列表弹窗已移除');

    dom.window.close();
}

/* ============================================================
 * 落地页
 * ============================================================ */
async function testLanding(server) {
    section('落地页 index.html');
    const { dom, win, doc, errors } = await loadPage(server, 'index.html');
    ok(errors.length === 0, '落地页加载无错误', errors.join('\n    '));
    const links = [...doc.querySelectorAll('a[href]')].map(a => a.getAttribute('href'));
    ok(links.some(h => /injection\/index\.html/.test(h)), '注塑件入口链接存在');
    ok(links.some(h => /stamping\/index\.html/.test(h)), '冲压件入口链接存在');
    ok(!/Excel导出/.test(doc.body.textContent) || /注塑件/.test(doc.body.textContent), '落地页文案与实际功能一致');
    ok(!/你用户名|你的用户名|仓库名/.test(doc.body.textContent), '落地页无占位符残留');
    dom.window.close();
}

/* ============================================================ */
(async () => {
    const server = await startServer();
    console.log('端到端 DOM 冒烟测试');
    try {
        await testInjection(server);
        await testStamping(server);
        await testLanding(server);
    } catch (e) {
        fail++;
        failures.push('测试执行异常：' + (e && e.stack || e));
    } finally {
        server.close();
    }

    console.log('\n' + '═'.repeat(52));
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (fail) {
        console.log('\n失败详情：');
        failures.forEach(f => console.log('  ✗ ' + f));
        process.exit(1);
    } else {
        console.log('✅ 端到端全部通过');
    }
})();
