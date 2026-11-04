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

## Tests

```bash
npm test
```

The always-on gateway tests exercise WebSocket upgrades and bidirectional
HTTP/2 streams for all four protocols, metadata and trailers, cancellation,
upstream failures, and both health checks.

Optional runtime tests run actual V2Fly when `V2RAY_TEST_BINARY` contains its
absolute path. Set `SS_PLUGIN_TEST_BINARY` to also test plugin interoperability.
The runtime suite validates all eight protocol/transport combinations and
automatic `leastping` selection through the gateway. Live Cloudflare/Coolify TLS and DNS still
require post-deployment verification.
