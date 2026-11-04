# V2Ray behind Cloudflare and Coolify

All four protocols use WebSocket over HTTPS on public port **443**.

```text
Client -> Cloudflare HTTPS -> Coolify HTTPS proxy
       -> v2ray HTTP gateway :53217 -> core WebSocket inbounds
```

| Protocol | WebSocket path | Internal core port |
|----------|----------------|--------------------|
| VLESS | `/vless` | 53217 |
| VMess | `/vmess` | 53218 |
| Trojan | `/trojan` | 53219 |
| Shadowsocks | `/shadowsocks` | 53220 |

TLS terminates at Cloudflare and Coolify, not at the core. Internal ports
are not published on the host. Plain TCP clients and old links will no longer work.

## Coolify setup

1. Set `V2RAY_HOST=v2ray.hesamian.com` (hostname only, no scheme, path, or port)
   and `V2RAY_UUID` to your shared UUID.
2. Keep `https://v2ray.hesamian.com` attached to the **v2ray** service with
   **internal port 53217**. This service is now the HTTP/WebSocket gateway.
   Do not attach the domain to `core`.
3. Remove domains from **init**: it is a one-shot configuration generator,
   not a web server.
4. Keep the Cloudflare DNS record proxied (orange cloud), enable WebSockets,
   and use **Full (strict)** SSL/TLS with a valid origin certificate in Coolify.
   The origin must be reachable on HTTPS port 443.
   Do not apply interactive challenges or caching rules to the four WS paths.
5. Redeploy the entire Compose application so init regenerates the persistent
   server config and exports. Re-import the new links/QR codes into clients.

Optional FTP exports use `FTP_HOST`, `FTP_USER`, `FTP_PASS`, and `FTP_PATH`
(a directory path ending in `/`). Each protocol gets `client.json`,
`connection.txt`, and `qr.png`. The generated client JSON includes the
public port, TLS SNI, WebSocket Host, and path.

### Shadowsocks compatibility

The `ss://` link includes SIP002 plugin settings:

```text
v2ray-plugin;tls;mux=0;host=v2ray.hesamian.com;path=/shadowsocks
```

Your Shadowsocks app must support and have **v2ray-plugin** installed/enabled.
The plugin's default mode is WebSocket. Keep `mux=0`: the core terminates
Shadowsocks directly rather than the plugin's multiplexing protocol.
A plain Shadowsocks client without
plugin support cannot connect through Cloudflare. V2Ray clients can use the
generated Shadowsocks `client.json` with native WS/TLS instead.
Shadowsocks here carries **TCP only**; native Shadowsocks UDP is not carried
by the WebSocket plugin.

## Rotating credentials

```bash
npm ci
npm run rotate -- v2ray.hesamian.com
# Or supply a UUID to synchronize with Coolify:
npm run rotate -- v2ray.hesamian.com --uuid <uuid>
```

Rotation generates local `v2ray-all/server.json`, `v2ray-all/client.json`,
and the four protocol folders with client configs, links, and QR codes.
It also migrates old TCP configurations to the WebSocket paths above.
If omitted, the hostname is read from `V2RAY_HOST` or the existing VLESS link.

**For this Compose deployment, set the new UUID as `V2RAY_UUID` in Coolify and
redeploy.** Local generated files are not mounted into its named volume;
restarting alone does not apply locally rotated credentials.

## Health checks and troubleshooting

The gateway health check requests `/healthz`; the core checks listening
sockets without opening incomplete protocol connections. This avoids the
old 30-second Shadowsocks `failed to read IV > EOF` log noise.

A healthy container is not proof of public connectivity. After redeployment,
check the gateway through the public domain:

```bash
curl --fail https://v2ray.hesamian.com/healthz
```

Expected response: `ok`. Then connect using a newly exported profile.
Client settings must be TLS on port 443, WebSocket transport, the selected
path, and the same hostname for address, SNI, and WebSocket Host.

## Tests

```bash
npm test
```

Optional runtime tests run actual V2Ray and Nginx binaries when
`V2RAY_TEST_BINARY` and `NGINX_TEST_BINARY` contain their absolute paths.
Set `SS_PLUGIN_TEST_BINARY` too to test Shadowsocks plugin interoperability.
These tests exercise all four WebSocket paths locally; live Cloudflare/Coolify
TLS and DNS must still be verified after deployment.
