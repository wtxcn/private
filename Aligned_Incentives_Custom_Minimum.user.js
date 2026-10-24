// ==UserScript==
// @name         Aligned Incentives - Custom Profit Filter
// @namespace    aligned-incentives-profit-filter
// @version      3.0
// @description  自定义最低利润门槛，支持负数、保存设置及动态页面筛选。
// @match        https://portal.alignedincentiv.es/Seller/Dashboard*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
    'use strict';

    const CONFIG = {"id": "tm-aligned-minimum", "title": "Aligned Incentives", "metric": "Profit"};
    const DEFAULTS = { minimum: 0, inclusive: true, enabled: true };
    const STORAGE_KEY = 'custom-minimum-filter-v1';
    const HIDDEN_CLASS = CONFIG.id + '-hidden';
    let hiddenElements = new Set();
    let timer = null;
    let ui = null;

    function normalize(text) {
        return String(text ?? '')
            .replace(/[\u00a0\u202f]/g, ' ')
            .replace(/[−–﹣－]/g, '-')
            .replace(/％/g, '%')
            .trim();
    }

    function parsePercent(text) {
        const match = normalize(text).match(
            /(\()?\s*([+-]?)\s*(\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)\s*%\s*(\))?/
        );
        if (!match) return null;
        const value = Number(match[3].replace(/,/g, ''));
        if (!Number.isFinite(value)) return null;
        return match[2] === '-' || (match[1] && match[4]) ? -value : value;
    }

    function parseMinimum(text) {
        const value = normalize(text).replace(/%$/, '').trim();
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function loadSettings() {
        try {
            const saved = GM_getValue(STORAGE_KEY, {});
            if (!saved || typeof saved !== 'object') return { ...DEFAULTS };
            return {
                minimum: typeof saved.minimum === 'number' && Number.isFinite(saved.minimum)
                    ? saved.minimum : DEFAULTS.minimum,
                inclusive: typeof saved.inclusive === 'boolean'
                    ? saved.inclusive : DEFAULTS.inclusive,
                enabled: typeof saved.enabled === 'boolean'
                    ? saved.enabled : DEFAULTS.enabled
            };
        } catch {
            return { ...DEFAULTS };
        }
    }

    let settings = loadSettings();

    function shouldShow(value) {
        return value !== null && Number.isFinite(value) &&
            (settings.inclusive ? value >= settings.minimum : value > settings.minimum);
    }

    // Restore only this script's filtering; preserve the site's own display styles.
    function commitHidden(nextHidden) {
        for (const element of hiddenElements) {
            if (!nextHidden.has(element)) element.classList.remove(HIDDEN_CLASS);
        }
        for (const element of nextHidden) {
            if (!element.classList.contains(HIDDEN_CLASS)) element.classList.add(HIDDEN_CLASS);
        }
        hiddenElements = nextHidden;
    }

    function updateBadge() {
        if (!ui) return;
        const minimum = Object.is(settings.minimum, -0) ? 0 : settings.minimum;
        ui.trigger.textContent = settings.enabled
            ? `${CONFIG.metric} ${settings.inclusive ? '≥' : '>'} ${minimum}% ⚙`
            : `${CONFIG.metric}：显示全部 ⚙`;
        ui.trigger.setAttribute('aria-expanded', String(!ui.panel.hidden));
    }

    function closeSettings() {
        if (!ui) return;
        ui.panel.hidden = true;
        updateBadge();
        ui.trigger.focus();
    }

    function openSettings() {
        mountSettings();
        if (!ui) return;
        ui.minimum.value = String(settings.minimum);
        ui.inclusive.checked = settings.inclusive;
        ui.enabled.checked = settings.enabled;
        ui.error.textContent = '';
        ui.panel.hidden = false;
        updateBadge();
        ui.minimum.focus();
        ui.minimum.select();
    }

    function mountSettings() {
        if (!document.body) return;
        if (ui) {
            if (!ui.host.isConnected) document.body.appendChild(ui.host);
            return;
        }
        const host = document.createElement('div');
        host.id = CONFIG.id + '-settings';
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <style>
                :host { all: initial; position: fixed; right: 18px; bottom: 18px;
                    z-index: 2147483600; font: 14px/1.5 system-ui, sans-serif; color: #172033; }
                *, *::before, *::after { box-sizing: border-box; }
                [hidden] { display: none !important; }
                button, input { font: inherit; }
                button { cursor: pointer; }
                .trigger { display: block; margin-left: auto; padding: 9px 13px;
                    border: 1px solid #cbd5e1; border-radius: 22px; background: #fff;
                    color: #172033; box-shadow: 0 2px 12px #17203324; }
                .panel { width: 310px; max-width: calc(100vw - 36px); padding: 18px;
                    margin-bottom: 10px; border: 1px solid #cbd5e1; border-radius: 12px;
                    background: #fff; box-shadow: 0 6px 24px #17203326; }
                h2 { font-size: 16px; line-height: 1.4; margin: 0 0 14px; }
                .label { display: block; margin-bottom: 5px; font-weight: 600; }
                .entry { display: flex; align-items: center; gap: 8px; }
                .minimum { min-width: 0; width: 100%; padding: 7px 9px; color: #172033;
                    background: #fff; border: 1px solid #94a3b8; border-radius: 6px; }
                .presets { display: flex; gap: 7px; margin: 10px 0 12px; }
                .presets button, .cancel { padding: 5px 10px; color: #172033;
                    border: 1px solid #cbd5e1; border-radius: 6px; background: #f8fafc; }
                .check { display: flex; gap: 7px; align-items: center; margin: 9px 0; }
                input[type=checkbox] { margin: 0; accent-color: #2563eb; }
                .hint { font-size: 12px; color: #526174; margin: 11px 0; }
                .error { font-size: 12px; color: #b42318; margin: 6px 0; }
                .error:empty { display: none; }
                .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
                .save { padding: 6px 12px; border: 1px solid #2563eb; border-radius: 6px;
                    background: #2563eb; color: #fff; }
            </style>
            <section class="panel" role="dialog" aria-label="最低利润门槛设置" hidden>
                <form>
                    <h2></h2>
                    <label class="label" for="minimum">最低利润门槛</label>
                    <div class="entry"><input class="minimum" id="minimum" type="text"
                        inputmode="decimal" autocomplete="off" spellcheck="false"
                        aria-describedby="minimum-hint" placeholder="例如 -0.5"><span>%</span></div>
                    <div class="presets">
                        <button type="button" data-minimum="-1">−1%</button>
                        <button type="button" data-minimum="-0.5">−0.5%</button>
                        <button type="button" data-minimum="0">0%</button>
                    </div>
                    <label class="check"><input class="inclusive" type="checkbox">
                        包含等于门槛的项目（≥）</label>
                    <label class="check"><input class="enabled" type="checkbox">启用筛选</label>
                    <p class="hint" id="minimum-hint">填写 −0.5 表示保留至少 −0.5% 的项目。
                        两个网站分别保存设置，刷新后仍有效。</p>
                    <p class="error" role="alert"></p>
                    <div class="actions"><button class="cancel" type="button">取消</button>
                        <button class="save" type="submit">保存并应用</button></div>
                </form>
            </section>
            <button class="trigger" type="button" aria-label="设置最低利润门槛"
                aria-haspopup="dialog" aria-expanded="false"></button>
        `;
        ui = {
            host,
            trigger: shadow.querySelector('.trigger'),
            panel: shadow.querySelector('.panel'),
            minimum: shadow.querySelector('.minimum'),
            inclusive: shadow.querySelector('.inclusive'),
            enabled: shadow.querySelector('.enabled'),
            error: shadow.querySelector('.error')
        };
        shadow.querySelector('h2').textContent = CONFIG.title + ' 筛选设置';
        ui.trigger.addEventListener('click', () => ui.panel.hidden ? openSettings() : closeSettings());
        shadow.querySelector('.cancel').addEventListener('click', closeSettings);
        for (const button of shadow.querySelectorAll('[data-minimum]')) {
            button.addEventListener('click', () => {
                ui.minimum.value = button.dataset.minimum;
                ui.error.textContent = '';
                ui.minimum.focus();
            });
        }
        shadow.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); closeSettings(); }
        });
        shadow.querySelector('form').addEventListener('submit', event => {
            event.preventDefault();
            const minimum = parseMinimum(ui.minimum.value);
            if (minimum === null) {
                ui.error.textContent = '请输入有效数字，例如 -0.5、-1 或 0。';
                ui.minimum.focus();
                return;
            }
            const next = { minimum, inclusive: ui.inclusive.checked, enabled: ui.enabled.checked };
            try {
                GM_setValue(STORAGE_KEY, next);
            } catch {
                ui.error.textContent = '设置未能保存，请检查 Tampermonkey 是否已启用。';
                return;
            }
            settings = next;
            clearTimeout(timer);
            timer = null;
            applyFilter();
            closeSettings();
        });
        document.body.appendChild(host);
        updateBadge();
    }


    function directDivs(cell) {
        return Array.from(cell.children).filter(child => child.tagName === 'DIV');
    }

    function collectHidden() {
        const hidden = new Set();
        for (const profitCell of document.querySelectorAll('tr > td.profit-column')) {
            const row = profitCell.parentElement;
            const profits = directDivs(profitCell);
            if (profits.length === 0) {
                if (!shouldShow(parsePercent(profitCell.textContent))) hidden.add(row);
                continue;
            }
            const keep = profits.map(item => shouldShow(parsePercent(item.textContent)));
            if (!keep.some(Boolean)) { hidden.add(row); continue; }

            const columnNames = ['line-capacity-column', 'brands-column',
                'buy-rate-column', 'profit-column'];
            const columns = columnNames.map(name =>
                Array.from(row.cells).find(cell => cell.classList.contains(name))
            );
            // Unknown layouts stay intact so brands, rates and profits cannot misalign.
            if (columns.some(cell => !cell)) continue;
            const entries = columns.map(directDivs);
            if (entries.some(items => items.length !== profits.length)) continue;
            for (const items of entries) {
                items.forEach((item, index) => { if (!keep[index]) hidden.add(item); });
            }
        }
        return hidden;
    }


    function applyFilter() {
        mountSettings();
        const nextHidden = settings.enabled ? collectHidden() : new Set();
        commitHidden(nextHidden);
        updateBadge();
    }

    function scheduleFilter() {
        if (timer !== null) return;
        timer = setTimeout(() => { timer = null; applyFilter(); }, 100);
    }

    const style = document.createElement('style');
    style.textContent = `.${HIDDEN_CLASS} { display: none !important; }`;
    (document.head || document.documentElement).appendChild(style);

    // Attribute changes are excluded so our hiding classes cannot trigger a loop.
    const observer = new MutationObserver(scheduleFilter);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('设置最低利润门槛…', openSettings);
    }
    applyFilter();
})();
