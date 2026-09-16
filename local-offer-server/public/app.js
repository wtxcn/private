(() => {
  'use strict';

  const BANKS = {
    chase: { name: 'Chase', color: '#0874cf' },
    citi: { name: 'Citi', color: '#056dae' },
    usbank: { name: 'U.S. Bank', color: '#b42339' },
    amex: { name: 'Amex', color: '#006fcf' }
  };
  const state = { data: null, query: '', bank: 'all', status: 'all', token: '' };
  const elements = Object.fromEntries(['access', 'access-form', 'access-key', 'access-error', 'dashboard', 'updated', 'refresh', 'search', 'bank-filters', 'status-filters', 'stats', 'results', 'empty'].map(id => [id, document.getElementById(id)]));

  function normalize(value) {
    return String(value || '').normalize('NFKD').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
  }

  function merchantName(value) {
    const first = String(value || '').split('|')[0].replace(/\s+/g, ' ').trim();
    return first.replace(/\s+(?:(?:spend|earn|get|save|up to)\b|\$?\d+(?:\.\d+)?%?\s*(?:cash back|back|off|points?)\b).*$/i, '').trim() || first || 'Offer';
  }

  function relativeTime(timestamp) {
    if (!timestamp) return 'Never';
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function placements() {
    const output = [];
    for (const snapshot of Object.values(state.data?.snapshots || {})) {
      const cards = new Map(snapshot.cards.map(card => [card.id, card]));
      for (const offer of snapshot.offers) {
        for (const [cardId, status] of Object.entries(offer.cards)) {
          output.push({ bank: snapshot.bank, card: cards.get(cardId)?.name || 'Card', status, name: offer.name, description: offer.description || '', scannedAt: snapshot.scannedAt });
        }
      }
    }
    return output;
  }

  function filtered() {
    const needle = normalize(state.query);
    return placements().filter(item => (state.bank === 'all' || item.bank === state.bank)
      && (state.status === 'all' || item.status === state.status)
      && (!needle || normalize(`${item.name} ${item.description} ${item.card} ${BANKS[item.bank]?.name}`).includes(needle)))
      .sort((left, right) => merchantName(left.name).localeCompare(merchantName(right.name)) || left.bank.localeCompare(right.bank) || left.card.localeCompare(right.card));
  }

  function filterButton(label, value, selected, kind) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `filter${selected === value ? ' active' : ''}`;
    button.textContent = label;
    button.addEventListener('click', () => { state[kind] = value; render(); });
    return button;
  }

  function addCell(row, value, className) {
    const cell = document.createElement('td');
    cell.textContent = value;
    if (className) cell.className = className;
    row.appendChild(cell);
    return cell;
  }

  function render() {
    const all = placements();
    const items = filtered();
    const offers = new Set(items.map(item => normalize(merchantName(item.name)))).size;
    const cards = new Set(all.map(item => `${item.bank}|${item.card}`)).size;
    elements['bank-filters'].replaceChildren(filterButton('All banks', 'all', state.bank, 'bank'), ...Object.entries(BANKS).map(([key, bank]) => filterButton(bank.name, key, state.bank, 'bank')));
    elements['status-filters'].replaceChildren(...[['Any status', 'all'], ['Addable', 'addable'], ['Added', 'added'], ['Unverified', 'unknown']].map(([label, value]) => filterButton(label, value, state.status, 'status')));
    elements.stats.replaceChildren(...[
      [Object.keys(state.data?.snapshots || {}).length, 'Banks'],
      [cards, 'Cards'],
      [offers, 'Offers'],
      [items.length, 'Matches']
    ].map(([value, label]) => {
      const box = document.createElement('div');
      box.className = 'stat';
      const strong = document.createElement('strong');
      const span = document.createElement('span');
      strong.textContent = value;
      span.textContent = label;
      box.append(strong, span);
      return box;
    }));
    const rows = items.map(item => {
      const row = document.createElement('tr');
      addCell(row, merchantName(item.name), 'merchant');
      const bank = addCell(row, BANKS[item.bank]?.name || item.bank, 'bank');
      bank.style.setProperty('--bank', BANKS[item.bank]?.color || '#64748b');
      addCell(row, item.card);
      addCell(row, [normalize(item.name) === normalize(merchantName(item.name)) ? '' : item.name, item.description].filter(Boolean).join(' · ') || item.name);
      addCell(row, item.status === 'unknown' ? 'Unverified' : item.status, `status ${item.status}`);
      addCell(row, relativeTime(item.scannedAt));
      return row;
    });
    elements.results.replaceChildren(...rows);
    elements.empty.textContent = all.length ? 'No matching offers.' : 'No offers have been synced yet.';
    elements.empty.hidden = rows.length > 0;
    elements.updated.textContent = state.data?.updatedAt ? `Synced ${relativeTime(state.data.updatedAt)}` : 'No synced data';
  }

  async function loadData(token = state.token) {
    elements['access-error'].textContent = '';
    const response = await fetch('/api/data', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 401 ? 'Access key is not valid.' : 'Dashboard could not load.');
    state.token = token;
    state.data = await response.json();
    localStorage.setItem('cardOffersHub.readToken', token);
    elements.access.hidden = true;
    elements.dashboard.hidden = false;
    render();
  }

  elements['access-form'].addEventListener('submit', event => {
    event.preventDefault();
    loadData(elements['access-key'].value.trim()).catch(error => { elements['access-error'].textContent = error.message; });
  });
  elements.search.addEventListener('input', event => { state.query = event.target.value; render(); });
  elements.refresh.addEventListener('click', () => { if (state.token) loadData().catch(() => {}); });

  const url = new URL(location.href);
  const token = url.searchParams.get('token') || localStorage.getItem('cardOffersHub.readToken') || '';
  if (url.searchParams.has('token')) history.replaceState(null, '', '/');
  if (token) loadData(token).catch(error => {
    localStorage.removeItem('cardOffersHub.readToken');
    elements['access-error'].textContent = error.message;
  });
})();
