const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../ChaseOffersAssistant.user.js'), 'utf8');

function load(snapshot) {
  const local = new Map();
  if (snapshot) local.set('chaseOffersAssistantSnapshot.v1', JSON.stringify(snapshot));
  const context = vm.createContext({
    globalThis: {},
    localStorage: { getItem: (key) => local.get(key) || null, setItem: (key, value) => local.set(key, value) },
    sessionStorage: { getItem: (key) => local.get(`session:${key}`) || null, setItem: (key, value) => local.set(`session:${key}`, value), removeItem: (key) => local.delete(`session:${key}`) },
    location: { href: 'https://secure.chase.com/web/auth/dashboard#/dashboard/overview', hash: '#/dashboard/overview' },
    document: { body: { innerText: '' }, querySelectorAll: () => [], getElementById: () => null },
    window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) }
  });
  context.globalThis = context;
  context.__CHASE_ASSISTANT_TEST__ = {};
  vm.runInContext(source, context);
  return context.__CHASE_ASSISTANT_TEST__.api;
}

function loadPanel(snapshot) {
  const dom = new JSDOM('', { url: 'https://secure.chase.com/web/auth/dashboard#/dashboard/overview', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 20, top: 30, width: 100, height: 60 }; };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  if (snapshot) w.localStorage.setItem('chaseOffersAssistantSnapshot.v1', JSON.stringify(snapshot));
  w.__CHASE_ASSISTANT_TEST__ = {};
  w.eval(source);
  const api = w.__CHASE_ASSISTANT_TEST__.api;
  const panel = api.mount();
  return { dom, w, api, panel };
}

test('both Chase Offers routes remain supported', () => {
  const { dom, w, api } = loadPanel();
  for (const route of ['offerCategoriesPage', 'offer-hub']) {
    w.location.hash = `#/dashboard/merchantOffers/${route}?accountId=123`;
    assert.equal(api.isOffersPage('123'), true);
    assert.equal(api.isOffersPage('456'), false);
  }
  dom.window.close();
});

test('Chase hub recognizes icon-only add controls and deduplicates carousel copies', () => {
  const { dom, w, api } = loadPanel();
  w.document.body.insertAdjacentHTML('beforeend', `
    <a data-testid="commerce-tile" aria-label="1 of 3 Merchant A 10% cash back">Merchant A 10% cash back<svg data-testid="commerce-tile-button"></svg></a>
    <a data-testid="commerce-tile" aria-label="1 of 5 Merchant A 10% cash back Add Offer"></a>
    <a data-testid="commerce-tile" aria-label="2 of 3 Merchant B $5 cash back 1 day left Success Added"></a>
    <a data-testid="commerce-tile" aria-label="3 of 3 Merchant C 5% cash back"></a>`);
  const offers = api.readOffersForCard();
  assert.equal(offers.length, 2);
  assert.equal(offers[0].status, 'addable');
  assert.equal(offers[0].name, 'Merchant A 10% cash back');
  assert.equal(offers[1].status, 'added');
  assert.ok(api.findAddButton(offers[0]).querySelector('[data-testid="commerce-tile-button"]'));
  dom.window.close();
});

function pickerFixture(stale = false) {
  const fixture = loadPanel({ cards: [{ id: '999', name: 'Old card' }], offers: [], selected: {}, logs: [] });
  const { w } = fixture;
  let clock = Date.now();
  w.Date.now = () => clock;
  w.setTimeout = fn => { clock += 1000; queueMicrotask(() => {
    if (!stale && w.location.hash.includes('/offerCategoriesPage') && picker.isConnected) {
      draw(Number(w.location.hash.match(/accountId=(\d+)/)[1]) - 101);
      picker.remove();
    } else if (!stale && w.location.hash.includes('/offer-hub') && !picker.isConnected) {
      draw(Number(w.location.hash.match(/accountId=(\d+)/)[1]) - 101);
      w.document.body.append(picker);
    }
    fn();
  }); };
  w.location.hash = '#/dashboard/merchantOffers/offer-hub?accountId=101';
  w.document.body.insertAdjacentHTML('beforeend', `
    <div role="button" data-testid="select-credit-card-account" aria-expanded="false">Test Card (...1111)</div>
    <ul role="listbox" hidden>
      <li role="option" data-testid="user-account-option-0" aria-selected="true">Test Card (...1111)</li>
      <li role="option" data-testid="user-account-option-1" aria-selected="false">Test Card (...2222)</li>
      <li role="option" data-testid="user-account-option-2">BUS COMPLETE CHK (...3333)</li>
    </ul><h2>1 results</h2><div id="test-grid"></div>`);
  const picker = w.document.querySelector('[data-testid="select-credit-card-account"]');
  const menu = w.document.querySelector('[role="listbox"]');
  const grid = w.document.querySelector('#test-grid');
  const draw = index => { grid.innerHTML = `<a data-testid="commerce-tile" aria-label="1 of 1 Merchant ${index} 10% cash back"><svg data-testid="commerce-tile-button"></svg></a>`; };
  draw(0);
  picker.onclick = () => { menu.hidden = false; picker.setAttribute('aria-expanded', 'true'); };
  [...menu.children].forEach((option, index) => {
    option.onclick = () => {
      picker.textContent = option.textContent;
      picker.setAttribute('aria-expanded', 'false');
      menu.hidden = true;
      [...menu.children].forEach(e => e.setAttribute('aria-selected', String(e === option)));
      w.location.hash = `#/dashboard/merchantOffers/offer-hub?accountId=${101 + index}`;
      if (!stale) draw(index);
    };
  });
  return fixture;
}

