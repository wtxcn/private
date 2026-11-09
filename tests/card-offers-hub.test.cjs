const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '../CardOffersHub.user.js'), 'utf8');

function setup(url = 'https://secure.chase.com/web/auth/dashboard#/dashboard/overview', amexTiming = { poll: 5, settle: 0, timeout: 200 }) {
  const dom = new JSDOM('', { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const values = new Map();
  w.GM_getValue = (key, fallback) => values.has(key) ? values.get(key) : fallback;
  w.GM_setValue = (key, value) => values.set(key, structuredClone(value));
  w.GM_registerMenuCommand = () => {};
  w.GM_addValueChangeListener = () => {};
  w.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 20, top: 30, width: 100, height: 60 }; };
  w.__CARD_OFFERS_HUB_TEST__ = { amexTiming };
  w.eval(source);
  return { dom, w, values, api: w.__CARD_OFFERS_HUB_TEST__.api };
}

function chaseSource(name, cardId, publishedAt) {
  return { bank: 'chase', publishedAt, snapshot: {
    cards: [{ id: cardId, name: `${name} (...${cardId.slice(-4)})` }],
    offers: [{ key: 'cvs 10 cash back', name: 'CVS $10 cash back', imageUrl: 'https://private/image', cards: { [cardId]: 'addable' } }],
    selected: { secret: [cardId] }, logs: ['private log'], scannedAt: publishedAt
  } };
}

test('complete per-card scans replace vanished offers without deleting another login or refreshing its age', () => {
  const { dom, api } = setup();
  const old = { bank: 'chase', scannedAt: 100, cards: [{ id: 'a', name: 'P1 card' }, { id: 'b', name: 'P2 card' }],
    offers: [{ key: 'google', name: 'Google Play', cards: { a: 'added', b: 'added' } }] };
  const fresh = { bank: 'chase', scannedAt: 200, cards: [{ id: 'a', name: 'P1 card', scannedAt: 200, complete: true }], offers: [] };
  const merged = api.mergeSnapshots(old, fresh);
  assert.deepEqual(Object.keys(merged.offers[0].cards), ['b']);
  assert.equal(merged.cards.find(c => c.id === 'b').scannedAt, 100);
  assert.equal(merged.cards.find(c => c.id === 'a').scannedAt, 200);
  const replay = api.mergeSnapshots(merged, old);
  assert.deepEqual(Object.keys(replay.offers[0].cards), ['b']);
  const cleared = api.mergeSnapshots(merged, { ...fresh, cards: [{ id: 'b', name: 'P2 card', scannedAt: 200, complete: true }] });
  assert.equal(cleared.offers.length, 0);
  for (const complete of [false, undefined]) {
    const partial = api.mergeSnapshots(old, { ...fresh, cards: [{ id: 'a', name: 'P1 card', complete }] });
    assert.deepEqual(Object.keys(partial.offers[0].cards), ['a', 'b']);
  }
  dom.window.close();
});

test('Hub starts minimized and restores repeatedly without capturing launcher clicks', () => {
  const { dom, w, api } = setup();
  const panel = api.mount();
  const root = panel.shadowRoot;
  let captures = 0;
  panel.setPointerCapture = () => { captures++; };
  assert.equal(panel.classList.contains('minimized'), true);
  for (let i = 0; i < 3; i++) {
    const launcher = root.querySelector('[data-restore]');
    launcher.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, composed: true, button: 0 }));
    launcher.dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true, composed: true, button: 0 }));
    launcher.click();
    assert.equal(captures, 0);
    assert.equal(panel.classList.contains('minimized'), false);
    root.querySelector('[data-minimize]').click();
    api.render();
    assert.equal(panel.classList.contains('minimized'), true);
  }
  assert.equal(root.querySelector('.footer > span:last-child').textContent, 'v0.1.19');
  dom.window.close();
});

test('Hub merges repeated bank scans by card and hashes source card IDs', () => {
  const { dom, w, api } = setup();
  w.localStorage.setItem('cardOffersHubSource.chase.v1', JSON.stringify(chaseSource('Freedom', '123456789', 1000)));
  assert.equal(api.syncCurrentBank(), true);
  w.localStorage.setItem('cardOffersHubSource.chase.v1', JSON.stringify(chaseSource('Sapphire', '987654321', 2000)));
  assert.equal(api.syncCurrentBank(true), true);
  const items = Array.from(api.placements());
  assert.deepEqual(items.map(item => item.card).sort(), ['Freedom (...6789)', 'Sapphire (...4321)']);
  assert.equal(items.every(item => item.name.includes('CVS')), true);
  const serialized = JSON.stringify(api.getData());
  assert.doesNotMatch(serialized, /123456789|987654321|private log|private\/image|selected/);
  assert.doesNotMatch(serialized, /P1|P2|profile/);
  assert.match(serialized, /\.\.\.6789/);
  assert.match(serialized, /\.\.\.4321/);
  dom.window.close();
});

