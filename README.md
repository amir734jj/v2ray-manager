# V2Ray behind Cloudflare and Coolify

VLESS, VMess, Trojan, and Shadowsocks use WebSocket over HTTPS through
`ws.hesamian.com`.

```text
Client -> Cloudflare -> Coolify -> gateway :53217
                                      -> v2ray WS ports 53217-53220
```

TLS terminates at Cloudflare and Coolify. V2Ray receives unencrypted traffic
only across the private Docker network. Each client uses a single WebSocket
outbound per protocol; there is no transport balancing or observatory.

## Project structure

```text
gateway/
  Dockerfile          Node.js WebSocket gateway and status image
  server.mjs          Health endpoint and WebSocket routing
  healthcheck.mjs     Gateway HTTP health check
  status.mjs          Express status routes and connection counters
  status.pug          Bootstrap status page
generator/
  Dockerfile          One-shot Coolify init image
  init.mjs            Config, profile, link, QR, and FTP generation
  connections.mjs     WebSocket server/client configuration and share links
  rotate-id.mjs       Local credential rotation command
v2ray/
  Dockerfile          V2Ray runtime image
  templates/          Server and client configuration templates
tests/
  connections.test.mjs
  gateway.test.mjs
  runtime.test.mjs
docker-compose.yaml
```

| Protocol | WebSocket path | Internal V2Ray port |
|----------|----------------|---------------------|
| VLESS | `/vless` | 53217 |
| VMess | `/vmess` | 53218 |
| Trojan | `/trojan` | 53219 |
| Shadowsocks | `/shadowsocks` | 53220 |

## Coolify and Cloudflare setup

1. Configure these Coolify environment variables:

   ```text
   V2RAY_UUID=<shared credential>
   V2RAY_HOST=ws.hesamian.com
   ```

2. Attach `https://ws.hesamian.com` to **gateway**, internal port **53217**,
   using ordinary HTTP upstream with WebSocket upgrades.
3. Optionally attach `https://v2ray.hesamian.com` to the same gateway port
   for the read-only status page. This does not change `V2RAY_HOST`.
4. Do not attach domains to `init` or `v2ray`. No custom proxy labels,
   HTTP/2 upstream configuration, or Coolify resource ID variables are needed.
5. Point Cloudflare DNS records for the chosen hostnames at the server.
   Enable proxying (orange cloud) and WebSockets, and use **Full (strict)**
   SSL/TLS with a valid origin certificate. HTTPS port 443 must be reachable.
6. Exclude WebSocket paths from interactive challenges and caching rules.
7. Deploy the entire Compose application and re-import generated profiles.
   Public clients use port **443**, not internal port 53217.

### Migrating an older dual-transport deployment

Remove the old `grpc.hesamian.com` / `www.grpc.hesamian.com` routes from Coolify,
any manually configured h2c labels, and `V2RAY_GRPC_HOST` from environment
variables. The Compose file no longer exposes the old ports or defines
HTTP/2 routing. Remove unused DNS records if desired.

Regenerate and re-import profiles: older downloaded files do not update
automatically. Local rotation removes obsolete `connection-grpc.txt` and
`qr-grpc.png` files and migrates older client balancer rules to direct WebSocket
outbounds. Server migration drops the obsolete listeners while preserving
WebSocket ports and credentials. Initialization rewrites the mounted server
configuration from the WebSocket template.

Existing obsolete files on the FTP server are not deleted automatically;
remove those two filenames from each remote protocol folder manually.

## Generated profiles and FTP exports

Set `FTP_HOST`, `FTP_USER`, `FTP_PASS`, and optionally `FTP_PATH` to upload:

```text
<protocol>/
  client.json      WebSocket profile
  connection.txt   WebSocket share link
  qr.png           WebSocket share-link QR
```

All four client templates are required; missing templates fail initialization.
Client outbounds and share URLs are generated in memory by `v2ray-tools`,
without temporary conversion files or custom URL encoders.

Shadowsocks share links require an app supporting `v2ray-plugin`:

```text
v2ray-plugin;tls;mux=0;host=ws.hesamian.com;path=/shadowsocks
```

Shadowsocks carries TCP only; its local SOCKS UDP support is disabled.

## Rotating credentials

```bash
npm ci
npm run rotate -- ws.hesamian.com

# Supply an explicit UUID to synchronize with Coolify:
npm run rotate -- ws.hesamian.com --uuid <uuid>
```

