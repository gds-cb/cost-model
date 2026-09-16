        // ==================== 引擎与参数库 ====================
        const E = window.CostEngine;
        const DB = window.CostDB;
        const UI = window.CostUI;

        // 参数库视图：真正的数据存在 costdb_v1_* 中（可备份 / 可迁移 / 可版本化）
        let stampingMaterialsData = [];   // 金属板材视图 {id, MaterialCode, Type, Spec, Thickness, Density, UnitPrice}
        let equipmentData = [];           // 冲压设备视图 {id, tonnage, hourlyRate, spm}

        let bomTree = [];
        let weldRelations = [];
        let currentEditingNodeId = null;
        let historyList = [];
        let feedbackList = [];
        let lastStampingSheet = null;

        const MAT_TABLE = DB.table('materials');
        const EQ_TABLE = DB.table('equipment');
        const CASE_TABLE = DB.table('cases');

        function generateId() { return DB.genId('st'); }

        /* ---------- 参数库 ⇄ 页面视图 适配 ---------- */
        function matToView(r) {
            return { id: r.id, MaterialCode: r.code, Type: r.category || '', Spec: r.spec || '', Thickness: r.thickness, Density: r.density, UnitPrice: r.unitPrice };
        }
        function matFromView(v) {
            return { id: v.id, code: v.MaterialCode, kind: 'sheet', category: v.Type, spec: v.Spec, thickness: v.Thickness, density: v.Density, unitPrice: v.UnitPrice, updatedAt: DB.today(), source: '页面录入' };
        }
        function eqToView(r) { return { id: r.id, tonnage: r.tonnage, hourlyRate: r.hourlyRate, spm: r.spm }; }
        function eqFromView(v) {
            return { id: v.id, name: '冲压线 ' + v.tonnage + 'T', kind: 'stamping', tonnage: v.tonnage, hourlyRate: v.hourlyRate, spm: v.spm, updatedAt: DB.today(), source: '页面录入' };
        }
        function caseToView(r) {
            return { id: r.id, name: r.name, category: r.category, material: r.material, thickness: r.thickness, length: r.length, width: r.width, processes: r.processes || [] };
        }
        function caseFromView(v) {
            return { id: v.id, name: v.name, category: v.category, material: v.material, thickness: v.thickness, length: v.length, width: v.width, processes: v.processes || [], updatedAt: DB.today(), source: '页面录入' };
        }

        // 存储与加载
        function loadStorage() {
            stampingMaterialsData = MAT_TABLE.all().filter(r => r.kind === 'sheet').map(matToView);
            equipmentData = EQ_TABLE.all()
                .filter(e => e.kind === 'stamping' && E.num(e.tonnage) > 0)
                .sort((a, b) => a.tonnage - b.tonnage)
                .map(eqToView);
            caseLibrary = CASE_TABLE.all().map(caseToView);

            bomTree = DB.state('bomTree') || [];
            weldRelations = DB.state('weldRelations') || [];
            historyList = DB.state('history') || [];
            feedbackList = DB.state('feedback') || [];

            const s = DB.settings('stamping').get();
            const setV = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined && v !== null) el.value = v; };
            setV('diePricePerKg', s.diePricePerKg);
            setV('scrapPrice', s.scrapPrice);
            setV('ratePerTonKm', s.ratePerTonKm);
            setV('minFreight', s.minFreight);
            setV('handlingFee', s.handlingFee);
            setV('mgmtRate', E.round(s.managementRate * 100, 2));
            setV('profitRate', E.round(s.profitRate * 100, 2));
            setV('taxRate', E.round(s.taxRate * 100, 2));
            setV('blankUtilization', s.blankUtilization);

            if (!bomTree.length) loadSampleBom();
        }

        function readStampingSettings() {
            const g = (id, d) => { const el = document.getElementById(id); return el ? E.num(el.value, d) : d; };
            const stored = DB.settings('stamping').get();
            return {
                preset: stored.preset,
                laborRate: stored.laborRate,
                equipmentRateFactor: E.num(stored.equipmentRateFactor, 1),
                moldPriceFactor: E.num(stored.moldPriceFactor, 1),
                blankUtilization: g('blankUtilization', 75),
                diePricePerKg: g('diePricePerKg', 25),
                scrapPrice: g('scrapPrice', 2.0),
                ratePerTonKm: g('ratePerTonKm', 0.5),
                minFreight: g('minFreight', 300),
                handlingFee: g('handlingFee', 0.5),
                managementRate: g('mgmtRate', 12) / 100,
                profitRate: g('profitRate', 10) / 100,
                taxRate: g('taxRate', 13) / 100,
                scrapAccountingMethod: (document.getElementById('scrapAccountingMethod') || {}).value || 'deduct'
            };
        }

        function saveAll() {
            // 参数库：只同步板材与冲压设备，绝不触碰注塑件共用的塑料数据与注塑机型
            const before = MAT_TABLE.all();
            const keep = {};
            stampingMaterialsData.forEach(v => { const r = matFromView(v); MAT_TABLE.upsert(r); keep[r.id] = true; });
            before.filter(r => r.kind === 'sheet' && !keep[r.id]).forEach(r => MAT_TABLE.remove(r.id));

            const eqBefore = EQ_TABLE.all();
            const eqKeep = {};
            equipmentData.forEach(v => { const r = eqFromView(v); EQ_TABLE.upsert(r); eqKeep[r.id] = true; });
            eqBefore.filter(r => r.kind === 'stamping' && !eqKeep[r.id]).forEach(r => EQ_TABLE.remove(r.id));

            CASE_TABLE.importRows(caseLibrary.map(caseFromView), 'replace');

            DB.state('bomTree', bomTree);
            DB.state('weldRelations', weldRelations);
            DB.state('history', historyList);
            DB.settings('stamping').set(readStampingSettings());
        }
        function showToast(msg, err = false) { let t = document.createElement('div'); t.className = 'toast'; t.style.background = err ? '#dc2626' : '#1e293b'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3000); }

        function loadSampleBom() {
            bomTree = [
                {
                    id: generateId(), name: "主骨架", qty: 1, materialId: "dc01", thickness: 1.2, length: 800, width: 500, height: 100, blankLen: 850, blankWid: 550,
                    processes: [{ name: "落料", tonnage: 400, dieWeight: 1500, strokes: 1 }, { name: "冲孔", tonnage: 250, dieWeight: 800, strokes: 2 }, { name: "拉伸", tonnage: 630, dieWeight: 2000, strokes: 1 }],
                    children: [
                        {
                            id: generateId(), name: "左加强板", qty: 2, materialId: "dc01", thickness: 1.0, length: 400, width: 100, height: 20, blankLen: 420, blankWid: 120,
                            processes: [{ name: "落料", tonnage: 250, dieWeight: 600, strokes: 1 }, { name: "冲孔", tonnage: 160, dieWeight: 400, strokes: 2 }], children: []
                        },
                        {
                            id: generateId(), name: "右加强板", qty: 2, materialId: "dc01", thickness: 1.0, length: 400, width: 100, height: 20, blankLen: 420, blankWid: 120,
                            processes: [{ name: "落料", tonnage: 250, dieWeight: 600, strokes: 1 }, { name: "冲孔", tonnage: 160, dieWeight: 400, strokes: 2 }], children: []
                        }
                    ]
                }
            ];
            weldRelations = [
                { fromPartId: bomTree[0].id, toPartId: bomTree[0].children[0].id, weldType: "spot", spotCount: 4, lengthMm: 0 },
                { fromPartId: bomTree[0].id, toPartId: bomTree[0].children[1].id, weldType: "spot", spotCount: 4, lengthMm: 0 }
            ];
            saveAll();
        }

        /**
         * 计算单件重量。
         * 返回 { netG: 净重(零件本体), grossG: 下料毛重, utilization: 材料利用率 }
         *
         * 修复：原实现把「下料毛重」直接当成「单件净重」显示和计费，口径混乱。
         * 现在明确区分：材料按毛重采购计费，废料按 (毛重 − 净重) 回收。
         * 净重 = 毛重 × 材料利用率（取全局「下料利用率」输入，可用 node.utilization 覆盖）。
         */
        function calcNodeWeight(node, density) {
            const t = E.num(node.thickness, 1);
            const blankLen = E.num(node.blankLen, 0);
            const blankWid = E.num(node.blankWid, 0);
            let grossG, netG, source;

            if (blankLen > 0 && blankWid > 0) {
                grossG = (blankLen * blankWid * t) / 1000 * density;
                const utilEl = document.getElementById('blankUtilization');
                const globalUtil = E.num(utilEl ? utilEl.value : null, 75) / 100;
                const util = E.num(node.utilization, globalUtil);
                netG = grossG * Math.min(1, Math.max(0.05, util));
                source = 'blank';
            } else {
                // 没有下料尺寸时，只能按外廓 × 填充系数估算，此时不虚构利用率
                grossG = (E.num(node.length) * E.num(node.width) * t) / 1000 * 0.6 * density;
                netG = grossG;
                source = 'geometry';
            }
            return { netG: netG, grossG: grossG, source: source, utilization: grossG > 0 ? netG / grossG : 0 };
        }

        /** 兼容旧调用：返回下料毛重（材料计费口径） */
        function calculatePartWeight(node) {
            const mat = stampingMaterialsData.find(m => m.id === node.materialId);
            return calcNodeWeight(node, mat ? mat.Density : 7.85).grossG;
        }

        // ========== BOM 渲染 ==========
        function renderBomTree() {
            let container = document.getElementById('bomTreeContainer');
            if (!container) return;
            let html = `<table class="bom-tree-table" style="min-width:1200px">
        <thead><tr>
            <th style="width:15%">零件名称</th><th>数量</th><th>材料</th>
            <th>厚(mm)</th>
            <th>外廓长(mm)</th><th>外廓宽(mm)</th><th>外廓高(mm)</th>
            <th>下料长(mm)</th><th>下料宽(mm)</th>
            <th>净重(g)</th><th>下料毛重(g)</th><th>利用率</th><th>操作</th>
        </tr></thead><tbody>`;
            function renderNodes(nodes, level) {
                for (let node of nodes) {
                    let indent = level * 24;
                    let indentHtml = `<span style="display:inline-block; width:${indent}px;"></span>`;
                    let materialOpts = stampingMaterialsData.map(m => `<option value="${m.id}" ${node.materialId === m.id ? 'selected' : ''}>${m.MaterialCode}</option>`).join('');
                    let nodeMat = stampingMaterialsData.find(m => m.id === node.materialId);
                    let w = calcNodeWeight(node, nodeMat ? E.num(nodeMat.Density, 7.85) : 7.85);
                    html += `<tr data-id="${node.id}">
                <td style="text-align:left"><div style="display:flex;align-items:center;">${indentHtml}${level > 0 ? '↳' : ''}<input type="text" value="${escapeHtml(node.name)}" class="bom-name" style="margin-left:4px; width:calc(100% - 24px);"></div></td>
                <td><input type="number" value="${node.qty}" class="bom-qty" step="1" style="width:60px;"></td>
                <td><select class="bom-material" style="width:110px;">${materialOpts}</select></td>
                <td><input type="number" value="${node.thickness}" class="bom-thickness" step="0.1" style="width:70px;"></td>
                <td><input type="number" value="${node.length}" class="bom-length" step="10" style="width:70px;"></td>
                <td><input type="number" value="${node.width}" class="bom-width" step="10" style="width:70px;"></td>
                <td><input type="number" value="${node.height || 0}" class="bom-height" step="10" style="width:70px;"></td>
                <td><input type="number" value="${node.blankLen || 0}" class="bom-blank-len" step="10" style="width:80px;"></td>
                <td><input type="number" value="${node.blankWid || 0}" class="bom-blank-wid" step="10" style="width:80px;"></td>
                <td><span class="part-weight-display">${w.netG.toFixed(1)}</span></td>
                <td><span style="color:#94a3b8;">${w.grossG.toFixed(1)}</span></td>
                <td><span style="color:#94a3b8;">${(w.utilization * 100).toFixed(0)}%</span></td>
                <td style="white-space: nowrap;">
                    <button class="small outline edit-process" data-id="${node.id}">⚙️工序</button>
                    <button class="small outline add-child" data-id="${node.id}">+子件</button>
                    <button class="small danger delete-node" data-id="${node.id}">删</button>
                </td>
            </tr>`;
                    if (node.children && node.children.length) renderNodes(node.children, level + 1);
                }
            }
            renderNodes(bomTree, 0);
            html += '</tbody></table>';
            container.innerHTML = html;
            // 绑定事件
            function bindInput(selector, field, isNumber = false) {
                document.querySelectorAll(selector).forEach(el => {
                    let tr = el.closest('tr'); if (!tr) return;
                    let id = tr.dataset.id;
                    el.addEventListener('change', () => {
                        let val = isNumber ? parseFloat(el.value) : el.value;
                        updateNodeField(id, field, val);
                    });
                });
            }
            bindInput('#bomTreeContainer .bom-name', 'name');
            bindInput('#bomTreeContainer .bom-qty', 'qty', true);
            bindInput('#bomTreeContainer .bom-thickness', 'thickness', true);
            bindInput('#bomTreeContainer .bom-length', 'length', true);
            bindInput('#bomTreeContainer .bom-width', 'width', true);
            bindInput('#bomTreeContainer .bom-height', 'height', true);
            bindInput('#bomTreeContainer .bom-blank-len', 'blankLen', true);
            bindInput('#bomTreeContainer .bom-blank-wid', 'blankWid', true);
            document.querySelectorAll('#bomTreeContainer .bom-material').forEach(el => {
                let tr = el.closest('tr'); let id = tr.dataset.id;
                el.addEventListener('change', () => { updateNodeField(id, 'materialId', el.value); renderBomTree(); calculate(); });
            });
            document.querySelectorAll('#bomTreeContainer .edit-process').forEach(btn => btn.onclick = () => openProcessEditor(btn.dataset.id));
            document.querySelectorAll('#bomTreeContainer .add-child').forEach(btn => btn.onclick = () => addChildNode(btn.dataset.id));
            document.querySelectorAll('#bomTreeContainer .delete-node').forEach(btn => btn.onclick = () => deleteNode(btn.dataset.id));
        }
        function findNodeById(nodes, id) {
            for (let node of nodes) {
                if (node.id === id) return node;
                if (node.children) { let found = findNodeById(node.children, id); if (found) return found; }
            }
            return null;
        }
        function updateNodeField(id, field, value) {
            let node = findNodeById(bomTree, id);
            if (node) { node[field] = value; saveAll(); renderBomTree(); calculate(); }
        }
        function addChildNode(parentId) {
            let parent = findNodeById(bomTree, parentId);
            if (parent) {
                let newNode = {
                    id: generateId(), name: "新零件", qty: 1, materialId: stampingMaterialsData[0].id,
                    thickness: 1.0, length: 100, width: 100, height: 50, blankLen: 110, blankWid: 110,
                    processes: [{ name: "落料", tonnage: 160, dieWeight: 500, strokes: 1 }], children: []
                };
                if (!parent.children) parent.children = [];
                parent.children.push(newNode);
                saveAll(); renderBomTree(); calculate();
                showToast("已添加子零件");
            }
        }
        function deleteNode(id) {
            let removeFromArray = (arr) => {
                for (let i = 0; i < arr.length; i++) {
                    if (arr[i].id === id) { arr.splice(i, 1); return true; }
                    if (arr[i].children && removeFromArray(arr[i].children)) return true;
                }
                return false;
            };
            if (confirm("删除零件及其所有子零件？")) {
                removeFromArray(bomTree);
                weldRelations = weldRelations.filter(r => r.fromPartId !== id && r.toPartId !== id);
                saveAll(); renderBomTree(); calculate();
                showToast("已删除");
            }
        }
        function openProcessEditor(nodeId) {
            let node = findNodeById(bomTree, nodeId);
            if (!node) return;
            currentEditingNodeId = nodeId;
            let container = document.getElementById('processEditorContainer');
            let processes = node.processes || [];
            let html = `<table class="process-table" id="editProcessTable"><thead><tr><th>工序名</th><th>设备吨位(T)</th><th>模具重量(kg)</th><th>冲次</th><th>操作</th></tr></thead><tbody>`;
            processes.forEach((p, idx) => {
                html += `<tr data-idx="${idx}">
            <td><input type="text" value="${p.name}" class="proc-name-${idx}" style="width:100px;"></td>
            <td><input type="number" value="${p.tonnage}" class="proc-tonnage-${idx}" step="10" style="width:90px;"></td>
            <td><input type="number" value="${p.dieWeight}" class="proc-die-${idx}" step="50" style="width:90px;"></td>
            <td><input type="number" value="${p.strokes}" class="proc-strokes-${idx}" step="1" style="width:70px;"></td>
            <td><button class="small outline delete-process" data-idx="${idx}">删除</button></td>
        </tr>`;
            });
            html += `</tbody></table><div class="inline-form"><input type="text" id="newProcName" placeholder="新工序名"><input type="number" id="newProcTonnage" placeholder="吨位" step="10"><input type="number" id="newProcDieWeight" placeholder="模具重量" step="50"><input type="number" id="newProcStrokes" placeholder="冲次" value="1"><button class="primary small" id="addProcessToNodeBtn">+添加</button></div>`;
            container.innerHTML = html;
            document.querySelectorAll('#editProcessTable .delete-process').forEach(btn => btn.onclick = () => { processes.splice(parseInt(btn.dataset.idx), 1); openProcessEditor(nodeId); });
            document.getElementById('addProcessToNodeBtn').onclick = () => {
                let name = document.getElementById('newProcName').value.trim();
                let tonnage = parseFloat(document.getElementById('newProcTonnage').value);
                let dieWeight = parseFloat(document.getElementById('newProcDieWeight').value);
                let strokes = parseFloat(document.getElementById('newProcStrokes').value);
                if (!name || isNaN(tonnage) || isNaN(dieWeight) || isNaN(strokes)) { alert("请完整填写"); return; }
                processes.push({ name, tonnage, dieWeight, strokes });
                openProcessEditor(nodeId);
            };
            document.getElementById('processModal').style.display = 'flex';
        }
        function saveProcessesFromModal() {
            if (!currentEditingNodeId) return;
            let node = findNodeById(bomTree, currentEditingNodeId);
            if (!node) return;
            let processes = [];
            let rows = document.querySelectorAll('#editProcessTable tbody tr');
            for (let row of rows) {
                let idx = row.dataset.idx;
                let name = row.querySelector(`.proc-name-${idx}`)?.value;
                let tonnage = parseFloat(row.querySelector(`.proc-tonnage-${idx}`)?.value);
                let dieWeight = parseFloat(row.querySelector(`.proc-die-${idx}`)?.value);
                let strokes = parseFloat(row.querySelector(`.proc-strokes-${idx}`)?.value);
                if (name && !isNaN(tonnage) && !isNaN(dieWeight) && !isNaN(strokes)) processes.push({ name, tonnage, dieWeight, strokes });
            }
            node.processes = processes;
            saveAll();
            document.getElementById('processModal').style.display = 'none';
            calculate();
            showToast("工序已保存");
        }

        // ========== 焊接关系 ==========
        function renderWeldRelationsUI() {
            let container = document.getElementById('weldRelationsContainer');
            let html = `<table class="weld-relations-table"><thead><tr><th>父零件</th><th>子零件</th><th>焊接类型</th><th>焊点数量</th><th>焊缝长度(mm)</th><th>操作</th></tr></thead><tbody>`;
            for (let i = 0; i < weldRelations.length; i++) {
                let rel = weldRelations[i];
                let fromNode = findNodeById(bomTree, rel.fromPartId);
                let toNode = findNodeById(bomTree, rel.toPartId);
                let fromName = fromNode ? fromNode.name : '?';
                let toName = toNode ? toNode.name : '?';
                html += `<tr data-idx="${i}">
            <td><input type="text" value="${escapeHtml(fromName)}" readonly style="width:120px;"> (${rel.fromPartId.substr(-6)})</td>
            <td><input type="text" value="${escapeHtml(toName)}" readonly style="width:120px;"> (${rel.toPartId.substr(-6)})</td>
            <td><select class="weld-type-${i}"><option value="spot" ${rel.weldType === 'spot' ? 'selected' : ''}>点焊</option><option value="mig" ${rel.weldType === 'mig' ? 'selected' : ''}>二保焊</option><option value="laser" ${rel.weldType === 'laser' ? 'selected' : ''}>激光焊</option></select></td>
            <td><input type="number" value="${rel.spotCount || 0}" class="spot-count-${i}" step="1" style="width:70px;"></td>
            <td><input type="number" value="${rel.lengthMm || 0}" class="weld-len-${i}" step="10" style="width:80px;"></td>
            <td><button class="small danger delete-weld" data-idx="${i}">删除</button></td>
        </tr>`;
            }
            html += `</tbody></td>`;
            container.innerHTML = html;
            for (let i = 0; i < weldRelations.length; i++) {
                document.querySelector(`.weld-type-${i}`).addEventListener('change', (e) => { weldRelations[i].weldType = e.target.value; });
                document.querySelector(`.spot-count-${i}`).addEventListener('change', (e) => { weldRelations[i].spotCount = parseInt(e.target.value) || 0; });
                document.querySelector(`.weld-len-${i}`).addEventListener('change', (e) => { weldRelations[i].lengthMm = parseInt(e.target.value) || 0; });
                document.querySelector(`.delete-weld[data-idx="${i}"]`).addEventListener('click', () => { weldRelations.splice(i, 1); renderWeldRelationsUI(); });
            }
        }
        function addWeldRelation() {
            let allParts = [];
            function collect(nodes, prefix = '') { for (let node of nodes) { allParts.push({ id: node.id, name: prefix + node.name }); if (node.children) collect(node.children, prefix + '  '); } }
            collect(bomTree);
            if (allParts.length < 2) { alert("至少需要两个零件"); return; }
            let partOptions = allParts.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
            let modalDiv = document.createElement('div'); modalDiv.className = 'modal'; modalDiv.style.display = 'flex';
            modalDiv.innerHTML = `<div class="modal-content" style="width:400px;"><div class="modal-header"><h3>选择焊接对</h3><button class="outline" id="closePickerBtn">✕</button></div>
        <div><label>父零件：</label><select id="weldFromPart">${partOptions}</select></div>
        <div><label>子零件：</label><select id="weldToPart">${partOptions}</select></div>
        <div class="toolbar"><button class="primary" id="confirmAddWeldBtn">确认</button><button class="outline" id="cancelAddWeldBtn">取消</button></div></div>`;
            document.body.appendChild(modalDiv);
            let closeModal = () => modalDiv.remove();
            document.getElementById('closePickerBtn').onclick = closeModal;
            document.getElementById('cancelAddWeldBtn').onclick = closeModal;
            document.getElementById('confirmAddWeldBtn').onclick = () => {
                let fromId = document.getElementById('weldFromPart').value, toId = document.getElementById('weldToPart').value;
                if (fromId === toId) { alert("不能自己焊自己"); return; }
                weldRelations.push({ fromPartId: fromId, toPartId: toId, weldType: "spot", spotCount: 2, lengthMm: 0 });
                closeModal(); renderWeldRelationsUI(); showToast("已添加焊接关系");
            };
        }

        // ========== 板材价格库维护 ==========
        function renderMaterialModal() {
            let tbody = document.getElementById('materialTableBody');
            tbody.innerHTML = stampingMaterialsData.map((m, idx) => `
        <tr>
            <td><input value="${escapeHtml(m.MaterialCode)}" class="mat-code-${idx}" style="width:100px;"></td>
            <td><input value="${m.Type}" class="mat-type-${idx}" style="width:80px;"></td>
            <td><input value="${m.Spec}" class="mat-spec-${idx}" style="width:120px;"></td>
            <td><input type="number" value="${m.UnitPrice}" class="mat-price-${idx}" step="0.1" style="width:90px;"></td>
            <td><span class="edit-icon" data-idx="${idx}">💾</span><span class="delete-icon" data-idx="${idx}">🗑️</span></td>
        </tr>
    `).join('');
            attachMaterialEvents();
        }
        function attachMaterialEvents() {
            document.querySelectorAll('#materialTableBody .edit-icon').forEach(el => {
                el.onclick = () => {
                    let idx = parseInt(el.dataset.idx);
                    stampingMaterialsData[idx].MaterialCode = document.querySelector(`.mat-code-${idx}`).value;
                    stampingMaterialsData[idx].Type = document.querySelector(`.mat-type-${idx}`).value;
                    stampingMaterialsData[idx].Spec = document.querySelector(`.mat-spec-${idx}`).value;
                    stampingMaterialsData[idx].UnitPrice = parseFloat(document.querySelector(`.mat-price-${idx}`).value);
                    saveAll(); refreshMaterialPreview(); renderMaterialModal(); calculate();
                    showToast("材料已保存");
                };
            });
            document.querySelectorAll('#materialTableBody .delete-icon').forEach(el => {
                el.onclick = () => {
                    if (confirm("删除该材料？")) {
                        stampingMaterialsData.splice(parseInt(el.dataset.idx), 1);
                        if (stampingMaterialsData.length === 0) {
                            stampingMaterialsData.push({ id: "default", MaterialCode: "Q235A", Type: "热轧", Spec: "3.0mm", Thickness: 3.0, Density: 7.85, UnitPrice: 3.5 });
                        }
                        saveAll(); refreshMaterialPreview(); renderMaterialModal(); calculate();
                        showToast("已删除");
                    }
                };
            });
        }
        function refreshMaterialPreview() {
            let tbody = document.getElementById('materialPreviewBody');
            tbody.innerHTML = stampingMaterialsData.map(m => `<tr><td>${m.MaterialCode}</td><td>${m.Type}</td><td>${m.Spec}</td><td>${m.UnitPrice}</td></tr>`).join('');
        }

        // ========== 设备费率库维护 ==========
        function renderEquipmentModal() {
            let tbody = document.getElementById('equipmentTableBody');
            tbody.innerHTML = equipmentData.map((eq, idx) => `
        <tr>
            <td><input type="number" value="${eq.tonnage}" class="eq-ton-${idx}" step="10" style="width:90px;"></td>
            <td><input type="number" value="${eq.hourlyRate}" class="eq-rate-${idx}" step="5" style="width:90px;"></td>
            <td><input type="number" value="${eq.spm}" class="eq-spm-${idx}" step="5" style="width:80px;"></td>
            <td><span class="edit-icon" data-idx="${idx}">💾</span><span class="delete-icon" data-idx="${idx}">🗑️</span></td>
        </tr>
    `).join('');
            attachEquipmentEvents();
        }
        function attachEquipmentEvents() {
            document.querySelectorAll('#equipmentTableBody .edit-icon').forEach(el => {
                el.onclick = () => {
                    let idx = parseInt(el.dataset.idx);
                    equipmentData[idx].tonnage = parseFloat(document.querySelector(`.eq-ton-${idx}`).value);
                    equipmentData[idx].hourlyRate = parseFloat(document.querySelector(`.eq-rate-${idx}`).value);
                    equipmentData[idx].spm = parseFloat(document.querySelector(`.eq-spm-${idx}`).value);
                    saveAll(); refreshEquipmentPreview(); renderEquipmentModal(); calculate();
                    showToast("设备已保存");
                };
            });
            document.querySelectorAll('#equipmentTableBody .delete-icon').forEach(el => {
                el.onclick = () => {
                    if (confirm("删除该设备？")) {
                        equipmentData.splice(parseInt(el.dataset.idx), 1);
                        if (equipmentData.length === 0) {
                            equipmentData.push({ id: "eq1", tonnage: 400, hourlyRate: 120, spm: 45 });
                        }
                        saveAll(); refreshEquipmentPreview(); renderEquipmentModal(); calculate();
                        showToast("已删除");
                    }
                };
            });
        }
        function refreshEquipmentPreview() {
            let tbody = document.getElementById('equipmentPreviewBody');
            tbody.innerHTML = equipmentData.map(e => `<tr><td>${e.tonnage}</td><td>${e.hourlyRate}</td><td>${e.spm}</td></tr>`).join('');
        }

        // ========== 成本计算 ==========
        //
        // 本次修复的缺陷（均为实测发现）：
        //   [BUG-2] 物流重量不再用「材料成本 ÷ 6」倒推，改用 BOM 真实重量
        //   [BUG-3] 模具重量不再乘以零件数量（模具是一次性工装，与装配用量无关）
        //   [BUG-4] 区分「单件净重」与「下料毛重」，废料按真实差值回收（不再固定 5%）
        //   [BUG-5] 设备匹配不再用 === 精确相等，改为「吨位不小于需求的最小设备」，找不到时告警
        //   [FIX-6] 焊接费按子零件数量放大（原来完全忽略数量）
        //   [FIX-7] 管理费率/利润率/税率可配置（原来硬编码 12%/10%/13%）
        //   [FIX-8] 图表改为引擎自绘，移除 Chart.js CDN 依赖
        //   [FIX-9] 历史记录不再每次重算都写入，改为显式「保存本次测算」

        /** 设备匹配：取吨位不小于需求的最小设备；避免原 === 精确匹配静默失败 */
        function findEquipment(tonnage) {
            const need = E.num(tonnage, 0);
            if (!equipmentData.length) return null;
            let best = null;
            for (const eq of equipmentData) {
                if (E.num(eq.tonnage) >= need && (!best || eq.tonnage < best.tonnage)) best = eq;
            }
            return best || equipmentData[equipmentData.length - 1];
        }

        function calculate() {
            const diagEl = document.getElementById('diagnostics');
            const issues = [];
            try {
                const annualQty = Math.max(1, parseInt(document.getElementById('annualQty').value) || 100000);
                const rates = readStampingSettings();
                const diePayment = document.getElementById('diePayment').value;
                const supplierRatio = diePayment === 'full_automaker' ? 0
                    : (diePayment === 'partial' ? E.num(document.getElementById('partialRatio').value, 0) / 100 : 1);

                let grossMaterialCost = 0, scrapKgSum = 0, netWeightKgSum = 0, grossWeightKgSum = 0;
                let processCostSum = 0, dieWeightSum = 0;
                const detailLines = [], materialLines = [];
                const allNodes = [];

                (function collect(nodes, level) {
                    for (const node of nodes) {
                        allNodes.push({ node: node, level: level });
                        if (node.children && node.children.length) collect(node.children, level + 1);
                    }
                })(bomTree, 0);

                for (const item of allNodes) {
                    const node = item.node;
                    const pad = '  '.repeat(item.level);
                    const mat = stampingMaterialsData.find(m => m.id === node.materialId);
                    if (!mat) {
                        issues.push({ field: 'material', level: 'warn', message: '零件「' + node.name + '」的材料在参数库中不存在，已按 7.85 kg/dm³、5.8 元/kg 估算。' });
                    }
                    const density = mat ? E.num(mat.Density, 7.85) : 7.85;
                    const price = mat ? E.num(mat.UnitPrice, 5.8) : 5.8;
                    const qty = E.num(node.qty, 1);

                    const w = calcNodeWeight(node, density);
                    const nodeGrossCost = (w.grossG / 1000) * price * qty;
                    grossMaterialCost += nodeGrossCost;
                    scrapKgSum += (w.grossG - w.netG) / 1000 * qty;
                    netWeightKgSum += w.netG / 1000 * qty;
                    grossWeightKgSum += w.grossG / 1000 * qty;

                    materialLines.push(pad + node.name + ' x' + qty
                        + '：净重 ' + w.netG.toFixed(1) + 'g'
                        + ' / 下料毛重 ' + w.grossG.toFixed(1) + 'g'
                        + '（利用率 ' + E.pct(w.utilization, 0) + '）'
                        + '，材料费 ' + nodeGrossCost.toFixed(2) + ' 元');

                    for (const proc of (node.processes || [])) {
                        const eq = findEquipment(proc.tonnage);
                        if (!eq) {
                            issues.push({ field: 'equipment', level: 'warn', message: '设备费率库为空，工序「' + proc.name + '」按 0.05 元/冲次估算。' });
                        }
                        // 设备费率系数：体现地区/自动化水平差异，不改动客户维护的设备库
                        const effRate = eq ? eq.hourlyRate * rates.equipmentRateFactor : 0;
                        const ratePerStroke = (eq && eq.spm > 0) ? effRate / (eq.spm * 60) : 0.05;
                        const cost = ratePerStroke * E.num(proc.strokes, 1) * qty;
                        processCostSum += cost;
                        // [BUG-3] 模具重量与装配用量无关，不再 × qty
                        dieWeightSum += E.num(proc.dieWeight, 0);
                        const line = pad + node.name + ' · ' + proc.name + '：'
                            + (eq
                                ? eq.tonnage + 'T / ' + E.money(effRate, 1) + '元/h'
                                + (rates.equipmentRateFactor !== 1 ? '（基准 ' + eq.hourlyRate + ' × ' + rates.equipmentRateFactor.toFixed(2) + '）' : '')
                                + ' / ' + eq.spm + 'SPM'
                                : '未匹配到设备')
                            + '，' + E.num(proc.strokes, 1) + ' 冲次 × ' + qty + ' 件 = ' + cost.toFixed(4) + ' 元'
                            + '，模具 ' + E.num(proc.dieWeight, 0) + 'kg';
                        detailLines.push(line);
                    }
                }

                // ---- 焊接：按子零件数量放大（原来完全忽略 qty）----
                const weldItemsRaw = weldRelations.map(rel => {
                    const child = allNodes.find(x => x.node.id === rel.toPartId);
                    return {
                        type: rel.weldType || 'spot',
                        count: E.num(rel.spotCount, 0),
                        lengthMm: E.num(rel.lengthMm, 0),
                        qty: child ? Math.max(1, E.num(child.node.qty, 1)) : 1
                    };
                });
                const weldPreview = E.joining({ items: weldItemsRaw });
                const weldDetails = weldPreview.detail.items.map(it => '焊接 · ' + it.label + '：' + it.note);

                // ---- 废料回收：[BUG-4] 按真实 (毛重 − 净重) 计算，不再固定 5% ----
                const scrapCredit = rates.scrapAccountingMethod === 'deduct' ? scrapKgSum * rates.scrapPrice : 0;
                const materialBlock = {
                    key: 'material', name: '材料费',
                    cost: Math.max(0, grossMaterialCost - scrapCredit),
                    detail: {
                        grossCost: grossMaterialCost,
                        scrapKg: scrapKgSum,
                        scrapValue: scrapCredit,
                        netWeightKg: netWeightKgSum,
                        grossWeightKg: grossWeightKgSum,
                        utilization: grossWeightKgSum > 0 ? netWeightKgSum / grossWeightKgSum : 0
                    },
                    __built: true
                };

                const processBlock = {
                    key: 'process', name: '冲压加工', cost: processCostSum,
                    detail: { ops: [] }, __built: true
                };

                // ---- 物流：[BUG-2] 用 BOM 真实重量，不再用成本倒推 ----
                const dist = E.num(document.getElementById('logisticsDistance').value, 500);
                const ratePerTonKm = E.num(document.getElementById('ratePerTonKm').value, 0.5);
                const minFreight = E.num(document.getElementById('minFreight').value, 300);
                const fullLoad = Math.max(1, parseInt(document.getElementById('fullLoadQty').value) || 8000);
                const handling = E.num(document.getElementById('handlingFee').value, 0.5);
                const theoretical = ratePerTonKm * grossWeightKgSum * dist;
                const actualFreight = Math.max(theoretical, minFreight);
                const logisticsCost = actualFreight / fullLoad + handling;
                const logisticsBlock = {
                    key: 'logistics', name: '包装物流', cost: logisticsCost,
                    detail: {
                        freightCost: logisticsCost, packagingCost: 0, ediPerPart: 0,
                        weightKgPerAssembly: grossWeightKgSum,
                        theoreticalFreight: theoretical,
                        actualFreight: actualFreight,
                        minFreightApplied: actualFreight > theoretical
                    },
                    __built: true
                };

                // ---- 模具 ----
                // 模具价格系数：体现地区模具供应水平差异
                const effDiePricePerKg = rates.diePricePerKg * rates.moldPriceFactor;
                const diePriceTotal = dieWeightSum * effDiePricePerKg;
                const toolingBlock = E.tooling({
                    totalToolPrice: diePriceTotal, supplierShare: supplierRatio, lifecycleQty: annualQty
                });
                toolingBlock.key = 'tooling';
                toolingBlock.name = '模具分摊';
                toolingBlock.__built = true;
                toolingBlock.detail.dieWeightKg = dieWeightSum;
                toolingBlock.detail.diePricePerKg = effDiePricePerKg;

                // ---- 用引擎组装整表 ----
                const sheet = E.buildSheet({
                    material: materialBlock,
                    process: processBlock,
                    tooling: toolingBlock,
                    joining: { items: weldItemsRaw },
                    logistics: logisticsBlock,
                    overhead: {
                        managementRate: rates.managementRate,
                        profitRate: rates.profitRate,
                        taxRate: rates.taxRate
                    }
                });

                sheet.meta = {
                    assemblyName: document.getElementById('assemblyName').value || '未命名总成',
                    annualQty: annualQty,
                    dieWeightSum: dieWeightSum,
                    diePriceTotal: diePriceTotal,
                    diePricePerKg: effDiePricePerKg,
                    baseDiePricePerKg: rates.diePricePerKg,
                    supplierRatio: supplierRatio,
                    rates: rates,
                    grossWeightKgSum: grossWeightKgSum,
                    netWeightKgSum: netWeightKgSum,
                    scrapKgSum: scrapKgSum,
                    scrapCredit: scrapCredit,
                    totalWeightKg: grossWeightKgSum
                };
                lastStampingSheet = sheet;

                if (grossWeightKgSum <= 0) {
                    issues.push({ field: 'bom', level: 'error', message: 'BOM 为空或所有零件重量为 0，请先添加零件并填写尺寸。' });
                }

                // ---- 输出 ----
                UI.renderDiagnostics(diagEl, issues.concat(sheet.diagnostics));

                document.getElementById('totalCostVal').innerHTML = E.money(sheet.totalCost) + ' 元';
                document.getElementById('quotePriceVal').innerHTML = E.money(sheet.quotePrice) + ' 元';

                document.getElementById('dieCostDetail').innerHTML =
                    '💰 模具总重 ' + dieWeightSum.toFixed(0) + 'kg × ' + E.money(effDiePricePerKg, 1) + ' 元/kg'
                    + (rates.moldPriceFactor !== 1
                        ? '（基准 ' + rates.diePricePerKg + ' × ' + rates.moldPriceFactor.toFixed(2) + '）'
                        : '')
                    + ' = ' + Math.round(diePriceTotal).toLocaleString() + ' 元'
                    + ' | 供应商承担 ' + E.pct(supplierRatio, 0)
                    + ' | 单件分摊 ' + E.money(toolingBlock.cost, 3) + ' 元';

                document.getElementById('materialBreakdown').innerHTML =
                    '<strong>材料明细</strong>（毛重计费 / 按真实下料废料回收）<br>' + materialLines.join('<br>');

                const items = E.displayItems(sheet);

                document.getElementById('costDetails').innerHTML = items.map(c =>
                    '<div class="cost-card"><span>' + E.escapeHtml(c.name) + '</span><span>' + E.money(c.val) + '元</span></div>'
                ).join('');

                const detailsDiv = document.getElementById('calcDetails');
                if (detailsDiv) detailsDiv.innerHTML = [...detailLines, ...weldDetails].map(d => '<div class="calc-detail-line">' + E.escapeHtml(d) + '</div>').join('');

                E.pieChart(document.getElementById('costChart'), items);

            } catch (e) {
                console.error(e);
                UI.renderDiagnostics(diagEl, [{ level: 'error', message: '计算错误：' + e.message }]);
            }
        }

        /* ---------- 历史记录：[BUG-9] 不再每次重算都写入 ---------- */
        function renderHistory() {
            const histDiv = document.getElementById('historyList');
            if (!histDiv) return;
            if (!historyList.length) {
                histDiv.innerHTML = '<div style="color:#9ca3af;padding:10px;font-size:0.75rem;">暂无记录。调整好参数后点「💾 保存本次测算」。</div>';
                return;
            }
            histDiv.innerHTML = historyList.slice(0, 10).map(h =>
                '<div style="padding:6px;border-bottom:1px solid #e2e8f0;font-size:0.75rem;">'
                + '<strong>' + escapeHtml(h.name) + '</strong> ' + E.money(h.totalCost) + '元'
                + ' <span style="float:right;color:#94a3b8;">' + escapeHtml(h.time) + '</span></div>'
            ).join('');
        }

        function saveHistorySnapshot() {
            if (!lastStampingSheet) { UI.toast('请先完成一次测算', 'error'); return; }
            const name = document.getElementById('assemblyName').value || '未命名总成';
            historyList.unshift({
                id: Date.now(), name: name,
                totalCost: lastStampingSheet.totalCost,
                quote: lastStampingSheet.quotePrice,
                annualQty: lastStampingSheet.meta.annualQty,
                time: new Date().toLocaleString()
            });
            if (historyList.length > 20) historyList.length = 20;
            DB.state('history', historyList);
            renderHistory();
            UI.toast('已保存本次测算', 'success');
        }

        function clearHistory() {
            if (!historyList.length) return;
            if (!confirm('清空全部历史记录？')) return;
            historyList = [];
            DB.state('history', historyList);
            renderHistory();
            UI.toast('历史记录已清空', 'success');
        }

        /* ---------- [BUG-1] Excel 导出：此前按钮存在但没有任何实现 ---------- */
        function exportExcel() {
            if (!lastStampingSheet) { UI.toast('请先完成一次测算', 'error'); return; }
            const s = lastStampingSheet, m = s.meta;
            const watermark = '总成：' + m.assemblyName + ' | 年产量：' + m.annualQty.toLocaleString() + ' 件'
                + ' | 生成时间：' + new Date().toLocaleString()
                + ' | 引擎 v' + E.VERSION + ' / 参数库 v' + DB.VERSION;

            const summary = [['成本项', '金额(元/件)', '占完全成本比']];
            s.blocks.forEach(b => summary.push([b.name, E.round(b.cost, 4), s.totalCost > 0 ? E.pct(b.cost / s.totalCost) : '-']));
            summary.push(['完全成本', s.totalCost, '100.0%']);
            summary.push(['含税报价', s.quotePrice, '']);
            summary.push(['增值税率', E.pct(s.overhead.taxRate), '']);
            summary.push(['税额', E.round(s.overhead.taxAmount, 4), '']);

            const params = [
                ['参数', '值'],
                ['总成名称', m.assemblyName],
                ['年产量(件)', m.annualQty],
                ['零件数(含子件)', bomTree.length ? '—' : '0'],
                ['总成下料毛重(kg)', E.round(m.grossWeightKgSum, 4)],
                ['总成净重(kg)', E.round(m.netWeightKgSum, 4)],
                ['材料利用率', E.pct(m.grossWeightKgSum > 0 ? m.netWeightKgSum / m.grossWeightKgSum : 0, 1)],
                ['废料重量(kg)', E.round(m.scrapKgSum, 4)],
                ['废料回收价(元/kg)', m.rates.scrapPrice],
                ['废料核算方式', m.rates.scrapAccountingMethod === 'deduct' ? '冲减材料成本' : '不核算'],
                ['模具总重(kg)', E.round(m.dieWeightSum, 1)],
                ['模具单价(元/kg)', m.diePricePerKg],
                ['模具总价(元)', E.round(m.diePriceTotal, 2)],
                ['模具供应商分摊', E.pct(m.supplierRatio, 0)],
                ['物流距离(km)', E.num(document.getElementById('logisticsDistance').value, 500)],
                ['吨公里费率', m.rates.ratePerTonKm],
                ['最低运费(元)', m.rates.minFreight],
                ['管理费率', E.pct(m.rates.managementRate)],
                ['利润率', E.pct(m.rates.profitRate)]
            ];

            const detail = [['层级/零件/工序', '计算过程', '费用(元)']];
            if (s.blockMap.material) {
                const d = s.blockMap.material.detail;
                detail.push(['材料费', '毛重 ' + E.round(d.grossWeightKg, 4) + 'kg × 单价', E.round(d.grossCost, 4)]);
                detail.push(['废料回收', '废料 ' + E.round(d.scrapKg, 4) + 'kg × 回收价', -E.round(d.scrapValue, 4)]);
            }
            if (s.blockMap.process) detail.push(['冲压加工', '各工序冲次费合计', E.round(s.blockMap.process.cost, 4)]);
            if (s.blockMap.tooling) detail.push(['模具分摊', E.round(m.diePriceTotal, 2) + ' × ' + E.pct(m.supplierRatio, 0) + ' ÷ ' + m.annualQty + ' 件', E.round(s.blockMap.tooling.cost, 4)]);
            if (s.blockMap.joining) {
                s.blockMap.joining.detail.items.forEach(it => detail.push(['焊接 · ' + it.label, it.note, E.round(it.cost, 4)]));
            }
            if (s.blockMap.logistics) {
                const d = s.blockMap.logistics.detail;
                detail.push(['运费', '理论 ' + E.money(d.theoreticalFreight) + ' / 实收 ' + E.money(d.actualFreight) + (d.minFreightApplied ? '（触发最低运费）' : '') + ' ÷ ' + E.num(document.getElementById('fullLoadQty').value, 8000) + ' 件 + 装卸 ' + m.rates.handlingFee, E.round(d.freightCost, 4)]);
            }
            detail.push(['管理费', E.pct(s.overhead.managementRate) + ' × 直接成本', E.round(s.overhead.management, 4)]);
            detail.push(['利润', E.pct(s.overhead.profitRate) + ' × (直接成本+管理费)', E.round(s.overhead.profit, 4)]);

            try {
                E.exportXls('冲压件成本报告_' + m.assemblyName + '_' + E.timestamp() + '.xls', [
                    { name: '成本汇总', title: '冲压件成本测算报告', watermark: watermark, rows: summary },
                    { name: '测算参数', rows: params },
                    { name: '计算明细', rows: detail }
                ]);
                UI.toast('Excel 报告已导出', 'success');
            } catch (e2) {
                UI.toast('导出失败：' + e2.message, 'error', 4000);
            }
        }

        function calcSimilarity(caseItem, length, width, thickness, materialId) {
            let mat = stampingMaterialsData.find(m => m.id === materialId);
            let matCode = mat ? mat.MaterialCode : '';
            let sizeDiff = Math.abs(caseItem.length - length) + Math.abs(caseItem.width - width);
            let thickDiff = Math.abs(caseItem.thickness - thickness);
            let matMatch = (caseItem.material === matCode) ? 0 : 20;
            let score = 100 - (sizeDiff / 100) - thickDiff * 10 - matMatch;
            return Math.max(0, Math.min(100, score));
        }
        function refreshCaseMatch() {
            let length = 800, width = 500, thickness = 1.2, materialId = "dc01";
            if (bomTree.length) {
                let first = bomTree[0];
                length = first.length || 800; width = first.width || 500; thickness = first.thickness || 1.2; materialId = first.materialId || "dc01";
            }
            let scores = caseLibrary.map(c => ({ case: c, score: calcSimilarity(c, length, width, thickness, materialId) }));
            scores.sort((a, b) => b.score - a.score);
            let container = document.getElementById('caseMatchPanel');
            container.innerHTML = '<div style="font-weight:600; margin-bottom:10px;">📌 相似案例推荐</div>';
            scores.slice(0, 6).forEach(s => {
                let div = document.createElement('div'); div.className = 'case-item';
                div.innerHTML = `<div><strong>${s.case.name}</strong> (${s.case.category})<span class="case-score">匹配度 ${s.score.toFixed(0)}%</span></div>
                        <div style="font-size:0.7rem;">材料:${s.case.material} 厚:${s.case.thickness}mm 尺寸:${s.case.length}x${s.case.width}</div>
                        <div class="progress-bar"><div class="progress-fill" style="width:${s.score}%"></div></div>`;
                div.onclick = () => {
                    if (confirm(`应用案例“${s.case.name}”的工序配置到顶层零件？`)) {
                        if (bomTree.length) { bomTree[0].processes = s.case.processes.map(p => ({ ...p })); saveAll(); renderBomTree(); calculate(); showToast(`已应用案例 ${s.case.name}`); }
                        else alert("无顶层零件");
                    }
                };
                container.appendChild(div);
            });
        }

        // 反馈相关
        function renderFeedbackList() {
            let container = document.getElementById('feedbackList');
            if (!container) return;
            if (feedbackList.length === 0) { container.innerHTML = '<div style="padding:20px;text-align:center;">暂无反馈</div>'; return; }
            let html = '';
            feedbackList.forEach(f => {
                html += `<div><strong>${f.time}</strong><br>${escapeHtml(f.content)}</div><hr>`;
            });
            container.innerHTML = html;
        }
        function addFeedback(content) {
            if (!content.trim()) return;
            feedbackList.unshift({ id: Date.now(), content: content, time: new Date().toLocaleString() });
            DB.state('feedback', feedbackList.slice(0, 200));
            renderFeedbackList();
            showToast("感谢反馈");
        }
        function exportFeedbackCSV() {
            if (!feedbackList.length) { showToast('暂无反馈记录', true); return; }
            const rows = [["时间", "内容"]];
            feedbackList.forEach(f => rows.push([f.time, f.content]));
            E.exportCsv('反馈记录_' + E.timestamp() + '.csv', rows);
        }

        // ========== 初始化 ==========
        function init() {
            // 旧版 localStorage → 参数库 迁移（幂等，只跑一次）
            const mig = DB.migrateLegacy();

            loadStorage();
            renderBomTree();
            renderHistory();
            refreshCaseMatch();
            refreshMaterialPreview();
            refreshEquipmentPreview();
            document.getElementById('calcBtn').onclick = calculate;

            // 修复：原来「重置」直接 localStorage.clear()，会把注塑件的数据一起清空
            document.getElementById('resetBtn').onclick = () => {
                if (!confirm('重置将恢复默认板材/设备/案例库，并清除本页 BOM 与输入。\n\n（不会影响注塑件的数据）\n\n确认继续？')) return;
                DB.table('cases').reset();
                DB.table('equipment').replaceAll(DB.table('equipment').all().filter(r => r.kind !== 'stamping'));
                DB.table('materials').replaceAll(DB.table('materials').all().filter(r => r.kind !== 'sheet'));
                DB.state('bomTree', null);
                DB.state('weldRelations', null);
                DB.state('history', null);
                location.reload();
            };

            // 本轮新增：Excel 导出、历史快照、参数库备份
            document.getElementById('exportExcelBtn').onclick = exportExcel;
            document.getElementById('saveHistoryBtn').onclick = saveHistorySnapshot;
            document.getElementById('clearHistoryBtn').onclick = clearHistory;
            UI.mountBackupButtons(document.getElementById('backupButtons'), {
                exportName: '成本参数库备份',
                onImported: function () {
                    loadStorage(); renderBomTree(); refreshCaseMatch();
                    refreshMaterialPreview(); refreshEquipmentPreview(); renderHistory(); calculate();
                }
            });

            // 费率预设：选一个档位，整套费率跟着切换（不改动参数库）
            UI.mountPresetPicker(document.getElementById('presetPicker'), {
                scope: 'stamping',
                onApplied: function () {
                    loadStorage(); renderBomTree(); calculate();
                }
            });

            // 板材价格批量导入：客户 3 分钟自己刷新价格，不依赖作者维护
            document.getElementById('importPriceBtn').onclick = function () {
                UI.openPriceImport({
                    table: 'materials',
                    codeField: 'code',
                    priceField: 'unitPrice',
                    codeLabel: '板材牌号',
                    priceLabel: '板材单价(元/kg)',
                    newKind: 'sheet',
                    newDensity: 7.85,
                    onDone: function () {
                        loadStorage(); renderBomTree(); refreshMaterialPreview(); refreshCaseMatch(); calculate();
                    }
                });
            };

            // 费率类参数：输入即重算，失焦时落库
            ['diePricePerKg', 'scrapPrice', 'ratePerTonKm', 'minFreight', 'handlingFee',
                'mgmtRate', 'profitRate', 'taxRate', 'blankUtilization',
                'logisticsDistance', 'fullLoadQty', 'partialRatio', 'annualQty'].forEach(id => {
                    const node = document.getElementById(id);
                    if (!node) return;
                    node.addEventListener('input', calculate);
                    node.addEventListener('change', () => { saveAll(); calculate(); });
                });
            document.getElementById('addRootPartBtn').onclick = () => {
                let newNode = {
                    id: generateId(), name: "新总成", qty: 1, materialId: stampingMaterialsData[0].id, thickness: 1.0, length: 300, width: 200, height: 50, blankLen: 330, blankWid: 230,
                    processes: [{ name: "落料", tonnage: 160, dieWeight: 500, strokes: 1 }], children: []
                };
                bomTree.push(newNode); saveAll(); renderBomTree(); calculate();
            };
            document.getElementById('importSampleBomBtn').onclick = () => { loadSampleBom(); renderBomTree(); calculate(); showToast("已导入示例BOM"); };
            document.getElementById('openWeldRelationsBtn').onclick = () => { renderWeldRelationsUI(); document.getElementById('weldRelationsModal').style.display = 'flex'; };
            document.getElementById('closeWeldRelationsModal').onclick = () => document.getElementById('weldRelationsModal').style.display = 'none';
            document.getElementById('addWeldRelationBtn').onclick = addWeldRelation;
            document.getElementById('addChildWeldRelationBtn').onclick = addWeldRelation;
            document.getElementById('saveWeldRelationsBtn').onclick = () => { saveAll(); document.getElementById('weldRelationsModal').style.display = 'none'; calculate(); showToast("焊接关系已保存"); };
            document.getElementById('diePayment').addEventListener('change', function () { document.getElementById('partialRatioGroup').style.display = this.value === 'partial' ? 'block' : 'none'; calculate(); });
            document.getElementById('saveProcessBtn').onclick = saveProcessesFromModal;
            document.getElementById('closeProcessModal').onclick = () => document.getElementById('processModal').style.display = 'none';
            document.getElementById('refreshCaseMatchBtn').onclick = refreshCaseMatch;
            document.getElementById('diePricePerKg').addEventListener('change', () => { saveAll(); calculate(); });
            // 板材库
            document.getElementById('openMaterialModalBtn').onclick = () => { renderMaterialModal(); document.getElementById('materialModal').style.display = 'flex'; };
            document.getElementById('closeMaterialModal').onclick = () => document.getElementById('materialModal').style.display = 'none';
            document.getElementById('addMaterialBtn').onclick = () => {
                let type = document.getElementById('newMatType').value;
                let code = document.getElementById('newMatCode').value.trim();
                let spec = document.getElementById('newMatSpec').value.trim();
                let price = parseFloat(document.getElementById('newMatPrice').value);
                if (code && spec && !isNaN(price)) {
                    stampingMaterialsData.push({ id: generateId(), MaterialCode: code, Type: type, Spec: spec, Thickness: 1.0, Density: 7.85, UnitPrice: price });
                    saveAll(); refreshMaterialPreview(); renderMaterialModal(); calculate();
                    showToast("材料已添加");
                    document.getElementById('newMatCode').value = '';
                    document.getElementById('newMatSpec').value = '';
                    document.getElementById('newMatPrice').value = '';
                } else alert("请完整填写");
            };
            // 设备库
            document.getElementById('openEquipmentModalBtn').onclick = () => { renderEquipmentModal(); document.getElementById('equipmentModal').style.display = 'flex'; };
            document.getElementById('closeEquipmentModal').onclick = () => document.getElementById('equipmentModal').style.display = 'none';
            document.getElementById('addEquipmentBtn').onclick = () => {
                let ton = parseFloat(document.getElementById('newEqTonnage').value);
                let rate = parseFloat(document.getElementById('newEqRate').value);
                let spm = parseFloat(document.getElementById('newEqSpm').value);
                if (!isNaN(ton) && !isNaN(rate) && !isNaN(spm) && ton > 0 && rate > 0 && spm > 0) {
                    equipmentData.push({ id: generateId(), tonnage: ton, hourlyRate: rate, spm: spm });
                    saveAll(); refreshEquipmentPreview(); renderEquipmentModal(); calculate();
                    showToast("设备已添加");
                    document.getElementById('newEqTonnage').value = '';
                    document.getElementById('newEqRate').value = '';
                    document.getElementById('newEqSpm').value = '';
                } else alert("请填写有效正数");
            };
            // 反馈
            document.getElementById('feedbackBtn').onclick = () => document.getElementById('feedbackModal').style.display = 'flex';
            document.getElementById('viewFeedbackBtn').onclick = () => { renderFeedbackList(); document.getElementById('viewFeedbackModal').style.display = 'flex'; };
            document.getElementById('closeFeedbackModal').onclick = () => document.getElementById('feedbackModal').style.display = 'none';
            document.getElementById('cancelFeedbackBtn').onclick = () => document.getElementById('feedbackModal').style.display = 'none';
            document.getElementById('submitFeedbackBtn').onclick = () => {
                let content = document.getElementById('feedbackContent').value.trim();
                if (!content) { alert("请输入内容"); return; }
                addFeedback(content);
                document.getElementById('feedbackModal').style.display = 'none';
                document.getElementById('feedbackContent').value = '';
            };
            document.getElementById('closeViewModal').onclick = () => document.getElementById('viewFeedbackModal').style.display = 'none';
            document.getElementById('clearAllFeedbackBtn').onclick = () => { feedbackList = []; saveAll(); renderFeedbackList(); showToast("已清空"); };
            document.getElementById('exportFeedbackBtn').onclick = exportFeedbackCSV;
            window.onclick = (e) => { if (e.target.classList.contains('modal')) e.target.style.display = 'none'; };
            document.getElementById('collapseHeader')?.addEventListener('click', () => document.getElementById('collapseContent')?.classList.toggle('show'));
            document.getElementById('historyHeader')?.addEventListener('click', () => document.getElementById('historyContent')?.classList.toggle('show'));
            calculate();
            renderHistory();
            showToast("冲压件成本模型已加载");
            if (mig && mig.migrated) {
                setTimeout(() => UI.toast('已把旧版数据迁移到新参数库，共 ' + mig.detail.length + ' 项', 'success', 3600), 400);
            }
        }
        function escapeHtml(s) {
            if (s === null || s === undefined) return '';
            return String(s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m]);
        }
        init();
    