test('Hub renders combined CVS results with bank, card and status filters', () => {
  const { dom, w, api } = setup();
  w.localStorage.setItem('cardOffersHubSource.chase.v1', JSON.stringify(chaseSource('Freedom', '123456789', Date.now())));
  api.syncCurrentBank();
  w.localStorage.setItem('cardOffersHubSource.chase.v1', JSON.stringify(chaseSource('Sapphire', '987654321', Date.now() + 1)));
  api.syncCurrentBank(true);
  const panel = api.mount();
  const root = panel.shadowRoot;
  const input = root.querySelector('[data-search]');
  input.focus();
  for (const character of 'CVS') {
    input.value += character;
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.equal(root.querySelector('[data-search]'), input);
  }
  assert.equal(root.querySelectorAll('.placement').length, 2);
  assert.equal(root.querySelectorAll('.offer').length, 1);
  assert.match(root.querySelector('[data-results]').textContent, /Freedom/);
  assert.match(root.querySelector('[data-results]').textContent, /Sapphire/);
  assert.equal(root.querySelector('[data-profile-filters]'), null);
  assert.equal(root.querySelector('[data-set-profile]'), null);
  dom.window.close();
});

test('Hub search ignores card names and card-ending digits', () => {
  const { dom, values, w, api } = setup();
  values.set('cardOffersHub.data.v1', { version: 2, snapshots: {
    amex: {
      bank: 'amex',
      cards: [{ id: 'amex:marriott', name: 'Marriott Bonvoy Brilliant Card (...11008)' }],
      offers: [
        { key: 'empire', name: 'Empire Today', description: 'Spend $750, get $150 back', cards: { 'amex:marriott': 'addable' } },
        { key: 'city-marriott', name: 'City Express by Marriott', description: 'Spend $500, get $100 back', cards: { 'amex:marriott': 'addable' } }
      ],
      scannedAt: Date.now()
    }
  } });
  const panel = api.mount();
  const root = panel.shadowRoot;
  const input = root.querySelector('[data-search]');
  input.value = 'marriott';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.match(root.querySelector('[data-results]').textContent, /City Express by Marriott/);
  assert.doesNotMatch(root.querySelector('[data-results]').textContent, /Empire Today/);
  input.value = '11008';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.match(root.querySelector('[data-results]').textContent, /No offers match/);
  dom.window.close();
});

test('Hub renders a full-page dashboard with local bank and card data', () => {
  const { dom, w, api } = setup();
  w.localStorage.setItem('cardOffersHubSource.chase.v1', JSON.stringify(chaseSource('Freedom', '123456789', Date.now())));
  api.syncCurrentBank();
  const dashboard = api.mountDashboard();
  const root = dashboard.shadowRoot;
  assert.match(root.querySelector('h1').textContent, /Card Offers Dashboard/);
  assert.match(root.querySelector('[data-dashboard-results]').textContent, /CVS/);
  assert.match(root.querySelector('[data-dashboard-results]').textContent, /Chase/);
  assert.match(root.querySelector('[data-dashboard-results]').textContent, /Freedom/);
  const input = root.querySelector('[data-dashboard-search]');
  input.value = 'missing merchant';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.match(root.querySelector('[data-dashboard-results]').textContent, /No offers match/);
  assert.equal(root.querySelector('[data-profile-filters]'), null);
  dom.window.close();
});

test('Hub opens the dashboard in a generated local tab', () => {
  const { dom, w, api } = setup();
  const popupDom = new JSDOM('', { url: 'about:blank', pretendToBeVisual: true });
  popupDom.window.focus = () => {};
  w.open = () => popupDom.window;
  w.localStorage.setItem('cardOffersHubSource.chase.v1', JSON.stringify(chaseSource('Freedom', '123456789', Date.now())));
  api.syncCurrentBank();
  assert.equal(api.openDashboard(), true);
  const dashboard = popupDom.window.document.querySelector('#card-offers-dashboard');
  assert.ok(dashboard);
  assert.equal(popupDom.window.document.title, 'Card Offers Dashboard');
  assert.match(dashboard.shadowRoot.querySelector('[data-dashboard-results]').textContent, /CVS/);
  assert.match(dashboard.shadowRoot.querySelector('[data-dashboard-results]').textContent, /Chase/);
  assert.match(dashboard.shadowRoot.querySelector('[data-dashboard-results]').textContent, /Freedom/);
  assert.equal(popupDom.window.name, '');
  assert.equal(popupDom.window.opener, null);
  popupDom.window.close();
  dom.window.close();
});