Rotation generates `v2ray-all/server.json`, `v2ray-all/client.json`, and the
four protocol folders. Existing TCP server configurations are migrated to WS.

For this Compose deployment, set the UUID as `V2RAY_UUID` in Coolify and
redeploy. Local generated files are not mounted into the named volume, so a
restart alone does not apply locally rotated credentials.

## Health checks and troubleshooting

The gateway health check requests `/healthz`. V2Ray checks its four listening
sockets without opening incomplete protocol connections.

```bash
curl --fail https://ws.hesamian.com/healthz
```

Expected response: `ok`. This does not prove a complete authenticated proxy
tunnel works; also test browsing with an imported profile.

### Read-only status page

Open `https://v2ray.hesamian.com` after adding that domain to the gateway.
The page is served at `/` and `/status` (also reachable on the WS hostname).
It displays active tunnels, total attempts, and proxy errors by protocol and
country. It refreshes every five seconds; `/status.json` provides the same
aggregate data. Only GET and HEAD are accepted; no reset or control actions
are exposed.

Express handles only the status routes. The page uses Pug and locally bundled
Bootstrap CSS, without custom styles, browser-side JavaScript, or CDN assets.
WebSocket proxying and health endpoints use native HTTP handlers.

Counters reset on restart and represent one process, not all replicas.
Attempts include failed connections; open sockets are not authenticated users
or proof that browsing works. Health checks, unknown routes, and status visits
are excluded. No IPs, credentials, or destinations are displayed.

The country table uses trusted Cloudflare metadata when
`GATEWAY_TRUST_CLOUDFLARE_HEADERS=true`. Missing, invalid, untrusted, or `XX`
values appear as Unknown; `T1` appears as Tor. No geolocation API is called.

There is no built-in status authentication. Anyone reaching the domain can
see aggregate activity. Restrict `/`, `/status`, and `/status.json` with proxy
access controls if needed, without protecting WebSocket tunnel paths.

### Client IP and country logs

Pino and `pino-pretty` write compact text logs to stdout for Docker/Coolify.
Lines show UTC time, severity, and a message. Startup and connections use INFO,
invalid metadata uses WARN, and proxy/server failures use ERROR. JSON metadata,
stack traces, and ANSI colors are omitted.

Each recognized WebSocket upgrade routed upstream generates one connection
record. This is an attempt, not proof of V2Ray authentication.

To use Cloudflare client metadata:

1. Enable **Network > IP Geolocation** in Cloudflare.
2. Ensure Coolify preserves `CF-Connecting-IP` and `CF-IPCountry`.
3. Restrict origin access to Cloudflare and trusted proxies; otherwise callers
   can forge these headers.
4. Set `GATEWAY_TRUST_CLOUDFLARE_HEADERS=true` in Coolify and redeploy.

```text
[17:00:00] INFO: WS vless | IP=203.0.113.42 | country=US
```

By default, Cloudflare headers are ignored: IP is the socket peer and country
is unknown. Invalid metadata is ignored and logged when trust is enabled.
Country reflects the connecting IP, not necessarily the user's location.
Logs exclude credentials, paths, and payloads. Treat IP logs as sensitive
and configure appropriate access and retention in Coolify.

### v2rayNG custom-profile troubleshooting

Generated profiles listen on local SOCKS port **10808**. The v2rayNG VPN
tunnel must use the same local port. Older exports used 1080: regenerate
and re-import them, or change the SOCKS inbound port to 10808. If you customized
v2rayNG's local proxy port, match the profile to that port.

After importing, select the updated profile and stop/start the VPN.
Do not change remote outbound port 443. Repeated `socks5 client connect`
errors can indicate a local port mismatch even when the core starts.

## Tests

```bash
npm test
```

Gateway tests cover all four WebSocket routes, binary streaming, health checks,
status counters, countries, metadata validation, and failed upstreams.
Generator tests cover all profiles, share links, rotation, and migration.

Set `V2RAY_TEST_BINARY` to the absolute path of a V2Fly binary for actual
proxy traffic tests through all four WebSocket outbounds. Optionally set
`SS_PLUGIN_TEST_BINARY` to test Shadowsocks plugin interoperability.
Live Cloudflare/Coolify TLS and DNS still require post-deployment verification.
