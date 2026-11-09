function createUSBankAdapter(env) {
  const { all, text, normalize, visible, enabled, click, sleep, waitFor, check, imageUrl, collect } = env;
  const MODAL = "#vicinity-overlay-click-modal, .cashback-offer-detail, .usb-modal-v2--dialog, .usb-modal-v2";
  const scope = { id: "cashback-deals", name: "Cash-back deals", kind: "scope" };
  const redeemedScope = { id: "cashback-redeemed", name: "U.S. Bank redeemed deals", kind: "scope" };
  function assertPage() {
    if (!/\/cashback-deals/i.test(location.href)) throw new Error("Open U.S. Bank cash-back deals first.");
    if (all('input[type="password"]').some(visible)) throw new Error("Sign in to U.S. Bank and open cash-back deals.");
  }
  function cardFromText(value) {
    const source = String(value || "").replace(/\s+/g, " ").trim();
    if (!source || source.length > 260 || !/(?:card|account|visa|mastercard|amex|altitude|cash\+|shopper|connect|platinum|signature)/i.test(source)) return null;
    const match = source.match(/(?:ending(?:\s+in)?|ends?\s+in|last\s*(?:four|4)|[•*x]{2,}|\.{3})\s*[-:]?\s*(\d{4,5})\b/i);
    if (!match) return null;
    const tail = match[1];
    let name = source.slice(0, match.index)
      .replace(/^(?:select|selected|current|choose|account)\s+/i, "")
      .replace(/\s*(?:ending(?:\s+in)?|ends?\s+in|last\s*(?:four|4))\s*$/i, "")
      .replace(/\s+/g, " ").trim();
    if (name.length > 110) name = name.slice(-110).replace(/^.*?\b(?=(?:U\.?S\.? Bank|Visa|Mastercard|Amex|Card)\b)/i, "").trim();
    if (!name || name.length > 110) name = "U.S. Bank Card";
    return { id: `cashback-deals:${tail}`, name: `${name} (...${tail})`, legacyIds: [scope.id], kind: "card" };
  }
  function cardFromAccountText(value) {
    const source = String(value || "").replace(/\s+/g, " ").trim();
    const match = source.match(/^(.*?)\s*(?:[•*x]{2,}|\.{3})\s*(\d{4,5})\b/i);
    if (!match) return null;
    const name = match[1].trim();
    if (!name || /\b(?:checking|savings|money market|certificate|brokerage|investment|mortgage|loan|line of credit|home equity|retirement|ira)\b/i.test(name)) return null;
    const tail = match[2];
    const display = /^U\.?S\.? Bank\b/i.test(name) ? name : `U.S. Bank ${name}`;
    return { id: `cashback-deals:${tail}`, name: `${display} (...${tail})`, legacyIds: [scope.id], kind: "card" };
  }
  function cardFromNode(node) {
    if (!node) return null;
    return cardFromText([node.getAttribute?.("aria-label"), node.getAttribute?.("title"), text(node)].filter(Boolean).join(" "));
  }
  function pageCard() {
    const selectors = [
      '[aria-label*="ending" i]', '[aria-label*="last four" i]', '[data-testid*="account" i]', '[data-testid*="card" i]',
      '[id*="account-selector" i]', '[id*="card-selector" i]', '[role="combobox"]', 'select option'
    ].join(",");
    return all(selectors).map(cardFromNode).find(Boolean) || null;
  }
  function detailCard(detail) {
    if (!detail) return null;
    const nodes = [detail, ...Array.from(detail.querySelectorAll('[aria-label], [title], p, span, div, button'))];
    return nodes.map(cardFromNode).find(Boolean) || null;
  }
  function currentCard() { assertPage(); return pageCard() || { ...scope }; }
  async function accountCards() {
    assertPage();
    const accounts = all("button").find(node => visible(node) && enabled(node) && /^Accounts$/i.test(text(node)));
    let opened = false;
    if (accounts && accounts.getAttribute("aria-expanded") !== "true") {
      click(accounts);
      opened = true;
      await waitFor(() => accounts.getAttribute("aria-expanded") === "true", 5000);
    }
    const cards = new Map();
    for (const node of all("a, button, [role=link]")) {
      if (!visible(node)) continue;
      const card = cardFromAccountText(text(node));
      if (card) cards.set(card.id, card);
    }
    if (opened && accounts?.isConnected && accounts.getAttribute("aria-expanded") === "true") click(accounts);
    return [...cards.values()];
  }
  async function discoverCards() { return [{ ...scope }]; }
  async function openCard(card) {
    assertPage();
    if (card.id !== scope.id && !card.id.startsWith(`${scope.id}:`)) throw new Error("This deal collection is no longer available.");
  }
  function detailFromControl(control) {
    if (!control || !visible(control)) return null;
    const ownerDocument = control.ownerDocument;
    let node = control.parentElement;
    while (node && node !== ownerDocument.body && node !== ownerDocument.documentElement) {
      // OfferHub can nest the action in a small usb-modal-v2 element while the
      // heading and Close action live in a larger wrapper. Require both.
      if (visible(node) && node.querySelector("h1, h2, h3") && node.querySelector("#close-action, #vicinity-overlay-click-modal--close")) return node;
      node = node.parentElement;
    }
    return null;
  }
  function modal() {
    const anchored = all("#activate-offer, #activated-offer").filter(visible).map(detailFromControl).find(Boolean);
    if (anchored) return anchored;
    return all(MODAL).filter(visible).find(node => node.querySelector("#activate-offer, #activated-offer")) || null;
  }
  function activated(detail) {
    if (!detail || !visible(detail)) return false;
    const explicit = detail.querySelector("#activated-offer");
    if (explicit && visible(explicit) && /activated/i.test(text(explicit) || explicit.getAttribute("aria-label") || "")) return true;
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
      || node.id === "close-action"
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
    const rawName = (node.getAttribute("aria-label") || "").replace(/^Offer from\s+/i, "").trim();
    const name = rawName.replace(/\s+(?:\$\s*\d[\d,.]*|\d+(?:\.\d+)?\s*%)(?:\s+(?:cash back|back|off))?\s*$/i, "").trim();
    if (!name) return null;
    const body = text(node).replace(/^New\s+/i, "");
    const reward = (body.match(/(?:\$\s*\d[\d,.]*|\d+(?:\.\d+)?\s*%)(?:\s+(?:cash back|back|off))?/gi) || []).join(" / ");
    const expiry = body.match(/(?:expires?|valid (?:until|through))\s*:?\s*([\w/,-]+(?:\s+\d{1,4})?)/i)?.[0] || "";
    const nativeId = node.getAttribute("data-offer-id") || "";
    // Keep the raw label in the key so existing v0.1.x snapshots update in place.
    const key = JSON.stringify([normalize(rawName), normalize(reward), normalize(expiry), nativeId]);
    return { key, name, description: [reward, expiry].filter(Boolean).join(" / "), imageUrl: imageUrl(node), status: "unknown", node };
  }
  const readOffers = () => buttons().map(readButton).filter(Boolean);
  function redeemedTab() {
    return all('[role="tab"]').find(node => visible(node) && /^Redeemed$/i.test(text(node))) || null;
  }
  function redeemedPageReady() {
    const tab = redeemedTab();
    return tab?.getAttribute('aria-selected') === 'true'
      && all('h3').some(node => visible(node) && /^Redeemed deals(?:\s*\(\d+\))?$/i.test(text(node)));
  }
  function redeemedListSettled() {
    if (!redeemedPageReady()) return false;
    if (readOffers().length) return true;
    return all('p, h3, h4, [role="status"], [data-testid]').some(node => visible(node)
      && (/(?:no|haven.t|have not|0)\s+(?:redeemed\s+)?(?:deals?|offers?)\s*(?:redeemed)?|(?:deals?|offers?)\s+(?:redeemed\s+)?(?:yet|in the (?:past|last)|available)/i.test(text(node))
        || /^Your pending and completed deals are shown for up to 6 months\./i.test(text(node))))
      && !all('[aria-busy="true"], [role="progressbar"]').some(visible);
  }
  function readRedeemedOffers() {
    if (!redeemedPageReady()) return [];
    return readOffers().map(offer => ({ ...offer, status: 'redeemed',
      card: detailCard(offer.node) || { ...redeemedScope } }));
  }
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
    const eligibleCards = await accountCards();
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
          offer.card = detailCard(detail) || pageCard() || { ...scope };
          inspected.set(offer.key, offer);
          await closeDetail(detail);
        } catch (error) {
          if (modal()) await closeDetail(modal());
          check();
          inspected.set(offer.key, offer);
          env.log(`Unverified: ${offer.name} - ${error.message}`);
        }
      }
      return [...inspected.values()];
    }, assertPage);
    if (!result.offers.length) throw new Error("No recognizable cash-back deals. Existing scan retained.");
    let redeemed = [];
    const redeemedControl = redeemedTab();
    if (redeemedControl) {
      const previousRows = buttons();
      click(redeemedControl);
      await waitFor(() => redeemedPageReady() && previousRows.every(node => !node.isConnected), 12000);
      await sleep(2000);
      await waitFor(redeemedListSettled, 12000);
      redeemed = (await collect(readRedeemedOffers, assertPage)).offers;
      const allControl = all('button, [role="tab"]').find(node => visible(node) && /^All deals$/i.test(text(node)));
      if (allControl) { click(allControl); await waitFor(() => allControl.getAttribute('aria-selected') === 'true', 8000); }
    }
    if (!eligibleCards.length) {
      env.log("U.S. Bank did not expose a recognizable card ending; keeping the account-level collection.");
      return { ...result, offers: [...result.offers, ...redeemed] };
    }
    return {
      ...result,
      offers: [...result.offers.flatMap(offer => eligibleCards.map(card => ({ ...offer, card }))), ...redeemed]
    };
  }
  async function addOffer(card, offer) {
    await openCard(card);
    if (!readOffers().some(item => item.key === offer.key)) {
      await collect(readOffers, assertPage);
      // The collector may end below a non-virtualized tile; find it afresh before clicking.
    }
    const detail = await openDetail(offer);
    try {
      const shownCard = detailCard(detail);
      if (shownCard && card.id !== scope.id && shownCard.id !== card.id) throw new Error("The opened offer belongs to a different U.S. Bank card.");
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
  return { assertPage, cardFromText, cardFromAccountText, accountCards, pageCard, detailCard, currentCard, discoverCards, openCard, scanCard, addOffer, readOffers, readButton, redeemedPageReady, redeemedListSettled, readRedeemedOffers, modal, activated, activateButton, closeDetail };
}
