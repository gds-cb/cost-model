/*!
 * tools/test-db.js —— 参数库单元测试（Node 直接运行）
 * 用法：node tools/test-db.js
 *
 * 重点覆盖「价格批量导入」的解析与匹配——这是客户每天要用的入口，
 * 解析器一旦漏掉一种分隔符，客户就会觉得「这工具不认我的表」。
 */
'use strict';

const DB = require('../assets/cost-db.js');

let pass = 0, fail = 0;
const failures = [];

function eq(actual, expected, label) {
    const ok = String(actual) === String(expected);
    if (ok) pass++; else { fail++; failures.push(label + '\n    期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual)); }
}
function ok(cond, label, extra) {
    if (cond) pass++; else { fail++; failures.push(label + (extra ? '\n    ' + extra : '')); }
}
function section(n) { console.log('\n── ' + n + ' ' + '─'.repeat(Math.max(0, 46 - n.length))); }

/* ============================================================
 * 1. 牌号归一化
 * ============================================================ */
section('牌号归一化');
eq(DB.normalizeCode('DC01'), 'DC01', '原样保留');
eq(DB.normalizeCode('dc01'), 'DC01', '统一大写');
eq(DB.normalizeCode('  DC 01  '), 'DC01', '去空格');
eq(DB.normalizeCode('ＰＣ／ＡＢＳ'), 'PC/ABS', '全角转半角');
eq(DB.normalizeCode(null), '', 'null 安全');
eq(DB.normalizeCode(undefined), '', 'undefined 安全');

/* ============================================================
 * 2. 价格文本解析
 * ============================================================ */
section('价格文本解析');

{
    const r = DB.parsePriceList('DC01,5.8');
    eq(r.rows.length, 1, '标准逗号分隔');
    eq(r.rows[0].code, 'DC01', '牌号');
    eq(r.rows[0].price, 5.8, '单价');
}
{
    const r = DB.parsePriceList('DC01,5.8,2026-03 采购询价');
    eq(r.rows[0].source, '2026-03 采购询价', '第三列作为数据来源');
}
{
    const r = DB.parsePriceList('DC01\t5.8');
    eq(r.rows[0].price, 5.8, '制表符分隔（从 Excel 复制）');
}
{
    const r = DB.parsePriceList('DC01;5.8');
    eq(r.rows[0].price, 5.8, '分号分隔');
}
{
    const r = DB.parsePriceList('DC01，5.8');
    eq(r.rows[0].price, 5.8, '中文逗号分隔');
}
{
    const r = DB.parsePriceList('DC01  5.8');
    eq(r.rows[0].price, 5.8, '两个空格分隔');
}
{
    const r = DB.parsePriceList('DC01 5.8');
    eq(r.rows[0].price, 5.8, '单个空格分隔');
}
{
    const r = DB.parsePriceList('DC01|5.8');
    eq(r.rows[0].price, 5.8, '竖线分隔');
}
{
    const r = DB.parsePriceList('  牌号,单价(元/kg)\nDC01,5.8\nQ235A,3.5  ');
    eq(r.rows.length, 2, '表头行被跳过，只保留数据行');
    eq(r.skippedHeaders, 1, '统计跳过的表头行数');
}
{
    const r = DB.parsePriceList('# 这是注释\n// 这也是\nDC01,5.8\n\n   \nQ235A,3.5');
    eq(r.rows.length, 2, '注释行与空行被忽略');
}
{
    const r = DB.parsePriceList('DC01,5.8元');
    eq(r.rows[0].price, 5.8, '带单位后缀仍能解析');
}
{
    const r = DB.parsePriceList('DC01\nQ235A,3.5\nDC03,abc\nDC04,-1');
    eq(r.rows.length, 1, '只保留合法行');
    eq(r.errors.length, 3, '三行报错');
    ok(r.errors.some(e => /缺少单价/.test(e.reason)), '缺单价被识别');
    ok(r.errors.some(e => /不是有效数字/.test(e.reason)), '非数字被识别');
    ok(r.errors.some(e => /负/.test(e.reason)), '负单价被识别');
}
{
    const r = DB.parsePriceList('');
    eq(r.rows.length, 0, '空文本安全');
    eq(r.errors.length, 0, '空文本无报错');
}
eq(DB.parsePriceList(null).rows.length, 0, 'null 安全');

/* ============================================================
 * 3. 价格导入匹配
 * ============================================================ */
section('价格导入匹配');
{
    const all = DB.table('materials').all();
    ok(all.length > 0, '参数库有默认材料', '实际 ' + all.length + ' 条');

    const target = all[0];
    const r = DB.importPriceList(target.code + ',99.5', { table: 'materials' });
    eq(r.ok, true, '导入返回 ok');
    eq(r.matched.length, 1, '匹配到 1 条');
    eq(r.matched[0].newPrice, 99.5, '新价正确');
    eq(r.matched[0].code, target.code, '回写的是库里真实的牌号写法');
}
{
    // 大小写 / 空格 / 全角 都应能匹配上同一条
    const target = DB.table('materials').all().find(m => m.code === 'DC01');
    ok(!!target, '默认库里有 DC01');
    ['dc01,1.1', ' DC01 , 1.2', 'ＤＣ０１,1.3'].forEach(txt => {
        const r = DB.importPriceList(txt, { table: 'materials' });
        eq(r.matched.length, 1, '模糊匹配成功：' + txt.trim());
    });
}
{
    const r = DB.importPriceList('不存在的牌号XYZ,10\nDC01,5.8', { table: 'materials' });
    eq(r.matched.length, 1, '一条匹配、一条不匹配');
    eq(r.unmatched.length, 1, '未匹配单独列出');
    eq(r.unmatched[0].code, '不存在的牌号XYZ', '未匹配保留原始牌号');
}
{
    // 预览（apply 不传）不应写入
    const before = DB.table('materials').all().find(m => m.code === 'Q235A').unitPrice;
    DB.importPriceList('Q235A,999', { table: 'materials' });
    const after = DB.table('materials').all().find(m => m.code === 'Q235A').unitPrice;
    eq(after, before, '仅预览时不写入参数库');
}
{
    const r = DB.importPriceList('', { table: 'materials' });
    eq(r.matched.length, 0, '空输入不匹配任何东西');
    eq(r.unmatched.length, 0, '空输入无未匹配');
}

/* ============================================================
 * 4. 价格模板
 * ============================================================ */
section('价格模板');
{
    const csv = DB.buildPriceTemplate('materials');
    const lines = csv.split('\r\n');
    ok(/牌号/.test(lines[0]) && /单价/.test(lines[0]), '首行是表头');
    ok(/数据来源/.test(lines[0]) && /更新日期/.test(lines[0]), '表头含来源与更新日期（督促用户填）');
    const all = DB.table('materials').all();
    eq(lines.length, all.length + 1, '每个牌号一行');
    ok(lines.slice(1).every(l => l.split(',').length >= 2), '数据行都有牌号与单价');
}

/* ============================================================
 * 5. 费率预设
 * ============================================================ */
section('费率预设');
{
    eq(DB.PRESET_ORDER.length, Object.keys(DB.PRESETS).length, 'PRESET_ORDER 与 PRESETS 数量一致');
    ok(DB.PRESET_ORDER.includes('east_std'), '包含基准档 east_std');

    DB.PRESET_ORDER.forEach(id => {
        const p = DB.PRESETS[id];
        ok(!!p && !!p.name && !!p.desc, '预设 ' + id + ' 有名称与说明');
        ok(typeof p.laborRate === 'number' && p.laborRate > 0, '预设 ' + id + ' 人工费率有效');
        ok(typeof p.equipmentRateFactor === 'number' && p.equipmentRateFactor > 0, '预设 ' + id + ' 设备费率系数有效');
        ok(typeof p.moldPriceFactor === 'number' && p.moldPriceFactor > 0, '预设 ' + id + ' 模具价格系数有效');
        ok(typeof p.blankUtilization === 'number' && p.blankUtilization > 0 && p.blankUtilization <= 100, '预设 ' + id + ' 下料利用率在 (0,100]');
        // 关键设计约束：预设不得包含管理费率/利润率 —— 那是商务决策，不是地区属性。
        // 混进来会让「高自动化档」总成本反而更低，自相矛盾。
        ok(p.managementRate === undefined && p.profitRate === undefined,
            '预设 ' + id + ' 不掺管理费率/利润率');
    });

    // 成本驱动因子应单调：高自动化 > 通用 > 华北 > 内陆
    const factorOrder = ['east_high', 'east_std', 'north_std', 'inland_low'];
    for (let i = 0; i + 1 < factorOrder.length; i++) {
        const a = DB.PRESETS[factorOrder[i]], b = DB.PRESETS[factorOrder[i + 1]];
        ok(a.equipmentRateFactor >= b.equipmentRateFactor,
            '设备费率系数单调：' + factorOrder[i] + ' ≥ ' + factorOrder[i + 1]);
        ok(a.moldPriceFactor >= b.moldPriceFactor,
            '模具价格系数单调：' + factorOrder[i] + ' ≥ ' + factorOrder[i + 1]);
        ok(a.blankUtilization >= b.blankUtilization,
            '材料利用率单调：' + factorOrder[i] + ' ≥ ' + factorOrder[i + 1]);
    }

    // 基准档应是 1.0 系数，其他档位以它为参照
    eq(DB.PRESETS.east_std.equipmentRateFactor, 1, '基准档设备系数 = 1');
    eq(DB.PRESETS.east_std.moldPriceFactor, 1, '基准档模具系数 = 1');

    // 两个页面的默认 settings 必须引用一个真实存在的预设
    ['injection', 'stamping'].forEach(scope => {
        const d = DB.SETTINGS_DEFAULTS[scope];
        ok(!!DB.PRESETS[d.preset], scope + ' 的默认 preset 存在于 PRESETS 中：' + d.preset);
        ok(typeof d.equipmentRateFactor === 'number' && typeof d.moldPriceFactor === 'number',
            scope + ' 设置了设备/模具费率系数默认值');
    });

    // 套用预设：返回合并后的 settings
    const next = DB.applyPreset('injection', 'inland_low');
    eq(next.preset, 'inland_low', 'applyPreset 记录预设 id');
    eq(next.laborRate, DB.PRESETS.inland_low.laborRate, 'applyPreset 写入人工费率');
    eq(next.equipmentRateFactor, DB.PRESETS.inland_low.equipmentRateFactor, 'applyPreset 写入设备系数');
    eq(next.moldPriceFactor, DB.PRESETS.inland_low.moldPriceFactor, 'applyPreset 写入模具系数');
    ok(next.cavityPricePerCm2 === DB.SETTINGS_DEFAULTS.injection.cavityPricePerCm2,
        'applyPreset 不动非费率参数（型腔单价保持默认）');
    eq(next.managementRate, DB.SETTINGS_DEFAULTS.injection.managementRate,
        'applyPreset 不动管理费率（商务决策由用户自己定）');
    eq(next.profitRate, DB.SETTINGS_DEFAULTS.injection.profitRate,
        'applyPreset 不动利润率');

    eq(DB.applyPreset('injection', '不存在的档位'), null, '未知预设返回 null');
}

/* ============================================================
 * 6. 跨工具数据不互相污染
 * ============================================================ */
section('数据隔离');
{
    // 注塑件只碰非 sheet，冲压件只碰 sheet —— 用默认库验证两类都存在
    const all = DB.table('materials').all();
    ok(all.some(m => m.kind === 'sheet'), '默认库含金属板材（冲压用）');
    ok(all.some(m => m.kind === 'polymer' || m.kind === 'other'), '默认库含塑料/其他（注塑用）');

    const eqAll = DB.table('equipment').all();
    ok(eqAll.some(e => e.kind === 'injection'), '默认库含注塑机型');
    ok(eqAll.some(e => e.kind === 'stamping'), '默认库含冲压机型');

    // 案例库引用的吨位必须在设备库里存在，否则匹配会静默失败
    const tonnages = {};
    eqAll.filter(e => e.kind === 'stamping').forEach(e => { tonnages[e.tonnage] = true; });
    const missing = [];
    DB.table('cases').all().forEach(c => {
        (c.processes || []).forEach(p => { if (!tonnages[p.tonnage]) missing.push(c.name + ' / ' + p.name + ' → ' + p.tonnage + 'T'); });
    });
    eq(missing.length, 0, '所有判例引用的设备吨位都在费率库中' + (missing.length ? '：' + missing.join('; ') : ''));

    // BOM 示例引用的材料 id 必须存在
    const ids = {};
    all.forEach(m => { ids[m.id] = true; });
    ['dc01', 'q235'].forEach(id => ok(!!ids[id], '示例 BOM 引用的材料 id 存在：' + id));
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
