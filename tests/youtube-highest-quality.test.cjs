const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('YouTubeHighestQuality.user.js', 'utf8')
  .replace('  wake();\n})();', '  window.testHooks = { tick, highestOption, qualityValue, onInteraction };\n  wake();\n})();');

function fixture(labels = ['360p', '2160p60 4K', '1080p60 HD'], behavior = {}) {
  let now = 10000;
  let expanded = false;
  let mode = 'main';
  let openCount = 0;
  let qualityOpenCount = 0;
  let generation = 0;
  let currentQuality = behavior.initialQuality || 'Auto (360p)';
  let panel;
  let row;
  let items;
  let summary;
  const detached = [];
  const selected = [];
  const notices = [];
  const messages = [];
  const flags = new Set();
  const location = { href: 'https://www.youtube.com/watch?v=test-a' };
  const classes = new Set();
  const video = { readyState: 4 };
  const visibleNode = () => ({ isConnected: true, getClientRects() { return this.isConnected ? [1] : []; } });

  function rebuildMenu(nextMode) {
    if (panel) {
      detached.push({ panel, row, items });
      for (const el of [panel, row, ...items]) el.isConnected = false;
    }
    mode = nextMode;
    generation++;
    summary = { textContent: currentQuality };
    const menuSummary = summary;
    const menuItems = labels.map(text => {
      const attributes = new Map([['aria-checked', String(text === currentQuality)]]);
      const item = {
        ...visibleNode(), textContent: text,
        getClientRects() { return this.isConnected && expanded && mode === 'quality' ? [1] : []; },
        classList: { contains: name => classes.has(text + ':' + name) },
        getAttribute: key => attributes.get(key) || null,
        hasAttribute: key => attributes.has(key),
        setAttribute: (key, value) => attributes.set(key, value),
        click() {
          selected.push(text);
          if (!behavior.ignoreSelection) currentQuality = text;
          if (!behavior.rebuildOnSelect) {
            menuItems.forEach(option => option.setAttribute('aria-checked', String(option.textContent === currentQuality)));
            menuSummary.textContent = currentQuality;
          } else if (behavior.staleClickedChecked) {
            // A detached node may retain an optimistic checked state while the live UI rejects it.
            attributes.set('aria-checked', 'true');
          }
          expanded = false;
          if (behavior.rebuildOnSelect) rebuildMenu('main');
        }
      };
      return item;
    });
    items = menuItems;
    row = {
      ...visibleNode(),
      getClientRects() { return this.isConnected && expanded && mode === 'main' ? [1] : []; },
      querySelector: selector => selector === '.ytp-menuitem-label' ? { textContent: 'Quality' } :
        selector === '.ytp-menuitem-content' ? menuSummary : null,
      click() {
        qualityOpenCount++;
        if (behavior.rebuildOnQuality) rebuildMenu('quality');
        else mode = 'quality';
      }
    };
    const menuRow = row;
    panel = {
      ...visibleNode(), id: 'panel-' + generation,
      getClientRects() { return this.isConnected && expanded ? [1] : []; },
      querySelectorAll: selector => selector === '.ytp-menuitem' && mode === 'main' ? [menuRow] :
        selector === '[role="menuitemradio"]' && mode === 'quality' ? menuItems : []
    };
  }

  rebuildMenu('main');
  const settings = {
    ...visibleNode(),
    getAttribute: key => key === 'aria-expanded' ? String(expanded) :
      key === 'aria-controls' ? (behavior.noAriaControls ? null : panel.id) : null,
    click() {
      expanded = !expanded;
      if (expanded) {
        openCount++;
        if (behavior.rebuildOnOpen) rebuildMenu('main');
        else { mode = 'main'; summary.textContent = currentQuality; }
      }
    }
  };
  const player = {
    ...visibleNode(),
    classList: { contains: name => flags.has(name) },
    contains: () => false,
    querySelector: selector => selector === 'video' ? video :
      selector === '.ytp-settings-button' ? settings : selector === '.ytp-settings-menu' ? panel : null
  };
  const noticeMap = new Map();
  const rootAttributes = new Map();
  const document = {
    hidden: false, activeElement: null,
    documentElement: {
      setAttribute: (name, value) => rootAttributes.set(name, value),
      removeAttribute: name => rootAttributes.delete(name),
      append(el) { noticeMap.set(el.id, el); notices.push(el); }
    },
    getElementById: id => id === 'movie_player' ? player : id === panel.id ? panel : noticeMap.get(id),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    createElement: () => ({ style: {}, setAttribute() {}, remove() { noticeMap.delete(this.id); } })
  };
  const window = { addEventListener() {}, removeEventListener() {} };
  let timerId = 0;
  const cancelledTimers = new Set();
  const context = vm.createContext({
    window, document, location, URL, getComputedStyle: () => ({ visibility: 'visible' }),
    Date: class extends Date { static now() { return now; } },
    setInterval: () => 1, clearInterval() {},
    setTimeout(callback, delay) {
      const id = ++timerId;
      // Drive bounded menu waits without leaving unresolved promises on failure paths.
      if (delay <= 100) queueMicrotask(() => {
        if (!cancelledTimers.has(id)) { now += delay; callback(); }
      });
      return id;
    },
    clearTimeout: id => cancelledTimers.add(id),
    console: { info(...args) { messages.push(args); }, warn(...args) { messages.push(args); } }
  });
  vm.runInContext(source, context);
  return {
    hooks: window.testHooks, flags, classes,
    get items() { return items; }, get row() { return row; },
    location, selected, notices, messages, document, detached,
    advance(ms = 1200) { now += ms; },
    setExpanded(value) { expanded = value; },
    openCount: () => openCount,
    qualityOpenCount: () => qualityOpenCount,
    expanded: () => expanded,
    status: () => rootAttributes.get('data-youtube-highest-quality'),
    reason: () => rootAttributes.get('data-youtube-highest-quality-reason'),
    resolution: () => rootAttributes.get('data-youtube-highest-quality-resolution'),
    stop: () => window.__youtubeHighestQualityLocal.stop()
  };
}

