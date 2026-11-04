import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer, connect } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { configureClient, protocols } from './connections.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const { V2RAY_TEST_BINARY, NGINX_TEST_BINARY, SS_PLUGIN_TEST_BINARY } = process.env;

async function freePort() {
  const server = createTcpServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForPort(port, child, logs) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Runtime exited: ${logs()}`);
    const ready = await new Promise(resolve => {
      const socket = connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (ready) return;
    await delay(50);
  }
  throw new Error(`Runtime did not listen on ${port}: ${logs()}`);
}

test('real V2Ray traffic through Nginx for all four WebSocket protocols', {
  skip: !V2RAY_TEST_BINARY || !NGINX_TEST_BINARY,
  timeout: 60000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'v2ray-runtime-test-'));
  const children = [];
  let logs = '';
  let activeProtocol = 'startup';
  let gateway;
  const origin = createServer((req, res) => res.end('proxied-through-websocket'));
  function start(binary, args, env = process.env) {
    const child = spawn(binary, args, { cwd: dir, env, windowsHide: true });
    children.push(child);
    child.stdout.on('data', data => { logs += data; });
    child.stderr.on('data', data => { logs += data; });
    return child;
  }
  try {
    await mkdir(join(dir, 'logs'));
    await mkdir(join(dir, 'temp'));
    await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
    const server = JSON.parse(await readFile(join(root, 'templates', 'server.template.json'), 'utf8'));
    let nginx = await readFile(join(root, 'nginx.conf'), 'utf8');
    const gatewayPort = await freePort();
    nginx = nginx.replace('listen 53217;', `listen ${gatewayPort};`)
      .replaceAll('/etc/nginx/proxy_params_ws', 'proxy_params_ws');
    for (const inbound of server.inbounds) {
      const port = await freePort();
      nginx = nginx.replace(`core:${inbound.port}`, `127.0.0.1:${port}`);
      inbound.listen = '127.0.0.1';
      inbound.port = port;
    }
    // Test ports and direct localhost destinations without depending on geoip assets.
    delete server.routing;
    await Promise.all([
      writeFile(join(dir, 'server.json'), JSON.stringify(server)),
      writeFile(join(dir, 'nginx.conf'), `events {}\nhttp {\n${nginx}\n}\n`),
      copyFile(join(root, 'proxy_params_ws'), join(dir, 'proxy_params_ws')),
    ]);
    await run(V2RAY_TEST_BINARY, ['test', '-config', join(dir, 'server.json')], { cwd: dir });
    await run(NGINX_TEST_BINARY, ['-t', '-p', '.', '-c', 'nginx.conf'], { cwd: dir });
    const core = start(V2RAY_TEST_BINARY, ['run', '-config', 'server.json']);
    await waitForPort(server.inbounds[0].port, core, () => logs);
    gateway = start(NGINX_TEST_BINARY, ['-p', '.', '-c', 'nginx.conf']);
    await waitForPort(gatewayPort, gateway, () => logs);
    const health = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`);
    assert.equal(await health.text(), 'ok\n');
    assert.equal((await fetch(`http://127.0.0.1:${gatewayPort}/unknown`)).status, 404);
    for (const protocol of protocols) {
      activeProtocol = protocol;
      const template = JSON.parse(await readFile(join(root, 'templates', `${protocol}.template.json`), 'utf8'));
      const client = configureClient(template, server, 'localhost');
      await writeFile(join(dir, `${protocol}-public.json`), JSON.stringify(client));
      await run(V2RAY_TEST_BINARY, ['test', '-config', `${protocol}-public.json`], { cwd: dir });
      delete client.routing;
      const socksPort = await freePort();
      client.inbounds[0].port = socksPort;
      const outbound = client.outbounds[0];
      const target = (outbound.settings.vnext ?? outbound.settings.servers)[0];
      target.address = '127.0.0.1';
      target.port = gatewayPort;
      // Coolify supplies TLS in production; this fixture tests the plain internal gateway.
      outbound.streamSettings.security = 'none';
      delete outbound.streamSettings.tlsSettings;
      await writeFile(join(dir, `${protocol}.json`), JSON.stringify(client));
      const proxy = start(V2RAY_TEST_BINARY, ['run', '-config', `${protocol}.json`]);
      await waitForPort(socksPort, proxy, () => logs);
      const { stdout } = await run('curl', [
        '--silent', '--show-error', '--fail', '--noproxy', '',
        '--socks5-hostname', `127.0.0.1:${socksPort}`, '--max-time', '10',
        `http://127.0.0.1:${origin.address().port}/`,
      ]);
      assert.equal(stdout, 'proxied-through-websocket', `${protocol}: ${logs}`);
    }
    if (SS_PLUGIN_TEST_BINARY) {
      activeProtocol = 'shadowsocks-plugin';
      const pluginPort = await freePort();
      const plugin = start(SS_PLUGIN_TEST_BINARY, [], {
        ...process.env,
        SS_LOCAL_HOST: '127.0.0.1',
        SS_LOCAL_PORT: String(pluginPort),
        SS_REMOTE_HOST: '127.0.0.1',
        SS_REMOTE_PORT: String(gatewayPort),
        SS_PLUGIN_OPTIONS: 'mux=0;host=localhost;path=/shadowsocks',
      });
      await waitForPort(pluginPort, plugin, () => logs);
      const template = JSON.parse(await readFile(join(root, 'templates', 'shadowsocks.template.json'), 'utf8'));
      const client = configureClient(template, server, 'localhost');
      delete client.routing;
      const socksPort = await freePort();
      client.inbounds[0].port = socksPort;
      client.outbounds[0].settings.servers[0].address = '127.0.0.1';
      client.outbounds[0].settings.servers[0].port = pluginPort;
      client.outbounds[0].streamSettings = { network: 'tcp', security: 'none' };
      await writeFile(join(dir, 'ss-plugin.json'), JSON.stringify(client));
      const proxy = start(V2RAY_TEST_BINARY, ['run', '-config', 'ss-plugin.json']);
      await waitForPort(socksPort, proxy, () => logs);
      const { stdout } = await run('curl', [
        '--silent', '--show-error', '--fail', '--noproxy', '',
        '--socks5-hostname', `127.0.0.1:${socksPort}`, '--max-time', '10',
        `http://127.0.0.1:${origin.address().port}/`,
      ]);
      assert.equal(stdout, 'proxied-through-websocket', `Shadowsocks plugin: ${logs}`);
    }
  } catch (error) {
    throw new Error(`${activeProtocol}: ${error.message}\n${logs}`, { cause: error });
  } finally {
    if (gateway && gateway.exitCode === null) {
      const exited = new Promise(resolve => gateway.once('exit', resolve));
      await run(NGINX_TEST_BINARY, ['-s', 'quit', '-p', '.', '-c', 'nginx.conf'], { cwd: dir });
      await exited;
    }
    for (const child of children) {
      if (child.exitCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill();
        await exited;
      }
    }
    await new Promise(resolve => origin.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
