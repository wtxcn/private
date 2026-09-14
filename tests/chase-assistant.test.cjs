const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../ChaseOffersAssistant.user.js'), 'utf8');

function load() {
  const local = new Map();
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
