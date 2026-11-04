# V2Ray behind Cloudflare and Coolify

Every generated V2Ray client has two Cloudflare-compatible transports:

- WebSocket through `ws.hesamian.com`
- gRPC through `grpc.hesamian.com`

An observatory probes both outbounds every 30 seconds. V2Fly's `leastping`
balancer sends new connections through the reachable transport with the lowest
measured delay. WebSocket is the fallback until measurements are available.

```text
                                   +-> gateway :53217 (HTTP/1.1 + WS)
Client -> Cloudflare -> Coolify ----+       -> v2ray WS ports 53217-53220
                                   +-> gateway :53317 (HTTP/2 h2c)
                                           -> v2ray gRPC ports 53317-53320
```

TLS terminates at Cloudflare and Coolify. V2Ray receives unencrypted traffic
only across the private Docker network.

## Project structure

```text
gateway/
  Dockerfile          Node.js WebSocket and gRPC gateway image
  server.mjs          Health endpoints, WebSocket and HTTP/2 gRPC routing
  healthcheck.mjs     Checks both gateway listeners
generator/
  Dockerfile          One-shot Coolify init image
  init.mjs            Config, profile, link, QR, and FTP generation
  connections.mjs     Transport, export, and least-ping configuration
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

| Protocol | WS path/port | gRPC service/port |
|----------|--------------|-------------------|
| VLESS | `/vless` / 53217 | `vless-grpc` / 53317 |
| VMess | `/vmess` / 53218 | `vmess-grpc` / 53318 |
| Trojan | `/trojan` / 53219 | `trojan-grpc` / 53319 |
| Shadowsocks | `/shadowsocks` / 53220 | `shadowsocks-grpc` / 53320 |

## Coolify and Cloudflare setup

1. Configure these Coolify environment variables:

   ```text
   V2RAY_UUID=<shared credential>
   V2RAY_HOST=ws.hesamian.com
   V2RAY_GRPC_HOST=grpc.hesamian.com
   ```

2. Configure just two domain routes, both targeting **gateway**:

   | Public domain | Internal gateway port | Upstream protocol |
   |---------------|-----------------------|-------------------|
   | `https://ws.hesamian.com` | 53217 | HTTP (WebSocket upgrades) |
   | `https://grpc.hesamian.com` | 53317 | HTTP/2 cleartext (`h2c`) |

   Public clients use HTTPS port **443** for both domains. The listed ports
   are private container ports, not ports to append to public client URLs.
3. Do not attach domains to `init` or `v2ray`. Remove any old gRPC domain/path
   routes targeting `v2ray` directly.
4. Preserve the full gRPC request path. The gateway routes `/vless-grpc/`,
   `/vmess-grpc/`, `/trojan-grpc/`, and `/shadowsocks-grpc/` to the correct
   V2Ray listener, including all RPC method suffixes.

   The gRPC route still requires `h2c` between Coolify and the gateway.
   If the domain UI has no upstream-protocol option, set the corresponding
   Traefik service's `loadbalancer.server.scheme=h2c` in its routing labels.
   For example, for a service named `gateway-grpc`:

   ```text
   traefik.http.services.gateway-grpc.loadbalancer.server.port=53317
   traefik.http.services.gateway-grpc.loadbalancer.server.scheme=h2c
   ```

   Use the actual service name referenced by the gRPC router, not necessarily
   the example name. Adding an HTTPS domain alone does not configure the
   HTTP/2 upstream. Do not change the WebSocket service's scheme to `h2c`.
5. Create proxied (orange-cloud) Cloudflare DNS records for both hostnames,
   enable **gRPC** and WebSockets under Network, and use **Full (strict)**
   SSL/TLS. The origin must be reachable on HTTPS port 443.
6. Exclude the WS paths and gRPC hostname from interactive challenges and
   caching rules.
7. Redeploy the entire Compose application, then re-import generated profiles.

## Generated profiles and FTP exports

Set `FTP_HOST`, `FTP_USER`, `FTP_PASS`, and optionally `FTP_PATH` to upload:

```text
<protocol>/
  client.json           Automatic WS + gRPC profile using leastping
  connection.txt        WebSocket share link
  qr.png                WebSocket share-link QR
  connection-grpc.txt   gRPC share link (VLESS, VMess, Trojan)
  qr-grpc.png            gRPC share-link QR (VLESS, VMess, Trojan)
```

Portable `ss://` links cannot represent V2Ray-native Shadowsocks over gRPC.
The Shadowsocks `client.json` still includes both native transports and
automatic selection. Its WebSocket link uses:

```text
v2ray-plugin;tls;mux=0;host=ws.hesamian.com;path=/shadowsocks
```

The Shadowsocks app must support `v2ray-plugin`. Both Shadowsocks transports
carry TCP only.

Client outbounds and share URLs are generated in memory by `v2ray-tools`.
The generator keeps deployment-specific transport and least-ping routing
configuration here, without temporary conversion files or custom URL encoders.
All four client templates are required; missing templates fail initialization.

## Automatic selection

Each generated client contains paired tags such as:

```text
trojan-ws
trojan-grpc
```

The corresponding `trojan-auto` balancer uses:

```json
{
  "strategy": { "type": "leastping", "settings": {} },
  "fallbackTag": "trojan-ws"
}
```

The observatory probes `https://cp.cloudflare.com/generate_204`. Selection is
made for new connections; existing connections are not migrated between
transports. Clients that only import share links cannot combine transports:
import `client.json` in a V2Fly-compatible client for automatic selection.

## Rotating credentials