test('Chase picker scans current login cards read-only without overview or cached IDs', async () => {
  const { dom, w, api } = pickerFixture();
  let enrollments = 0;
  w.document.querySelector('#test-grid').onclick = () => { enrollments++; };
  await api.scanAllCards();
  const snapshot = JSON.parse(w.localStorage.getItem('chaseOffersAssistantSnapshot.v1'));
  assert.deepEqual(snapshot.cards.map(card => card.id), ['101', '102']);
  assert.equal(snapshot.offers.length, 2);
  assert.ok(snapshot.cards.every(card => card.complete === true && card.scannedAt > 0));
  assert.deepEqual(snapshot.offers.map(offer => Object.keys(offer.cards)), [['101'], ['102']]);
  assert.equal(enrollments, 0);
  assert.match(w.location.hash, /offerCategoriesPage/);
  dom.window.close();
});

test('Chase picker rejects a changed label and URL while the previous grid remains', async () => {
  const { dom, api } = pickerFixture(true);
  assert.equal(await api.openPickerCard('Test Card (...2222)'), null);
  dom.window.close();
});

test('an incomplete category grid cannot authorize removal of cached offers', async () => {
  const { dom, w, api } = pickerFixture();
  w.document.querySelector('h2').textContent = '2 results';
  await api.scanAllCards();
  const saved = JSON.parse(w.localStorage.getItem('chaseOffersAssistantSnapshot.v1'));
  assert.deepEqual(saved.cards.map(card => card.id), ['999']);
  assert.ok(saved.logs.some(line => line.includes('previous saved results were retained')));
  dom.window.close();
});

test('adding continues across cards after enrollment removes the account picker', async () => {
  const { dom, w, api } = pickerFixture();
  await api.scanAllCards();
  api.toggleOfferSelection('merchant 0 10% cash back');
  api.toggleOfferSelection('merchant 1 10% cash back');
  const queue = w.__CHASE_ASSISTANT_TEST__.queue;
  await w.__CHASE_ASSISTANT_TEST__.api.openPickerCard('Test Card (...2222)');
  const picker = w.document.querySelector('[data-testid="select-credit-card-account"]');
  const grid = w.document.querySelector('#test-grid');
  const enrollments = [];
  const timer = w.setTimeout;
  w.setTimeout = fn => timer(() => {
    if (w.location.hash.includes('/offer-hub?') && !picker.isConnected) w.document.body.append(picker);
    fn();
  });
  grid.onclick = event => {
    const tile = event.target.closest('[data-testid="commerce-tile"]');
    if (!tile) return;
    const id = w.location.hash.match(/accountId=(\d+)/)[1];
    enrollments.push(id);
    tile.setAttribute('aria-label', tile.getAttribute('aria-label') + ' Success Added');
    tile.querySelector('svg')?.remove();
    picker.remove();
    w.location.hash = `#/dashboard/merchantOffers/offerCategoriesPage?accountId=${id}&offerCategoryName=ALL`;
  };
  await queue.addSelectedOffers();
  assert.deepEqual(enrollments, ['101', '102']);
  const saved = JSON.parse(w.localStorage.getItem('chaseOffersAssistantSnapshot.v1'));
  assert.ok(saved.offers.every(offer => Object.values(offer.cards).every(status => status === 'added')));
  assert.ok(saved.logs.some(line => line.includes('Finished all selected offers.')));
  assert.equal(api.selectedTasks().length, 0);
  assert.equal(api.loadAddRun(), null);
  dom.window.close();
});