test('selects highest numeric resolution rather than first row or lexical order', async () => {
  const f = fixture(['720p60', '1080p60', '4320p60 8K', '2160p60 4K', 'Auto']);
  f.advance(); await f.hooks.tick();
  assert.deepEqual(f.selected, ['4320p60 8K']);
  assert.equal(f.expanded(), false);
  assert.match(f.notices[0].textContent, /4320p60/);
  assert.equal(f.status(), 'selected');
  assert.equal(f.resolution(), '4320p60 8K');
});

test('ignores Auto options containing resolutions in English and Chinese', async () => {
  const f = fixture(['Auto (4320p60 8K)', '自动（4320p60）', '自動 (4320p60)', '2160p60 4K', '1080p60']);
  f.items[0].setAttribute('aria-checked', 'true');
  f.advance(); await f.hooks.tick();
  assert.deepEqual(f.selected, ['2160p60 4K']);
  assert.equal(f.status(), 'selected');
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
  assert.equal(f.reason(), 'menu-open');
  f.setExpanded(false); f.flags.add('ad-showing'); f.advance(2500); await f.hooks.tick();
  assert.equal(f.openCount(), 0);
  assert.deepEqual(f.selected, []);
  assert.equal(f.reason(), 'advertisement');
});

test('finds quality options and confirms after YouTube rebuilds menu DOM', async () => {
  const f = fixture(['360p', '2160p60 4K', 'Auto (2160p60 4K)'], {
    rebuildOnOpen: true, rebuildOnQuality: true, rebuildOnSelect: true, noAriaControls: true
  });
  f.advance(); await f.hooks.tick();
  assert.deepEqual(f.selected, ['2160p60 4K']);
  assert.equal(f.status(), 'selected');
  assert.equal(f.expanded(), false);
  assert.ok(f.openCount() >= 2, 'reopens the live main menu for confirmation');
  const clickedOldItem = f.detached.flatMap(menu => menu.items)
    .find(item => item.textContent === '2160p60 4K' && !item.isConnected);
  assert.equal(clickedOldItem.getAttribute('aria-checked'), 'false');
});

test('does not report success from a detached checked option when live menu stays Auto', async () => {
  const f = fixture(['2160p60 4K', 'Auto (2160p60 4K)'], {
    rebuildOnSelect: true, ignoreSelection: true, staleClickedChecked: true
  });
  f.advance(); await f.hooks.tick();
  assert.deepEqual(f.selected, ['2160p60 4K']);
  assert.equal(f.notices.length, 0);
  assert.equal(f.status(), 'error');
  assert.equal(f.reason(), 'selection-not-confirmed');
  assert.equal(f.expanded(), false);
});

test('accepts a fresh already-checked highest option without another click or menu reopening', async () => {
  const f = fixture(['2160p60 4K', '1080p60', 'Auto (2160p60 4K)'], {
    initialQuality: '2160p60 4K', rebuildOnOpen: true, rebuildOnQuality: true
  });
  f.advance(); await f.hooks.tick();
  assert.deepEqual(f.selected, [], 'does not click a quality that is already selected');
  assert.equal(f.openCount(), 1, 'does not reopen menus when the live highest option is already checked');
  assert.equal(f.qualityOpenCount(), 1);
  assert.equal(f.status(), 'selected');
  assert.equal(f.resolution(), '2160p60 4K');
  assert.equal(f.expanded(), false);
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
  assert.equal(f.reason(), 'user-interaction');
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

test('limits automatic quality checks to three per video and restarts for the next video', async () => {
  const f = fixture();
  f.advance(); await f.hooks.tick();
  f.advance(9000); await f.hooks.tick();
  f.advance(26000); await f.hooks.tick();
  f.advance(60000); await f.hooks.tick();
  assert.equal(f.qualityOpenCount(), 3);
  const previousOpenCount = f.openCount();
  f.location.href = 'https://www.youtube.com/watch?v=test-b';
  await f.hooks.tick(); f.advance(); await f.hooks.tick();
  assert.equal(f.qualityOpenCount(), 4);
  assert.equal(f.openCount(), previousOpenCount + 1);
});

test('reports startup and stopping without exposing browsing information', async () => {
  const f = fixture();
  assert.equal(f.status(), 'ready');
  assert.ok(f.messages.some(args => args.some(text => String(text).includes('v1.0.2'))));
  f.stop(); f.advance(); await f.hooks.tick();
  assert.equal(f.status(), 'stopped');
  assert.equal(f.resolution(), undefined);
  assert.equal(f.openCount(), 0);
});
