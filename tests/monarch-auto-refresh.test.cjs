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
    setAttribute(name, value) { attrs[name] = value; },
    addEventListener(name, callback) { this[name] = callback; },
    matches(selector) { return selector === ':disabled' && !!options.disabled; },
    closest() { return options.inert ? {} : null; },
    getClientRects() { return options.hidden ? [] : [{ width: 150, height: 40 }]; },
    click() { this.clicks++; if (options.throwOnClick) throw new Error('click failed'); },
  };
}

function environment(iso, options = {}) {
  const state = { now: Date.parse(iso), buttons: options.buttons || [button()], modals: [],
    path: options.path || '/accounts', online: true, events: {}, logs: [], menu: null, tick: null,
    attrs: {}, widgets: [], alerts: [] };
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
      documentElement: {
        setAttribute: (name, value) => { state.attrs[name] = value; },
        getAttribute: name => state.attrs[name] ?? null,
      },
      body: { appendChild(element) { element.isConnected = true; state.widgets.push(element); } },
      createElement: () => button({ name: '' }),
      querySelectorAll: selector => selector.startsWith('button') ? [...state.buttons, ...state.widgets] : state.modals,
      addEventListener: (name, fn) => { state.events[name] = fn; },
    },
    window: { addEventListener: (name, fn) => { state.events[name] = fn; } },
    getComputedStyle: element => element.style,
    setInterval: fn => { state.tick = fn; },
    GM_registerMenuCommand: (name, fn) => { state.menu = fn; }, alert: value => state.alerts.push(value),
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

  const prefix = 'data-monarch-auto-refresh-';
  const transaction = environment('2026-11-08T19:59:00Z', { path: '/transactions' });
  await flush();
  check(transaction.state.attrs[prefix + 'version'], '1.0.3', 'diagnostics exposes current version');
  check(transaction.state.attrs[prefix + 'page'], 'other', 'non-account route is observable');
  check(transaction.state.attrs[prefix + 'page-status'].includes('本页不执行'), true, 'non-account explanation is explicit');
  check(transaction.state.attrs[prefix + 'status'].includes('Accounts'), true, 'non-account status explains required page');
  check(transaction.state.attrs[prefix + 'last-check'], '2026-11-08T19:59:00.000Z', 'startup check is timestamped');
  check(transaction.state.attrs[prefix + 'last-attempt'], 'null', 'no attempt is exposed on a skipped page');
  check(transaction.state.widgets.length, 1, 'one small status button is attached');
  const widget = transaction.state.widgets[0];
  check(widget.textContent.includes('本页不执行（仅 Accounts）'), true, 'status button explains non-account route');
  check(widget.textContent.includes('暂无脚本尝试'), true, 'status button exposes lack of attempt');
  check(widget.textContent.includes('2026-11-08 14:00'), true, 'status button shows next Chicago schedule');
  widget.click();
  check(transaction.state.alerts.length, 1, 'status button opens diagnostics');
  check(transaction.clicks(), 0, 'viewing diagnostics never refreshes accounts');
  await transaction.at('2026-11-08T19:59:15Z');
  check(transaction.state.attrs[prefix + 'last-check'], '2026-11-08T19:59:15.000Z', 'non-account ticks still update last check');
  check(transaction.state.widgets.length, 1, 'status button is reused across ticks');
  await transaction.at('2026-11-08T20:00:00Z');
  check(transaction.clicks(), 0, '14:00 cannot refresh a transactions page');
  check(transaction.state.attrs[prefix + 'next-schedule'].includes('14:00（中部，当前窗口）'), true,
    'an unattempted current window remains visible');
  transaction.state.path = '/accounts';
  await transaction.at('2026-11-08T20:01:00Z');
  check(transaction.clicks(), 1, 'accounts route still executes inside original grace window');
  check(transaction.state.attrs[prefix + 'page'], 'accounts', 'route changes update page state');
  const recorded = JSON.parse(transaction.state.attrs[prefix + 'last-attempt']);
  check(recorded.slot, 'America/Chicago:2026-11-08T14:00', 'DOM record exposes actual attempted slot');
  check(recorded.status, 'clicked', 'DOM record is updated after native click');
  check(widget.textContent.includes('已调用点击'), true, 'status button distinguishes click from server success');
  check(widget.textContent.includes('2026-11-08 17:00'), true, 'next schedule advances after scheduled hour');
  await transaction.at('2026-11-08T20:02:00Z');
  check(transaction.clicks(), 1, 'diagnostic updates preserve same-slot deduplication');
  transaction.state.path = '/transactions';
  await transaction.at('2026-11-08T23:00:00Z');
  check(transaction.clicks(), 1, 'navigating away still prevents the next planned refresh');
  check(transaction.state.attrs[prefix + 'last-attempt'], JSON.stringify(recorded), 'non-account diagnostics retain attempt record');
  const rollover = environment('2026-11-09T05:59:00Z', { path: '/transactions' });
  await flush();
  check(rollover.state.attrs[prefix + 'next-schedule'], '2026-11-09 05:00（中部）', 'next schedule rolls to next Chicago date');
  check(JSON.parse(failed.state.attrs[prefix + 'last-attempt']).status, 'attempted', 'failed click remains an attempt, not success');
  console.log(`PASS: ${assertions} checks; no real browser clicks or network requests.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
