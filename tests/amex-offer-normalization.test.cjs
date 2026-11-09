const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAmexOffers } = require('../local-offer-server/amex-offers.cjs');
const { sanitizeData } = require('../local-offer-server/server.cjs');

const terms = 'Spend $250 or more, earn $25 back';
const offer = (key, description, card = 'a', status = 'addable') => ({ key, name: 'Best Buy', description, cards: { [card]: status } });

test('nine legacy text variants become three card placements, not nine offers', () => {
  const variants = [terms, `${terms} 12/31/2026 Add to Card`, `${terms} ${terms} Add to Card`,
    `${terms} Your offer has been added. Remember to use your enrolled Card. ${terms} Redeem Now Details`,
    `${terms} ${terms}`, `${terms} 12/31/2026 ${terms} 12/31/2026`,
    `${terms} 12/31/2026 Add to Card`, `${terms} ${terms} Add to Card`,
    `${terms} ${terms} Add to Card Details Earn a one-time $25 statement credit`];
  const input = variants.map((text, i) => offer(`old-${i}`, text, i === 0 ? 'a' : i < 6 ? 'b' : 'c'));
  const normalized = normalizeAmexOffers(input);
  assert.equal(normalized.length, 1);
  assert.deepEqual(Object.keys(normalized[0].cards), ['a', 'b', 'c']);
  assert.equal(normalized[0].cards.b, 'added');
  assert.equal(normalized[0].description, `${terms} Expires 12/31/2026`);
  assert.deepEqual(normalizeAmexOffers(normalized), normalized);
  assert.equal(input[3].cards.b, 'addable');
});

test('different amounts, merchants, limits, dates and ambiguous undated copies stay separate', () => {
  const input = [offer('1', `${terms} 12/31/2026`), offer('2', `${terms} 11/30/2026`), offer('3', terms),
    offer('4', 'Spend $500 or more, earn $50 back 12/31/2026'),
    offer('5', `${terms}, up to 2 times 12/31/2026`), { ...offer('6', `${terms} 12/31/2026`), name: 'Other merchant' }];
  assert.equal(normalizeAmexOffers(input).length, 6);
  assert.equal(normalizeAmexOffers([offer('x', 'A special offer'), offer('y', 'A special offer')]).length, 2);
  assert.deepEqual(normalizeAmexOffers(normalizeAmexOffers(input)), normalizeAmexOffers(input));
});

test('server repairs existing Amex snapshots on read without touching other banks', () => {
  const offers = [offer('old1', terms), offer('old2', `${terms} ${terms} Add to Card`)];
  const snapshot = { scannedAt: 100, cards: [{ id: 'a', name: 'Test card' }], offers };
  const data = sanitizeData({ snapshots: { amex: snapshot, chase: snapshot } });
  assert.equal(data.snapshots.amex.offers.length, 1);
  assert.equal(data.snapshots.chase.offers.length, 2);
});

test('cash amounts and percentages are never interchangeable', () => {
  const input = [offer('cash', 'Get $10 back'), offer('percent', 'Get 10% back'),
    offer('small', 'Get $1.50 back'), offer('large', 'Get $150 back')];
  assert.equal(normalizeAmexOffers(input).length, 4);
});

test('redeemed is terminal for the same campaign and card, regardless of input order', () => {
  const added = offer('added', `${terms} Expires 12/31/2026 Your offer has been added`, 'a', 'added');
  const redeemed = offer('redeemed', `${terms} Expires 12/31/2026 Your offer has been added`, 'a', 'redeemed');
  const otherCard = offer('other-card', `${terms} 12/31/2026`, 'b', 'added');
  for (const input of [[added, redeemed, otherCard], [redeemed, added, otherCard]]) {
    const normalized = normalizeAmexOffers(input);
    assert.equal(normalized.length, 1);
    assert.deepEqual(normalized[0].cards, { a: 'redeemed', b: 'added' });
    assert.deepEqual(normalizeAmexOffers(normalized), normalized);
    assert.equal(added.cards.a, 'added');
  }
  const distinct = normalizeAmexOffers([redeemed,
    offer('different-date', `${terms} 11/30/2026`, 'a', 'added'),
    offer('different-terms', 'Spend $500 or more, earn $50 back 12/31/2026', 'a', 'added')]);
  assert.equal(distinct.length, 3);
  assert.equal(distinct.filter(item => item.cards.a === 'redeemed').length, 1);
});

