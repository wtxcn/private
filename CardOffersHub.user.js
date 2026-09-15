// ==UserScript==
// @name         Card Offers Hub
// @namespace    https://github.com/wtxcn/private
// @version      0.1.4
// @description  Combine P1 and P2 card-offer snapshots from supported banks into one private local search hub.
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
  const DATA_KEY = "cardOffersHub.data.v1";
  const PROFILE_KEY = bank => `cardOffersHub.profile.${bank}`;
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
    minimize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/></svg>'
  };

  let panel;
  let root;
  let minimized = true;
  let query = "";
  let profileFilter = "all";
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
  const getData = () => {
    const value = GM_getValue(DATA_KEY, { version: 1, snapshots: {} });
    return value && value.snapshots && typeof value.snapshots === "object" ? value : { version: 1, snapshots: {} };
  };
  const saveData = value => GM_setValue(DATA_KEY, value);
  const getProfile = bank => GM_getValue(PROFILE_KEY(bank), "P1") === "P2" ? "P2" : "P1";

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
    const profile = getProfile(bank);
    const data = getData();
    data.snapshots[`${profile}:${bank}`] = { profile, bank, publishedAt: Number(source.publishedAt) || Date.now(), ...snapshot };
    saveData(data);
    lastSourceText = sourceText;
    notice = `${profile} ${BANKS[bank].name} synced`;
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
          output.push({ profile: snapshot.profile, bank: snapshot.bank, card: cards.get(cardId)?.name || "Card", status, name: offer.name, description: offer.description || "", scannedAt: snapshot.scannedAt });
        }
      }
    }
    return output;
  }

  function filteredPlacements() {
    const needle = normalize(query);
    return placements().filter(item => (profileFilter === "all" || item.profile === profileFilter)
      && (bankFilter === "all" || item.bank === bankFilter)
      && (statusFilter === "all" || item.status === statusFilter)
      && (!needle || normalize(`${item.name} ${item.description} ${item.card} ${BANKS[item.bank]?.name}`).includes(needle)))
      .sort((left, right) => left.name.localeCompare(right.name) || left.profile.localeCompare(right.profile) || left.bank.localeCompare(right.bank));
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

  function setProfile(bank, profile) {
    GM_setValue(PROFILE_KEY(bank), profile);
    lastSourceText = "";
    syncCurrentBank(true);
    render();
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
    const rows = [["Profile", "Bank", "Card", "Status", "Offer", "Description", "Last scanned"], ...placements().map(item => [item.profile, BANKS[item.bank]?.name || item.bank, item.card, item.status, item.name, item.description, new Date(item.scannedAt).toISOString()])];
    download(`card-offers-${new Date().toISOString().slice(0, 10)}.csv`, rows.map(row => row.map(quote).join(",")).join("\n"), "text/csv;charset=utf-8");
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
    const profiles = new Set(items.map(item => item.profile)).size;
    const banks = new Set(items.map(item => item.bank)).size;
    const current = currentBank();
    const currentProfile = current ? getProfile(current) : "";
    root.querySelector("[data-current-profile]").innerHTML = current
      ? `<span>This ${escapeHtml(BANKS[current].name)} login saves as</span><button class="profile ${currentProfile === "P1" ? "active" : ""}" data-set-profile="P1">P1</button><button class="profile ${currentProfile === "P2" ? "active" : ""}" data-set-profile="P2">P2</button>`
      : '<span>Open a supported bank page to sync new scans.</span>';
    root.querySelector("[data-stats]").innerHTML = `<div><b>${profiles}</b><span>People</span></div><div><b>${banks}</b><span>Banks</span></div><div><b>${groups.length}</b><span>Matches</span></div><div><b>${filteredPlacements().length}</b><span>Cards</span></div>`;
    root.querySelector("[data-profile-filters]").innerHTML = ["all", "P1", "P2"].map(value => `<button class="chip ${profileFilter === value ? "active" : ""}" data-profile-filter="${value}">${value === "all" ? "All people" : value}</button>`).join("");
    root.querySelector("[data-bank-filters]").innerHTML = ["all", ...Object.keys(BANKS)].map(value => `<button class="chip ${bankFilter === value ? "active" : ""}" data-bank-filter="${value}">${value === "all" ? "All banks" : BANKS[value].name}</button>`).join("");
    root.querySelector("[data-status-filters]").innerHTML = ["all", "addable", "added", "unknown"].map(value => `<button class="chip ${statusFilter === value ? "active" : ""}" data-status-filter="${value}">${value === "all" ? "Any status" : value === "unknown" ? "Unverified" : value[0].toUpperCase() + value.slice(1)}</button>`).join("");
    root.querySelector("[data-results]").innerHTML = groups.map(group => `<article class="offer"><div class="offer-title"><div><strong>${escapeHtml(group.name)}</strong><span>${group.rows.length} card offer${group.rows.length === 1 ? "" : "s"}</span></div><b>${group.rows.length}</b></div><div class="placements">${group.rows.map(item => {
      const terms = [normalize(item.name) === normalize(group.name) ? "" : item.name, item.description].filter(Boolean).join(" · ");
      return `<div class="placement"><span class="person ${item.profile.toLowerCase()}">${item.profile}</span><span class="bank" style="--bank:${BANKS[item.bank]?.color || "#64748b"}">${escapeHtml(BANKS[item.bank]?.name || item.bank)}</span><span class="card"><strong>${escapeHtml(item.card)}</strong>${terms ? `<small>${escapeHtml(terms)}</small>` : ""}</span><span class="state ${item.status}">${item.status === "unknown" ? "Unverified" : item.status}</span><time>${relativeTime(item.scannedAt)}</time></div>`;
    }).join("")}</div></article>`).join("") || `<div class="empty">${items.length ? "No offers match this search." : "No synced offers yet. Choose P1 or P2 on a bank page, then run that bank's scan."}</div>`;
    root.querySelector("[data-notice]").textContent = notice || `${items.length} card-offer records stored locally`;
    setMinimized(minimized);
  }

  function mount() {
    panel = document.createElement("aside");
    panel.id = ID;
    root = panel.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host{position:fixed;z-index:2147483645;right:18px;bottom:18px;width:min(720px,calc(100vw - 36px));color:#142033;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color-scheme:light}:host(.minimized){width:auto}*{box-sizing:border-box;letter-spacing:0}svg{display:block;width:18px;height:18px}.launcher{display:none;align-items:center;gap:8px;padding:10px 13px;border:1px solid #0a2b63;border-radius:7px;background:#0a2b63;color:#fff;box-shadow:0 8px 24px #14203333;font:700 13px/1 inherit;cursor:pointer}:host(.minimized) .launcher{display:flex}:host(.minimized) .shell{display:none}.shell{display:flex;max-height:calc(100dvh - 36px);flex-direction:column;overflow:hidden;border:1px solid #d9e0e9;border-radius:8px;background:#f6f8fb;box-shadow:0 16px 38px #1420332e}.header{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid #e1e6ed;background:#fff;cursor:grab;touch-action:none}.mark{display:grid;width:42px;height:42px;place-items:center;flex:none;border-radius:7px;background:#0a2b63;color:#fff}.title{flex:1;min-width:0}.title strong{display:block;color:#071f52;font-size:18px;font-weight:800}.title span{display:block;color:#6d7889;font-size:11px}.icon{display:grid;width:32px;height:32px;place-items:center;padding:0;border:1px solid #d5dce6;border-radius:6px;background:#fff;color:#183b68;cursor:pointer}.profile-bar{display:flex;align-items:center;gap:7px;padding:10px 16px;border-bottom:1px solid #e2e7ee;background:#eef4fa;color:#42566f;font-size:12px}.profile-bar span{margin-right:auto}.profile,.chip{padding:6px 9px;border:1px solid #d2dae5;border-radius:6px;background:#fff;color:#45556b;font:700 11px/1.2 inherit;cursor:pointer}.profile.active,.chip.active{border-color:#0a2b63;background:#0a2b63;color:#fff}.controls{padding:12px 16px;border-bottom:1px solid #e1e6ed}.search{display:flex;align-items:center;gap:9px;padding:9px 11px;border:1px solid #cfd8e4;border-radius:7px;background:#fff;color:#718096}.search input{width:100%;min-width:0;border:0;outline:0;background:transparent;color:#142033;font:15px/1.4 inherit}.toolbar,.filters{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.toolbar{margin-top:9px}.toolbar button{display:inline-flex;align-items:center;gap:6px;padding:7px 9px;border:1px solid #d2dae5;border-radius:6px;background:#fff;color:#344861;font:700 11px/1.2 inherit;cursor:pointer}.toolbar .spacer{flex:1}.filters{margin-top:8px}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:10px}.stats div{padding:8px;border:1px solid #dce3ec;border-radius:6px;background:#fff}.stats b,.stats span{display:block}.stats b{color:#071f52;font-size:18px}.stats span{color:#7a8594;font-size:10px}.results{display:flex;min-height:80px;flex-direction:column;gap:8px;overflow:auto;padding:12px 16px}.offer{border:1px solid #dfe5ec;border-radius:7px;background:#fff}.offer-title{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px}.offer-title strong{display:block;color:#071f52;font-size:17px;font-weight:800;overflow-wrap:anywhere}.offer-title span{display:block;margin-top:2px;color:#697586;font-size:12px}.offer-title>b{min-width:28px;color:#53657a;text-align:right}.placements{border-top:1px solid #edf0f4}.placement{display:grid;grid-template-columns:34px 76px minmax(110px,1fr) 76px 52px;align-items:center;gap:7px;padding:8px 12px;border-top:1px solid #edf0f4;font-size:11px}.placement:first-child{border-top:0}.person{display:inline-grid;width:30px;height:22px;place-items:center;border-radius:5px;background:#dbeafe;color:#1d4f91;font-weight:800}.person.p2{background:#fce7f3;color:#9d174d}.bank{padding-left:7px;border-left:3px solid var(--bank);font-weight:800}.card{display:block;min-width:0;color:#344861}.card strong,.card small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.card strong{font-size:11px}.card small{margin-top:2px;color:#778395;font-size:10px}.state{font-weight:800;text-transform:capitalize}.state.added{color:#28784f}.state.addable{color:#0874cf}.state.unknown{color:#9a5b13}.placement time{color:#8490a0;text-align:right}.empty{padding:32px 18px;color:#697586;text-align:center}.footer{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 16px;border-top:1px solid #e1e6ed;background:#fff;color:#6e7b8c;font-size:11px}@media(max-width:560px){:host{right:8px;bottom:8px;width:calc(100vw - 16px)}.shell{max-height:calc(100dvh - 16px)}.toolbar .spacer{display:none}.placement{grid-template-columns:34px 70px minmax(0,1fr)}.state,.placement time{grid-column:auto}.profile-bar{flex-wrap:wrap}.profile-bar span{width:100%;margin:0}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
    </style><button class="launcher" data-restore>${ICONS.card}<span>Offer Hub</span></button><div class="shell"><header class="header" data-drag><span class="mark">${ICONS.card}</span><div class="title"><strong>Card Offers Hub</strong><span>P1 + P2 private local search</span></div><button class="icon" data-minimize title="Minimize" aria-label="Minimize">${ICONS.minimize}</button></header><div class="profile-bar" data-current-profile></div><div class="controls"><label class="search">${ICONS.search}<input data-search type="search" placeholder="Search CVS, Lyft, dining..."></label><div class="toolbar"><button data-sync>${ICONS.refresh}Sync now</button><span class="spacer"></span><button data-json>${ICONS.download}JSON</button><button data-csv>${ICONS.download}CSV</button></div><div class="filters" data-profile-filters></div><div class="filters" data-bank-filters></div><div class="filters" data-status-filters></div><div class="stats" data-stats></div></div><section class="results" data-results></section><footer class="footer"><span data-notice></span><span>v0.1.4</span></footer></div>`;
    document.body.appendChild(panel);
    root.querySelector("[data-search]").addEventListener("input", event => { query = event.target.value; render(); });
    root.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.restore !== undefined) setMinimized(false);
      else if (button.dataset.minimize !== undefined) setMinimized(true);
      else if (button.dataset.setProfile) setProfile(currentBank(), button.dataset.setProfile);
      else if (button.dataset.profileFilter) { profileFilter = button.dataset.profileFilter; render(); }
      else if (button.dataset.bankFilter) { bankFilter = button.dataset.bankFilter; render(); }
      else if (button.dataset.statusFilter) { statusFilter = button.dataset.statusFilter; render(); }
      else if (button.dataset.sync !== undefined) { notice = syncCurrentBank(true) ? notice : "No completed scan found on this page"; render(); }
      else if (button.dataset.json !== undefined) exportJson();
      else if (button.dataset.csv !== undefined) exportCsv();
    });
    panel.addEventListener("pointerdown", beginDrag);
    panel.addEventListener("pointermove", moveDrag);
    panel.addEventListener("pointerup", endDrag);
    panel.addEventListener("pointercancel", endDrag);
    render();
  }

  const api = { sanitizeSnapshot, placements, filteredPlacements, groupedResults, syncCurrentBank, collectAmexPage, getData, setProfile, render, mount: () => { mount(); return panel; } };
  if (globalThis.__CARD_OFFERS_HUB_TEST__) { globalThis.__CARD_OFFERS_HUB_TEST__.api = api; return; }
  if (window.top !== window.self || document.getElementById(ID)) return;
  mount();
  syncCurrentBank();
  window.addEventListener("card-offers-hub-source", () => { lastSourceText = ""; syncCurrentBank(); });
  window.setInterval(() => syncCurrentBank(), 2500);
  GM_addValueChangeListener?.(DATA_KEY, () => render());
  GM_registerMenuCommand?.("Open Card Offers Hub", () => setMinimized(false));
})();
