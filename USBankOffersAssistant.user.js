// ==UserScript==
// @name         U.S. Bank Offers Assistant
// @namespace    https://onlinebanking.usbank.com/
// @version      0.1.0
// @description  Scan and select offers locally. Enrollment starts only when you click Add selected.
// @match        https://onlinebanking.usbank.com/digital/*
// @updateURL    https://raw.githubusercontent.com/wtxcn/private/main/USBankOffersAssistant.user.js
// @downloadURL  https://raw.githubusercontent.com/wtxcn/private/main/USBankOffersAssistant.user.js
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
    try { return Boolean(JSON.parse(localStorage.getItem(config.legacyStore) || "null")?.active); }
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
      if (completed) { snapshot.scannedAt = Date.now(); save(); }
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
          added += 1; save(); log(`Added: ${offer.name} - ${card.name}`);
        } catch (error) {
          if (cancelled) throw error;
          unverified += 1;
          // An uncertain click must not be displayed as added or blindly retried.
          offer.cards[card.id] = "unknown";
          snapshot.selected[offer.key] = (snapshot.selected[offer.key] || []).filter(id => id !== card.id);
          save(); log(`Not verified: ${offer.name} - ${error.message}`);
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
      const total = Object.keys(offer.cards).length;
      const selected = snapshot.selected[offer.key] || [];
      const complete = fullyAdded(offer);
      const allSelected = eligible > 0 && Object.entries(offer.cards).filter(([, s]) => s === "addable").every(([id]) => selected.includes(id));
      const key = escape(offer.key);
      const logo = offer.imageUrl ? `<img src="${escape(offer.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="initials">${escape(offer.name.slice(0, 2).toUpperCase())}</span>`;
      return `<article class="offer ${selected.length ? "selected" : ""}" data-offer="${key}"><button class="offer-head" data-offer-toggle aria-pressed="${allSelected}" aria-label="${escape(`${allSelected ? "Deselect" : "Select"} all eligible ${config.scopePlural} for ${offer.name}`)}" ${busy || !eligible ? "disabled" : ""}><span class="logo">${logo}</span><span class="offer-main"><strong>${escape(offer.name)}</strong><span class="description">${escape(offer.description || "")}</span><span class="${complete ? "green" : "meta"}">${added}/${total} ${escape(config.scopePlural)} added</span></span><span class="count ${complete ? "green" : ""}">${eligible || (complete ? added : "?")}<small>${eligible ? "eligible" : complete ? "added" : "unverified"}</small></span></button><div class="cards">${snapshot.cards.filter(card => offer.cards[card.id]).map(card => {
        const state = offer.cards[card.id];
        return `<button class="card ${state} ${selected.includes(card.id) ? "chosen" : ""}" data-card="${escape(card.id)}" ${busy || state !== "addable" ? "disabled" : ""} aria-pressed="${selected.includes(card.id)}" title="${escape(`${card.name}: ${state}`)}">${state === "added" ? "&#10003; " : state === "unknown" ? "? " : ""}${escape(card.name)}</button>`;
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
      *{box-sizing:border-box;letter-spacing:0} .panel{display:flex;flex-direction:column;max-height:calc(100dvh - 88px);background:#f8f9fb;border:1px solid #dfe4ec;border-radius:8px;box-shadow:0 12px 32px #14203330;overflow:hidden}
      header{display:flex;align-items:center;gap:12px;padding:16px;background:white;border-bottom:1px solid #e4e7ed;flex:none}.brand-icon{display:grid;place-items:center;width:42px;height:42px;border-radius:8px;background:${config.accent};color:white;flex:none}.brand{flex:1;min-width:0}.brand strong{display:block;font-size:18px;font-weight:800}.sub{font-size:12px;color:#677183}svg{width:19px;height:19px;display:block}
      button{font:600 12px/1.4 inherit;font-family:inherit;font-size:12px;line-height:1.4;cursor:pointer;border:1px solid #d9dee8;border-radius:6px;background:white;color:#25354e;padding:7px 10px;overflow-wrap:anywhere}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid #0874cf;outline-offset:2px}.icon{display:grid;place-items:center;padding:6px;width:32px;height:32px;flex:none}.body{overflow:auto;min-height:0}.controls{padding:12px 16px;border-bottom:1px solid #e4e7ed}.actions{display:flex;gap:6px;flex-wrap:wrap}.primary{background:#0a2b63;color:white;border-color:#0a2b63}.danger{color:#b3261e}.search{display:flex;align-items:center;gap:10px;margin-top:12px;padding:10px;background:white;border:1px solid #d9dee8;border-radius:8px;color:#717c8e}.search input{min-width:0;width:100%;border:0;background:white;color:#17254a;font:inherit}.stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:5px;margin-top:10px}.stat{text-align:left;padding:8px 6px;min-width:0}.stat b{display:block;font-size:18px}.stat.active{border-color:#0874cf;box-shadow:inset 0 -2px #0874cf}.scopes,.cards{display:flex;gap:5px;flex-wrap:wrap}.scopes{margin-top:10px}.scope.active,.card.chosen{background:#0a2b63;border-color:#0a2b63;color:white}
      .list{display:flex;flex-direction:column;gap:8px;padding:12px 16px}.offer{border:1px solid #e1e5eb;border-radius:8px;background:white;padding:14px;cursor:pointer}.offer.selected{border-color:#0874cf;box-shadow:inset 0 0 0 1px #0874cf}.offer-head{display:flex;align-items:center;gap:12px;background:transparent;padding:0;border:0;width:100%;text-align:left}.offer-head:disabled{opacity:1}.logo{display:grid;place-items:center;width:64px;height:50px;flex:none;overflow:hidden}.logo img{width:100%;height:100%;object-fit:contain}.initials{display:grid;place-items:center;width:42px;height:42px;background:#e9f2fb;border-radius:8px;color:#2767a3}.offer-main{min-width:0;flex:1}.offer-main strong{display:block;font-size:17px;font-weight:800;color:#071f52;overflow-wrap:anywhere}.description,.meta{display:block;color:#697586;font-size:12px}.green{display:block;color:#28784f}.count{text-align:right;min-width:54px;flex:none;font-weight:700;font-size:15px}.count small{display:block;color:#697586;font-size:10px}.cards{margin-top:10px}.card{max-width:100%;font-size:11px}.card.added{color:#28784f;border-color:#76c59a;background:#eaf7ef;opacity:1;text-decoration:none;font-weight:700}.card.unknown{color:#8b5315;border-color:#d8b067;background:#fff8e9;opacity:1}.summary{display:flex;justify-content:space-between;gap:12px;text-align:left}.summary span{color:#697586}.empty{padding:24px;text-align:center;color:#697586}.status{padding:0 16px 10px;overflow-wrap:anywhere}.time{color:#697586;font-size:11px}details{margin:0 16px 14px}summary{cursor:pointer;color:#697586}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:140px;overflow:auto;background:#eff2f6;padding:8px;font:11px/1.4 monospace}.footer{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 16px;background:white;border-top:1px solid #e4e7ed;flex:none}.collapsed .body,.collapsed .footer{display:none}
      @media(max-width:480px){:host{top:12px;right:8px;width:calc(100vw - 16px)}.panel{max-height:calc(100dvh - 24px)}.stats{grid-template-columns:repeat(3,minmax(0,1fr))}.logo{width:44px;height:44px}.offer-head{gap:8px}.list{padding:10px}.offer{padding:10px}.summary{flex-direction:column}.controls{padding:10px}}
      </style><div class="panel"><header><span class="brand-icon">${config.icons.card}</span><div class="brand"><strong>${escape(config.name)}</strong><span class="sub" data-total></span></div><button class="icon" data-collapse title="Collapse / expand" aria-label="Collapse / expand" aria-expanded="true">${config.icons.collapse}</button></header><div class="body"><div class="controls"><div class="actions"><button data-scan>${escape(config.scanLabel)}</button>${config.cardMode ? '<button data-current>Scan current card</button>' : ""}<button data-select>Select visible</button><button data-clear>Clear selection</button><button class="danger" data-stop>Stop</button></div><label class="search">${config.icons.search}<input type="search" data-search aria-label="Search merchants or offers" placeholder="Search merchants or offers"></label><div class="stats" data-stats></div><div class="scopes" data-scopes></div></div><section class="list" data-list></section><details><summary>Activity</summary><pre data-log></pre></details></div><div class="footer"><div><div data-status></div><div class="time" data-time></div></div><button class="primary" data-add>Add selected (0)</button><button class="icon" data-forget title="Clear local offer cache" aria-label="Clear local offer cache">${config.icons.trash}</button></div></div>`;
    document.body.appendChild(panel);
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
      else if ("collapse" in data) { const collapsed = root.querySelector(".panel").classList.toggle("collapsed"); button.setAttribute("aria-expanded", String(!collapsed)); }
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
  const api = { fullyAdded, filtered, tasks, toggleOffer, toggleCard, merge, scan, addSelected, stop, adapter, env, snapshot: () => snapshot, busy: () => busy };
  if (globalThis.__OFFERS_ASSISTANT_TEST__) { globalThis.__OFFERS_ASSISTANT_TEST__.api = api; return api; }
  if (window.top === window.self && !document.getElementById(ID)) mount();
  return api;
}