test('picker recovery never enrolls when the hub fails to restore, and Stop cancels recovery', async () => {
  for (const stop of [false, true]) {
    const { dom, w, api } = pickerFixture(true);
    let clock = Date.now();
    w.Date.now = () => clock;
    w.setTimeout = fn => { clock += 1000; queueMicrotask(fn); };
    const queue = w.__CHASE_ASSISTANT_TEST__.queue;
    w.document.querySelector('[data-testid="select-credit-card-account"]').remove();
    w.location.hash = '#/dashboard/merchantOffers/offerCategoriesPage?accountId=101&offerCategoryName=ALL';
    let clicks = 0;
    w.document.querySelector('#test-grid').onclick = () => clicks++;
    if (stop) queueMicrotask(() => queue.stopCurrentRun());
    assert.equal(await queue.openOffers({ id: '102', pickerName: 'Test Card (...2222)' }), false);
    assert.match(w.location.hash, /offer-hub\?accountId=101$/);
    assert.equal(clicks, 0);
    assert.equal(api.loadAddRun(), null);
    dom.window.close();
  }
});

test('current picker card stays on its category grid and legacy category routing remains usable', async () => {
  const { dom, w } = pickerFixture();
  const queue = w.__CHASE_ASSISTANT_TEST__.queue;
  w.document.querySelector('[data-testid="select-credit-card-account"]').remove();
  w.location.hash = '#/dashboard/merchantOffers/offerCategoriesPage?accountId=101&offerCategoryName=ALL';
  const route = w.location.hash;
  assert.equal(await queue.openOffers({ id: '101', pickerName: 'Test Card (...1111)' }), true);
  assert.equal(await queue.openOffers({ id: '101', name: 'Legacy card' }), true);
  assert.equal(w.location.hash, route);
  dom.window.close();
});

function sheetPickerFixture({ startCategory = false, stale = false, incomplete = false, sameNameOffers = false, duplicateId = false, unknownTile = false, delayHubMount = false } = {}) {
  const fixture = loadPanel({ cards: [{ id: '999', name: 'Cached card from another login' }], offers: [], selected: {}, logs: [] });
  const { w } = fixture;
  const names = ['Test Cash (...1111)', 'Test Visa (...2222)', 'Test Flex (...3333)'];
  let selected = 0;
  let clock = Date.now();
  let category = startCategory;
  let allClicks = 0;
  let hubMountTicks = 0;
  const addedCards = new Set();
  const picker = w.document.createElement('button');
  picker.dataset.testid = 'account-selector-trigger';
  picker.setAttribute('aria-haspopup', 'dialog');
  picker.setAttribute('aria-expanded', 'false');
  const all = w.document.createElement('button');
  all.dataset.testid = 'offerHubCategoryNavbarButtonTopLink';
  all.setAttribute('aria-label', 'All 2 of 8');
  all.textContent = 'All';
  const heading = w.document.createElement('h2');
  const grid = w.document.createElement('div');
  w.document.body.append(heading, grid);
  const label = name => name.replace(' (...', '...').replace(')', '');
  const draw = () => {
    heading.textContent = category ? `${incomplete || sameNameOffers ? 2 : 1} results` : 'All offers';
    grid.innerHTML = `<a id="native-${selected}-a" data-testid="commerce-tile" aria-label="1 of 1 Merchant ${selected} 10% cash back${addedCards.has(String(201 + selected)) ? ' Success Added' : ''}"><svg data-testid="commerce-tile-button"></svg></a>`;
    if (sameNameOffers) grid.insertAdjacentHTML('beforeend', `<a id="native-${selected}-${duplicateId ? 'a' : 'b'}" data-testid="commerce-tile" aria-label="2 of 2 Merchant ${selected} 10% cash back${unknownTile ? '' : ' Success Added'}"></a>`);
    if (category) { picker.remove(); all.remove(); }
    else {
      picker.textContent = label(names[selected]);
      w.document.body.append(picker, all);
    }
  };
  w.location.hash = `#/dashboard/merchantOffers/${category ? 'offerCategoriesPage' : 'offer-hub'}?accountId=201${category ? '&offerCategoryName=ALL' : ''}`;
  draw();
  w.Date.now = () => clock;
  w.setTimeout = fn => { clock += 1000; queueMicrotask(() => {
    const nextCategory = w.location.hash.includes('/offerCategoriesPage');
    if (!stale && nextCategory !== category) {
      if (delayHubMount && !nextCategory && ++hubMountTicks < 3) w.document.body.append(picker);
      else { category = nextCategory; hubMountTicks = 0; draw(); }
    }
    fn();
  }); };
  picker.onclick = () => {
    assert.equal(category, false, 'do not open the picker before the restored hub has mounted');
    picker.setAttribute('aria-expanded', 'true');
    const sheet = w.document.createElement('div');
    sheet.dataset.testid = 'account-selector-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.innerHTML = `<ul role="listbox">${[...names, 'Checking (...4444)', 'Disabled Card (...5555)'].map((name, i) =>
      `<li role="option" data-testid="account-option-${i}" aria-selected="${i === selected}" aria-disabled="${i === 4}">${name}</li>`).join('')}</ul>`;
    w.document.body.append(sheet);
    [...sheet.querySelectorAll('[role="option"]')].forEach((option, i) => {
      option.onclick = () => {
        selected = i;
        picker.textContent = label(names[i]);
        picker.setAttribute('aria-expanded', 'false');
        sheet.remove();
        w.location.hash = `#/dashboard/merchantOffers/offer-hub?accountId=${201 + i}`;
        if (!stale) draw();
      };
    });
  };
  all.onclick = () => {
    allClicks++;
    w.location.hash = `#/dashboard/merchantOffers/offerCategoriesPage?accountId=${201 + selected}&offerCategoryName=ALL`;
  };
  return { ...fixture, grid, picker, names, addedCards, allClicks: () => allClicks };
}

