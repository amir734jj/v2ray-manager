#!/usr/bin/env node
/**
 * Rotates the shared UUID across standalone local v2ray server configs,
 * regenerates connection URLs, and prints QR codes to the terminal.
 *
 * Usage:
 *   npm run rotate
 *
 * VMess URL generation uses: https://github.com/amir734jj/v2ray-tools
 * QR codes use: https://github.com/soldair/node-qrcode
 */

import { randomUUID }              from 'crypto';
import { readFile, writeFile, access, mkdir } from 'fs/promises';
import { join, dirname }           from 'path';
import { fileURLToPath }           from 'url';
import QRCode                      from 'qrcode';
import { configureClient, configureServerTransports, createConnectionUrls, validateHost } from './connections.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const projectDir = dirname(__dir);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const serverPath   = join(projectDir, 'v2ray-all/server.json');
  const templatePath = join(projectDir, 'v2ray/templates/server.template.json');

  // Optional args: npm run rotate -- [<server-address>] [--uuid <uuid>]
  const args    = process.argv.slice(2);
  const uuidIdx = args.indexOf('--uuid');
  const argUuid = uuidIdx !== -1 ? args[uuidIdx + 1] : null;
  const optionIndexes = new Set();
  for (const index of [uuidIdx]) {
    if (index !== -1) {
      optionIndexes.add(index);
      optionIndexes.add(index + 1);
    }
  }
  const argHost = args.find((_arg, index) => !optionIndexes.has(index)) ?? null;
  const newId   = argUuid ?? randomUUID();
  const existingConn = await readFile(join(projectDir, 'vless/connection.txt'), 'utf8').catch(err => {
    if (err.code === 'ENOENT') return '';
    throw err;
  });
  const hostMatch = existingConn.match(/@([^:@\s]+):/);
  const serverHost = validateHost(argHost ?? process.env.V2RAY_HOST ?? hostMatch?.[1]);

  // --- Update v2ray-all/server.json (bootstrap from template if missing) -----
  const sourcePath = await access(serverPath).then(() => serverPath).catch(() => templatePath);
  const serverRaw = await readFile(sourcePath, 'utf8');
  const serverJson = configureServerTransports(JSON.parse(serverRaw));
  for (const inbound of serverJson.inbounds ?? []) {
    for (const client of inbound.settings?.clients ?? []) {
      if (client.id)       client.id       = newId;
      if (client.password) client.password = newId;
    }
  }
  const updatedServer = JSON.stringify(serverJson, null, 2) + '\n';
  await mkdir(dirname(serverPath), { recursive: true });
  await writeFile(serverPath, updatedServer);
  console.log(`New standalone ID: ${newId}`);
  console.log('Updated  v2ray-all/server.json\n');

  const config = serverJson;

  if (argHost) console.log(`Server:  ${serverHost}\n`);
  const urls = createConnectionUrls(config, serverHost);

  const entries = [
    { dir: 'vless',       label: 'VLESS',       wsUrl: urls.vless },
    { dir: 'vmess',       label: 'VMess',       wsUrl: urls.vmess },
    { dir: 'trojan',      label: 'Trojan',      wsUrl: urls.trojan },
  ];

  // --- Write connection files, QR images & print QR codes --------------------
  for (const { dir, label, wsUrl } of entries) {
    await mkdir(join(projectDir, dir), { recursive: true });
    const qrImagePath    = join(projectDir, dir, 'qr.png');
    const clientJsonPath = join(projectDir, dir, 'client.json');

    await writeFile(join(projectDir, dir, 'connection.txt'), wsUrl + '\n');
    await QRCode.toFile(qrImagePath, wsUrl, { type: 'png', width: 512, margin: 2 });
    // Update per-protocol client.json (bootstrap from templates/<dir>.template.json if missing)
    const clientTemplatePath = join(projectDir, 'v2ray/templates/' + dir + '.template.json');
    const clientSource = await access(clientJsonPath).then(() => clientJsonPath)
      .catch(() => access(clientTemplatePath).then(() => clientTemplatePath).catch(() => null));
    if (clientSource) {
      const raw = await readFile(clientSource, 'utf8');
      const clientJson = JSON.parse(raw);
      configureClient(clientJson, config, serverHost);
      await writeFile(clientJsonPath, JSON.stringify(clientJson, null, 2) + '\n');
      console.log(`Updated  ${dir}/client.json`);
    }

    const qr = await QRCode.toString(wsUrl, { type: 'terminal', small: true });
    console.log(`\n${'═'.repeat(60)}`);
    console.log(` ${label}`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`WS URL:   ${wsUrl}`);
    console.log(`QR:  ${qrImagePath}\n`);
    console.log(qr);
  }

  console.log('All connection.txt files updated.\n');

  // --- Update v2ray-all/client.json (all protocols in one file) ---------------
  const rootClientPath    = join(projectDir, 'v2ray-all/client.json');
  const rootTemplatePath  = join(projectDir, 'v2ray/templates/client.template.json');
  const rootSource = await access(rootClientPath).then(() => rootClientPath)
    .catch(() => access(rootTemplatePath).then(() => rootTemplatePath).catch(() => null));
  if (rootSource) {
    const raw = await readFile(rootSource, 'utf8');
    const clientJson = JSON.parse(raw);
    configureClient(clientJson, config, serverHost);
    await writeFile(rootClientPath, JSON.stringify(clientJson, null, 2) + '\n');
    console.log('Updated  v2ray-all/client.json (all protocols)\n');
  }

  console.log('Managed deployments ignore these standalone profiles. Use Users to reset per-user credentials.');
  console.log('Local v2ray-all/server.json is not mounted by this Compose deployment.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