test('Hub pairs with and syncs sanitized data to the local Offer Server', async () => {
  const { dom, w, values, api } = setup();
  const requests = [];
  w.GM_xmlhttpRequest = options => {
    requests.push(options);
    if (options.url.endsWith('/api/pair')) {
      options.onload({ status: 200, responseText: JSON.stringify({ writeToken: 'write-key', readToken: 'read-key', dashboardUrl: 'http://127.0.0.1:8787/?token=read-key' }) });
    } else {
      options.onload({ status: 200, responseText: JSON.stringify({ ok: true }) });
    }
  };
  w.localStorage.setItem('cardOffersHubSource.chase.v1', JSON.stringify(chaseSource('Freedom', '123456789', Date.now())));
  api.syncCurrentBank();
  assert.equal(await api.syncLocalServer(), true);
  assert.equal(requests.length >= 2, true);
  const upload = requests.find(request => request.url.endsWith('/api/sync'));
  assert.equal(upload.headers.Authorization, 'Bearer write-key');
  assert.match(upload.data, /CVS/);
  assert.doesNotMatch(upload.data, /123456789|private log|private\/image|selected/);
  assert.equal(values.get('cardOffersHub.localServer.v1').readToken, 'read-key');
  dom.window.close();
});

test('Hub replaces the legacy U.S. Bank deal placeholder after a real card ending is scanned', () => {
  const { dom, w, values, api } = setup('https://onlinebanking.usbank.com/digital/servicing/dominjection/cashback-deals');
  values.set('cardOffersHub.data.v1', { version: 2, snapshots: {
    usbank: { bank: 'usbank', cards: [{ id: 'usbank:legacy', name: 'Cash-back deals' }], offers: [
      { key: 'cvs', name: 'CVS', description: '5% back', cards: { 'usbank:legacy': 'added' } }
    ], scannedAt: 100 }
  } });
  w.localStorage.setItem('cardOffersHubSource.usbank.v1', JSON.stringify({ bank: 'usbank', publishedAt: 200, snapshot: {
    cards: [{ id: 'cashback-deals:4321', name: 'U.S. Bank Cash+ Card (...4321)' }],
    offers: [{ key: 'cvs', name: 'CVS', description: '5% back', cards: { 'cashback-deals:4321': 'added' } }],
    scannedAt: 200
  } }));
  assert.equal(api.syncCurrentBank(true), true);
  const cards = api.getData().snapshots.usbank.cards;
  assert.deepEqual(Array.from(cards, card => card.name), ['U.S. Bank Cash+ Card (...4321)']);
  assert.doesNotMatch(JSON.stringify(api.getData()), /Cash-back deals/);
  dom.window.close();
});

test('Hub migrates legacy P1 and P2 snapshots into one bank dataset', () => {
  const { dom, values, api } = setup();
  values.set('cardOffersHub.data.v1', { version: 1, snapshots: {
    'P1:chase': { profile: 'P1', bank: 'chase', cards: [{ id: 'card-a', name: 'Freedom (...1111)' }], offers: [{ key: 'cvs', name: 'CVS', description: '$10 back', cards: { 'card-a': 'added' } }], scannedAt: 1000 },
    'P2:chase': { profile: 'P2', bank: 'chase', cards: [{ id: 'card-b', name: 'Sapphire (...2222)' }], offers: [{ key: 'cvs', name: 'CVS', description: '$10 back', cards: { 'card-b': 'addable' } }], scannedAt: 2000 },
    'P1:citi': { profile: 'P1', bank: 'citi', cards: [{ id: 'card-c', name: 'Citi (...3333)' }], offers: [{ key: 'lyft', name: 'Lyft', description: '10% back', cards: { 'card-c': 'added' } }], scannedAt: 1500 }
  } });
  const data = api.getData();
  assert.deepEqual(Object.keys(data.snapshots), ['chase', 'citi']);
  assert.equal(data.snapshots.chase.cards.length, 2);
  assert.equal(Object.keys(data.snapshots.chase.offers[0].cards).length, 2);
  assert.equal(api.placements().length, 3);
  assert.doesNotMatch(JSON.stringify(data), /P1|P2|profile/);
  dom.window.close();
});

test('Hub captures visible Amex addable offers without storing opaque account IDs', () => {
  const html = '<div data-testid="simple_switcher_wrapper">Gold Card ••••1008</div><div id="offer-cvs"><img alt="CVS"><button title="add to list card">CVS Spend $50, get $10 Expires 10/31/2026</button></div>';
  const { dom, w, api } = setup('https://global.americanexpress.com/offers?opaqueAccountId=opaque-secret-1234');
  w.document.body.innerHTML = html;
  assert.equal(api.collectAmexPage(), true);
  assert.equal(api.syncCurrentBank(true), true);
  const serialized = JSON.stringify(api.getData());
  assert.match(serialized, /CVS/);
  assert.doesNotMatch(serialized, /opaque-secret-1234/);
  dom.window.close();
});

