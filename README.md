# V2Ray Manager

VLESS, VMess, Trojan, and Shadowsocks over WebSocket, behind Cloudflare and Coolify.

```text
Client :443 -> Cloudflare -> Coolify -> gateway :53217 -> V2Ray
```

| Protocol | WebSocket path | Internal V2Ray port |
|----------|----------------|---------------------|
| VLESS | `/vless` | 53217 |
| VMess | `/vmess` | 53218 |
| Trojan | `/trojan` | 53219 |
| Shadowsocks | `/shadowsocks` | 53220 |

## Deploy

1. Deploy [docker-compose.yaml](./docker-compose.yaml) in Coolify with:

   ```text
   V2RAY_UUID=<shared credential>
   V2RAY_HOST=ws.hesamian.com
   ```

2. Attach `https://ws.hesamian.com` to **gateway port 53217**, using HTTP
   upstream with WebSocket upgrades. Do not attach domains to `init` or `v2ray`.
3. Optionally attach `https://v2ray.hesamian.com` to the same port for status.
4. Point Cloudflare DNS at the server, enable proxying and WebSockets, and use
   **Full (strict)** TLS with a valid origin certificate. Exclude tunnel paths
   from caching and interactive challenges.
5. Deploy and import the generated profiles. Clients use **port 443**.

## Profiles

Set `FTP_HOST`, `FTP_USER`, `FTP_PASS`, and optionally `FTP_PATH` to upload
these files for each protocol:

- `client.json` - client profile
- `connection.txt` - share link
- `qr.png` - share-link QR code

Shadowsocks links require a client supporting `v2ray-plugin`; Shadowsocks is
TCP-only. Generated SOCKS listeners use local port **10808**.

Old files, profiles, and Coolify routes must be removed manually. There is no
automatic legacy cleanup or migration; regenerate and re-import old profiles.

## Rotate credentials

```bash
npm ci
npm run rotate -- ws.hesamian.com

# Or choose the UUID:
npm run rotate -- ws.hesamian.com --uuid <uuid>
```

This writes local server/client configs and protocol exports. Existing configs
must already use WebSocket; remove older configs to regenerate from templates.

Set the new `V2RAY_UUID` in Coolify and **redeploy**. Restarting alone does not
apply locally generated files.

## Status and logs

- **Status:** `https://v2ray.hesamian.com` (or `/status` on the gateway).
  Refreshes every **5 seconds**, with active tunnels, attempts, and errors by
  protocol and country. `/status.json` provides the same counters.
- **Health:** `https://ws.hesamian.com/healthz` returns `ok`.
- **Logs:** connection attempts and proxy errors appear in Coolify stdout.

Counters reset on restart. Open tunnels and healthy listeners do not prove
authenticated browsing works. The status page shows no IPs or credentials,
but is public unless you restrict its routes separately from tunnel paths.

For country counters and real client IP logs, enable Cloudflare IP Geolocation,
preserve `CF-Connecting-IP` / `CF-IPCountry`, and set
`GATEWAY_TRUST_CLOUDFLARE_HEADERS=true`. Only enable this when origin access is
restricted to Cloudflare and trusted proxies; otherwise headers can be forged.
By default, country is Unknown and logs use the socket peer IP. Restrict access
to IP logs and configure retention.

If v2rayNG connects but browsing fails, ensure its local SOCKS port matches
**10808**, re-import the updated profile, and restart the VPN.

## Tests

```bash
npm test
```

Set `V2RAY_TEST_BINARY` to a V2Fly executable for live local proxy tests.
Optionally set `SS_PLUGIN_TEST_BINARY` to test Shadowsocks plugin compatibility.
