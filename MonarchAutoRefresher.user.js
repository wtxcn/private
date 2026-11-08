// ==UserScript==
// @name         Monarch 定时 Refresh all
// @namespace    local.monarch.auto-refresh
// @version      1.0.2
// @description  每天 05:00 起，每 3 小时点击 Refresh all，最后一次为 23:00（America/Chicago）。
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
  // 只暴露脚本版本和通用运行状态，供安装检查使用，不包含账户信息。
  document.documentElement.setAttribute('data-monarch-auto-refresh-version', '1.0.2');
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let running = false;
  let lastMessage = '';

  function log(message) {
    if (message === lastMessage) return;
    lastMessage = message;
    document.documentElement.setAttribute('data-monarch-auto-refresh-status', message);
    console.info('[Monarch Auto Refresh]', message);
  }

  function scheduledSlot(now) {
    const p = Object.fromEntries(format.formatToParts(now).map(x => [x.type, x.value]));
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

  async function tick() {
    if (running || !/^\/accounts\/?$/.test(location.pathname)) return;
    const slot = scheduledSlot(new Date());
    if (!slot) return;
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
        const modalOpen = Array.from(document.querySelectorAll('[aria-modal="true"], dialog[open]'))
          .some(isVisible);
        const button = modalOpen ? null : findButton();
        if (!button) {
          log('未找到唯一可点击的 Refresh all（可能未登录、正在同步或有弹窗）；窗口内继续检查。');
          return;
        }
        // 点击前记为已尝试：即使页面重载或服务器报错，本时点也不会重复请求。
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ slot, at: now, status: 'attempted' }));
        button.click();
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ slot, at: now, status: 'clicked' }));
        log(`${slot}：已点击 Refresh all；同步结果请以 Monarch 页面为准。`);
      });
    } catch (error) {
      log(`本轮停止：${error.message}`);
    } finally {
      running = false;
    }
  }

  GM_registerMenuCommand('查看计划 / 检查按钮（不执行刷新）', () => {
    let last;
    try { last = readLast(); } catch (error) { last = { error: error.message }; }
    alert([
      `时区：${TIME_ZONE}`,
      `每天：${HOURS.map(h => `${String(h).padStart(2, '0')}:00`).join('、')}`,
      `当前中部时间：${format.format(new Date())}`,
      `账户列表页：${/^\/accounts\/?$/.test(location.pathname) ? '是' : '否'}`,
      `Refresh all 按钮：${findButton() ? '已识别且可点击' : '未就绪 / 不唯一'}`,
      `最近脚本尝试：${last ? JSON.stringify(last) : '暂无'}`,
      '仅在每个计划时点后 10 分钟内执行；错过不补刷。',
    ].join('\n'));
  });

  log(`已启动。${TIME_ZONE} 每天 ${HOURS.map(h => `${h}:00`).join('、')}；请保持账户列表页打开并登录。`);
  setInterval(tick, CHECK_EVERY_MS);
  window.addEventListener('pageshow', tick);
  window.addEventListener('online', tick);
  document.addEventListener('visibilitychange', tick);
  void tick();
})();
