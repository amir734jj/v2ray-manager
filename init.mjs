import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from 'fs';
import { readFile, writeFile, unlink } from 'fs/promises';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import QRCode from 'qrcode';
import config2vmess from 'v2ray-tools/src/utils/config2vmess.js';
import config2vless from 'v2ray-tools/src/utils/config2vless.js';
import config2trojan from 'v2ray-tools/src/utils/config2trojan.js';

const { V2RAY_UUID, V2RAY_HOST, FTP_HOST, FTP_USER, FTP_PASS, FTP_PATH } = process.env;

// ── Helpers ──────────────────────────────────────────────────────────────────
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
          address: host, port,
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

// ── Generate client folders and upload to FTP ───────────────────────────────
if (FTP_HOST) {
  execSync('apk add --no-cache curl', { stdio: 'ignore' });

  const serverHost = V2RAY_HOST || 'YOUR_SERVER_IP';
  const ftpBase = `ftp://${FTP_HOST}${FTP_PATH || '/'}`;
  console.log(`FTP target: ${ftpBase} (user: ${FTP_USER})`);

  // Parse the generated server config to extract inbounds
  const serverJson = JSON.parse(readFileSync(cfgPath, 'utf8'));
  serverJson._resolvedHost = serverHost;

  const [vlessInbound]  = serverJson.inbounds.filter(i => i.protocol === 'vless');
  const [vmessInbound]  = serverJson.inbounds.filter(i => i.protocol === 'vmess');
  const [trojanInbound] = serverJson.inbounds.filter(i => i.protocol === 'trojan');

  // Patch listen address so library-generated URLs use the real host
  const patchedConfig = JSON.parse(JSON.stringify(serverJson));
  for (const inbound of patchedConfig.inbounds) inbound.listen = serverHost;
  delete patchedConfig._resolvedHost;

  const patchedPath = join(tmpdir(), `v2ray-server-patched-${Date.now()}.json`);
  writeFileSync(patchedPath, JSON.stringify(patchedConfig, null, 2));

  let vlessUrl, vmessUrl, trojanUrl;
  try {
    [vlessUrl, trojanUrl, vmessUrl] = await Promise.all([
      config2vless ({ path: patchedPath, inboundTag: vlessInbound?.tag }),
      config2trojan({ path: patchedPath, inboundTag: trojanInbound?.tag }),
      makeVmessUrl(serverJson, vmessInbound),
    ]);
  } finally {
    try { unlinkSync(patchedPath); } catch {}
  }

  const entries = [
    { dir: 'vless',  url: vlessUrl,  templateName: 'vless'  },
    { dir: 'vmess',  url: vmessUrl,  templateName: 'vmess'  },
    { dir: 'trojan', url: trojanUrl, templateName: 'trojan' },
  ];

  // Generate each folder: client.json, connection.txt, qr.png
  for (const { dir, url, templateName } of entries) {
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

    // connection.txt
    writeFileSync(join(outDir, 'connection.txt'), url + '\n');

    // qr.png
    await QRCode.toFile(join(outDir, 'qr.png'), url, { type: 'png', width: 512, margin: 2 });

    console.log(`Generated ${dir}/  (client.json, connection.txt, qr.png)`);
  }

  // Also generate the combined client.json
  const combinedTmpl = '/app/templates/client.template.json';
  if (existsSync(combinedTmpl)) {
    const clientJson = JSON.parse(readFileSync(combinedTmpl, 'utf8'));
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
    writeFileSync('/tmp/client.json', JSON.stringify(clientJson, null, 2) + '\n');
    console.log('Generated client.json (combined)');
  }

  // Upload all files to FTP
  const filesToUpload = [];
  for (const dir of ['vless', 'vmess', 'trojan']) {
    for (const file of ['client.json', 'connection.txt', 'qr.png']) {
      const localPath = `/tmp/${dir}/${file}`;
      if (existsSync(localPath)) filesToUpload.push({ local: localPath, remote: `${dir}/${file}` });
    }
  }
  if (existsSync('/tmp/client.json')) {
    filesToUpload.push({ local: '/tmp/client.json', remote: 'client.json' });
  }

  for (const { local, remote } of filesToUpload) {
    try {
      execSync(
        `curl -v --ftp-create-dirs -T "${local}" "${ftpBase}${remote}" --user "${FTP_USER}:${FTP_PASS}" --connect-timeout 10 --max-time 30 2>&1`,
        { stdio: 'pipe' }
      );
      console.log(`Uploaded ${remote}`);
    } catch (err) {
      const output = (err.stderr?.toString() || '') + (err.stdout?.toString() || '');
      console.warn(`WARNING: failed to upload ${remote} (exit ${err.status})\n${output}`);
    }
  }
}
