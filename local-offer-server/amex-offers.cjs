function normalizeAmexOffers(offers) {
  const text = value => String(value || '').replace(/\s+/g, ' ').trim();
  const keyOf = value => text(value).normalize('NFKD').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
  const mergeStatus = (previous, status) => previous === 'redeemed' || status === 'redeemed' ? 'redeemed'
    : previous === 'added' || status === 'added' ? 'added'
      : previous && previous !== status ? 'unknown' : status;
  const datePattern = '\\b(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4}|\\d{2})\\b';
  const expiryLabel = '(?:Expires?|Expiry(?: date)?|Expiration(?: date)?|Valid (?:through|until)|Offer ends?)';
  const redeemedDate = new RegExp(`\\b(?:your offer has been redeemed|you have redeemed this offer|offer redeemed|redeemed)(?:\\s+on)?\\s+${datePattern}[.!]?`, 'ig');
  const dateKey = date => {
    if (!date) return '';
    const year = Number(`${date[3].length === 2 ? '20' : ''}${date[3]}`);
    const month = Number(date[1]);
    const day = Number(date[2]);
    const value = new Date(Date.UTC(year, month - 1, day));
    return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day
      ? `${year}-${date[1].padStart(2, '0')}-${date[2].padStart(2, '0')}` : '';
  };
  const candidates = offers.map(offer => {
    const original = text(offer.description);
    const hasRedeemed = Object.values(offer.cards || {}).includes('redeemed');
    const explicitDate = original.match(new RegExp(`\\b${expiryLabel}\\s*:?\\s*${datePattern}`, 'i'));
    // A date on a Redeemed tile may be the redemption date. Only a labelled
    // expiry identifies its campaign; bare dates remain supported for old
    // active-offer snapshots, whose collector omitted the Expires label.
    const legacyDate = !hasRedeemed && !/\bredeemed\b/i.test(original)
      ? original.match(new RegExp(datePattern)) : null;
    const expiry = dateKey(explicitDate || legacyDate);
    let description = original
      .split(/\b(?:Your offer has been added|Remember to use your enrolled|Add to Card|Added to Card|Redeem Now|View Details|Card Details|Terms apply|Details)\b/i)[0]
      .replace(redeemedDate, ' ')
      .replace(new RegExp(`\\b${expiryLabel}\\s*:?\\s*${datePattern}`, 'ig'), ' ')
      .replace(new RegExp(datePattern, 'g'), ' ');
    description = text(description);
    // The old collector concatenated a button's text with its parent's text.
    let repeated;
    while ((repeated = description.match(/^(.+?)\s+\1$/i))) description = repeated[1];
    const base = /[$%]|\b\d[\d,]*\s+(?:points|miles)\b/i.test(description)
      ? `amex|${keyOf(offer.name)}|${description.normalize('NFKC').toLowerCase()}` : null;
    const cards = { ...offer.cards };
    if (/\bYour offer has been added\b/i.test(original)) {
      for (const id of Object.keys(cards)) if (cards[id] !== 'redeemed') cards[id] = 'added';
    }
    return { ...offer, description, cards, base, expiry, hasRedeemed };
  });
  const dates = new Map();
  const redeemedBases = new Set(candidates.filter(item => item.hasRedeemed).map(item => item.base));
  for (const item of candidates) {
    if (!dates.has(item.base)) dates.set(item.base, new Set());
    if (item.expiry) dates.get(item.base).add(item.expiry);
  }
  const merged = new Map();
  for (const item of candidates) {
    // Date-less legacy copies can join an unambiguous active campaign. Once
    // redemption exists for these terms, either undated side may be a separate
    // recurrence, so neither side can borrow a date from the other.
    const known = dates.get(item.base);
    const expiry = item.expiry || (!redeemedBases.has(item.base) && item.base && known.size === 1 ? [...known][0] : '');
    // Preserve unmatched bank redemption evidence without applying it to an
    // Added copy (or a later recurrence) solely because the offer terms match.
    const unresolvedKey = /^amex unresolved redemption\b/.test(keyOf(item.key))
      ? item.key : `amex unresolved redemption ${keyOf(item.key || `${item.name} ${item.description}`)}`;
    const key = item.hasRedeemed && !expiry ? unresolvedKey : item.base ? `${item.base}|${expiry}` : item.key;
    const entry = merged.get(key) || { base: item.base, expiry, stub: !item.base && !item.description, offer: {
      key, name: item.name,
      description: item.description + (expiry ? ` Expires ${expiry.slice(5, 7)}/${expiry.slice(8)}/${expiry.slice(0, 4)}` : ''),
      cards: {}
    } };
    const prior = entry.offer;
    for (const [id, status] of Object.entries(item.cards)) {
      prior.cards[id] = mergeStatus(prior.cards[id], status);
    }
    merged.set(key, entry);
  }
  const entries = [...merged.values()];
  const campaigns = new Map();
  const campaignKey = (entry, id) => JSON.stringify([keyOf(entry.offer.name), entry.expiry, id]);
  for (const entry of entries) {
    if (!entry.base || !entry.expiry) continue;
    for (const id of Object.keys(entry.offer.cards)) {
      const key = campaignKey(entry, id);
      if (!campaigns.has(key)) campaigns.set(key, []);
      campaigns.get(key).push(entry.offer);
    }
  }
  for (const entry of entries) {
    if (!entry.stub || !entry.expiry) continue;
    for (const [id, status] of Object.entries(entry.offer.cards)) {
      // Missing terms identify a campaign only with the same card, merchant and
      // explicit expiry, and only when there is exactly one possible campaign.
      const matches = campaigns.get(campaignKey(entry, id)) || [];
      if (matches.length !== 1) continue;
      const target = matches[0];
      target.cards[id] = mergeStatus(target.cards[id], status);
      delete entry.offer.cards[id];
    }
  }
  return entries.map(entry => entry.offer).filter(offer => Object.keys(offer.cards).length);
}

module.exports = { normalizeAmexOffers };
