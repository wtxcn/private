// ==UserScript==
// @name         YouTube 自动最高画质
// @namespace    local.youtube.highest-quality
// @version      1.0.0
// @updateURL    https://raw.githubusercontent.com/wtxcn/private/main/YouTubeHighestQuality.user.js
// @downloadURL  https://raw.githubusercontent.com/wtxcn/private/main/YouTubeHighestQuality.user.js
// @description  打开视频或切换视频时，自动选择播放器中最高的可用分辨率。
// @match        https://www.youtube.com/*
// @match        https://youtube.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const INSTANCE = '__youtubeHighestQualityLocal';
  window[INSTANCE]?.stop();
  const QUALITY_LABEL = /^(quality|画质|畫質|画質|화질|calidad|qualité|qualität|qualidade|качество)$/i;
  let stopped = false;
  let busy = false;
  let state = null;
  let interaction = 0;
  let lastInteraction = 0;
  let toastTimer;

  function visible(el) {
    return !!el?.isConnected && el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== 'hidden';
  }

  function routeKey() {
    const url = new URL(location.href);
    if (url.pathname === '/watch') return url.searchParams.get('v') || '';
    return url.pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1] || '';
  }

  function currentPlayer() {
    const main = document.getElementById('movie_player');
    if (visible(main)) return main;
    return [...document.querySelectorAll('video')]
      .filter(visible)
      .sort((a, b) => Number(a.paused) - Number(b.paused))
      .map(video => video.closest('.html5-video-player'))
      .find(visible) || null;
  }

  function qualityValue(text) {
    const normalized = text.replace(/\s+/g, ' ').trim();
    const match = normalized.match(/(?:^|\D)(\d{3,5})p\s*(\d{2,3})?/i);
    if (!match) return null;
    return { height: Number(match[1]), fps: Number(match[2] || 0), label: normalized };
  }

  function highestOption(items) {
    return items.map(el => ({ el, value: qualityValue(el.textContent || '') }))
      .filter(({ el, value }) => value && el.getAttribute('aria-disabled') !== 'true' &&
        !el.hasAttribute('disabled') && !el.classList.contains('ytp-menuitem-disabled') &&
        !/premium|enhanced bitrate|增强比特率|增強位元率|高码率|高碼率|升级|升級/i.test(value.label))
      .sort((a, b) => b.value.height - a.value.height || b.value.fps - a.value.fps)[0] || null;
  }

  function stillCurrent(job, serial) {
    return !stopped && state === job && routeKey() === job.key &&
      currentPlayer() === job.player && job.player.querySelector('video') === job.video &&
      interaction === serial && !job.player.classList.contains('ad-showing') &&
      !job.player.classList.contains('ad-interrupting');
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function waitFor(read, job, serial, timeout = 1600) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!stillCurrent(job, serial)) return null;
      const value = read();
      if (value) return value;
      await sleep(100);
    }
    return null;
  }

  function notify(label) {
    let toast = document.getElementById('youtube-highest-quality-notice');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'youtube-highest-quality-notice';
      toast.setAttribute('role', 'status');
      toast.style.cssText = 'position:fixed;right:24px;top:72px;z-index:2147483647;' +
        'padding:10px 16px;border-radius:8px;background:#171717ed;color:white;' +
        'font:14px/1.5 system-ui,sans-serif;pointer-events:none;box-shadow:0 2px 12px #0005';
      document.documentElement.append(toast);
    }
    toast.textContent = `已选择最高画质：${label}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.remove(), 2800);
  }

  async function selectHighest(job) {
    const player = job.player;
    if (document.hidden || player.classList.contains('ad-showing') ||
        player.classList.contains('ad-interrupting') || Date.now() - lastInteraction < 1800) return null;
    const settings = player.querySelector('.ytp-settings-button');
    // 用户正在看菜单时延后，不接管用户打开的设置。
    if (!settings || settings.getAttribute('aria-expanded') === 'true') return null;
    const serial = interaction;
    let opened = false;
    const focusBefore = document.activeElement;
    try {
      if (!stillCurrent(job, serial)) return null;
      settings.click();
      opened = true;
      const panel = await waitFor(() => {
        const el = document.getElementById(settings.getAttribute('aria-controls')) ||
          player.querySelector('.ytp-settings-menu');
        return visible(el) && el;
      }, job, serial);
      if (!panel) return false;

      const row = await waitFor(() => [...panel.querySelectorAll('.ytp-menuitem')].find(el =>
        visible(el) && QUALITY_LABEL.test(el.querySelector('.ytp-menuitem-label')?.textContent.trim() || '')
      ), job, serial);
      if (!row) return false;
      row.click();

      const options = await waitFor(() => {
        const items = [...panel.querySelectorAll('[role="menuitemradio"]')].filter(visible);
        return highestOption(items);
      }, job, serial);
      if (!options || !stillCurrent(job, serial)) return false;
      const { el, value } = options;
      if (el.getAttribute('aria-checked') !== 'true') {
        el.click();
        // 菜单中选择的是目标画质；已有缓冲可能使实际解码分辨率延后切换。
        if (!stillCurrent(job, serial)) return null;
        const confirmed = await waitFor(() => {
          if (el.getAttribute('aria-checked') === 'true') return true;
          const summary = row.querySelector('.ytp-menuitem-content')?.textContent || '';
          const valueNow = qualityValue(summary);
          return !/auto|自动|自動/i.test(summary) && valueNow?.height === value.height &&
            valueNow?.fps === value.fps;
        }, job, serial);
        if (!confirmed) return stillCurrent(job, serial) ? false : null;
      }
      if (job.selected !== value.label) notify(value.label);
      job.selected = value.label;
      console.info('[YouTube 自动最高画质] 已选择', value.label);
      return true;
    } finally {
      // 只关闭本轮自己打开的菜单；用户插手或页面切换后不再操作。
      if (opened && stillCurrent(job, serial)) {
        if (settings.getAttribute('aria-expanded') === 'true') settings.click();
        if (focusBefore?.isConnected && player.contains(document.activeElement) &&
            typeof focusBefore.focus === 'function') focusBefore.focus({ preventScroll: true });
      }
    }
  }

  async function tick() {
    if (stopped || busy) return;
    const key = routeKey();
    const player = key ? currentPlayer() : null;
    const video = player?.querySelector('video');
    if (!key || !video) { state = null; return; }
    if (!state || state.key !== key || state.player !== player || state.video !== video) {
      state = { key, player, video, successes: 0, failures: 0, selected: '', next: Date.now() + 900 };
    }
    const job = state;
    if (Date.now() < job.next || video.readyState < 1) return;
    busy = true;
    const serial = interaction;
    try {
      const result = await selectHighest(job);
      if (state !== job) return;
      if (interaction !== serial) { job.next = Date.now() + 2000; return; }
      if (!stillCurrent(job, serial)) return;
      if (result === true) {
        job.successes += 1;
        job.failures = 0;
        // 有限复查，覆盖片源清晰度稍后才齐全的情况；不会一直弹出菜单。
        job.next = job.successes >= 3 ? Infinity : Date.now() + (job.successes === 1 ? 8000 : 25000);
      } else if (result === false) {
        job.failures += 1;
        job.next = job.failures >= 6 ? Infinity : Date.now() + 5000;
        if (job.failures >= 6) console.warn('[YouTube 自动最高画质] 当前播放器菜单不兼容，已停止本段重试。');
      } else {
        job.next = Date.now() + 2000;
      }
    } catch (error) {
      job.failures += 1;
      job.next = job.failures >= 6 ? Infinity : Date.now() + 5000;
      console.warn('[YouTube 自动最高画质]', error);
    } finally { busy = false; }
  }

  function onInteraction(event) {
    if (event.isTrusted) { interaction += 1; lastInteraction = Date.now(); }
  }
  function wake() { void tick(); }
  document.addEventListener('pointerdown', onInteraction, true);
  document.addEventListener('keydown', onInteraction, true);
  document.addEventListener('yt-navigate-finish', wake);
  document.addEventListener('loadedmetadata', wake, true);
  document.addEventListener('play', wake, true);
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('popstate', wake);
  const timer = setInterval(wake, 1500);
  window[INSTANCE] = {
    stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(toastTimer);
      document.removeEventListener('pointerdown', onInteraction, true);
      document.removeEventListener('keydown', onInteraction, true);
      document.removeEventListener('yt-navigate-finish', wake);
      document.removeEventListener('loadedmetadata', wake, true);
      document.removeEventListener('play', wake, true);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('popstate', wake);
      document.getElementById('youtube-highest-quality-notice')?.remove();
    }
  };
  wake();
})();