function createUSBankAdapter(env) {
  const { all, text, normalize, visible, enabled, click, sleep, waitFor, check, imageUrl, collect } = env;
  const MODAL = "#vicinity-overlay-click-modal, .cashback-offer-detail, .usb-modal-v2--dialog, .usb-modal-v2";
  // The old script exposes a deal collection, not a per-card selector. Do not invent card eligibility.
  const scope = { id: "cashback-deals", name: "Cash-back deals", kind: "scope" };
  function assertPage() {
    if (!/\/cashback-deals/i.test(location.href)) throw new Error("Open U.S. Bank cash-back deals first.");
    if (all('input[type="password"]').some(visible)) throw new Error("Sign in to U.S. Bank and open cash-back deals.");
  }
  function currentCard() { assertPage(); return { ...scope }; }
  async function discoverCards() { return [currentCard()]; }
  async function openCard(card) {
    assertPage();
    if (card.id !== scope.id) throw new Error("This deal collection is no longer available.");
  }
  function modal() {
    return all(MODAL).filter(visible).find(node => node.querySelector('#activate-offer, button, [role="button"]')) || null;
  }
  function activated(detail) {
    if (!detail || !visible(detail)) return false;
    return Array.from(detail.querySelectorAll('button, [role="status"], [aria-label], p, span')).some(node => {
      if (!visible(node)) return false;
      return [text(node), node.getAttribute("aria-label") || ""].some(value =>
        /^(?:Activated Offer|Offer activated|Activated|Successfully activated|This offer is activated|Deal activated)[.!]?$/i.test(value.trim()));
    });
  }
  function activateButton(detail) {
    if (!detail || activated(detail)) return null;
    return Array.from(detail.querySelectorAll('button, [role="button"]')).find(node => visible(node) && enabled(node)
      && (node.id === "activate-offer" || /^Activate(?: Offer)?$/i.test(text(node) || node.getAttribute("aria-label") || ""))
      && !/activated/i.test(text(node)));
  }
  function closeButton(detail) {
    if (!detail) return null;
    return Array.from(detail.querySelectorAll('button, [role="button"]')).find(node => visible(node) && enabled(node) && (
      node.id === "vicinity-overlay-click-modal--close"
      || node.getAttribute("data-testid") === "vicinity-overlay-click-modal--close"
      || /modal_close_icon/.test(String(node.className))
      || node.closest(".usb-modal-v2--close")
      || /^close(?: modal| offer| details)?$/i.test(node.getAttribute("aria-label") || text(node))
    ));
  }
  async function closeDetail(detail) {
    if (!detail || !visible(detail)) return;
    const close = closeButton(detail);
    if (!close) throw new Error("Close the U.S. Bank offer detail, then scan again.");
    click(close);
    await waitFor(() => !detail.isConnected || !visible(detail), 5000);
  }
  function buttons() {
    return all('button[aria-label^="Offer from "], [role="button"][aria-label^="Offer from "]').filter(node => visible(node) && enabled(node) && !node.closest(MODAL));
  }
  function readButton(node) {
    const name = (node.getAttribute("aria-label") || "").replace(/^Offer from\s+/i, "").trim();
    if (!name) return null;
    const body = text(node).replace(/^New\s+/i, "");
    const reward = (body.match(/(?:\$\s*\d[\d,.]*|\d+(?:\.\d+)?\s*%)(?:\s+(?:cash back|back|off))?/gi) || []).join(" / ");
    const expiry = body.match(/(?:expires?|valid (?:until|through))\s*:?\s*([\w/,-]+(?:\s+\d{1,4})?)/i)?.[0] || "";
    const nativeId = node.getAttribute("data-offer-id") || "";
    const key = JSON.stringify([normalize(name), normalize(reward), normalize(expiry), nativeId]);
    return { key, name, description: [reward, expiry].filter(Boolean).join(" / "), imageUrl: imageUrl(node), status: "unknown", node };
  }
  const readOffers = () => buttons().map(readButton).filter(Boolean);
  async function openDetail(offer) {
    assertPage(); check();
    // Never reuse a success banner from a different offer's modal.
    if (modal()) await closeDetail(modal());
    const current = readOffers().find(item => item.key === offer.key);
    if (!current) throw new Error("The selected U.S. Bank offer is no longer visible.");
    click(current.node);
    const detail = await waitFor(() => modal(), 8000);
    await waitFor(() => activated(detail) || activateButton(detail), 8000);
    const heading = text(detail.querySelector("h1, h2, h3"));
    if (heading && !normalize(heading).includes(normalize(offer.name))) {
      throw new Error("The opened detail does not match the selected merchant.");
    }
    return detail;
  }
  async function scanCard() {
    assertPage();
    if (modal()) await closeDetail(modal());
    const allTab = all('button, [role="tab"]').find(node => visible(node) && /^All deals(?:\s*\(?\d+\)?)?$/i.test(text(node)));
    if (allTab && allTab.getAttribute("aria-selected") !== "true") { click(allTab); await sleep(700); }
    const inspected = new Map();
    const result = await collect(async () => {
      for (const offer of readOffers()) {
        check();
        if (inspected.has(offer.key)) continue;
        try {
          const detail = await openDetail(offer);
          // Scanning only opens/closes details; it never clicks Activate.
          offer.status = activated(detail) ? "added" : activateButton(detail) ? "addable" : "unknown";
          inspected.set(offer.key, offer);
          await closeDetail(detail);
        } catch (error) {
          if (modal()) await closeDetail(modal());
          check();
          inspected.set(offer.key, offer);
          env.log(`Unverified: ${offer.name}`);
        }
      }
      return [...inspected.values()];
    }, assertPage);
    if (!result.offers.length) throw new Error("No recognizable cash-back deals. Existing scan retained.");
    return result;
  }
  async function addOffer(card, offer) {
    await openCard(card);
    if (!readOffers().some(item => item.key === offer.key)) {
      await collect(readOffers, assertPage);
      // The collector may end below a non-virtualized tile; find it afresh before clicking.
    }
    const detail = await openDetail(offer);
    try {
      if (activated(detail)) return "added";
      const button = activateButton(detail);
      if (!button) throw new Error("No native Activate Offer control for this deal.");
      assertPage(); click(button);
      await waitFor(() => { assertPage(); return detail.isConnected && activated(detail); }, 15000);
      return "added";
    } finally {
      // Stop cancels further clicks, including closing; the user can close the detail manually.
      check();
      await closeDetail(detail);
    }
  }
  return { assertPage, currentCard, discoverCards, openCard, scanCard, addOffer, readOffers, readButton, activated, activateButton, closeDetail };
}

createOffersAssistant({"file":"USBankOffersAssistant.user.js","adapter":"usbank","factory":"createUSBankAdapter","id":"usbank-offers-assistant","name":"U.S. Bank Offers Assistant","version":"0.1.0","namespace":"https://onlinebanking.usbank.com/","match":"https://onlinebanking.usbank.com/digital/*","accent":"#b42339","legacyStore":"usBankOfferClickerState.v1","cardMode":false,"scopePlural":"collections","allLabel":"All deals","scanLabel":"Scan deals","icons":{"card":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect width=\"20\" height=\"14\" x=\"2\" y=\"5\" rx=\"2\"/><line x1=\"2\" x2=\"22\" y1=\"10\" y2=\"10\"/></svg>","search":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"m21 21-4.34-4.34\"/><circle cx=\"11\" cy=\"11\" r=\"8\"/></svg>","collapse":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"m7 15 5 5 5-5\"/><path d=\"m7 9 5-5 5 5\"/></svg>","trash":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M10 11v6\"/><path d=\"M14 11v6\"/><path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\"/><path d=\"M3 6h18\"/><path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"/></svg>"}}, createUSBankAdapter);
})();
