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

test('Hub keeps P1 and P2 bank snapshots together and hashes source card IDs', () => {
  const { dom, w, api } = setup();
  w.localStorage.setItem('cardOffersHubSource.chase.v1', JSON.stringify(chaseSource('Freedom', '123456789', 1000)));
  assert.equal(api.syncCurrentBank(), true);
  api.setProfile('chase', 'P2');
  w.localStorage.setItem('cardOffersHubSource.chase.v1', JSON.stringify(chaseSource('Sapphire', '987654321', 2000)));
  assert.equal(api.syncCurrentBank(), true);
  const items = Array.from(api.placements());
  assert.deepEqual(items.map(item => item.profile).sort(), ['P1', 'P2']);
  assert.equal(items.every(item => item.name.includes('CVS')), true);
  const serialized = JSON.stringify(api.getData());
  assert.doesNotMatch(serialized, /123456789|987654321|private log|private\/image|selected/);
  assert.match(serialized, /\.\.\.6789/);
  assert.match(serialized, /\.\.\.4321/);
  dom.window.close();
});

test('Hub renders combined CVS results with profile, bank, card and status filters', () => {
  const { dom, w, api } = setup();
  w.localStorage.setItem('cardOffersHubSource.chase.v1', JSON.stringify(chaseSource('Freedom', '123456789', Date.now())));
  api.syncCurrentBank();
  api.setProfile('chase', 'P2');
  w.localStorage.setItem('cardOffersHubSource.chase.v1', JSON.stringify(chaseSource('Sapphire', '987654321', Date.now() + 1)));
  api.syncCurrentBank();
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
  assert.match(root.querySelector('[data-results]').textContent, /P1/);
  assert.match(root.querySelector('[data-results]').textContent, /P2/);
  root.querySelector('[data-profile-filter="P2"]').click();
  assert.equal(root.querySelectorAll('.placement').length, 1);
  assert.match(root.querySelector('[data-results]').textContent, /Sapphire/);
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

test('installable Hub is updateable, local-only and never starts bank actions', () => {
  assert.match(source, /@version\s+0\.1\.3/);
  assert.match(source, /right:18px;bottom:18px/);
  assert.match(source, /panel\.style\.bottom = "auto"/);
  assert.doesNotMatch(source, /suppressLauncherClick/);
  assert.match(source, /@updateURL.*CardOffersHub\.user\.js/);
  assert.match(source, /GM_getValue/);
  assert.match(source, /GM_setValue/);
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|GM_xmlhttpRequest|\.click\(\).*add offer/i);
});
