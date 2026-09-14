// ==UserScript==
// @name         Chase Offers Assistant
// @namespace    https://www.chase.com/
// @version      0.1.1
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
  const OVERVIEW_URL = "https://secure.chase.com/web/auth/dashboard#/dashboard/overview";
  const WAIT_MS = 30000;

  let panel;
  let scanInProgress = false;
  let addInProgress = false;
  let cancelRequested = false;
  let searchTerm = "";
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

  function normalizeOfferName(value) {
    return String(value || "")
      .replace(/^\d+\s+of\s+\d+\s+/i, "")
      .replace(/\b(add offer|success added|new|expiring soon|last day|\d+\s*(?:d|days?)\s*left)\b/ig, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function displayOfferName(value) {
    return String(value || "")
      .replace(/^\d+\s+of\s+\d+\s+/i, "")
      .replace(/\b(add offer|success added|new)\b/ig, "")
      .replace(/\s+/g, " ")
      .trim();
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

  async function addSelectedOffers() {
    const tasks = selectedTasks();
    if (!tasks.length || scanInProgress || addInProgress) return;
    if (!window.confirm(`Add ${tasks.length} selected offer(s)? Chase will apply each offer to the selected card.`)) return;

    addInProgress = true;
    cancelRequested = false;
    render();
    try {
      for (let index = 0; index < tasks.length && !cancelRequested; index += 1) {
        const { card, offer } = tasks[index];
        log(`Adding ${index + 1}/${tasks.length}: ${offer.name} to ${card.name}`);
        const loaded = await openOffers(card);
        if (!loaded || pageHasOfferError()) {
          log(`Skipped ${offer.name}: Chase did not load ${card.name}.`);
          continue;
        }
        const button = findAddButton(offer);
        if (!button) {
          log(`Skipped ${offer.name}: it is no longer addable on ${card.name}.`);
          continue;
        }
        button.scrollIntoView({ block: "center", inline: "nearest" });
        await sleep(250);
        if (cancelRequested) break;
        button.click();
        await sleep(900);

        if (!isOffersPage(card.id)) {
          const returned = await openOffers(card);
          if (!returned) {
            log(`Could not verify ${offer.name} on ${card.name}.`);
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
      }
    } catch (error) {
      log(`Adding stopped: ${error.message}`);
    } finally {
      addInProgress = false;
      render();
    }
  }

  function filteredOffers() {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return snapshot.offers;
    return snapshot.offers.filter((offer) => offer.name.toLowerCase().includes(query));
  }

  function selectedCount() {
    return selectedTasks().length;
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
    panel.innerHTML = `
      <style>
        #${ID} { position:fixed; z-index:2147483647; top:86px; right:16px; width:min(510px,calc(100vw - 32px)); max-height:calc(100vh - 104px); display:flex; flex-direction:column; color:#172033; background:#fff; border:1px solid #b9c5d8; border-radius:8px; box-shadow:0 12px 32px rgba(15,23,42,.25); font:13px/1.35 Arial,sans-serif; }
        #${ID} * { box-sizing:border-box; }
        #${ID} header { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid #dce3ee; font-weight:700; }
        #${ID} main { min-height:0; padding:10px 12px; overflow:auto; }
        #${ID} button { margin:0 5px 6px 0; border:1px solid #075aaf; border-radius:5px; padding:7px 9px; color:#fff; background:#075aaf; font:inherit; cursor:pointer; }
        #${ID} button.secondary { color:#075aaf; background:#fff; }
        #${ID} button.danger { border-color:#b42318; background:#b42318; }
        #${ID} button:disabled { opacity:.55; cursor:not-allowed; }
        #${ID} input { width:100%; padding:7px 8px; border:1px solid #aebcd0; border-radius:5px; font:inherit; }
        #${ID} .summary { margin:5px 0 9px; color:#4b596d; }
        #${ID} .offer { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:5px 8px; padding:8px 0; border-top:1px solid #e2e8f0; }
        #${ID} .offer-name { font-weight:700; overflow-wrap:anywhere; }
        #${ID} .cards { grid-column:1/-1; display:flex; flex-wrap:wrap; gap:5px; }
        #${ID} .card { margin:0; padding:4px 6px; border-color:#aebcd0; background:#fff; color:#334155; font-size:11px; }
        #${ID} .card.selected { color:#fff; border-color:#075aaf; background:#075aaf; }
        #${ID} .card.added { color:#64748b; border-color:#cbd5e1; background:#f8fafc; cursor:default; }
        #${ID} .status { color:#4b596d; font-size:12px; }
        #${ID} .logs { margin-top:9px; max-height:120px; overflow:auto; padding:7px; border-radius:5px; background:#101827; color:#dbeafe; white-space:pre-wrap; font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; }
      </style>
      <header><span>Chase Offers Assistant</span><span class="status">${mode}</span></header>
      <main>
        <div>
          <button data-scan ${scanInProgress || addInProgress ? "disabled" : ""}>Scan all cards</button>
          <button class="secondary" data-select ${scanInProgress || addInProgress ? "disabled" : ""}>Select visible</button>
          <button class="secondary" data-clear ${scanInProgress || addInProgress ? "disabled" : ""}>Clear</button>
          <button data-add ${selectedCount() && !scanInProgress && !addInProgress ? "" : "disabled"}>Add selected (${selectedCount()})</button>
          <button class="danger" data-stop ${scanInProgress || addInProgress ? "" : "disabled"}>Stop</button>
        </div>
        <input data-search placeholder="Search scanned offers" value="${escapeHtml(searchTerm)}">
        <div class="summary">${snapshot.cards.length} cards | ${snapshot.offers.length} offers | ${date}</div>
        <section>${offers.slice(0, 400).map((offer) => {
          const addable = Object.values(offer.cards).filter((status) => status === "addable").length;
          return `<div class="offer"><div class="offer-name">${escapeHtml(offer.name)}</div><div class="status">${addable} addable</div><div class="cards">${snapshot.cards.filter((card) => offer.cards[card.id]).map((card) => {
            const status = offer.cards[card.id];
            const selected = (snapshot.selected[offer.key] || []).includes(card.id);
            const classes = `card ${status === "added" ? "added" : selected ? "selected" : ""}`;
            return `<button class="${classes}" data-toggle="${escapeHtml(encodeURIComponent(offer.key))}" data-card="${card.id}" ${status === "added" ? "disabled" : ""}>${escapeHtml(card.name)}</button>`;
          }).join("")}</div></div>`;
        }).join("") || "<div class=\"summary\">Run Scan all cards to build your offer list.</div>"}</section>
        <div class="logs">${escapeHtml((snapshot.logs || []).join("\n"))}</div>
      </main>`;

    panel.querySelector("[data-scan]")?.addEventListener("click", scanAllCards);
    panel.querySelector("[data-select]")?.addEventListener("click", selectVisibleAddable);
    panel.querySelector("[data-clear]")?.addEventListener("click", clearSelection);
    panel.querySelector("[data-add]")?.addEventListener("click", addSelectedOffers);
    panel.querySelector("[data-stop]")?.addEventListener("click", () => { cancelRequested = true; log("Stop requested. The current page action will finish safely."); });
    panel.querySelector("[data-search]")?.addEventListener("input", (event) => { searchTerm = event.target.value; render(); });
    panel.querySelectorAll("[data-toggle]").forEach((button) => button.addEventListener("click", () => {
      toggleSelection(decodeURIComponent(button.dataset.toggle), button.dataset.card);
    }));
  }

  if (globalThis.__CHASE_ASSISTANT_TEST__) {
    globalThis.__CHASE_ASSISTANT_TEST__.api = { normalizeOfferName, displayOfferName, mergeCardOffers, readCards, readOffersForCard, selectedTasks };
    return;
  }

  if (!document.getElementById(ID)) {
    panel = makePanel();
    render();
  }
})();
