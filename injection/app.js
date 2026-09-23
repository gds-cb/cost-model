/*!
 * 注塑件成本模型 —— 页面逻辑 V2.0.0
 * ---------------------------------------------------------------
 * 本次重构（A 阶段）修复的问题：
 *   ✅ 去 CDN 依赖（图表自绘，可离线/内网）
 *   ✅ 新增 Excel 导出（此前落地页宣传但实际没有）
 *   ✅ 新增参数库导入/导出备份（换电脑不丢数据）
 *   ✅ 管理费率/利润率/税率/废料价 全部可配置（此前硬编码 12%/10%/13%）
 *   ✅ 计算全面走 CostEngine 引擎，为三模式/多品类复用打基础
 *   ✅ 设备匹配不再用精确相等，超限时明确告警而不是静默退化
 *   ✅ 输入校验 + 诊断面板，不再静默算错
 *   ✅ 反馈不再"假装有后端"（本地留存 + 邮件/剪贴板通道）
 *   ✅ 修复两处 </tbody><td> 非法闭合标签
 */
(function () {
    'use strict';

    var E = window.CostEngine;
    var DB = window.CostDB;
    var UI = window.CostUI;

    /* =====================================================================
     * 1. 参数库适配层
     * materialsData / surfaceData 是 CostDB 参数库的「视图」，
     * 保留原有字段名以兼容既有界面代码；真正的数据在 costdb_v1_* 中。
     * ===================================================================== */

    var MAT_TABLE = DB.table('materials');
    var SURF_TABLE = DB.table('surface');

    var materialsData = [];
    var surfaceData = [];
    var equipmentDB = [];
    var settings = null;
    var currentMaterialId = null;
    var currentSurfaceId = null;
    var lastSheet = null;

    function matToView(r) {
        return { id: r.id, MaterialCode: r.code, Density: r.density, UnitPrice: r.unitPrice };
    }
    function matFromView(v) {
        return {
            id: v.id, code: v.MaterialCode, kind: 'polymer',
            density: v.Density, unitPrice: v.UnitPrice,
            updatedAt: DB.today(), source: '页面录入'
        };
    }
    function surfToView(r) {
        return { id: r.id, ProcessName: r.name, UnitPrice: r.unitPrice, ThicknessFactor: r.factor, Yield: (r.yield === undefined ? 1 : r.yield) };
    }
    function surfFromView(v) {
        return {
            id: v.id, name: v.ProcessName, unitPrice: v.UnitPrice,
            factor: v.ThicknessFactor, yield: (v.Yield === undefined ? 1 : v.Yield),
            updatedAt: DB.today(), source: '页面录入'
        };
    }

    function isPolymer(r) { return r.kind !== 'sheet'; }

    function el(id) { return document.getElementById(id); }
    function val(id, dflt) { var n = el(id); return n ? n.value : dflt; }
    function numOf(id, dflt) { var n = el(id); return n ? E.num(n.value, dflt) : dflt; }

    /* =====================================================================
     * 2. 加载 / 保存
     * ===================================================================== */

    function loadData() {
        materialsData = MAT_TABLE.all().filter(isPolymer).map(matToView);
        surfaceData = SURF_TABLE.all().map(surfToView);

        var eqs = DB.table('equipment').all()
            .filter(function (e) { return e.kind === 'injection' && E.num(e.tonnage) > 0; })
            .sort(function (a, b) { return a.tonnage - b.tonnage; });

        equipmentDB = eqs.map(function (e) {
            return {
                id: e.id,
                name: e.name || ('注塑机 ' + e.tonnage + 'T'),
                tonnage: e.tonnage,
                maxForce: E.num(e.maxForce) > 0 ? e.maxForce : e.tonnage * 0.85,
                hourlyRate: E.num(e.hourlyRate),
                laborRate: E.num(e.laborRate)
            };
        });

        settings = DB.settings('injection').get();
        applySettingsToForm();
        refreshSelects();
        refreshPreviews();
    }

    function applySettingsToForm() {
        var set = function (id, v) { var n = el(id); if (n && v !== undefined && v !== null) n.value = v; };
        set('managementRate', E.round(settings.managementRate * 100, 2));
        set('profitRate', E.round(settings.profitRate * 100, 2));
        set('taxRate', E.round(settings.taxRate * 100, 2));
        set('scrapPrice', settings.scrapPrice);
        set('paymentDays', settings.paymentDays);
        set('capitalRate', E.round(E.num(settings.capitalRate, 0.06) * 100, 2));
    }

    function readSettingsFromForm() {
        settings = DB.settings('injection').set({
            managementRate: numOf('managementRate', 12) / 100,
            profitRate: numOf('profitRate', 10) / 100,
            taxRate: numOf('taxRate', 13) / 100,
            paymentDays: numOf('paymentDays', 0),
            capitalRate: numOf('capitalRate', 6) / 100,
            scrapPrice: numOf('scrapPrice', 0)
        });
    }

    /** 保存材料：只同步塑料类记录，绝不触碰冲压件共用的板材数据 */
    function saveMaterials() {
        var before = MAT_TABLE.all();
        var keep = {};
        materialsData.forEach(function (v) {
            var r = matFromView(v);
            MAT_TABLE.upsert(r);
            keep[r.id] = true;
        });
        before.filter(function (r) { return isPolymer(r) && !keep[r.id]; })
            .forEach(function (r) { MAT_TABLE.remove(r.id); });

        materialsData = MAT_TABLE.all().filter(isPolymer).map(matToView);
        refreshSelects();
        refreshPreviews();
        calculate();
    }

    function saveSurface() {
        var before = SURF_TABLE.all();
        var keep = {};
        surfaceData.forEach(function (v) {
            var r = surfFromView(v);
            SURF_TABLE.upsert(r);
            keep[r.id] = true;
        });
        before.filter(function (r) { return !keep[r.id]; })
            .forEach(function (r) { SURF_TABLE.remove(r.id); });

        surfaceData = SURF_TABLE.all().map(surfToView);
        refreshSelects();
        refreshPreviews();
        calculate();
    }

    function refreshSelects() {
        var matSel = el('materialSelect');
        if (matSel) {
            var curMat = matSel.value;
            matSel.innerHTML = '';
            if (!materialsData.length) {
                matSel.add(new Option('（材料库为空，请先新增）', ''));
            } else {
                materialsData.forEach(function (m) { matSel.add(new Option(m.MaterialCode, m.MaterialCode)); });
                if (curMat && materialsData.some(function (m) { return m.MaterialCode === curMat; })) matSel.value = curMat;
            }
        }
        var surfSel = el('surfaceProcess');
        if (surfSel) {
            var curSurf = surfSel.value;
            surfSel.innerHTML = '<option value="">无</option>';
            surfaceData.forEach(function (s) { surfSel.add(new Option(s.ProcessName, s.ProcessName)); });
            if (curSurf && surfaceData.some(function (s) { return s.ProcessName === curSurf; })) surfSel.value = curSurf;
        }
    }

    /** 修复：原来的 '</tbody><td>' / '</tbody></td>' 是非法闭合标签 */
    function refreshPreviews() {
        var matPreview = el('materialTablePreview');
        if (matPreview) {
            if (!materialsData.length) {
                matPreview.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:20px;">暂无数据，点击「新增」添加</div>';
            } else {
                matPreview.innerHTML = '<table class="table-mini">'
                    + '<thead><tr><th>材料</th><th>密度</th><th>价格(元/kg)</th><th style="width:80px">操作</th></tr></thead>'
                    + '<tbody>' + materialsData.map(function (m) {
                        return '<tr>'
                            + '<td>' + E.escapeHtml(m.MaterialCode) + '</td>'
                            + '<td>' + m.Density + '</td>'
                            + '<td>' + m.UnitPrice + '</td>'
                            + '<td>'
                            + '<button class="action-btn edit-btn" data-type="material" data-id="' + m.id + '" title="编辑">✏️</button>'
                            + '<button class="action-btn delete-btn" data-type="material" data-id="' + m.id + '" title="删除">🗑️</button>'
                            + '</td></tr>';
                    }).join('') + '</tbody></table>';
            }
        }

        var surfPreview = el('surfaceTablePreview');
        if (surfPreview) {
            if (!surfaceData.length) {
                surfPreview.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:20px;">暂无数据，点击「新增」添加</div>';
            } else {
                surfPreview.innerHTML = '<table class="table-mini">'
                    + '<thead><tr><th>工艺</th><th>单价(元/dm²)</th><th>系数</th><th style="width:80px">操作</th></tr></thead>'
                    + '<tbody>' + surfaceData.map(function (s) {
                        return '<tr>'
                            + '<td>' + E.escapeHtml(s.ProcessName) + '</td>'
                            + '<td>' + s.UnitPrice + '</td>'
                            + '<td>' + s.ThicknessFactor + '</td>'
                            + '<td>'
                            + '<button class="action-btn edit-btn" data-type="surface" data-id="' + s.id + '" title="编辑">✏️</button>'
                            + '<button class="action-btn delete-btn" data-type="surface" data-id="' + s.id + '" title="删除">🗑️</button>'
                            + '</td></tr>';
                    }).join('') + '</tbody></table>';
            }
        }
    }

    /* =====================================================================
     * 3. 重量计算（保留双模式：精确输入 / 几何估算）
     *    几何估算是「研发估算模式」的核心能力——快、可解释、支持方案对比
     * ===================================================================== */

    function calculatePartWeight() {
        var method = val('weightMethod', 'estimate');
        var runnerWeight = E.num(val('runnerWeight'), 0);
        var cavity = Math.max(1, Math.round(E.num(val('cavityCount'), 1)));
        var runnerPerPart = runnerWeight / cavity;

        if (method === 'manual') {
            var netWeight = E.num(val('netWeight'), 0);
            return { partWeight: netWeight, totalWeight: netWeight + runnerPerPart, method: 'manual' };
        }

        var len = E.num(val('length'), 0);
        var wid = E.num(val('width'), 0);
        var thick = E.num(val('thickness'), 2.8);
        var code = val('materialSelect', '');
        var material = materialsData.filter(function (m) { return m.MaterialCode === code; })[0];
        var density = material ? E.num(material.Density, 1.05) : 1.05;

        var geoFactor = { solid: 0.85, box: 0.60, frame: 0.40, ribbed: 0.70 }[val('partGeometry', 'box')] || 0.60;
        var uniformity = E.num(val('thicknessUniformity'), 1.0);
        var correctedVolumeCm3 = (len * wid * thick / 1000) * geoFactor * uniformity;
        var partWeight = correctedVolumeCm3 * density;

        return { partWeight: partWeight, totalWeight: partWeight + runnerPerPart, method: 'estimate' };
    }

    /* =====================================================================
     * 4. 物流与包装（引擎驱动）
     * ===================================================================== */

    var FREIGHT_RATE_BY_REGION = { 华东: 0.0008, 华南: 0.0009, 华北: 0.0007 };

    function collectLogisticsInput(partWeightG, annualQty) {
        var model = val('logisticsModel', 'general');
        var region = val('region', '华东');
        var input = {
            mode: model,
            annualQty: annualQty,
            partWeightKg: partWeightG / 1000,
            packagingAmortize: { simple: 0.05, eu: 0.15, custom: numOf('packagingAmortize', 0.5) }[val('packagingType', 'simple')] || 0,
            emptyReturnRate: E.num(val('emptyReturn'), 0),
            ediFeeMonthly: numOf('ediFee', 0)
        };

        if (model === 'general') {
            var std = val('volumetricStandard', '6000');
            input.lengthMm = numOf('length', 0);
            input.widthMm = numOf('width', 0);
            input.heightMm = numOf('height', 0);
            input.distanceKm = numOf('logisticsDistance', 500);
            input.freightRatePerKgKm = FREIGHT_RATE_BY_REGION[region] !== undefined ? FREIGHT_RATE_BY_REGION[region] : 0.0008;
            input.billingMode = val('billingMode', 'max');
            input.volFactor = std === 'custom' ? numOf('volumetricFactor', 6000) : E.num(std, 6000);
        } else if (model === 'direct') {
            var parts = String(val('truckType', '')).split('|');
            input.truckCost = E.num(parts[1]);
            input.truckCapacityKg = E.num(parts[2]);
        } else if (model === 'milkrun') {
            input.supplierCount = numOf('milkrunSupplierCount', 1);
            input.totalCostPerTrip = numOf('milkrunTotalCost', 2000);
            input.partsPerTrip = numOf('milkrunPartsPerTrip', 1000);
        } else if (model === 'rdc') {
            input.inboundFee = numOf('rdcInboundFee', 0);
            input.lineFeedFee = numOf('rdcLineFeedFee', 0);
            input.storageFee = numOf('rdcStorageFee', 0);
            input.inventoryDays = numOf('rdcInventoryDays', 7);
        }
        return input;
    }

    var LOGISTICS_LABEL = { general: '通用零担', direct: '供应商直送', milkrun: '循环取货', rdc: 'RDC模式' };

    function jitFactorFromForm() {
        var v = val('deliveryRequirement', 'normal');
        return v === 'jit' ? 1.05 : (v === 'sequencing' ? 1.12 : 1.0);
    }

    function buildLogisticsBlock(partWeightG, annualQty) {
        var block = E.logistics(collectLogisticsInput(partWeightG, annualQty));
        var fx = block.detail.freightExtra || {};
        var setVal = function (id, v) { var n = el(id); if (n && v !== undefined && v !== null) n.value = v; };
        setVal('directPartsPerTruck', fx.partsPerTruck);
        setVal('directTripsPerYear', fx.tripsPerYear);
        setVal('milkrunTripsPerYear', fx.tripsPerYear);
        block.__built = true;
        return block;
    }

    /* =====================================================================
     * 5. 模具成本（公式不变，但费率全部改为可配置）
     * ===================================================================== */

    function buildMoldCost(len, wid, cavity) {
        var projAreaCm2 = len * wid / 100;
        var moldAreaCm2 = ((len + 150) * (wid + 150)) / 100;

        var moldBaseFactor = { 标准模架: 1.0, 精密模架: 1.4, 细水口模架: 1.3, 简化型模架: 0.8 }[val('moldBaseType', '标准模架')] || 1.0;
        var cavityComplexFactor = { 简单: 0.7, 中等: 1.0, 复杂: 1.5, 极复杂: 2.2 }[val('cavityComplex', '中等')] || 1.0;
        var brandFactor = { 国产: 1.0, 合资: 1.6, 进口: 2.2 }[val('hotRunnerBrand', '国产')] || 1.0;

        var moldBaseCost = moldAreaCm2 * settings.moldBasePricePerCm2 * moldBaseFactor;
        var cavityCost = projAreaCm2 * settings.cavityPricePerCm2 * cavityComplexFactor * cavity;
        var slideCost = Math.round(numOf('slideMedium', 0)) * settings.slidePrice;
        var lifterCost = Math.round(numOf('lifterMedium', 0)) * settings.lifterPrice;
        var hotRunnerCost = Math.round(numOf('hotRunnerPoints', 0)) * settings.hotRunnerPricePerPoint * brandFactor;

        var moldLife = Math.max(1, numOf('lifeRequirement', 100000));
        var total = (moldBaseCost + cavityCost + slideCost + lifterCost + hotRunnerCost) * (1 + settings.designTrialRate);
        total *= Math.pow(moldLife / settings.moldLifeBaseRef, settings.moldLifeExponent);
        // 地区/供应商水平差异通过「模具价格系数」体现（不影响上面各项明细，只影响总价）
        var moldPriceFactor = E.num(settings.moldPriceFactor, 1);
        var totalBeforeFactor = total;
        total *= moldPriceFactor;

        return {
            projAreaCm2: projAreaCm2,
            moldAreaCm2: moldAreaCm2,
            moldBaseCost: moldBaseCost,
            cavityCost: cavityCost,
            slideCost: slideCost,
            lifterCost: lifterCost,
            hotRunnerCost: hotRunnerCost,
            designTrialRate: settings.designTrialRate,
            moldLife: moldLife,
            moldPriceFactor: moldPriceFactor,
            totalBeforeFactor: totalBeforeFactor,
            totalMoldPrice: total
        };
    }

    /* =====================================================================
     * 6. 核心计算（引擎驱动）
     * ===================================================================== */

    function calculate() {
        try {
            var diagEl = el('diagnostics');
            readSettingsFromForm();

            var len = numOf('length', 0);
            var wid = numOf('width', 0);
            var thick = numOf('thickness', 2.8);
            var cavity = Math.max(1, Math.round(numOf('cavityCount', 1)));
            var totalQty = Math.max(1, Math.round(numOf('lifecycleQty', 100000)));
            var wasteRatePct = numOf('wasteRate', 0);
            var wasteRate = wasteRatePct / 100;
            var region = val('region', '华东');

            var matCode = val('materialSelect', '');
            var material = materialsData.filter(function (m) { return m.MaterialCode === matCode; })[0];
            if (!material && materialsData.length) material = materialsData[0];
            if (!material) {
                UI.renderDiagnostics(diagEl, [{ level: 'error', message: '材料库为空，请先在右侧「材料价格库」新增材料。' }]);
                return;
            }

            var surfName = val('surfaceProcess', '');
            var surface = surfaceData.filter(function (s) { return s.ProcessName === surfName; })[0] || null;

            // ---- 输入校验：不再静默出错 ----
            var issues = E.validate({
                length: { label: '长 L', min: 1 },
                width: { label: '宽 W', min: 1 },
                thickness: { label: '壁厚', min: 0.1 },
                cavityCount: { label: '模穴数', min: 1 },
                lifecycleQty: { label: '生命周期产量', min: 1 },
                wasteRate: { label: '废品率(%)', min: 0, max: 100 },
                partialRatio: { label: '供应商分摊(%)', min: 0, max: 100 },
                managementRate: { label: '管理费率(%)', min: 0, max: 200 },
                profitRate: { label: '利润率(%)', min: 0, max: 200 },
                taxRate: { label: '增值税率(%)', min: 0, max: 100 }
            }, {
                length: len, width: wid, thickness: thick, cavityCount: cavity,
                lifecycleQty: totalQty, wasteRate: wasteRatePct,
                partialRatio: numOf('partialRatio', 50),
                managementRate: numOf('managementRate', 12),
                profitRate: numOf('profitRate', 10),
                taxRate: numOf('taxRate', 13)
            });
            if (material.UnitPrice <= 0) {
                issues.push({ field: 'material', level: 'warn', message: '材料「' + material.MaterialCode + '」单价为 0，材料费将不计入。' });
            }

            // ---- 重量 ----
            var weightResult = calculatePartWeight();
            var partWeightG = weightResult.partWeight;
            var grossWeightG = weightResult.totalWeight * (1 + wasteRate);
            var netKg = partWeightG / 1000;
            var grossKg = grossWeightG / 1000;

            // ---- 设备选择：改用「首个满足吨位」的线性查找，超限时明确告警 ----
            var mold = buildMoldCost(len, wid, cavity);
            var projAreaCm2 = mold.projAreaCm2;
            var requiredTon = projAreaCm2 * 0.5 * cavity * 1.2;

            if (!equipmentDB.length) {
                UI.renderDiagnostics(diagEl, [{ level: 'error', message: '设备费率库为空。请检查参数库 equipment 表（assets/cost-db.js）。' }]);
                return;
            }
            var equipment = null;
            for (var i = 0; i < equipmentDB.length; i++) {
                if (requiredTon <= equipmentDB[i].maxForce) { equipment = equipmentDB[i]; break; }
            }
            var equipOverLimit = false;
            if (!equipment) {
                equipment = equipmentDB[equipmentDB.length - 1];
                equipOverLimit = true;
                issues.push({
                    field: 'equipment', level: 'warn',
                    message: '所需锁模力约 ' + Math.round(requiredTon) + 'T，超过费率库最大机型（' + equipment.tonnage + 'T），已按最大机型估算，结果偏乐观。'
                });
            }
            if (equipment.hourlyRate <= 0) {
                issues.push({ field: 'equipment', level: 'warn', message: '设备「' + equipment.name + '」小时费率为 0，加工费将不计入。' });
            }

            var cycle = thick <= 2.5 ? 40 : (thick <= 3.5 ? 60 : 80);
            // 人工费率优先级：费率预设 > 设备库自带 > 地区默认
            var regionLabor = { 华东: 35, 华南: 38, 华北: 32 };
            var laborRate = E.num(settings.laborRate) > 0
                ? E.num(settings.laborRate)
                : (equipment.laborRate !== undefined && equipment.laborRate > 0
                    ? equipment.laborRate
                    : (regionLabor[region] !== undefined ? regionLabor[region] : 35));
            // 设备费率系数：体现地区/自动化水平差异，不改动客户维护的设备库
            var equipmentRateFactor = E.num(settings.equipmentRateFactor, 1);
            var machineRate = equipment.hourlyRate * equipmentRateFactor;

            // ---- 模具分摊比例 ----
            var moldPayment = val('moldPayment', 'full_supplier');
            var supplierRatio = moldPayment === 'full_automaker' ? 0
                : (moldPayment === 'partial' ? numOf('partialRatio', 0) / 100 : 1);

            // ---- 用引擎组装成本表 ----
            var logiBlock = buildLogisticsBlock(partWeightG, totalQty);

            var sheet = E.buildSheet({
                material: {
                    grossWeightKg: grossKg,
                    netWeightKg: netKg,
                    unitPrice: material.UnitPrice,
                    scrapPrice: settings.scrapPrice,
                    scrapCredit: E.num(settings.scrapPrice) > 0
                },
                process: {
                    ops: [{
                        name: '注塑成型',
                        type: 'cycle',
                        cycleSec: cycle,
                        cavity: cavity,
                        machineRate: machineRate,
                        laborRate: laborRate
                    }]
                },
                tooling: {
                    totalToolPrice: mold.totalMoldPrice,
                    supplierShare: supplierRatio,
                    lifecycleQty: totalQty
                },
                surface: surface ? {
                    areaDm2: projAreaCm2 / 100,
                    unitPrice: surface.UnitPrice,
                    factor: surface.ThicknessFactor,
                    yield: surface.Yield
                } : null,
                logistics: logiBlock,
                overhead: {
                    managementRate: settings.managementRate,
                    profitRate: settings.profitRate,
                    taxRate: settings.taxRate,
                    paymentDays: settings.paymentDays,
                    capitalRate: settings.capitalRate,
                    jitFactor: jitFactorFromForm()
                }
            });

            lastSheet = sheet;
            sheet.meta = {
                partName: val('partName', '未命名零件'),
                region: region,
                material: material.MaterialCode,
                materialPrice: material.UnitPrice,
                cavity: cavity,
                cycleSec: cycle,
                equipment: equipment.name,
                requiredTon: requiredTon,
                partWeightG: partWeightG,
                grossWeightG: grossWeightG,
                runnerWeightG: weightResult.totalWeight - partWeightG,
                weightMethod: weightResult.method,
                wasteRate: wasteRate,
                mold: mold,
                supplierRatio: supplierRatio,
                laborRate: laborRate,
                logisticsLabel: LOGISTICS_LABEL[val('logisticsModel', 'general')] || ''
            };

            // ---- 输出 ----
            UI.renderDiagnostics(diagEl, issues.concat(sheet.diagnostics));

            el('totalCostVal').innerHTML = E.money(sheet.totalCost) + ' 元';
            el('quotePriceVal').innerHTML = E.money(sheet.quotePrice) + ' 元';

            var matBlock = sheet.blockMap.material;
            var procBlock = sheet.blockMap.process;
            var toolBlock = sheet.blockMap.tooling;
            var surfBlock = sheet.blockMap.surface;
            var logiOut = sheet.blockMap.logistics;

            el('weightDetail').innerHTML = '⚖️ 重量(' + (weightResult.method === 'manual' ? '精确输入' : '几何估算') + ')'
                + ' | 净重: ' + partWeightG.toFixed(1) + 'g'
                + ' | 含料把: ' + weightResult.totalWeight.toFixed(1) + 'g'
                + ' | 含废品投料: ' + grossWeightG.toFixed(1) + 'g'
                + ' | 废品率: ' + wasteRatePct.toFixed(1) + '%'
                + ' | 材料: ' + material.UnitPrice + '元/kg'
                + ' | 材料利用率: ' + E.pct(matBlock.detail.utilization, 0);

            el('techDetails').innerHTML = '📐 投影面积: ' + projAreaCm2.toFixed(1) + 'cm²'
                + ' | 模穴数: ' + cavity
                + ' | 成型周期: ' + cycle + 's'
                + ' | 单件加工费: ' + E.money(procBlock.cost, 3) + '元';

            el('equipAdvice').innerHTML = '🖥️ 推荐设备: ' + equipment.tonnage + '吨'
                + '（需求 ' + Math.round(requiredTon) + '吨）'
                + ' | 机时费率: ' + E.money(machineRate, 1) + '元/h'
                + (equipmentRateFactor !== 1 ? '（基准 ' + equipment.hourlyRate + ' × ' + equipmentRateFactor.toFixed(2) + '）' : '')
                + ' + 人工 ' + laborRate + '元/h'
                + (equipOverLimit ? ' ⚠️ 已超费率库上限' : '');

            el('moldCostDetail').innerHTML = '🔧 模具总价: ' + Math.round(mold.totalMoldPrice).toLocaleString() + '元'
                + (mold.moldPriceFactor !== 1
                    ? '（明细合计 ' + Math.round(mold.totalBeforeFactor).toLocaleString() + ' × ' + mold.moldPriceFactor.toFixed(2) + '）'
                    : '')
                + ' | 供应商承担 ' + E.pct(supplierRatio, 0)
                + ' | 单件分摊: ' + E.money(toolBlock.cost, 3) + '元'
                + '<br>明细：模架 ' + Math.round(mold.moldBaseCost).toLocaleString()
                + ' + 型腔 ' + Math.round(mold.cavityCost).toLocaleString()
                + ' + 滑块 ' + Math.round(mold.slideCost).toLocaleString()
                + ' + 斜顶 ' + Math.round(mold.lifterCost).toLocaleString()
                + ' + 热流道 ' + Math.round(mold.hotRunnerCost).toLocaleString()
                + ' + 设计试模 ' + E.pct(mold.designTrialRate, 0)
                + '，按寿命 ' + mold.moldLife.toLocaleString() + ' 模次修正';

            el('logisticsDetail').innerHTML = '🚚 物流模式: ' + (LOGISTICS_LABEL[val('logisticsModel', 'general')] || '')
                + ' | 单件运费: ' + E.money(logiOut.detail.freightCost, 3) + '元';

            var packTypeText = '';
            var packSel = el('packagingType');
            if (packSel && packSel.options[packSel.selectedIndex]) packTypeText = packSel.options[packSel.selectedIndex].text;
            el('packagingDetail').innerHTML = '📦 包装: ' + packTypeText
                + ' | 包装+EDI: ' + E.money(logiOut.detail.packagingCost + logiOut.detail.ediPerPart, 3) + '元/件';

            var items = E.displayItems(sheet);
            el('costDetails').innerHTML = items.map(function (it) {
                return '<div class="cost-card"><span>' + E.escapeHtml(it.name) + '</span><span>' + E.money(it.val) + '元</span></div>';
            }).join('');

            E.pieChart(el('costChart'), items);

        } catch (e) {
            console.error(e);
            UI.renderDiagnostics(el('diagnostics'), [{ level: 'error', message: '计算失败：' + e.message }]);
        }
    }

    /* =====================================================================
     * 7. 导出 Excel（此前落地页宣传但实际缺失，本次补上）
     * ===================================================================== */

    function exportExcel() {
        if (!lastSheet) {
            UI.toast('请先完成一次测算', 'error');
            return;
        }
        var s = lastSheet;
        var m = s.meta;
        var watermark = '零件：' + m.partName + ' | 基地：' + m.region + ' | 生成时间：' + new Date().toLocaleString()
            + ' | 引擎 v' + E.VERSION + ' / 参数库 v' + DB.VERSION;

        var summary = [['成本项', '金额(元/件)', '占完全成本比']];
        s.blocks.forEach(function (b) {
            summary.push([b.name, E.round(b.cost, 4), s.totalCost > 0 ? E.pct(b.cost / s.totalCost) : '-']);
        });
        summary.push(['完全成本', s.totalCost, '100.0%']);
        summary.push(['含税报价', s.quotePrice, '']);
        summary.push(['增值税率', E.pct(s.overhead.taxRate), '']);
        summary.push(['税额', E.round(s.overhead.taxAmount, 4), '']);

        var params = [
            ['参数', '值'],
            ['零件名称', m.partName],
            ['生产基地', m.region],
            ['材料牌号', m.material],
            ['材料单价(元/kg)', m.materialPrice],
            ['重量计算方式', m.weightMethod === 'manual' ? '精确输入' : '几何估算'],
            ['零件净重(g)', E.round(m.partWeightG, 2)],
            ['含料把重量(g)', E.round(m.grossWeightG, 2)],
            ['废品率(%)', E.round(m.wasteRate * 100, 2)],
            ['材料利用率', E.pct(s.blockMap.material.detail.utilization, 1)],
            ['模穴数', m.cavity],
            ['成型周期(s)', m.cycleSec],
            ['推荐设备', m.equipment],
            ['需求锁模力(T)', E.round(m.requiredTon, 1)],
            ['机时费率(元/h)', s.blockMap.process.detail.ops[0] ? E.round(s.blockMap.process.detail.ops[0].cost > 0 ? 0 : 0) : 0],
            ['人工费率(元/h)', m.laborRate],
            ['模具总价(元)', E.round(m.mold.totalMoldPrice, 2)],
            ['模具供应商分摊', E.pct(m.supplierRatio, 0)],
            ['模具寿命(模次)', m.mold.moldLife],
            ['管理费率', E.pct(s.overhead.managementRate)],
            ['利润率', E.pct(s.overhead.profitRate)],
            ['物流模式', m.logisticsLabel],
            ['交付系数(JIT等)', s.overhead.jitFactor]
        ];

        var detail = [['成本块', '计算明细']];
        s.blocks.forEach(function (b) {
            if (b.key === 'process' && b.detail.ops) {
                b.detail.ops.forEach(function (op) { detail.push([b.name + ' · ' + op.name, op.note + ' = ' + E.money(op.cost, 4) + ' 元']); });
            } else if (b.key === 'material') {
                var d = b.detail;
                detail.push(['材料费', '毛重 ' + d.grossKg + 'kg × ' + d.unitPrice + ' 元/kg = ' + E.money(d.grossCost, 4) + ' 元']);
                detail.push(['废料回收', '废料 ' + d.scrapKg + 'kg × 回收价 = ' + E.money(d.scrapValue, 4) + ' 元']);
            } else if (b.key === 'tooling') {
                detail.push(['模具分摊', E.money(b.detail.totalToolPrice, 2) + ' × ' + E.pct(b.detail.supplierShare, 0) + ' ÷ ' + b.detail.lifecycleQty + ' 件 = ' + E.money(b.cost, 4) + ' 元']);
            } else if (b.key === 'surface') {
                detail.push(['表面处理', b.detail.areaDm2 + 'dm² × ' + b.detail.unitPrice + ' 元/dm² × ' + b.detail.factor + ' ÷ 良率 ' + b.detail.yield]);
            } else if (b.key === 'logistics') {
                detail.push(['运费', '单件 ' + E.money(b.detail.freightCost, 4) + ' 元']);
                detail.push(['包装+EDI', '单件 ' + E.money(b.detail.packagingCost + b.detail.ediPerPart, 4) + ' 元']);
            } else if (b.key === 'overhead') {
                var o = b.detail;
                detail.push(['管理费', E.money(o.management, 4) + ' 元']);
                detail.push(['利润', E.money(o.profit, 4) + ' 元']);
                detail.push(['交付方式加成', E.money(o.jitUplift, 4) + ' 元']);
            }
        });

        try {
            E.exportXls('注塑件成本报告_' + m.partName + '_' + E.timestamp() + '.xls', [
                { name: '成本汇总', title: '注塑件成本测算报告', watermark: watermark, rows: summary },
                { name: '测算参数', rows: params },
                { name: '计算明细', rows: detail }
            ]);
            UI.toast('Excel 报告已导出', 'success');
        } catch (e2) {
            UI.toast('导出失败：' + e2.message, 'error', 4000);
        }
    }

    /* =====================================================================
     * 8. 材料 / 表面处理 编辑
     * ===================================================================== */

    function openMaterialEditModal(id) {
        var m = materialsData.filter(function (x) { return x.id === id; })[0];
        if (!m) return;
        currentMaterialId = id;
        el('materialCode').value = m.MaterialCode;
        el('materialDensity').value = m.Density;
        el('materialPrice').value = m.UnitPrice;
        el('materialModalTitle').innerText = '编辑材料';
        el('deleteMaterialBtn').style.display = 'inline-flex';
        el('materialModal').style.display = 'flex';
    }

    function deleteMaterialById(id) {
        if (!confirm('确定删除该材料吗？')) return;
        materialsData = materialsData.filter(function (m) { return m.id !== id; });
        if (!materialsData.length) {
            materialsData.push({ id: DB.genId('mat'), MaterialCode: 'PP+EPDM-T20', Density: 1.05, UnitPrice: 8.5 });
        }
        saveMaterials();
        closeMaterialModal();
    }

    function saveMaterial() {
        var code = el('materialCode').value.trim();
        var density = parseFloat(el('materialDensity').value);
        var price = parseFloat(el('materialPrice').value);
        if (!code) { alert('请填写材料代码'); return; }
        if (!isFinite(density) || density <= 0) { alert('请填写有效密度（>0）'); return; }
        if (!isFinite(price) || price < 0) { alert('请填写有效单价（≥0）'); return; }

        var view = { MaterialCode: code, Density: density, UnitPrice: price };
        if (currentMaterialId) {
            var idx = -1;
            for (var i = 0; i < materialsData.length; i++) if (materialsData[i].id === currentMaterialId) { idx = i; break; }
            if (idx >= 0) { view.id = currentMaterialId; materialsData[idx] = view; }
        } else {
            view.id = DB.genId('mat');
            materialsData.push(view);
        }
        saveMaterials();
        closeMaterialModal();
        UI.toast('材料已保存到参数库', 'success');
    }

    function openNewMaterialModal() {
        currentMaterialId = null;
        el('materialCode').value = '';
        el('materialDensity').value = '';
        el('materialPrice').value = '';
        el('materialModalTitle').innerText = '新增材料';
        el('deleteMaterialBtn').style.display = 'none';
        el('materialModal').style.display = 'flex';
    }

    function closeMaterialModal() {
        el('materialModal').style.display = 'none';
        currentMaterialId = null;
    }

    function openSurfaceEditModal(id) {
        var s = surfaceData.filter(function (x) { return x.id === id; })[0];
        if (!s) return;
        currentSurfaceId = id;
        el('surfaceName').value = s.ProcessName;
        el('surfacePrice').value = s.UnitPrice;
        el('surfaceFactor').value = s.ThicknessFactor;
        el('surfaceModalTitle').innerText = '编辑表面处理';
        el('deleteSurfaceBtn').style.display = 'inline-flex';
        el('surfaceModal').style.display = 'flex';
    }

    function deleteSurfaceById(id) {
        if (!confirm('确定删除该表面处理工艺吗？')) return;
        surfaceData = surfaceData.filter(function (s) { return s.id !== id; });
        if (!surfaceData.length) {
            surfaceData.push({ id: DB.genId('surf'), ProcessName: '钢琴漆', UnitPrice: 1.25, ThicknessFactor: 1.2, Yield: 1 });
        }
        saveSurface();
        closeSurfaceModal();
    }

    function saveSurfaceItem() {
        var name = el('surfaceName').value.trim();
        var price = parseFloat(el('surfacePrice').value);
        var factor = parseFloat(el('surfaceFactor').value);
        if (!name) { alert('请填写工艺名称'); return; }
        if (!isFinite(price) || price < 0) { alert('请填写有效单价'); return; }
        if (!isFinite(factor) || factor <= 0) { alert('请填写有效厚度系数（>0）'); return; }

        var view = { ProcessName: name, UnitPrice: price, ThicknessFactor: factor, Yield: 1 };
        if (currentSurfaceId) {
            var idx = -1;
            for (var i = 0; i < surfaceData.length; i++) if (surfaceData[i].id === currentSurfaceId) { idx = i; break; }
            if (idx >= 0) { view.id = currentSurfaceId; view.Yield = surfaceData[idx].Yield; surfaceData[idx] = view; }
        } else {
            view.id = DB.genId('surf');
            surfaceData.push(view);
        }
        saveSurface();
        closeSurfaceModal();
        UI.toast('表面处理已保存到参数库', 'success');
    }

    function openNewSurfaceModal() {
        currentSurfaceId = null;
        el('surfaceName').value = '';
        el('surfacePrice').value = '';
        el('surfaceFactor').value = '';
        el('surfaceModalTitle').innerText = '新增表面处理';
        el('deleteSurfaceBtn').style.display = 'none';
        el('surfaceModal').style.display = 'flex';
    }

    function closeSurfaceModal() {
        el('surfaceModal').style.display = 'none';
        currentSurfaceId = null;
    }

    /* =====================================================================
     * 9. 事件绑定
     * ===================================================================== */

    function setupGlobalDelegation() {
        document.body.addEventListener('click', function (e) {
            var t = e.target;
            var btn = t.closest ? t.closest('.action-btn') : null;
            if (!btn && t.classList && t.classList.contains('action-btn')) btn = t;
            if (!btn && t.parentElement && t.parentElement.classList && t.parentElement.classList.contains('action-btn')) btn = t.parentElement;
            if (!btn) return;

            e.preventDefault();
            var type = btn.getAttribute('data-type');
            var id = btn.getAttribute('data-id');
            if (type === 'material') {
                if (btn.classList.contains('edit-btn')) openMaterialEditModal(id);
                else if (btn.classList.contains('delete-btn')) deleteMaterialById(id);
            } else if (type === 'surface') {
                if (btn.classList.contains('edit-btn')) openSurfaceEditModal(id);
                else if (btn.classList.contains('delete-btn')) deleteSurfaceById(id);
            }
        });
    }

    function bindEvents() {
        el('calcBtn').onclick = calculate;

        // 修复：原来「重置」会 localStorage.clear() 把两个工具的参数库一起清空
        el('resetBtn').onclick = function () {
            if (!confirm('重置将恢复本页的默认材料/表面处理数据，并清除本页输入。\n\n（不会影响冲压件的数据）\n\n确认继续？')) return;
            MAT_TABLE.replaceAll(MAT_TABLE.all().filter(function (r) {
                return r.kind === 'sheet';
            }));
            DB.table('surface').reset();
            loadData();
            calculate();
            UI.toast('已恢复默认参数', 'success');
        };

        el('resetSettingsBtn').onclick = function () {
            if (!confirm('恢复默认费率（管理费 12% / 利润 10% / 税 13%）？')) return;
            settings = DB.settings('injection').reset();
            applySettingsToForm();
            calculate();
            UI.toast('费率已恢复默认', 'success');
        };

        el('exportExcelBtn').onclick = exportExcel;

        el('weightMethod').onchange = function () {
            var method = el('weightMethod').value;
            el('netWeightGroup').style.display = method === 'manual' ? 'block' : 'none';
            el('estimateGroup').style.display = method === 'estimate' ? 'block' : 'none';
            calculate();
        };
        el('moldPayment').onchange = function () {
            el('partialRatioGroup').style.display = el('moldPayment').value === 'partial' ? 'block' : 'none';
            calculate();
        };
        el('logisticsModel').onchange = function () {
            var model = el('logisticsModel').value;
            el('generalGroup').style.display = model === 'general' ? 'block' : 'none';
            el('directGroup').style.display = model === 'direct' ? 'block' : 'none';
            el('milkrunGroup').style.display = model === 'milkrun' ? 'block' : 'none';
            el('rdcGroup').style.display = model === 'rdc' ? 'block' : 'none';
            calculate();
        };
        el('packagingType').onchange = function () {
            el('packagingCostGroup').style.display = el('packagingType').value === 'custom' ? 'block' : 'none';
            calculate();
        };
        el('volumetricStandard').onchange = function () {
            el('customVolFactorDiv').style.display = el('volumetricStandard').value === 'custom' ? 'block' : 'none';
            calculate();
        };

        var autoIds = ['length', 'width', 'height', 'thickness', 'cavityCount', 'lifecycleQty', 'partialRatio',
            'netWeight', 'wasteRate', 'materialSelect', 'region', 'surfaceProcess', 'surfaceGrade',
            'moldBaseType', 'cavityComplex', 'slideMedium', 'lifterMedium', 'hotRunnerPoints', 'hotRunnerBrand',
            'logisticsDistance', 'billingMode', 'lifeRequirement', 'truckType', 'milkrunSupplierCount',
            'milkrunTotalCost', 'milkrunPartsPerTrip', 'rdcInboundFee', 'rdcLineFeedFee', 'rdcStorageFee',
            'rdcInventoryDays', 'packagingAmortize', 'emptyReturn', 'deliveryRequirement', 'ediFee',
            'volumetricFactor', 'runnerWeight', 'partGeometry', 'thicknessUniformity',
            'managementRate', 'profitRate', 'taxRate', 'scrapPrice', 'paymentDays', 'capitalRate', 'partName'];
        autoIds.forEach(function (id) {
            var n = el(id);
            if (!n) return;
            n.addEventListener('input', calculate);
            if (n.tagName === 'SELECT') n.addEventListener('change', calculate);
        });

        // 模态框
        el('openMaterialModalBtn').onclick = openNewMaterialModal;
        el('openSurfaceModalBtn').onclick = openNewSurfaceModal;
        el('saveMaterialBtn').onclick = saveMaterial;
        el('saveSurfaceBtn').onclick = saveSurfaceItem;
        el('deleteMaterialBtn').onclick = function () { if (currentMaterialId) deleteMaterialById(currentMaterialId); };
        el('deleteSurfaceBtn').onclick = function () { if (currentSurfaceId) deleteSurfaceById(currentSurfaceId); };
        el('closeMaterialModalBtn').onclick = closeMaterialModal;
        el('closeSurfaceModalBtn').onclick = closeSurfaceModal;
        el('cancelMaterialBtn').onclick = closeMaterialModal;
        el('cancelSurfaceBtn').onclick = closeSurfaceModal;

        // 反馈：不再假装有后端。弹窗整理内容 → 用户通过 cost-config.js 配置的渠道发出
        el('feedbackBtn').onclick = function () {
            UI.openFeedbackDialog({
                subjectPrefix: '[注塑件成本模型反馈]',
                context: UI.buildContext({
                    '页面': '注塑件成本模型',
                    '零件': val('partName', ''),
                    '材料': val('materialSelect', ''),
                    '参数库材料数': materialsData.length
                })
            });
        };
        el('viewFeedbackBtn').onclick = UI.viewFeedback;

        window.onclick = function (event) {
            if (event.target === el('materialModal')) closeMaterialModal();
            if (event.target === el('surfaceModal')) closeSurfaceModal();
        };
    }

    /* =====================================================================
     * 10. 初始化
     * ===================================================================== */

    function init() {
        // 旧版 localStorage 数据迁移到参数库（幂等，只跑一次）
        var mig = DB.migrateLegacy();
        if (mig.migrated) {
            setTimeout(function () { UI.toast('已把旧版数据迁移到新参数库，共 ' + mig.detail.length + ' 项', 'success', 3600); }, 400);
        }

        loadData();
        bindEvents();
        setupGlobalDelegation();
        UI.mountBackupButtons(el('backupButtons'), {
            exportName: '成本参数库备份',
            onImported: function () { loadData(); calculate(); UI.toast('参数库已更新', 'success'); }
        });

        // 费率预设：选一个档位，整套费率跟着切换（不改动参数库）
        UI.mountPresetPicker(el('presetPicker'), {
            scope: 'injection',
            onApplied: function () { loadData(); calculate(); }
        });

        // 材料价格批量导入：让客户 3 分钟自己刷新价格，不依赖作者维护
        el('importPriceBtn').onclick = function () {
            UI.openPriceImport({
                table: 'materials',
                codeField: 'code',
                priceField: 'unitPrice',
                codeLabel: '材料牌号',
                priceLabel: '材料单价(元/kg)',
                newKind: 'polymer',
                newDensity: 1.05,
                onDone: function () { loadData(); calculate(); }
            });
        };

        // 触发初始显示状态
        el('weightMethod').dispatchEvent(new Event('change'));
        el('moldPayment').dispatchEvent(new Event('change'));
        el('logisticsModel').dispatchEvent(new Event('change'));
        el('packagingType').dispatchEvent(new Event('change'));
        el('volumetricStandard').dispatchEvent(new Event('change'));

        calculate();
    }

    /* =====================================================================
     * 11. 对外接口（便于自动化测试与后续嵌入/二次开发）
     * ===================================================================== */
    window.CostApp = {
        version: '2.0.0',
        page: 'injection',
        calculate: calculate,
        exportExcel: exportExcel,
        exportBackup: UI.exportBackup,
        importBackup: UI.importBackup,
        loadData: loadData,
        materials: function () { return materialsData; },
        lastSheet: function () { return lastSheet; }
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
}());
