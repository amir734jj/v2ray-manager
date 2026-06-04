import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { writeFile } from 'fs/promises';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import QRCode from 'qrcode';
import config2vmess from 'v2ray-tools/src/utils/config2vmess.js';
import config2vless from 'v2ray-tools/src/utils/config2vless.js';
import config2trojan from 'v2ray-tools/src/utils/config2trojan.js';

const { V2RAY_UUID, V2RAY_HOST, FTP_HOST, FTP_USER, FTP_PASS, FTP_PATH } = process.env;

// ── Generate server.json ─────────────────────────────────────────────────────
const cfgPath = '/cfg/server.json';

if (existsSync(cfgPath) && statSync(cfgPath).size > 0) {
  console.log('server.json already exists, skipping.');
} else {
  if (!V2RAY_UUID) {
    console.error('ERROR: V2RAY_UUID is required');
    process.exit(1);
  }

  const template = readFileSync('/app/templates/server.template.json', 'utf8');
  const config = template.replaceAll('00000000-0000-0000-0000-000000000000', V2RAY_UUID);
  const tmpPath = `${cfgPath}.tmp`;

  try {
    writeFileSync(tmpPath, config);
    renameSync(tmpPath, cfgPath);
    console.log(`Generated server.json with UUID ${V2RAY_UUID}`);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    console.error('ERROR: failed to generate server.json:', err.message);
    process.exit(1);
  }
}

// ── Generate client folders & upload to FTP ─────────────────────────────────
if (FTP_HOST) {
  execSync('apk add --no-cache curl', { stdio: 'ignore' });

  const serverHost = V2RAY_HOST || 'YOUR_SERVER_IP';
  const ftpBase = `ftp://${FTP_HOST}${FTP_PATH || '/'}`;
  console.log(`FTP target: ${ftpBase} (user: ${FTP_USER})`);

  // Write a patched server config with the real host so v2ray-tools URLs
  // contain the correct address instead of 0.0.0.0
  const serverJson = JSON.parse(readFileSync(cfgPath, 'utf8'));
  for (const inbound of serverJson.inbounds) inbound.listen = serverHost;
  const patchedPath = join(tmpdir(), 'server-patched.json');
  writeFileSync(patchedPath, JSON.stringify(serverJson, null, 2));

  // Build a VMess client outbound config for config2vmess (it reads outbounds)
  const vmessInbound = serverJson.inbounds.find(i => i.protocol === 'vmess');
  const vmessClient = vmessInbound ? {
    outbounds: [{
      tag: vmessInbound.tag ?? `vmess-${vmessInbound.port}`,
      protocol: 'vmess',
      settings: {
        vnext: [{
          address: serverHost,
          port: vmessInbound.port,
          users: [{ id: vmessInbound.settings.clients[0].id, alterId: vmessInbound.settings.clients[0].alterId ?? 0, security: 'auto' }],
        }],
      },
      streamSettings: vmessInbound.streamSettings,
    }],
  } : null;

  let vmessUrl = false;
  if (vmessClient) {
    const vmessPath = join(tmpdir(), 'vmess-client.json');
    writeFileSync(vmessPath, JSON.stringify(vmessClient, null, 2));
    vmessUrl = await config2vmess({ path: vmessPath });
    try { unlinkSync(vmessPath); } catch {}
  }

  const [vlessUrl, trojanUrl] = await Promise.all([
    config2vless({ path: patchedPath, inboundTag: serverJson.inbounds.find(i => i.protocol === 'vless')?.tag }),
    config2trojan({ path: patchedPath, inboundTag: serverJson.inbounds.find(i => i.protocol === 'trojan')?.tag }),
  ]);
  try { unlinkSync(patchedPath); } catch {}

  const entries = [
    { dir: 'vless',  url: vlessUrl,  templateName: 'vless'  },
    { dir: 'vmess',  url: vmessUrl,  templateName: 'vmess'  },
    { dir: 'trojan', url: trojanUrl, templateName: 'trojan' },
  ];

  // Generate each folder: client.json, connection.txt, qr.png
  for (const { dir, url, templateName } of entries) {
    if (!url) { console.log(`Skipping ${dir}/ (no URL generated)`); continue; }
    const outDir = `/tmp/${dir}`;
    mkdirSync(outDir, { recursive: true });

    // client.json from template
    const tmplPath = `/app/templates/${templateName}.template.json`;
    if (existsSync(tmplPath)) {
      const clientJson = JSON.parse(readFileSync(tmplPath, 'utf8'));
      for (const outbound of clientJson.outbounds ?? []) {
        for (const next of outbound.settings?.vnext ?? []) {
          next.address = serverHost;
          for (const user of next.users ?? []) { if (user.id) user.id = V2RAY_UUID; }
        }
        for (const server of outbound.settings?.servers ?? []) {
          server.address = serverHost;
          if (server.password) server.password = V2RAY_UUID;
        }
      }
      writeFileSync(join(outDir, 'client.json'), JSON.stringify(clientJson, null, 2) + '\n');
    }

    writeFileSync(join(outDir, 'connection.txt'), url + '\n');
    await QRCode.toFile(join(outDir, 'qr.png'), url, { type: 'png', width: 512, margin: 2 });
    console.log(`Generated ${dir}/  (client.json, connection.txt, qr.png)`);
  }

  // Upload all generated files to FTP
  for (const dir of ['vless', 'vmess', 'trojan']) {
    const dirPath = `/tmp/${dir}`;
    if (!existsSync(dirPath)) continue;

    for (const file of readdirSync(dirPath)) {
      const localPath = join(dirPath, file);
      if (!statSync(localPath).isFile()) continue;

      try {
        execSync(
          `curl -v --ftp-create-dirs -T "${localPath}" "${ftpBase}${dir}/${file}" --user "${FTP_USER}:${FTP_PASS}" --connect-timeout 10 --max-time 30 2>&1`,
          { stdio: 'pipe' }
        );
        console.log(`Uploaded ${dir}/${file}`);
      } catch (err) {
        const output = (err.stderr?.toString() || '') + (err.stdout?.toString() || '');
        console.warn(`WARNING: failed to upload ${dir}/${file} (exit ${err.status})\n${output}`);
      }
    }
  }
}