for (const startCategory of [false, true]) {
  test(`sheet picker scans every card from ${startCategory ? 'All deals' : 'Offers hub'} without using overview IDs`, async () => {
    const { dom, w, api, grid, names, allClicks } = sheetPickerFixture({ startCategory });
    let enrollments = 0;
    grid.onclick = () => enrollments++;
    await api.scanAllCards();
    const saved = JSON.parse(w.localStorage.getItem('chaseOffersAssistantSnapshot.v1'));
    assert.deepEqual(saved.cards.map(card => card.id), ['201', '202', '203']);
    assert.deepEqual(saved.cards.map(card => card.name), names);
    assert.ok(saved.cards.every(card => card.complete && card.pickerKind === 'sheet' && card.scannedAt));
    assert.deepEqual(saved.offers.map(offer => Object.keys(offer.cards)), [['201'], ['202'], ['203']]);
    assert.equal(allClicks(), 3);
    assert.equal(enrollments, 0);
    assert.ok(saved.logs.some(line => line.includes('3/3 cards')));
    dom.window.close();
  });
}

test('sheet picker rejects stale grids even when both trigger label and URL changed', async () => {
  const { dom, api, names } = sheetPickerFixture({ stale: true });
  assert.equal(await api.openPickerCard(names[1]), null);
  dom.window.close();
});

test('sheet scan retries a trigger whose first click was lost while the hub mounted', async () => {
  const { dom, w, api, picker } = sheetPickerFixture({ startCategory: true });
  const show = picker.onclick;
  let clicks = 0;
  picker.onclick = () => { if (++clicks > 1) show(); };
  await api.scanAllCards();
  const saved = JSON.parse(w.localStorage.getItem('chaseOffersAssistantSnapshot.v1'));
  assert.deepEqual(saved.cards.map(card => card.id), ['201', '202', '203']);
  assert.ok(clicks >= 4);
  dom.window.close();
});

test('sheet scan waits for the restored hub grid even when the picker appears early', async () => {
  const { dom, w, api } = sheetPickerFixture({ startCategory: true, delayHubMount: true });
  await api.scanAllCards();
  const saved = JSON.parse(w.localStorage.getItem('chaseOffersAssistantSnapshot.v1'));
  assert.deepEqual(saved.cards.map(card => card.id), ['201', '202', '203']);
  dom.window.close();
});

test('an incomplete sheet scan cannot replace the previous saved results', async () => {
  const { dom, w, api } = sheetPickerFixture({ incomplete: true });
  await api.scanAllCards();
  const saved = JSON.parse(w.localStorage.getItem('chaseOffersAssistantSnapshot.v1'));
  assert.deepEqual(saved.cards.map(card => card.id), ['999']);
  assert.equal(w.localStorage.getItem('cardOffersHubSource.chase.v1'), null);
  dom.window.close();
});

