function normalizeAmexOffers(offers) {
  const text = value => String(value || '').replace(/\s+/g, ' ').trim();
  const keyOf = value => text(value).normalize('NFKD').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
  const candidates = offers.map(offer => {
    const original = text(offer.description);
    const date = original.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
    const expiry = date && Number(date[1]) <= 12 && Number(date[2]) <= 31
      ? `${date[3].length === 2 ? '20' : ''}${date[3]}-${date[1].padStart(2, '0')}-${date[2].padStart(2, '0')}` : '';
    let description = original
      .split(/\b(?:Your offer has been added|Remember to use your enrolled|Add to Card|Added to Card|Redeem Now|View Details|Card Details|Terms apply|Details)\b/i)[0]
      .replace(/(?:Expires?\s*)?\b\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})\b/ig, ' ');
    description = text(description);
    // The old collector concatenated a button's text with its parent's text.
    let repeated;
    while ((repeated = description.match(/^(.+?)\s+\1$/i))) description = repeated[1];
    const base = /[$%]|\b\d[\d,]*\s+(?:points|miles)\b/i.test(description)
      ? `amex|${keyOf(offer.name)}|${description.normalize('NFKC').toLowerCase()}` : null;
    const cards = { ...offer.cards };
    if (/\bYour offer has been added\b/i.test(original)) {
      for (const id of Object.keys(cards)) cards[id] = 'added';
    }
    return { ...offer, description, cards, base, expiry };
  });
  const dates = new Map();
  for (const item of candidates) {
    if (!dates.has(item.base)) dates.set(item.base, new Set());
    if (item.expiry) dates.get(item.base).add(item.expiry);
  }
  const merged = new Map();
  for (const item of candidates) {
    // Date-less legacy copies can join a known campaign only when unambiguous.
    const known = dates.get(item.base);
    const expiry = item.expiry || (item.base && known.size === 1 ? [...known][0] : '');
    const key = item.base ? `${item.base}|${expiry}` : item.key;
    const prior = merged.get(key) || {
      key, name: item.name,
      description: item.description + (expiry ? ` Expires ${expiry.slice(5, 7)}/${expiry.slice(8)}/${expiry.slice(0, 4)}` : ''),
      cards: {}
    };
    for (const [id, status] of Object.entries(item.cards)) {
      const previous = prior.cards[id];
      prior.cards[id] = status === 'added' || previous === 'added' ? 'added'
        : previous && previous !== status ? 'unknown' : status;
    }
    merged.set(key, prior);
  }
  return [...merged.values()];
}

module.exports = { normalizeAmexOffers };
