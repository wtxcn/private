const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../ChaseOfferClicker.user.js'), 'utf8');
const exported = ['getState', 'setState', 'getAccountIds', 'setAccountIds', 'scanAccounts',
  'extractAccountIdsFromPage', 'startRun', 'stopRun', 'resumeAfterRefresh', 'runActiveProcess',
  'processCurrentPage', 'waitForPageReady', 'waitForHubReady', 'finishCurrentAccount',
  'ensureOnHubForState', 'clickOneOffer', 'getAddButtons', 'armResume', 'boot'];

function storage() {
  const data = new Map();
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key)
  };
}

function harness() {
  const timers = [];
  const navigations = [];
  let now = 100000;
  const page = { cards: [], tiles: [], headings: [], ready: false };
  const node = (text = '', attrs = {}) => ({
    id: attrs.id || '', textContent: text, innerText: text, isConnected: true,
    getAttribute: key => attrs[key] || null,
    closest: selector => selector === '#chase-offer-clicker' ? null : {},
    getBoundingClientRect: () => ({ width: attrs.hidden ? 0 : 100, height: 30 }),
    scrollIntoView() {}, click() { navigations.push('click'); },
  });
  const location = {
    href: 'https://secure.chase.com/web/auth/dashboard#/dashboard/overview',
    get hash() { return this.href.slice(this.href.indexOf('#')); },
    hostname: 'secure.chase.com',
    assign(url) { navigations.push(url); this.href = url; },
    reload() { navigations.push('reload'); },
  };
  const document = {
    title: 'Chase Offers', body: { textContent: '', scrollHeight: 1000 },
    documentElement: { innerHTML: 'accountId=999999 stale script logs' },
    getElementById: () => null,
    querySelectorAll(selector) {
      if (selector.includes('requestCardPayment-')) return page.cards;
      if (selector === 'h1, h2, [role="alert"]') return page.headings;
      if (selector === '[data-testid="commerce-tile"]') return page.tiles;
      return [];
    },
    querySelector(selector) {
      if (selector === '[data-testid="categoryOffersSectionContainer"]') return page.ready ? {} : null;
      return null;
    },
  };
  const context = vm.createContext({
    document, location, localStorage: storage(), sessionStorage: storage(),
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, ms) { timers.push({ fn, ms }); }, setInterval() {}, clearInterval() {},
    window: {
      getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
      setTimeout(fn, ms) { timers.push({ fn, ms }); },
      addEventListener() {}, scrollTo() {}, scrollBy() {}, scrollY: 0, innerHeight: 800,
    },
  });
  vm.runInContext(source.replace('  boot();', `  globalThis.api = { ${exported.join(',')} };
    globalThis.setBusy = value => { processInFlight = value; };
    panel = {querySelector: () => ({value: '1'})};
    makePanel = () => panel;
    render = () => {};
    scheduleRender = () => {};`), context);
  const api = context.api;
  function active(extra = {}) {
    api.setState({ active: true, phase: 'process', accountId: '1111', accountIds: ['1111'], ...extra });
  }
  function hub(id = '1111') {
    location.href = `https://secure.chase.com/web/auth/dashboard#/dashboard/merchantOffers/offerCategoriesPage?accountId=${id}&offerCategoryName=ALL`;
  }
  async function tick() {
    const timer = timers.shift();
    if (timer) { now += timer.ms; timer.fn(); }
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  return { api, context, page, node, location, navigations, timers, active, hub, tick };
}

test('legacy localStorage run and cached account IDs cannot leak into a new tab', () => {
  const h = harness();
  h.context.localStorage.setItem('chaseOfferClickerState.v1', JSON.stringify({ active: true, accountId: '9999' }));
  h.context.localStorage.setItem('chaseOfferClickerAccountIds.v1', '["9999"]');
  assert.equal(h.api.getState().active, false);
  assert.equal(h.api.getAccountIds().length, 0);
});

test('scan uses only rendered payment controls, ignoring raw HTML and hidden accounts', () => {
  const h = harness();
  h.page.cards = [h.node('', { id: 'account-tile-navigation-button-requestCardPayment-1111' }),
    h.node('', { id: 'account-tile-navigation-button-requestCardPayment-2222', hidden: true })];
  h.api.setAccountIds(['9999']);
  assert.deepEqual(Array.from(h.api.scanAccounts()), ['1111']);
  h.page.cards = [];
  h.api.scanAccounts();
  assert.equal(h.api.getAccountIds().length, 0);
});

test('Add All Cards never starts with cached IDs from the Offers page', () => {
  const h = harness(); h.hub(); h.api.setAccountIds(['9999', '8888']);
  h.api.startRun({ allCards: true });
  assert.equal(h.api.getState().phase, 'scan-accounts');
  assert.equal(h.api.getAccountIds().length, 0);
  assert.match(h.navigations[0], /overview$/);
});