test('native offer count accepts distinct same-name offers without treating conflicting enrollment as added', async () => {
  const { dom, w, api } = sheetPickerFixture({ sameNameOffers: true });
  await api.scanAllCards();
  const saved = JSON.parse(w.localStorage.getItem('chaseOffersAssistantSnapshot.v1'));
  assert.deepEqual(saved.cards.map(card => card.id), ['201', '202', '203']);
  assert.ok(saved.cards.every(card => card.complete));
  assert.ok(saved.offers.every(offer => Object.values(offer.cards).every(status => status === 'unknown')));
  dom.window.close();
});

for (const extra of [{ duplicateId: true }, { unknownTile: true }]) {
  test(`native offer count rejects ${extra.duplicateId ? 'duplicate IDs' : 'unrecognized tile status'} as a complete list`, async () => {
    const { dom, w, api } = sheetPickerFixture({ sameNameOffers: true, ...extra });
    await api.scanAllCards();
    const saved = JSON.parse(w.localStorage.getItem('chaseOffersAssistantSnapshot.v1'));
    assert.deepEqual(saved.cards.map(card => card.id), ['999']);
    assert.equal(w.localStorage.getItem('cardOffersHubSource.chase.v1'), null);
    dom.window.close();
  });
}

test('Stop during category-to-picker recovery never navigates to overview or starts enrollment', async () => {
  const { dom, w, api, grid } = sheetPickerFixture({ startCategory: true });
  let enrollments = 0;
  grid.onclick = () => enrollments++;
  queueMicrotask(() => w.__CHASE_ASSISTANT_TEST__.queue.stopCurrentRun());
  await api.scanAllCards();
  assert.match(w.location.hash, /offer-hub/);
  assert.equal(enrollments, 0);
  assert.equal(w.localStorage.getItem('cardOffersHubSource.chase.v1'), null);
  dom.window.close();
});

test('sheet picker label comparison preserves the card name, not just its last four digits', async () => {
  const { dom, api, names, picker } = sheetPickerFixture();
  const click = picker.onclick;
  picker.onclick = () => {
    click();
    const option = picker.ownerDocument.querySelector('[data-testid="account-option-1"]');
    const select = option.onclick;
    option.onclick = () => { select(); picker.textContent = 'Different Card...2222'; };
  };
  assert.equal(await api.openPickerCard(names[1]), null);
  dom.window.close();
});

test('the original dropdown also scans when started on its category page', async () => {
  const { dom, w, api } = pickerFixture();
  w.document.querySelector('[data-testid="select-credit-card-account"]').remove();
  w.location.hash = '#/dashboard/merchantOffers/offerCategoriesPage?accountId=101&offerCategoryName=ALL';
  await api.scanAllCards();
  const saved = JSON.parse(w.localStorage.getItem('chaseOffersAssistantSnapshot.v1'));
  assert.deepEqual(saved.cards.map(card => card.id), ['101', '102']);
  assert.ok(saved.cards.every(card => card.pickerKind === 'dropdown' && card.complete));
  dom.window.close();
});

test('sheet picker supports the existing user-started add queue across cards', async () => {
  const { dom, w, api, grid, picker, addedCards } = sheetPickerFixture();
  await api.scanAllCards();
  const enrollments = [];
  grid.onclick = event => {
    const tile = event.target.closest('[data-testid="commerce-tile"]');
    if (!tile) return;
    const id = w.location.hash.match(/accountId=(\d+)/)[1];
    enrollments.push(id);
    addedCards.add(id);
    tile.setAttribute('aria-label', tile.getAttribute('aria-label') + ' Success Added');
    tile.querySelector('svg')?.remove();
    picker.remove();
    w.location.hash = `#/dashboard/merchantOffers/offerCategoriesPage?accountId=${id}&offerCategoryName=ALL`;
  };
  for (let i = 0; i < 3; i++) api.toggleOfferSelection(`merchant ${i} 10% cash back`);
  assert.deepEqual(enrollments, []);
  await w.__CHASE_ASSISTANT_TEST__.queue.addSelectedOffers();
  assert.deepEqual(enrollments, ['201', '202', '203']);
  assert.equal(api.selectedTasks().length, 0);
  dom.window.close();
});

