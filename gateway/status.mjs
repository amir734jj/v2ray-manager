import express from 'express';
import { renderFile } from 'pug';
import { fileURLToPath } from 'node:url';

const views = fileURLToPath(new URL('.', import.meta.url));
const template = fileURLToPath(new URL('./status.pug', import.meta.url));
const statusHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
};
const startedAt = new Date();
const counters = ['ws', 'grpc'].flatMap(transport =>
  ['vless', 'vmess', 'trojan', 'shadowsocks'].map(protocol => ({
    transport, protocol, active: 0, total: 0, errors: 0,
  })),
);

export function trackConnection(transport, protocol, connection) {
  const counter = counters.find(item => item.transport === transport && item.protocol === protocol);
  counter.active++;
  counter.total++;
  connection.once('close', () => { counter.active--; });
  let failed = false;
  return () => {
    if (!failed) counter.errors++;
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
  };
}

export function statusResponse(path, method) {
  if (path !== '/' && path !== '/status' && path !== '/status.json') return null;
  if (method !== 'GET' && method !== 'HEAD') {
    return { code: 405, headers: { ...statusHeaders, allow: 'GET, HEAD' }, body: 'Method Not Allowed\n' };
  }
  const status = snapshot();
  return {
    code: 200,
    headers: {
      ...statusHeaders,
      'content-type': path === '/status.json' ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    },
    body: method === 'HEAD' ? '' : path === '/status.json' ? JSON.stringify(status) : renderFile(template, status),
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
    response.render('status', snapshot());
  });
  return app;
}