test('Hub migrates Amex duplicates and retains the other account during subsequent scans', () => {
  const { dom, values, api } = setup('https://global.americanexpress.com/offers');
  const terms = 'Spend $250 or more, earn $25 back';
  const offer = (key, description, cards) => ({ key, name: 'Best Buy', description, cards });
  values.set('cardOffersHub.data.v1', { version: 2, snapshots: { amex: {
    bank: 'amex', scannedAt: 100, cards: [{ id: 'a', name: 'Card A' }, { id: 'b', name: 'Card B' }],
    offers: [offer('old1', terms, { a: 'addable', b: 'addable' }),
      offer('old2', `${terms} ${terms} Your offer has been added`, { a: 'addable' })]
  } } });
  const old = api.getData().snapshots.amex;
  assert.equal(old.offers.length, 1);
  assert.equal(old.offers[0].cards.a, 'added');
  const merged = api.mergeSnapshots(old, { bank: 'amex', scannedAt: 200,
    cards: [{ id: 'a', name: 'Card A' }],
    offers: [offer('new', `${terms} 12/31/2026 Add to Card`, { a: 'addable' }),
      offer('cash', 'Get $10 back', { a: 'addable' }),
      offer('percent', 'Get 10% back', { a: 'addable' })] });
  assert.equal(merged.offers.length, 3);
  const combined = merged.offers.find(item => item.description.startsWith('Spend'));
  assert.deepEqual({ ...combined.cards }, { a: 'added', b: 'addable' });
  assert.equal(combined.description, `${terms} Expires 12/31/2026`);
  assert.equal(merged.cards.find(card => card.id === 'b').scannedAt, 100);
  dom.window.close();
});

test('Amex UI transitions do not create duplicates or regress an added status', () => {
  const { dom, w, api } = setup('https://global.americanexpress.com/offers');
  const terms = 'Spend $250 or more, earn $25 back';
  const render = content => {
    w.document.body.innerHTML = `<div data-testid="simple_switcher_wrapper">Test Card (...10001)</div>
      <div id="offer-best-buy"><h3>Best Buy</h3> ${content}</div>`;
    api.syncCurrentBank(true);
  };
  render(`<span>${terms}</span> <span>12/31/2026</span> <button title="add to list card">Add to Card</button>`);
  assert.equal(api.placements().length, 1);
  assert.equal(api.placements()[0].status, 'addable');
  render(`<span>${terms}</span> <span>12/31/2026</span> <button>View Details</button> Details Earn a one-time $25 statement credit.`);
  assert.equal(api.placements().length, 1);
  render(`<span>${terms}</span> Your offer has been added. Remember to use your enrolled Card. <button>Redeem Now</button>`);
  assert.equal(api.placements().length, 1);
  assert.equal(api.placements()[0].status, 'added');
  render(`<span>${terms}</span> <span>12/31/2026</span> <button title="add to list card">Add to Card</button>`);
  assert.equal(api.placements().length, 1);
  assert.equal(api.placements()[0].status, 'added');
  assert.equal(api.placements()[0].description, `${terms} Expires 12/31/2026`);
  dom.window.close();
});

test('Hub captures added Amex offers directly from the dashboard', () => {
  const html = '<div role="combobox" aria-label="Open to manage your other accounts">Marriott Card ••••11005</div><input id="ENROLLED" type="radio" checked><div id="offer-valentino"><button id="header-panel-valentino"><img alt="Valentino - Luxury Fashion & Accessories">Spend $1,100 or more, earn $220 back Valentino - Luxury Fashion & Accessories Expires today</button><span>Added to Card ••••11005</span></div>';
  const { dom, w, api } = setup('https://global.americanexpress.com/dashboard');
  w.document.body.innerHTML = html;
  assert.equal(api.collectAmexPage(), true);
  assert.equal(api.syncCurrentBank(true), true);
  const item = api.placements().find(placement => placement.bank === 'amex');
  assert.equal(item.name, 'Valentino - Luxury Fashion & Accessories');
  assert.equal(item.status, 'added');
  assert.match(item.card, /11005/);
  dom.window.close();
});

