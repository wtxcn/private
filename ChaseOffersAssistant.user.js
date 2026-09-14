// ==UserScript==
// @name         Chase Offers Assistant
// @namespace    https://www.chase.com/
// @version      0.1.4
// @description  Scan and manage Chase Offers across cards, with explicit confirmation before adding.
// @match        https://*.chase.com/*
// @match        https://chase.com/*
// @updateURL    https://raw.githubusercontent.com/wtxcn/private/main/ChaseOffersAssistant.user.js
// @downloadURL  https://raw.githubusercontent.com/wtxcn/private/main/ChaseOffersAssistant.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const ID = "chase-offers-assistant";
  const SNAPSHOT_KEY = "chaseOffersAssistantSnapshot.v1";
  const ADD_RUN_KEY = "chaseOffersAssistantAddRun.v1";
  const ADD_RUN_TTL_MS = 120000;
  const OVERVIEW_URL = "https://secure.chase.com/web/auth/dashboard#/dashboard/overview";
  const WAIT_MS = 30000;

  let panel;
  let scanInProgress = false;
  let addInProgress = false;
  let cancelRequested = false;
  let searchTerm = "";
  let viewFilter = "all";
  let cardFilter = "";
  let snapshot = loadSnapshot();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function loadSnapshot() {
    try {
      const value = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "null");
      if (value && Array.isArray(value.cards) && Array.isArray(value.offers)) return value;
    } catch (_) {
      // A malformed cached scan is disposable.
    }
    return { cards: [], offers: [], selected: {}, scannedAt: 0, logs: [] };
  }

  function saveSnapshot() {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  }

  function loadAddRun() {
    try {
      const run = JSON.parse(sessionStorage.getItem(ADD_RUN_KEY) || "null");
      return Array.isArray(run?.tasks) && Number.isInteger(run.index) ? run : null;
    } catch (_) {
      return null;
    }
  }

  function saveAddRun(run, armResume = false) {
    const next = { ...run, resumeUntil: armResume ? Date.now() + ADD_RUN_TTL_MS : run.resumeUntil || 0 };
    sessionStorage.setItem(ADD_RUN_KEY, JSON.stringify(next));
    return next;
  }

  function clearAddRun() {
    sessionStorage.removeItem(ADD_RUN_KEY);
  }

  function log(message) {
    const time = new Date().toLocaleTimeString();
    snapshot.logs = [...(snapshot.logs || []), `[${time}] ${message}`].slice(-100);
    saveSnapshot();
    render();
  }

  function textOf(node) {
    return (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(node) {
    if (!node?.getBoundingClientRect) return false;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    }[character]));
  }

  function offerTitleText(value) {
    return String(value || "")
      .replace(/^\d+\s+of\s+\d+\s+/i, "")
      .split(/\b(?:add offer|success added)\b/i)[0]
      .replace(/\b(new|expiring soon|last day|\d+\s*(?:d|days?)\s*left)\b/ig, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeOfferName(value) {
    return offerTitleText(value).toLowerCase();
  }

  function displayOfferName(value) {
    return offerTitleText(value);
  }

  function offerHubUrl(accountId) {
    return `https://secure.chase.com/web/auth/dashboard#/dashboard/merchantOffers/offerCategoriesPage?accountId=${encodeURIComponent(accountId)}&offerCategoryName=ALL`;
  }

  function currentAccountId() {
    const match = location.href.match(/[?&]accountId=(\d+)/i);
    return match?.[1] || "";
  }

  function isOverviewPage() {
    return /\/dashboard\/overview/i.test(location.hash || location.href);
  }

  function isOffersPage(accountId = "") {
    return /\/merchantOffers\/offerCategoriesPage/i.test(location.hash || location.href)
      && (!accountId || currentAccountId() === String(accountId));
  }

  function pageHasOfferError() {
    return /your account is not eligible to access Chase Offers/i.test(textOf(document.body));
  }

  function getCardName(node) {
    const accountId = node.id.match(/requestCardPayment-(\d+)$/)?.[1];
    const exactName = accountId ? document.querySelector(`#accounts-name-link-button-${accountId}`) : null;
    if (exactName) return textOf(exactName);
    let parent = node;
    for (let level = 0; level < 5 && parent; level += 1, parent = parent.parentElement) {
      const name = textOf(parent.querySelector?.('[id^="accounts-name-link-button-"]'));
      if (name) return name;
    }
    return `Card (...${node.id.slice(-4)})`;
  }

  function readCards() {
    if (!isOverviewPage()) return [];
    const seen = new Set();
    return Array.from(document.querySelectorAll('[id^="account-tile-navigation-button-requestCardPayment-"]'))
      .filter(isVisible)
      .map((node) => {
        const id = node.id.match(/requestCardPayment-(\d+)$/)?.[1];
        return id ? { id, name: getCardName(node) } : null;
      })
      .filter((card) => card && !seen.has(card.id) && seen.add(card.id));
  }

  function readOffersForCard() {
    // Chase exposes these in the same page world even when ordinary button queries are incomplete.
    const tiles = Array.from(document.querySelectorAll('[data-testid="commerce-tile"]'))
      .filter((node) => !node.closest?.(`#${ID}`) && isVisible(node));
    const offers = [];
    for (const tile of tiles) {
      const label = `${tile.getAttribute("aria-label") || ""} ${textOf(tile)}`.replace(/\s+/g, " ").trim();
      if (!/\b(add offer|success added)\b/i.test(label)) continue;
      const name = displayOfferName(label);
      const key = normalizeOfferName(name);
      if (!key || key.length < 3) continue;
      offers.push({ key, name, status: /success added/i.test(label) ? "added" : "addable" });
    }
    return offers;
  }

  function mergeCardOffers(card, cardOffers) {
    const offers = new Map(snapshot.offers.map((offer) => [offer.key, offer]));
    for (const offer of offers.values()) delete offer.cards[card.id];
    for (const item of cardOffers) {
      const offer = offers.get(item.key) || { key: item.key, name: item.name, cards: {} };
      offer.name = offer.name.length >= item.name.length ? offer.name : item.name;
      offer.cards[card.id] = item.status;
      offers.set(item.key, offer);
    }
    snapshot.offers = [...offers.values()].filter((offer) => Object.keys(offer.cards).length > 0)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async function waitFor(check, timeout = WAIT_MS) {
    const startedAt = Date.now();
    while (!cancelRequested && Date.now() - startedAt < timeout) {
      if (check()) return true;
      await sleep(350);
    }
    return false;
  }

  async function openOverview() {
    if (!isOverviewPage()) location.assign(OVERVIEW_URL);
    return waitFor(() => isOverviewPage() && readCards().length > 0);
  }

  async function openOffers(card) {
    if (!isOffersPage(card.id)) location.assign(offerHubUrl(card.id));
    return waitFor(() => pageHasOfferError() || (isOffersPage(card.id) && readOffersForCard().length > 0));
  }

  async function scanAllCards() {
    if (scanInProgress || addInProgress) return;
    scanInProgress = true;
    cancelRequested = false;
    render();
    try {
      const ready = await openOverview();
      if (!ready) throw new Error("Account overview did not load");
      snapshot.cards = readCards();
      snapshot.offers = [];
      snapshot.selected = {};
      saveSnapshot();
      log(`Found ${snapshot.cards.length} card(s). Starting read-only scan.`);

      for (let index = 0; index < snapshot.cards.length && !cancelRequested; index += 1) {
        const card = snapshot.cards[index];
        log(`Scanning ${index + 1}/${snapshot.cards.length}: ${card.name}`);
        const loaded = await openOffers(card);
        if (!loaded || pageHasOfferError()) {
          log(`Skipped ${card.name}: Chase did not load offers for this card.`);
          continue;
        }
        const offers = readOffersForCard();
        mergeCardOffers(card, offers);
        saveSnapshot();
        log(`${card.name}: ${offers.filter((offer) => offer.status === "addable").length} addable, ${offers.filter((offer) => offer.status === "added").length} added.`);
      }
      if (!cancelRequested) {
        snapshot.scannedAt = Date.now();
        saveSnapshot();
        log(`Scan complete: ${snapshot.offers.length} unique offer(s).`);
      }
    } catch (error) {
      log(`Scan stopped: ${error.message}`);
    } finally {
      scanInProgress = false;
      render();
    }
  }

  function selectedTasks() {
    const byKey = new Map(snapshot.offers.map((offer) => [offer.key, offer]));
    return Object.entries(snapshot.selected || []).flatMap(([key, ids]) => {
      const offer = byKey.get(key);
      if (!offer) return [];
      return ids.map((cardId) => ({ offer, card: snapshot.cards.find((item) => item.id === cardId) }))
        .filter((task) => task.card && task.offer.cards[task.card.id] === "addable");
    });
  }

  function toggleSelection(key, cardId) {
    const selected = new Set(snapshot.selected?.[key] || []);
    if (selected.has(cardId)) selected.delete(cardId);
    else selected.add(cardId);
    if (selected.size) snapshot.selected[key] = [...selected];
    else delete snapshot.selected[key];
    saveSnapshot();
    render();
  }

  function selectVisibleAddable() {
    for (const offer of filteredOffers()) {
      snapshot.selected[offer.key] = Object.entries(offer.cards)
        .filter(([, status]) => status === "addable")
        .map(([cardId]) => cardId);
    }
    saveSnapshot();
    render();
  }

  function clearSelection() {
    snapshot.selected = {};
    saveSnapshot();
    render();
  }

  function findAddButton(offer) {
    return Array.from(document.querySelectorAll('[data-testid="commerce-tile"]'))
      .filter((tile) => !tile.closest?.(`#${ID}`) && isVisible(tile))
      .find((tile) => {
        const label = `${tile.getAttribute("aria-label") || ""} ${textOf(tile)}`;
        return normalizeOfferName(label) === offer.key && /\badd offer\b/i.test(label);
      });
  }

  function taskFromRun(run) {
    const item = run.tasks[run.index];
    if (!item) return null;
    const offer = snapshot.offers.find((candidate) => candidate.key === item.offerKey);
    const card = snapshot.cards.find((candidate) => candidate.id === item.cardId);
    return offer && card ? { offer, card } : null;
  }

  function advanceAddRun(run) {
    run.index += 1;
    return saveAddRun(run);
  }

  async function processAddRun() {
    let run = loadAddRun();
    if (!run || scanInProgress || addInProgress) return;
    addInProgress = true;
    cancelRequested = false;
    render();
    try {
      while (run.index < run.tasks.length && !cancelRequested) {
        const task = taskFromRun(run);
        if (!task) {
          log(`Skipped ${run.index + 1}/${run.tasks.length}: the scanned offer or card is no longer available.`);
          run = advanceAddRun(run);
          continue;
        }
        const { card, offer } = task;
        log(`Adding ${run.index + 1}/${run.tasks.length}: ${offer.name} to ${card.name}`);
        run = saveAddRun(run, true);
        const loaded = await openOffers(card);
        if (!loaded || pageHasOfferError()) {
          log(`Skipped ${offer.name}: Chase did not load ${card.name}.`);
          run = advanceAddRun(run);
          continue;
        }
        const button = findAddButton(offer);
        if (!button) {
          log(`Skipped ${offer.name}: it is no longer addable on ${card.name}.`);
          run = advanceAddRun(run);
          continue;
        }
        button.scrollIntoView({ block: "center", inline: "nearest" });
        await sleep(250);
        if (cancelRequested) break;
        run = saveAddRun(run, true);
        button.click();
        await sleep(900);

        if (!isOffersPage(card.id)) {
          run = saveAddRun(run, true);
          const returned = await openOffers(card);
          if (!returned) {
            log(`Could not verify ${offer.name} on ${card.name}.`);
            run = advanceAddRun(run);
            continue;
          }
        }
        const added = await waitFor(() => readOffersForCard().some((item) => item.key === offer.key && item.status === "added"), 12000);
        if (added) {
          offer.cards[card.id] = "added";
          snapshot.selected[offer.key] = (snapshot.selected[offer.key] || []).filter((id) => id !== card.id);
          if (!snapshot.selected[offer.key]?.length) delete snapshot.selected[offer.key];
          saveSnapshot();
          log(`Added ${offer.name} to ${card.name}.`);
        } else {
          log(`Could not confirm ${offer.name} on ${card.name}; review it in Chase before retrying.`);
        }
        run = advanceAddRun(run);
      }
      if (cancelRequested) log("Stopped by user.");
      else if (run.index >= run.tasks.length) log("Finished all selected offers.");
    } catch (error) {
      log(`Adding stopped: ${error.message}`);
    } finally {
      clearAddRun();
      addInProgress = false;
      render();
    }
  }

  async function addSelectedOffers() {
    const tasks = selectedTasks();
    if (!tasks.length || scanInProgress || addInProgress) return;
    if (!window.confirm(`Add ${tasks.length} selected offer(s)? Chase will apply each offer to the selected card.`)) return;
    saveAddRun({ tasks: tasks.map(({ offer, card }) => ({ offerKey: offer.key, cardId: card.id })), index: 0 });
    await processAddRun();
  }

  function stopCurrentRun() {
    cancelRequested = true;
    clearAddRun();
    log("Stop requested. The current page action will finish safely.");
  }

  function filteredOffers() {
    const query = searchTerm.trim().toLowerCase();
    return snapshot.offers.filter((offer) => {
      const statuses = Object.values(offer.cards);
      if (cardFilter && !offer.cards[cardFilter]) return false;
      if (viewFilter === "addable" && !statuses.includes("addable")) return false;
      if (viewFilter === "added" && !statuses.includes("added")) return false;
      return !query || offer.name.toLowerCase().includes(query);
    });
  }

  function selectedCount() {
    return selectedTasks().length;
  }

  function countOfferPlacements(status) {
    return snapshot.offers.reduce((total, offer) => total + Object.values(offer.cards)
      .filter((value) => value === status).length, 0);
  }

  function countCardOffers(cardId) {
    return snapshot.offers.reduce((total, offer) => total + (offer.cards[cardId] ? 1 : 0), 0);
  }

  function makePanel() {
    const element = document.createElement("aside");
    element.id = ID;
    document.body.appendChild(element);
    return element;
  }

  function render() {
    if (!panel) return;
    const offers = filteredOffers();
    const mode = scanInProgress ? "Scanning" : addInProgress ? "Adding" : "Ready";
    const date = snapshot.scannedAt ? new Date(snapshot.scannedAt).toLocaleString() : "Not scanned";
    const addableOffers = snapshot.offers.filter((offer) => Object.values(offer.cards).includes("addable")).length;
    const addedOffers = snapshot.offers.filter((offer) => Object.values(offer.cards).includes("added")).length;
    const addablePlacements = countOfferPlacements("addable");
    const addedPlacements = countOfferPlacements("added");
    const selected = selectedCount();
    panel.innerHTML = `
      <style>
        #${ID} { position:fixed; z-index:2147483647; top:82px; right:16px; width:min(660px,calc(100vw - 32px)); max-height:calc(100vh - 98px); display:flex; flex-direction:column; overflow:hidden; color:#142033; background:#f5f7fb; border:1px solid #9eafc6; border-radius:8px; box-shadow:0 16px 40px rgba(0,23,62,.24); font:13px/1.35 Arial,sans-serif; }
        #${ID} * { box-sizing:border-box; }
        #${ID} header { display:flex; align-items:center; justify-content:space-between; padding:13px 16px; color:#fff; background:#0b2f60; border-bottom:3px solid #1677c8; }
        #${ID} .brand { font-size:15px; font-weight:700; }
        #${ID} .subbrand { margin-top:1px; color:#bdd4ee; font-size:11px; }
        #${ID} .run-state { color:#d9eafb; font-size:12px; font-weight:700; }
        #${ID} main { min-height:0; overflow:auto; }
        #${ID} .controls { position:sticky; top:0; z-index:2; padding:12px 16px 10px; background:#f5f7fb; border-bottom:1px solid #d6e0ed; }
        #${ID} button { border:1px solid #0a5da9; border-radius:5px; padding:7px 10px; color:#fff; background:#0a5da9; font:600 12px/1.2 Arial,sans-serif; cursor:pointer; }
        #${ID} button + button { margin-left:6px; }
        #${ID} button.secondary { color:#0a5da9; background:#fff; }
        #${ID} button.danger { border-color:#b3261e; background:#b3261e; }
        #${ID} button:disabled { opacity:.55; cursor:not-allowed; }
        #${ID} .actions { display:flex; flex-wrap:wrap; gap:6px; }
        #${ID} .actions button + button { margin-left:0; }
        #${ID} .search { display:flex; align-items:center; margin-top:10px; padding:0 10px; background:#fff; border:1px solid #b9c9dc; border-radius:5px; box-shadow:0 1px 2px rgba(0,23,62,.04); }
        #${ID} .search span { color:#58708e; font-weight:700; }
        #${ID} input { width:100%; padding:9px 8px; border:0; outline:0; color:#142033; background:transparent; font:inherit; }
        #${ID} .stats { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:7px; margin-top:10px; }
        #${ID} .stat { min-width:0; padding:8px 9px; background:#fff; border:1px solid #d5dfeb; border-radius:6px; box-shadow:0 1px 2px rgba(0,23,62,.03); }
        #${ID} .stat b { display:block; color:#102e55; font-size:16px; font-variant-numeric:tabular-nums; }
        #${ID} .stat span { display:block; margin-top:1px; color:#61738a; font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        #${ID} .filters { display:flex; align-items:center; gap:2px; margin-top:10px; }
        #${ID} .filter { border:0; border-radius:0; padding:6px 9px; color:#52667e; background:transparent; font-weight:700; }
        #${ID} .filter + .filter { margin-left:0; }
        #${ID} .filter.active { color:#0b2f60; box-shadow:inset 0 -2px 0 #1478c9; }
        #${ID} .card-scope { display:flex; align-items:center; flex-wrap:wrap; gap:5px; margin-top:8px; }
        #${ID} .scope-label { margin-right:2px; color:#697b91; font-size:10px; font-weight:700; text-transform:uppercase; }
        #${ID} .scope { margin:0; padding:4px 7px; border-color:#c5d2e0; color:#4a6079; background:#fff; font-size:10px; font-weight:700; }
        #${ID} .scope.active { color:#fff; border-color:#0a5da9; background:#0a5da9; }
        #${ID} .list { display:flex; flex-direction:column; gap:7px; padding:10px 16px 14px; }
        #${ID} .offer { padding:10px 11px; background:#fff; border:1px solid #d7e0ec; border-radius:7px; box-shadow:0 1px 2px rgba(0,23,62,.04); }
        #${ID} .offer.selected-row { border-color:#4b9cda; box-shadow:0 0 0 1px #4b9cda inset,0 1px 2px rgba(0,23,62,.04); }
        #${ID} .offer-head { display:flex; align-items:flex-start; gap:12px; }
        #${ID} .offer-main { flex:1; min-width:0; }
        #${ID} .offer-name { color:#142033; font-size:13px; font-weight:700; line-height:1.3; overflow-wrap:anywhere; }
        #${ID} .offer-meta { margin-top:2px; color:#71839a; font-size:11px; }
        #${ID} .offer-count { min-width:64px; color:#0b2f60; font-size:12px; font-weight:700; text-align:right; font-variant-numeric:tabular-nums; }
        #${ID} .offer-count span { display:block; color:#71839a; font-size:10px; font-weight:400; }
        #${ID} .cards { display:flex; flex-wrap:wrap; gap:5px; margin-top:9px; }
        #${ID} .card { margin:0; padding:5px 7px; border-color:#b7c8db; background:#fff; color:#40536b; font-size:11px; font-weight:600; }
        #${ID} .card.selected { color:#fff; border-color:#0a5da9; background:#0a5da9; }
        #${ID} .card.added { color:#789; border-color:#d8e1eb; background:#f5f7fa; cursor:default; text-decoration:line-through; }
        #${ID} .empty { padding:30px 16px; color:#64748b; text-align:center; }
        #${ID} details { margin:0 16px 14px; border-top:1px solid #d6e0ed; }
        #${ID} summary { padding:9px 0; color:#5e7088; font-size:11px; font-weight:700; cursor:pointer; }
        #${ID} .logs { max-height:110px; overflow:auto; margin-bottom:10px; padding:8px; border-radius:5px; background:#102746; color:#d9eafb; white-space:pre-wrap; font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; }
        @media (max-width:560px) { #${ID} { right:8px; width:calc(100vw - 16px); } #${ID} .stats { grid-template-columns:repeat(2,minmax(0,1fr)); } #${ID} .actions button { flex:1 1 auto; } }
      </style>
      <header><div><div class="brand">Chase Offers</div><div class="subbrand">Offer Assistant</div></div><span class="run-state">${mode}</span></header>
      <main>
        <div class="controls">
          <div class="actions">
          <button data-scan ${scanInProgress || addInProgress ? "disabled" : ""}>Scan all cards</button>
          <button class="secondary" data-select ${scanInProgress || addInProgress ? "disabled" : ""}>Select visible</button>
          <button class="secondary" data-clear ${scanInProgress || addInProgress ? "disabled" : ""}>Clear</button>
          <button data-add ${selected && !scanInProgress && !addInProgress ? "" : "disabled"}>Add selected (${selected})</button>
          <button class="danger" data-stop ${scanInProgress || addInProgress ? "" : "disabled"}>Stop</button>
          </div>
          <label class="search"><span>Search</span><input data-search placeholder="Search scanned offers" value="${escapeHtml(searchTerm)}"></label>
          <div class="stats"><div class="stat"><b>${snapshot.cards.length}</b><span>Cards</span></div><div class="stat"><b>${snapshot.offers.length}</b><span>Unique offers</span></div><div class="stat"><b>${addablePlacements}</b><span>Addable cards</span></div><div class="stat"><b>${addedPlacements}</b><span>Added cards</span></div><div class="stat"><b>${selected}</b><span>Selected</span></div></div>
          <div class="filters"><button class="filter ${viewFilter === "all" ? "active" : ""}" data-filter="all">All ${snapshot.offers.length}</button><button class="filter ${viewFilter === "addable" ? "active" : ""}" data-filter="addable">Addable ${addableOffers}</button><button class="filter ${viewFilter === "added" ? "active" : ""}" data-filter="added">Added ${addedOffers}</button></div>
          <div class="card-scope"><span class="scope-label">Card</span><button class="scope ${!cardFilter ? "active" : ""}" data-card-filter="">All cards</button>${snapshot.cards.map((card) => `<button class="scope ${cardFilter === card.id ? "active" : ""}" data-card-filter="${card.id}">${escapeHtml(card.name)} · ${countCardOffers(card.id)}</button>`).join("")}</div>
        </div>
        <section class="list">${offers.map((offer) => {
          const addable = Object.values(offer.cards).filter((status) => status === "addable").length;
          const added = Object.values(offer.cards).filter((status) => status === "added").length;
          const visibleOn = Object.keys(offer.cards).length;
          const selectedRow = (snapshot.selected[offer.key] || []).length > 0;
          return `<article class="offer ${selectedRow ? "selected-row" : ""}"><div class="offer-head"><div class="offer-main"><div class="offer-name">${escapeHtml(offer.name)}</div><div class="offer-meta">${visibleOn}/${snapshot.cards.length} cards · ${added ? `${added} added` : "Choose cards below"}</div></div><div class="offer-count">${addable}<span>addable</span></div></div><div class="cards">${snapshot.cards.filter((card) => offer.cards[card.id]).map((card) => {
            const status = offer.cards[card.id];
            const isSelected = (snapshot.selected[offer.key] || []).includes(card.id);
            const classes = `card ${status === "added" ? "added" : isSelected ? "selected" : ""}`;
            return `<button class="${classes}" data-toggle="${escapeHtml(encodeURIComponent(offer.key))}" data-card="${card.id}" ${status === "added" ? "disabled" : ""}>${escapeHtml(card.name)}</button>`;
          }).join("")}</div></article>`;
        }).join("") || "<div class=\"empty\">Run Scan all cards to build your offer list.</div>"}</section>
        <details><summary>Scan log · ${date}</summary><div class="logs">${escapeHtml((snapshot.logs || []).join("\n"))}</div></details>
      </main>`;

    panel.querySelector("[data-scan]")?.addEventListener("click", scanAllCards);
    panel.querySelector("[data-select]")?.addEventListener("click", selectVisibleAddable);
    panel.querySelector("[data-clear]")?.addEventListener("click", clearSelection);
    panel.querySelector("[data-add]")?.addEventListener("click", addSelectedOffers);
    panel.querySelector("[data-stop]")?.addEventListener("click", stopCurrentRun);
    panel.querySelector("[data-search]")?.addEventListener("input", (event) => { searchTerm = event.target.value; render(); });
    panel.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => { viewFilter = button.dataset.filter; render(); }));
    panel.querySelectorAll("[data-card-filter]").forEach((button) => button.addEventListener("click", () => { cardFilter = button.dataset.cardFilter; render(); }));
    panel.querySelectorAll("[data-toggle]").forEach((button) => button.addEventListener("click", () => {
      toggleSelection(decodeURIComponent(button.dataset.toggle), button.dataset.card);
    }));
  }

  if (globalThis.__CHASE_ASSISTANT_TEST__) {
    globalThis.__CHASE_ASSISTANT_TEST__.api = { normalizeOfferName, displayOfferName, mergeCardOffers, readCards, readOffersForCard, selectedTasks, loadAddRun, saveAddRun, clearAddRun };
    return;
  }

  if (!document.getElementById(ID)) {
    panel = makePanel();
    render();
    const pendingRun = loadAddRun();
    if (pendingRun?.resumeUntil > Date.now()) {
      log(`Continuing ${pendingRun.tasks.length - pendingRun.index} selected offer(s) after Chase navigation.`);
      window.setTimeout(processAddRun, 800);
    } else if (pendingRun) {
      clearAddRun();
    }
  }
})();
