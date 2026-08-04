// ==UserScript==
// @name         US Bank Cash-Back Deal Clicker
// @namespace    https://onlinebanking.usbank.com/
// @version      0.1.3
// @description  Activates U.S. Bank cash-back deals by opening each visible native deal card slowly and clicking Activate Offer.
// @match        https://onlinebanking.usbank.com/digital/*
// @updateURL    https://raw.githubusercontent.com/wtxcn/private/main/USBankOfferClicker.user.js
// @downloadURL  https://raw.githubusercontent.com/wtxcn/private/main/USBankOfferClicker.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = "0.1.3";
  const DEALS_URL = "https://onlinebanking.usbank.com/digital/servicing/dominjection/cashback-deals";
  const STORE_KEY = "usBankOfferClickerState.v1";
  const LOG_KEY = "usBankOfferClickerLogs.v1";
  const KEEP_ALIVE_KEY = "usBankOfferClickerKeepAlive.v1";

  let panel;
  let abortRequested = false;
  let renderQueued = false;
  let processInFlight = false;
  let keepAliveTimer = null;
  let lastKeepAliveAt = 0;

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
    return loadJson(STORE_KEY, { active: false, phase: "idle" });
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
    saveJson(LOG_KEY, logs.slice(-300));
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

  function getLabel(node) {
    return [
      textOf(node),
      node.getAttribute("aria-label") || "",
      node.getAttribute("title") || "",
      node.getAttribute("id") || "",
      node.value || ""
    ].join(" ").replace(/\s+/g, " ").trim();
  }

  function isVisible(node) {
    if (!node?.getBoundingClientRect) return false;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function isEnabled(node) {
    return !node.disabled && node.getAttribute("aria-disabled") !== "true";
  }

  function isOwnPanel(node) {
    return Boolean(node?.closest?.("#usbank-offer-clicker"));
  }

  function getSearchRoots() {
    const roots = [document];
    const seen = new Set(roots);

    Array.from(document.querySelectorAll("*")).forEach((node) => {
      if (node.shadowRoot && !seen.has(node.shadowRoot)) {
        seen.add(node.shadowRoot);
        roots.push(node.shadowRoot);
      }
    });

    Array.from(document.querySelectorAll("iframe")).forEach((frame) => {
      try {
        const doc = frame.contentDocument;
        if (doc && !seen.has(doc)) {
          seen.add(doc);
          roots.push(doc);
        }
      } catch (_) {
        // Cross-origin frames cannot be inspected by this userscript.
      }
    });

    return roots;
  }

  function allCandidates(selector) {
    return getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll(selector)));
  }

  function isDealsPage() {
    return /cashback-deals/i.test(location.href) || /Your cash-back deals|Activate deals and earn cash back/i.test(textOf(document.body).slice(0, 2500));
  }

  function isLoggedOutOrTimedOut() {
    const body = textOf(document.body).slice(0, 2500);
    if (isDealsPage() && getOfferButtons().length > 0) return false;

    const normalized = body.replace(/Log in to your business profile[^.]*\./gi, "");
    return /sign in|sign on|logged out|session (has )?timed out|for your security|verify your identity/i.test(normalized)
      && /u\.?s\.? bank|usbank|online banking/i.test(`${body} ${location.hostname}`);
  }

  function offerName(button) {
    const aria = button.getAttribute("aria-label") || "";
    const match = aria.match(/Offer from\s+(.+)$/i);
    return (match ? match[1] : textOf(button)).replace(/^New\s+/i, "").trim().slice(0, 160) || "deal";
  }

  function offerKey(button) {
    return `${button.getAttribute("aria-label") || ""} ${textOf(button)}`
      .toLowerCase()
      .replace(/^new\s+/i, "")
      .replace(/[^a-z0-9$%]+/g, " ")
      .trim();
  }

  function getProcessedKeys() {
    const state = getState();
    return new Set(Array.isArray(state.processedKeys) ? state.processedKeys : []);
  }

  function saveProcessedKeys(keys) {
    setState({ ...getState(), processedKeys: Array.from(keys).slice(-1000) });
  }

  function isOfferButton(node) {
    if (!node || isOwnPanel(node) || !isVisible(node) || !isEnabled(node)) return false;
    const aria = node.getAttribute("aria-label") || "";
    const label = getLabel(node);
    if (!/^Offer from\s+/i.test(aria)) return false;
    if (/favorite|filter|tab|shop now|activate offer|activated offer|close/i.test(label)) return false;
    return true;
  }

  function getOfferButtons() {
    const processed = getProcessedKeys();
    const seen = new Set();
    return allCandidates("button, [role='button']")
      .filter(isOfferButton)
      .filter((button) => {
        const key = offerKey(button);
        if (!key || processed.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function findButtonByText(pattern) {
    return allCandidates("button, [role='button'], a").find((node) => {
      if (isOwnPanel(node) || !isVisible(node) || !isEnabled(node)) return false;
      return pattern.test(getLabel(node));
    });
  }

  function findActivateButton() {
    const byId = allCandidates("#activate-offer").find((node) => {
      if (isOwnPanel(node) || !isVisible(node) || !isEnabled(node)) return false;
      return !/Activated|Offer activated/i.test(getLabel(node));
    });
    if (byId) return byId;

    return allCandidates("button, [role='button']").find((node) => {
      if (isOwnPanel(node) || !isVisible(node) || !isEnabled(node)) return false;
      const label = getLabel(node);
      const inDealModal = Boolean(node.closest?.("#vicinity-overlay-click-modal, .cashback-offer-detail, .usb-modal-v2"));
      return inDealModal && /^(Activate|Activate Offer)\b/i.test(label) && !/Activated|Offer activated/i.test(label);
    });
  }

  function visibleModal() {
    return allCandidates("#vicinity-overlay-click-modal, .usb-modal-v2, .usb-modal-v2--dialog, .cashback-offer-detail")
      .find((node) => !isOwnPanel(node) && isVisible(node));
  }

  function findCloseButton() {
    const direct = allCandidates([
      "#vicinity-overlay-click-modal--close",
      "[data-testid='vicinity-overlay-click-modal--close']",
      ".usb-modal-v2--close button",
      "button.modal_close_icon"
    ].join(", ")).find((node) => !isOwnPanel(node) && isVisible(node) && isEnabled(node));
    if (direct) return direct;

    const labeled = allCandidates("button, [role='button']").find((node) => {
      if (isOwnPanel(node) || !isVisible(node) || !isEnabled(node)) return false;
      const label = getLabel(node);
      const className = String(node.className || "");
      return Boolean(node.closest?.("#vicinity-overlay-click-modal, .usb-modal-v2, .usb-modal-v2--dialog"))
        && (/close modal/i.test(label) || /modal_close_icon|usb-modal-v2--close/i.test(className));
    });
    if (labeled) return labeled;

    const modal = visibleModal();
    if (!modal) return null;

    const modalRect = modal.getBoundingClientRect();
    return allCandidates("button, [role='button']").find((node) => {
      if (isOwnPanel(node) || !isVisible(node) || !isEnabled(node)) return false;
      const rect = node.getBoundingClientRect();
      const isSmall = rect.width <= 64 && rect.height <= 64;
      const nearTop = rect.top <= modalRect.top + 90;
      const nearRight = rect.right >= modalRect.right - 90;
      return Boolean(node.closest?.("#vicinity-overlay-click-modal, .usb-modal-v2, .usb-modal-v2--dialog")) && isSmall && nearTop && nearRight;
    });
  }

  function hasActivatedSignal() {
    const body = textOf(document.body).slice(0, 3000);
    return /Activated Offer|Offer activated/i.test(body);
  }

  function humanClick(node) {
    if (!node) return false;
    node.scrollIntoView({ block: "center", inline: "center" });
    node.focus?.({ preventScroll: true });

    const rect = node.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: window.screenX + x,
      screenY: window.screenY + y
    };

    ["pointerover", "mouseover", "pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => {
      const EventClass = type.startsWith("pointer") && typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent;
      node.dispatchEvent(new EventClass(type, { ...base, button: 0, buttons: type.endsWith("down") ? 1 : 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    });
    node.click?.();
    return true;
  }

  async function waitUntil(predicate, timeoutMs, stepMs = 250) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true;
      await sleep(stepMs);
    }
    return false;
  }

  async function openDealsPageIfNeeded() {
    if (isDealsPage()) return true;
    pushLog("Opening U.S. Bank cash-back deals page.");
    location.href = DEALS_URL;
    return false;
  }

  async function waitForDeals(timeoutMs = 30000) {
    const ok = await waitUntil(() => isDealsPage() || isLoggedOutOrTimedOut(), timeoutMs, 500);
    if (!ok) return false;
    if (isLoggedOutOrTimedOut()) return false;
    const allTab = findButtonByText(/^All deals\b/i);
    if (allTab) {
      humanClick(allTab);
      await sleep(1000);
    }
    return true;
  }

  async function closeDetailIfOpen() {
    for (let i = 0; i < 8; i += 1) {
      const close = findCloseButton();
      if (!close) return true;
      humanClick(close);
      await waitUntil(() => !findCloseButton() || findCloseButton() !== close, 5000, 250);
      await sleep(500);
    }
    return !findCloseButton();
  }

  async function waitForDetailOpen() {
    return waitUntil(() => Boolean(findActivateButton()) || hasActivatedSignal() || Boolean(findCloseButton()), 8000, 250);
  }

  async function waitForActivationDone() {
    return waitUntil(() => hasActivatedSignal() || !findActivateButton(), 15000, 300);
  }

  function scrollTargets() {
    const targets = [document.scrollingElement || document.documentElement];
    allCandidates("main, section, div").forEach((node) => {
      if (!isVisible(node)) return;
      const style = window.getComputedStyle(node);
      const canScroll = node.scrollHeight > node.clientHeight + 50 && /(auto|scroll)/i.test(`${style.overflowY} ${style.overflow}`);
      if (canScroll) targets.push(node);
    });
    return targets;
  }

  async function scrollForMore() {
    const targets = scrollTargets();
    const before = targets.map((node) => `${node.scrollTop}:${node.scrollHeight}`).join("|");
    targets.forEach((node) => {
      node.scrollBy?.({ top: Math.floor(window.innerHeight * 0.85), behavior: "smooth" });
    });
    window.scrollBy({ top: Math.floor(window.innerHeight * 0.85), behavior: "smooth" });
    await sleep(1500);
    const afterTargets = scrollTargets();
    const after = afterTargets.map((node) => `${node.scrollTop}:${node.scrollHeight}`).join("|");
    return before !== after;
  }

  function findSessionButton() {
    return Array.from(document.querySelectorAll("button, a, [role='button']")).find((node) => {
      const label = getLabel(node);
      return /stay signed in|continue session|keep me signed in|yes, continue|i'?m still here/i.test(label);
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
      humanClick(sessionButton);
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

  async function activateOneOffer(delayMs) {
    await closeDetailIfOpen();

    const button = getOfferButtons()[0];
    if (!button) return false;

    const name = offerName(button);
    const key = offerKey(button);
    const processed = getProcessedKeys();
    processed.add(key);
    saveProcessedKeys(processed);

    if (!humanClick(button)) return false;
    pushLog(`Opened: ${name}`);

    const detailOpened = await waitForDetailOpen();
    if (!detailOpened) {
      pushLog(`Could not open detail: ${name}`);
      await sleep(delayMs);
      return true;
    }

    const activate = findActivateButton();
    if (activate) {
      humanClick(activate);
      pushLog(`Clicked Activate Offer: ${name}`);
      await waitForActivationDone();
      await sleep(Math.max(1000, Math.floor(delayMs / 2)));
    } else if (hasActivatedSignal()) {
      pushLog(`Already activated: ${name}`);
    } else {
      pushLog(`No Activate button found: ${name}`);
    }

    const closed = await closeDetailIfOpen();
    if (!closed) pushLog(`Detail did not close cleanly: ${name}`);
    await sleep(delayMs);
    return true;
  }

  async function processOffers() {
    if (processInFlight) return;
    processInFlight = true;

    try {
      const initialState = getState();
      if (!initialState.active) return;

      if (!(await openDealsPageIfNeeded())) return;
      if (!(await waitForDeals())) {
        if (isLoggedOutOrTimedOut()) {
          pushLog("U.S. Bank session appears logged out or timed out. Sign in, open cash-back deals, then run again.");
          setState({ ...getState(), active: false, phase: "timed-out" });
        } else {
          pushLog("Could not find U.S. Bank cash-back deals page yet.");
        }
        return;
      }

      const delayMs = Number(initialState.delayMs || 5000);
      const maxClicks = Number(initialState.maxClicks || 300);
      let clicked = Number(initialState.clicked || 0);
      let noMoreRounds = 0;

      pushLog(`Start pass: visible deals=${getOfferButtons().length}`);

      while (!abortRequested && clicked < maxClicks && noMoreRounds < 4) {
        let roundClicked = 0;

        while (!abortRequested && clicked < maxClicks && getOfferButtons().length > 0) {
          const ok = await activateOneOffer(delayMs);
          if (!ok) break;
          clicked += 1;
          roundClicked += 1;
          setState({ ...getState(), clicked, phase: "running" });
        }

        await closeDetailIfOpen();
        const moved = await scrollForMore();
        const visible = getOfferButtons().length;
        pushLog(`Pass progress: checked=${clicked}, visible unchecked=${visible}`);

        if (roundClicked === 0 && visible === 0 && !moved) noMoreRounds += 1;
        else noMoreRounds = 0;
      }

      if (abortRequested) {
        pushLog("Stopped by user.");
        setState({ ...getState(), active: false, phase: "stopped" });
        return;
      }

      pushLog(`Done. Checked ${clicked} deal(s).`);
      setState({ ...getState(), active: false, phase: "done", clicked });
    } catch (error) {
      pushLog(`Error: ${error.message}`);
      setState({ ...getState(), active: false, phase: "error" });
    } finally {
      processInFlight = false;
    }
  }

  function startRun() {
    abortRequested = false;
    setState({
      active: true,
      phase: "starting",
      delayMs: Number(panel.querySelector("[data-delay]").value || 5000),
      maxClicks: Number(panel.querySelector("[data-max]").value || 300),
      clicked: 0,
      processedKeys: [],
      startedAt: Date.now()
    });
    pushLog(`Starting U.S. Bank cash-back deals run v${VERSION}.`);
    processOffers();
  }

  function stopRun() {
    abortRequested = true;
    setState({ ...getState(), active: false, phase: "stopped" });
    pushLog("Stop requested.");
  }

  function debugScan() {
    const buttons = getOfferButtons();
    pushLog(`Debug scan: visible unchecked deals=${buttons.length}, dealsPage=${isDealsPage()}, timedOut=${isLoggedOutOrTimedOut()}`);
    buttons.slice(0, 20).forEach((button, index) => {
      pushLog(`#${index + 1}: ${offerName(button)} | key=${offerKey(button)}`);
    });
    if (buttons.length > 20) pushLog(`...and ${buttons.length - 20} more.`);
  }

  function scheduleRender(force = false) {
    if (!panel) return;
    if (force) {
      render();
      return;
    }
    if (renderQueued) return;
    renderQueued = true;
    window.setTimeout(() => {
      renderQueued = false;
      render();
    }, 250);
  }

  function makePanel() {
    const el = document.createElement("div");
    el.id = "usbank-offer-clicker";
    el.innerHTML = `
      <style>
        #usbank-offer-clicker {
          position: fixed;
          z-index: 2147483647;
          right: 18px;
          top: 92px;
          width: 380px;
          color: #111827;
          background: #fff;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          box-shadow: 0 12px 30px rgba(15, 23, 42, 0.22);
          font-family: Arial, sans-serif;
          font-size: 13px;
        }
        #usbank-offer-clicker header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 12px;
          border-bottom: 1px solid #e5e7eb;
          font-weight: 700;
        }
        #usbank-offer-clicker main { padding: 10px 12px; }
        #usbank-offer-clicker button {
          margin: 4px 4px 4px 0;
          padding: 7px 10px;
          border: 1px solid #005eb8;
          border-radius: 6px;
          background: #005eb8;
          color: white;
          cursor: pointer;
          font-size: 12px;
        }
        #usbank-offer-clicker button.secondary {
          background: #fff;
          color: #005eb8;
        }
        #usbank-offer-clicker button.danger {
          border-color: #b91c1c;
          background: #b91c1c;
        }
        #usbank-offer-clicker label {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          margin-right: 8px;
        }
        #usbank-offer-clicker input {
          width: 72px;
          padding: 5px;
          border: 1px solid #cbd5e1;
          border-radius: 5px;
        }
        #usbank-offer-clicker .status {
          margin: 8px 0;
          padding: 8px;
          border-radius: 6px;
          background: #f8fafc;
          border: 1px solid #e5e7eb;
          line-height: 1.35;
        }
        #usbank-offer-clicker .logs {
          height: 190px;
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
        <span>US Bank Deals</span>
        <button type="button" class="secondary" data-hide>Hide</button>
      </header>
      <main>
        <div>
          <label>Delay <input data-delay type="number" min="1500" step="500" value="5000"> ms</label>
          <label>Max <input data-max type="number" min="1" step="10" value="300"></label>
          <label>Keep alive <input data-keepalive-min type="number" min="1" step="1" value="4"> min</label>
        </div>
        <div>
          <button type="button" data-start>Activate All</button>
          <button type="button" data-stop class="danger">Stop</button>
          <button type="button" data-debug class="secondary">Debug Scan</button>
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
    el.querySelector("[data-debug]").addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      debugScan();
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
      tab.textContent = "US Bank Deals";
      tab.style.cssText = "position:fixed;right:18px;top:92px;z-index:2147483647;padding:8px 10px;border-radius:6px;border:1px solid #005eb8;background:#005eb8;color:#fff;cursor:pointer";
      tab.addEventListener("click", () => {
        tab.remove();
        el.style.display = "block";
      });
      document.body.appendChild(tab);
    });

    return el;
  }

  function render() {
    if (!panel) return;
    const state = getState();
    const keepAlive = getKeepAliveConfig();
    const logs = getLogs();
    const visibleDeals = getOfferButtons().length;
    const keepAliveMinutes = Math.max(1, Math.round(Number(keepAlive.intervalMs || 240000) / 60000));
    const keepAliveAge = lastKeepAliveAt ? `${Math.round((Date.now() - lastKeepAliveAt) / 1000)}s ago` : "not yet";
    const keepAliveButton = panel.querySelector("[data-keepalive]");
    const keepAliveInput = panel.querySelector("[data-keepalive-min]");
    if (keepAliveButton) keepAliveButton.textContent = keepAlive.enabled ? "Keep Alive On" : "Keep Alive Off";
    if (keepAliveInput && document.activeElement !== keepAliveInput) keepAliveInput.value = String(keepAliveMinutes);

    panel.querySelector("[data-status]").innerHTML = `
      <div><b>Status:</b> ${state.active ? "running" : (state.phase || "idle")}</div>
      <div><b>Version:</b> ${VERSION}</div>
      <div><b>Deals page:</b> ${isDealsPage() ? "yes" : "no"}</div>
      <div><b>Visible unchecked:</b> ${visibleDeals}</div>
      <div><b>Checked:</b> ${Number(state.clicked || 0)}</div>
      <div><b>Keep alive:</b> ${keepAlive.enabled ? `${keepAliveMinutes} min, last ${keepAliveAge}` : "off"}</div>
      ${isLoggedOutOrTimedOut() ? "<div><b>Action:</b> Sign in again and open cash-back deals.</div>" : ""}
    `;

    const logBox = panel.querySelector("[data-logs]");
    const nextLogText = logs.join("\n");
    if (logBox.textContent !== nextLogText) {
      logBox.textContent = nextLogText;
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  function boot() {
    if (document.getElementById("usbank-offer-clicker")) return;
    panel = makePanel();
    scheduleKeepAlive();
    render();
    setInterval(() => scheduleRender(false), 5000);

    const state = getState();
    if (state.active) {
      pushLog("Resuming saved run after navigation/refresh.");
      window.setTimeout(() => processOffers(), 2500);
    }
  }

  boot();
})();