const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('YouTubeHighestQuality.user.js', 'utf8')
  .replace('  wake();\n})();', '  window.testHooks = { tick, highestOption, qualityValue, onInteraction };\n  wake();\n})();');

function fixture(labels = ['360p', '2160p60 4K', '1080p60 HD']) {
  let now = 10000;
  let expanded = false;
  let mode = 'main';
  let openCount = 0;
  const selected = [];
  const notices = [];
  const flags = new Set();
  const location = { href: 'https://www.youtube.com/watch?v=test-a' };
  const classes = new Set();
  const video = { readyState: 4 };
  const visibleNode = () => ({ isConnected: true, getClientRects: () => [1] });
  const items = labels.map(text => {
    const attributes = new Map([['aria-checked', 'false']]);
    return {
      ...visibleNode(), textContent: text,
      classList: { contains: name => classes.has(`${text}:${name}`) },
      getAttribute: key => attributes.get(key) || null,
      hasAttribute: key => attributes.has(key),
      setAttribute: (key, value) => attributes.set(key, value),
      click() {
        items.forEach(item => item.setAttribute('aria-checked', 'false'));
        attributes.set('aria-checked', 'true');
        selected.push(text);
        expanded = false;
      }
    };
  });
  const settings = {
    ...visibleNode(),
    getAttribute: key => key === 'aria-expanded' ? String(expanded) : key === 'aria-controls' ? 'panel' : null,
    click() { expanded = !expanded; mode = 'main'; if (expanded) openCount++; }
  };
  const row = {
    ...visibleNode(),
    querySelector: () => ({ textContent: 'Quality' }),
    click() { mode = 'quality'; }
  };
  const panel = {
    ...visibleNode(),
    querySelectorAll: selector => selector === '.ytp-menuitem' && mode === 'main' ? [row] :
      selector === '[role="menuitemradio"]' && mode === 'quality' ? items : []
  };
  const player = {
    ...visibleNode(),
    classList: { contains: name => flags.has(name) },
    contains: () => false,
    querySelector: selector => selector === 'video' ? video : selector === '.ytp-settings-button' ? settings : null
  };
  const noticeMap = new Map();
  const document = {
    hidden: false, activeElement: null,
    documentElement: { append(el) { noticeMap.set(el.id, el); notices.push(el); } },
    getElementById: id => id === 'movie_player' ? player : id === 'panel' && expanded ? panel : noticeMap.get(id),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    createElement: () => ({ style: {}, setAttribute() {}, remove() { noticeMap.delete(this.id); } })
  };
  const window = { addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({
    window, document, location, URL, getComputedStyle: () => ({ visibility: 'visible' }),
    Date: class extends Date { static now() { return now; } },
    setInterval: () => 1, clearInterval() {},
    setTimeout: () => 2, clearTimeout() {},
    console: { info() {}, warn() {} }
  });
  vm.runInContext(source, context);
  return {
    hooks: window.testHooks, flags, classes, items, row, location, selected, notices, document,
    advance(ms = 1200) { now += ms; },
    setExpanded(value) { expanded = value; },
    openCount: () => openCount,
    expanded: () => expanded,
    stop: () => window.__youtubeHighestQualityLocal.stop()
  };
}

test('selects highest numeric resolution rather than first row or lexical order', async () => {
  const f = fixture(['720p60', '1080p60', '4320p60 8K', '2160p60 4K', 'Auto']);
  f.advance(); await f.hooks.tick();
  assert.deepEqual(f.selected, ['4320p60 8K']);
  assert.equal(f.expanded(), false);
  assert.match(f.notices[0].textContent, /4320p60/);
});

test('same resolution prefers higher frame rate and ignores upgrade/disabled options', async () => {
  const f = fixture(['1080p Premium Enhanced bitrate', '2160p60', '1440p30', '1440p60', 'Auto']);
  f.items[1].setAttribute('aria-disabled', 'true');
  f.advance(); await f.hooks.tick();
  assert.deepEqual(f.selected, ['1440p60']);
});

test('preserves an already-open user menu and does not touch ad playback', async () => {
  const f = fixture();
  f.setExpanded(true); f.advance(); await f.hooks.tick();
  assert.equal(f.openCount(), 0);
  assert.equal(f.expanded(), true);
  f.setExpanded(false); f.flags.add('ad-showing'); f.advance(2500); await f.hooks.tick();
  assert.equal(f.openCount(), 0);
  assert.deepEqual(f.selected, []);
});

test('cancels the old video selection after SPA navigation during menu opening', async () => {
  const f = fixture();
  f.row.click = () => { f.location.href = 'https://www.youtube.com/watch?v=test-b'; };
  f.advance(); await f.hooks.tick();
  assert.deepEqual(f.selected, []);
});

test('does not continue selecting or closing a menu after user interaction', async () => {
  const f = fixture();
  f.row.click = () => f.hooks.onInteraction({ isTrusted: true });
  f.advance(); await f.hooks.tick();
  assert.deepEqual(f.selected, []);
  assert.equal(f.expanded(), true);
});

test('user cancellations do not exhaust the failure budget', async () => {
  const f = fixture();
  const openQuality = f.row.click;
  f.row.click = () => f.hooks.onInteraction({ isTrusted: true });
  for (let i = 0; i < 7; i++) {
    f.setExpanded(false); f.advance(5000); await f.hooks.tick();
  }
  f.setExpanded(false); f.row.click = openQuality;
  f.advance(5000); await f.hooks.tick();
  assert.deepEqual(f.selected, ['2160p60 4K']);
});

test('limits automatic menu checks to three per video and restarts for the next video', async () => {
  const f = fixture();
  f.advance(); await f.hooks.tick();
  f.advance(9000); await f.hooks.tick();
  f.advance(26000); await f.hooks.tick();
  f.advance(60000); await f.hooks.tick();
  assert.equal(f.openCount(), 3);
  f.location.href = 'https://www.youtube.com/watch?v=test-b';
  await f.hooks.tick(); f.advance(); await f.hooks.tick();
  assert.equal(f.openCount(), 4);
});

test('stopping the instance prevents future selections', async () => {
  const f = fixture(); f.stop(); f.advance(); await f.hooks.tick();
  assert.equal(f.openCount(), 0);
});
