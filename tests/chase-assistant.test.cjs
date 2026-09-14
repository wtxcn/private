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
  assert.match(source, /@version\s+0\.1\.15/);
  assert.match(source, /brand-card/);
  assert.match(source, /search-icon/);
  assert.match(source, /-apple-system,BlinkMacSystemFont/);
  assert.match(source, /offer-meta\.complete \{ color:#61ae85/);
  assert.match(source, /offer-name \{ color:#071f52; font-size:17px; font-weight:800/);
  assert.match(source, /card\.added \{ color:#28784f; border-color:#76c59a; background:#eaf7ef/);
  assert.match(source, /text-decoration:none/);
  assert.match(source, /cardOffersHubSource\.chase\.v1/);
  assert.match(source, /publishHubSnapshot\(\)/);
});

test('Chase panel minimizes to a movable launcher and stays minimized across renders', () => {
  const snapshot = { cards: [{ id: 'a', name: 'Card A' }], offers: [
    { key: 'offer', name: 'Merchant', cards: { a: 'addable' } }
  ], selected: {}, scannedAt: 0, logs: [] };
  const { dom, w, api, panel } = loadPanel(snapshot);
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
