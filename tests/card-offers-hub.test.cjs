const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '../CardOffersHub.user.js'), 'utf8');

function setup(url = 'https://secure.chase.com/web/auth/dashboard#/dashboard/overview') {
  const dom = new JSDOM('', { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const values = new Map();
  w.GM_getValue = (key, fallback) => values.has(key) ? values.get(key) : fallback;
  w.GM_setValue = (key, value) => values.set(key, structuredClone(value));
  w.GM_registerMenuCommand = () => {};
  w.GM_addValueChangeListener = () => {};
  w.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 20, top: 30, width: 100, height: 60 }; };
  w.__CARD_OFFERS_HUB_TEST__ = {};
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
  const html = '<div data-testid="simple_switcher_wrapper"><div role="combobox" aria-label="Open to manage your other accounts"><div data-testid="simple_switcher_selected_option_display" aria-label="Business Platinum Card® ending in 91001."><span>Wrong stale card ••••11005</span></div></div></div><div data-testid="addedToCardViewAllContainer"><div class="offer-row"><img alt="Valentino - Luxury Fashion & Accessories"><div><h3>Valentino - Luxury Fashion & Accessories</h3><span>Spend $1,100 or more, earn $220 back</span><span>Expires 9/15/26</span><button>Terms apply</button><button data-testid="merchantOfferDetailsLink">View Details</button></div></div></div>';
  const { dom, w, api } = setup('https://global.americanexpress.com/offers/enrolled?opaqueAccountId=opaque-secret-1234');
  w.document.body.innerHTML = html;
  assert.equal(api.collectAmexPage(), true);
  assert.equal(api.syncCurrentBank(true), true);
  const item = api.placements().find(placement => placement.bank === 'amex');
  assert.equal(item.name, 'Valentino - Luxury Fashion & Accessories');
  assert.equal(item.status, 'added');
  assert.match(item.card, /Business Platinum Card/);
  assert.match(item.card, /91001/);
  assert.doesNotMatch(item.card, /11005/);
  assert.doesNotMatch(JSON.stringify(api.getData()), /opaque-secret-1234/);
  dom.window.close();
});

test('installable Hub is updateable, local-only and never starts bank actions', () => {
  assert.match(source, /@version\s+0\.1\.9/);
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
