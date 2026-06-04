import { readFileSync, writeFileSync, existsSync, statSync, renameSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';

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

  const template = readFileSync('/templates/server.template.json', 'utf8');
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

// ── Upload client configs to FTP (if FTP_HOST is set) ───────────────────────
if (FTP_HOST) {
  execSync('apk add --no-cache curl', { stdio: 'ignore' });

  const host = V2RAY_HOST || 'YOUR_SERVER_IP';
  const ftpBase = `ftp://${FTP_HOST}${FTP_PATH || '/'}`;
  console.log(`FTP target: ${ftpBase} (user: ${FTP_USER})`);

  for (const proto of ['vless', 'vmess', 'trojan', 'client']) {
    const tmplPath = `/templates/${proto}.template.json`;
    if (!existsSync(tmplPath)) continue;

    const config = readFileSync(tmplPath, 'utf8')
      .replaceAll('00000000-0000-0000-0000-000000000000', V2RAY_UUID)
      .replaceAll('YOUR_SERVER_IP', host);

    const outPath = `/tmp/${proto}.json`;
    writeFileSync(outPath, config);

    try {
      const result = execSync(
        `curl -v --ftp-create-dirs -T "${outPath}" "${ftpBase}${proto}.json" --user "${FTP_USER}:${FTP_PASS}" --connect-timeout 10 --max-time 30 2>&1`,
        { stdio: 'pipe' }
      );
      console.log(`Uploaded ${proto}.json to FTP`);
    } catch (err) {
      const output = (err.stderr?.toString() || '') + (err.stdout?.toString() || '');
      console.warn(`WARNING: failed to upload ${proto}.json (exit ${err.status})\n${output}`);
    }
  }
}
