# V2Ray behind Cloudflare and Coolify

Every generated V2Ray client has two Cloudflare-compatible transports:

- WebSocket through `ws.hesamian.com`
- gRPC through `grpc.hesamian.com`

An observatory probes both outbounds every 30 seconds. V2Fly's `leastping`
balancer sends new connections through the reachable transport with the lowest
measured delay. WebSocket is the fallback until measurements are available.

```text
                         +-> Node gateway :53217 -> WS inbounds 53217-53220
Client -> Cloudflare ----+
                         +-> Coolify UI h2c routes -> gRPC inbounds 53317-53320
```

TLS terminates at Cloudflare and Coolify. V2Ray receives unencrypted traffic
only across the private Docker network.

## Project structure

```text
gateway/
  Dockerfile          Node.js WebSocket gateway image
  server.mjs          Health endpoint and WebSocket routing
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

2. Attach `https://ws.hesamian.com` to the **gateway** service on internal
   port **53217**. Do not attach this domain to `v2ray`.
3. Do not add a Coolify domain to `init`.
4. In the Coolify UI, add these four routes to the **v2ray** service. Configure
   each upstream as cleartext HTTP/2 (`h2c`), while the public URL remains
   HTTPS:

   | Public route | Internal port |
   |--------------|---------------|
   | `https://grpc.hesamian.com/vless-grpc` | 53317 |
   | `https://grpc.hesamian.com/vmess-grpc` | 53318 |
   | `https://grpc.hesamian.com/trojan-grpc` | 53319 |
   | `https://grpc.hesamian.com/shadowsocks-grpc` | 53320 |

   Coolify must preserve the complete gRPC path below each prefix.
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

The gateway health check requests `/healthz`. V2Ray checks all eight listening
sockets without opening incomplete protocol connections.

Check the public WebSocket gateway:

```bash
curl --fail https://ws.hesamian.com/healthz
```

Expected response: `ok`. Cloudflare's gRPC hostname does not expose a normal
HTTP health page; validate it using a generated gRPC profile.

## Tests

```bash
npm test
```

Optional runtime tests run actual V2Fly when `V2RAY_TEST_BINARY` contains its
absolute path. Set `SS_PLUGIN_TEST_BINARY` to also test plugin interoperability.
The runtime suite validates all eight protocol/transport combinations and
automatic `leastping` selection. Live Cloudflare/Coolify TLS and DNS still
require post-deployment verification.
