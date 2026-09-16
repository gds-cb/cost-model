/*!
 * cost-db.js —— 成本参数库 V1.0.0
 * ---------------------------------------------------------------
 * 这是护城河所在。参数库的价值 >> 公式的价值，所以它必须：
 *   1. 可维护（Schema 驱动，不是硬编码在算法里）
 *   2. 可版本化（每条记录带 updatedAt / source，整套带 schemaVersion）
 *   3. 可迁移（老用户的 localStorage 数据一条不丢）
 *   4. 可备份（一键导出/导入 JSON，换电脑不丢数据）
 *   5. 可扩展（新增品类只加数据，不改算法）
 *
 * 四张核心表 + 一张战略表：
 *   materials       材料 / 板材价格库
 *   surface         表面处理工艺库
 *   equipment       设备费率库
 *   cases           工艺判例库（相似件匹配）
 *   purchasedParts  外购件价格库  ← L3，未来的订阅制根基
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        // Node 分支：必须显式注入引擎（cost-db 用到 CostEngine.clone / round 等）
        module.exports = factory(require('./cost-engine.js'));
    } else {
        root.CostDB = factory(root.CostEngine || (typeof require === 'function' ? require('./cost-engine.js') : null));
    }
}(typeof self !== 'undefined' ? self : this, function (CostEngine) {
    'use strict';

    var SCHEMA_VERSION = '1.0.0';
    var PREFIX = 'costdb_v1_';

    /* =====================================================================
     * 1. Schema 定义 —— 字段元数据驱动，UI 可据此自动生成表单
     * ===================================================================== */

    var SCHEMAS = {
        materials: {
            label: '材料 / 板材价格库',
            icon: '📦',
            primary: 'code',
            fields: [
                { key: 'id', label: 'ID', type: 'string', required: true, hidden: true },
                { key: 'code', label: '牌号 / 代码', type: 'string', required: true, width: 150, placeholder: '如 PP+EPDM-T20 / DC01' },
                { key: 'kind', label: '类别', type: 'enum', options: ['polymer', 'sheet', 'other'], labels: { polymer: '塑料', sheet: '金属板材', other: '其他' }, default: 'polymer', width: 90 },
                { key: 'category', label: '材料类型', type: 'string', width: 90, placeholder: '热轧/冷轧/高强钢' },
                { key: 'spec', label: '规格', type: 'string', width: 110, placeholder: '1.5-6.0mm' },
                { key: 'density', label: '密度 g/cm³', type: 'number', required: true, min: 0.01, max: 25, step: 0.01, default: 1.05 },
                { key: 'unitPrice', label: '单价 元/kg', type: 'number', required: true, min: 0, step: 0.1, default: 0 },
                { key: 'thickness', label: '参考厚度 mm', type: 'number', min: 0, step: 0.1 },
                { key: 'updatedAt', label: '价格更新日期', type: 'date' },
                { key: 'source', label: '数据来源', type: 'string', width: 130, placeholder: '如 2026Q1 采购实价' },
                { key: 'note', label: '备注', type: 'string' }
            ]
        },

        surface: {
            label: '表面处理工艺库',
            icon: '🎨',
            primary: 'name',
            fields: [
                { key: 'id', label: 'ID', type: 'string', required: true, hidden: true },
                { key: 'name', label: '工艺名称', type: 'string', required: true, width: 140, placeholder: '如 钢琴漆' },
                { key: 'unitPrice', label: '单价 元/dm²', type: 'number', required: true, min: 0, step: 0.05 },
                { key: 'factor', label: '工艺系数', type: 'number', required: true, min: 0.01, step: 0.05, default: 1 },
                { key: 'yield', label: '一次合格率', type: 'number', min: 0.01, max: 1, step: 0.01, default: 1 },
                { key: 'updatedAt', label: '更新日期', type: 'date' },
                { key: 'source', label: '数据来源', type: 'string', width: 130 },
                { key: 'note', label: '备注', type: 'string' }
            ]
        },

        equipment: {
            label: '设备费率库',
            icon: '🖥️',
            primary: 'name',
            fields: [
                { key: 'id', label: 'ID', type: 'string', required: true, hidden: true },
                { key: 'name', label: '设备名称', type: 'string', width: 130, placeholder: '如 注塑机 1300T' },
                { key: 'kind', label: '工艺类别', type: 'enum', options: ['injection', 'stamping', 'machining', 'diecasting', 'other'], labels: { injection: '注塑', stamping: '冲压', machining: '机加工', diecasting: '压铸', other: '其他' }, default: 'injection', width: 90 },
                { key: 'tonnage', label: '吨位 T', type: 'number', min: 0, step: 10 },
                { key: 'maxForce', label: '有效锁模力 T', type: 'number', min: 0, step: 10 },
                { key: 'hourlyRate', label: '小时费率 元/h', type: 'number', required: true, min: 0, step: 5 },
                { key: 'laborRate', label: '人工费率 元/h', type: 'number', min: 0, step: 1 },
                { key: 'spm', label: 'SPM 冲次/分', type: 'number', min: 0, step: 1 },
                { key: 'updatedAt', label: '更新日期', type: 'date' },
                { key: 'source', label: '数据来源', type: 'string', width: 130 },
                { key: 'note', label: '备注', type: 'string' }
            ]
        },

        cases: {
            label: '工艺判例库',
            icon: '📚',
            primary: 'name',
            fields: [
                { key: 'id', label: 'ID', type: 'string', required: true, hidden: true },
                { key: 'name', label: '零件名称', type: 'string', required: true, width: 150 },
                { key: 'category', label: '零件类别', type: 'string', width: 110, placeholder: '车身件/底盘/内饰' },
                { key: 'material', label: '材料牌号', type: 'string', width: 110 },
                { key: 'thickness', label: '厚度 mm', type: 'number', min: 0, step: 0.1 },
                { key: 'length', label: '长 mm', type: 'number', min: 0, step: 10 },
                { key: 'width', label: '宽 mm', type: 'number', min: 0, step: 10 },
                { key: 'processes', label: '工序配置', type: 'json' },
                { key: 'updatedAt', label: '更新日期', type: 'date' },
                { key: 'source', label: '数据来源', type: 'string', width: 130 },
                { key: 'note', label: '备注', type: 'string' }
            ]
        },

        /* L3 战略表：外购件价格库 —— 不需要算法，只需要数据和更新 */
        purchasedParts: {
            label: '外购件价格库',
            icon: '💱',
            primary: 'name',
            fields: [
                { key: 'id', label: 'ID', type: 'string', required: true, hidden: true },
                { key: 'name', label: '零件名称', type: 'string', required: true, width: 160, placeholder: '如 六角法兰螺栓 M8×25' },
                { key: 'category', label: '类别', type: 'string', width: 110, placeholder: '紧固件/轴承/传感器' },
                { key: 'spec', label: '规格型号', type: 'string', width: 140 },
                { key: 'unitPrice', label: '单价 元/件', type: 'number', required: true, min: 0, step: 0.01 },
                { key: 'currency', label: '币种', type: 'enum', options: ['CNY', 'USD', 'EUR'], default: 'CNY', width: 70 },
                { key: 'moq', label: 'MOQ', type: 'number', min: 0, step: 100 },
                { key: 'supplier', label: '供应商', type: 'string', width: 130 },
                { key: 'region', label: '产地', type: 'string', width: 90 },
                { key: 'validFrom', label: '价格有效期起', type: 'date' },
                { key: 'updatedAt', label: '更新日期', type: 'date' },
                { key: 'source', label: '数据来源', type: 'string', width: 130 },
                { key: 'note', label: '备注', type: 'string' }
            ]
        }
    };

    /* =====================================================================
     * 2. 默认数据（不叫"默认"叫"起步数据"，鼓励用户尽快替换成自己的实价）
     * ===================================================================== */

    function today() { return new Date().toISOString().slice(0, 10); }

    var DEFAULTS = {
        materials: [
            { id: 'm1', code: 'PP+EPDM-T20', kind: 'polymer', density: 1.05, unitPrice: 8.5, source: '起步值，请替换为实价' },
            { id: 'm2', code: 'ABS 757', kind: 'polymer', density: 1.05, unitPrice: 11.5, source: '起步值，请替换为实价' },
            { id: 'm3', code: 'PC/ABS', kind: 'polymer', density: 1.14, unitPrice: 18.0, source: '起步值，请替换为实价' },
            { id: 'm4', code: 'PA66+GF30', kind: 'polymer', density: 1.36, unitPrice: 22.0, source: '起步值，请替换为实价' },
            // 金属板材：id 沿用旧版（q235/dc01/…），确保既有 BOM 的 materialId 不会失配
            { id: 'q235', code: 'Q235A', kind: 'sheet', category: '热轧', spec: '1.5-6.0mm', density: 7.85, unitPrice: 3.5, thickness: 3.0, source: '起步值，请替换为实价' },
            { id: 'dc01', code: 'DC01', kind: 'sheet', category: '冷轧', spec: '0.5-3.0mm', density: 7.85, unitPrice: 5.8, thickness: 1.0, source: '起步值，请替换为实价' },
            { id: 'hc340', code: 'HC340/590DP', kind: 'sheet', category: '高强钢', spec: '0.8-2.5mm', density: 7.85, unitPrice: 7.5, thickness: 1.2, source: '起步值，请替换为实价' },
            { id: 'spcc', code: 'SPCC', kind: 'sheet', category: '冷轧', spec: '0.5-2.0mm', density: 7.85, unitPrice: 5.6, thickness: 1.0, source: '起步值，请替换为实价' },
            { id: 'saph440', code: 'SAPH440', kind: 'sheet', category: '热轧', spec: '2.0-6.0mm', density: 7.85, unitPrice: 5.2, thickness: 3.2, source: '起步值，请替换为实价' },
            { id: '510l', code: '510L', kind: 'sheet', category: '热轧', spec: '2.0-8.0mm', density: 7.85, unitPrice: 5.0, thickness: 4.0, source: '起步值，请替换为实价' },
            { id: 'qste500', code: 'QSTE500TM', kind: 'sheet', category: '高强钢', spec: '1.5-20mm', density: 7.85, unitPrice: 6.2, thickness: 3.0, source: '起步值，请替换为实价' },
            { id: 'dc03', code: 'DC03', kind: 'sheet', category: '冷轧', spec: '0.5-2.5mm', density: 7.85, unitPrice: 6.5, thickness: 0.8, source: '起步值，请替换为实价' },
            { id: 'adc12', code: 'ADC12', kind: 'other', category: '压铸铝合金', density: 2.7, unitPrice: 19.5, source: '起步值，请替换为实价' }
        ],
        surface: [
            { id: 's1', name: '钢琴漆', unitPrice: 1.25, factor: 1.2, yield: 0.95 },
            { id: 's2', name: '普通喷漆', unitPrice: 0.35, factor: 1.0, yield: 0.97 },
            { id: 's3', name: '皮纹', unitPrice: 0.80, factor: 1.1, yield: 0.98 },
            { id: 's4', name: '高光', unitPrice: 1.50, factor: 1.0, yield: 0.92 },
            { id: 's5', name: '电镀', unitPrice: 2.20, factor: 1.3, yield: 0.90 },
            { id: 's6', name: 'IMD/IML', unitPrice: 3.50, factor: 1.0, yield: 0.93 }
        ],
        equipment: [
            // —— 注塑机（吨位 / 有效锁模力 / 机时费率 / 人工费率）——
            { id: 'e1', name: '注塑机 850T', kind: 'injection', tonnage: 850, maxForce: 723, hourlyRate: 180, laborRate: 35 },
            { id: 'e2', name: '注塑机 1300T', kind: 'injection', tonnage: 1300, maxForce: 1105, hourlyRate: 250, laborRate: 35 },
            { id: 'e3', name: '注塑机 2000T', kind: 'injection', tonnage: 2000, maxForce: 1800, hourlyRate: 350, laborRate: 35 },
            { id: 'e4', name: '注塑机 2800T', kind: 'injection', tonnage: 2800, maxForce: 2600, hourlyRate: 450, laborRate: 35 },
            // —— 冲压线（吨位 / 机时费率 / 每分钟冲次）——
            // 注意：沿用旧版费率表，确保既有 BOM 与案例库中引用的吨位都能匹配到
            { id: 'eq25', name: '冲压线 25T', kind: 'stamping', tonnage: 25, hourlyRate: 45, spm: 90 },
            { id: 'eq45', name: '冲压线 45T', kind: 'stamping', tonnage: 45, hourlyRate: 50, spm: 80 },
            { id: 'eq80', name: '冲压线 80T', kind: 'stamping', tonnage: 80, hourlyRate: 55, spm: 70 },
            { id: 'eq110', name: '冲压线 110T', kind: 'stamping', tonnage: 110, hourlyRate: 60, spm: 65 },
            { id: 'eq160', name: '冲压线 160T', kind: 'stamping', tonnage: 160, hourlyRate: 70, spm: 60 },
            { id: 'eq200', name: '冲压线 200T', kind: 'stamping', tonnage: 200, hourlyRate: 80, spm: 55 },
            { id: 'eq250', name: '冲压线 250T', kind: 'stamping', tonnage: 250, hourlyRate: 90, spm: 52 },
            { id: 'eq315', name: '冲压线 315T', kind: 'stamping', tonnage: 315, hourlyRate: 100, spm: 50 },
            { id: 'eq400', name: '冲压线 400T', kind: 'stamping', tonnage: 400, hourlyRate: 120, spm: 45 },
            { id: 'eq500', name: '冲压线 500T', kind: 'stamping', tonnage: 500, hourlyRate: 135, spm: 43 },
            { id: 'eq630', name: '冲压线 630T', kind: 'stamping', tonnage: 630, hourlyRate: 150, spm: 40 },
            { id: 'eq800', name: '冲压线 800T', kind: 'stamping', tonnage: 800, hourlyRate: 180, spm: 36 },
            { id: 'eq1000', name: '冲压线 1000T', kind: 'stamping', tonnage: 1000, hourlyRate: 200, spm: 33 }
        ],
        cases: [
            { id: 'c1', name: '前门内板', category: '车身件', material: 'DC01', thickness: 1.0, length: 1200, width: 800, processes: [{ name: '落料', tonnage: 400, dieWeight: 1500, strokes: 1 }, { name: '冲孔', tonnage: 250, dieWeight: 800, strokes: 2 }, { name: '拉伸', tonnage: 630, dieWeight: 2000, strokes: 1 }, { name: '切边', tonnage: 400, dieWeight: 1200, strokes: 1 }] },
            { id: 'c2', name: '后纵梁', category: '商用车底盘', material: 'Q235A', thickness: 2.5, length: 1500, width: 200, processes: [{ name: '落料', tonnage: 630, dieWeight: 1800, strokes: 1 }, { name: '拉伸', tonnage: 1000, dieWeight: 3500, strokes: 1 }, { name: '冲孔', tonnage: 400, dieWeight: 1000, strokes: 2 }] },
            { id: 'c3', name: '发动机盖外板', category: '车身件', material: 'DC03', thickness: 0.8, length: 1400, width: 1000, processes: [{ name: '落料', tonnage: 500, dieWeight: 2000, strokes: 1 }, { name: '拉伸', tonnage: 800, dieWeight: 2800, strokes: 1 }, { name: '切边', tonnage: 500, dieWeight: 1600, strokes: 1 }, { name: '翻边', tonnage: 400, dieWeight: 1300, strokes: 1 }] },
            { id: 'c4', name: '车架横梁', category: '商用车底盘', material: '510L', thickness: 3.0, length: 1800, width: 300, processes: [{ name: '落料', tonnage: 800, dieWeight: 2200, strokes: 1 }, { name: '冲孔', tonnage: 630, dieWeight: 1400, strokes: 4 }, { name: '弯曲', tonnage: 630, dieWeight: 1800, strokes: 1 }] },
            { id: 'c5', name: 'A柱内板', category: '车身件', material: 'HC340/590DP', thickness: 1.2, length: 1100, width: 450, processes: [{ name: '落料', tonnage: 400, dieWeight: 1600, strokes: 1 }, { name: '拉伸', tonnage: 630, dieWeight: 2100, strokes: 1 }, { name: '切边', tonnage: 400, dieWeight: 1100, strokes: 1 }] },
            { id: 'c6', name: '车架纵梁', category: '商用车底盘', material: '510L', thickness: 3.0, length: 2000, width: 250, processes: [{ name: '落料', tonnage: 800, dieWeight: 2500, strokes: 1 }, { name: '冲孔', tonnage: 630, dieWeight: 1800, strokes: 6 }, { name: '弯曲', tonnage: 1000, dieWeight: 3000, strokes: 2 }, { name: '整形', tonnage: 800, dieWeight: 2000, strokes: 1 }] },
            { id: 'c7', name: '发动机横梁', category: '商用车底盘', material: 'QSTE500TM', thickness: 2.5, length: 1600, width: 200, processes: [{ name: '落料', tonnage: 630, dieWeight: 2000, strokes: 1 }, { name: '拉伸', tonnage: 800, dieWeight: 2800, strokes: 1 }, { name: '冲孔', tonnage: 400, dieWeight: 1200, strokes: 4 }, { name: '切边', tonnage: 400, dieWeight: 1400, strokes: 1 }] },
            { id: 'c8', name: '支架', category: '小冲压件', material: 'DC01', thickness: 1.2, length: 150, width: 80, processes: [{ name: '落料', tonnage: 160, dieWeight: 500, strokes: 1 }, { name: '冲孔', tonnage: 110, dieWeight: 300, strokes: 2 }, { name: '弯曲', tonnage: 110, dieWeight: 400, strokes: 1 }] },
            { id: 'c9', name: '加强板', category: '小冲压件', material: 'Q235A', thickness: 2.0, length: 300, width: 120, processes: [{ name: '落料', tonnage: 250, dieWeight: 800, strokes: 1 }, { name: '冲孔', tonnage: 160, dieWeight: 500, strokes: 3 }] },
            { id: 'c10', name: '空调冷凝器支架', category: '商用车小件', material: 'DC01', thickness: 1.5, length: 200, width: 80, processes: [{ name: '落料', tonnage: 160, dieWeight: 400, strokes: 1 }, { name: '冲孔', tonnage: 110, dieWeight: 300, strokes: 2 }, { name: '弯曲', tonnage: 110, dieWeight: 350, strokes: 1 }] },
            { id: 'c11', name: '电瓶框横梁', category: '商用车底盘', material: 'Q235A', thickness: 2.0, length: 800, width: 150, processes: [{ name: '落料', tonnage: 315, dieWeight: 1200, strokes: 1 }, { name: '冲孔', tonnage: 250, dieWeight: 800, strokes: 4 }, { name: '弯曲', tonnage: 250, dieWeight: 900, strokes: 2 }] },
            { id: 'c12', name: '油箱托架', category: '商用车底盘', material: '510L', thickness: 2.5, length: 600, width: 180, processes: [{ name: '落料', tonnage: 400, dieWeight: 1500, strokes: 1 }, { name: '冲孔', tonnage: 315, dieWeight: 1000, strokes: 3 }, { name: '弯曲', tonnage: 315, dieWeight: 1200, strokes: 2 }] }
        ],
        purchasedParts: []
    };

    /* =====================================================================
     * 3. 设置项（费率类参数，全部可配置，不再硬编码）
     * ===================================================================== */

    var SETTINGS_DEFAULTS = {
        injection: {
            preset: 'east_std',
            laborRate: 35,              // 人工费率 元/h（由费率预设决定）
            equipmentRateFactor: 1.0,   // 设备费率系数（乘在设备库费率上）
            moldPriceFactor: 1.0,       // 模具价格系数
            managementRate: 0.12,
            profitRate: 0.10,
            taxRate: 0.13,
            scrapPrice: 0.0,
            scrapCredit: false,
            hotRunnerPricePerPoint: 2800,
            cavityPricePerCm2: 100,
            slidePrice: 4000,
            lifterPrice: 3500,
            moldBasePricePerCm2: 60,
            designTrialRate: 0.07,
            moldLifeBaseRef: 100000,
            moldLifeExponent: 0.7
        },
        stamping: {
            preset: 'east_std',
            laborRate: 35,
            equipmentRateFactor: 1.0,
            moldPriceFactor: 1.0,
            blankUtilization: 75,       // 下料利用率 %
            managementRate: 0.12,
            profitRate: 0.10,
            taxRate: 0.13,
            diePricePerKg: 25,
            ratePerTonKm: 0.5,
            minFreight: 300,
            handlingFee: 0.5,
            scrapPrice: 2.0,
            scrapAccountingMethod: 'deduct'
        }
    };

    /* ---------------------------------------------------------------------
     * 费率预设：地区 × 自动化水平
     *
     * 为什么需要它：默认值只能有一套，但「不会调」的人（研发人员、小供应商老板）
     * 拿到一套陌生数字是不敢用的。给他几个能对号入座的档位，比给他一堆输入框有用。
     *
     * 设计约束（重要）：
     *   1. 预设只改「制造成本驱动因子」，绝不覆盖客户的参数库（材料 / 设备 / 判例）
     *   2. 设备费率用「系数」而不是绝对值 —— 既体现地区差异，又不破坏客户维护的设备表
     *   3. **预设不改管理费率与利润率**。那两个是商务决策（这家公司想赚多少），
     *      不是地区属性。混进来会让「高自动化档」总成本反而更低，自相矛盾。
     *   4. 因此各档位的完全成本必须单调：内陆 < 华北 < 华东通用 < 华南 < 华东高自动化
     * ------------------------------------------------------------------- */
    var PRESETS = {
        east_high: {
            name: '华东 · 高自动化',
            desc: '大型 Tier1 / 外资配套。进口设备为主、自动化程度高 → 设备与模具费率高，材料利用率也高。',
            laborRate: 38, equipmentRateFactor: 1.20, moldPriceFactor: 1.15, blankUtilization: 78
        },
        east_std: {
            name: '华东 · 通用（基准）',
            desc: '主流 Tier1 配套，国产设备为主。这是工具的基准档，其他档位都以它为参照。',
            laborRate: 35, equipmentRateFactor: 1.00, moldPriceFactor: 1.00, blankUtilization: 75
        },
        south_std: {
            name: '华南 · 通用',
            desc: '珠三角配套。人工略高、模具供应充足但价格略高，物流半径短。',
            laborRate: 38, equipmentRateFactor: 1.00, moldPriceFactor: 1.05, blankUtilization: 75
        },
        north_std: {
            name: '华北 · 通用',
            desc: '环渤海配套。人工与设备成本略低于华东，模具供应相对少。',
            laborRate: 32, equipmentRateFactor: 0.95, moldPriceFactor: 0.95, blankUtilization: 73
        },
        inland_low: {
            name: '内陆 · 低成本',
            desc: '内陆产能转移区。人工低、设备偏旧、模具便宜，但材料利用率也偏低。',
            laborRate: 26, equipmentRateFactor: 0.80, moldPriceFactor: 0.80, blankUtilization: 70
        }
    };

    var PRESET_ORDER = ['east_high', 'east_std', 'south_std', 'north_std', 'inland_low'];

    /* =====================================================================
     * 4. 存储读写
     * ===================================================================== */

    function hasStorage() {
        try { return typeof localStorage !== 'undefined' && localStorage !== null; } catch (e) { return false; }
    }

    function readKey(key, fallback) {
        if (!hasStorage()) return fallback ? CostEngine.clone(fallback) : fallback;
        try {
            var raw = localStorage.getItem(PREFIX + key);
            if (raw === null) return fallback ? CostEngine.clone(fallback) : fallback;
            return JSON.parse(raw);
        } catch (e) {
            console.warn('[CostDB] 读取失败 ' + key, e);
            return fallback ? CostEngine.clone(fallback) : fallback;
        }
    }

    function writeKey(key, value) {
        if (!hasStorage()) return false;
        try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); return true; }
        catch (e) { console.error('[CostDB] 写入失败 ' + key, e); return false; }
    }

    function genId(prefix) {
        return (prefix || 'r') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    /* =====================================================================
     * 5. 校验
     * ===================================================================== */

    function validateRecord(schemaName, record) {
        var schema = SCHEMAS[schemaName];
        if (!schema) return [{ field: '_', level: 'error', message: '未知的数据表：' + schemaName }];
        var issues = [];
        schema.fields.forEach(function (f) {
            var v = record ? record[f.key] : undefined;
            var missing = v === undefined || v === null || v === '';
            if (f.required && missing && !f.hidden) {
                issues.push({ field: f.key, level: 'error', message: f.label + ' 必填' });
                return;
            }
            if (missing || f.type !== 'number') return;
            var n = parseFloat(v);
            if (!isFinite(n)) { issues.push({ field: f.key, level: 'error', message: f.label + ' 不是有效数字' }); return; }
            if (f.min !== undefined && n < f.min) issues.push({ field: f.key, level: 'error', message: f.label + ' 不能小于 ' + f.min });
            if (f.max !== undefined && n > f.max) issues.push({ field: f.key, level: 'error', message: f.label + ' 不能大于 ' + f.max });
        });
        return issues;
    }

    function normalizeRecord(schemaName, record) {
        var schema = SCHEMAS[schemaName];
        var out = {};
        schema.fields.forEach(function (f) {
            var v = record ? record[f.key] : undefined;
            if (f.type === 'number') {
                if (v === '' || v === undefined || v === null) { out[f.key] = f.default !== undefined ? f.default : undefined; return; }
                var n = parseFloat(v);
                out[f.key] = isFinite(n) ? n : (f.default !== undefined ? f.default : undefined);
            } else if (f.type === 'enum') {
                out[f.key] = (v === undefined || v === null || v === '') ? (f.default || '') : v;
            } else {
                out[f.key] = v === undefined || v === null ? (f.default !== undefined ? f.default : '') : v;
            }
        });
        if (!out.id) out.id = genId(schemaName.slice(0, 2));
        out.updatedAt = out.updatedAt || today();
        return out;
    }

    /* =====================================================================
     * 6. 表 API
     * ===================================================================== */

    function createTable(schemaName) {
        var schema = SCHEMAS[schemaName];

        function all() {
            var rows = readKey(schemaName, null);
            if (rows === null) {
                rows = CostEngine.clone(DEFAULTS[schemaName] || []);
                writeKey(schemaName, rows);
            }
            return rows;
        }

        return {
            schemaName: schemaName,
            schema: schema,
            all: all,
            /** 按某个字段取唯一值列表（用于下拉框） */
            options: function (field) {
                var seen = {}, out = [];
                all().forEach(function (r) {
                    var v = r[field];
                    if (v !== undefined && v !== '' && !seen[v]) { seen[v] = true; out.push(v); }
                });
                return out;
            },
            find: function (predicate) { return all().filter(predicate); },
            get: function (id) { return all().filter(function (r) { return r.id === id; })[0] || null; },
            byPrimary: function (value) {
                var p = schema.primary;
                return all().filter(function (r) { return r[p] === value; })[0] || null;
            },
            upsert: function (record) {
                var rows = all();
                var rec = normalizeRecord(schemaName, record);
                var issues = validateRecord(schemaName, rec).filter(function (i) { return i.level === 'error'; });
                if (issues.length) return { ok: false, issues: issues };

                // 主键去重：同牌号覆盖而不是新增，避免下拉框出现重复项
                var p = schema.primary;
                var idx = -1;
                if (rec.id) idx = rows.findIndex(function (r) { return r.id === rec.id; });
                if (idx === -1 && rec[p]) idx = rows.findIndex(function (r) { return r[p] === rec[p]; });

                if (idx >= 0) rows[idx] = Object.assign({}, rows[idx], rec);
                else rows.push(rec);
                writeKey(schemaName, rows);
                return { ok: true, record: rec, replaced: idx >= 0 };
            },
            remove: function (id) {
                var rows = all().filter(function (r) { return r.id !== id; });
                writeKey(schemaName, rows);
                return rows;
            },
            replaceAll: function (rows) {
                var clean = (rows || []).map(function (r) { return normalizeRecord(schemaName, r); });
                writeKey(schemaName, clean);
                return clean;
            },
            reset: function () {
                writeKey(schemaName, CostEngine.clone(DEFAULTS[schemaName] || []));
                return all();
            },
            importRows: function (rows, mode) {
                mode = mode || 'merge';
                if (mode === 'replace') return this.replaceAll(rows);
                var current = all();
                var report = { added: 0, updated: 0, skipped: 0 };
                (rows || []).forEach(function (r) {
                    var rec = normalizeRecord(schemaName, r);
                    var issues = validateRecord(schemaName, rec).filter(function (i) { return i.level === 'error'; });
                    if (issues.length) { report.skipped++; return; }
                    var p = schema.primary;
                    var idx = current.findIndex(function (c) { return c.id === rec.id || (rec[p] && c[p] === rec[p]); });
                    if (idx >= 0) { current[idx] = Object.assign({}, current[idx], rec); report.updated++; }
                    else { current.push(rec); report.added++; }
                });
                writeKey(schemaName, current);
                return report;
            }
        };
    }

    /* =====================================================================
     * 7. 设置 API
     * ===================================================================== */

    function settings(scope) {
        var defaults = SETTINGS_DEFAULTS[scope] || {};
        return {
            get: function () {
                return Object.assign({}, defaults, readKey('settings_' + scope, {}));
            },
            set: function (patch) {
                var next = Object.assign({}, this.get(), patch || {});
                writeKey('settings_' + scope, next);
                return next;
            },
            reset: function () {
                writeKey('settings_' + scope, {});
                return Object.assign({}, defaults);
            }
        };
    }

    /**
     * 套用费率预设。只改制造成本驱动因子，不动参数库，
     * 也不动管理费率/利润率（那是商务决策，不是地区属性）。
     * @param {string} scope 'injection' | 'stamping'
     * @param {string} presetId PRESET_ORDER 中的 id
     * @returns {Object|null} 新的 settings；预设不存在时返回 null
     */
    function applyPreset(scope, presetId) {
        var p = PRESETS[presetId];
        if (!p) return null;
        return settings(scope).set({
            preset: presetId,
            laborRate: p.laborRate,
            equipmentRateFactor: p.equipmentRateFactor,
            moldPriceFactor: p.moldPriceFactor,
            blankUtilization: p.blankUtilization
        });
    }

    function getPreset(scope) {
        var id = settings(scope).get().preset;
        return { id: id, preset: PRESETS[id] || PRESETS.east_std };
    }

    /* =====================================================================
     * 7b. 材料价格批量导入
     *
     * 设计前提：原材料价格是公开商品（我的钢铁、上海有色网都能查），
     * 所以「保持价格新鲜」这件事不该由工具作者承担，而应该让客户 3 分钟自己搞定。
     * 这个功能就是那 3 分钟。
     * ===================================================================== */

    /** 全角转半角 + 去空格 + 转大写，用于牌号匹配 */
    function normalizeCode(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/[\uFF01-\uFF5E]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
            .replace(/[\u3000\s]+/g, '')
            .toUpperCase();
    }

    var HEADER_HINT = /牌号|材料|代码|品名|名称|单价|价格|price|code|material|name/i;

    /**
     * 解析价格文本。支持逗号（中英文）/ 制表符 / 分号 / 竖线 / 两个以上空格分隔。
     * 表头行自动跳过；`#`、`//`、`;` 开头视为注释；空行忽略。
     * @returns {{rows:Array, errors:Array, skippedHeaders:number}}
     */
    function parsePriceList(text) {
        var rows = [], errors = [], skippedHeaders = 0;
        String(text === null || text === undefined ? '' : text).split(/\r?\n/).forEach(function (raw, idx) {
            var line = raw.trim();
            var lineNo = idx + 1;
            if (!line) return;
            if (/^(#|\/\/|;)/.test(line)) return;

            var parts = line.split(/[,，;；\t|]+|\s{2,}/)
                .map(function (s) { return s.trim(); })
                .filter(function (s) { return s !== ''; });
            if (parts.length < 2) parts = line.split(/\s+/);

            if (parts.length < 2) {
                errors.push({ line: lineNo, text: raw, reason: '只找到 1 列，缺少单价' });
                return;
            }

            var code = parts[0];
            var priceRaw = parts[1];

            // 表头行：「牌号,单价(元/kg)」这类
            if (HEADER_HINT.test(code) && isNaN(parseFloat(String(priceRaw).replace(/[^\d.\-]/g, '')))) {
                skippedHeaders++;
                return;
            }

            var price = parseFloat(String(priceRaw).replace(/[^\d.\-]/g, ''));
            if (!code) { errors.push({ line: lineNo, text: raw, reason: '缺少牌号' }); return; }
            if (!isFinite(price)) { errors.push({ line: lineNo, text: raw, reason: '单价不是有效数字：' + priceRaw }); return; }
            if (price < 0) { errors.push({ line: lineNo, text: raw, reason: '单价为负' }); return; }

            rows.push({ line: lineNo, code: code, price: price, source: parts[2] || '' });
        });
        return { rows: rows, errors: errors, skippedHeaders: skippedHeaders };
    }

    /**
     * 把价格文本与参数库比对；apply=true 时真正写入。
     * @param {string} text
     * @param {Object} opts
     *   table        默认 'materials'
     *   codeField    默认取 schema.primary
     *   priceField   默认 'unitPrice'
     *   source       全局数据来源（行内第三列会覆盖它）
     *   apply        true 才写入
     *   addUnmatched true 时把未匹配的牌号作为新记录添加
     *   newKind      新增记录的 kind（默认 'other'）
     *   newDensity   新增记录的密度（默认 7.85）
     */
    function importPriceList(text, opts) {
        opts = opts || {};
        var schemaName = opts.table || 'materials';
        var schema = SCHEMAS[schemaName];
        if (!schema) return { ok: false, error: '未知的数据表：' + schemaName };

        var table = createTable(schemaName);
        var codeField = opts.codeField || schema.primary;
        var priceField = opts.priceField || 'unitPrice';
        var parsed = parsePriceList(text);

        var snapshot = table.all();
        var index = {};
        snapshot.forEach(function (r) { index[normalizeCode(r[codeField])] = r; });

        var matched = [], unmatched = [], added = [], stamp = today();

        parsed.rows.forEach(function (row) {
            var rec = index[normalizeCode(row.code)];
            if (rec) {
                matched.push({
                    inputCode: row.code,
                    code: rec[codeField],
                    oldPrice: num(rec[priceField]),
                    newPrice: row.price,
                    delta: num(row.price) - num(rec[priceField]),
                    source: row.source || opts.source || ''
                });
            } else {
                unmatched.push({ code: row.code, price: row.price, source: row.source || opts.source || '' });
            }
        });

        if (opts.apply) {
            matched.forEach(function (m) {
                var rec = index[normalizeCode(m.inputCode)];
                if (!rec) return;
                var next = Object.assign({}, rec);   // 必须整条回写，避免部分字段被清空
                next[priceField] = m.newPrice;
                next.updatedAt = stamp;
                if (m.source) next.source = m.source;
                table.upsert(next);
            });
            if (opts.addUnmatched) {
                unmatched.forEach(function (u) {
                    var rec = {};
                    rec[codeField] = u.code;
                    rec[priceField] = u.price;
                    rec.kind = opts.newKind || 'other';
                    rec.density = opts.newDensity || 7.85;
                    rec.updatedAt = stamp;
                    rec.source = u.source || '批量导入新增';
                    var res = table.upsert(rec);
                    if (res.ok) added.push(u.code);
                });
            }
        }

        return {
            ok: true,
            parsed: parsed,
            matched: matched,
            unmatched: unmatched,
            added: added,
            changed: matched.filter(function (m) { return m.delta !== 0; }).length
        };
    }

    /** 生成价格表 CSV 模板（含当前所有牌号，客户改完直接粘回来） */
    function buildPriceTemplate(schemaName, opts) {
        opts = opts || {};
        schemaName = schemaName || 'materials';
        var schema = SCHEMAS[schemaName];
        var table = createTable(schemaName);
        var codeField = opts.codeField || schema.primary;
        var priceField = opts.priceField || 'unitPrice';

        var rows = [[opts.codeLabel || '牌号', opts.priceLabel || '单价', '数据来源', '更新日期']];
        table.all().forEach(function (r) {
            rows.push([r[codeField], r[priceField], r.source || '', r.updatedAt || '']);
        });
        return rows.map(function (row) {
            return row.map(function (c) {
                var s = c === null || c === undefined ? '' : String(c);
                return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
            }).join(',');
        }).join('\r\n');
    }

    function num(v, dflt) {
        var n = parseFloat(v);
        return isFinite(n) ? n : (dflt === undefined ? 0 : dflt);
    }

    /* =====================================================================
     * 8. 旧数据迁移 —— 老用户一条不丢
     * ===================================================================== */

    var LEGACY_MAP = {
        injection_materials: { table: 'materials', kind: 'polymer', map: function (r) { return { id: r.id, code: r.MaterialCode, kind: 'polymer', density: r.Density, unitPrice: r.UnitPrice, source: '从旧版迁移' }; } },
        stamping_materials: { table: 'materials', map: function (r) { return { id: r.id, code: r.MaterialCode, kind: 'sheet', category: r.Type, spec: r.Spec, thickness: r.Thickness, density: r.Density, unitPrice: r.UnitPrice, source: '从旧版迁移' }; } },
        injection_surface: { table: 'surface', map: function (r) { return { id: r.id, name: r.ProcessName, unitPrice: r.UnitPrice, factor: r.ThicknessFactor, yield: 1, source: '从旧版迁移' }; } },
        stamping_equipment: { table: 'equipment', map: function (r) { return { id: r.id, name: '冲压线 ' + r.tonnage + 'T', kind: 'stamping', tonnage: r.tonnage, hourlyRate: r.hourlyRate, spm: r.spm, source: '从旧版迁移' }; } },
        stamping_caseLibrary: { table: 'cases', map: function (r) { return Object.assign({ source: '从旧版迁移' }, r); } }
    };

    var MIGRATION_FLAG = 'migrated_v1';

    /**
     * 把旧版 localStorage 数据迁移到新的参数库。
     * 幂等：只在参数库为空 / 未迁移过时执行，且不覆盖已有数据。
     */
    function migrateLegacy() {
        if (!hasStorage()) return { migrated: false, detail: [] };
        if (readKey(MIGRATION_FLAG, false) === true) return { migrated: false, detail: [], reason: '已迁移过' };

        var detail = [];
        Object.keys(LEGACY_MAP).forEach(function (legacyKey) {
            var raw;
            try { raw = localStorage.getItem(legacyKey); } catch (e) { return; }
            if (!raw) return;
            var rows;
            try { rows = JSON.parse(raw); } catch (e) { return; }
            if (!Array.isArray(rows) || !rows.length) return;

            var cfg = LEGACY_MAP[legacyKey];
            var mapped = rows.map(cfg.map);
            var report = createTable(cfg.table).importRows(mapped, 'merge');
            detail.push({ from: legacyKey, to: cfg.table, added: report.added, updated: report.updated });
        });

        // 旧版设置项
        var injSettings = {};
        var legacyScrap = null;
        try { legacyScrap = localStorage.getItem('stamping_diePricePerKg'); } catch (e) { }
        if (legacyScrap !== null && legacyScrap !== '') {
            settings('stamping').set({ diePricePerKg: parseFloat(legacyScrap) });
            detail.push({ from: 'stamping_diePricePerKg', to: 'settings.stamping.diePricePerKg' });
        }

        writeKey(MIGRATION_FLAG, true);
        if (detail.length) console.info('[CostDB] 旧数据迁移完成', detail);
        return { migrated: detail.length > 0, detail: detail };
    }

    /* =====================================================================
     * 9. 整包备份 / 恢复
     * ===================================================================== */

    /** 所有页面级状态（非参数库，但也应该被备份） */
    var STATE_KEYS = ['bomTree', 'weldRelations', 'history', 'injectionForm', 'stampingForm'];

    var APP_ID = 'cost-model';

    function exportBundle(extra) {
        var stores = {};
        Object.keys(SCHEMAS).forEach(function (name) { stores[name] = createTable(name).all(); });

        var state = {};
        STATE_KEYS.forEach(function (k) {
            var v = readKey('state_' + k, null);
            if (v !== null) state[k] = v;
        });

        var scopes = {};
        Object.keys(SETTINGS_DEFAULTS).forEach(function (s) { scopes[s] = settings(s).get(); });

        return {
            app: APP_ID,
            schemaVersion: SCHEMA_VERSION,
            engineVersion: CostEngine.VERSION,
            exportedAt: new Date().toISOString(),
            note: '这是完整的成本参数库备份。导入时会按主键合并，不会丢失本地已有数据。',
            stores: stores,
            settings: scopes,
            state: state,
            extra: extra || null
        };
    }

    function downloadBundle(filename) {
        CostEngine.exportJson(filename || ('成本参数库备份_' + CostEngine.timestamp() + '.json'), exportBundle());
    }

    /**
     * 导入整包备份。
     * @param {Object} bundle
     * @param {Object} opts { mode: 'merge' | 'replace' }
     * @returns {{ok, errors:[], report:{}}}
     */
    function importBundle(bundle, opts) {
        opts = opts || {};
        var mode = opts.mode || 'merge';
        var errors = [];
        var report = {};

        if (!bundle || typeof bundle !== 'object') return { ok: false, errors: ['文件内容不是有效的 JSON 对象'], report: {} };
        if (bundle.app !== APP_ID) errors.push('这不是「汽车成本计算工具箱」的备份文件（app=' + bundle.app + '）');
        if (!bundle.schemaVersion) errors.push('缺少 schemaVersion 字段');
        if (errors.length) return { ok: false, errors: errors, report: {} };

        var major = String(bundle.schemaVersion).split('.')[0];
        var localMajor = SCHEMA_VERSION.split('.')[0];
        if (major !== localMajor) {
            return { ok: false, errors: ['备份文件版本 ' + bundle.schemaVersion + ' 与当前版本 ' + SCHEMA_VERSION + ' 不兼容'], report: {} };
        }

        Object.keys(bundle.stores || {}).forEach(function (name) {
            if (!SCHEMAS[name]) { report[name] = '跳过（未知数据表）'; return; }
            var res = createTable(name).importRows(bundle.stores[name], mode);
            report[name] = mode === 'replace' ? ('已替换为 ' + (bundle.stores[name] || []).length + ' 条') : res;
        });

        Object.keys(bundle.settings || {}).forEach(function (scope) {
            var s = settings(scope);
            s.set(mode === 'replace' ? bundle.settings[scope] : Object.assign({}, bundle.settings[scope], s.get()));
            report['settings.' + scope] = '已导入';
        });

        Object.keys(bundle.state || {}).forEach(function (k) {
            writeKey('state_' + k, bundle.state[k]);
            report['state.' + k] = '已导入';
        });

        return { ok: true, errors: [], report: report };
    }

    /** 页面级状态读写（BOM / 焊接关系 / 历史 等） */
    function state(key, value) {
        if (value === undefined) return readKey('state_' + key, null);
        writeKey('state_' + key, value);
        return value;
    }

    /* =====================================================================
     * 10. 公共 API
     * ===================================================================== */

    var tables = {};
    Object.keys(SCHEMAS).forEach(function (name) { tables[name] = createTable(name); });

    return {
        VERSION: SCHEMA_VERSION,
        APP_ID: APP_ID,
        SCHEMAS: SCHEMAS,
        DEFAULTS: DEFAULTS,
        SETTINGS_DEFAULTS: SETTINGS_DEFAULTS,
        PRESETS: PRESETS,
        PRESET_ORDER: PRESET_ORDER,
        applyPreset: applyPreset,
        getPreset: getPreset,
        parsePriceList: parsePriceList,
        importPriceList: importPriceList,
        buildPriceTemplate: buildPriceTemplate,
        normalizeCode: normalizeCode,
        tables: tables,
        table: function (name) { return tables[name] || createTable(name); },
        settings: settings,
        state: state,
        genId: genId,
        validateRecord: validateRecord,
        normalizeRecord: normalizeRecord,
        migrateLegacy: migrateLegacy,
        exportBundle: exportBundle,
        importBundle: importBundle,
        downloadBundle: downloadBundle,
        today: today
    };
}));
