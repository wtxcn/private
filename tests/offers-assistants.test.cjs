const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const base = path.join(__dirname, '..');
const core = fs.readFileSync(path.join(base, 'src/offers-assistant/core.js'), 'utf8');
const adapterSource = bank => fs.readFileSync(path.join(base, 'src/offers-assistant', `${bank}.js`), 'utf8');
const config = bank => ({ id: `${bank}-offers-assistant`, name: `${bank} Offers`, version: '0.1.0', legacyStore: `${bank}OfferClickerState.v1`, legacyPanel: `${bank === 'citi' ? 'citi' : 'usbank'}-offer-clicker`, scopePlural: 'cards', allLabel: 'All cards', scanLabel: 'Scan all cards', cardMode: true, icons: { card: '', collapse: '', search: '', trash: '' } });
function setup(bank = 'citi', html = '', seed) {
  const url = bank === 'citi' ? 'https://online.citi.com/US/nga/products-offers/merchantoffers' : 'https://onlinebanking.usbank.com/digital/servicing/dominjection/cashback-deals';
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLElement.prototype.getBoundingClientRect = function () { return { width: this.hidden ? 0 : 100, height: this.hidden ? 0 : 60 }; };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  // Advance logical time between awaits without spending minutes on enrollment delays.
  let elapsed = Date.now();
  w.Date.now = () => elapsed;
  w.setTimeout = (fn, delay) => { elapsed += delay || 0; queueMicrotask(fn); return 1; };
  w.__OFFERS_ASSISTANT_TEST__ = {};
  if (seed) w.localStorage.setItem(`${bank}-offers-assistant.snapshot.v1`, JSON.stringify(seed));
  w.eval(core + '\n' + adapterSource(bank));
  w.eval(`createOffersAssistant(${JSON.stringify(config(bank))}, ${bank === 'citi' ? 'createCitiAdapter' : 'createUSBankAdapter'});`);
  return { dom, w, api: w.__OFFERS_ASSISTANT_TEST__.api };
}
const seed = () => ({ cards: [{ id: 'a', name: 'Test Card A' }, { id: 'b', name: 'Test Card B' }], offers: [
  { key: 'partial', name: 'Merchant Alpha', cards: { a: 'added', b: 'addable' } },
  { key: 'ready', name: 'Merchant Beta', cards: { a: 'addable', b: 'addable' } },
  { key: 'done', name: 'Merchant Gamma', cards: { a: 'added' } },
  { key: 'unknown', name: 'Merchant Delta', cards: { a: 'unknown' } }
], selected: { ready: ['a'] }, scannedAt: 100 });
for (const bank of ['citi', 'usbank']) {
  test(`${bank}: all-card selection, individual toggle and completed-only Added`, () => {
    const { dom, api } = setup(bank, '', seed());
    assert.equal(api.tasks().length, 0);
    api.toggleOffer('partial');
    assert.deepEqual(Array.from(api.tasks(), t => t.card.id), ['b']);
    api.toggleOffer('ready');
    assert.equal(api.tasks().length, 3);
    api.toggleCard('ready', 'a');
    assert.equal(api.tasks().length, 2);
    api.toggleOffer('ready');
    assert.equal(api.tasks().length, 3);
    api.toggleOffer('ready');
    api.toggleCard('partial', 'a');
    assert.equal(api.tasks().length, 1);
    assert.deepEqual(Array.from(api.filtered('added'), o => o.key), ['done']);
    assert.deepEqual(Array.from(api.filtered('unknown'), o => o.key), ['unknown']);
    api.merge({ id: 'b', name: 'Test Card B' }, [{ key: 'partial', name: 'Merchant Alpha', status: 'added' }]);
    assert.ok(api.filtered('added').some(o => o.key === 'partial'));
    dom.window.close();
  });
  test(`${bank}: stop interrupts selected queue; failures never mark an offer green`, async () => {
    const { dom, api } = setup(bank, '', seed());
    api.adapter.assertPage = () => {};
    api.adapter.openCard = async () => {};
    let calls = 0;
    api.adapter.addOffer = async () => { calls += 1; return 'unknown'; };
    api.toggleOffer('ready');
    await api.addSelected();
    assert.equal(calls, 2);
    assert.equal(api.snapshot().offers.find(o => o.key === 'ready').cards.a, 'unknown');
    assert.ok(!api.filtered('added').some(o => o.key === 'ready'));
    api.merge({ id: 'a', name: 'Test Card A' }, [{ key: 'ready', name: 'Merchant Beta', status: 'addable' }]);
    api.merge({ id: 'b', name: 'Test Card B' }, [{ key: 'ready', name: 'Merchant Beta', status: 'addable' }]);
    api.toggleOffer('ready');
    calls = 0;
    api.adapter.addOffer = async () => { calls += 1; api.stop(); return 'added'; };
    await api.addSelected();
    assert.equal(calls, 1);
    dom.window.close();
  });
  test(`${bank}: boot and selection never enroll; busy click is ignored; all tasks complete sequentially`, async () => {
    const { dom, api } = setup(bank, '', seed());
    let clicks = 0;
    api.adapter.assertPage = () => {};
    api.adapter.openCard = async () => {};
    api.adapter.addOffer = async () => { clicks += 1; return 'added'; };
    api.toggleOffer('ready');
    assert.equal(clicks, 0);
    await Promise.all([api.addSelected(), api.addSelected()]);
    assert.equal(clicks, 2);
    assert.equal(api.tasks().length, 0);
    assert.ok(api.filtered('added').some(o => o.key === 'ready'));
    assert.equal(dom.window.sessionStorage.length, 0);
    dom.window.close();
  });
  test(`${bank}: real panel click bubbles once and continuous search retains the input node`, () => {
    const { dom, w } = setup(bank, '', seed());
    delete w.__OFFERS_ASSISTANT_TEST__;
    w.eval(`createOffersAssistant(${JSON.stringify(config(bank))}, ${bank === 'citi' ? 'createCitiAdapter' : 'createUSBankAdapter'});`);
    const root = w.document.querySelector(`#${bank}-offers-assistant`).shadowRoot;
    root.querySelector('[data-offer="ready"] strong').click();
    assert.equal(root.querySelectorAll('[data-offer="ready"] .chosen').length, 2);
    root.querySelector('[data-offer="ready"] [data-card="a"]').click();
    assert.equal(root.querySelectorAll('[data-offer="ready"] .chosen').length, 1);
    root.querySelector('[data-offer="ready"] [data-offer-toggle]').click();
    assert.equal(root.querySelectorAll('[data-offer="ready"] .chosen').length, 2);
    const input = root.querySelector('[data-search]');
    input.focus();
    for (const char of 'Beta') { input.value += char; input.dispatchEvent(new w.Event('input', { bubbles: true })); assert.equal(root.querySelector('[data-search]'), input); }
    assert.equal(root.querySelectorAll('[data-offer]').length, 1);
    assert.equal(root.activeElement, input);
    assert.equal(root.querySelector('[data-add]').textContent, 'Add selected (2)');
    assert.equal(root.querySelector('[data-offer="ready"] .offer-main strong').textContent, 'Merchant Beta');
    dom.window.close();
  });
}
const picker = '<select id="card-selector-cds-dropdown"><option value="a">Test Card A - 1111</option><option value="b">Test Card B - 2222</option><option value="c">Test ATM Card - 3333</option></select>';
const citiTile = (name, status = 'addable', reward = '10% cash back') => `<cds-tile><h3>${name}</h3><p>${reward}</p>${status === 'addable' ? `<button id="${name}-Shopping-oneclick" aria-label="Enroll in Offer for ${name}">+</button>` : `<span>Enrolled in ${name}</span>`}</cds-tile>`;
test('Citi: stable selection, merchant identities, positive enrollment signal, single native click', async () => {
  const { dom, api, w } = setup('citi', picker + citiTile('Merchant A') + citiTile('Merchant B', 'added'));
  const card = api.adapter.currentCard();
  assert.equal(card.id, 'card:a');
  assert.equal((await api.adapter.discoverCards()).length, 3);
  assert.ok(api.adapter.cardFromName('Legacy Test Card (...4444)'));
  assert.equal(api.adapter.cardFromName('Selected card'), null);
  const rows = api.adapter.readOffers();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'addable');
  let clicks = 0;
  rows[0].node.querySelector('button').onclick = function () { clicks += 1; this.outerHTML = '<span>Enrolled</span>'; };
  assert.equal(await api.adapter.addOffer(card, rows[0]), 'added');
  assert.equal(clicks, 1);
  assert.equal(api.adapter.readOffers()[0].key, rows[0].key);
  w.document.querySelector('select').value = 'b';
  await assert.rejects(api.adapter.addOffer(card, rows[1]), /changed/);
  dom.window.close();
});
test('Citi: change waits for replacement grid; new card cannot inherit old grid', async () => {
  const { dom, api, w } = setup('citi', picker + citiTile('Old merchant'));
  const cards = await api.adapter.discoverCards();
  await assert.rejects(api.adapter.openCard(cards[1]), /did not confirm/);
  await assert.rejects(api.adapter.openCard(cards[1]), /did not confirm/);
  w.document.querySelector('select').value = 'a';
  w.document.querySelector('select').onchange = () => { w.document.querySelector('cds-tile').outerHTML = citiTile('New merchant'); };
  await api.adapter.openCard(cards[1]);
  assert.equal(api.adapter.readOffers()[0].name, 'New merchant');
  dom.window.close();
});
test('Citi: button disappearing without success is not enrolled', async () => {
  const { dom, api } = setup('citi', picker + citiTile('Merchant A'));
  const offer = api.adapter.readOffers()[0];
  offer.node.querySelector('button').onclick = function () { this.remove(); };
  await assert.rejects(api.adapter.addOffer(api.adapter.currentCard(), offer), /did not confirm/);
  dom.window.close();
});
function usbFixture() {
  const fixture = setup('usbank', '<button aria-label="Offer from Merchant A 10% cash back"><span>10% cash back</span></button><span>Offer activated</span>');
  let activationClicks = 0;
  let positive = true;
  fixture.w.document.querySelector('button').onclick = () => {
    const modal = fixture.w.document.createElement('div');
    modal.id = 'vicinity-overlay-click-modal';
    modal.innerHTML = '<h2>Merchant A</h2><button id="activate-offer">Activate Offer</button><button id="vicinity-overlay-click-modal--close">Close modal</button>';
    modal.querySelector('#activate-offer').onclick = function () { activationClicks += 1; this.outerHTML = positive ? '<span>Offer activated</span>' : '<span>Loading</span>'; };
    modal.querySelector('#vicinity-overlay-click-modal--close').onclick = () => modal.remove();
    fixture.w.document.body.appendChild(modal);
  };
  return { ...fixture, activationClicks: () => activationClicks, fail: () => { positive = false; } };
}
test('US Bank: scan opens details read-only, ignores unrelated success text, then adds only on request', async () => {
  const { dom, api, activationClicks } = usbFixture();
  const card = api.adapter.currentCard();
  const result = await api.adapter.scanCard(card);
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].name, 'Merchant A');
  assert.equal(result.offers[0].status, 'addable');
  assert.equal(activationClicks(), 0);
  assert.equal(await api.adapter.addOffer(card, result.offers[0]), 'added');
  assert.equal(activationClicks(), 1);
  assert.equal(dom.window.document.querySelector('#vicinity-overlay-click-modal'), null);
  dom.window.close();
});
test('US Bank: disappearing Activate button without modal success remains unverified', async () => {
  const { dom, api, fail } = usbFixture();
  fail();
  await assert.rejects(api.adapter.addOffer(api.adapter.currentCard(), api.adapter.readOffers()[0]), /did not confirm/);
  dom.window.close();
});
test('US Bank: current OfferHub detail controls identify addable and activated deals', () => {
  const { dom, api, w } = setup('usbank');
  const overlay = w.document.createElement('section');
  overlay.className = 'offerhub-overlay';
  overlay.innerHTML = '<h1>Merchant A</h1><div class="usb-modal-v2"><button id="activate-offer">Activate</button></div><button id="close-action">Close</button>';
  w.document.body.appendChild(overlay);
  assert.equal(api.adapter.activateButton(api.adapter.modal()), overlay.querySelector('#activate-offer'));
  assert.equal(api.adapter.activated(api.adapter.modal()), false);
  overlay.querySelector('#activate-offer').outerHTML = '<button id="activated-offer">Offer activated</button>';
  assert.equal(api.adapter.activated(api.adapter.modal()), true);
  assert.equal(typeof api.adapter.closeDetail, 'function');
  dom.window.close();
});
test('packaged scripts have independent identities, no remote library, no confirmation or resume-on-boot', () => {
  for (const name of ['CitiOffersAssistant', 'USBankOffersAssistant']) {
    const code = fs.readFileSync(path.join(base, `${name}.user.js`), 'utf8');
    assert.match(code, new RegExp(`@downloadURL.*${name}\\.user\\.js`));
    assert.doesNotMatch(code, /window\.confirm|@require|GM_xmlhttpRequest|fetch\(|XMLHttpRequest|state\.active/);
    assert.match(code, /font-size:17px;font-weight:800/);
    assert.match(code, /\.card\.added\{color:#28784f/);
  }
});

test('an omitted card-offer record on rescan cannot make a partial offer fully added', () => {
  const { dom, api } = setup('citi', '', seed());
  api.merge({ id: 'b', name: 'Test Card B' }, [], true);
  assert.equal(api.snapshot().offers.find(o => o.key === 'partial').cards.b, 'unknown');
  assert.ok(!api.filtered('added').some(o => o.key === 'partial'));
  dom.window.close();
});

test('a stale legacy active flag does not block scanning after the old clicker is disabled', async () => {
  const { dom, api, w } = setup('citi');
  w.localStorage.setItem('citiOfferClickerState.v1', JSON.stringify({ active: true, phase: 'running' }));
  api.adapter.assertPage = () => {};
  api.adapter.discoverCards = async () => [{ id: 'card:a', name: 'Test Card (...1111)' }];
  api.adapter.openCard = async () => {};
  let scans = 0;
  api.adapter.scanCard = async () => { scans += 1; return { offers: [], complete: true }; };
  await api.scan();
  assert.equal(scans, 1);

  const legacyPanel = w.document.createElement('aside');
  legacyPanel.id = 'citi-offer-clicker';
  w.document.body.appendChild(legacyPanel);
  await api.scan();
  assert.equal(scans, 1);
  assert.match(api.snapshot().logs.at(-1), /old clicker is running/i);
  dom.window.close();
});
