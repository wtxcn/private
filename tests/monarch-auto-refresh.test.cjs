const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'MonarchAutoRefresher.user.js'), 'utf8');
let assertions = 0;
const check = (actual, expected, message) => { assert.equal(actual, expected, message); assertions++; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function button(options = {}) {
  const attrs = options.attrs || {};
  return {
    innerText: options.name ?? 'Refresh all', textContent: options.name ?? 'Refresh all',
    clicks: 0, style: options.style || { display: 'block', visibility: 'visible' },
    getAttribute(name) { return attrs[name] ?? null; },
    matches(selector) { return selector === ':disabled' && !!options.disabled; },
    closest() { return options.inert ? {} : null; },
    getClientRects() { return options.hidden ? [] : [{ width: 150, height: 40 }]; },
    click() { this.clicks++; if (options.throwOnClick) throw new Error('click failed'); },
  };
}

function environment(iso, options = {}) {
  const state = { now: Date.parse(iso), buttons: options.buttons || [button()], modals: [],
    path: options.path || '/accounts', online: true, events: {}, logs: [], menu: null, tick: null };
  const shared = options.shared || { storage: new Map(), locked: false };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [state.now])); }
    static now() { return state.now; }
  }
  const context = {
    Date: FakeDate, Intl, console: { info: (...items) => state.logs.push(items.join(' ')) },
    location: { get pathname() { return state.path; } },
    navigator: {
      get onLine() { return state.online; },
      locks: options.noLocks ? null : { async request(name, config, callback) {
        if (shared.locked) return callback(null);
        shared.locked = true;
        try { return await callback({ name }); } finally { shared.locked = false; }
      } },
    },
    localStorage: {
      getItem: key => shared.storage.get(key) ?? null,
      setItem: (key, value) => { if (options.storageFails) throw new Error('storage denied'); shared.storage.set(key, value); },
    },
    document: {
      documentElement: { setAttribute() {} },
      querySelectorAll: selector => selector.startsWith('button') ? state.buttons : state.modals,
      addEventListener: (name, fn) => { state.events[name] = fn; },
    },
    window: { addEventListener: (name, fn) => { state.events[name] = fn; } },
    getComputedStyle: element => element.style,
    setInterval: fn => { state.tick = fn; },
    GM_registerMenuCommand: (name, fn) => { state.menu = fn; }, alert: () => {},
  };
  vm.runInNewContext(source, context);
  return { ...state, state, shared, clicks: () => state.buttons.reduce((sum, b) => sum + b.clicks, 0),
    async at(iso) { state.now = Date.parse(iso); await state.tick(); await flush(); } };
}

(async () => {
  // America/Chicago is UTC-6 in November and UTC-5 in July.
  for (const hour of [5, 8, 11, 14, 17, 20, 23]) {
    for (const [day, offset] of [['2026-11-08', 6], ['2026-07-08', 5]]) {
      const timestamp = Date.parse(`${day}T00:00:00Z`) + (hour + offset) * 3_600_000;
      const env = environment(new Date(timestamp).toISOString());
      await flush(); check(env.clicks(), 1, `${day} ${hour}:00 central`);
      await env.state.tick(); check(env.clicks(), 1, 'same slot cannot click again');
    }
  }
  for (const iso of ['2026-11-08T08:00:00Z', '2026-11-08T10:59:59Z',
    '2026-11-08T11:10:00Z', '2026-11-08T12:00:00Z', '2026-11-09T06:00:00Z']) {
    const env = environment(iso); await flush(); check(env.clicks(), 0, `not due ${iso}`);
  }
  const late = environment('2026-11-08T11:09:59Z'); await flush(); check(late.clicks(), 1, 'within grace');
  const icon = environment('2026-11-08T11:00:00Z', { buttons: [button({ name: '\uf15c\nRefresh all' })] });
  await flush(); check(icon.clicks(), 1, 'actual Monarch icon font does not change button name');
  const wake = environment('2026-11-08T10:00:00Z'); await flush();
  await wake.at('2026-11-08T20:30:00Z'); check(wake.clicks(), 0, 'no catch-up after sleep');
  await wake.at('2026-11-08T23:00:00Z'); check(wake.clicks(), 1, 'next scheduled slot executes');
  await wake.at('2026-11-09T11:00:00Z'); check(wake.clicks(), 2, 'new day executes');

  const shared = { storage: new Map(), locked: false };
  const a = environment('2026-11-08T11:00:00Z', { shared });
  const b = environment('2026-11-08T11:00:00Z', { shared });
  await flush(); check(a.clicks() + b.clicks(), 1, 'two tabs execute once');
  const reload = environment('2026-11-08T11:01:00Z', { shared });
  await flush(); check(reload.clicks(), 0, 'reload does not click again');

  for (const buttons of [[], [button({ name: 'Refresh' })], [button({ hidden: true })],
    [button({ disabled: true })], [button({ attrs: { 'aria-disabled': 'true' } })],
    [button({ attrs: { 'aria-busy': 'true' } })], [button({ inert: true })],
    [button(), button()], [button({ style: { display: 'block', visibility: 'hidden' } })]]) {
    const env = environment('2026-11-08T11:00:00Z', { buttons });
    await flush(); check(env.clicks(), 0, 'reject absent/disabled/ambiguous button');
  }
  for (const options of [{ path: '/dashboard' }, { path: '/accounts/details/123' },
    { noLocks: true }, { storageFails: true }]) {
    const env = environment('2026-11-08T11:00:00Z', options);
    await flush(); check(env.clicks(), 0, 'route or safe coordination unavailable');
  }
  const offline = environment('2026-11-08T10:59:00Z'); await flush();
  offline.state.online = false;
  await offline.at('2026-11-08T11:00:00Z'); check(offline.clicks(), 0, 'offline');
  offline.state.online = true;
  await offline.at('2026-11-08T11:01:00Z'); check(offline.clicks(), 1, 'network returns within window');
  const modal = environment('2026-11-08T10:59:00Z'); await flush();
  modal.state.modals = [button()];
  await modal.at('2026-11-08T11:00:00Z'); check(modal.clicks(), 0, 'modal blocks click');

  const failed = environment('2026-11-08T11:00:00Z', { buttons: [button({ throwOnClick: true })] });
  await flush(); await failed.at('2026-11-08T11:01:00Z');
  check(failed.clicks(), 1, 'failed attempt does not repeat');
  const corrupt = { storage: new Map([['monarch-auto-refresh:last-attempt:v1', '{bad']]), locked: false };
  const invalid = environment('2026-11-08T11:00:00Z', { shared: corrupt });
  await flush(); check(invalid.clicks(), 0, 'corrupt record fails closed');
  console.log(`PASS: ${assertions} checks; no real browser clicks or network requests.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
