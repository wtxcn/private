const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { startServer } = require('../local-offer-server/server.cjs');

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