test('Add Loaded Offers does not fall back to the previous queue off an account page', () => {
  const h = harness(); h.api.setState({ active: false, accountId: '9999' });
  h.api.startRun();
  assert.equal(h.api.getState().active, false);
  assert.equal(h.navigations.length, 0);
});

test('ineligible page stops without reload, queue advancement, or false success', async () => {
  const h = harness(); h.hub(); h.active({ allCards: true, accountIds: ['1111', '2222'] });
  h.page.headings = [h.node('Your account is not eligible to access Chase Offers.')];
  await h.api.resumeAfterRefresh();
  assert.equal(h.api.getState().phase, 'offers-unavailable');
  assert.equal(h.api.getState().active, false);
  assert.equal(h.navigations.length, 0);
});

test('Stop while waiting for loading cancels worker and cannot resurrect navigation', async () => {
  const h = harness(); h.hub(); h.active();
  h.api.runActiveProcess(0); await h.tick();
  h.api.stopRun(); await h.tick();
  assert.equal(h.api.getState().phase, 'stopped');
  assert.equal(h.api.getState().active, false);
  assert.equal(h.navigations.length, 0);
});

test('Stop during pre-click delay prevents offer activation', async () => {
  const h = harness(); h.hub(); h.active(); h.context.setBusy(true);
  h.page.tiles = [h.node('Merchant 5% cash back Add offer', { 'data-testid': 'commerce-tile' })];
  const result = h.api.clickOneOffer(1000);
  const check = assert.rejects(result, { name: 'AbortError' });
  h.api.stopRun(); await h.tick(); await check;
  assert.equal(h.navigations.length, 0);
});

test('Stop during post-click delay prevents automatic return navigation', async () => {
  const h = harness(); h.hub(); h.active(); h.context.setBusy(true);
  h.page.tiles = [h.node('Merchant 5% cash back Add offer', { 'data-testid': 'commerce-tile' })];
  const result = h.api.clickOneOffer(1000);
  const check = assert.rejects(result, { name: 'AbortError' });
  await h.tick(); h.location.href = 'https://secure.chase.com/#/offer-details';
  h.api.stopRun(); await h.tick(); await check;
  assert.deepEqual(h.navigations, ['click']);
});

test('queued timer cannot start after Stop', async () => {
  const h = harness(); h.active(); h.api.runActiveProcess(100); h.api.stopRun();
  await h.tick(); assert.equal(h.navigations.length, 0);
});

test('stopped snapshot cannot advance the queue', () => {
  const h = harness(); h.active({ allCards: true, accountIds: ['1111', '2222'] });
  const old = h.api.getState(); h.api.stopRun(); h.api.finishCurrentAccount(old);
  assert.equal(h.navigations.length, 0);
  assert.equal(h.api.getState().phase, 'stopped');
});

test('hub redirect preserves refresh-verification phase', () => {
  const h = harness(); h.active({ phase: 'verify-after-refresh' });
  h.api.ensureOnHubForState(h.api.getState());
  assert.equal(h.api.getState().phase, 'verify-after-refresh');
});

test('offers heading alone is not ready and loading timeout stops without reload', async () => {
  const h = harness(); h.hub(); h.active();
  const result = h.api.processCurrentPage();
  for (let i = 0; i < 65; i++) await h.tick();
  await result;
  assert.equal(h.api.getState().phase, 'load-timeout');
  assert.equal(h.navigations.length, 0);
});

test('missing account ID is never accepted as a matching hub', async () => {
  const h = harness(); h.hub(''); h.active(); h.page.ready = true;
  const result = h.api.waitForHubReady('1111', 1000);
  await h.tick(); await h.tick();
  assert.equal(await result, false);
});

test('fresh empty loaded offers page verifies and completes normally', async () => {
  const h = harness(); h.hub(); h.active({ phase: 'verify-after-refresh' }); h.page.ready = true;
  const result = h.api.resumeAfterRefresh();
  await Promise.resolve(); await h.tick(); await result;
  assert.equal(h.api.getState().phase, 'done');
  assert.equal(h.navigations.length, 0);
});

test('new start is refused until previous worker has unwound', () => {
  const h = harness(); h.hub(); h.context.setBusy(true); h.api.startRun();
  assert.equal(h.api.getState().active, false);
  assert.equal(h.navigations.length, 0);
});

test('opening an already logged-in page never resumes a saved run', () => {
  const h = harness(); h.active(); h.api.boot();
  assert.equal(h.api.getState().phase, 'idle');
  assert.equal(h.api.getState().active, false);
  assert.equal(h.navigations.length, 0);
});

test('script navigation has a one-use resume permit', () => {
  const h = harness(); h.active({ phase: 'verify-after-refresh' }); h.api.armResume();
  h.api.boot();
  assert.equal(h.api.getState().active, true);
  h.api.boot();
  assert.equal(h.api.getState().active, false);
  assert.equal(h.api.getState().phase, 'idle');
});
