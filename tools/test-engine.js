/*!
 * tools/test-engine.js —— 成本引擎单元测试（Node 直接运行）
 * 用法：node tools/test-engine.js
 *
 * 为什么要有这个：成本工具算错了比算不准更致命。
 * 任何公式改动都必须先过这里，再上页面。
 */
'use strict';

const E = require('../assets/cost-engine.js');

let pass = 0, fail = 0;
const failures = [];

function eq(actual, expected, label, tol) {
    tol = tol === undefined ? 1e-6 : tol;
    let ok;
    if (typeof actual === 'number' && typeof expected === 'number') ok = Math.abs(actual - expected) <= tol;
    else ok = String(actual) === String(expected);
    if (ok) { pass++; }
    else { fail++; failures.push(`${label}\n    期望 ${expected}，实际 ${actual}`); }
}

function truthy(v, label) { eq(!!v, true, label); }
function falsy(v, label) { eq(!!v, false, label); }

function section(name) { console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(0, 46 - name.length))); }

/* ============================================================
 * 1. 工具函数
 * ============================================================ */
section('工具函数');
eq(E.num('abc', 7), 7, 'num 非法值回落默认');
eq(E.num('', 7), 7, 'num 空串回落默认');
eq(E.num('3.5'), 3.5, 'num 解析字符串');
eq(E.num(0, 7), 0, 'num 保留真实的 0');
eq(E.pos(0, 5), 5, 'pos 非正数回落默认');
eq(E.round(1.005, 2), 1.01, 'round 边界进位');
eq(E.money(2.5), '2.50', 'money 两位小数');
eq(E.pct(0.1234), '12.3%', 'pct 百分比');
eq(E.escapeHtml('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;', 'escapeHtml 转义');
eq(E.escapeHtml(undefined), '', 'escapeHtml 空值不抛异常');

/* ============================================================
 * 2. 材料费
 * ============================================================ */
section('材料费');
{
    const b = E.material({ grossWeightKg: 0.25073, netWeightKg: 0.243432, unitPrice: 8.5, scrapPrice: 2.0, scrapCredit: true });
    eq(b.cost, 0.25073 * 8.5 - (0.25073 - 0.243432) * 2.0, '材料费 = 毛重×单价 − 废料回收', 1e-9);
    eq(b.detail.grossCost, 2.1312, '毛重成本（detail 保留 4 位小数）', 1e-4);
    eq(b.detail.utilization, 0.243432 / 0.25073, '材料利用率', 1e-4);
}
{
    const b = E.material({ grossWeightKg: 1, netWeightKg: 1, unitPrice: 10, scrapCredit: false });
    eq(b.cost, 10, '毛重=净重时无废料');
}
{
    // 输入错误：净重 > 毛重，不应产生负废料
    const b = E.material({ grossWeightKg: 1, netWeightKg: 2, unitPrice: 10, scrapPrice: 2 });
    eq(b.detail.scrapKg, 0, '净重>毛重时废料按 0 处理');
    eq(b.cost, 10, '净重>毛重时成本不倒挂');
}

/* ============================================================
 * 3. 加工费
 * ============================================================ */
section('加工费');
{
    // 注塑循环制：(180+35) / (3600/60 × 1) = 215/60
    const b = E.process({ ops: [{ name: '注塑', type: 'cycle', cycleSec: 60, cavity: 1, machineRate: 180, laborRate: 35 }] });
    eq(b.cost, 215 / 60, '循环制加工费', 1e-9);
}
{
    const b = E.process({ ops: [{ name: '注塑', type: 'cycle', cycleSec: 60, cavity: 2, machineRate: 180, laborRate: 35 }] });
    eq(b.cost, 215 / 120, '两穴时单件加工费减半', 1e-9);
}
{
    const b = E.process({ ops: [{ name: '冲孔', type: 'stroke', strokes: 3, ratePerStroke: 0.4 }] });
    eq(b.cost, 1.2, '冲次制加工费', 1e-9);
}
{
    const b = E.process({ ops: [{ name: '去毛刺', type: 'machine', hoursPerPart: 0.02, ratePerHour: 45, qtyMultiplier: 2 }] });
    eq(b.cost, 0.02 * 45 * 2, '工时制 + 数量倍率', 1e-9);
}

/* ============================================================
 * 4. 模具摊销
 * ============================================================ */
section('模具摊销');
eq(E.tooling({ totalToolPrice: 300000, supplierShare: 1, lifecycleQty: 100000 }).cost, 3, '供应商全付');
eq(E.tooling({ totalToolPrice: 300000, supplierShare: 0, lifecycleQty: 100000 }).cost, 0, '主机厂全付不分摊');
eq(E.tooling({ totalToolPrice: 300000, supplierShare: 0.5, lifecycleQty: 100000 }).cost, 1.5, '部分分摊 50%');
eq(E.tooling({ totalToolPrice: 300000, supplierShare: 1, lifecycleQty: 0 }).cost, 0, '产量为 0 时不产生 Infinity/NaN');
truthy(isFinite(E.tooling({ totalToolPrice: 300000, supplierShare: 1, lifecycleQty: 0 }).cost), '产量为 0 时结果有限');
eq(E.tooling({ totalToolPrice: 300000, supplierShare: 5, lifecycleQty: 100000 }).cost, 3, '分摊比 >1 被夹到 1');

/* ============================================================
 * 5. 表面处理 / 连接
 * ============================================================ */
section('表面处理 / 连接');
eq(E.surface({ areaDm2: 12, unitPrice: 1.25, factor: 1.2, yield: 1 }).cost, 18, '表面处理 = 面积×单价×系数');
eq(E.surface({ areaDm2: 12, unitPrice: 1.25, factor: 1.2, yield: 0.9 }).cost, 20, '良率 90% 时成本放大 1/0.9');
eq(E.joining({ items: [{ type: 'spot', count: 10 }] }).cost, 2.5, '点焊 10 点 × 0.25');
eq(E.joining({ items: [{ type: 'mig', lengthMm: 100 }] }).cost, 1.0, 'MIG 焊 100mm ÷ 10 × 0.10');
eq(E.joining({ items: [{ type: 'bolt', count: 4, rate: 0.5 }] }).cost, 2.0, '自定义单点费率覆盖默认');

/* ============================================================
 * 6. 物流
 * ============================================================ */
section('物流');
{
    // 航空货运标准：体积重(kg) = L(cm)×W(cm)×H(cm) ÷ 6000 = 80×60×40 ÷ 6000 = 32 kg
    const g = E.logisticsGeneral({ lengthMm: 800, widthMm: 600, heightMm: 400, partWeightKg: 5, volFactor: 6000, billingMode: 'max', freightRatePerKgKm: 0.0008, distanceKm: 500 });
    eq(g.volKg, 32, '体积重计算（cm³ ÷ 6000）');
    eq(g.billKg, 32, '取最大值时按体积重计费');
}
{
    // 直送：载重 3000kg，单件 2kg → 1500 件/车；年 10 万件 → 67 车；800 元/车
    const d = E.logisticsDirect({ partWeightKg: 2, truckCapacityKg: 3000, truckCost: 800, annualQty: 100000 });
    eq(d.partsPerTruck, 1500, '单车装载件数');
    eq(d.tripsPerYear, 67, '年车次向上取整');
    eq(d.cost, 67 * 800 / 100000, '单件直送运费', 1e-9);
}
{
    // 关键回归：单件重量极小导致 partsPerTruck 极大时，不应出现除零/Infinity
    const d = E.logisticsDirect({ partWeightKg: 0, truckCapacityKg: 3000, truckCost: 800, annualQty: 100000 });
    truthy(isFinite(d.cost), '单件重量为 0 时不产生 Infinity');
}
eq(E.logisticsMilkrun({ annualQty: 100000, supplierCount: 5, totalCostPerTrip: 2000, partsPerTrip: 1000 }).tripsPerYear, 100, 'Milk-run 年趟数');
eq(E.packaging({ packagingAmortize: 0.05, emptyReturnRate: 1, ediFeeMonthly: 0, annualQty: 100000 }).cost, 0.1, '包装 + 100% 空箱返回');
eq(E.packaging({ packagingAmortize: 0.5, emptyReturnRate: 0, ediFeeMonthly: 1200, annualQty: 100000 }).cost, 0.5 + 0.144, 'EDI 年费按件分摊');

/* ============================================================
 * 7. 期间费用
 * ============================================================ */
section('期间费用');
{
    const o = E.overhead({ directCost: 100, managementRate: 0.12, profitRate: 0.10, taxRate: 0.13, jitFactor: 1 });
    eq(o.detail.management, 12, '管理费 = 直接成本 × 12%');
    eq(o.detail.profit, 11.2, '利润 = (直接+管理) × 10%');
    eq(o.cost, 23.2, '期间费用合计');
}
{
    const o = E.overhead({ directCost: 100, managementRate: 0.12, profitRate: 0.10, taxRate: 0.13, jitFactor: 1.12 });
    eq(o.detail.jitUplift, (100 + 12 + 11.2) * 0.12, 'JIT 加成额', 1e-9);
}
{
    // 账期资金占用：供应商垫资成本
    const o = E.overhead({ directCost: 100, managementRate: 0, profitRate: 0, taxRate: 0, capitalRate: 0.06, paymentDays: 90 });
    eq(o.detail.capital, 100 * 0.06 * 90 / 365, '账期资金占用', 1e-4);
    truthy(o.cost > 0, '有账期时期间费用大于 0');
}
eq(E.overhead({ directCost: 100, capitalRate: 0, paymentDays: 0 }).detail.capital, 0, '未启用账期时资金占用为 0');

/* ============================================================
 * 8. 整表组装 + 回归：注塑件默认场景
 * ============================================================ */
section('整表组装（注塑默认场景回归）');
{
    // 复刻页面默认值：800×150×2.8mm 盒状件，PP+EPDM-T20，850T 注塑机，供应商全付模具
    const partWeightG = (800 * 150 * 2.8 / 1000) * 0.60 * 1.15 * 1.05; // 几何估算
    const grossG = partWeightG * 1.03;                                  // 含 3% 废品
    const sheet = E.buildSheet({
        material: { grossWeightKg: grossG / 1000, netWeightKg: partWeightG / 1000, unitPrice: 8.5, scrapPrice: 0, scrapCredit: false },
        process: { ops: [{ name: '注塑成型', type: 'cycle', cycleSec: 60, cavity: 1, machineRate: 180, laborRate: 35 }] },
        tooling: { totalToolPrice: 311370, supplierShare: 1, lifecycleQty: 100000 },
        logistics: Object.assign(E.logistics({ mode: 'direct', partWeightKg: partWeightG / 1000, truckCapacityKg: 3000, truckCost: 800, annualQty: 100000, packagingAmortize: 0.05, emptyReturnRate: 0 }), { __built: true }),
        overhead: { managementRate: 0.12, profitRate: 0.10, taxRate: 0.13, jitFactor: 1 }
    });

    const matCost = grossG / 1000 * 8.5;
    eq(sheet.blockMap.material.cost, matCost, '材料费', 1e-6);
    eq(sheet.blockMap.process.cost, 215 / 60, '加工费', 1e-9);
    eq(sheet.blockMap.tooling.cost, 3.1137, '模具分摊', 1e-6);

    const expectedDirect = matCost + 215 / 60 + 3.1137 + (9 * 800 / 100000) + 0.05;
    eq(sheet.directCost, expectedDirect, '直接成本合计', 1e-4);

    // 管理费 = 直接×12%；利润 = (直接+管理)×10%  →  系数 1.12 × 1.10 = 1.232
    const expectedTotal = expectedDirect * 1.232;
    eq(sheet.blockMap.overhead.detail.management, expectedDirect * 0.12, '管理费 = 直接成本 × 12%', 1e-4);
    eq(sheet.blockMap.overhead.detail.profit, expectedDirect * 1.12 * 0.10, '利润 = (直接+管理) × 10%', 1e-4);
    eq(sheet.totalCost, expectedTotal, '完全成本 = 直接 × 1.232', 1e-4);
    eq(sheet.quotePrice, expectedTotal * 1.13, '含税报价 = 完全成本 × 1.13', 1e-3);

    eq(sheet.blocks.length, 5, '成本块数量（材料/加工/模具/物流/期间费用；本例无表面处理与连接）');
    truthy(sheet.totalCost > 0, '完全成本为正');

    // 自洽性：期间费用块 = 管理费 + 利润 + 资金占用
    const oh = sheet.blockMap.overhead;
    eq(oh.cost, oh.detail.management + oh.detail.profit + oh.detail.capital, '期间费用块 = 管理费+利润+资金占用', 1e-4);

    // 自洽性：各成本块之和 = 直接成本（防止漏加/重复加）
    const directBlocks = sheet.blocks.filter(b => b.key !== 'overhead');
    const sumDirect = directBlocks.reduce((s, b) => s + b.cost, 0);
    eq(sumDirect, sheet.directCost, '各成本块之和 = 直接成本', 1e-4);
    truthy(Math.abs(sheet.totalCost - expectedTotal) < 1e-4, '总额自洽');
}

/* ============================================================
 * 9. 诊断信息（不能静默算错）
 * ============================================================ */
section('诊断信息');
{
    const s = E.buildSheet({
        material: { grossWeightKg: 0, netWeightKg: 0, unitPrice: 0 },
        tooling: { totalToolPrice: 100000, supplierShare: 1, lifecycleQty: 0 }
    });
    truthy(s.diagnostics.some(d => d.level === 'error'), '完全成本为 0 时报 error');
    truthy(s.diagnostics.some(d => d.message.includes('生命周期产量')), '产量为 0 时报模具未摊销');
}
{
    const s = E.buildSheet({ material: { grossWeightKg: 1, netWeightKg: 2, unitPrice: 5 } });
    truthy(s.diagnostics.some(d => d.message.includes('净重大于毛重')), '净重>毛重 给出告警');
}

/* ============================================================
 * 10. 敏感度分析
 * ============================================================ */
section('敏感度分析');
{
    const base = { '材料单价': 8.5, '成型周期': 60, '机时费率': 180 };
    const evaluate = (ov) => {
        const u = ov['材料单价'] || base['材料单价'];
        const c = ov['成型周期'] || base['成型周期'];
        const r = ov['机时费率'] || base['机时费率'];
        return 0.25 * u + r / (3600 / c);
    };
    const rows = E.sensitivity(evaluate, base, { delta: 0.1 });
    eq(rows.length, 3, '返回 3 个参数');
    truthy(rows[0].swing >= rows[1].swing && rows[1].swing >= rows[2].swing, '按影响幅度降序排列');
    truthy(rows[0].swingPct >= 0, '影响幅度为非负');

    // 本模型中成本 = 0.25×材料单价 + 机时费率×成型周期÷3600
    //   材料单价 ±10%  → 0.25×8.5×0.2 = 0.425
    //   成型周期 ±10%  → 180×60×0.2÷3600 = 0.6
    //   机时费率 ±10%  → 180×60×0.2÷3600 = 0.6
    // 所以最敏感的是「成型周期/机时费率」（并列 0.6），材料单价次之
    const matRow = rows.find(r => r.name === '材料单价');
    eq(matRow.swing, 0.425, '材料单价影响幅度 = 0.425', 1e-9);
    eq(rows[0].swing, 0.6, '最大影响幅度 = 0.6', 1e-9);
    truthy(['成型周期', '机时费率'].includes(rows[0].name), '最敏感参数为周期或机时费率（并列）');
}

/* ============================================================
 * 11. 输入校验
 * ============================================================ */
section('输入校验');
{
    const issues = E.validate(
        { length: { label: '长 L', min: 1 }, taxRate: { label: '税率', min: 0, max: 100 }, name: { label: '名称', required: true } },
        { length: 0, taxRate: 150, name: '' }
    );
    eq(issues.length, 3, '三处非法输入全部被捕获');
    truthy(issues.some(i => i.message.includes('长 L')), '捕获下界越界');
    truthy(issues.some(i => i.message.includes('税率')), '捕获上界越界');
    truthy(issues.some(i => i.message.includes('必填')), '捕获必填缺失');
}
truthy(E.validate({ length: { min: 1 } }, { length: 'abc' }).some(i => i.message.includes('有效数字')), '非数字输入被捕获');

/* ============================================================
 * 汇总
 * ============================================================ */
console.log('\n' + '═'.repeat(52));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
    console.log('\n失败详情：');
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
} else {
    console.log('✅ 全部通过');
}
