// ==UserScript==
// @name         Card Offers Hub
// @namespace    https://github.com/wtxcn/private
// @version      0.1.6
// @description  Combine card-offer snapshots from supported banks into one private local search hub.
// @match        https://*.chase.com/*
// @match        https://chase.com/*
// @match        https://online.citi.com/US/nga/products-offers/merchantoffers*
// @match        https://onlinebanking.usbank.com/digital/*
// @match        https://global.americanexpress.com/*
// @match        https://github.com/wtxcn/private*
// @updateURL    https://raw.githubusercontent.com/wtxcn/private/main/CardOffersHub.user.js
// @downloadURL  https://raw.githubusercontent.com/wtxcn/private/main/CardOffersHub.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const ID = "card-offers-hub";
  const DASHBOARD_ID = "card-offers-dashboard";
  const DASHBOARD_URL = "https://github.com/wtxcn/private?card-offers-dashboard=1";
  const DATA_KEY = "cardOffersHub.data.v1";
  const BANKS = {
    chase: { name: "Chase", color: "#0874cf", source: "cardOffersHubSource.chase.v1", legacy: "chaseOffersAssistantSnapshot.v1" },
    citi: { name: "Citi", color: "#056dae", source: "cardOffersHubSource.citi.v1", legacy: "citi-offers-assistant.snapshot.v1" },
    usbank: { name: "U.S. Bank", color: "#b42339", source: "cardOffersHubSource.usbank.v1", legacy: "usbank-offers-assistant.snapshot.v1" },
    amex: { name: "Amex", color: "#006fcf", source: "cardOffersHubSource.amex.v1", legacy: "amexOffersHubSnapshot.v1" }
  };
  const ICONS = {
    card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>',
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>',
    minimize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/></svg>'
  };

  let panel;
  let root;
  let dashboard;
  let dashboardRoot;
  let minimized = true;
  let query = "";
  let bankFilter = "all";
  let statusFilter = "all";
  let notice = "";
  let lastSourceText = "";
  let dragState = null;

  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const normalize = value => String(value || "").normalize("NFKD").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
  const merchantName = value => {
    const first = String(value || "").split("|")[0].replace(/\s+/g, " ").trim();
    return first.replace(/\s+(?:(?:spend|earn|get|save|up to)\b|\$?\d+(?:\.\d+)?%?\s*(?:cash back|back|off|points?)\b).*$/i, "").trim() || first || "Offer";
  };
  const readJson = (value, fallback = null) => { try { return JSON.parse(value) || fallback; } catch (_) { return fallback; } };
  const currentBank = () => location.hostname.includes("chase.com") ? "chase"
    : location.hostname.includes("citi.com") ? "citi"
      : location.hostname.includes("usbank.com") ? "usbank"
        : location.hostname.includes("americanexpress.com") ? "amex" : "";
  const isDashboardPage = () => location.hostname === "github.com"
    && location.pathname.replace(/\/$/, "") === "/wtxcn/private"
    && new URLSearchParams(location.search).get("card-offers-dashboard") === "1";
  const getData = () => {
    const value = GM_getValue(DATA_KEY, { version: 1, snapshots: {} });
    if (!value || !value.snapshots || typeof value.snapshots !== "object") return { version: 2, snapshots: {} };
    const snapshots = {};
    for (const [key, snapshot] of Object.entries(value.snapshots)) {
      if (!snapshot || !Array.isArray(snapshot.cards) || !Array.isArray(snapshot.offers)) continue;
      const bank = snapshot.bank || key.split(":").pop();
      if (!BANKS[bank]) continue;
      snapshots[bank] = mergeSnapshots(snapshots[bank], { ...snapshot, bank });
    }
    return { version: 2, snapshots };
  };
  const saveData = value => GM_setValue(DATA_KEY, value);

  function hashId(value) {
    let hash = 2166136261;
    for (const character of String(value)) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36);
  }

  function safeCardName(value) {
    return String(value || "Card").replace(/\d{6,}/g, digits => `...${digits.slice(-4)}`).replace(/\s+/g, " ").trim().slice(0, 100) || "Card";
  }

  function sanitizeSnapshot(bank, snapshot) {
    if (!snapshot || !Array.isArray(snapshot.cards) || !Array.isArray(snapshot.offers)) return null;
    const ids = new Map();
    const cards = snapshot.cards.filter(card => card && card.id != null).map(card => {
      const id = `${bank}:${hashId(`${bank}|${card.id}`)}`;
      ids.set(String(card.id), id);
      return { id, name: safeCardName(card.name) };
    });
    const offers = snapshot.offers.filter(offer => offer && typeof offer.name === "string" && offer.cards && typeof offer.cards === "object").map(offer => {
      const states = {};
      for (const [rawId, status] of Object.entries(offer.cards)) {
        const id = ids.get(String(rawId));
        if (id && ["addable", "added", "unknown"].includes(status)) states[id] = status;
      }
      return {
        key: normalize(offer.key || offer.name),
        name: String(offer.name).replace(/\s+/g, " ").trim().slice(0, 180),
        description: String(offer.description || "").replace(/\s+/g, " ").trim().slice(0, 300),
        cards: states
      };
    }).filter(offer => offer.key && Object.keys(offer.cards).length);
    return { cards, offers, scannedAt: Number(snapshot.scannedAt) || Date.now() };
  }

  function mergeSnapshots(existing, incoming) {
    const cleanIncoming = {
      bank: incoming.bank,
      publishedAt: Number(incoming.publishedAt) || 0,
      cards: incoming.cards,
      offers: incoming.offers,
      scannedAt: Number(incoming.scannedAt) || 0
    };
    if (!existing) return cleanIncoming;
    const cards = new Map(existing.cards.map(card => [card.id, card]));
    for (const card of cleanIncoming.cards) cards.set(card.id, card);
    const offers = new Map(existing.offers.map(offer => [offer.key, { ...offer, cards: { ...offer.cards } }]));
    for (const offer of cleanIncoming.offers) {
      const prior = offers.get(offer.key) || { key: offer.key, name: offer.name, description: "", cards: {} };
      prior.name = offer.name || prior.name;
      prior.description = offer.description || prior.description;
      Object.assign(prior.cards, offer.cards);
      offers.set(offer.key, prior);
    }
    return {
      bank: cleanIncoming.bank || existing.bank,
      publishedAt: Math.max(Number(existing.publishedAt) || 0, cleanIncoming.publishedAt),
      cards: [...cards.values()],
      offers: [...offers.values()],
      scannedAt: Math.max(Number(existing.scannedAt) || 0, cleanIncoming.scannedAt)
    };
  }

  function sourceFromStorage(bank) {
    const config = BANKS[bank];
    const published = readJson(localStorage.getItem(config.source));
    if (published?.snapshot) return published;
    const legacy = readJson(localStorage.getItem(config.legacy));
    if (legacy?.cards && legacy?.offers && legacy.scannedAt) return { bank, publishedAt: legacy.scannedAt, snapshot: legacy };
    return null;
  }

  function syncCurrentBank(force = false) {
    const bank = currentBank();
    if (!bank) return false;
    if (bank === "amex") collectAmexPage();
    const source = sourceFromStorage(bank);
    if (!source?.snapshot) return false;
    const sourceText = JSON.stringify(source);
    if (!force && sourceText === lastSourceText) return false;
    const snapshot = sanitizeSnapshot(bank, source.snapshot);
    if (!snapshot) return false;
    const data = getData();
    data.snapshots[bank] = mergeSnapshots(data.snapshots[bank], { bank, publishedAt: Number(source.publishedAt) || Date.now(), ...snapshot });
    saveData(data);
    lastSourceText = sourceText;
    notice = `${BANKS[bank].name} synced`;
    render();
    return true;
  }

  function collectAmexPage() {
    if (currentBank() !== "amex") return false;
    const cardControl = document.querySelector('[role="combobox"][aria-label*="manage your other accounts" i], [data-testid="simple_switcher_combobox"], [data-testid="simple_switcher_wrapper"]');
    const selectedCard = cardControl?.querySelector?.('[data-testid="simple_switcher_selected_option_display"]')
      || document.querySelector('[data-testid="simple_switcher_selected_option_display"]');
    const selectedLabel = selectedCard?.getAttribute("aria-label") || "";
    const currentCardName = safeCardName(selectedLabel.replace(/\s+ending in\s+(\d{4,5})\.?$/i, " (...$1)") || cardControl?.textContent || "Amex Card");
    const currentTail = currentCardName.match(/(\d{4,5})\D*$/)?.[1] || "current";
    const currentCardId = `amex:${normalize(currentCardName)}:${currentTail}`;
    const eligibleView = Boolean(document.querySelector('#ELIGIBLE:checked, [id="ELIGIBLE"][aria-checked="true"]'));
    const enrolledPage = /\/offers\/enrolled(?:\/|$)/i.test(location.pathname);
    const tiles = Array.from(document.querySelectorAll('[id^="offer-"]:not(#offer-view-menu)')).filter(tile => tile.querySelector("button, img"));
    const addButtons = Array.from(document.querySelectorAll('button[title="add to list card"]'));
    const detailButtons = Array.from(document.querySelectorAll('[data-testid="merchantOfferDetailsLink"], button')).filter(button => /view details/i.test(button.textContent || ""));
    for (const button of [...addButtons, ...detailButtons]) {
      let tile = button;
      for (let depth = 0; depth < 10 && tile; depth += 1, tile = tile.parentElement) {
        const text = tile.textContent || "";
        const detailCount = Array.from(tile.querySelectorAll?.("button") || []).filter(candidate => /view details/i.test(candidate.textContent || "")).length;
        if ((tile.id || "").startsWith("offer-") || (detailCount === 1 && /view details/i.test(text) && text.length > 30 && tile.querySelector?.("h2, h3, h4, img[alt]"))) break;
      }
      if (tile && !tiles.includes(tile)) tiles.push(tile);
    }
    if (!tiles.length) return false;
    const cardsFound = new Map([[currentCardId, { id: currentCardId, name: currentCardName }]]);
    const offers = tiles.map(tile => {
      const button = tile.querySelector('button[id^="header-panel-"], button');
      const tileText = `${button?.innerText || button?.textContent || ""} ${tile.innerText || tile.textContent || ""}`.replace(/\s+/g, " ").trim();
      const headingName = tile.querySelector("h2, h3, h4")?.textContent?.replace(/\s+/g, " ").trim() || "";
      const imageName = tile.querySelector("img[alt]")?.getAttribute("alt")?.replace(/\s+/g, " ").trim() || "";
      const addedTail = tileText.match(/Added to Card\s*[•·*\s]*(\d{4,5})/i)?.[1] || "";
      const tail = addedTail || currentTail;
      const cardName = addedTail && addedTail !== currentTail ? `Amex Card (...${addedTail})` : currentCardName;
      const cardId = addedTail && addedTail !== currentTail ? `amex:card:${addedTail}` : currentCardId;
      cardsFound.set(cardId, { id: cardId, name: cardName });
      const fallbackName = tileText.split(/\b(?:spend|earn|get|save)\b/i)[0].replace(/^\d+\s+of\s+\d+\s+/i, "").trim();
      const name = (headingName || imageName || fallbackName || "Amex offer").slice(0, 180);
      let description = tileText;
      for (const label of new Set([headingName, imageName].filter(Boolean))) description = description.replaceAll(label, " ");
      description = description
        .replace(/Added to Card\s*[•·*\s]*\d{4,5}/ig, " ")
        .replace(/Expires?(?:\s+today|\s+\d{1,2}\/\d{1,2}\/\d{2,4})?/ig, " ")
        .replace(/Terms apply|View Details/ig, " ")
        .replace(/\s+/g, " ").trim().slice(0, 300);
      const status = enrolledPage || /Added to Card/i.test(tileText) ? "added"
        : tile.querySelector('button[title="add to list card"]') || eligibleView ? "addable" : "unknown";
      return { key: normalize(`${name}|${description}`), name, description, cards: { [cardId]: status } };
    }).filter(offer => offer.key);
    const old = readJson(localStorage.getItem(BANKS.amex.source), { snapshot: { cards: [], offers: [] } });
    const cards = new Map((old.snapshot?.cards || []).map(card => [String(card.id), card]));
    for (const [id, card] of cardsFound) cards.set(id, card);
    const merged = new Map((old.snapshot?.offers || []).map(offer => [offer.key, offer]));
    for (const offer of offers) {
      const prior = merged.get(offer.key) || { key: offer.key, name: offer.name, cards: {} };
      prior.name = offer.name;
      prior.description = offer.description;
      Object.assign(prior.cards, offer.cards);
      merged.set(offer.key, prior);
    }
    const nextOffers = [...merged.values()].filter(offer => Object.keys(offer.cards || {}).length);
    const priorContent = JSON.stringify({ cards: old.snapshot?.cards || [], offers: old.snapshot?.offers || [] });
    const nextContent = JSON.stringify({ cards: [...cards.values()], offers: nextOffers });
    if (priorContent === nextContent) return false;
    const snapshot = { cards: [...cards.values()], offers: nextOffers, scannedAt: Date.now() };
    localStorage.setItem(BANKS.amex.source, JSON.stringify({ bank: "amex", publishedAt: Date.now(), snapshot }));
    return true;
  }

  function placements() {
    const output = [];
    for (const snapshot of Object.values(getData().snapshots)) {
      const cards = new Map(snapshot.cards.map(card => [card.id, card]));
      for (const offer of snapshot.offers) {
        for (const [cardId, status] of Object.entries(offer.cards)) {
          output.push({ bank: snapshot.bank, card: cards.get(cardId)?.name || "Card", status, name: offer.name, description: offer.description || "", scannedAt: snapshot.scannedAt });
        }
      }
    }
    return output;
  }

  function filteredPlacements() {
    const needle = normalize(query);
    return placements().filter(item => (bankFilter === "all" || item.bank === bankFilter)
      && (statusFilter === "all" || item.status === statusFilter)
      && (!needle || normalize(`${item.name} ${item.description} ${item.card} ${BANKS[item.bank]?.name}`).includes(needle)))
      .sort((left, right) => left.name.localeCompare(right.name) || left.bank.localeCompare(right.bank) || left.card.localeCompare(right.card));
  }

  function groupedResults() {
    const groups = new Map();
    for (const item of filteredPlacements()) {
      const merchant = merchantName(item.name);
      const key = normalize(merchant);
      if (!groups.has(key)) groups.set(key, { name: merchant, rows: [] });
      groups.get(key).rows.push(item);
    }
    return [...groups.values()];
  }

  function relativeTime(timestamp) {
    if (!timestamp) return "Never";
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    download(`card-offers-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(getData(), null, 2), "application/json");
  }

  function exportCsv() {
    const quote = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const rows = [["Bank", "Card", "Status", "Offer", "Description", "Last scanned"], ...placements().map(item => [BANKS[item.bank]?.name || item.bank, item.card, item.status, item.name, item.description, new Date(item.scannedAt).toISOString()])];
    download(`card-offers-${new Date().toISOString().slice(0, 10)}.csv`, rows.map(row => row.map(quote).join(",")).join("\n"), "text/csv;charset=utf-8");
  }

  function openDashboard() {
    window.open(DASHBOARD_URL, "_blank", "noopener");
  }

  function setMinimized(value) {
    minimized = Boolean(value);
    panel?.classList.toggle("minimized", minimized);
  }

  function beginDrag(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const origin = event.composedPath?.()[0] || event.target;
    if (!origin?.closest?.("[data-drag]")) return;
    if (origin.closest("button")) return;
    const rect = panel.getBoundingClientRect();
    dragState = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, startX: event.clientX, startY: event.clientY, moved: false };
    panel.setPointerCapture?.(event.pointerId);
  }

  function moveDrag(event) {
    if (!dragState || (dragState.pointerId !== undefined && event.pointerId !== undefined && dragState.pointerId !== event.pointerId)) return;
    if (Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY) > 4) dragState.moved = true;
    if (!dragState.moved) return;
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    const width = panel.offsetWidth || rect.width;
    const height = panel.offsetHeight || rect.height;
    panel.style.left = `${Math.max(8, Math.min(event.clientX - dragState.offsetX, window.innerWidth - width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(event.clientY - dragState.offsetY, window.innerHeight - height - 8))}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function endDrag(event) {
    if (!dragState) return;
    panel.releasePointerCapture?.(event.pointerId);
    dragState = null;
  }

  function render() {
    if (!root) return;
    const items = placements();
    const groups = groupedResults();
    const banks = new Set(items.map(item => item.bank)).size;
    const current = currentBank();
    root.querySelector("[data-current-bank]").innerHTML = current
      ? `<span>Syncing ${escapeHtml(BANKS[current].name)} offers by bank and card</span>`
      : '<span>Open a supported bank page to sync new scans.</span>';
    root.querySelector("[data-stats]").innerHTML = `<div><b>${banks}</b><span>Banks</span></div><div><b>${groups.length}</b><span>Matches</span></div><div><b>${filteredPlacements().length}</b><span>Cards</span></div>`;
    root.querySelector("[data-bank-filters]").innerHTML = ["all", ...Object.keys(BANKS)].map(value => `<button class="chip ${bankFilter === value ? "active" : ""}" data-bank-filter="${value}">${value === "all" ? "All banks" : BANKS[value].name}</button>`).join("");
    root.querySelector("[data-status-filters]").innerHTML = ["all", "addable", "added", "unknown"].map(value => `<button class="chip ${statusFilter === value ? "active" : ""}" data-status-filter="${value}">${value === "all" ? "Any status" : value === "unknown" ? "Unverified" : value[0].toUpperCase() + value.slice(1)}</button>`).join("");
    root.querySelector("[data-results]").innerHTML = groups.map(group => `<article class="offer"><div class="offer-title"><div><strong>${escapeHtml(group.name)}</strong><span>${group.rows.length} card offer${group.rows.length === 1 ? "" : "s"}</span></div><b>${group.rows.length}</b></div><div class="placements">${group.rows.map(item => {
      const terms = [normalize(item.name) === normalize(group.name) ? "" : item.name, item.description].filter(Boolean).join(" · ");
      return `<div class="placement"><span class="bank" style="--bank:${BANKS[item.bank]?.color || "#64748b"}">${escapeHtml(BANKS[item.bank]?.name || item.bank)}</span><span class="card"><strong>${escapeHtml(item.card)}</strong>${terms ? `<small>${escapeHtml(terms)}</small>` : ""}</span><span class="state ${item.status}">${item.status === "unknown" ? "Unverified" : item.status}</span><time>${relativeTime(item.scannedAt)}</time></div>`;
    }).join("")}</div></article>`).join("") || `<div class="empty">${items.length ? "No offers match this search." : "No synced offers yet. Open a bank offers page, then run that bank's scan."}</div>`;
    root.querySelector("[data-notice]").textContent = notice || `${items.length} card-offer records stored locally`;
    setMinimized(minimized);
  }

  function renderDashboard() {
    if (!dashboardRoot) return;
    const items = placements();
    const filtered = filteredPlacements();
    const groups = groupedResults();
    const cardCount = new Set(items.map(item => `${item.bank}|${item.card}`)).size;
    const lastUpdated = Math.max(0, ...items.map(item => Number(item.scannedAt) || 0));
    dashboardRoot.querySelector("[data-dashboard-stats]").innerHTML = `<div><b>${Object.keys(getData().snapshots).length}</b><span>Banks</span></div><div><b>${cardCount}</b><span>Cards</span></div><div><b>${groups.length}</b><span>Offers</span></div><div><b>${filtered.length}</b><span>Matches</span></div>`;
    dashboardRoot.querySelector("[data-dashboard-bank-filters]").innerHTML = ["all", ...Object.keys(BANKS)].map(value => `<button class="filter ${bankFilter === value ? "active" : ""}" data-bank-filter="${value}"><span class="dot" style="--dot:${value === "all" ? "#64748b" : BANKS[value].color}"></span>${value === "all" ? "All banks" : BANKS[value].name}</button>`).join("");
    dashboardRoot.querySelector("[data-dashboard-status-filters]").innerHTML = ["all", "addable", "added", "unknown"].map(value => `<button class="filter ${statusFilter === value ? "active" : ""}" data-status-filter="${value}">${value === "all" ? "Any status" : value === "unknown" ? "Unverified" : value[0].toUpperCase() + value.slice(1)}</button>`).join("");
    dashboardRoot.querySelector("[data-dashboard-updated]").textContent = lastUpdated ? `Updated ${relativeTime(lastUpdated)}` : "No scans yet";
    dashboardRoot.querySelector("[data-dashboard-results]").innerHTML = groups.map(group => `<section class="result-group"><header><div><h2>${escapeHtml(group.name)}</h2><span>${group.rows.length} card offer${group.rows.length === 1 ? "" : "s"}</span></div><b>${group.rows.length}</b></header><div class="table-head"><span>Bank</span><span>Card</span><span>Offer</span><span>Status</span><span>Updated</span></div>${group.rows.map(item => {
      const terms = [normalize(item.name) === normalize(group.name) ? "" : item.name, item.description].filter(Boolean).join(" · ");
      return `<div class="table-row"><span class="bank-name" style="--bank:${BANKS[item.bank]?.color || "#64748b"}">${escapeHtml(BANKS[item.bank]?.name || item.bank)}</span><strong>${escapeHtml(item.card)}</strong><span class="terms">${escapeHtml(terms || item.name)}</span><span class="status ${item.status}">${item.status === "unknown" ? "Unverified" : item.status}</span><time>${relativeTime(item.scannedAt)}</time></div>`;
    }).join("")}</section>`).join("") || `<div class="dashboard-empty">${items.length ? "No offers match this search." : "No offers have been synced yet. Open a bank offers page and run its scanner."}</div>`;
  }

  function mountDashboard() {
    dashboard = document.createElement("main");
    dashboard.id = DASHBOARD_ID;
    dashboardRoot = dashboard.attachShadow({ mode: "open" });
    dashboardRoot.innerHTML = `<style>
      :host{position:fixed;z-index:2147483647;inset:0;display:block;overflow:auto;background:#f4f6f8;color:#152238;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color-scheme:light}*{box-sizing:border-box;letter-spacing:0}button,input{font:inherit}svg{display:block;width:19px;height:19px}.topbar{position:sticky;z-index:3;top:0;display:flex;align-items:center;gap:14px;min-height:68px;padding:12px 24px;border-bottom:1px solid #dce2e8;background:#fff}.brand{display:grid;width:40px;height:40px;place-items:center;border-radius:7px;background:#102e57;color:#fff}.heading{min-width:0}.heading h1{margin:0;color:#0b2548;font-size:20px;line-height:1.2}.heading p{margin:2px 0 0;color:#718096;font-size:12px}.updated{margin-left:auto;color:#65758a;font-size:12px}.action{display:inline-flex;align-items:center;gap:7px;padding:8px 10px;border:1px solid #ccd5df;border-radius:6px;background:#fff;color:#29425f;font-weight:700;cursor:pointer}.layout{display:grid;grid-template-columns:230px minmax(0,1fr);min-height:calc(100dvh - 68px)}.sidebar{padding:20px 16px;border-right:1px solid #dce2e8;background:#fff}.side-title{margin:0 0 8px;color:#758196;font-size:10px;font-weight:800;text-transform:uppercase}.filter-list{display:grid;gap:3px;margin-bottom:22px}.filter{display:flex;align-items:center;gap:8px;width:100%;padding:8px 9px;border:0;border-radius:6px;background:transparent;color:#40516a;text-align:left;cursor:pointer}.filter:hover{background:#f0f4f8}.filter.active{background:#e8f0f8;color:#0b315f;font-weight:800}.dot{width:8px;height:8px;border-radius:50%;background:var(--dot)}.privacy{margin-top:24px;padding-top:14px;border-top:1px solid #e4e8ed;color:#8490a0;font-size:11px}.content{min-width:0;padding:20px 24px 40px}.search-row{display:flex;align-items:center;gap:12px}.search-box{display:flex;align-items:center;gap:9px;max-width:720px;flex:1;padding:10px 12px;border:1px solid #cbd5e0;border-radius:7px;background:#fff;color:#718096}.search-box input{width:100%;min-width:0;border:0;outline:0;color:#17273d;font-size:15px}.stats{display:grid;grid-template-columns:repeat(4,minmax(100px,1fr));gap:8px;margin:14px 0 18px}.stats div{padding:10px 12px;border:1px solid #dce2e8;border-radius:7px;background:#fff}.stats b,.stats span{display:block}.stats b{color:#0b315f;font-size:21px}.stats span{color:#78869a;font-size:11px}.results{display:grid;gap:10px}.result-group{overflow:hidden;border:1px solid #dce2e8;border-radius:7px;background:#fff}.result-group>header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 14px;border-bottom:1px solid #e8ecf0}.result-group h2{margin:0;color:#102e57;font-size:16px;line-height:1.25}.result-group header span{color:#7d8999;font-size:11px}.result-group header>b{color:#53657a}.table-head,.table-row{display:grid;grid-template-columns:90px minmax(150px,.8fr) minmax(240px,1.5fr) 88px 64px;align-items:center;gap:10px;padding:8px 14px}.table-head{background:#f7f9fb;color:#7b8798;font-size:10px;font-weight:800;text-transform:uppercase}.table-row{min-height:48px;border-top:1px solid #edf0f3;font-size:12px}.table-row:first-of-type{border-top:0}.bank-name{padding-left:8px;border-left:3px solid var(--bank);font-weight:800}.table-row strong{overflow-wrap:anywhere}.terms{color:#4f5f73;overflow-wrap:anywhere}.status{font-weight:800;text-transform:capitalize}.status.added{color:#28784f}.status.addable{color:#0874cf}.status.unknown{color:#9a5b13}.table-row time{color:#8490a0;text-align:right}.dashboard-empty{padding:80px 24px;color:#718096;text-align:center}@media(max-width:800px){.topbar{padding:10px 14px}.updated{display:none}.layout{grid-template-columns:1fr}.sidebar{position:static;padding:12px 14px;border-right:0;border-bottom:1px solid #dce2e8}.filter-list{display:flex;flex-wrap:wrap;margin-bottom:10px}.filter{width:auto;border:1px solid #dce2e8}.privacy,.side-title{display:none}.content{padding:14px}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.table-head{display:none}.table-row{grid-template-columns:80px minmax(0,1fr) 82px}.terms{grid-column:2/4}.table-row time{display:none}.action span{display:none}}
    </style><header class="topbar"><span class="brand">${ICONS.dashboard}</span><div class="heading"><h1>Card Offers Dashboard</h1><p>Private local view by bank and card</p></div><span class="updated" data-dashboard-updated></span><button class="action" data-json>${ICONS.download}<span>JSON</span></button><button class="action" data-csv>${ICONS.download}<span>CSV</span></button></header><div class="layout"><aside class="sidebar"><h3 class="side-title">Banks</h3><div class="filter-list" data-dashboard-bank-filters></div><h3 class="side-title">Status</h3><div class="filter-list" data-dashboard-status-filters></div><p class="privacy">Offer data stays in this browser. Bank logins, cookies and full card numbers are not stored.</p></aside><section class="content"><div class="search-row"><label class="search-box">${ICONS.search}<input data-dashboard-search type="search" placeholder="Search merchant, bank, card or offer..."></label></div><div class="stats" data-dashboard-stats></div><div class="results" data-dashboard-results></div></section></div>`;
    document.body.appendChild(dashboard);
    document.title = "Card Offers Dashboard";
    document.documentElement.style.overflow = "hidden";
    dashboardRoot.querySelector("[data-dashboard-search]").addEventListener("input", event => { query = event.target.value; renderDashboard(); });
    dashboardRoot.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.bankFilter) { bankFilter = button.dataset.bankFilter; renderDashboard(); }
      else if (button.dataset.statusFilter) { statusFilter = button.dataset.statusFilter; renderDashboard(); }
      else if (button.dataset.json !== undefined) exportJson();
      else if (button.dataset.csv !== undefined) exportCsv();
    });
    renderDashboard();
    return dashboard;
  }

  function mount() {
    panel = document.createElement("aside");
    panel.id = ID;
    root = panel.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host{position:fixed;z-index:2147483645;right:18px;bottom:18px;width:min(720px,calc(100vw - 36px));color:#142033;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color-scheme:light}:host(.minimized){width:auto}*{box-sizing:border-box;letter-spacing:0}svg{display:block;width:18px;height:18px}.launcher{display:none;align-items:center;gap:8px;padding:10px 13px;border:1px solid #0a2b63;border-radius:7px;background:#0a2b63;color:#fff;box-shadow:0 8px 24px #14203333;font:700 13px/1 inherit;cursor:pointer}:host(.minimized) .launcher{display:flex}:host(.minimized) .shell{display:none}.shell{display:flex;max-height:calc(100dvh - 36px);flex-direction:column;overflow:hidden;border:1px solid #d9e0e9;border-radius:8px;background:#f6f8fb;box-shadow:0 16px 38px #1420332e}.header{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid #e1e6ed;background:#fff;cursor:grab;touch-action:none}.mark{display:grid;width:42px;height:42px;place-items:center;flex:none;border-radius:7px;background:#0a2b63;color:#fff}.title{flex:1;min-width:0}.title strong{display:block;color:#071f52;font-size:18px;font-weight:800}.title span{display:block;color:#6d7889;font-size:11px}.icon{display:grid;width:32px;height:32px;place-items:center;padding:0;border:1px solid #d5dce6;border-radius:6px;background:#fff;color:#183b68;cursor:pointer}.bank-bar{display:flex;align-items:center;padding:10px 16px;border-bottom:1px solid #e2e7ee;background:#eef4fa;color:#42566f;font-size:12px}.chip{padding:6px 9px;border:1px solid #d2dae5;border-radius:6px;background:#fff;color:#45556b;font:700 11px/1.2 inherit;cursor:pointer}.chip.active{border-color:#0a2b63;background:#0a2b63;color:#fff}.controls{padding:12px 16px;border-bottom:1px solid #e1e6ed}.search{display:flex;align-items:center;gap:9px;padding:9px 11px;border:1px solid #cfd8e4;border-radius:7px;background:#fff;color:#718096}.search input{width:100%;min-width:0;border:0;outline:0;background:transparent;color:#142033;font:15px/1.4 inherit}.toolbar,.filters{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.toolbar{margin-top:9px}.toolbar button{display:inline-flex;align-items:center;gap:6px;padding:7px 9px;border:1px solid #d2dae5;border-radius:6px;background:#fff;color:#344861;font:700 11px/1.2 inherit;cursor:pointer}.toolbar .spacer{flex:1}.filters{margin-top:8px}.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:10px}.stats div{padding:8px;border:1px solid #dce3ec;border-radius:6px;background:#fff}.stats b,.stats span{display:block}.stats b{color:#071f52;font-size:18px}.stats span{color:#7a8594;font-size:10px}.results{display:flex;min-height:80px;flex-direction:column;gap:8px;overflow:auto;padding:12px 16px}.offer{border:1px solid #dfe5ec;border-radius:7px;background:#fff}.offer-title{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px}.offer-title strong{display:block;color:#071f52;font-size:17px;font-weight:800;overflow-wrap:anywhere}.offer-title span{display:block;margin-top:2px;color:#697586;font-size:12px}.offer-title>b{min-width:28px;color:#53657a;text-align:right}.placements{border-top:1px solid #edf0f4}.placement{display:grid;grid-template-columns:76px minmax(110px,1fr) 76px 52px;align-items:center;gap:7px;padding:8px 12px;border-top:1px solid #edf0f4;font-size:11px}.placement:first-child{border-top:0}.bank{padding-left:7px;border-left:3px solid var(--bank);font-weight:800}.card{display:block;min-width:0;color:#344861}.card strong,.card small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.card strong{font-size:11px}.card small{margin-top:2px;color:#778395;font-size:10px}.state{font-weight:800;text-transform:capitalize}.state.added{color:#28784f}.state.addable{color:#0874cf}.state.unknown{color:#9a5b13}.placement time{color:#8490a0;text-align:right}.empty{padding:32px 18px;color:#697586;text-align:center}.footer{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 16px;border-top:1px solid #e1e6ed;background:#fff;color:#6e7b8c;font-size:11px}@media(max-width:560px){:host{right:8px;bottom:8px;width:calc(100vw - 16px)}.shell{max-height:calc(100dvh - 16px)}.toolbar .spacer{display:none}.placement{grid-template-columns:70px minmax(0,1fr)}.state,.placement time{grid-column:auto}.stats{grid-template-columns:repeat(3,minmax(0,1fr))}}
    </style><button class="launcher" data-restore>${ICONS.card}<span>Offer Hub</span></button><div class="shell"><header class="header" data-drag><span class="mark">${ICONS.card}</span><div class="title"><strong>Card Offers Hub</strong><span>Private local search by bank and card</span></div><button class="icon" data-minimize title="Minimize" aria-label="Minimize">${ICONS.minimize}</button></header><div class="bank-bar" data-current-bank></div><div class="controls"><label class="search">${ICONS.search}<input data-search type="search" placeholder="Search CVS, Lyft, dining..."></label><div class="toolbar"><button data-sync>${ICONS.refresh}Sync now</button><button data-dashboard>${ICONS.dashboard}Dashboard</button><span class="spacer"></span><button data-json>${ICONS.download}JSON</button><button data-csv>${ICONS.download}CSV</button></div><div class="filters" data-bank-filters></div><div class="filters" data-status-filters></div><div class="stats" data-stats></div></div><section class="results" data-results></section><footer class="footer"><span data-notice></span><span>v0.1.6</span></footer></div>`;
    document.body.appendChild(panel);
    root.querySelector("[data-search]").addEventListener("input", event => { query = event.target.value; render(); });
    root.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.restore !== undefined) setMinimized(false);
      else if (button.dataset.minimize !== undefined) setMinimized(true);
      else if (button.dataset.bankFilter) { bankFilter = button.dataset.bankFilter; render(); }
      else if (button.dataset.statusFilter) { statusFilter = button.dataset.statusFilter; render(); }
      else if (button.dataset.sync !== undefined) { notice = syncCurrentBank(true) ? notice : "No completed scan found on this page"; render(); }
      else if (button.dataset.dashboard !== undefined) openDashboard();
      else if (button.dataset.json !== undefined) exportJson();
      else if (button.dataset.csv !== undefined) exportCsv();
    });
    panel.addEventListener("pointerdown", beginDrag);
    panel.addEventListener("pointermove", moveDrag);
    panel.addEventListener("pointerup", endDrag);
    panel.addEventListener("pointercancel", endDrag);
    render();
  }

  const api = { sanitizeSnapshot, mergeSnapshots, placements, filteredPlacements, groupedResults, syncCurrentBank, collectAmexPage, getData, render, renderDashboard, mount: () => { mount(); return panel; }, mountDashboard };
  if (globalThis.__CARD_OFFERS_HUB_TEST__) { globalThis.__CARD_OFFERS_HUB_TEST__.api = api; return; }
  if (window.top !== window.self || document.getElementById(ID)) return;
  GM_registerMenuCommand?.("Open Card Offers Dashboard", openDashboard);
  if (isDashboardPage()) {
    mountDashboard();
    GM_addValueChangeListener?.(DATA_KEY, () => renderDashboard());
    return;
  }
  mount();
  syncCurrentBank();
  window.addEventListener("card-offers-hub-source", () => { lastSourceText = ""; syncCurrentBank(); });
  window.setInterval(() => syncCurrentBank(), 2500);
  GM_addValueChangeListener?.(DATA_KEY, () => render());
  GM_registerMenuCommand?.("Open Card Offers Hub", () => setMinimized(false));
})();