test('Hub captures the Amex Added to Card page and uses its authoritative selected-card label', () => {
  const html = '<div data-testid="simple_switcher_wrapper"><div role="combobox" aria-label="Open to manage your other accounts"><div data-testid="simple_switcher_selected_option_display" aria-label="Business Platinum Card® ending in 8765."><span>Wrong stale card ••••11005</span></div></div></div><div data-testid="addedToCardViewAllContainer"><div class="offer-row"><img alt="Valentino - Luxury Fashion & Accessories"><div><h3>Valentino - Luxury Fashion & Accessories</h3><span>Spend $1,100 or more, earn $220 back</span><span>Expires 9/15/26</span><button>Terms apply</button><button data-testid="merchantOfferDetailsLink">View Details</button></div></div></div>';
  const { dom, w, api } = setup('https://global.americanexpress.com/offers/enrolled?opaqueAccountId=opaque-secret-1234');
  w.document.body.innerHTML = html;
  assert.equal(api.collectAmexPage(), true);
  assert.equal(api.syncCurrentBank(true), true);
  const item = api.placements().find(placement => placement.bank === 'amex');
  assert.equal(item.name, 'Valentino - Luxury Fashion & Accessories');
  assert.equal(item.status, 'added');
  assert.match(item.card, /Business Platinum Card/);
  assert.match(item.card, /8765/);
  assert.doesNotMatch(item.card, /11005/);
  assert.doesNotMatch(JSON.stringify(api.getData()), /opaque-secret-1234/);
  dom.window.close();
});

test('Amex redemption badges update one campaign and survive later Added scans', () => {
  const { dom, w, api } = setup('https://global.americanexpress.com/offers/enrolled');
  const render = badge => {
    w.document.body.innerHTML = `<div data-testid="simple_switcher_wrapper">Test Card (...1234)</div>
      <div id="offer-nordstrom"><h3>Nordstrom</h3><span>Spend $100, get $20 back</span>
      <span>Expires 12/31/2026</span> ${badge} <button>View Details</button></div>`;
    api.syncCurrentBank(true);
  };
  render('<span>Added to Card</span>');
  assert.equal(api.placements()[0].status, 'added');
  render('<span>Redeemed on 11/08/2026</span>');
  assert.equal(api.placements().length, 1);
  assert.equal(api.placements()[0].status, 'redeemed');
  assert.equal(api.placements()[0].description, 'Spend $100, get $20 back Expires 12/31/2026');
  render('<span>Added to Card</span> <button>Redeem Now</button>');
  assert.equal(api.placements().length, 1);
  assert.equal(api.placements()[0].status, 'redeemed');
  dom.window.close();
});

test('Amex Redeemed view is explicit and redeem instructions do not mean redeemed', () => {
  const fixture = '<div data-testid="simple_switcher_wrapper">Test Card (...5678)</div><div id="offer-nordstrom"><h3>Nordstrom</h3><span>Spend $100, get $20 back</span><span>Expires 12/31/2026</span><button>View Details</button></div>';
  for (const [url, control] of [
    ['https://global.americanexpress.com/offers/redeemed', '<input type="radio" id="REDEEMED" checked>'],
    ['https://global.americanexpress.com/dashboard', '<input type="radio" id="REDEEMED" checked>'],
    ['https://global.americanexpress.com/dashboard', '<div id="REDEEMED" role="radio" aria-checked="true"></div>']
  ]) {
    const { dom, w, api } = setup(url);
    w.document.body.innerHTML = fixture + control;
    api.syncCurrentBank(true);
    assert.equal(api.placements()[0].status, 'redeemed');
    dom.window.close();
  }
  const { dom, w, api } = setup('https://global.americanexpress.com/offers/enrolled');
  w.document.body.innerHTML = fixture.replace('<button>View Details</button>', '<span>This offer can be redeemed online.</span><button>Redeem Now</button>')
    + '<input type="radio" id="REDEEMED">';
  api.syncCurrentBank(true);
  assert.equal(api.placements()[0].status, 'added');
  dom.window.close();
});

test('Amex merge and sanitization retain redeemed per card, including complete scans', () => {
  const { dom, api } = setup();
  const normalized = api.sanitizeSnapshot('amex', { scannedAt: 100,
    cards: [{ id: 'a', name: 'Card A' }],
    offers: [{ key: 'nordstrom', name: 'Nordstrom', cards: { a: 'redeemed' } }] });
  assert.equal(Object.values(normalized.offers[0].cards)[0], 'redeemed');
  const old = { bank: 'amex', scannedAt: 100,
    cards: [{ id: 'a', name: 'Card A' }, { id: 'b', name: 'Card B' }],
    offers: [{ key: 'amex|nordstrom|spend $100, get $20 back|2026-12-31', name: 'Nordstrom',
      description: 'Spend $100, get $20 back Expires 12/31/2026', cards: { a: 'redeemed', b: 'added' } }] };
  for (const status of ['added', 'addable']) {
    for (const complete of [false, true]) {
      const merged = api.mergeSnapshots(old, { bank: 'amex', scannedAt: 200,
        cards: [{ id: 'a', name: 'Card A', scannedAt: 200, complete }],
        offers: [{ ...old.offers[0], cards: { a: status } }] });
      assert.deepEqual({ ...merged.offers[0].cards }, { a: 'redeemed', b: 'added' });
    }
  }
  dom.window.close();
});