for (const startCategory of [false, true]) {
  test(`legacy overview-ID scan remains usable from ${startCategory ? 'category page without either picker' : 'overview'}`, async () => {
    const { dom, w, api } = loadPanel();
    w.document.body.insertAdjacentHTML('beforeend', `
      <button id="account-tile-navigation-button-requestCardPayment-301"></button>
      <button id="accounts-name-link-button-301">Legacy Card (...1111)</button>
      <button id="account-tile-navigation-button-requestCardPayment-302"></button>
      <button id="accounts-name-link-button-302">Legacy Card (...2222)</button>
      <h2>1 results</h2><div id="legacy-grid"></div>`);
    let clock = Date.now();
    let previousHash = '';
    w.Date.now = () => clock;
    w.setTimeout = fn => { clock += 1000; queueMicrotask(() => {
      if (previousHash !== w.location.hash) {
        previousHash = w.location.hash;
        const id = w.location.hash.match(/accountId=(\d+)/)?.[1];
        w.document.querySelector('#legacy-grid').innerHTML = id
          ? `<a data-testid="commerce-tile" aria-label="Merchant ${id} 10% cash back Add offer"></a>` : '';
      }
      fn();
    }); };
    if (startCategory) w.location.hash = '#/dashboard/merchantOffers/offerCategoriesPage?accountId=301&offerCategoryName=ALL';
    await api.scanAllCards();
    const saved = JSON.parse(w.localStorage.getItem('chaseOffersAssistantSnapshot.v1'));
    assert.deepEqual(saved.cards.map(card => card.id), ['301', '302']);
    assert.deepEqual(saved.offers.map(offer => Object.keys(offer.cards)), [['301'], ['302']]);
    assert.ok(saved.cards.every(card => card.complete));
    dom.window.close();
  });
}

test('normalizes Chase tile labels without merchant drift', () => {
  const { normalizeOfferName } = load();
  assert.equal(normalizeOfferName('12 of 113 Viator 8% cash back Add offer New'), 'viator 8% cash back');
  assert.equal(normalizeOfferName('Lyft 10% cash back 17 days left Success Added'), 'lyft 10% cash back');
});

test('keeps reward amounts as part of the offer identity', () => {
  const { normalizeOfferName } = load();
  assert.notEqual(normalizeOfferName('Merchant 5% cash back Add offer'), normalizeOfferName('Merchant $10 cash back Add offer'));
});

test('strips controls while retaining offer display text', () => {
  const { displayOfferName } = load();
  assert.equal(displayOfferName('3 of 113 Chevron 3% cash back Add offer'), 'Chevron 3% cash back');
  assert.equal(displayOfferName('[solidcore] 15% cash back Add offer [solidcore] 15% cash back'), '[solidcore] 15% cash back');
});

test('Chase commerce tiles remain the single source of offer state', () => {
  assert.match(source, /\[data-testid="commerce-tile"\]/);
  assert.match(source, /getAttribute\("aria-label"\)/);
});

test('add queue is retained only while the user-started run has a resume permit', () => {
  const { saveAddRun, loadAddRun, clearAddRun } = load();
  saveAddRun({ tasks: [{ offerKey: 'merchant 10% cash back', cardId: '1234' }], index: 0 }, true);
  assert.equal(loadAddRun().tasks.length, 1);
  assert.ok(loadAddRun().resumeUntil > 0);
  clearAddRun();
  assert.equal(loadAddRun(), null);
});

test('an ineligible Chase card is removed from the remaining add queue at once', () => {
  const api = load({
    cards: [{ id: 'a', name: 'Card A' }, { id: 'b', name: 'Card B' }],
    offers: [
      { key: 'first', name: 'First', cards: { a: 'addable', b: 'addable' } },
      { key: 'second', name: 'Second', cards: { a: 'addable' } },
      { key: 'confirmed', name: 'Confirmed', cards: { a: 'added' } }
    ],
    selected: { first: ['a', 'b'], second: ['a'] },
    scannedAt: 1,
    logs: []
  });
  const original = api.saveAddRun({ tasks: [
    { offerKey: 'first', cardId: 'a' },
    { offerKey: 'first', cardId: 'b' },
    { offerKey: 'second', cardId: 'a' }
  ], index: 0 });
  const result = api.removeCardTasks(original, 'a');
  assert.equal(result.skipped, 2);
  assert.deepEqual(Array.from(result.run.tasks, task => task.cardId), ['b']);
  assert.equal(result.run.index, 0);
  assert.equal(api.markCardUnavailable({ id: 'a', name: 'Card A' }), 2);
  assert.deepEqual(Array.from(api.selectedTasks(), task => `${task.offer.key}:${task.card.id}`), ['first:b']);
  const offers = Array.from(api.filteredOffers());
  assert.equal(offers.find(offer => offer.key === 'first').cards.a, 'unknown');
  assert.equal(offers.find(offer => offer.key === 'second').cards.a, 'unknown');
  assert.equal(offers.find(offer => offer.key === 'confirmed').cards.a, 'added');
});

