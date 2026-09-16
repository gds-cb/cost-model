/*!
 * cost-engine.js —— 汽车零部件成本计算引擎 V1.0.0
 * ---------------------------------------------------------------
 * 设计原则：任何零件（注塑/冲压/压铸/机加工/线束…）的成本，都是同样
 * 7 个成本块的组合。品类差异只体现在「每个块用什么公式、填什么参数」。
 *
 *   1. material   材料费      = 毛重×单价 − 废料回收 + 外购子件
 *   2. process    加工费      = Σ(工时×费率) 或 Σ(冲次×单次费率) 或 循环时间
 *   3. tooling    工装摊销    = 模具总价×供应商分摊比 ÷ 生命周期产量
 *   4. surface    二次加工    = 处理面积×单价×工艺系数
 *   5. joining    连接装配    = Σ(焊点/螺栓/卡扣 数 × 单点费率)
 *   6. logistics  包装物流    = 包装摊销 + 运费/件 + 仓储 + EDI
 *   7. overhead   期间费用    = (1~6)×管理费率 + 利润 + 税金
 *
 * 无任何第三方依赖，可离线/内网运行；同时兼容 Node（供未来服务端复用）。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CostEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var VERSION = '1.0.0';

    /* =====================================================================
     * 0. 通用工具
     * ===================================================================== */

    /** 安全取数：空/非法一律回落默认值，避免 NaN 污染整张成本表 */
    function num(v, dflt) {
        if (dflt === undefined) dflt = 0;
        if (v === null || v === undefined || v === '') return dflt;
        var n = typeof v === 'number' ? v : parseFloat(v);
        return isFinite(n) ? n : dflt;
    }

    /** 取正数，非正数回落默认值（用于费率、密度等不应为 0 的参数） */
    function pos(v, dflt) {
        var n = num(v, dflt);
        return n > 0 ? n : dflt;
    }

    function round(n, digits) {
        if (digits === undefined) digits = 2;
        var f = Math.pow(10, digits);
        return Math.round((num(n) + Number.EPSILON) * f) / f;
    }

    function sum(arr) {
        return (arr || []).reduce(function (s, x) { return s + num(x); }, 0);
    }

    function money(n, digits) { return round(n, digits === undefined ? 2 : digits).toFixed(digits === undefined ? 2 : digits); }
    function pct(n, digits) { return round(num(n) * 100, digits === undefined ? 1 : digits) + '%'; }

    function escapeHtml(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /** 深拷贝（用于参数预设，避免调用方互相污染） */
    function clone(o) { return JSON.parse(JSON.stringify(o)); }

    /* =====================================================================
     * 1. 成本块 —— material 材料费
     * ===================================================================== */

    /**
     * @param {Object} i
     *   grossWeightKg  毛重(kg)   —— 实际采购/投料重量，含工艺废料
     *   netWeightKg    净重(kg)   —— 零件本体重量，用于算废料回收
     *   unitPrice      材料单价(元/kg)
     *   scrapPrice     废料回收价(元/kg)
     *   scrapCredit    true=废料冲减材料成本（默认 true）
     *   purchasedCost  外购子件成本(元/件) —— 总成类零件用
     * @returns {{key,name,cost,detail:{...}}}
     */
    function material(i) {
        i = i || {};
        var grossKg = Math.max(0, num(i.grossWeightKg));
        var netKg = Math.max(0, num(i.netWeightKg, grossKg));
        var unitPrice = num(i.unitPrice);
        var grossCost = grossKg * unitPrice;

        // 废料 = 毛重 − 净重（毛重小于净重属输入错误，按 0 处理并告警）
        var scrapKg = Math.max(0, grossKg - netKg);
        var scrapValue = num(i.scrapCredit, true) === false ? 0 : scrapKg * num(i.scrapPrice);
        var purchased = num(i.purchasedCost);

        var cost = grossCost - scrapValue + purchased;
        var utilization = grossKg > 0 ? netKg / grossKg : 0;

        return {
            key: 'material',
            name: '材料费',
            cost: cost,
            detail: {
                grossKg: round(grossKg, 4),
                netKg: round(netKg, 4),
                scrapKg: round(scrapKg, 4),
                unitPrice: unitPrice,
                grossCost: round(grossCost, 4),
                scrapValue: round(scrapValue, 4),
                purchasedCost: round(purchased, 4),
                utilization: round(utilization, 4)
            }
        };
    }

    /* =====================================================================
     * 2. 成本块 —— process 加工费
     * ===================================================================== */

    /**
     * 单道工序。支持三种计价方式，按 type 自动分派：
     *   { type:'machine', hoursPerPart, ratePerHour }              工时制（机加工/焊接/装配）
     *   { type:'stroke',  strokes, ratePerStroke }                 冲次制（冲压）
     *   { type:'cycle',   cycleSec, cavity, machineRate, laborRate } 循环制（注塑/压铸）
     * 也允许直接给 { amount } 手工指定金额。
     */
    function processOp(op) {
        op = op || {};
        var type = op.type || 'machine';
        var qtyMultiplier = pos(op.qtyMultiplier, 1); // 一个总成里该工序要做几遍
        var amount = 0;
        var note = '';

        if (op.amount !== undefined && op.amount !== null && op.amount !== '') {
            amount = num(op.amount);
            note = '手工指定';
        } else if (type === 'stroke') {
            var strokes = num(op.strokes, 1);
            var rps = num(op.ratePerStroke);
            amount = strokes * rps;
            note = strokes + ' 冲次 × ' + round(rps, 4) + ' 元/冲次';
        } else if (type === 'cycle') {
            var cycle = pos(op.cycleSec, 1);
            var cavity = pos(op.cavity, 1);
            var rate = num(op.machineRate) + num(op.laborRate);
            amount = rate / (3600 / cycle * cavity);
            note = '周期 ' + cycle + 's ÷ ' + cavity + ' 穴 × ' + round(rate, 2) + ' 元/h';
        } else {
            amount = num(op.hoursPerPart) * num(op.ratePerHour);
            note = round(num(op.hoursPerPart), 5) + ' h × ' + round(num(op.ratePerHour), 2) + ' 元/h';
        }

        return {
            name: op.name || '工序',
            type: type,
            cost: amount * qtyMultiplier,
            note: note,
            qtyMultiplier: qtyMultiplier
        };
    }

    /** @param {Object} i  { ops:[...] } */
    function process(i) {
        i = i || {};
        var ops = (i.ops || []).map(processOp);
        return {
            key: 'process',
            name: '加工费',
            cost: sum(ops.map(function (o) { return o.cost; })),
            detail: { ops: ops }
        };
    }

    /* =====================================================================
     * 3. 成本块 —— tooling 工装模具摊销
     * ===================================================================== */

    /**
     * @param {Object} i
     *   totalToolPrice  模具总价(元) —— 一次性投入
     *   supplierShare   供应商分摊比例 0~1（主机厂全付=0，供应商全付=1）
     *   lifecycleQty    生命周期总产量(件) —— 注意用生命周期，不是年产量
     */
    function tooling(i) {
        i = i || {};
        var price = Math.max(0, num(i.totalToolPrice));
        var share = num(i.supplierShare, 1);
        share = Math.min(1, Math.max(0, share));
        var qty = num(i.lifecycleQty);
        var cost = qty > 0 ? (price * share) / qty : 0;
        return {
            key: 'tooling',
            name: '模具分摊',
            cost: cost,
            detail: {
                totalToolPrice: round(price, 2),
                supplierShare: share,
                supplierBorne: round(price * share, 2),
                lifecycleQty: qty
            }
        };
    }

    /* =====================================================================
     * 4. 成本块 —— surface 二次加工 / 表面处理
     * ===================================================================== */

    /**
     * @param {Object} i
     *   areaDm2    处理面积(dm²)。注：注塑件应尽量用表面积而非投影面积
     *   unitPrice  单价(元/dm²)
     *   factor     工艺/厚度系数
     *   yield      一次合格率 0~1（<1 时成本按 1/yield 放大）
     */
    function surface(i) {
        i = i || {};
        var area = Math.max(0, num(i.areaDm2));
        var unitPrice = num(i.unitPrice);
        var factor = pos(i.factor, 1);
        var yieldRate = pos(i.yield, 1);
        var cost = (area * unitPrice * factor) / Math.min(1, yieldRate);
        return {
            key: 'surface',
            name: '表面处理',
            cost: cost,
            detail: {
                areaDm2: round(area, 3),
                unitPrice: unitPrice,
                factor: factor,
                yield: yieldRate
            }
        };
    }

    /* =====================================================================
     * 5. 成本块 —— joining 连接 / 装配
     * ===================================================================== */

    /** 默认单点/单米费率(元)。可在调用时用 rate 覆盖。 */
    var JOIN_RATES = {
        spot: { rate: 0.25, unit: 'count', label: '点焊' },
        mig: { rate: 0.10, unit: 'length', label: 'MIG 焊' },
        laser: { rate: 0.45, unit: 'length', label: '激光焊' },
        bolt: { rate: 0.15, unit: 'count', label: '螺栓' },
        clip: { rate: 0.08, unit: 'count', label: '卡扣' },
        rivet: { rate: 0.12, unit: 'count', label: '铆接' },
        adhesive: { rate: 0.30, unit: 'length', label: '涂胶' }
    };

    function joiningItem(it) {
        it = it || {};
        var type = it.type || 'spot';
        var def = JOIN_RATES[type] || { rate: 0, unit: 'count', label: type };
        var rate = it.rate !== undefined && it.rate !== null && it.rate !== '' ? num(it.rate) : def.rate;
        var cost = 0;
        if (def.unit === 'length') cost = (num(it.lengthMm) / 10) * rate; // 每 10mm
        else cost = num(it.count) * rate;
        return {
            type: type,
            label: it.label || def.label,
            cost: cost,
            note: def.unit === 'length'
                ? round(num(it.lengthMm), 1) + ' mm ÷ 10 × ' + rate + ' 元'
                : num(it.count) + ' 个 × ' + rate + ' 元'
        };
    }

    /** @param {Object} i  { items:[{type,count|lengthMm,qty}] } */
    function joining(i) {
        i = i || {};
        var items = (i.items || []).map(function (raw) {
            var r = joiningItem(raw);
            var q = pos(raw.qty, 1);
            r.cost *= q;
            r.qty = q;
            return r;
        });
        return {
            key: 'joining',
            name: '连接装配',
            cost: sum(items.map(function (x) { return x.cost; })),
            detail: { items: items }
        };
    }

    /* =====================================================================
     * 6. 成本块 —— logistics 包装物流
     * ===================================================================== */

    var LOGISTICS_MODES = ['general', 'direct', 'milkrun', 'rdc'];

    /**
     * 通用零担：按重量/体积重计费
     * 体积重(kg) = (L/10)×(W/10)×(H/10) ÷ 体积系数   —— L/W/H 单位 mm
     */
    function logisticsGeneral(i) {
        var l = num(i.lengthMm), w = num(i.widthMm), h = num(i.heightMm);
        var actualKg = num(i.partWeightKg);
        var volFactor = pos(i.volFactor, 6000);
        var volKg = (l / 10) * (w / 10) * (h / 10) / volFactor;
        var mode = i.billingMode || 'max';
        var billKg = mode === 'actual' ? actualKg : (mode === 'volumetric' ? volKg : Math.max(actualKg, volKg));
        var cost = num(i.freightRatePerKgKm) * num(i.distanceKm) * billKg;
        return { cost: cost, actualKg: actualKg, volKg: volKg, billKg: billKg };
    }

    /** 供应商直送：按车次，一车能装多少件由载重决定 */
    function logisticsDirect(i) {
        var partKg = pos(i.partWeightKg, 0.0001);
        var capacityKg = pos(i.truckCapacityKg, 1);
        var annualQty = num(i.annualQty);
        var partsPerTruck = Math.max(1, Math.floor(capacityKg / partKg));
        var trips = Math.ceil(annualQty / partsPerTruck);
        var total = trips * num(i.truckCost);
        return {
            cost: annualQty > 0 ? total / annualQty : 0,
            partsPerTruck: partsPerTruck,
            tripsPerYear: trips,
            totalFreight: round(total, 2)
        };
    }

    /** 循环取货 Milk-run：线路成本按参与供应商数分摊 */
    function logisticsMilkrun(i) {
        var annualQty = num(i.annualQty);
        var suppliers = pos(i.supplierCount, 1);
        var perTrip = pos(i.partsPerTrip, 1);
        var trips = Math.ceil(annualQty / perTrip);
        var total = (num(i.totalCostPerTrip) / suppliers) * trips;
        return { cost: annualQty > 0 ? total / annualQty : 0, tripsPerYear: trips, totalFreight: round(total, 2) };
    }

    /** 第三方物流 RDC：入仓 + 上线配送 + 仓储 */
    function logisticsRdc(i) {
        var days = num(i.inventoryDays, 7);
        var storage = num(i.storageFee) * (days / 30);
        return {
            cost: num(i.inboundFee) + num(i.lineFeedFee) + storage,
            storagePerPart: round(storage, 4)
        };
    }

    /** 包装：摊销 + 空箱返程 + EDI 分摊 */
    function packaging(i) {
        i = i || {};
        var amortize = num(i.packagingAmortize);
        var returnRate = num(i.emptyReturnRate);
        var cost = amortize * (1 + returnRate);
        var annualQty = num(i.annualQty);
        var ediPerPart = annualQty > 0 ? (num(i.ediFeeMonthly) * 12) / annualQty : 0;
        return { packagingCost: cost, ediPerPart: ediPerPart, cost: cost + ediPerPart };
    }

    /**
     * @param {Object} i
     *   mode: general | direct | milkrun | rdc
     *   各模式所需字段见上面各函数
     *   packagingAmortize / emptyReturnRate / ediFeeMonthly / annualQty  —— 包装部分
     */
    function logistics(i) {
        i = i || {};
        var mode = i.mode || 'general';
        var freight = { cost: 0 };

        if (mode === 'direct') freight = logisticsDirect(i);
        else if (mode === 'milkrun') freight = logisticsMilkrun(i);
        else if (mode === 'rdc') freight = logisticsRdc(i);
        else freight = logisticsGeneral(i);

        var pack = packaging(i);
        var cost = num(freight.cost) + num(pack.cost);

        return {
            key: 'logistics',
            name: '包装物流',
            cost: cost,
            detail: {
                mode: mode,
                freightCost: round(num(freight.cost), 4),
                packagingCost: round(pack.packagingCost, 4),
                ediPerPart: round(pack.ediPerPart, 4),
                freightExtra: freight // 直送/零担的件数、车次等附加信息
            }
        };
    }

    /* =====================================================================
     * 7. 成本块 —— overhead 期间费用 / 利润 / 税金
     * ===================================================================== */

    /**
     * @param {Object} i
     *   directCost      制造成本合计（1~6）
     *   managementRate  管理费率（对直接成本）
     *   profitRate      利润率（对 直接成本+管理费）
     *   taxRate         增值税率
     *   jitFactor       交付方式系数（JIT/排序上线）
     *   capitalRate     账期资金占用年化利率  —— C 阶段启用
     *   paymentDays     账期天数            —— C 阶段启用
     */
    function overhead(i) {
        i = i || {};
        var direct = num(i.directCost);
        var mgmtRate = num(i.managementRate, 0.12);
        var profitRate = num(i.profitRate, 0.10);
        var taxRate = num(i.taxRate, 0.13);
        var jitFactor = pos(i.jitFactor, 1);

        var management = direct * mgmtRate;
        var profit = (direct + management) * profitRate;

        // 账期资金占用：供应商垫资成本 = 含税前金额 × 年化利率 × 账期/365
        var capital = 0;
        var paymentDays = num(i.paymentDays);
        var capitalRate = num(i.capitalRate);
        if (paymentDays > 0 && capitalRate > 0) {
            capital = (direct + management + profit) * capitalRate * (paymentDays / 365);
        }

        var beforeJit = direct + management + profit + capital;
        var total = beforeJit * jitFactor;
        var quote = total * (1 + taxRate);

        return {
            key: 'overhead',
            name: '管理费/利润/税',
            cost: management + profit + capital,
            detail: {
                management: round(management, 4),
                profit: round(profit, 4),
                capital: round(capital, 4),
                jitFactor: jitFactor,
                jitUplift: round(total - beforeJit, 4),
                taxRate: taxRate,
                taxAmount: round(quote - total, 4),
                managementRate: mgmtRate,
                profitRate: profitRate,
                paymentDays: paymentDays,
                capitalRate: capitalRate
            }
        };
    }

    /* =====================================================================
     * 8. 汇总 —— buildSheet 组装一张完整成本表
     * ===================================================================== */

    var BLOCK_ORDER = ['material', 'process', 'tooling', 'surface', 'joining', 'logistics'];

    /**
     * @param {Object} input  形如 { material:{...}, process:{...}, ..., overhead:{...} }
     *                        缺失的成本块自动跳过
     * @returns {{blocks, blockMap, directCost, overhead, totalCost, quotePrice, diagnostics}}
     */
    function buildSheet(input) {
        input = input || {};
        var diagnostics = [];
        var blocks = [];

        BLOCK_ORDER.forEach(function (key) {
            var payload = input[key];
            if (!payload) return;
            var fn = { material: material, process: process, tooling: tooling, surface: surface, joining: joining, logistics: logistics }[key];
            var block;
            // 允许调用方传入已算好的成本块（__built:true），避免重复计算
            if (payload.__built === true) {
                block = payload;
            } else {
                try {
                    block = fn(payload);
                } catch (e) {
                    diagnostics.push({ level: 'error', block: key, message: e.message });
                    return;
                }
            }
            if (block.cost < 0) {
                diagnostics.push({ level: 'warn', block: key, message: block.name + ' 出现负值 ' + money(block.cost) + ' 元，请检查输入' });
            }
            // 注意：预构建的多材料成本块没有单一 unitPrice，跳过该检查避免误报
            if (key === 'material' && block.detail.unitPrice !== undefined && block.detail.unitPrice <= 0) {
                diagnostics.push({ level: 'warn', block: key, message: '材料单价为 0，材料费未计入' });
            }
            if (key === 'material' && block.detail.grossKg > 0 && block.detail.netKg > block.detail.grossKg) {
                diagnostics.push({ level: 'warn', block: key, message: '净重大于毛重，请检查下料尺寸或净重输入' });
            }
            // 注意：预构建块的参数在 detail 里，不在 payload 顶层
            if (key === 'tooling') {
                var lifeQty = payload.__built === true ? num(block.detail.lifecycleQty) : num(payload.lifecycleQty);
                if (lifeQty <= 0) {
                    diagnostics.push({ level: 'warn', block: key, message: '生命周期产量为 0，模具未摊销' });
                }
            }
            blocks.push(block);
        });

        var directCost = sum(blocks.map(function (b) { return b.cost; }));

        var ohInput = Object.assign({ directCost: directCost }, input.overhead || {});
        var oh = overhead(ohInput);
        blocks.push(oh);

        var totalCost = directCost + oh.detail.management + oh.detail.profit + oh.detail.capital;
        totalCost *= oh.detail.jitFactor;
        var quotePrice = totalCost * (1 + oh.detail.taxRate);

        if (totalCost <= 0) {
            diagnostics.push({ level: 'error', block: 'total', message: '完全成本为 0，请检查输入参数' });
        }

        var blockMap = {};
        blocks.forEach(function (b) { blockMap[b.key] = b; });

        return {
            blocks: blocks,
            blockMap: blockMap,
            directCost: round(directCost, 4),
            overhead: oh.detail,
            totalCost: round(totalCost, 4),
            quotePrice: round(quotePrice, 4),
            diagnostics: diagnostics
        };
    }

    /* =====================================================================
     * 8b. 展示展开 —— 把成本块拆成工程师习惯看到的科目
     * ===================================================================== */

    /**
     * 期间费用拆成 管理费 / 利润 / 账期资金占用；物流拆成 运费 / 包装及EDI；
     * 其余成本块原样保留。这样明细粒度贴近成本表，而不是只有几个大块。
     * @param {Object} sheet  buildSheet 的返回值
     * @returns {Array} [{name, val}]
     */
    function displayItems(sheet) {
        if (!sheet || !sheet.blocks) return [];
        var out = [];
        sheet.blocks.forEach(function (b) {
            if (b.key === 'overhead') {
                out.push({ name: '管理费', val: num(b.detail.management) });
                out.push({ name: '利润', val: num(b.detail.profit) });
                if (num(b.detail.capital) !== 0) out.push({ name: '账期资金占用', val: num(b.detail.capital) });
            } else if (b.key === 'logistics') {
                out.push({ name: '运费', val: num(b.detail.freightCost) });
                var pack = num(b.detail.packagingCost) + num(b.detail.ediPerPart);
                if (pack !== 0) out.push({ name: '包装及EDI', val: pack });
            } else {
                out.push({ name: b.name, val: num(b.cost) });
            }
        });
        return out;
    }

    /* =====================================================================
     * 9. 图表 —— 无依赖 SVG（替代 CDN 版 Chart.js，可离线）
     * ===================================================================== */

    var PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#6366f1'];

    function normalizeItems(items) {
        return (items || []).map(function (it, idx) {
            return {
                name: it.name || ('项目' + (idx + 1)),
                val: num(it.val),
                color: it.color || PALETTE[idx % PALETTE.length]
            };
        });
    }

    /**
     * 环形图。用 stroke-dasharray 画弧，天然支持「只有一项」的 100% 情况。
     * @param {HTMLElement} el
     * @param {Array} items [{name, val, color}]
     */
    function pieChart(el, items) {
        if (!el) return;
        items = normalizeItems(items).filter(function (i) { return i.val > 0; });
        var total = sum(items.map(function (i) { return i.val; }));
        if (total <= 0) { el.innerHTML = '<div class="ce-empty">暂无数据</div>'; return; }

        var size = 240, cx = size / 2, cy = size / 2;
        var rOuter = 92, rInner = 56;
        var r = (rOuter + rInner) / 2, sw = rOuter - rInner;
        var C = 2 * Math.PI * r;
        var offset = 0;

        var arcs = items.map(function (it) {
            var frac = it.val / total;
            var len = frac * C;
            var seg = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none"'
                + ' stroke="' + it.color + '" stroke-width="' + sw + '"'
                + ' stroke-dasharray="' + len.toFixed(3) + ' ' + (C - len).toFixed(3) + '"'
                + ' stroke-dashoffset="' + (-offset).toFixed(3) + '"'
                + ' transform="rotate(-90 ' + cx + ' ' + cy + ')">'
                + '<title>' + escapeHtml(it.name) + '：' + money(it.val) + ' 元（' + pct(frac) + '）</title>'
                + '</circle>';
            offset += len;
            return seg;
        }).join('');

        var legend = items.map(function (it) {
            var frac = it.val / total;
            return '<div class="ce-legend-row">'
                + '<span class="ce-dot" style="background:' + it.color + '"></span>'
                + '<span class="ce-legend-name">' + escapeHtml(it.name) + '</span>'
                + '<span class="ce-legend-val">' + money(it.val) + ' 元</span>'
                + '<span class="ce-legend-pct">' + pct(frac) + '</span>'
                + '</div>';
        }).join('');

        el.innerHTML = '<div class="ce-pie-wrap">'
            + '<svg viewBox="0 0 ' + size + ' ' + size + '" class="ce-pie" role="img">'
            + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="#eef2f7" stroke-width="' + sw + '"/>'
            + arcs + '</svg>'
            + '<div class="ce-legend">' + legend + '</div>'
            + '</div>';
    }

    /**
     * 横向条形图（HTML/CSS，天然响应式）。用于敏感度、对比。
     * @param {HTMLElement} el
     * @param {Array} items [{name, val, color, note}]
     */
    function barChart(el, items) {
        if (!el) return;
        items = normalizeItems(items);
        if (!items.length) { el.innerHTML = '<div class="ce-empty">暂无数据</div>'; return; }
        var max = Math.max.apply(null, items.map(function (i) { return Math.abs(i.val); })) || 1;
        el.innerHTML = items.map(function (it) {
            var w = Math.min(100, Math.abs(it.val) / max * 100);
            var negative = it.val < 0;
            return '<div class="ce-bar-row">'
                + '<span class="ce-bar-name">' + escapeHtml(it.name) + '</span>'
                + '<span class="ce-bar-track"><span class="ce-bar-fill" style="width:' + w.toFixed(1) + '%;background:' + (negative ? '#ef4444' : it.color) + '"></span></span>'
                + '<span class="ce-bar-val">' + money(it.val) + (it.note ? ' <em>' + escapeHtml(it.note) + '</em>' : '') + '</span>'
                + '</div>';
        }).join('');
    }

    /* =====================================================================
     * 10. 敏感度分析 —— 「哪个参数动了最致命」
     * ===================================================================== */

    /**
     * 单因素敏感度：把每个参数分别上下浮动 delta，看完全成本变化多少。
     * @param {Function} evaluator  (overrides) => number   接收参数覆盖表，返回完全成本
     * @param {Object}   base       基准参数表 { 参数名: 数值 }
     * @param {Object}   opts       { delta:0.1, params:['材料单价', ...] }
     * @returns {Array} [{name, base, up, down, upDelta, downDelta, swing, swingPct}]
     */
    function sensitivity(evaluator, base, opts) {
        opts = opts || {};
        var delta = num(opts.delta, 0.1);
        var names = opts.params || Object.keys(base);
        var baseCost = num(evaluator({}));
        var rows = names.map(function (name) {
            var v = num(base[name]);
            if (v === 0) return null;
            var upOverride = {}; upOverride[name] = v * (1 + delta);
            var downOverride = {}; downOverride[name] = v * (1 - delta);
            var upCost = num(evaluator(upOverride));
            var downCost = num(evaluator(downOverride));
            var swing = Math.abs(upCost - downCost);
            return {
                name: name,
                base: v,
                up: upCost,
                down: downCost,
                upDelta: upCost - baseCost,
                downDelta: downCost - baseCost,
                swing: swing,
                swingPct: baseCost > 0 ? swing / baseCost : 0
            };
        }).filter(Boolean);

        rows.sort(function (a, b) { return b.swing - a.swing; });
        return rows;
    }

    /* =====================================================================
     * 11. 导出 —— Excel / CSV / JSON（无依赖）
     * ===================================================================== */

    function downloadBlob(filename, blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    }

    function timestamp() {
        var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
    }

    /** CSV（带 UTF-8 BOM，Excel 打开不乱码） */
    function exportCsv(filename, rows) {
        var csv = rows.map(function (row) {
            return row.map(function (cell) {
                var s = cell === null || cell === undefined ? '' : String(cell);
                return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
            }).join(',');
        }).join('\r\n');
        downloadBlob(filename, new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
    }

    /**
     * 导出 Excel（HTML-table 形式 .xls，Excel/WPS 可直接打开，保留格式与多表）
     * @param {string} filename
     * @param {Array}  sheets [{ name, rows:[[...]], title?, watermark? }]
     */
    function exportXls(filename, sheets) {
        function sheetHtml(sheet) {
            var head = '';
            if (sheet.title) {
                head += '<tr><td colspan="8" style="font-size:16pt;font-weight:bold;height:30pt">' + escapeHtml(sheet.title) + '</td></tr>';
            }
            if (sheet.watermark) {
                head += '<tr><td colspan="8" style="font-size:9pt;color:#888">' + escapeHtml(sheet.watermark) + '</td></tr>';
            }
            var body = (sheet.rows || []).map(function (row, ri) {
                var style = ri === 0 && sheet.header !== false
                    ? ' style="background:#eef2ff;font-weight:bold;border:1px solid #cbd5e1"'
                    : ' style="border:1px solid #e2e8f0"';
                return '<tr>' + row.map(function (cell) {
                    var v = cell === null || cell === undefined ? '' : cell;
                    var isNum = typeof v === 'number';
                    return '<td' + style + (isNum ? ' x:num' : '') + '>' + escapeHtml(isNum ? round(v, 4) : v) + '</td>';
                }).join('') + '</tr>';
            }).join('');
            return head + body;
        }

        var html = '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8">'
            + '<style>td{font-family:微软雅黑,Arial;font-size:10pt;vertical-align:middle;padding:3px 6px}</style></head><body>'
            + sheets.map(function (s, i) {
                return '<table border="0" cellspacing="0">' + sheetHtml(s) + '</table>'
                    + (i < sheets.length - 1 ? '<br style="mso-data-placement:same-cell">' : '');
            }).join('')
            + '</body></html>';

        downloadBlob(filename, new Blob(['\uFEFF' + html], { type: 'application/vnd.ms-excel;charset=utf-8' }));
    }

    /** 导出 JSON 备份 */
    function exportJson(filename, data) {
        downloadBlob(filename, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }));
    }

    /* =====================================================================
     * 12. 输入校验 —— 避免静默出错
     * ===================================================================== */

    /**
     * @param {Object} rules { 字段名: {label, min, max, required} }
     * @param {Object} values
     * @returns {Array} [{field, level, message}]
     */
    function validate(rules, values) {
        var issues = [];
        Object.keys(rules || {}).forEach(function (field) {
            var r = rules[field] || {};
            var label = r.label || field;
            var raw = values ? values[field] : undefined;
            var missing = raw === undefined || raw === null || raw === '';
            if (r.required && missing) {
                issues.push({ field: field, level: 'error', message: label + ' 必填' });
                return;
            }
            if (missing) return;
            var v = num(raw, NaN);
            if (!isFinite(v)) {
                issues.push({ field: field, level: 'error', message: label + ' 不是有效数字' });
                return;
            }
            if (r.min !== undefined && v < r.min) issues.push({ field: field, level: 'error', message: label + ' 不能小于 ' + r.min });
            if (r.max !== undefined && v > r.max) issues.push({ field: field, level: 'error', message: label + ' 不能大于 ' + r.max });
        });
        return issues;
    }

    /* =====================================================================
     * 13. 公共 API
     * ===================================================================== */

    return {
        VERSION: VERSION,
        num: num, pos: pos, round: round, sum: sum, money: money, pct: pct,
        escapeHtml: escapeHtml, clone: clone,
        // 成本块
        material: material,
        process: process, processOp: processOp,
        tooling: tooling,
        surface: surface,
        joining: joining, joiningItem: joiningItem, JOIN_RATES: JOIN_RATES,
        logistics: logistics, packaging: packaging,
        logisticsGeneral: logisticsGeneral, logisticsDirect: logisticsDirect,
        logisticsMilkrun: logisticsMilkrun, logisticsRdc: logisticsRdc,
        LOGISTICS_MODES: LOGISTICS_MODES,
        overhead: overhead,
        buildSheet: buildSheet, BLOCK_ORDER: BLOCK_ORDER,
        displayItems: displayItems,
        // 图表
        pieChart: pieChart, barChart: barChart, PALETTE: PALETTE,
        // 分析
        sensitivity: sensitivity,
        // 导出
        exportCsv: exportCsv, exportXls: exportXls, exportJson: exportJson,
        downloadBlob: downloadBlob, timestamp: timestamp,
        // 校验
        validate: validate
    };
}));
