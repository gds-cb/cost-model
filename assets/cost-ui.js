/*!
 * cost-ui.js —— 成本工具箱共享交互组件 V1.0.0
 * Toast、诊断提示、图标、数据备份按钮（导出/导入）等页面级通用能力。
 * 依赖：cost-engine.js (CostEngine)、cost-db.js (CostDB)
 */
(function (root) {
    'use strict';

    var E = root.CostEngine;
    var DB = root.CostDB;

    /* ================= 图标（内联 SVG，替代 CDN 图标字体） ================= */
    var ICON_PATHS = {
        factory: 'M2 20V9l6 4V9l6 4V4h4v16H2zm4-2h2v-2H6v2zm4 0h2v-2h-2v2zm4 0h2v-2h-2v2z',
        settings: 'M12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7zm7.4-2.6l1.9-1.5-1.9-3.3-2.3.8a7.6 7.6 0 0 0-1.3-.8L15.5 5h-3.8l-.3 2.4c-.5.2-.9.5-1.3.8l-2.3-.8-1.9 3.3 1.9 1.5a7 7 0 0 0 0 1.6l-1.9 1.5 1.9 3.3 2.3-.8c.4.3.8.6 1.3.8l.3 2.4h3.8l.3-2.4c.5-.2.9-.5 1.3-.8l2.3.8 1.9-3.3-1.9-1.5c.1-.5.1-1.1 0-1.6z',
        chart: 'M4 20h16v2H2V2h2v18zm3-3V9h3v8H7zm5 0V4h3v13h-3zm5 0v-6h3v6h-3z',
        calculator: 'M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm1 3v3h10V5H7zm0 5v2h2v-2H7zm4 0v2h2v-2h-2zm4 0v2h2v-2h-2zm-8 4v2h2v-2H7zm4 0v2h2v-2h-2zm4 0v2h2v-2h-2zm-8 4v2h6v-2H7z',
        refresh: 'M12 5V2L7 7l5 5V9a5 5 0 1 1-5 5H5a7 7 0 1 0 7-9z',
        excel: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm0 7V3.5L19.5 9H14zM8.5 12l1.6 2.6L8.4 17h1.7l1-1.7 1 1.7h1.7l-1.7-2.4L13.7 12h-1.7l-.9 1.5-.9-1.5H8.5z',
        download: 'M12 3v10.6l3.3-3.3 1.4 1.4L12 17.4l-4.7-5.7 1.4-1.4L12 13.6V3zM4 19h16v2H4v-2z',
        upload: 'M12 17V6.4L8.7 9.7 7.3 8.3 12 3l4.7 5.3-1.4 1.4L12 6.4V17h-0zM4 19h16v2H4v-2z',
        save: 'M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v4z',
        plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z',
        mail: 'M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm9 8L4 7v11h16V7l-8 6z',
        warn: 'M12 2l10 18H2L12 2zm-1 7v5h2V9h-2zm0 7v2h2v-2h-2z',
        info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
        tool: 'M14.7 6.3a4 4 0 0 1 5 5L21 12.6 11.4 22H6v-5.4L15.6 7 14.7 6.3z'
    };

    function icon(name, size) {
        var d = ICON_PATHS[name] || ICON_PATHS.info;
        var s = size || 16;
        return '<svg class="ce-i" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>';
    }

    /* ================= Toast ================= */
    function toastHost() {
        var host = document.getElementById('ceToastHost');
        if (!host) {
            host = document.createElement('div');
            host.id = 'ceToastHost';
            document.body.appendChild(host);
        }
        return host;
    }

    function toast(message, type, ms) {
        var host = toastHost();
        var el = document.createElement('div');
        el.className = 'ce-toast' + (type ? ' ' + type : '');
        el.innerHTML = E.escapeHtml(message);
        host.appendChild(el);
        setTimeout(function () {
            el.style.transition = 'opacity .25s';
            el.style.opacity = '0';
            setTimeout(function () { el.remove(); }, 260);
        }, ms || 2600);
    }

    /* ================= 诊断信息渲染 ================= */
    function renderDiagnostics(el, diagnostics) {
        if (!el) return;
        var list = diagnostics || [];
        if (!list.length) { el.innerHTML = ''; return; }
        el.innerHTML = '<div class="ce-diagnostics">' + list.map(function (d) {
            var ic = d.level === 'error' ? 'warn' : (d.level === 'warn' ? 'warn' : 'info');
            return '<div class="ce-diag-item ' + (d.level || 'info') + '">'
                + '<span class="ce-diag-icon">' + icon(ic, 14) + '</span>'
                + '<span>' + E.escapeHtml(d.message) + '</span></div>';
        }).join('') + '</div>';
    }

    /* ================= 数据备份：导出 / 导入 / 重置 ================= */
    /**
     * @param {Object} opts
     *   exportName  导出文件名前缀
     *   onImported  导入成功后的回调 (report) => void
     *   confirmText 导入前的确认文案
     */
    function exportBackup(exportName) {
        try {
            DB.downloadBundle((exportName || '成本参数库备份') + '_' + E.timestamp() + '.json');
            toast('参数库已导出，请妥善保存', 'success');
        } catch (e) {
            toast('导出失败：' + e.message, 'error', 4000);
        }
    }

    function importBackup(onImported) {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = function () {
            var file = input.files && input.files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function () {
                var bundle;
                try { bundle = JSON.parse(reader.result); }
                catch (e) { toast('文件不是有效的 JSON', 'error'); return; }

                var summary = describeBundle(bundle);
                if (!confirm('即将导入参数库备份：\n\n' + summary + '\n\n导入方式为「合并」（同牌号覆盖，不会删除你本地已有的其他数据）。\n确认继续？')) return;

                var res = DB.importBundle(bundle, { mode: 'merge' });
                if (!res.ok) {
                    alert('导入失败：\n\n' + res.errors.join('\n'));
                    return;
                }
                toast('参数库导入成功', 'success');
                if (typeof onImported === 'function') onImported(res);
            };
            reader.readAsText(file, 'utf-8');
        };
        input.click();
    }

    function describeBundle(b) {
        var lines = [];
        if (!b || typeof b !== 'object') return '（无法识别）';
        lines.push('导出时间：' + (b.exportedAt || '未知'));
        lines.push('数据版本：' + (b.schemaVersion || '未知'));
        var stores = b.stores || {};
        Object.keys(stores).forEach(function (k) {
            var n = Array.isArray(stores[k]) ? stores[k].length : 0;
            if (n) lines.push('  · ' + ((DB.SCHEMAS[k] && DB.SCHEMAS[k].label) || k) + '：' + n + ' 条');
        });
        return lines.join('\n');
    }

    /** 一键把导出/导入按钮插到指定容器 */
    function mountBackupButtons(container, opts) {
        if (!container) return;
        opts = opts || {};
        var wrap = document.createElement('div');
        wrap.className = 'ce-toolbar';
        wrap.innerHTML =
            '<button class="ce-btn outline small" data-ce="export-backup">' + icon('download', 14) + ' 导出备份</button>'
            + '<button class="ce-btn outline small" data-ce="import-backup">' + icon('upload', 14) + ' 导入备份</button>';
        container.appendChild(wrap);
        wrap.querySelector('[data-ce="export-backup"]').onclick = function () { exportBackup(opts.exportName); };
        wrap.querySelector('[data-ce="import-backup"]').onclick = function () {
            importBackup(function () {
                if (typeof opts.onImported === 'function') opts.onImported();
                else location.reload();
            });
        };
    }

    /* ================= 意见反馈 ================= */
    /**
     * 读取 cost-config.js 里的渠道配置。
     * 全部留空时，弹窗会自动降级为「只有复制按钮」。
     */
    function feedbackConfig() {
        var c = (typeof window !== 'undefined' && window.COST_TOOL_CONFIG) || {};
        return {
            email: c.feedbackEmail || '',
            formUrl: c.feedbackFormUrl || '',
            formLabel: c.feedbackFormLabel || '在线表单',
            wechat: c.feedbackWechat || '',
            wechatQr: c.feedbackWechatQr || '',
            authorName: c.authorName || ''
        };
    }

    function hasFeedbackChannel(cfg) {
        return !!(cfg.email || cfg.formUrl || cfg.wechat || cfg.wechatQr);
    }

    /**
     * 打开意见反馈弹窗。
     *
     * 设计前提：本工具是纯前端应用、没有服务器，**无法自动收集反馈**。
     * 所以这里做的是「帮用户把内容整理好，并给出能发出去的渠道」，
     * 而不是假装提交成功（旧版把反馈写进用户自己的 localStorage，
     * 作者永远收不到，那是自欺欺人）。
     *
     * @param {Object} opts { context: 环境信息字符串, subjectPrefix: 邮件主题前缀 }
     */
    function openFeedbackDialog(opts) {
        opts = opts || {};
        var cfg = feedbackConfig();
        var configured = hasFeedbackChannel(cfg);
        var context = opts.context || buildContext({});

        var old = document.getElementById('ceFeedbackModal');
        if (old) old.remove();

        var modal = document.createElement('div');
        modal.id = 'ceFeedbackModal';
        modal.className = 'ce-backdrop';
        modal.innerHTML =
            '<div class="ce-modal ce-modal-sm">'
            + '  <div class="ce-modal-head">'
            + '    <h3>✉️ 意见反馈</h3>'
            + '    <button class="ce-btn outline small" data-ce="close">✕</button>'
            + '  </div>'
            + '  <div class="ce-modal-body">'
            + (configured
                ? '<p class="ce-modal-tip">这个工具是纯前端应用、<b>没有服务器</b>，所以无法自动提交。'
                  + '请把下面的内容通过任一渠道发给作者' + (cfg.authorName ? '（' + E.escapeHtml(cfg.authorName) + '）' : '')
                  + ' —— 你的反馈会直接决定下一步做什么改进。</p>'
                : '<p class="ce-modal-tip">这个工具是纯前端应用、<b>没有服务器</b>，无法自动提交反馈；'
                  + '<b>作者还没有配置接收渠道</b>。你可以先复制下面的内容，通过已知的方式联系作者。</p>')
            + '    <textarea id="ceFeedbackText" class="ce-textarea" rows="7" spellcheck="false"></textarea>'
            + '    <div class="ce-modal-actions" id="ceFeedbackActions"></div>'
            + '    <div id="ceFeedbackExtra"></div>'
            + '  </div>'
            + '  <div class="ce-modal-foot">'
            + '    <button class="ce-btn outline small" data-ce="history">📋 本机反馈记录</button>'
            + '    <div><button class="ce-btn outline" data-ce="cancel">关闭</button></div>'
            + '  </div>'
            + '</div>';
        document.body.appendChild(modal);

        var ta = modal.querySelector('#ceFeedbackText');
        ta.value = '【我的建议 / 遇到的问题】\n\n\n\n'
            + '──────────── 以下信息请保留，便于定位问题 ────────────\n'
            + context;

        var extra = modal.querySelector('#ceFeedbackExtra');

        function close() { modal.remove(); }
        modal.querySelector('[data-ce="close"]').onclick = close;
        modal.querySelector('[data-ce="cancel"]').onclick = close;
        modal.addEventListener('click', function (e) { if (e.target === modal) close(); });

        modal.querySelector('[data-ce="history"]').onclick = viewFeedback;

        // ---- 渠道按钮 ----
        var actions = modal.querySelector('#ceFeedbackActions');

        function addBtn(label, cls, fn) {
            var b = document.createElement('button');
            b.className = 'ce-btn ' + (cls || 'outline') + ' small';
            b.textContent = label;
            b.onclick = fn;
            actions.appendChild(b);
            return b;
        }

        addBtn('📋 复制内容', 'primary', function () {
            var ok = copyText(ta.value);
            rememberFeedback(ta.value);
            toast(ok ? '已复制到剪贴板，粘贴发送即可' : '复制失败，请手动选中文本复制',
                ok ? 'success' : 'error', 3200);
        });

        if (cfg.formUrl) {
            addBtn('📝 打开' + cfg.formLabel, 'outline', function () {
                copyText(ta.value);
                rememberFeedback(ta.value);
                window.open(cfg.formUrl, '_blank', 'noopener');
                toast('表单已在新窗口打开，内容已复制到剪贴板', 'success', 3600);
            });
        }

        if (cfg.wechat || cfg.wechatQr) {
            addBtn('💬 加微信发送', 'outline', function () {
                var ok = copyText(ta.value);
                rememberFeedback(ta.value);
                extra.innerHTML = '<div class="ce-wechat-box">'
                    + '<div class="ce-wechat-title">内容已复制' + (ok ? '' : '（复制失败，请手动选择文本）') + '，加微信后粘贴发送：</div>'
                    + (cfg.wechat ? '<div class="ce-wechat-id">微信号：<b>' + E.escapeHtml(cfg.wechat) + '</b></div>' : '')
                    + (cfg.wechatQr ? '<img class="ce-wechat-qr" src="' + E.escapeHtml(cfg.wechatQr) + '" alt="微信二维码">' : '')
                    + '</div>';
            });
        }

        if (cfg.email) {
            addBtn('✉️ 用邮件发送', 'outline', function () {
                rememberFeedback(ta.value);
                var subject = encodeURIComponent(opts.subjectPrefix || '[汽车成本工具反馈]');
                window.location.href = 'mailto:' + cfg.email + '?subject=' + subject
                    + '&body=' + encodeURIComponent(ta.value);
            });
        }

        // 兜底提示
        if (!configured) {
            extra.innerHTML = '<div class="ce-diag-item info" style="margin-top:10px;">'
                + '<span class="ce-diag-icon">' + icon('info', 14) + '</span>'
                + '<span>部署者可在 <code>assets/cost-config.js</code> 里填写反馈表单链接、微信号或邮箱，'
                + '填好后这里会自动出现对应按钮。</span></div>';
        }
    }

    /** 本地留一份，方便「本机反馈记录」回看（不是提交，只是本地台账） */
    function rememberFeedback(text) {
        try {
            var list = DB.state('feedback') || [];
            list.unshift({ time: new Date().toLocaleString(), content: text });
            DB.state('feedback', list.slice(0, 200));
        } catch (e) { /* 忽略 */ }
    }

    /** 兼容旧调用 */
    function collectFeedback(opts) { openFeedbackDialog(opts); }

    function copyText(text) {
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            var ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch (e) { return false; }
    }

    /**
     * 查看「本机反馈台账」—— 注意这只是本地留存，**不是已提交的记录**。
     * 作者不会收到任何东西，除非用户主动通过渠道发出去。
     */
    function viewFeedback() {
        var list = DB.state('feedback') || [];
        if (!list.length) { toast('本机暂无反馈记录', 'error'); return; }
        var text = list.map(function (f) { return '【' + f.time + '】\n' + f.content; })
            .join('\n\n────────────────────\n\n');
        var ok = copyText(text);
        toast('本机共 ' + list.length + ' 条留存记录，' + (ok ? '已复制到剪贴板' : '复制失败，请手动查看'),
            ok ? 'success' : 'error', 3600);
    }

    function buildContext(info) {
        var parts = [];
        parts.push('引擎版本：' + (E.VERSION || '?'));
        parts.push('参数库版本：' + (DB.VERSION || '?'));
        Object.keys(info || {}).forEach(function (k) { parts.push(k + '：' + info[k]); });
        parts.push('时间：' + new Date().toLocaleString());
        return parts.join('\n');
    }

    /* ================= 费率预设选择器 ================= */
    /**
     * 在容器里渲染「地区 × 自动化水平」费率预设下拉框。
     * 预设只改费率类参数，不覆盖客户的参数库。
     * @param {HTMLElement} container
     * @param {Object} opts { scope:'injection'|'stamping', onApplied(id) }
     */
    function mountPresetPicker(container, opts) {
        if (!container) return;
        opts = opts || {};
        var current = DB.getPreset(opts.scope);
        if (!DB.PRESETS[current.id]) current = { id: 'east_std', preset: DB.PRESETS.east_std };

        container.innerHTML =
            '<label>费率预设（地区 × 自动化水平）</label>'
            + '<select id="cePresetSelect">'
            + DB.PRESET_ORDER.map(function (id) {
                var p = DB.PRESETS[id];
                return '<option value="' + id + '"' + (id === current.id ? ' selected' : '') + '>'
                    + E.escapeHtml(p.name) + '</option>';
            }).join('')
            + '</select>'
            + '<div class="info-tip" id="cePresetDesc">' + E.escapeHtml(current.preset.desc) + '</div>'
            + '<div class="info-tip" id="cePresetValues"></div>';

        function renderValues() {
            var s = DB.settings(opts.scope).get();
            var el = document.getElementById('cePresetValues');
            if (!el) return;
            el.innerHTML = '当前：人工 ' + E.num(s.laborRate) + ' 元/h'
                + ' · 设备费率 ×' + E.num(s.equipmentRateFactor, 1).toFixed(2)
                + ' · 模具价 ×' + E.num(s.moldPriceFactor, 1).toFixed(2)
                + ' · 管理费 ' + E.pct(s.managementRate, 0)
                + ' · 利润 ' + E.pct(s.profitRate, 0)
                + (s.blankUtilization !== undefined ? ' · 下料利用率 ' + E.num(s.blankUtilization) + '%' : '');
        }
        renderValues();

        container.querySelector('#cePresetSelect').onchange = function () {
            var id = this.value;
            var next = DB.applyPreset(opts.scope, id);
            if (!next) return;
            var desc = document.getElementById('cePresetDesc');
            if (desc) desc.textContent = DB.PRESETS[id].desc;
            renderValues();
            toast('已套用「' + DB.PRESETS[id].name + '」', 'success');
            if (typeof opts.onApplied === 'function') opts.onApplied(id, next);
        };

        // 供外部在手动改费率后刷新显示
        return { refresh: renderValues };
    }

    /* ================= 材料价格批量导入 ================= */
    /**
     * 打开价格批量导入弹窗：粘贴 → 预览匹配 → 确认更新。
     * @param {Object} opts
     *   table / codeField / priceField  默认 materials / code / unitPrice
     *   title / codeLabel / priceLabel  文案
     *   newKind / newDensity            新增未匹配项时的默认值
     *   onDone(report)                  应用成功后的回调
     */
    function openPriceImport(opts) {
        opts = opts || {};
        var table = opts.table || 'materials';
        var schema = DB.SCHEMAS[table];
        if (!schema) { toast('未知的数据表：' + table, 'error'); return; }
        var codeField = opts.codeField || schema.primary;
        var priceField = opts.priceField || 'unitPrice';
        var priceLabel = opts.priceLabel || '单价';
        var codeLabel = opts.codeLabel || '牌号';

        var old = document.getElementById('cePriceImportModal');
        if (old) old.remove();

        var modal = document.createElement('div');
        modal.id = 'cePriceImportModal';
        modal.className = 'ce-backdrop';
        modal.innerHTML =
            '<div class="ce-modal">'
            + '  <div class="ce-modal-head">'
            + '    <h3>📥 批量导入' + E.escapeHtml(priceLabel) + '</h3>'
            + '    <button class="ce-btn outline small" data-ce="close">✕</button>'
            + '  </div>'
            + '  <div class="ce-modal-body">'
            + '    <p class="ce-modal-tip">一行一条，格式 <b>' + E.escapeHtml(codeLabel) + ',单价</b>。'
            + '也支持制表符 / 分号分隔，第三列可写数据来源（如 <code>2026-03 采购询价</code>）。'
            + '表头行与 <code>#</code> 开头的注释会自动跳过。<b>单价请不要加千分位逗号。</b></p>'
            + '    <textarea id="cePriceInput" class="ce-textarea" rows="9" spellcheck="false"'
            + '      placeholder="DC01,5.8,2026-03 采购询价&#10;Q235A,3.6&#10;SPCC,5.5,我的钢铁网"></textarea>'
            + '    <div class="ce-modal-actions">'
            + '      <button class="ce-btn outline small" data-ce="template">⬇️ 下载模板（含当前' + E.escapeHtml(codeLabel) + '）</button>'
            + '      <button class="ce-btn outline small" data-ce="load">📋 载入当前价</button>'
            + '      <button class="ce-btn primary small" data-ce="preview">🔍 预览匹配</button>'
            + '    </div>'
            + '    <div id="cePricePreview" class="ce-preview"></div>'
            + '  </div>'
            + '  <div class="ce-modal-foot">'
            + '    <label class="ce-check"><input type="checkbox" id="ceAddUnmatched"> 未匹配的' + E.escapeHtml(codeLabel) + '作为新记录添加</label>'
            + '    <div>'
            + '      <button class="ce-btn outline" data-ce="cancel">取消</button>'
            + '      <button class="ce-btn success" data-ce="apply" disabled>✅ 确认更新</button>'
            + '    </div>'
            + '  </div>'
            + '</div>';
        document.body.appendChild(modal);

        var input = modal.querySelector('#cePriceInput');
        var preview = modal.querySelector('#cePricePreview');
        var applyBtn = modal.querySelector('[data-ce="apply"]');
        var addChk = modal.querySelector('#ceAddUnmatched');

        function close() { modal.remove(); }
        modal.querySelector('[data-ce="close"]').onclick = close;
        modal.querySelector('[data-ce="cancel"]').onclick = close;
        modal.addEventListener('click', function (e) { if (e.target === modal) close(); });

        modal.querySelector('[data-ce="template"]').onclick = function () {
            var csv = DB.buildPriceTemplate(table, { codeField: codeField, priceField: priceField, codeLabel: codeLabel, priceLabel: priceLabel });
            E.downloadBlob('价格表模板_' + E.timestamp() + '.csv',
                new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
            toast('模板已下载：改完单价再粘回来即可', 'success', 3200);
        };

        modal.querySelector('[data-ce="load"]').onclick = function () {
            input.value = DB.buildPriceTemplate(table, { codeField: codeField, priceField: priceField, codeLabel: codeLabel, priceLabel: priceLabel });
            toast('已载入当前价，直接改数字即可', 'success');
        };

        function runPreview() {
            var text = input.value;
            if (!text.trim()) { toast('请先粘贴价格数据', 'error'); return null; }
            var r = DB.importPriceList(text, { table: table, codeField: codeField, priceField: priceField });
            if (!r.ok) { toast(r.error, 'error'); return null; }

            var html = '';
            html += '<div class="ce-preview-stats">'
                + '<span class="ce-pill ok">匹配 ' + r.matched.length + '</span>'
                + '<span class="ce-pill warn">未匹配 ' + r.unmatched.length + '</span>'
                + '<span class="ce-pill err">错误 ' + r.parsed.errors.length + '</span>'
                + (r.parsed.skippedHeaders ? '<span class="ce-pill muted">跳过表头 ' + r.parsed.skippedHeaders + '</span>' : '')
                + '</div>';

            if (r.matched.length) {
                html += '<div class="ce-preview-title">价格变化</div><table class="ce-preview-table">'
                    + '<thead><tr><th>' + E.escapeHtml(codeLabel) + '</th><th>原价</th><th>新价</th><th>变化</th><th>来源</th></tr></thead><tbody>'
                    + r.matched.slice(0, 40).map(function (m) {
                        var d = m.delta;
                        var cls = d > 0 ? 'up' : (d < 0 ? 'down' : 'same');
                        var txt = (d > 0 ? '+' : '') + E.round(d, 3) + (m.oldPrice ? '（' + E.pct(d / m.oldPrice, 1) + '）' : '');
                        return '<tr><td>' + E.escapeHtml(m.code) + '</td><td>' + m.oldPrice + '</td><td><b>' + m.newPrice + '</b></td>'
                            + '<td class="' + cls + '">' + (d === 0 ? '不变' : txt) + '</td>'
                            + '<td>' + E.escapeHtml(m.source || '') + '</td></tr>';
                    }).join('')
                    + '</tbody></table>'
                    + (r.matched.length > 40 ? '<div class="ce-preview-more">仅显示前 40 条，共 ' + r.matched.length + ' 条</div>' : '');
            }

            if (r.unmatched.length) {
                html += '<div class="ce-preview-title">未匹配（参数库里没有这些' + E.escapeHtml(codeLabel) + '）</div>'
                    + '<div class="ce-preview-list">' + r.unmatched.slice(0, 20).map(function (u) {
                        return '<span class="ce-chip">' + E.escapeHtml(u.code) + ' = ' + u.price + '</span>';
                    }).join('') + (r.unmatched.length > 20 ? '<span class="ce-chip">…共 ' + r.unmatched.length + ' 个</span>' : '') + '</div>';
            }

            if (r.parsed.errors.length) {
                html += '<div class="ce-preview-title">无法解析的行</div>'
                    + '<div class="ce-preview-list">' + r.parsed.errors.slice(0, 12).map(function (e) {
                        return '<span class="ce-chip err">第 ' + e.line + ' 行：' + E.escapeHtml(e.reason) + '</span>';
                    }).join('') + (r.parsed.errors.length > 12 ? '<span class="ce-chip err">…共 ' + r.parsed.errors.length + ' 行</span>' : '') + '</div>';
            }

            preview.innerHTML = html;
            applyBtn.disabled = r.matched.length === 0;
            return r;
        }

        modal.querySelector('[data-ce="preview"]').onclick = runPreview;
        input.addEventListener('input', function () { applyBtn.disabled = true; preview.innerHTML = ''; });

        applyBtn.onclick = function () {
            var r = DB.importPriceList(input.value, {
                table: table, codeField: codeField, priceField: priceField,
                apply: true, addUnmatched: addChk.checked,
                newKind: opts.newKind, newDensity: opts.newDensity
            });
            if (!r.ok) { toast(r.error, 'error'); return; }
            close();
            toast('已更新 ' + r.changed + ' 条价格'
                + (r.matched.length - r.changed > 0 ? '（' + (r.matched.length - r.changed) + ' 条价格未变）' : '')
                + (r.added.length ? '，新增 ' + r.added.length + ' 条' : ''), 'success', 3600);
            if (typeof opts.onDone === 'function') opts.onDone(r);
        };
    }

    /* ================= 公共 API ================= */
    root.CostUI = {
        VERSION: '1.2.0',
        icon: icon,
        toast: toast,
        renderDiagnostics: renderDiagnostics,
        exportBackup: exportBackup,
        importBackup: importBackup,
        mountBackupButtons: mountBackupButtons,
        mountPresetPicker: mountPresetPicker,
        openPriceImport: openPriceImport,
        openFeedbackDialog: openFeedbackDialog,
        collectFeedback: collectFeedback,
        feedbackConfig: feedbackConfig,
        viewFeedback: viewFeedback,
        copyText: copyText,
        buildContext: buildContext
    };
}(typeof self !== 'undefined' ? self : this));