test('Chase ineligible page errors skip the whole card instead of retrying each offer', () => {
  assert.match(source, /function pageOfferErrorMessage\(\)/);
  assert.match(source, /Chase says this card is not eligible for Offers/);
  assert.match(source, /run = skipUnavailableCard\(run, card, loadError\)/);
  assert.match(source, /run = skipUnavailableCard\(run, card, verifyError\)/);
});

test('the summary view does not cap the aggregated offer list', () => {
  assert.doesNotMatch(source, /offers\.slice\(0, 400\)/);
  assert.match(source, /Unique offers/);
  assert.match(source, /data-card-filter/);
});

test('card transitions wait for the prior offer grid to detach before scanning', () => {
  assert.match(source, /previousTiles\.every\(\(tile\) => !tile\.isConnected\)/);
  assert.match(source, /previousGridRemoved/);
});

test('summary statistics provide clickable views for cards and offer states', () => {
  assert.match(source, /data-stat="cards"/);
  assert.match(source, /data-stat="selected"/);
  assert.match(source, /data-card-summary/);
  assert.match(source, /viewFilter === "selected"/);
});

test('live search restores focus after rebuilding filtered offer rows', () => {
  assert.match(source, /function render\(restoreSearchFocus = false\)/);
  assert.match(source, /render\(true\)/);
  assert.match(source, /searchInput\.setSelectionRange\(searchTerm\.length, searchTerm\.length\)/);
});

test('offer scans retain Chase tile imagery for the visual list', () => {
  assert.match(source, /tile\.querySelector\("img"\)/);
  assert.match(source, /imageUrl/);
  assert.match(source, /class="offer-logo/);
});

test('the assistant panel uses the refreshed logo, system font, and offer-state colors', () => {
  assert.match(source, /@version\s+0\.1\.22/);
  assert.match(source, /brand-card/);
  assert.match(source, /search-icon/);
  assert.match(source, /-apple-system,BlinkMacSystemFont/);
  assert.match(source, /offer-meta\.complete \{ color:#61ae85/);
  assert.match(source, /offer-name \{ color:#071f52; font-size:17px; font-weight:800/);
  assert.match(source, /card\.added \{ color:#28784f; border-color:#76c59a; background:#eaf7ef/);
  assert.match(source, /card\.unverified \{ color:#945c15/);
  assert.match(source, /status !== "addable"/);
  assert.match(source, /text-decoration:none/);
  assert.match(source, /cardOffersHubSource\.chase\.v1/);
  assert.match(source, /publishHubSnapshot\(\)/);
});

test('Chase panel starts minimized and supports repeated restore/minimize without pointer capture', () => {
  const { dom, w, api, panel } = loadPanel();
  let captures = 0;
  panel.setPointerCapture = () => { captures++; };
  assert.equal(api.minimized(), true);
  assert.equal(w.getComputedStyle(panel.querySelector('.panel-shell')).display, 'none');
  assert.equal(w.getComputedStyle(panel.querySelector('.launcher')).display, 'flex');
  for (let i = 0; i < 3; i++) {
    const launcher = panel.querySelector('[data-restore]');
    launcher.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    launcher.dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true, button: 0 }));
    launcher.click();
    assert.equal(captures, 0);
    assert.equal(api.minimized(), false);
    assert.equal(w.getComputedStyle(panel.querySelector('.panel-shell')).display, 'flex');
    const minimize = panel.querySelector('[data-minimize]');
    minimize.addEventListener('click', (event) => event.stopPropagation());
    minimize.click();
    assert.equal(api.minimized(), true);
    api.render();
    assert.equal(w.getComputedStyle(panel.querySelector('.panel-shell')).display, 'none');
  }
  assert.equal(panel.querySelector('.run-state').textContent, 'Ready');
  dom.window.close();
});

test('Chase panel minimizes to a movable launcher and stays minimized across renders', () => {
  const snapshot = { cards: [{ id: 'a', name: 'Card A' }], offers: [
    { key: 'offer', name: 'Merchant', cards: { a: 'addable' } }
  ], selected: {}, scannedAt: 0, logs: [] };
  const { dom, w, api, panel } = loadPanel(snapshot);
  panel.querySelector('[data-restore]').click();
  assert.equal(api.minimized(), false);
  panel.querySelector('[data-minimize]').click();
  assert.equal(api.minimized(), true);
  api.toggleOfferSelection('offer');
  api.render();
  assert.equal(panel.classList.contains('minimized'), true);
  const launcher = panel.querySelector('[data-restore]');
  launcher.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 40, clientY: 50 }));
  panel.dispatchEvent(new w.MouseEvent('pointermove', { bubbles: true, clientX: 180, clientY: 150 }));
  panel.dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true, clientX: 180, clientY: 150 }));
  assert.equal(panel.style.left, '160px');
  assert.equal(panel.style.top, '130px');
  panel.querySelector('[data-restore]').click();
  assert.equal(api.minimized(), true);
  panel.querySelector('[data-restore]').click();
  assert.equal(api.minimized(), false);
  assert.equal(api.selectedTasks().length, 1);
  dom.window.close();
});

