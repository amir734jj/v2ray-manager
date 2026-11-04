import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const gateway = 'http://127.0.0.1:53217';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  build: {
    outDir: fileURLToPath(new URL('../gateway/public', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/auth': gateway,
      '/api': gateway,
      '/blocklist': gateway,
      '/status.json': gateway,
      '/socket.io': { target: gateway, ws: true },
    },
  },
});
