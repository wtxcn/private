// ==UserScript==
// @name         Citi Offers Assistant
// @namespace    https://online.citi.com/
// @version      0.1.6
// @description  Scan and select offers locally. Enrollment starts only when you click Add selected.
// @match        https://online.citi.com/US/nga/products-offers/merchantoffers*
// @updateURL    https://raw.githubusercontent.com/wtxcn/private/main/CitiOffersAssistant.user.js
// @downloadURL  https://raw.githubusercontent.com/wtxcn/private/main/CitiOffersAssistant.user.js
// @grant        none
// @noframes
// @run-at       document-idle
// ==/UserScript==

// Generated from src/offers-assistant by scripts/build-offers-assistants.cjs.
/* Bundled icon licenses:
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

The Search and Trash2 icons include Feather-derived artwork:

The MIT License (MIT)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
(function () {
"use strict";
function createOffersAssistant(config, adapterFactory) {
  "use strict";
  const ID = config.id;
  const STORE = `${ID}.snapshot.v1`;
  const HUB_SOURCE = `cardOffersHubSource.${config.adapter}.v1`;
  const ownSelectors = `#${ID}, #citi-offer-clicker, #usbank-offer-clicker`;
  let busy = false;
  let cancelled = false;
  let panel;
  let root;
  let status = "Ready";
  let filter = "all";
  let scope = "";
  let query = "";
  let cardSummary = false;
  let minimized = false;
  let dragState = null;
  let suppressLauncherClick = false;
  let snapshot = { cards: [], offers: [], selected: {}, logs: [], scannedAt: 0 };
  try {
    const cached = JSON.parse(localStorage.getItem(STORE) || "null");
    if (cached && Array.isArray(cached.cards) && Array.isArray(cached.offers)) {
      snapshot.cards = cached.cards.filter(c => typeof c.id === "string" && typeof c.name === "string");
      snapshot.offers = cached.offers.filter(o => typeof o.key === "string" && typeof o.name === "string" && o.cards && typeof o.cards === "object");
      snapshot.scannedAt = Number(cached.scannedAt) || 0;
    }
  } catch (_) { /* A stale cache must not prevent the panel from opening. */ }

  const text = node => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = () => { if (cancelled) throw new Error("Stopped by user."); };
  const own = node => Boolean(node?.closest?.(ownSelectors) || node?.getRootNode?.().host?.closest?.(ownSelectors));
  const visible = node => {
    if (!node?.getBoundingClientRect || own(node)) return false;
    const rect = node.getBoundingClientRect();
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const enabled = node => node && !node.disabled && node.getAttribute("aria-disabled") !== "true";
  function roots() {
    const result = [document];
    const seen = new Set(result);
    for (let index = 0; index < result.length; index += 1) {
      for (const node of result[index].querySelectorAll("*")) {
        if (own(node)) continue;
        let child = node.shadowRoot;
        try { if (node.tagName === "IFRAME") child = node.contentDocument; } catch (_) { /* Cross-origin frames remain inaccessible. */ }
        if (child && !seen.has(child)) { seen.add(child); result.push(child); }
      }
    }
    return result;
  }
  const all = selector => [...new Set(roots().flatMap(r => Array.from(r.querySelectorAll(selector))))].filter(node => !own(node));
  const label = node => `${node?.getAttribute?.("aria-label") || ""} ${text(node)}`.trim();
  async function waitFor(predicate, timeout = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      check();
      const value = await predicate();
      if (value) return value;
      await sleep(250);
    }
    throw new Error("The bank did not confirm the page change. Refresh the offers page and scan again.");
  }
  function click(node) {
    check();
    if (!visible(node) || !enabled(node) || !node.isConnected) throw new Error("The bank control is no longer available.");
    node.scrollIntoView?.({ block: "center", inline: "nearest" });
    // One native click only: dispatching an extra click event can enroll twice.
    node.click();
  }
  function imageUrl(node) {
    const images = Array.from(node?.querySelectorAll?.("img") || []);
    const image = images.find(img => /logo|merchant|brand/i.test(`${img.alt} ${img.className}`)) || images[0];
    try {
      const raw = image?.currentSrc || image?.getAttribute("src");
      if (!raw) return "";
      const url = new URL(raw, location.href);
      return /^(https:|data:)$/.test(url.protocol) ? url.href : "";
    } catch (_) { return ""; }
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify({ ...snapshot, selected: {}, logs: [] })); }
    catch (_) { status = "Storage unavailable; this scan is in memory only"; }
  }
  function publishHubSnapshot() {
    if (!snapshot.scannedAt) return;
    try {
      const clean = {
        cards: snapshot.cards.map(({ id, name }) => ({ id, name })),
        offers: snapshot.offers.map(({ key, name, description = "", imageUrl = "", cards }) => ({ key, name, description, imageUrl, cards: { ...cards } })),
        scannedAt: snapshot.scannedAt
      };
      localStorage.setItem(HUB_SOURCE, JSON.stringify({ bank: config.adapter, publishedAt: Date.now(), snapshot: clean }));
      window.dispatchEvent(new CustomEvent("card-offers-hub-source", { detail: { bank: config.adapter } }));
    } catch (_) { /* Hub sync must never interrupt the bank assistant. */ }
  }
  function log(message) {
    snapshot.logs.push(`[${new Date().toLocaleTimeString()}] ${message}`);
    snapshot.logs = snapshot.logs.slice(-80);
    render();
  }
  function scrollTargets() {
    return [...new Set([document.scrollingElement, ...all("main, section, div").filter(node => {
      if (!visible(node)) return false;
      const css = node.ownerDocument.defaultView.getComputedStyle(node);
      return node.scrollHeight > node.clientHeight + 50 && /auto|scroll/.test(css.overflowY);
    })])].filter(Boolean);
  }
  async function collect(read, assertScope) {
    const found = new Map();
    let stable = 0;
    scrollTargets().forEach(node => { node.scrollTop = 0; });
    await sleep(500);
    for (let round = 0; round < 100; round += 1) {
      check();
      assertScope();
      const before = found.size;
      for (const offer of await read()) found.set(offer.key, offer);
      assertScope();
      const targets = scrollTargets();
      const beforePosition = targets.map(node => `${node.scrollTop}:${node.scrollHeight}`).join("|");
      targets.forEach(node => { node.scrollTop += Math.max(240, node.clientHeight * 0.8); });
      await sleep(600);
      const afterPosition = targets.map(node => `${node.scrollTop}:${node.scrollHeight}`).join("|");
      stable = found.size === before && beforePosition === afterPosition ? stable + 1 : 0;
      if (stable >= 3) return { offers: [...found.values()], complete: true };
    }
    return { offers: [...found.values()], complete: false };
  }
  const env = { all, roots, text, normalize, label, visible, enabled, click, sleep, waitFor, check, imageUrl, collect, log };
  const adapter = adapterFactory(env);

  function fullyAdded(offer) {
    const values = Object.values(offer.cards);
    return values.length > 0 && values.every(value => value === "added");
  }
  function filtered(view = filter, cardId = scope, search = query) {
    return snapshot.offers.filter(offer => {
      if (cardId && !offer.cards[cardId]) return false;
      if (view === "added" && !fullyAdded(offer)) return false;
      if (view === "addable" && !Object.values(offer.cards).includes("addable")) return false;
      if (view === "unknown" && !Object.values(offer.cards).includes("unknown")) return false;
      if (view === "selected" && !snapshot.selected[offer.key]?.length) return false;
      return normalize(`${offer.name} ${offer.description || ""}`).includes(normalize(search));
    });
  }
  function tasks() {
    return snapshot.cards.flatMap(card => snapshot.offers.filter(offer =>
      offer.cards[card.id] === "addable" && snapshot.selected[offer.key]?.includes(card.id)
    ).map(offer => ({ card, offer })));
  }
  function toggleOffer(key) {
    if (busy) return;
    const offer = snapshot.offers.find(o => o.key === key);
    if (!offer) return;
    const ids = snapshot.cards.filter(c => offer.cards[c.id] === "addable").map(c => c.id);
    if (!ids.length) return;
    if (ids.every(id => snapshot.selected[key]?.includes(id))) delete snapshot.selected[key];
    else snapshot.selected[key] = ids;
    render();
  }
  function toggleCard(key, cardId) {
    if (busy) return;
    const offer = snapshot.offers.find(o => o.key === key);
    if (offer?.cards[cardId] !== "addable") return;
    const ids = new Set(snapshot.selected[key] || []);
    if (ids.has(cardId)) ids.delete(cardId); else ids.add(cardId);
    if (ids.size) snapshot.selected[key] = [...ids]; else delete snapshot.selected[key];
    render();
  }
  function merge(card, incoming, complete = false) {
    if (!snapshot.cards.some(c => c.id === card.id)) snapshot.cards.push({ ...card });
    const offers = new Map(snapshot.offers.map(o => [o.key, o]));
    // A filtered or lazy-loaded grid can omit a previously seen offer. Absence is not enrollment.
    if (complete) for (const offer of offers.values()) {
      if (offer.cards[card.id]) offer.cards[card.id] = "unknown";
    }
    for (const item of incoming) {
      const offer = offers.get(item.key) || { key: item.key, name: item.name, description: item.description || "", imageUrl: item.imageUrl || "", cards: {} };
      offer.name = item.name;
      offer.description = item.description || "";
      offer.cards[card.id] = ["added", "addable"].includes(item.status) ? item.status : "unknown";
      if (item.imageUrl) offer.imageUrl = item.imageUrl;
      offers.set(item.key, offer);
    }
    snapshot.offers = [...offers.values()].filter(o => Object.keys(o.cards).length).sort((a, b) => a.name.localeCompare(b.name));
    for (const key of Object.keys(snapshot.selected)) {
      const offer = offers.get(key);
      snapshot.selected[key] = snapshot.selected[key].filter(id => offer?.cards[id] === "addable");
      if (!snapshot.selected[key].length) delete snapshot.selected[key];
    }
    save();
  }
  function legacyRunning() {
    try {
      const active = Boolean(JSON.parse(localStorage.getItem(config.legacyStore) || "null")?.active);
      // Old clickers can leave active=true behind after they are disabled. Their
      // panel is the reliable signal that a legacy worker exists on this page.
      return active && Boolean(config.legacyPanel && document.getElementById(config.legacyPanel));
    }
    catch (_) { return false; }
  }
  function assertLegacyStopped() {
    if (legacyRunning()) throw new Error("The old clicker is running. Stop and disable it before using this assistant.");
  }
  async function scan(currentOnly = false) {
    if (busy) return;
    busy = true; cancelled = false; status = "Scanning"; render();
    try {
      assertLegacyStopped();
      adapter.assertPage();
      const cards = currentOnly ? [adapter.currentCard()] : await adapter.discoverCards();
      if (!cards.length || cards.some(c => !c?.id)) throw new Error("No identifiable card found on this offers page.");
      log(`Read-only scan: ${cards.length} ${config.scopePlural}.`);
      let completed = 0;
      for (const card of cards) {
        check(); assertLegacyStopped();
        try {
          await adapter.openCard(card);
          const result = await adapter.scanCard(card);
          check();
          merge(card, result.offers, result.complete);
          completed += 1;
          log(`${card.name}: ${result.offers.length} offers${result.complete ? "" : " (partial scan)"}.`);
        } catch (error) {
          if (cancelled) throw error;
          log(`Skipped ${card.name}: ${error.message}`);
        }
      }
      if (completed) { snapshot.scannedAt = Date.now(); save(); publishHubSnapshot(); }
      status = completed === cards.length ? "Scan complete" : "Scan incomplete";
    } catch (error) { status = error.message; log(status); }
    finally { busy = false; render(); }
  }
  async function addSelected() {
    if (busy) return;
    const queue = tasks();
    if (!queue.length) return;
    busy = true; cancelled = false; status = "Adding"; render();
    let added = 0;
    let unverified = 0;
    try {
      assertLegacyStopped(); adapter.assertPage();
      for (let index = 0; index < queue.length; index += 1) {
        check(); assertLegacyStopped();
        const { card, offer } = queue[index];
        status = `Adding ${index + 1}/${queue.length}`; render();
        try {
          await adapter.openCard(card);
          check(); assertLegacyStopped();
          // The adapter must observe this exact offer's success signal on this scope.
          const result = await adapter.addOffer(card, offer);
          check();
          if (result !== "added") throw new Error("No confirmed enrollment. Scan again before retrying.");
          offer.cards[card.id] = "added";
          snapshot.selected[offer.key] = (snapshot.selected[offer.key] || []).filter(id => id !== card.id);
          if (!snapshot.selected[offer.key].length) delete snapshot.selected[offer.key];
          added += 1; save(); publishHubSnapshot(); log(`Added: ${offer.name} - ${card.name}`);
        } catch (error) {
          if (cancelled) throw error;
          unverified += 1;
          // An uncertain click must not be displayed as added or blindly retried.
          offer.cards[card.id] = "unknown";
          snapshot.selected[offer.key] = (snapshot.selected[offer.key] || []).filter(id => id !== card.id);
          save(); publishHubSnapshot(); log(`Not verified: ${offer.name} - ${error.message}`);
        }
        if (index < queue.length - 1) { await sleep(5000); check(); }
      }
      status = `${added} confirmed${unverified ? `, ${unverified} not verified` : ""}`;
    } catch (error) { status = error.message; log(status); }
    finally { busy = false; render(); }
  }
  function stop() { cancelled = true; status = "Stopping"; render(); }
  function restoreFocus(key, cardId) {
    const row = Array.from(root.querySelectorAll("[data-offer]")).find(node => node.dataset.offer === key);
    const target = cardId ? Array.from(row?.querySelectorAll("[data-card]") || []).find(node => node.dataset.card === cardId) : row?.querySelector("[data-offer-toggle]");
    target?.focus({ preventScroll: true });
  }
  function setMinimized(value) {
    minimized = Boolean(value);
    panel?.classList.toggle("minimized", minimized);
  }
  function movePanel(clientX, clientY) {
    const width = panel.offsetWidth || panel.getBoundingClientRect().width;
    const height = panel.offsetHeight || panel.getBoundingClientRect().height;
    const left = Math.max(8, Math.min(clientX - dragState.offsetX, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(clientY - dragState.offsetY, window.innerHeight - height - 8));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
  }
  function startDrag(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const origin = event.composedPath?.()[0] || event.target;
    if (!origin?.closest?.("[data-drag-handle], [data-restore]")) return;
    if (origin.closest("button") && !origin.closest("[data-restore]")) return;
    const rect = panel.getBoundingClientRect();
    dragState = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, startX: event.clientX, startY: event.clientY, moved: false, launcher: Boolean(origin.closest("[data-restore]")) };
    panel.setPointerCapture?.(event.pointerId);
  }
  function continueDrag(event) {
    if (!dragState || (dragState.pointerId !== undefined && event.pointerId !== undefined && event.pointerId !== dragState.pointerId)) return;
    if (Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY) > 4) dragState.moved = true;
    if (!dragState.moved) return;
    event.preventDefault();
    movePanel(event.clientX, event.clientY);
  }
  function finishDrag(event) {
    if (!dragState || (dragState.pointerId !== undefined && event.pointerId !== undefined && event.pointerId !== dragState.pointerId)) return;
    suppressLauncherClick = dragState.moved && dragState.launcher;
    panel.releasePointerCapture?.(event.pointerId);
    dragState = null;
  }
  function render() {
    if (!root) return;
    const count = tasks().length;
    root.querySelector("[data-status]").textContent = status;
    root.querySelector("[data-total]").textContent = `${snapshot.offers.length} offers / ${snapshot.cards.length} ${config.scopePlural} / v${config.version}`;
    root.querySelector("[data-time]").textContent = snapshot.scannedAt ? `Last scan: ${new Date(snapshot.scannedAt).toLocaleString()}` : "Not scanned";
    root.querySelectorAll("[data-scan], [data-current], [data-select], [data-clear], [data-forget]").forEach(button => { button.disabled = busy; });
    root.querySelector("[data-add]").disabled = busy || !count;
    root.querySelector("[data-add]").textContent = `Add selected (${count})`;
    root.querySelector("[data-stop]").disabled = !busy;
    const groups = ["all", "addable", "added", "unknown", "selected"];
    const names = { all: "All", addable: "Addable", added: "Added", unknown: "Unverified", selected: "Selected" };
    root.querySelector("[data-stats]").innerHTML = `<button class="stat ${cardSummary ? "active" : ""}" data-summary><b>${snapshot.cards.length}</b>${escape(config.scopePlural)}</button>` + groups.map(view => `<button class="stat ${filter === view && !cardSummary ? "active" : ""}" data-filter="${view}" aria-pressed="${filter === view && !cardSummary}"><b>${filtered(view, "", "").length}</b>${names[view]}</button>`).join("");
    root.querySelector("[data-scopes]").innerHTML = `<button class="scope ${!scope ? "active" : ""}" data-scope="">${escape(config.allLabel)}</button>` + snapshot.cards.map(card => `<button class="scope ${scope === card.id ? "active" : ""}" data-scope="${escape(card.id)}">${escape(card.name)}</button>`).join("");
    root.querySelector("[data-list]").innerHTML = cardSummary ? snapshot.cards.map(card => {
      const offers = snapshot.offers.filter(o => o.cards[card.id]);
      return `<button class="summary" data-summary-card="${escape(card.id)}"><strong>${escape(card.name)}</strong><span>${offers.length} offers / ${offers.filter(o => o.cards[card.id] === "added").length} added</span></button>`;
    }).join("") : filtered().map(offer => {
      const eligible = Object.values(offer.cards).filter(s => s === "addable").length;
      const added = Object.values(offer.cards).filter(s => s === "added").length;
      const unknown = Object.values(offer.cards).filter(s => s === "unknown").length;
      const total = Object.keys(offer.cards).length;
      const selected = snapshot.selected[offer.key] || [];
      const complete = fullyAdded(offer);
      const allSelected = eligible > 0 && Object.entries(offer.cards).filter(([, s]) => s === "addable").every(([id]) => selected.includes(id));
      const key = escape(offer.key);
      const logo = offer.imageUrl ? `<img src="${escape(offer.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="initials">${escape(offer.name.slice(0, 2).toUpperCase())}</span>`;
      return `<article class="offer ${selected.length ? "selected" : ""}" data-offer="${key}"><button class="offer-head" data-offer-toggle aria-pressed="${allSelected}" aria-label="${escape(`${allSelected ? "Deselect" : "Select"} all eligible ${config.scopePlural} for ${offer.name}`)}" ${busy || !eligible ? "disabled" : ""}><span class="logo">${logo}</span><span class="offer-main"><strong>${escape(offer.name)}</strong><span class="description">${escape(offer.description || "")}</span><span class="${complete ? "green" : "meta"}">${added}/${total} ${escape(config.scopePlural)} added</span></span><span class="count ${complete ? "green" : ""}">${eligible || (complete ? added : unknown)}<small>${eligible ? "eligible" : complete ? "added" : "unverified"}</small></span></button><div class="cards">${snapshot.cards.filter(card => offer.cards[card.id]).map(card => {
        const state = offer.cards[card.id];
        return `<button class="card ${state} ${selected.includes(card.id) ? "chosen" : ""}" data-card="${escape(card.id)}" ${busy || state !== "addable" ? "disabled" : ""} aria-pressed="${selected.includes(card.id)}" title="${escape(`${card.name}: ${state}`)}">${state === "added" ? "&#10003; " : state === "unknown" ? "Unverified: " : ""}${escape(card.name)}</button>`;
      }).join("")}</div></article>`;
    }).join("");
    if (!root.querySelector("[data-list]").innerHTML) root.querySelector("[data-list]").innerHTML = '<div class="empty">No offers</div>';
    root.querySelector("[data-log]").textContent = snapshot.logs.join("\n");
  }
  function mount() {
    panel = document.createElement("aside"); panel.id = ID;
    root = panel.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host{position:fixed;z-index:2147483646;top:72px;right:16px;width:min(660px,calc(100vw - 32px));color:#17254a;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;letter-spacing:0;color-scheme:light}
      :host(.minimized){width:auto}.launcher{display:none;align-items:center;padding:9px 12px;border-color:${config.accent};background:${config.accent};color:white;box-shadow:0 8px 24px #14203330;touch-action:none}.launcher svg{width:16px;height:16px;margin-right:7px}:host(.minimized) .panel{display:none}:host(.minimized) .launcher{display:flex}
      *{box-sizing:border-box;letter-spacing:0} .panel{display:flex;flex-direction:column;max-height:calc(100dvh - 88px);background:#f8f9fb;border:1px solid #dfe4ec;border-radius:8px;box-shadow:0 12px 32px #14203330;overflow:hidden}
      header{display:flex;align-items:center;gap:12px;padding:16px;background:white;border-bottom:1px solid #e4e7ed;flex:none;cursor:grab;touch-action:none}header:active,.launcher:active{cursor:grabbing}.brand-icon{display:grid;place-items:center;width:42px;height:42px;border-radius:8px;background:${config.accent};color:white;flex:none}.brand{flex:1;min-width:0}.brand strong{display:block;font-size:18px;font-weight:800}.sub{font-size:12px;color:#677183}svg{width:19px;height:19px;display:block}
      button{font:600 12px/1.4 inherit;font-family:inherit;font-size:12px;line-height:1.4;cursor:pointer;border:1px solid #d9dee8;border-radius:6px;background:white;color:#25354e;padding:7px 10px;overflow-wrap:anywhere}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid #0874cf;outline-offset:2px}.icon{display:grid;place-items:center;padding:6px;width:32px;height:32px;flex:none}.body{overflow:auto;min-height:0}.controls{padding:12px 16px;border-bottom:1px solid #e4e7ed}.actions{display:flex;gap:6px;flex-wrap:wrap}.primary{background:#0a2b63;color:white;border-color:#0a2b63}.danger{color:#b3261e}.search{display:flex;align-items:center;gap:10px;margin-top:12px;padding:10px;background:white;border:1px solid #d9dee8;border-radius:8px;color:#717c8e}.search input{min-width:0;width:100%;border:0;background:white;color:#17254a;font:inherit}.stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:5px;margin-top:10px}.stat{text-align:left;padding:8px 6px;min-width:0}.stat b{display:block;font-size:18px}.stat.active{border-color:#0874cf;box-shadow:inset 0 -2px #0874cf}.scopes,.cards{display:flex;gap:5px;flex-wrap:wrap}.scopes{margin-top:10px}.scope.active,.card.chosen{background:#0a2b63;border-color:#0a2b63;color:white}
      .list{display:flex;flex-direction:column;gap:8px;padding:12px 16px}.offer{border:1px solid #e1e5eb;border-radius:8px;background:white;padding:14px;cursor:pointer}.offer.selected{border-color:#0874cf;box-shadow:inset 0 0 0 1px #0874cf}.offer-head{display:flex;align-items:center;gap:12px;background:transparent;padding:0;border:0;width:100%;text-align:left}.offer-head:disabled{opacity:1}.logo{display:grid;place-items:center;width:64px;height:50px;flex:none;overflow:hidden}.logo img{width:100%;height:100%;object-fit:contain}.initials{display:grid;place-items:center;width:42px;height:42px;background:#e9f2fb;border-radius:8px;color:#2767a3}.offer-main{min-width:0;flex:1}.offer-main strong{display:block;font-size:17px;font-weight:800;color:#071f52;overflow-wrap:anywhere}.description,.meta{display:block;color:#697586;font-size:12px}.green{display:block;color:#28784f}.count{text-align:right;min-width:54px;flex:none;font-weight:700;font-size:15px}.count small{display:block;color:#697586;font-size:10px}.cards{margin-top:10px}.card{max-width:100%;font-size:11px}.card.added{color:#28784f;border-color:#76c59a;background:#eaf7ef;opacity:1;text-decoration:none;font-weight:700}.card.unknown{color:#8b5315;border-color:#d8b067;background:#fff8e9;opacity:1}.summary{display:flex;justify-content:space-between;gap:12px;text-align:left}.summary span{color:#697586}.empty{padding:24px;text-align:center;color:#697586}.status{padding:0 16px 10px;overflow-wrap:anywhere}.time{color:#697586;font-size:11px}details{margin:0 16px 14px}summary{cursor:pointer;color:#697586}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:140px;overflow:auto;background:#eff2f6;padding:8px;font:11px/1.4 monospace}.footer{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 16px;background:white;border-top:1px solid #e4e7ed;flex:none}
      @media(max-width:480px){:host{top:12px;right:8px;width:calc(100vw - 16px)}.panel{max-height:calc(100dvh - 24px)}.stats{grid-template-columns:repeat(3,minmax(0,1fr))}.logo{width:44px;height:44px}.offer-head{gap:8px}.list{padding:10px}.offer{padding:10px}.summary{flex-direction:column}.controls{padding:10px}}
      </style><button class="launcher" data-restore title="Restore ${escape(config.name)}" aria-label="Restore ${escape(config.name)}">${config.icons.card}${escape(config.name.replace(/ Assistant$/, ""))}</button><div class="panel"><header data-drag-handle><span class="brand-icon">${config.icons.card}</span><div class="brand"><strong>${escape(config.name)}</strong><span class="sub" data-total></span></div><button class="icon" data-minimize title="Minimize" aria-label="Minimize">${config.icons.collapse}</button></header><div class="body"><div class="controls"><div class="actions"><button data-scan>${escape(config.scanLabel)}</button>${config.cardMode ? '<button data-current>Scan current card</button>' : ""}<button data-select>Select visible</button><button data-clear>Clear selection</button><button class="danger" data-stop>Stop</button></div><label class="search">${config.icons.search}<input type="search" data-search aria-label="Search merchants or offers" placeholder="Search merchants or offers"></label><div class="stats" data-stats></div><div class="scopes" data-scopes></div></div><section class="list" data-list></section><details><summary>Activity</summary><pre data-log></pre></details></div><div class="footer"><div><div data-status></div><div class="time" data-time></div></div><button class="primary" data-add>Add selected (0)</button><button class="icon" data-forget title="Clear local offer cache" aria-label="Clear local offer cache">${config.icons.trash}</button></div></div>`;
    document.body.appendChild(panel);
    panel.addEventListener("pointerdown", startDrag);
    panel.addEventListener("pointermove", continueDrag);
    panel.addEventListener("pointerup", finishDrag);
    panel.addEventListener("pointercancel", finishDrag);
    root.querySelector("[data-search]").addEventListener("input", event => { query = event.target.value; cardSummary = false; render(); });
    root.addEventListener("click", event => {
      const target = event.target;
      const row = target.closest("[data-offer]");
      if (row) {
        const card = target.closest("[data-card]");
        if (card) { toggleCard(row.dataset.offer, card.dataset.card); restoreFocus(row.dataset.offer, card.dataset.card); }
        else { toggleOffer(row.dataset.offer); restoreFocus(row.dataset.offer); }
        return;
      }
      const button = target.closest("button");
      if (!button || button.disabled) return;
      const data = button.dataset;
      if ("scan" in data) void scan();
      else if ("current" in data) void scan(true);
      else if ("add" in data) void addSelected();
      else if ("stop" in data) stop();
      else if ("minimize" in data) setMinimized(true);
      else if ("restore" in data) { if (suppressLauncherClick) suppressLauncherClick = false; else setMinimized(false); }
      else if ("filter" in data) { filter = data.filter; cardSummary = false; render(); }
      else if ("scope" in data) { scope = data.scope; cardSummary = false; render(); }
      else if ("summary" in data) { cardSummary = true; render(); }
      else if ("summaryCard" in data) { scope = data.summaryCard; filter = "all"; cardSummary = false; render(); }
      else if ("clear" in data) { snapshot.selected = {}; render(); }
      else if ("select" in data) {
        for (const offer of filtered()) snapshot.selected[offer.key] = Object.entries(offer.cards).filter(([id, s]) => s === "addable" && (!scope || scope === id)).map(([id]) => id);
        render();
      } else if ("forget" in data) {
        snapshot = { cards: [], offers: [], selected: {}, logs: [], scannedAt: 0 }; scope = ""; status = "Local cache cleared"; save(); render();
      }
    });
    root.addEventListener("error", event => {
      if (event.target.tagName !== "IMG") return;
      const fallback = document.createElement("span"); fallback.className = "initials"; fallback.textContent = "--"; event.target.replaceWith(fallback);
    }, true);
    render();
  }
  const api = { fullyAdded, filtered, tasks, toggleOffer, toggleCard, merge, scan, addSelected, stop, adapter, env, snapshot: () => snapshot, busy: () => busy, minimized: () => minimized };
  if (globalThis.__OFFERS_ASSISTANT_TEST__) { globalThis.__OFFERS_ASSISTANT_TEST__.api = api; return api; }
  if (window.top === window.self && !document.getElementById(ID)) mount();
  return api;
}

function createCitiAdapter(env) {
  const { all, text, normalize, visible, enabled, click, sleep, waitFor, check, imageUrl, collect } = env;
  const TILE = "cds-tile, .mo-offer-tile-container, .cds-tile, .tile-content, .mo-tile-content, .lifestyle-tile-content";
  let pendingTransition = null;
  function assertPage() {
    if (!/\/products-offers\/merchantoffers/i.test(location.href)) throw new Error("Open Citi Merchant Offers first.");
    if (all('input[type="password"]').some(visible)) throw new Error("Sign in to Citi, then open Merchant Offers.");
  }
  function selector() {
    return all('#card-selector-cds-dropdown, select[aria-label*="card" i], [role="combobox"][aria-label*="card" i]').find(visible);
  }
  function cardFromName(name, value = "") {
    const normalized = name.replace(/\s+/g, " ").trim();
    // Refuse generic "selected card" identities: they would merge different cards.
    const lastFour = normalized.match(/(?:ending(?:\s+(?:in|with))?\s*|(?:\*|\u2022|\.){2,}\s*|[-\u2013\u2014]\s*|\(\s*)(\d(?:\s*\d){3})\s*\)?$/i)?.[1]?.replace(/\s/g, "");
    if (!lastFour) return null;
    return { id: value ? `card:${value}` : `card:${normalize(normalized)}`, name: normalized };
  }
  function currentCard() {
    const control = selector();
    if (!control) throw new Error("Citi card selector not found. Open the Merchant Offers card picker.");
    const select = control.tagName === "SELECT" ? control : control.querySelector("select");
    if (select) {
      const option = select.selectedOptions?.[0];
      const card = cardFromName(text(option), option?.value || "");
      if (card) return card;
    }
    const selected = control.querySelector('[role="option"][aria-selected="true"]');
    const card = cardFromName(text(selected) || text(control));
    if (!card) throw new Error("The selected Citi card could not be identified. Select a card and scan again.");
    return card;
  }
  function options(control) {
    const ids = (control.getAttribute("aria-controls") || control.getAttribute("aria-owns") || "").split(/\s+/).filter(Boolean);
    let containers = ids.map(id => all('[role="listbox"], [id]').find(node => node.id === id)).filter(Boolean);
    if (!containers.length) containers = all('[role="listbox"]').filter(visible);
    if (containers.length !== 1) return [];
    return Array.from(containers[0].querySelectorAll('[role="option"]')).filter(visible);
  }
  async function openPicker() {
    const control = selector();
    if (!control) throw new Error("Citi card picker is unavailable.");
    if (!options(control).length) click(control);
    await waitFor(() => options(selector() || control).length, 5000);
    return selector() || control;
  }
  async function discoverCards() {
    assertPage();
    const control = selector();
    if (!control) return [currentCard()];
    const select = control.tagName === "SELECT" ? control : control.querySelector("select");
    if (select) return Array.from(select.options).filter(option => !option.disabled).map(option => cardFromName(text(option), option.value)).filter(Boolean);
    const picker = await openPicker();
    const cards = options(picker).map(option => cardFromName(text(option))).filter(Boolean);
    if (picker.getAttribute("aria-expanded") !== "false") click(picker);
    return [...new Map(cards.map(card => [card.id, card])).values()];
  }
  function assertCard(card) {
    assertPage();
    if (currentCard().id !== card.id) throw new Error("The selected Citi card changed. Scan again before adding.");
  }
  function tiles() {
    const result = all(TILE).filter(visible);
    for (const button of all('[id$="-oneclick"], [aria-label^="Enroll in Offer for"]')) {
      if (!visible(button)) continue;
      const tile = button.closest(TILE);
      if (tile && !result.includes(tile)) result.push(tile);
    }
    // A cds-tile can wrap several layout divs; read one record per real tile.
    return result.filter(tile => !result.some(parent => parent !== tile && parent.contains(tile)));
  }
  const signature = () => tiles().map(tile => `${text(tile)}|${tile.innerHTML}`).join("\n");
  async function openCard(card) {
    assertPage();
    if (currentCard().id === card.id && !pendingTransition) return;
    if (currentCard().id === card.id && pendingTransition) {
      await confirmTransition(card);
      return;
    }
    const previousTiles = tiles();
    const previousSignature = signature();
    pendingTransition = { id: card.id, previousTiles, previousSignature };
    const control = selector();
    const select = control.tagName === "SELECT" ? control : control.querySelector("select");
    if (select) {
      const option = Array.from(select.options).find(item => cardFromName(text(item), item.value)?.id === card.id);
      if (!option || option.disabled) throw new Error("The scanned Citi card is no longer in the picker.");
      check();
      select.value = option.value;
      select.dispatchEvent(new select.ownerDocument.defaultView.Event("change", { bubbles: true }));
    } else {
      const picker = await openPicker();
      const option = options(picker).find(item => cardFromName(text(item))?.id === card.id);
      if (!option) throw new Error("The scanned Citi card is no longer in the picker.");
      click(option);
    }
    await confirmTransition(card);
  }
  async function confirmTransition(card) {
    const { previousTiles, previousSignature } = pendingTransition;
    await waitFor(() => currentCard().id === card.id && (
      previousTiles.length > 0 && previousTiles.every(tile => !tile.isConnected)
      || signature() !== previousSignature
    ));
    // Let rendering settle after the picker label changes.
    let last = signature(); let steady = 0;
    await waitFor(async () => {
      assertCard(card); await sleep(400);
      const next = signature(); steady = next === last ? steady + 1 : 0; last = next;
      return steady >= 2 && tiles().length;
    });
    assertCard(card);
    pendingTransition = null;
  }
  function enrollButton(tile) {
    return Array.from(tile.querySelectorAll('button, [role="button"], input[type="button"]')).find(node => {
      const label = `${node.getAttribute("aria-label") || ""} ${text(node)}`;
      return visible(node) && enabled(node) && !/enrolled|activated|added/i.test(label)
        && (/-oneclick$/i.test(node.id) || /^Enroll in Offer for\b/i.test(label.trim()));
    });
  }
  function hasAddedSignal(tile) {
    return Array.from(tile.querySelectorAll('button, [role="status"], [aria-label], span, p')).some(node => {
      if (!visible(node)) return false;
      const values = [text(node), node.getAttribute("aria-label") || ""];
      return values.some(value => /^(?:offer )?(?:enrolled|activated|added to card)(?:\s+successfully)?[.!]?$/i.test(value.trim())
        || /^enrolled\s+in\s+.+[.!]?$/i.test(value.trim())
        || /^(?:successfully enrolled|you(?:'re| are) enrolled)(?:\s+in (?:this |the )?offer)?[.!]?$/i.test(value.trim()));
    });
  }
  function readTile(tile) {
    const control = tile.querySelector('[aria-label^="Enroll in Offer for"], [id$="-oneclick"]');
    const aria = control?.getAttribute("aria-label") || "";
    const heading = tile.querySelector('h2, h3, h4, .merchant-name, .offer-title');
    const name = (aria.match(/Enroll in Offer for\s+(.+)$/i)?.[1] || text(heading) || tile.querySelector("img")?.alt || "").trim();
    if (!name) return null;
    const body = text(tile);
    const reward = (body.match(/(?:\$\s*\d[\d,.]*|\d+(?:\.\d+)?\s*%)(?:\s+(?:cash back|back|off))?/gi) || []).join(" / ");
    const expiry = body.match(/(?:expires?|valid (?:until|through))\s*:?\s*([\w/,-]+(?:\s+\d{1,4})?)/i)?.[0] || "";
    const nativeId = tile.getAttribute("data-offer-id") || "";
    const key = JSON.stringify([normalize(name), normalize(reward), normalize(expiry), nativeId]);
    const button = enrollButton(tile);
    return { key, name, description: [reward, expiry].filter(Boolean).join(" / "), imageUrl: imageUrl(tile), status: button ? "addable" : hasAddedSignal(tile) ? "added" : "unknown", node: tile };
  }
  function readOffers() {
    const records = new Map();
    for (const tile of tiles()) {
      const offer = readTile(tile);
      if (!offer) continue;
      const prior = records.get(offer.key);
      if (!prior || offer.status === "addable" || prior.status === "unknown") records.set(offer.key, offer);
    }
    return [...records.values()];
  }
  async function scanCard(card) {
    assertCard(card);
    const result = await collect(readOffers, () => assertCard(card));
    if (!result.offers.length) throw new Error("No recognizable Citi offer tiles. Existing scan retained.");
    return result;
  }
  async function addOffer(card, offer) {
    assertCard(card);
    let row = readOffers().find(item => item.key === offer.key);
    if (!row) {
      await collect(() => { const rows = readOffers(); row ||= rows.find(item => item.key === offer.key); return rows; }, () => assertCard(card));
      row = readOffers().find(item => item.key === offer.key) || row;
    }
    if (!row?.node?.isConnected) throw new Error("This offer is no longer visible on the selected card.");
    if (row.status === "added") return "added";
    const button = enrollButton(row.node);
    if (!button) throw new Error("No native enroll control for this offer.");
    assertCard(card); click(button);
    await waitFor(() => {
      assertCard(card);
      const current = readOffers().find(item => item.key === offer.key);
      if (current?.status === "added") return true;
      // Some Citi layouts remove the title/button on enrollment, but retain the same tile.
      return row.node.isConnected && !enrollButton(row.node) && hasAddedSignal(row.node)
        && (!readTile(row.node) || readTile(row.node).key === offer.key);
    });
    return "added";
  }
  return { assertPage, currentCard, discoverCards, openCard, scanCard, addOffer, readOffers, readTile, cardFromName, hasAddedSignal };
}

createOffersAssistant({"file":"CitiOffersAssistant.user.js","adapter":"citi","factory":"createCitiAdapter","id":"citi-offers-assistant","name":"Citi Offers Assistant","version":"0.1.6","namespace":"https://online.citi.com/","match":"https://online.citi.com/US/nga/products-offers/merchantoffers*","accent":"#0874cf","legacyStore":"citiOfferClickerState.v1","legacyPanel":"citi-offer-clicker","cardMode":true,"scopePlural":"cards","allLabel":"All cards","scanLabel":"Scan all cards","icons":{"card":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect width=\"20\" height=\"14\" x=\"2\" y=\"5\" rx=\"2\"/><line x1=\"2\" x2=\"22\" y1=\"10\" y2=\"10\"/></svg>","search":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"m21 21-4.34-4.34\"/><circle cx=\"11\" cy=\"11\" r=\"8\"/></svg>","collapse":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"m7 15 5 5 5-5\"/><path d=\"m7 9 5-5 5 5\"/></svg>","trash":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M10 11v6\"/><path d=\"M14 11v6\"/><path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\"/><path d=\"M3 6h18\"/><path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"/></svg>"}}, createCitiAdapter);
})();
