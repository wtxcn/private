// ==UserScript==
// @name         Monarch 定时 Refresh all
// @namespace    local.monarch.auto-refresh
// @version      1.0.8
// @description  每天 05:00 起每 3 小时进入 Accounts 并点击 Refresh all（America/Chicago）。
// @homepageURL  https://github.com/wtxcn/private/blob/main/monarch-auto-refresh/README.md
// @downloadURL  https://raw.githubusercontent.com/wtxcn/private/main/MonarchAutoRefresher.user.js
// @updateURL    https://raw.githubusercontent.com/wtxcn/private/main/MonarchAutoRefresher.user.js
// @match        https://app.monarch.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
  'use strict';

  // 固定使用美国中部时间，自动处理夏令时。若需更换时区，修改这里。
  const TIME_ZONE = 'America/Chicago';
  const HOURS = [5, 8, 11, 14, 17, 20, 23]; // 不包含凌晨 02:00。
  const GRACE_MINUTES = 10; // 迟到不足 10 分钟仍执行；再晚则跳过。
  const CHECK_EVERY_MS = 15_000;
  const MIN_GAP_MS = 170 * 60_000;
  const STORAGE_KEY = 'monarch-auto-refresh:last-attempt:v1';
  const LOCK_NAME = 'monarch-auto-refresh:v1';
  const ACCOUNTS_HEARTBEAT_KEY = 'monarch-auto-refresh:accounts-heartbeat:v1';
  const NAVIGATION_KEY = 'monarch-auto-refresh:navigation:v1';
  const HISTORY_KEY = 'monarch-auto-refresh:history:v1';
  const POSITION_KEY = 'monarch-auto-refresh:widget-position:v1';
  const HEARTBEAT_TTL_MS = 45_000;
  const NAVIGATION_TTL_MS = 45_000;
  const CONFIRM_TIMEOUT_MS = 10 * 60_000;
  // 只暴露脚本版本和通用运行状态，供安装检查使用，不包含账户信息。
  document.documentElement.setAttribute('data-monarch-auto-refresh-version', '1.0.8');
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let running = false;
  let lastMessage = '';
  let statusButton;
  let expanded = false;
  let monitor = null;
  let drag = null;
  let suppressClickUntil = 0;

  function onAccountsPage() {
    return /^\/accounts\/?$/.test(location.pathname);
  }

  function timeParts(now) {
    return Object.fromEntries(format.formatToParts(now).map(x => [x.type, x.value]));
  }

  function nextScheduleLabel(now, last = null) {
    const p = timeParts(now);
    const currentSlot = scheduledSlot(now);
    if (currentSlot && last?.slot !== currentSlot) {
      return `${p.year}-${p.month}-${p.day} ${p.hour}:00（中部，当前窗口）`;
    }
    const nextHour = HOURS.find(hour => hour > Number(p.hour));
    const day = new Date(Date.UTC(Number(p.year), Number(p.month) - 1,
      Number(p.day) + (nextHour === undefined ? 1 : 0)));
    return `${day.toISOString().slice(0, 10)} ${String(nextHour ?? HOURS[0]).padStart(2, '0')}:00（中部）`;
  }

  function log(message) {
    if (message === lastMessage) return;
    lastMessage = message;
    document.documentElement.setAttribute('data-monarch-auto-refresh-status', message);
    console.info('[Monarch Auto Refresh]', message);
  }

  function scheduledSlot(now) {
    const p = timeParts(now);
    if (!HOURS.includes(Number(p.hour)) || Number(p.minute) >= GRACE_MINUTES) return null;
    return `${TIME_ZONE}:${p.year}-${p.month}-${p.day}T${p.hour}:00`;
  }

  function readLast() {
    // 存储不可用或损坏时由调用者停止本轮，避免失去去重保护后反复刷新。
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw);
    if (!value || typeof value.slot !== 'string' || !Number.isFinite(value.at)) {
      throw new Error('刷新记录格式异常，请先检查浏览器站点存储。');
    }
    return value;
  }

  function readTimestamp(key) {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const value = JSON.parse(raw);
    if (!value || !Number.isFinite(value.at)) throw new Error('跨标签协调记录格式异常。');
    return value;
  }

  function readHistory() {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw === null) return [];
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) throw new Error('刷新日志格式异常。');
    return entries;
  }

  function normalizeHistory() {
    const last = readLast();
    if (!last) return;
    const history = readHistory();
    const entry = history.find(item => item.slot === last.slot);
    if (!entry || entry.at === last.at) return;
    // 旧版把状态判定时间覆盖了点击时间；恢复为刷新记录中的实际点击时间。
    if (entry.outcome === 'confirmed' || entry.outcome === 'unconfirmed') entry.resultAt = entry.at;
    entry.at = last.at;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }

  function recordOutcome(slot, at, outcome) {
    const history = readHistory();
    const prior = history.find(entry => entry.slot === slot);
    const last = readLast();
    const clickedAt = last?.slot === slot ? last.at : prior?.at ?? at;
    const entry = { slot, at: clickedAt, outcome };
    if (outcome === 'confirmed' || outcome === 'unconfirmed') entry.resultAt = at;
    history.splice(0, history.length, entry, ...history.filter(item => item.slot !== slot));
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 30)));
    document.documentElement.setAttribute('data-monarch-auto-refresh-outcome', outcome);
    if (outcome === 'confirmed' || outcome === 'unconfirmed') {
      const last = readLast();
      if (last?.slot === slot) {
        last.result = outcome;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(last));
      }
    }
  }

  function syncCompleteVisible() {
    const notices = document.querySelectorAll(
      '[class*="RefreshProgressToast__Root"], [role="status"], [role="alert"], [data-sonner-toast]');
    return Array.from(notices).some(element => isVisible(element)
      && /sync complete/i.test(element.textContent || '')
      && /accounts are up to date/i.test(element.textContent || ''));
  }

  function checkSyncResult() {
    if (!monitor) return;
    const last = readLast();
    if (last?.slot === monitor.slot && last.result) { monitor = null; return; }
    const now = Date.now();
    const visible = syncCompleteVisible();
    if (!visible) monitor.sawAbsent = true;
    if (visible && monitor.sawAbsent) {
      recordOutcome(monitor.slot, now, 'confirmed');
      log(`${monitor.slot}：Monarch 显示 Sync complete / All accounts are up to date。`);
      monitor = null;
    } else if (now - monitor.at >= CONFIRM_TIMEOUT_MS) {
      recordOutcome(monitor.slot, now, 'unconfirmed');
      log(`${monitor.slot}：已点击，但 10 分钟内未观察到 Monarch 同步完成提示。`);
      monitor = null;
    }
  }

  function startSyncMonitor(slot, at, sawAbsent) {
    monitor = { slot, at, sawAbsent };
    if (typeof MutationObserver === 'function') {
      const observer = new MutationObserver(() => {
        try { checkSyncResult(); } catch (error) { log(`同步状态检查失败：${error.message}`); }
        if (!monitor) observer.disconnect();
      });
      observer.observe(document.body || document.documentElement,
        { childList: true, characterData: true, subtree: true });
    }
  }

  function reconcilePendingOutcome() {
    if (monitor) return;
    const last = readLast();
    if (!last || last.status !== 'clicked' || last.result) return;
    const newest = readHistory()[0];
    if (newest?.slot !== last.slot || newest.outcome !== 'clicked') return;
    if (Date.now() - last.at >= CONFIRM_TIMEOUT_MS) {
      recordOutcome(last.slot, Date.now(), 'unconfirmed');
    } else if (onAccountsPage()) {
      startSyncMonitor(last.slot, last.at, false);
    }
  }

  function recent(record, now, ttl) {
    return record && record.at <= now && now - record.at < ttl;
  }

  function modalOpen() {
    return Array.from(document.querySelectorAll('[aria-modal="true"], dialog[open]')).some(isVisible);
  }

  function editing() {
    const active = document.activeElement;
    return !!active && (active.matches('input, textarea, select, [contenteditable="true"]')
      || !!active.closest('[contenteditable="true"]'));
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden'
      && style.visibility !== 'collapse'
      && Array.from(element.getClientRects()).some(r => r.width > 0 && r.height > 0);
  }

  function findButton() {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const matches = buttons.filter(element => {
      const name = (element.getAttribute('aria-label') || element.innerText || element.textContent || '')
        // Monarch 的图标字体会在 innerText 中插入私用区字符；它不是按钮名称。
        .replace(/[\uE000-\uF8FF]/g, '')
        .replace(/\s+/g, ' ').trim();
      return /^refresh all$/i.test(name) && isVisible(element)
        && !element.matches(':disabled')
        && element.getAttribute('aria-disabled') !== 'true'
        && element.getAttribute('aria-busy') !== 'true'
        && !element.closest('[inert]');
    });
    // 只允许唯一匹配，避免网站改版后误点其他按钮。
    return matches.length === 1 ? matches[0] : null;
  }

  function pageStatus() {
    if (!onAccountsPage()) return '计划窗口内若没有可用的 Accounts 标签，将自动进入 Accounts 再刷新。';
    if (!navigator.locks?.request) return '账户列表页暂不可执行：浏览器缺少 Web Locks。';
    if (!navigator.onLine) return '账户列表页暂离线：联网后才能执行。';
    if (modalOpen()) return '账户列表页有弹窗：关闭后才能执行。';
    return findButton()
      ? '此账户列表页可自动刷新（仅在计划窗口内）。'
      : '账户列表页按钮未就绪：请检查登录、同步状态或按钮。';
  }

  function renderWidget(page, lastLabel, next) {
    const brief = !onAccountsPage() ? '到点进入 Accounts'
      : page.startsWith('此账户') ? '可自动刷新' : '暂不可刷新';
    statusButton.style.cssText = 'position:fixed;z-index:2147483000;'
      + 'border:1px solid #cbd5e1;border-radius:12px;background:#f8fafc;color:#0f172a;'
      + 'box-shadow:0 2px 8px #0003;cursor:grab;touch-action:none;'
      + 'font:12px/1.5 system-ui,sans-serif;text-align:left;white-space:pre-line;'
      + (expanded ? 'width:300px;max-height:260px;overflow:auto;padding:10px;' :
        'width:38px;height:38px;padding:0;text-align:center;font-size:24px;');
    try {
      const position = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null');
      if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
        statusButton.style.left = `${Math.max(0, Math.min(position.x, window.innerWidth - (expanded ? 300 : 38)))}px`;
        statusButton.style.top = `${Math.max(0, Math.min(position.y, window.innerHeight - (expanded ? 260 : 38)))}px`;
      } else {
        statusButton.style.right = '10px';
        statusButton.style.bottom = '175px';
      }
    } catch {
      statusButton.style.right = '10px';
      statusButton.style.bottom = '175px';
    }
    if (!expanded) {
      statusButton.textContent = '↻';
      statusButton.title = `Monarch 自动刷新 · ${brief}。点击展开，拖动可移动。`;
      return;
    }
    let historyLabel = '暂无刷新记录';
    try {
      const labels = { confirmed: 'Monarch 显示同步完成',
        unconfirmed: '已点击，未确认完成', attempted: '已记录尝试',
        click_error: '按钮点击报错' };
      historyLabel = readHistory().slice(0, 10).map(entry => {
        const label = entry.outcome === 'clicked'
          ? Date.now() - entry.at < CONFIRM_TIMEOUT_MS
            ? '已点击，等待同步结果' : '旧记录：已点击，结果未记录'
          : labels[entry.outcome] || entry.outcome;
        return `${format.format(new Date(entry.at))} ${label}`;
      })
        .join('\n') || historyLabel;
    } catch { historyLabel = '日志读取异常'; }
    statusButton.textContent = `↻ Monarch 自动刷新 · ${brief}\n最近：${lastLabel}\n下次：${next}`
      + `\n\n刷新日志（最近 10 条）\n${historyLabel}\n\n点击收起 · 拖动移动`;
    statusButton.title = `${page}\n“Monarch 显示同步完成”只表示页面给出完成提示。`;
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    const rect = statusButton.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
    statusButton.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event) {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) < 5 && !drag.moved) return;
    drag.moved = true;
    statusButton.style.right = 'auto';
    statusButton.style.bottom = 'auto';
    statusButton.style.left = `${Math.max(0, Math.min(drag.left + dx, window.innerWidth - (expanded ? 300 : 38)))}px`;
    statusButton.style.top = `${Math.max(0, Math.min(drag.top + dy, window.innerHeight - (expanded ? 260 : 38)))}px`;
  }

  function onPointerUp() {
    if (!drag) return;
    if (drag.moved) {
      suppressClickUntil = Date.now() + 500;
      try { localStorage.setItem(POSITION_KEY, JSON.stringify({
        x: parseFloat(statusButton.style.left), y: parseFloat(statusButton.style.top),
      })); } catch (error) { log(`图标位置保存失败：${error.message}`); }
    }
    drag = null;
  }

  function updateDiagnostics(now) {
    const root = document.documentElement;
    const page = pageStatus();
    let last = null;
    let lastLabel = '暂无脚本尝试';
    try {
      last = readLast();
      if (last) {
        const status = last.result === 'confirmed' ? '页面显示同步完成'
          : last.result === 'unconfirmed' ? '已点击，未确认完成'
            : last.status === 'clicked' ? '已调用点击' : '已记录尝试';
        lastLabel = `${format.format(new Date(last.at))} ${status}`;
      }
    } catch {
      lastLabel = '记录读取异常，点击查看诊断';
    }
    root.setAttribute('data-monarch-auto-refresh-last-check', now.toISOString());
    root.setAttribute('data-monarch-auto-refresh-page', onAccountsPage() ? 'accounts' : 'other');
    root.setAttribute('data-monarch-auto-refresh-page-status', page);
    // 只公开本脚本的尝试记录，不读取或展示 Monarch 账户数据。
    root.setAttribute('data-monarch-auto-refresh-last-attempt', JSON.stringify(last
      ? { slot: last.slot, at: last.at, status: last.status === 'clicked' ? 'clicked' : 'attempted' }
      : null));
    root.setAttribute('data-monarch-auto-refresh-outcome', last?.result ||
      (last?.status === 'clicked' ? 'clicked' : last ? 'attempted' : 'none'));
    const next = nextScheduleLabel(now, last);
    root.setAttribute('data-monarch-auto-refresh-next-schedule', next);
    if (!statusButton || !statusButton.isConnected) {
      statusButton = document.createElement('button');
      statusButton.id = 'monarch-auto-refresh-status-button';
      statusButton.type = 'button';
      statusButton.setAttribute('aria-label', 'Monarch 自动刷新状态与日志，点击展开或收起');
      statusButton.addEventListener('click', () => {
        if (Date.now() < suppressClickUntil) return;
        expanded = !expanded;
        updateDiagnostics(new Date());
      });
      statusButton.addEventListener('pointerdown', onPointerDown);
      statusButton.addEventListener('pointermove', onPointerMove);
      statusButton.addEventListener('pointerup', onPointerUp);
      statusButton.addEventListener('pointercancel', onPointerUp);
      (document.body || root).appendChild(statusButton);
    }
    renderWidget(page, lastLabel, next);
  }

  async function tick() {
    const checkTime = new Date();
    try { reconcilePendingOutcome(); } catch (error) { log(`日志恢复失败：${error.message}`); }
    try { checkSyncResult(); } catch (error) { log(`同步状态检查失败：${error.message}`); }
    updateDiagnostics(checkTime);
    if (running) return;
    // 只有可执行的 Accounts 标签才报活；其他标签会优先把刷新交给它。
    if (onAccountsPage() && pageStatus().startsWith('此账户')) {
      try { localStorage.setItem(ACCOUNTS_HEARTBEAT_KEY, JSON.stringify({ at: checkTime.getTime() })); }
      catch (error) { log(`状态记录失败：${error.message}`); return; }
    }
    const slot = scheduledSlot(checkTime);
    if (!slot) {
      log('当前不在计划时点后的 10 分钟窗口；等待下次计划，不补刷。');
      return;
    }
    if (!navigator.locks?.request) {
      log('缺少 Web Locks 支持，未刷新。请使用最新版 Chrome / Edge / Firefox。');
      return;
    }
    running = true;
    try {
      // 同一浏览器配置中的多个 Monarch 标签共享锁和刷新记录。
      await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, lock => {
        if (!lock) return;
        const now = Date.now();
        if (scheduledSlot(new Date(now)) !== slot) return;
        const last = readLast();
        if (last?.slot === slot) return;
        if (last && now - last.at < MIN_GAP_MS) {
          log('距上次脚本刷新不足 170 分钟，本轮跳过。');
          return;
        }
        if (!navigator.onLine) {
          log('当前离线；会在本次 10 分钟窗口内继续检查。');
          return;
        }
        if (!onAccountsPage()) {
          if (recent(readTimestamp(ACCOUNTS_HEARTBEAT_KEY), now, HEARTBEAT_TTL_MS)) {
            log('已有可用的 Accounts 标签；由该标签执行刷新。');
            return;
          }
          if (recent(readTimestamp(NAVIGATION_KEY), now, NAVIGATION_TTL_MS)) {
            log('另一标签正在前往 Accounts；等待它执行。');
            return;
          }
          if (modalOpen() || editing()) {
            log('当前页面正在编辑或有弹窗；为避免丢失内容，本次暂不切换。');
            return;
          }
          localStorage.setItem(NAVIGATION_KEY, JSON.stringify({ at: now }));
          log('计划时间已到：正在进入 Accounts，随后点击 Refresh all。');
          try { location.assign('/accounts?chartType=performance&timeframe=month'); }
          catch (error) {
            localStorage.removeItem(NAVIGATION_KEY);
            throw error;
          }
          return;
        }
        const button = modalOpen() ? null : findButton();
        if (!button) {
          log('未找到唯一可点击的 Refresh all（可能未登录、正在同步或有弹窗）；窗口内继续检查。');
          return;
        }
        // 点击前记为已尝试：即使页面重载或服务器报错，本时点也不会重复请求。
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ slot, at: now, status: 'attempted' }));
        recordOutcome(slot, now, 'attempted');
        const completeWasVisible = syncCompleteVisible();
        try { button.click(); }
        catch (error) {
          recordOutcome(slot, now, 'click_error');
          throw error;
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ slot, at: now, status: 'clicked' }));
        recordOutcome(slot, now, 'clicked');
        startSyncMonitor(slot, now, !completeWasVisible);
        log(`${slot}：已点击 Refresh all；同步结果请以 Monarch 页面为准。`);
      });
    } catch (error) {
      log(`本轮停止：${error.message}`);
    } finally {
      running = false;
      updateDiagnostics(new Date());
    }
  }

  function showDiagnostics() {
    let last;
    try { last = readLast(); } catch (error) { last = { error: error.message }; }
    alert([
      `时区：${TIME_ZONE}`,
      `每天：${HOURS.map(h => `${String(h).padStart(2, '0')}:00`).join('、')}`,
      `当前中部时间：${format.format(new Date())}`,
      `本页状态：${pageStatus()}`,
      `Refresh all 按钮：${findButton() ? '已识别且可点击' : '未就绪 / 不唯一'}`,
      `最近脚本尝试：${last ? JSON.stringify(last) : '暂无'}`,
      `刷新日志：${JSON.stringify(readHistory().slice(0, 10))}`,
      `下次计划：${nextScheduleLabel(new Date(), last)}`,
      `最近脚本检查：${document.documentElement.getAttribute('data-monarch-auto-refresh-last-check') || '暂无'}`,
      '若已有可用的 Accounts 标签，由它刷新；否则计划窗口内本标签进入 Accounts 后刷新。',
      '“clicked”只表示已点击；“confirmed”表示观察到 Monarch 同步完成提示，不保证各银行数据都已更新。',
      '仅在每个计划时点后 10 分钟内执行；错过不补刷。',
    ].join('\n'));
  }

  GM_registerMenuCommand('查看计划 / 检查按钮（不执行刷新）', showDiagnostics);

  try {
    normalizeHistory();
    const last = readLast();
    let history = readHistory();
    if (last && history.length === 0) {
      recordOutcome(last.slot, last.at, last.status === 'clicked' ? 'clicked' : 'attempted');
      history = readHistory();
    }
    if (onAccountsPage() && last?.status === 'clicked' && !last.result
      && history[0]?.slot === last.slot && history[0]?.outcome === 'clicked'
      && Date.now() - last.at < CONFIRM_TIMEOUT_MS) {
      startSyncMonitor(last.slot, last.at, false);
    }
  } catch (error) { log(`日志恢复失败：${error.message}`); }

  log(`已启动。${TIME_ZONE} 每天 ${HOURS.map(h => `${h}:00`).join('、')}；计划窗口内自动进入 Accounts 刷新。`);
  setInterval(tick, CHECK_EVERY_MS);
  window.addEventListener('pageshow', tick);
  window.addEventListener('online', tick);
  document.addEventListener('visibilitychange', tick);
  void tick();
})();