test('Add selected starts the guarded queue without an extra confirmation dialog', () => {
  const handler = source.slice(source.indexOf('async function addSelectedOffers()'), source.indexOf('function stopCurrentRun()'));
  assert.doesNotMatch(source, /window\.confirm\s*\(/);
  assert.match(handler, /if \(!tasks\.length \|\| scanInProgress \|\| addInProgress\) return/);
  assert.match(handler, /saveAddRun\(/);
  assert.match(handler, /await processAddRun\(\)/);
  assert.match(source, /addEventListener\("click", addSelectedOffers\)/);
  assert.match(source, /if \(pendingRun\?\.resumeUntil > Date\.now\(\)\)/);
});

test('Added requires every applicable card, not just one added card', () => {
  const { isOfferFullyAdded } = load();
  assert.equal(isOfferFullyAdded({ cards: { a: 'added', b: 'addable' } }), false);
  assert.equal(isOfferFullyAdded({ cards: { a: 'added', b: 'added' } }), true);
  assert.equal(isOfferFullyAdded({ cards: { a: 'added' } }), true);
  assert.equal(isOfferFullyAdded({ cards: {} }), false);
  assert.equal(isOfferFullyAdded({ cards: { a: 'added', b: 'unknown' } }), false);
});

test('partial offers stay in Addable even when filtering to an already-added card', () => {
  const api = load({ cards: [{ id: 'a' }, { id: 'b' }], selected: {}, offers: [
    { key: 'partial', name: 'Partial', cards: { a: 'added', b: 'addable' } },
    { key: 'complete', name: 'Complete', cards: { a: 'added', b: 'added' } },
    { key: 'limited', name: 'Limited', cards: { a: 'added' } },
    { key: 'new', name: 'New', cards: { b: 'addable' } }
  ] });
  const keys = (filter, scope) => Array.from(api.filteredOffers(filter, scope), offer => offer.key);
  assert.deepEqual(keys('added'), ['complete', 'limited']);
  assert.deepEqual(keys('addable'), ['partial', 'new']);
  assert.deepEqual(keys('added', 'a'), ['complete', 'limited']);
  assert.deepEqual(keys('addable', 'a'), ['partial']);
  api.mergeCardOffers({ id: 'b' }, [{ key: 'partial', name: 'Partial', status: 'added' },
    { key: 'complete', name: 'Complete', status: 'added' }, { key: 'new', name: 'New', status: 'addable' }]);
  assert.ok(keys('added').includes('partial'));
  assert.ok(!keys('addable').includes('partial'));
  assert.match(source, /const addedOffers = snapshot\.offers\.filter\(isOfferFullyAdded\)\.length/);
  assert.match(source, /const isComplete = isOfferFullyAdded\(offer\)/);
});

test('offer selection toggles all eligible cards, skips added cards, and permits individual changes', () => {
  const api = load({ cards: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], offers: [
    { key: 'offer', name: 'Offer', cards: { a: 'addable', b: 'addable', c: 'added' } },
    { key: 'other', name: 'Other', cards: { a: 'addable' } },
    { key: 'complete', name: 'Complete', cards: { a: 'added' } }
  ], selected: { other: ['a'] } });
  const ids = () => Array.from(api.selectedTasks().filter((task) => task.offer.key === 'offer'), (task) => task.card.id);
  api.toggleOfferSelection('offer');
  assert.deepEqual(ids(), ['a', 'b']);
  assert.equal(api.loadAddRun(), null);
  api.toggleSelection('offer', 'a');
  assert.deepEqual(ids(), ['b']);
  api.toggleOfferSelection('offer');
  assert.deepEqual(ids(), ['a', 'b']);
  api.toggleOfferSelection('offer');
  assert.deepEqual(ids(), []);
  api.toggleOfferSelection('complete');
  api.toggleOfferSelection('missing');
  assert.equal(api.selectedTasks().length, 1);
  assert.equal(api.selectedTasks()[0].offer.key, 'other');
});
