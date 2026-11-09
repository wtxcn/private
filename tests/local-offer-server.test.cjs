const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { startServer } = require('../local-offer-server/server.cjs');

test('server preserves per-card scan ages instead of the latest bank timestamp', () => {
  const { sanitizeData } = require('../local-offer-server/server.cjs');
  const data = sanitizeData({ snapshots: { chase: { bank: 'chase', scannedAt: 200,
    cards: [{ id: 'a', name: 'Card A', scannedAt: 100 }, { id: 'b', name: 'Card B', scannedAt: 200 }], offers: [] } } });
  assert.deepEqual(data.snapshots.chase.cards.map(card => card.scannedAt), [100, 200]);
});

test('bank-synced redemption stays scoped to its card and campaign through stale sync and restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-offers-redeemed-'));
  let running = await startServer({ host: '127.0.0.1', port: 0, dataDir });
  let base = `http://127.0.0.1:${running.port}`;
  const { writeToken, readToken } = await fetch(`${base}/api/pair`).then(response => response.json());
  const campaign = 'amex|nordstrom|spend $200, get $50 back|2026-12-31';
  const nextCampaign = 'amex|nordstrom|spend $200, get $50 back|2027-12-31';
  const source = { updatedAt: 123, snapshots: { amex: { bank: 'amex', scannedAt: 123,
    cards: [{ id: 'a', name: 'Card A' }, { id: 'b', name: 'Card B' }],
    offers: [
      { key: campaign, name: 'Nordstrom', description: 'Spend $200, get $50 back Expires 12/31/2026', cards: { a: 'redeemed', b: 'added' }, manualStatuses: { b: 'redeemed' } },
      { key: nextCampaign, name: 'Nordstrom', description: 'Spend $200, get $50 back Expires 12/31/2027', cards: { a: 'added' } }
    ]
  } } };
  const request = (route, body, token = writeToken) => fetch(`${base}${route}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const read = () => fetch(`${base}/api/data`, { headers: { Authorization: `Bearer ${readToken}` } }).then(response => response.json());
  const close = () => Promise.all(running.servers.map(server => new Promise(resolve => server.close(resolve))));
  try {
    assert.equal((await request('/api/sync', source, readToken)).status, 401);
    assert.equal((await request('/api/sync', source, 'invalid-key')).status, 401);
    assert.deepEqual((await read()).snapshots, {});
    assert.equal((await request('/api/sync', source)).status, 200);
    assert.equal((await fetch(`${base}/api/data`)).status, 401);
    assert.equal((await fetch(`${base}/api/data`, { headers: { Authorization: `Bearer ${writeToken}` } })).status, 401);
    assert.deepEqual((await read()).snapshots.amex.offers.find(item => item.key === campaign).cards, { a: 'redeemed', b: 'added' });
    // An obsolete manual status file and endpoint cannot affect synced bank data.
    fs.writeFileSync(path.join(dataDir, 'status-overrides.json'), JSON.stringify({ version: 1, overrides: [
      { bank: 'amex', offerKey: campaign, cardId: 'b', status: 'redeemed' }
    ] }));
    assert.equal((await request('/api/status', { bank: 'amex', offerKey: campaign, cardId: 'b', status: 'redeemed' })).status, 404);
    source.snapshots.amex.offers[0].cards.a = 'added';
    assert.equal((await request('/api/sync', source)).status, 200);
    await close();
    running = await startServer({ host: '127.0.0.1', port: 0, dataDir });
    base = `http://127.0.0.1:${running.port}`;
    const data = await read();
    const current = data.snapshots.amex.offers.find(item => item.key === campaign);
    assert.deepEqual(current.cards, { a: 'redeemed', b: 'added' });
    assert.equal(current.manualStatuses, undefined);
    assert.equal(data.snapshots.amex.offers.find(item => item.key === nextCampaign).cards.a, 'added');
    assert.equal(data.updatedAt, 123, 'preserving redemption must retain the source scan timestamp');
  } finally {
    await close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('dashboard displays and filters bank-synced redeemed offers without write capability', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../local-offer-server/public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../local-offer-server/public/app.js'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:8787/?token=read-key', runScripts: 'outside-only' });
  const data = { snapshots: { amex: { bank: 'amex', cards: [{ id: 'a', name: 'Card A' }, { id: 'b', name: 'Card B' }],
    offers: [{ key: 'campaign', name: 'Nordstrom', description: '$200 / $50', cards: { a: 'redeemed', b: 'added' } }] } } };
  const requests = [];
  dom.window.fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' });
    assert.equal(url, '/api/data');
    assert.equal(options.method || 'GET', 'GET');
    assert.equal(options.headers.Authorization, 'Bearer read-key');
    return { ok: true, json: async () => structuredClone(data) };
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    dom.window.eval(app);
    await settle();
    const document = dom.window.document;
    assert.equal(document.querySelectorAll('.table-row').length, 2);
    assert.equal(document.querySelector('.status.redeemed').textContent, 'redeemed');
    assert.equal(document.querySelectorAll('.table-row button').length, 0);
    const redeemedFilter = [...document.querySelectorAll('#status-filters button')].find(button => button.textContent === 'Redeemed');
    redeemedFilter.click();
    assert.equal(document.querySelectorAll('.table-row').length, 1);
    assert.match(document.querySelector('.table-row').textContent, /Card A/);
    assert.doesNotMatch(document.querySelector('.table-row').textContent, /Card B/);
    const addedFilter = [...document.querySelectorAll('#status-filters button')].find(button => button.textContent === 'Added');
    addedFilter.click();
    assert.equal(document.querySelectorAll('.table-row').length, 1);
    assert.match(document.querySelector('.table-row').textContent, /Card B/);
    document.getElementById('refresh').click();
    await settle();
    assert.deepEqual(requests, [{ url: '/api/data', method: 'GET' }, { url: '/api/data', method: 'GET' }]);
  } finally {
    dom.window.close();
  }
});