test('date-only redeemed copies join only one matching campaign on the same card', () => {
  const input = [offer('full', `${terms} 12/31/2026`, 'a', 'added'),
    offer('full-other-card', `${terms} 12/31/2026`, 'b', 'added'),
    offer('redeemed-stub', 'Expires 12/31/2026', 'a', 'redeemed'),
    offer('other-card-stub', 'Expires 12/31/2026', 'c', 'redeemed'),
    offer('other-date-stub', 'Expires 11/30/2026', 'a', 'redeemed'),
    offer('unknown-terms', 'A special offer Expires 12/31/2026', 'a', 'redeemed')];
  const original = structuredClone(input);
  const normalized = normalizeAmexOffers(input);
  assert.equal(normalized.length, 4);
  assert.deepEqual(normalized.find(item => item.description.startsWith('Spend')).cards, { a: 'redeemed', b: 'added' });
  assert.deepEqual(normalized.find(item => item.key === 'other-card-stub').cards, { c: 'redeemed' });
  assert.deepEqual(normalizeAmexOffers(normalized), normalized);
  assert.deepEqual(input, original);
  const ambiguous = normalizeAmexOffers([input[0], input[2],
    offer('other-terms', 'Spend $500 or more, earn $50 back 12/31/2026', 'a', 'added')]);
  assert.equal(ambiguous.length, 3);
  assert.equal(ambiguous.filter(item => item.cards.a === 'redeemed').length, 1);
  assert.equal(ambiguous.find(item => item.key === 'redeemed-stub').cards.a, 'redeemed');
});

test('a redeemed date is not an expiry or permission to update an Added campaign', () => {
  const input = [offer('active', `${terms} Expires 11/08/2026`, 'a', 'added'),
    offer('date-only-redemption', '11/08/2026', 'a', 'redeemed'),
    offer('labelled-redemption', 'Redeemed on 11/08/2026', 'a', 'redeemed')];
  const normalized = normalizeAmexOffers(input);
  assert.equal(normalized.length, 3);
  assert.equal(normalized.find(item => item.description.startsWith('Spend')).cards.a, 'added');
  assert.equal(normalized.filter(item => /Expires/.test(item.description)).length, 1);
  assert.deepEqual(normalizeAmexOffers(normalized), normalized);
});

test('explicit expiry wins over redemption time and excludes the timestamp from campaign terms', () => {
  const input = [offer('active', `${terms} Expires 12/31/2026`, 'a', 'added'),
    offer('redeemed', `${terms} Redeemed on 11/08/2026 Expires 12/31/2026`, 'a', 'redeemed')];
  const normalized = normalizeAmexOffers(input);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].description, `${terms} Expires 12/31/2026`);
  assert.equal(normalized[0].cards.a, 'redeemed');
  assert.deepEqual(normalizeAmexOffers(normalized), normalized);
});

test('undated redemption cannot adopt a newer campaign expiry, even if only one is known', () => {
  for (const activeCard of ['a', 'b']) {
    const input = [offer('old-redemption', terms, 'a', 'redeemed'),
      offer('new-campaign', `${terms} Expires 12/31/2027`, activeCard, 'added')];
    for (const ordered of [input, [...input].reverse()]) {
      const normalized = normalizeAmexOffers(ordered);
      assert.equal(normalized.length, 2);
      const current = normalized.find(item => /Expires/.test(item.description));
      assert.deepEqual(current.cards, { [activeCard]: 'added' });
      const unresolved = normalized.find(item => !/Expires/.test(item.description));
      assert.deepEqual(unresolved.cards, { a: 'redeemed' });
      assert.deepEqual(normalizeAmexOffers(normalized), normalized);
    }
  }
});

test('undated Added copies cannot adopt a known redemption campaign expiry', () => {
  for (const redeemedCard of ['a', 'b']) {
    const input = [offer('old-redeemed-campaign', `${terms} Expires 12/31/2026`, redeemedCard, 'redeemed'),
      offer('new-undated-added', terms, 'a', 'added')];
    for (const ordered of [input, [...input].reverse()]) {
      const normalized = normalizeAmexOffers(ordered);
      assert.equal(normalized.length, 2);
      assert.deepEqual(normalized.find(item => /Expires/.test(item.description)).cards, { [redeemedCard]: 'redeemed' });
      assert.deepEqual(normalized.find(item => !/Expires/.test(item.description)).cards, { a: 'added' });
      assert.deepEqual(normalizeAmexOffers(normalized), normalized);
    }
  }
});

test('unidentified redemption stays separate from undated Added copies and invalid expiries', () => {
  const input = [offer('added', terms, 'a', 'added'),
    offer('redeemed', terms, 'a', 'redeemed'),
    offer('invalid-date', 'Expires 02/30/2026', 'a', 'redeemed')];
  const normalized = normalizeAmexOffers(input);
  assert.equal(normalized.length, 3);
  assert.equal(normalized.find(item => item.description === terms && item.cards.a === 'added').cards.a, 'added');
  assert.equal(normalized.some(item => /Expires/.test(item.description)), false);
  assert.deepEqual(normalizeAmexOffers(normalized), normalized);
});
