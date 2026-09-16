const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
    assert.match(page, /Private VPN dashboard/);
    const styles = await fetch(`${base}/styles.css`).then(response => response.text());
    assert.match(styles, /\.access\[hidden\].*display:\s*none/);
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
