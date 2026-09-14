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
});