test('local Offer Server pairs only locally, sanitizes uploads and protects reads', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-offers-server-'));
  const { servers, port } = await startServer({ host: '127.0.0.1', port: 0, dataDir });
  const base = `http://127.0.0.1:${port}`;
  try {
    const pairing = await fetch(`${base}/api/pair`).then(response => response.json());
    assert.ok(pairing.writeToken);
    assert.ok(pairing.readToken);
    const source = {
      version: 2,
      snapshots: {
        chase: {
          bank: 'chase',
          cards: [{ id: 'chase:hash', name: 'Freedom 123456789' }],
          offers: [{ key: 'cvs', name: 'CVS', description: '$10 back', cards: { 'chase:hash': 'addable' }, logs: ['private'] }],
          scannedAt: 1234,
          cookies: 'secret'
        }
      },
      selected: { secret: true }
    };
    const syncResponse = await fetch(`${base}/api/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pairing.writeToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(source)
    });
    assert.equal(syncResponse.status, 200);
    assert.equal((await fetch(`${base}/api/data`)).status, 401);
    const dataResponse = await fetch(`${base}/api/data`, { headers: { Authorization: `Bearer ${pairing.readToken}` } });
    assert.equal(dataResponse.status, 200);
    const text = await dataResponse.text();
    assert.match(text, /CVS/);
    assert.match(text, /\.\.\.6789/);
    assert.doesNotMatch(text, /123456789|private|cookies|selected/);
    const page = await fetch(base).then(response => response.text());
    assert.match(page, /Private local view by bank and card/);
    assert.match(page, /class="sidebar"/);
    assert.match(page, /id="results"/);
    const styles = await fetch(`${base}/styles.css`).then(response => response.text());
    assert.match(styles, /\.access\[hidden\].*display:\s*none/);
    assert.match(styles, /grid-template-columns:\s*230px minmax\(0, 1fr\)/);
    const app = await fetch(`${base}/app.js`).then(response => response.text());
    assert.match(app, /function grouped\(items\)/);
    assert.match(app, /result-group/);
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('VPN dashboard search ignores card names and card-ending digits', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../local-offer-server/public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../local-offer-server/public/app.js'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:8787/?token=read-key', runScripts: 'outside-only', pretendToBeVisual: true });
  const data = { version: 2, updatedAt: Date.now(), snapshots: {
    amex: {
      bank: 'amex',
      cards: [{ id: 'amex:marriott', name: 'Marriott Bonvoy Brilliant Card (...11008)' }],
      offers: [
        { key: 'empire', name: 'Empire Today', description: 'Spend $750, get $150 back', cards: { 'amex:marriott': 'addable' } },
        { key: 'city-marriott', name: 'City Express by Marriott', description: 'Spend $500, get $100 back', cards: { 'amex:marriott': 'addable' } }
      ],
      scannedAt: Date.now()
    }
  } };
  dom.window.fetch = async () => ({ ok: true, json: async () => data });
  dom.window.eval(app);
  await new Promise(resolve => setImmediate(resolve));
  const input = dom.window.document.getElementById('search');
  input.value = 'marriott';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.match(dom.window.document.getElementById('results').textContent, /City Express by Marriott/);
  assert.doesNotMatch(dom.window.document.getElementById('results').textContent, /Empire Today/);
  input.value = '11008';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(dom.window.document.querySelectorAll('.result-group').length, 0);
  dom.window.close();
});

test('an unavailable VPN keeps loopback online and retries only the configured address', async t => {
  const http = require('node:http');
  const originalListen = http.Server.prototype.listen;
  const attempts = [];
  let recovered = false;
  t.mock.method(http.Server.prototype, 'listen', function (port, host, callback) {
    attempts.push({ host, port });
    if (host === '192.0.2.1') {
      if (!recovered) {
        process.nextTick(() => this.emit('error', Object.assign(new Error('VPN offline'), { code: 'EADDRNOTAVAIL' })));
        return this;
      }
      // Simulate the configured VPN returning with a second loopback listener.
      return originalListen.call(this, 0, '127.0.0.1', callback);
    }
    return originalListen.call(this, port, host, callback);
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-offers-offline-vpn-'));
  const { servers, port } = await startServer({ host: '127.0.0.1', vpnHost: '192.0.2.1', port: 0, dataDir, vpnRetryMs: 10 });
  try {
    assert.equal(servers[0].listening, true);
    assert.equal(servers[1].listening, false);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/data`)).status, 401);
    recovered = true;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('VPN did not reconnect')), 1000);
      servers[1].once('listening', () => { clearTimeout(timeout); resolve(); });
    });
    assert.equal(servers[1].listening, true);
    assert.ok(attempts.slice(1).every(attempt => attempt.host === '192.0.2.1' && attempt.port === port));
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  const count = attempts.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(attempts.length, count);
});