test('Hub popup and full dashboard filter redeemed offers', () => {
  for (const mode of ['popup', 'dashboard']) {
    const { dom, values, api } = setup();
    values.set('cardOffersHub.data.v1', { version: 2, snapshots: { amex: {
      bank: 'amex', cards: [{ id: 'a', name: 'Card A' }, { id: 'b', name: 'Card B' }],
      offers: [{ key: 'nordstrom', name: 'Nordstrom', cards: { a: 'redeemed', b: 'added' } }], scannedAt: 100
    } } });
    const root = (mode === 'popup' ? api.mount() : api.mountDashboard()).shadowRoot;
    root.querySelector('[data-status-filter="redeemed"]').click();
    const results = root.querySelector(mode === 'popup' ? '[data-results]' : '[data-dashboard-results]');
    assert.match(results.textContent, /Card A/);
    assert.doesNotMatch(results.textContent, /Card B/);
    assert.match(results.textContent, /redeemed/);
    dom.window.close();
  }
});

function amexSyncFixture() {
  const context = setup('https://global.americanexpress.com/offers/enrolled', { poll: 5, settle: 20, timeout: 180 });
  const { w } = context;
  w.document.body.innerHTML = `<div role="combobox" aria-label="Open to manage your other accounts">
    <div data-testid="simple_switcher_selected_option_display" aria-label="Personal Gold Card ending in 1234."></div></div>
    <input type="radio" name="offers-view" id="ENROLLED" checked><label for="ENROLLED">Added to Card</label>
    <input type="radio" name="offers-view" id="REDEEMED"><label for="REDEEMED">Redeemed</label><main id="offer-list"></main>`;
  const grid = w.document.getElementById('offer-list');
  const render = redeemed => {
    grid.innerHTML = `<div id="offer-nordstrom"><h3>Nordstrom</h3> <span>Spend $100, get $20 back</span>
      <span>Expires 12/31/2026</span> ${redeemed ? '' : '<span>Added to Card</span>'} <button>View Details</button></div>`
      + (redeemed ? '' : '<div id="offer-bestbuy"><h3>Best Buy</h3> <span>Spend $100, get $10 back</span> <span>Expires 12/31/2026</span> <span>Added to Card</span> <button>View Details</button> <button title="add to list card">Add to Card</button> <button>Redeem Now</button></div>');
  };
  render(false);
  let activations = 0;
  grid.addEventListener('click', event => { if (event.target.closest('button')) activations++; });
  return { ...context, grid, renderGrid: render, activations: () => activations };
}

test('Amex Sync now visits only native Redeemed navigation and waits for settled current-card offers', async () => {
  const { dom, w, api, grid, renderGrid, activations } = amexSyncFixture();
  const root = api.mount().shadowRoot;
  let navigationClicks = 0;
  w.document.getElementById('REDEEMED').addEventListener('click', () => {
    navigationClicks++;
    assert.equal(root.querySelector('[data-amex-stop]').hidden, false);
    grid.setAttribute('aria-busy', 'true');
    assert.equal(api.syncCurrentBank(true), false);
    w.setTimeout(() => { renderGrid(true); grid.removeAttribute('aria-busy'); }, 25);
  });
  assert.equal(await api.syncAmexWithRedeemed(), true);
  assert.equal(navigationClicks, 1);
  assert.equal(activations(), 0);
  assert.equal(api.placements().find(item => item.name === 'Nordstrom').status, 'redeemed');
  assert.equal(api.placements().find(item => item.name === 'Best Buy').status, 'added');
  assert.equal(api.placements().every(item => item.card.endsWith('1234)')), true);
  assert.equal(root.querySelector('[data-amex-stop]').hidden, true);
  assert.match(root.querySelector('[data-notice]').textContent, /including redeemed/);
  dom.window.close();
});

test('Amex Stop cancels the pending Redeemed read without activating any offer', async () => {
  const { dom, w, api, activations } = amexSyncFixture();
  const root = api.mount().shadowRoot;
  w.document.getElementById('REDEEMED').addEventListener('click', () => api.stopAmexSync());
  assert.equal(await api.syncAmexWithRedeemed(), false);
  assert.equal(activations(), 0);
  assert.equal(api.placements().every(item => item.status === 'added'), true);
  assert.match(root.querySelector('[data-notice]').textContent, /stopped/i);
  dom.window.close();
});

test('Amex sync rejects unchanged grids and passive polling cannot relabel stale Added tiles', async () => {
  const { dom, api, activations } = amexSyncFixture();
  const root = api.mount().shadowRoot;
  assert.equal(await api.syncAmexWithRedeemed(), false);
  for (let i = 0; i < 3; i++) api.syncCurrentBank(true);
  assert.equal(api.placements().every(item => item.status === 'added'), true);
  assert.equal(activations(), 0);
  assert.match(root.querySelector('[data-notice]').textContent, /changed, settled/);
  dom.window.close();
});

