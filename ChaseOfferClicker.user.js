// ==UserScript==
// @name         Chase Native Offer Clicker - Refresh Safe
// @namespace    https://www.chase.com/
// @version      0.1.0
// @description  Adds Chase Offers by clicking native Chase UI buttons slowly, with scroll and refresh verification.
// @match        https://*.chase.com/*
// @match        https://chase.com/*
// @updateURL    https://raw.githubusercontent.com/DemingYan/private/main/ChaseOfferClicker.user.js
// @downloadURL  https://raw.githubusercontent.com/DemingYan/private/main/ChaseOfferClicker.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const STORE_KEY = "chaseOfferClickerState.v1";
  const LOG_KEY = "chaseOfferClickerLogs.v1";
  const KEEP_ALIVE_KEY = "chaseOfferClickerKeepAlive.v1";

  let panel;
  let abortRequested = false;
  let renderQueued = false;
  let keepAliveTimer = null;
  let lastKeepAliveAt = 0;
  let pageSummaryCache = {
    addable: 0,
    page: "",
    updatedAt: 0
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function loadJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || "") || fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function getState() {
    return loadJson(STORE_KEY, { active: false });
  }

  function setState(next) {
    saveJson(STORE_KEY, next);
    scheduleRender();
  }

  function getLogs() {
    return loadJson(LOG_KEY, []);
  }

  function pushLog(message) {
    const stamp = new Date().toLocaleTimeString();
    const logs = getLogs();
    logs.push(`[${stamp}] ${message}`);
    saveJson(LOG_KEY, logs.slice(-250));
    scheduleRender();
  }

  function clearLogs(event) {
    event?.preventDefault();
    event?.stopPropagation();
    saveJson(LOG_KEY, []);
    panel?.querySelector("[data-logs]")?.replaceChildren();
    scheduleRender(true);
  }

  function getKeepAliveConfig() {
    return loadJson(KEEP_ALIVE_KEY, { enabled: true, intervalMs: 240000 });
  }

  function setKeepAliveConfig(next) {
    saveJson(KEEP_ALIVE_KEY, next);
    scheduleKeepAlive();
    scheduleRender(true);
  }

  function textOf(node) {
    return (node?.innerText || node?.textContent || "").trim().replace(/\s+/g, " ");
  }

  function isVisible(node) {
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function isEnabled(node) {
    return !node.disabled && node.getAttribute("aria-disabled") !== "true";
  }

  function nearbyText(node) {
    let root = node;
    for (let i = 0; i < 8 && root; i += 1) {
      const text = root.textContent || "";
      if (text.length > 40 && /(offer|cash back|earn|\$|%|expires|merchant|restaurant|shopping)/i.test(text)) break;
      root = root.parentElement;
    }
    return (root?.textContent || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 260);
  }

  function isAddOfferControl(node) {
    if (!isVisible(node) || !isEnabled(node)) return false;
    const label = [
      textOf(node),
      node.getAttribute("aria-label") || "",
      node.getAttribute("title") || "",
      node.value || ""
    ].join(" ");

    if (!/(add to card|add offer|add this offer|activate offer|activate|clip offer|save offer)/i.test(label)) return false;
    if (/(added|activated|remove|removed|view|details|learn|filter|sort|search|make payment|pay|transfer|download|log out|sign out)/i.test(label)) return false;

    const context = nearbyText(node);
    return /(offer|cash back|earn|\$|%|expires|merchant|restaurant|shopping|grocery|travel|gas)/i.test(context);
  }

  function getAddButtons() {
    return Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'))
      .filter(isAddOfferControl);
  }

  function getOfferName(button) {
    const text = nearbyText(button);
    return text
      .replace(/(add to card|add offer|activate offer|activate|clip offer|save offer)/ig, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140) || "offer";
  }

  function pageLabel() {
    const title = document.title || "";
    const h1 = textOf(document.querySelector("h1"));
    const h2 = textOf(document.querySelector("h2"));
    return [h1, h2, title].filter(Boolean).join(" | ").slice(0, 160);
  }

  function refreshPageSummary(force = false) {
    const now = Date.now();
    if (!force && now - pageSummaryCache.updatedAt < 10000) return pageSummaryCache;

    pageSummaryCache = {
      addable: getAddButtons().length,
      page: pageLabel(),
      updatedAt: now
    };
    return pageSummaryCache;
  }

  function scheduleRender(force = false) {
    if (!panel) return;
    if (force) {
      render(true);
      return;
    }
    if (renderQueued) return;
    renderQueued = true;
    window.setTimeout(() => {
      renderQueued = false;
      render(false);
    }, 250);
  }

  function findSessionButton() {
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    return candidates.find((node) => {
      const label = `${textOf(node)} ${node.getAttribute?.("aria-label") || ""}`;
      return /stay signed in|stay logged in|continue session|keep me signed in|yes, continue|i'?m still here/i.test(label);
    });
  }

  function dispatchKeepAliveEvents() {
    const x = Math.max(10, Math.floor(window.innerWidth * 0.6));
    const y = Math.max(10, Math.floor(window.innerHeight * 0.25));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Shift" }));
    document.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Shift" }));
  }

  function keepAliveTick() {
    const config = getKeepAliveConfig();
    if (!config.enabled) return;

    const sessionButton = findSessionButton();
    if (sessionButton) {
      sessionButton.click();
      pushLog("Clicked session keep-alive prompt.");
    } else {
      dispatchKeepAliveEvents();
      pushLog("Sent keep-alive activity.");
    }
    lastKeepAliveAt = Date.now();
    scheduleRender(true);
  }

  function scheduleKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }

    const config = getKeepAliveConfig();
    if (!config.enabled) return;

    const intervalMs = Math.max(60000, Number(config.intervalMs || 240000));
    keepAliveTimer = setInterval(keepAliveTick, intervalMs);
  }

  async function waitForPageReady(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (getAddButtons().length > 0 || /chase offers|offers/i.test(pageLabel())) return true;
      await sleep(500);
    }
    return false;
  }

  async function clickOneOffer(delayMs) {
    const buttons = getAddButtons();
    const button = buttons[0];
    if (!button) return false;

    const name = getOfferName(button);
    button.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(400);
    button.click();
    pushLog(`Clicked: ${name}`);
    await sleep(delayMs);
    return true;
  }

  async function clickLoadedOffers(delayMs, maxClicks) {
    let clicked = 0;
    while (!abortRequested && getAddButtons().length > 0 && clicked < maxClicks) {
      const before = getAddButtons().length;
      const ok = await clickOneOffer(delayMs);
      if (!ok) break;
      clicked += 1;

      if (getAddButtons().length >= before) await sleep(1500);
    }
    return clicked;
  }

  async function scrollForMore() {
    const beforeY = window.scrollY;
    const beforeHeight = document.body.scrollHeight;
    window.scrollBy({ top: Math.floor(window.innerHeight * 0.8), behavior: "smooth" });
    await sleep(1800);
    return window.scrollY !== beforeY || document.body.scrollHeight !== beforeHeight;
  }

  async function processCurrentPage() {
    const state = getState();
    if (!state.active) return;

    await waitForPageReady();

    const delayMs = Number(state.delayMs || 5000);
    const maxClicks = Number(state.maxClicksPerPass || 200);
    let totalClicked = 0;
    let noMoreRounds = 0;

    pushLog(`Start pass: ${pageLabel()} | addable=${getAddButtons().length}`);

    while (!abortRequested && totalClicked < maxClicks && noMoreRounds < 3) {
      const clicked = await clickLoadedOffers(delayMs, maxClicks - totalClicked);
      totalClicked += clicked;

      const moved = await scrollForMore();
      const addable = getAddButtons().length;
      pushLog(`Pass progress: clicked=${totalClicked}, addable=${addable}`);

      if (clicked === 0 && addable === 0 && !moved) noMoreRounds += 1;
      else noMoreRounds = 0;
    }

    if (abortRequested) {
      pushLog("Stopped by user.");
      setState({ ...state, active: false, phase: "stopped" });
      return;
    }

    pushLog(`Clicked ${totalClicked} offer(s). Reloading to verify.`);
    setState({ ...state, phase: "verify-after-refresh" });
    location.reload();
  }

  async function resumeAfterRefresh() {
    const state = getState();
    if (!state.active) return;
    await waitForPageReady();

    if (state.phase === "verify-after-refresh") {
      window.scrollTo(0, 0);
      await sleep(1500);
      const addable = getAddButtons().length;
      if (addable > 0) {
        pushLog(`Refresh found ${addable} more offer(s), continuing.`);
        setState({ ...state, phase: "process" });
        await processCurrentPage();
        return;
      }

      pushLog("Done after refresh: no addable offers found at top of page.");
      setState({ ...state, active: false, phase: "done" });
      return;
    }

    await processCurrentPage();
  }

  function startRun() {
    abortRequested = false;
    setState({
      active: true,
      phase: "process",
      delayMs: Number(panel.querySelector("[data-delay]").value || 5000),
      maxClicksPerPass: Number(panel.querySelector("[data-max]").value || 200),
      startedAt: Date.now()
    });
    pushLog("Starting Chase Offers run.");
    resumeAfterRefresh().catch((error) => {
      pushLog(`Error: ${error.message}`);
      setState({ ...getState(), active: false, phase: "error" });
    });
  }

  function stopRun() {
    abortRequested = true;
    const state = getState();
    setState({ ...state, active: false, phase: "stopped" });
    pushLog("Stop requested.");
  }

  function makePanel() {
    const el = document.createElement("div");
    el.id = "chase-offer-clicker";
    el.innerHTML = `
      <style>
        #chase-offer-clicker {
          position: fixed;
          z-index: 2147483647;
          right: 18px;
          top: 92px;
          width: 360px;
          color: #111827;
          background: #fff;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          box-shadow: 0 12px 30px rgba(15, 23, 42, 0.22);
          font-family: Arial, sans-serif;
          font-size: 13px;
        }
        #chase-offer-clicker header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 12px;
          border-bottom: 1px solid #e5e7eb;
          font-weight: 700;
        }
        #chase-offer-clicker main { padding: 10px 12px; }
        #chase-offer-clicker button {
          margin: 4px 4px 4px 0;
          padding: 7px 10px;
          border: 1px solid #0b5cab;
          border-radius: 6px;
          background: #0b5cab;
          color: white;
          cursor: pointer;
          font-size: 12px;
        }
        #chase-offer-clicker button.secondary {
          background: #fff;
          color: #0b5cab;
        }
        #chase-offer-clicker button.danger {
          border-color: #b91c1c;
          background: #b91c1c;
        }
        #chase-offer-clicker label {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          margin-right: 8px;
        }
        #chase-offer-clicker input {
          width: 72px;
          padding: 5px;
          border: 1px solid #cbd5e1;
          border-radius: 5px;
        }
        #chase-offer-clicker .status {
          margin: 8px 0;
          padding: 8px;
          border-radius: 6px;
          background: #f8fafc;
          border: 1px solid #e5e7eb;
          line-height: 1.35;
        }
        #chase-offer-clicker .logs {
          height: 180px;
          overflow: auto;
          white-space: pre-wrap;
          background: #0f172a;
          color: #e5e7eb;
          padding: 8px;
          border-radius: 6px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 11px;
        }
      </style>
      <header>
        <span>Chase Offers</span>
        <button type="button" class="secondary" data-hide>Hide</button>
      </header>
      <main>
        <div>
          <label>Delay <input data-delay type="number" min="1000" step="500" value="5000"> ms</label>
          <label>Max <input data-max type="number" min="1" step="10" value="200"></label>
          <label>Keep alive <input data-keepalive-min type="number" min="1" step="1" value="4"> min</label>
        </div>
        <div>
          <button type="button" data-start>Add Loaded Offers</button>
          <button type="button" data-stop class="danger">Stop</button>
          <button type="button" data-keepalive class="secondary">Keep Alive On</button>
          <button type="button" data-clear class="secondary">Clear Log</button>
        </div>
        <div class="status" data-status></div>
        <div class="logs" data-logs></div>
      </main>
    `;

    document.body.appendChild(el);
    el.addEventListener("click", (event) => event.stopPropagation());
    el.querySelector("[data-start]").addEventListener("click", (event) => {
      event.preventDefault();
      startRun();
    });
    el.querySelector("[data-stop]").addEventListener("click", (event) => {
      event.preventDefault();
      stopRun();
    });
    el.querySelector("[data-keepalive]").addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = getKeepAliveConfig();
      const minutes = Number(el.querySelector("[data-keepalive-min]").value || 4);
      setKeepAliveConfig({ enabled: !current.enabled, intervalMs: Math.max(1, minutes) * 60000 });
      pushLog(`Keep alive ${!current.enabled ? "enabled" : "disabled"}.`);
    });
    el.querySelector("[data-keepalive-min]").addEventListener("change", (event) => {
      const current = getKeepAliveConfig();
      const minutes = Number(event.target.value || 4);
      setKeepAliveConfig({ ...current, intervalMs: Math.max(1, minutes) * 60000 });
      pushLog(`Keep alive interval set to ${Math.max(1, minutes)} minute(s).`);
    });
    el.querySelector("[data-clear]").addEventListener("click", clearLogs);
    el.querySelector("[data-hide]").addEventListener("click", () => {
      el.style.display = "none";
      const tab = document.createElement("button");
      tab.textContent = "Chase Offers";
      tab.style.cssText = "position:fixed;right:18px;top:92px;z-index:2147483647;padding:8px 10px;border-radius:6px;border:1px solid #0b5cab;background:#0b5cab;color:#fff;cursor:pointer";
      tab.addEventListener("click", () => {
        tab.remove();
        el.style.display = "block";
      });
      document.body.appendChild(tab);
    });

    return el;
  }

  function render(forceSummary = false) {
    if (!panel) return;
    const state = getState();
    const keepAlive = getKeepAliveConfig();
    const logs = getLogs();
    const summary = refreshPageSummary(forceSummary);
    const keepAliveMinutes = Math.max(1, Math.round(Number(keepAlive.intervalMs || 240000) / 60000));
    const keepAliveAge = lastKeepAliveAt ? `${Math.round((Date.now() - lastKeepAliveAt) / 1000)}s ago` : "not yet";
    const keepAliveButton = panel.querySelector("[data-keepalive]");
    const keepAliveInput = panel.querySelector("[data-keepalive-min]");
    if (keepAliveButton) keepAliveButton.textContent = keepAlive.enabled ? "Keep Alive On" : "Keep Alive Off";
    if (keepAliveInput && document.activeElement !== keepAliveInput) keepAliveInput.value = String(keepAliveMinutes);

    panel.querySelector("[data-status]").innerHTML = `
      <div><b>Status:</b> ${state.active ? "running" : (state.phase || "idle")}</div>
      <div><b>Page:</b> ${summary.page || "unknown"}</div>
      <div><b>Addable:</b> ${summary.addable}</div>
      <div><b>Keep alive:</b> ${keepAlive.enabled ? `${keepAliveMinutes} min, last ${keepAliveAge}` : "off"}</div>
    `;

    const logBox = panel.querySelector("[data-logs]");
    const nextLogText = logs.join("\n");
    if (logBox.textContent !== nextLogText) {
      logBox.textContent = nextLogText;
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  function boot() {
    if (document.getElementById("chase-offer-clicker")) return;
    panel = makePanel();
    scheduleKeepAlive();
    render(true);
    setInterval(() => scheduleRender(false), 5000);

    const state = getState();
    if (state.active) {
      pushLog("Resuming saved run after navigation/refresh.");
      setTimeout(() => resumeAfterRefresh().catch((error) => {
        pushLog(`Error: ${error.message}`);
        setState({ ...getState(), active: false, phase: "error" });
      }), 2500);
    }
  }

  boot();
})();
