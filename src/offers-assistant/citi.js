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