test('Amex selected-card changes abort pending redemption reads', async () => {
  const { dom, w, api, renderGrid } = amexSyncFixture();
  const root = api.mount().shadowRoot;
  w.document.getElementById('REDEEMED').addEventListener('click', () => {
    w.document.querySelector('[data-testid="simple_switcher_selected_option_display"]').setAttribute('aria-label', 'Business Platinum Card ending in 8765.');
    renderGrid(true);
  });
  assert.equal(await api.syncAmexWithRedeemed(), false);
  assert.equal(api.placements().every(item => item.status === 'added' && /1234/.test(item.card)), true);
  assert.match(root.querySelector('[data-notice]').textContent, /selected Amex card changed/);
  dom.window.close();
});

test('Amex sync retains visible data when native Redeemed navigation is unavailable or enrollment is active', async () => {
  for (const active of [false, true]) {
    const { dom, w, api, activations } = amexSyncFixture();
    const root = api.mount().shadowRoot;
    w.document.getElementById('REDEEMED').remove();
    if (active) w.localStorage.setItem('amexNativeOfferClickerState.v1', JSON.stringify({ active: true }));
    assert.equal(await api.syncAmexWithRedeemed(), false);
    assert.equal(activations(), 0);
    assert.match(root.querySelector('[data-notice]').textContent, active ? /Stop the Amex enrollment clicker/ : /No native Redeemed control/);
    if (!active) assert.equal(api.placements().every(item => item.status === 'added'), true);
    dom.window.close();
  }
});

test('Amex first collection waits for nonloading settled data and rejects unidentified or mismatched cards', async () => {
  const { dom, w, api, grid } = amexSyncFixture();
  grid.setAttribute('aria-busy', 'true');
  assert.equal(api.collectAmexPage(), false);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(api.collectAmexPage(), false);
  grid.removeAttribute('aria-busy');
  assert.equal(api.collectAmexPage(), false);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(api.collectAmexPage(), true);
  dom.window.close();
  for (const [selected, tileTail] of [['Unknown card', '1234'], ['Personal Gold Card ending in 1234.', '8765']]) {
    const { dom, w, api } = setup('https://global.americanexpress.com/offers/enrolled');
    w.document.body.innerHTML = `<div role="combobox" aria-label="Open to manage your other accounts"><div data-testid="simple_switcher_selected_option_display" aria-label="${selected}"></div></div>
      <div id="offer-nordstrom"><h3>Nordstrom</h3> Spend $100, get $20 back Expires 12/31/2026 Added to Card ••••${tileTail} <button>View Details</button></div>`;
    assert.equal(api.collectAmexPage(), false);
    assert.equal(api.placements().length, 0);
    dom.window.close();
  }
});

test('Amex redeemed URL alone never identifies stale tiles as redeemed', () => {
  const { dom, w, api } = setup('https://global.americanexpress.com/offers/redeemed');
  w.document.body.innerHTML = '<div data-testid="simple_switcher_wrapper">Test Card (...1234)</div><div id="offer-nordstrom"><h3>Nordstrom</h3> Spend $100, get $20 back Expires 12/31/2026 <button>View Details</button></div>';
  assert.equal(api.collectAmexPage(), false);
  assert.equal(api.placements().length, 0);
  dom.window.close();
});

test('Amex activity rows on the redeemed page are captured only for the selected card', () => {
  const { dom, w, api } = setup('https://global.americanexpress.com/offers/redeemed?opaqueAccountId=test', { settle: 0 });
  w.document.body.innerHTML = `<div role="combobox" aria-label="Open to manage your other accounts">
    <div data-testid="simple_switcher_selected_option_display" aria-label="Platinum Card ending in 1234."></div></div>
    <button data-testid="redeemedOffer-first"><span>Oct 25, 2026</span><span><span>Nordstrom</span><span>Card ending in ••••-1234</span></span><span></span><span>$50.00</span></button>
    <button data-testid="redeemedOffer-other"><span>Oct 20, 2026</span><span><span>Kroger</span><span>Card ending in ••••-8765</span></span><span></span><span>$15.00</span></button>`;
  assert.equal(api.collectAmexPage(), true);
  api.syncCurrentBank(true);
  const redeemed = api.placements().filter(item => item.status === 'redeemed');
  assert.equal(redeemed.length, 1);
  assert.equal(redeemed[0].name, 'Nordstrom');
  assert.match(redeemed[0].description, /\$50\.00/);
  assert.match(redeemed[0].card, /1234/);
  dom.window.close();
});

