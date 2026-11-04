import express from 'express';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bootstrapCss = readFileSync(require.resolve('bootstrap/dist/css/bootstrap.min.css'), 'utf8');
const views = fileURLToPath(new URL('.', import.meta.url));
const statusHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
};
const startedAt = new Date();
const counters = ['vless', 'vmess', 'trojan', 'shadowsocks'].map(protocol => ({
  transport: 'ws', protocol, active: 0, total: 0, errors: 0,
}));
const countries = new Map();
const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });

export function trackConnection(transport, protocol, connection, country) {
  const counter = counters.find(item => item.transport === transport && item.protocol === protocol);
  const code = typeof country === 'string' && /^(?:[A-Z]{2}|T1)$/.test(country) && country !== 'XX'
    ? country : 'unknown';
  if (!countries.has(code)) {
    countries.set(code, {
      code,
      name: code === 'unknown' ? 'Unknown' : code === 'T1' ? 'Tor' : countryNames.of(code),
      active: 0, total: 0, errors: 0,
    });
  }
  const countryCounter = countries.get(code);
  for (const row of [counter, countryCounter]) {
    row.active++;
    row.total++;
  }
  connection.once('close', () => {
    counter.active--;
    countryCounter.active--;
  });
  let failed = false;
  return () => {
    if (!failed) {
      counter.errors++;
      countryCounter.errors++;
    }
    failed = true;
  };
}

function snapshot() {
  return {
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    totals: counters.reduce((total, row) => ({
      active: total.active + row.active,
      total: total.total + row.total,
      errors: total.errors + row.errors,
    }), { active: 0, total: 0, errors: 0 }),
    connections: counters,
    countries: [...countries.values()].sort((a, b) => b.total - a.total || a.code.localeCompare(b.code)),
  };
}

export function createStatusApp() {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.enable('strict routing');
  app.enable('case sensitive routing');
  app.set('view engine', 'pug');
  app.set('views', views);
  app.enable('view cache');
  app.all(['/', '/status', '/status.json'], (request, response) => {
    response.set(statusHeaders);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.set('Allow', 'GET, HEAD').status(405).type('text').send('Method Not Allowed\n');
      return;
    }
    if (request.path === '/status.json') {
      response.json(snapshot());
      return;
    }
    response.render('status', { ...snapshot(), bootstrapCss });
  });
  return app;
}
