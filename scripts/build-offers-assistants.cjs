const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, 'src/offers-assistant');
const core = fs.readFileSync(path.join(sourceDir, 'core.js'), 'utf8');
const iconLicense = fs.readFileSync(path.join(sourceDir, 'ICON-LICENSE.txt'), 'utf8');
// Lucide CreditCard, Search, ChevronsUpDown and Trash2 icon nodes, bundled locally.
const nodes = JSON.parse(fs.readFileSync(path.join(sourceDir, 'icons.json'), 'utf8'));
const icons = Object.fromEntries(Object.entries(nodes).map(([name, children]) => [name,
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + children.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([key, value]) => `${key}="${value}"`).join(' ')}/>`).join('') + '</svg>'
]));
const configs = [
  { file: 'CitiOffersAssistant.user.js', adapter: 'citi', factory: 'createCitiAdapter', id: 'citi-offers-assistant', name: 'Citi Offers Assistant', version: '0.1.2', namespace: 'https://online.citi.com/', match: 'https://online.citi.com/US/nga/products-offers/merchantoffers*', accent: '#0874cf', legacyStore: 'citiOfferClickerState.v1', legacyPanel: 'citi-offer-clicker', cardMode: true, scopePlural: 'cards', allLabel: 'All cards', scanLabel: 'Scan all cards' },
  { file: 'USBankOffersAssistant.user.js', adapter: 'usbank', factory: 'createUSBankAdapter', id: 'usbank-offers-assistant', name: 'U.S. Bank Offers Assistant', version: '0.1.4', namespace: 'https://onlinebanking.usbank.com/', match: 'https://onlinebanking.usbank.com/digital/*', accent: '#b42339', legacyStore: 'usBankOfferClickerState.v1', legacyPanel: 'usbank-offer-clicker', cardMode: false, scopePlural: 'collections', allLabel: 'All deals', scanLabel: 'Scan deals' }
];
for (const config of configs) {
  const header = `// ==UserScript==\n// @name         ${config.name}\n// @namespace    ${config.namespace}\n// @version      ${config.version}\n// @description  Scan and select offers locally. Enrollment starts only when you click Add selected.\n// @match        ${config.match}\n// @updateURL    https://raw.githubusercontent.com/wtxcn/private/main/${config.file}\n// @downloadURL  https://raw.githubusercontent.com/wtxcn/private/main/${config.file}\n// @grant        none\n// @noframes\n// @run-at       document-idle\n// ==/UserScript==\n\n`;
  const adapter = fs.readFileSync(path.join(sourceDir, `${config.adapter}.js`), 'utf8');
  const output = header + '// Generated from src/offers-assistant by scripts/build-offers-assistants.cjs.\n' + `/* Bundled icon licenses:\n${iconLicense}\n*/\n` + '(function () {\n"use strict";\n' + core + '\n' + adapter + `\ncreateOffersAssistant(${JSON.stringify({ ...config, icons })}, ${config.factory});\n})();\n`;
  const destination = path.join(root, config.file);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== output) throw new Error(`Rebuild ${config.file}`);
  } else fs.writeFileSync(destination, output);
  console.log(`${process.argv.includes('--check') ? 'Verified' : 'Built'} ${config.file}`);
}