test('Amex Sync now accepts the dedicated activity page with matching redemption rows', async () => {
  const { dom, w, api } = setup('https://global.americanexpress.com/offers/redeemed?opaqueAccountId=test', { poll: 5, settle: 0, timeout: 200 });
  w.document.body.innerHTML = `<div role="combobox" aria-label="Open to manage your other accounts">
    <div data-testid="simple_switcher_selected_option_display" aria-label="Test Card ending in 1234."></div></div>
    <button data-testid="redeemedOffer-first"><span>Oct 25, 2026</span>
      <span><span>Merchant</span><span>Card ending in ••••-1234</span></span><span></span><span>$5.00</span></button>`;
  assert.equal(await api.syncAmexWithRedeemed(), true);
  assert.equal(api.placements().filter(item => item.status === 'redeemed').length, 1);
  dom.window.close();
});

test('Amex Sync now recognizes the official empty activity message', async () => {
  const { dom, w, api } = setup('https://global.americanexpress.com/offers/redeemed?opaqueAccountId=test', { poll: 5, settle: 0, timeout: 200 });
  w.document.body.innerHTML = `<div role="combobox" aria-label="Open to manage your other accounts">
    <div data-testid="simple_switcher_selected_option_display" aria-label="Test Card ending in 1234."></div></div>
    <h2>You haven't redeemed any offers in the last 24 months. Add and redeem offers to earn rewards on qualifying purchases.</h2>`;
  assert.equal(await api.syncAmexWithRedeemed(), true);
  assert.equal(api.placements().length, 0);
  dom.window.close();
});

test('Amex Sync now follows View Activity and reads redemption rows', async () => {
  const { dom, w, api } = setup('https://global.americanexpress.com/offers', { poll: 5, settle: 0, timeout: 200 });
  w.document.body.innerHTML = `<div role="combobox" aria-label="Open to manage your other accounts">
    <div data-testid="simple_switcher_selected_option_display" aria-label="Platinum Card ending in 1234."></div></div>
    <a id="savings-view-more-header" href="/offers/redeemed?opaqueAccountId=test">View Activity</a>`;
  let clicked = 0;
  w.document.querySelector('#savings-view-more-header').addEventListener('click', event => {
    event.preventDefault();
    clicked++;
    w.history.pushState({}, '', '/offers/redeemed?opaqueAccountId=test');
    w.document.body.insertAdjacentHTML('beforeend', `<button data-testid="redeemedOffer-first"><span>Oct 25, 2026</span>
      <span><span>Nordstrom</span><span>Card ending in ••••-1234</span></span><span>$50.00</span></button>`);
  });
  assert.equal(await api.syncAmexWithRedeemed(), true);
  assert.equal(clicked, 1);
  assert.equal(api.placements().filter(item => item.status === 'redeemed').length, 1);
  dom.window.close();
});

test('Amex ignores hidden redeemed badges and unrelated selected navigation', () => {
  const { dom, w, api } = setup('https://global.americanexpress.com/dashboard');
  w.document.body.innerHTML = `<div data-testid="simple_switcher_wrapper">Test Card (...1234)</div>
    <input type="radio" id="REDEEMED" checked hidden>
    <div role="tab" aria-selected="true">Account overview</div><div role="tab" aria-selected="true">Added to Card (2)</div>
    <div id="offer-nordstrom"><h3>Nordstrom</h3> Spend $100, get $20 back Expires 12/31/2026
      <span><span hidden>Redeemed</span></span><button>View Details</button></div>`;
  api.syncCurrentBank(true);
  assert.equal(api.placements()[0].status, 'added');
  dom.window.close();
});

test('installable Hub is updateable, local-only and never starts bank actions', () => {
  assert.match(source, /@version\s+0\.1\.19/);
  assert.doesNotMatch(source, /@match\s+https:\/\/github\.com/);
  assert.doesNotMatch(source, /card-offers-dashboard=1/);
  assert.match(source, /window\.open\("", "card-offers-dashboard"\)/);
  assert.match(source, /popup\.opener = null/);
  assert.match(source, /Open Card Offers Dashboard/);
  assert.doesNotMatch(source, /data-set-profile|data-profile-filter|All people|This .* login saves as/);
  assert.match(source, /right:18px;bottom:18px/);
  assert.match(source, /panel\.style\.bottom = "auto"/);
  assert.doesNotMatch(source, /suppressLauncherClick/);
  assert.match(source, /@updateURL.*CardOffersHub\.user\.js/);
  assert.match(source, /@connect\s+127\.0\.0\.1/);
  assert.match(source, /GM_xmlhttpRequest/);
  assert.match(source, /http:\/\/127\.0\.0\.1:8787/);
  assert.match(source, /GM_getValue/);
  assert.match(source, /GM_setValue/);
  assert.doesNotMatch(source, /fetch\(|\bXMLHttpRequest\b|\.click\(\).*add offer/i);
});
