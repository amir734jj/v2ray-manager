import express from 'express';
import { fileURLToPath } from 'node:url';

const publicDirectory = fileURLToPath(new URL('../public', import.meta.url));

export function createPagesController() {
  const router = express.Router({ strict: true, caseSensitive: true });
  router.use('/assets', express.static(fileURLToPath(new URL('../public/assets', import.meta.url)), {
    index: false, redirect: false,
  }));
  router.all(['/', '/status', '/login', '/register', '/blocked-ips', '/users', '/subscriptions', '/destinations'], (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.set('Allow', 'GET, HEAD').status(405).type('text').send('Method Not Allowed\n');
      return;
    }
    response.sendFile('index.html', { root: publicDirectory });
  });
  return router;
}
