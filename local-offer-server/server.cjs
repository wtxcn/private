#!/usr/bin/env node

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const BANKS = new Set(['chase', 'citi', 'usbank', 'amex']);
const STATUSES = new Set(['addable', 'added', 'unknown']);
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

function cleanText(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function safeCardName(value) {
  return cleanText(value, 100).replace(/\d{6,}/g, digits => `...${digits.slice(-4)}`) || 'Card';
}

function sanitizeData(value) {
  const snapshots = {};
  for (const [key, source] of Object.entries(value?.snapshots || {})) {
    const bank = cleanText(source?.bank || key, 20).toLowerCase();
    if (!BANKS.has(bank) || !Array.isArray(source.cards) || !Array.isArray(source.offers)) continue;
    const cards = [];
    const cardIds = new Set();
    for (const card of source.cards.slice(0, 100)) {
      const id = cleanText(card?.id, 100);
      if (!id || cardIds.has(id)) continue;
      cardIds.add(id);
      cards.push({ id, name: safeCardName(card?.name) });
    }
    const offers = [];
    for (const offer of source.offers.slice(0, 5000)) {
      const name = cleanText(offer?.name, 180);
      if (!name || !offer?.cards || typeof offer.cards !== 'object') continue;
      const states = {};
      for (const [cardId, status] of Object.entries(offer.cards)) {
        if (cardIds.has(cardId) && STATUSES.has(status)) states[cardId] = status;
      }
      if (!Object.keys(states).length) continue;
      offers.push({
        key: cleanText(offer.key || name, 220).toLowerCase(),
        name,
        description: cleanText(offer.description, 300),
        cards: states
      });
    }
    snapshots[bank] = {
      bank,
      cards,
      offers,
      scannedAt: Number(source.scannedAt) || 0,
      publishedAt: Number(source.publishedAt) || 0
    };
  }
  return { version: 2, updatedAt: Number(value?.updatedAt) || Date.now(), snapshots };
}

function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function ensureState(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(dataDir, 'config.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {
    config = {};
  }
  if (!config.writeToken) config.writeToken = randomToken();
  if (!config.readToken) config.readToken = randomToken();
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  return { config, configPath, dataPath: path.join(dataDir, 'offers.json') };
}

function readData(dataPath) {
  try {
    return sanitizeData(JSON.parse(fs.readFileSync(dataPath, 'utf8')));
  } catch (_) {
    return { version: 2, updatedAt: 0, snapshots: {} };
  }
}

function writeData(dataPath, value) {
  const temporaryPath = `${dataPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, dataPath);
  fs.chmodSync(dataPath, 0o600);
}

function isLocalRequest(request) {
  const address = request.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address === request.socket.localAddress;
}

function bearerToken(request, url) {
  const authorization = request.headers.authorization || '';
  if (authorization.startsWith('Bearer ')) return authorization.slice(7);
  return url.searchParams.get('token') || '';
}

function tokenMatches(actual, expected) {
  const actualBuffer = Buffer.from(String(actual));
  const expectedBuffer = Buffer.from(String(expected));
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  response.end(JSON.stringify(value));
}

function serveStatic(response, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  if (!['index.html', 'app.js', 'styles.css'].includes(relativePath)) return false;
  const filePath = path.join(PUBLIC_DIR, relativePath);
  const extension = path.extname(filePath);
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extension] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  });
  fs.createReadStream(filePath).pipe(response);
  return true;
}

function startServer(options = {}) {
  const host = options.host || process.env.OFFER_HUB_HOST || '127.0.0.1';
  const vpnHost = options.vpnHost || process.env.OFFER_HUB_VPN_HOST || '';
  const port = Number(options.port ?? process.env.OFFER_HUB_PORT ?? 8787);
  const dataDir = options.dataDir || process.env.OFFER_HUB_DATA_DIR || path.join(os.homedir(), '.card-offers-hub');
  const state = ensureState(dataDir);
  let localPort = port;
  const handler = (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'GET' && url.pathname === '/api/pair') {
      if (!isLocalRequest(request)) return sendJson(response, 403, { error: 'Pairing is only available on this Mac.' });
      return sendJson(response, 200, {
        writeToken: state.config.writeToken,
        readToken: state.config.readToken,
        dashboardUrl: `http://127.0.0.1:${localPort}/?token=${state.config.readToken}`
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/sync') {
      if (!tokenMatches(bearerToken(request, url), state.config.writeToken)) return sendJson(response, 401, { error: 'Invalid sync key.' });
      let body = '';
      request.on('data', chunk => {
        body += chunk;
        if (body.length > 2_000_000) request.destroy();
      });
      request.on('end', () => {
        try {
          const data = sanitizeData(JSON.parse(body));
          writeData(state.dataPath, data);
          sendJson(response, 200, { ok: true, updatedAt: data.updatedAt, banks: Object.keys(data.snapshots).length });
        } catch (_) {
          sendJson(response, 400, { error: 'Invalid offer data.' });
        }
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/data') {
      if (!tokenMatches(bearerToken(request, url), state.config.readToken)) return sendJson(response, 401, { error: 'Invalid access key.' });
      return sendJson(response, 200, readData(state.dataPath));
    }

    if (request.method === 'GET' && serveStatic(response, url.pathname)) return;
    sendJson(response, 404, { error: 'Not found.' });
  };

  return new Promise(async (resolve, reject) => {
    const hosts = [...new Set([host, vpnHost].filter(Boolean))];
    const servers = [];
    try {
      for (const listenHost of hosts) {
        const server = http.createServer(handler);
        await new Promise((listenResolve, listenReject) => {
          server.once('error', listenReject);
          server.listen(port, listenHost, listenResolve);
        });
        servers.push(server);
        if (listenHost === host) localPort = server.address().port;
      }
      resolve({ server: servers[0], servers, state, host, vpnHost, port: localPort });
    } catch (error) {
      for (const server of servers) server.close();
      reject(error);
    }
  });
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--host') options.host = argv[++index];
    else if (argv[index] === '--vpn-host') options.vpnHost = argv[++index];
    else if (argv[index] === '--port') options.port = Number(argv[++index]);
    else if (argv[index] === '--data-dir') options.dataDir = argv[++index];
  }
  return options;
}

if (require.main === module) {
  startServer(parseArguments(process.argv.slice(2))).then(({ host, vpnHost, port, state }) => {
    console.log(`Card Offers Server listening on http://${host}:${port}`);
    if (vpnHost) console.log(`VPN access: http://${vpnHost}:${port}`);
    console.log(`State: ${path.dirname(state.configPath)}`);
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { sanitizeData, startServer };
