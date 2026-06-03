#!/usr/bin/env node
/**
 * Rotates the shared UUID across all v2ray server configs,
 * regenerates connection URLs, and prints QR codes to the terminal.
 *
 * Usage:
 *   npm run rotate
 *
 * VMess URL generation uses: https://github.com/amir734jj/v2ray-tools
 * QR codes use: https://github.com/soldair/node-qrcode
 */

import { randomUUID }              from 'crypto';
import { readFile, writeFile, unlink, access } from 'fs/promises';
import { join, dirname }           from 'path';
import { fileURLToPath }           from 'url';
import { tmpdir }                  from 'os';
import QRCode                      from 'qrcode';
import config2vmess                from 'v2ray-tools/src/utils/config2vmess.js';
import config2vless                from 'v2ray-tools/src/utils/config2vless.js';
import config2trojan               from 'v2ray-tools/src/utils/config2trojan.js';

const __dir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * VMess share-link via v2ray-tools (config2vmess).
 * config2vmess reads an outbound-based client config, so we build a minimal
 * temporary one from the known server inbound shape.
 */
async function makeVmessUrl(serverConfig, inbound) {
  const { port, streamSettings, settings } = inbound;
  const [client] = settings.clients;
  const host = serverConfig._resolvedHost;

  const clientConfig = {
    outbounds: [{
      tag: inbound.tag ?? `vmess-${port}`,
      protocol: 'vmess',
      settings: {
        vnext: [{
          address: host,
          port,
          users: [{ id: client.id, alterId: client.alterId ?? 0, security: 'auto' }],
        }],
      },
      streamSettings,
    }],
  };

  const tmpPath = join(tmpdir(), `vmess-client-${Date.now()}.json`);
  await writeFile(tmpPath, JSON.stringify(clientConfig, null, 2));
  try {
    return await config2vmess({ path: tmpPath });
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const serverPath   = join(__dir, 'v2ray-all/server.json');
  const templatePath = join(__dir, 'templates/server.template.json');

  // Optional args: npm run rotate -- [<server-address>] [--uuid <uuid>]
  const args    = process.argv.slice(2);
  const uuidIdx = args.indexOf('--uuid');
  const argUuid = uuidIdx !== -1 ? args[uuidIdx + 1] : null;
  const argHost = args.find((a, i) => a !== '--uuid' && i !== uuidIdx + 1) ?? null;
  const newId   = argUuid ?? randomUUID();

  // --- Update v2ray-all/server.json (bootstrap from template if missing) -----
  const sourcePath = await access(serverPath).then(() => serverPath).catch(() => templatePath);
  const serverRaw = await readFile(sourcePath, 'utf8');
  const serverJson = JSON.parse(serverRaw);
  for (const inbound of serverJson.inbounds ?? []) {
    for (const client of inbound.settings?.clients ?? []) {
      if (client.id)       client.id       = newId;
      if (client.password) client.password = newId;
    }
  }
  const updatedServer = JSON.stringify(serverJson, null, 2) + '\n';
  await writeFile(serverPath, updatedServer);
  console.log(`New ID: ${newId}  ← set this as V2RAY_UUID in Coolify`);
  console.log('Updated  v2ray-all/server.json\n');

  // Read back the updated config so the library works from the real file
  const config = JSON.parse(updatedServer);

  // Resolve server host: CLI arg > existing connection.txt > fallback
  const existingConn = await readFile(join(__dir, 'vless/connection.txt'), 'utf8').catch(() => '');
  const hostMatch    = existingConn.match(/@([^:@\s]+):/);
  const serverHost   = argHost ?? (hostMatch ? hostMatch[1] : 'YOUR_SERVER_IP');
  if (argHost) console.log(`Server:  ${serverHost}\n`);
  if (serverHost === 'YOUR_SERVER_IP') console.warn('Warning: server address unknown — run: npm run rotate -- <ip>\n');
  config._resolvedHost = serverHost; // pass through to makeVmessUrl

  // --- Generate share URLs using v2ray-tools library -------------------------
  const [vlessInbound]  = config.inbounds.filter(i => i.protocol === 'vless');
  const [vmessInbound]  = config.inbounds.filter(i => i.protocol === 'vmess');
  const [trojanInbound] = config.inbounds.filter(i => i.protocol === 'trojan');

  // Patch listen address so library-generated URLs use the real host
  const patchedConfig = JSON.parse(JSON.stringify(config));
  for (const inbound of patchedConfig.inbounds) {
    inbound.listen = serverHost;
  }
  delete patchedConfig._resolvedHost;

  const patchedPath = join(tmpdir(), `v2ray-server-patched-${Date.now()}.json`);
  await writeFile(patchedPath, JSON.stringify(patchedConfig, null, 2));

  const [vlessUrl, trojanUrl, vmessUrl] = await Promise.all([
    config2vless ({ path: patchedPath, inboundTag: vlessInbound?.tag }),
    config2trojan({ path: patchedPath, inboundTag: trojanInbound?.tag }),
    makeVmessUrl(config, vmessInbound),
  ]);

  await unlink(patchedPath).catch(() => {});

  const entries = [
    { dir: 'vless',  label: 'VLESS',     url: vlessUrl  },
    { dir: 'vmess',  label: 'VMess-HTTP', url: vmessUrl  },
    { dir: 'trojan', label: 'Trojan',     url: trojanUrl },
  ];

  // --- Write connection files, QR images & print QR codes --------------------
  for (const { dir, label, url } of entries) {
    const qrImagePath    = join(__dir, dir, 'qr.png');
    const clientJsonPath = join(__dir, dir, 'client.json');

    await writeFile(join(__dir, dir, 'connection.txt'), url + '\n');
    await QRCode.toFile(qrImagePath, url, { type: 'png', width: 512, margin: 2 });

    // Update per-protocol client.json (bootstrap from templates/<dir>.template.json if missing)
    const clientTemplatePath = join(__dir, 'templates/' + dir + '.template.json');
    const clientSource = await access(clientJsonPath).then(() => clientJsonPath)
      .catch(() => access(clientTemplatePath).then(() => clientTemplatePath).catch(() => null));
    if (clientSource) {
      const raw = await readFile(clientSource, 'utf8');
      const clientJson = JSON.parse(raw);
      for (const outbound of clientJson.outbounds ?? []) {
        for (const next of outbound.settings?.vnext ?? []) {
          if (argHost) next.address = serverHost;
          for (const user of next.users ?? []) {
            if (user.id) user.id = newId;
          }
        }
        for (const server of outbound.settings?.servers ?? []) {
          if (argHost) server.address = serverHost;
          if (server.password) server.password = newId;
        }
      }
      await writeFile(clientJsonPath, JSON.stringify(clientJson, null, 2) + '\n');
      console.log(`Updated  ${dir}/client.json`);
    }

    const qr = await QRCode.toString(url, { type: 'terminal', small: true });
    console.log(`\n${'═'.repeat(60)}`);
    console.log(` ${label}`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`URL: ${url}`);
    console.log(`QR:  ${qrImagePath}\n`);
    console.log(qr);
  }

  console.log('All connection.txt files updated.\n');

  // --- Update v2ray-all/client.json (all protocols in one file) ---------------
  const rootClientPath    = join(__dir, 'v2ray-all/client.json');
  const rootTemplatePath  = join(__dir, 'templates/client.template.json');
  const rootSource = await access(rootClientPath).then(() => rootClientPath)
    .catch(() => access(rootTemplatePath).then(() => rootTemplatePath).catch(() => null));
  if (rootSource) {
    const raw = await readFile(rootSource, 'utf8');
    const clientJson = JSON.parse(raw);
    for (const outbound of clientJson.outbounds ?? []) {
      for (const next of outbound.settings?.vnext ?? []) {
        if (argHost) next.address = serverHost;
        for (const user of next.users ?? []) {
          if (user.id) user.id = newId;
        }
      }
      for (const server of outbound.settings?.servers ?? []) {
        if (argHost) server.address = serverHost;
        if (server.password) server.password = newId;
      }
    }
    await writeFile(rootClientPath, JSON.stringify(clientJson, null, 2) + '\n');
    console.log('Updated  v2ray-all/client.json (all protocols)\n');
  }

  console.log('Restart the container to apply the new ID:');
  console.log('  sudo docker compose restart');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
