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
