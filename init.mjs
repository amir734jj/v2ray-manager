import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import QRCode from 'qrcode';
import { configureClient, createConnectionUrls, validateHost } from './connections.mjs';

const { V2RAY_UUID, V2RAY_HOST, FTP_HOST, FTP_USER, FTP_PASS, FTP_PATH } = process.env;

// ── Generate server.json ─────────────────────────────────────────────────────
const cfgPath = '/cfg/server.json';

if (!V2RAY_UUID) {
  console.error('ERROR: V2RAY_UUID is required');
  process.exit(1);
}
validateHost(V2RAY_HOST);

const template = readFileSync('/app/templates/server.template.json', 'utf8');
const config = template.replaceAll('00000000-0000-0000-0000-000000000000', V2RAY_UUID);
const tmpPath = `${cfgPath}.tmp`;

try {
  writeFileSync(tmpPath, config);
  renameSync(tmpPath, cfgPath);
  console.log('Generated server.json');
} catch (err) {
  try { unlinkSync(tmpPath); } catch {}
  console.error('ERROR: failed to generate server.json:', err.message);
  process.exit(1);
}

// ── Generate client folders & upload to FTP ─────────────────────────────────
if (FTP_HOST) {

  const serverHost = V2RAY_HOST;
  const ftpBase = `ftp://${FTP_HOST}${FTP_PATH || '/'}`;
  console.log(`FTP target: ${ftpBase} (user: ${FTP_USER})`);

  const serverJson = JSON.parse(readFileSync(cfgPath, 'utf8'));

  const urls = await createConnectionUrls(serverJson, serverHost);

  const entries = [
    { dir: 'vless',       url: urls.vless,       templateName: 'vless'       },
    { dir: 'vmess',       url: urls.vmess,       templateName: 'vmess'       },
    { dir: 'trojan',      url: urls.trojan,      templateName: 'trojan'      },
    { dir: 'shadowsocks', url: urls.shadowsocks, templateName: 'shadowsocks' },
  ];

  // Generate each folder: client.json, connection.txt, qr.png
  for (const { dir, url, templateName } of entries) {
    const outDir = `/tmp/${dir}`;
    mkdirSync(outDir, { recursive: true });

    // client.json from template
    const tmplPath = `/app/templates/${templateName}.template.json`;
    if (existsSync(tmplPath)) {
      const clientJson = JSON.parse(readFileSync(tmplPath, 'utf8'));
      configureClient(clientJson, serverJson, serverHost);
      writeFileSync(join(outDir, 'client.json'), JSON.stringify(clientJson, null, 2) + '\n');
    }

    writeFileSync(join(outDir, 'connection.txt'), url + '\n');
    await QRCode.toFile(join(outDir, 'qr.png'), url, { type: 'png', width: 512, margin: 2 });
    console.log(`Generated ${dir}/  (client.json, connection.txt, qr.png)`);
  }

  // Upload all generated files to FTP
  for (const dir of ['vless', 'vmess', 'trojan', 'shadowsocks']) {
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