```bash
npm ci
npm run rotate -- ws.hesamian.com --grpc-host grpc.hesamian.com

# Supply an explicit UUID to synchronize with Coolify:
npm run rotate -- ws.hesamian.com \
  --grpc-host grpc.hesamian.com \
  --uuid <uuid>
```

Rotation generates local `v2ray-all/server.json`, `v2ray-all/client.json`, and
the four protocol folders. It also migrates old TCP or WS-only server configs
to paired WS/gRPC inbounds.

For this Compose deployment, set the UUID as `V2RAY_UUID` in Coolify and
redeploy. Local generated files are not mounted into the named volume, so a
restart alone does not apply locally rotated credentials.

## Health checks and troubleshooting

The gateway health check requests `/healthz` on both its HTTP/1.1 and HTTP/2
listeners. V2Ray checks all eight listening sockets without opening incomplete
protocol connections.

Check the public WebSocket gateway:

```bash
curl --fail https://ws.hesamian.com/healthz
```

Expected response: `ok`. The gRPC gateway also serves `/healthz` over HTTP/2,
but a health response does not prove a complete proxy tunnel works; validate
with a generated gRPC profile.

### Read-only status page

For a separate status domain, add `https://v2ray.hesamian.com` in Coolify,
targeting **gateway** on internal port **53217** with ordinary HTTP upstream,
and point its DNS record at the server. Open the domain root to see the page.
This additional domain does not change `V2RAY_HOST` or `V2RAY_GRPC_HOST`.

The page is served at `/` and `/status` on the gateway (so it is also reachable
on the WebSocket hostname). It shows active routed tunnels, total
connection attempts, and proxy errors for each protocol and transport.
The page refreshes every five seconds; `/status.json` provides the same
aggregate data as JSON. Both endpoints also work on the HTTP/2 listener.
Only GET and HEAD are accepted; there are no controls or reset actions.
Express serves the HTTP status routes and renders a Pug template with local
CSS and no browser-side JavaScript or CDN assets. The gRPC listener keeps
native HTTP/2 handling.

Counters are in memory, reset on gateway restart, and represent one process
(not all replicas). Active sockets/streams and attempts are not authenticated
users or proof that browsing works. Health checks, unknown routes, and status
visits are excluded. Errors count proxy transport failures, not gRPC application
status codes. No IPs, credentials, or destinations are exposed on the page.

The endpoints have no built-in authentication: anyone who can reach the
domain can see aggregate activity. Restrict `/status` and `/status.json` with
proxy access controls if needed (including `/`), without protecting the
protocol tunnel paths.

### Client IP and country logs

The gateway uses Pino with `pino-pretty` for compact text logs to stdout,
captured by Docker/Coolify. Lines show UTC time, severity, and a message.
Startup and connections use `INFO`, invalid metadata uses `WARN`, and
proxy/server failures use `ERROR` with the error message. JSON metadata,
stack traces, and ANSI colors are omitted.

The gateway writes one connection record for every recognized WebSocket
upgrade or gRPC stream routed upstream. These are connection attempts, not
proof of V2Ray authentication. Health checks and unknown routes are not logged.

To log visitor identities behind Cloudflare and Coolify:

1. Enable **Network > IP Geolocation** for the domain in Cloudflare.
2. Ensure Coolify/Traefik preserves `CF-Connecting-IP` and `CF-IPCountry`.
3. Restrict origin access to Cloudflare and keep the gateway accessible only
   through trusted proxies. Otherwise direct callers can forge these headers.
4. Set `GATEWAY_TRUST_CLOUDFLARE_HEADERS=true` in Coolify and redeploy.

Example connection log:

```text
[17:00:00] INFO: WS vless | IP=203.0.113.42 | country=US
```

By default, Cloudflare headers are ignored: `IP` is the immediate socket
peer (usually the proxy), and `country` is `unknown`.
Missing or invalid Cloudflare IPs fall back to the socket peer; invalid
metadata emits a warning when header trust is enabled. Missing or invalid
country values are `unknown`. Cloudflare's `XX` (unknown) and `T1` (Tor) codes
are preserved. Country reflects the connecting IP, not necessarily the user's
physical location. No external geolocation lookup is made.

Logs exclude credentials, request paths, and payloads. Treat IP logs as
sensitive data and configure appropriate access and retention in Coolify.

### v2rayNG custom-profile troubleshooting

Generated profiles listen on local SOCKS port `10808`. When importing a full
`client.json` into v2rayNG, its VPN tunnel must use that same local port.
Older exports used `1080`; change their SOCKS inbound port to `10808` and
re-import them, or regenerate and re-import the updated profiles.
If you customized v2rayNG's local proxy port, match the profile to that port.
After importing, select the updated profile and stop/start the VPN.
Do not change the remote outbound port `443`.

Repeated `socks5 client connect` / `socks5 session connect` errors in the
VPN tunnel log can indicate this local port mismatch, even when the core
starts successfully. This is separate from connectivity to the public
WebSocket or gRPC domains.

## Tests

```bash
npm test
```

The always-on gateway tests exercise WebSocket upgrades and bidirectional
HTTP/2 streams for all four protocols, metadata and trailers, cancellation,
upstream failures, and both health checks.
The WebSocket gateway uses `http-proxy-3` to avoid the deprecated
`util._extend` calls in the original `http-proxy`; the tests check for `DEP0060`
warnings after proxying traffic.

Optional runtime tests run actual V2Fly when `V2RAY_TEST_BINARY` contains its
absolute path. Set `SS_PLUGIN_TEST_BINARY` to also test plugin interoperability.
The runtime suite validates all eight protocol/transport combinations and
automatic `leastping` selection through the gateway. Live Cloudflare/Coolify TLS and DNS still
require post-deployment verification.
