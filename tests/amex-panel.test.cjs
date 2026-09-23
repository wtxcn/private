const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('Amex starts collapsed and repeatedly restores without starting enrollment', () => {
  const dom = new JSDOM('', { url: 'https://global.americanexpress.com/', runScripts: 'outside-only' });
  const w = dom.window;
  w.setInterval = () => 0;
  w.eval(fs.readFileSync(path.join(__dirname, '../AmexNativeOfferClicker.user.js'), 'utf8'));
  const panel = w.document.querySelector('#amex-native-offer-clicker');
  assert.equal(panel.style.display, 'none');
  for (let i = 0; i < 3; i++) {
    assert.equal(w.document.querySelectorAll('[data-amex-restore]').length, 1);
    w.document.querySelector('[data-amex-restore]').click();
    assert.equal(panel.style.display, 'block');
    assert.equal(w.document.querySelectorAll('[data-amex-restore]').length, 0);
    panel.querySelector('[data-hide]').click();
    assert.equal(panel.style.display, 'none');
  }
  assert.notEqual(JSON.parse(w.localStorage.getItem('amexNativeOfferClickerState.v1') || '{}').active, true);
  dom.window.close();
});
