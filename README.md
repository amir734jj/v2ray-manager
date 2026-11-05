# V2Ray Manager

Manage VLESS, VMess, and Trojan connections over WebSocket behind
Cloudflare and Coolify.

```text
Client :443 -> Cloudflare -> Coolify -> gateway :53217 -> V2Ray
```

## Deploy

1. Deploy [docker-compose.yaml](./docker-compose.yaml) in Coolify with:

   ```text
   V2RAY_UUID=<shared credential>
   V2RAY_HOST=<public hostname>
   DATABASE_URL=<PostgreSQL connection URL>
   ```

   PostgreSQL stores management accounts, sessions, and blocked IPs. Its user
   needs permission to create and update tables and indexes.
2. Attach your public hostname to **gateway port 53217** with WebSocket
   upgrades. Do not attach it to `init` or `v2ray`.
3. Enable Cloudflare proxying and WebSockets. Use **Full (strict)** TLS with
   a valid origin certificate, and exclude tunnel paths and `/socket.io/`
   from caching and interactive challenges.
4. Restrict access to the management page, then open `/register` over HTTPS.
   **The first registrant becomes the administrator.** Later accounts need
   administrator approval.
5. Import your generated client profiles and connect on port **443**.

Management accounts protect the dashboard, not the public tunnel paths.
V2Ray validates tunnel credentials separately.

## Client profiles

Set `FTP_HOST`, `FTP_USER`, `FTP_PASS`, and optionally `FTP_PATH` to upload
each protocol's `client.json`, `connection.txt`, and `qr.png`.

## Dashboard and history

The **Status** page shows connections, CPU, memory, and proxy throughput.
Select **Show history graphs** to see time ranges, zoom, and lowest/highest
values for these metrics. Graphs are hidden by default. Connection attempts
and proxy failures are cumulative and reset when the gateway restarts.
Samples are recorded every five seconds and retained for 24 hours in the
`gateway-metrics` LevelDB volume. Preserve that volume across redeploys.

The administrator can block IPs from the dashboard. Enable
`GATEWAY_TRUST_CLOUDFLARE_HEADERS=true` only when origin access is restricted
to Cloudflare and trusted proxies; otherwise client IP headers can be forged.

The authenticated endpoints `/api/status.json` and
`/api/resource-history?range=1h` expose status and chart data. `/healthz`
checks the gateway listener, but does not prove a client can browse.

## Local development

Install Node.js LTS, npm, Bun, and PostgreSQL:

```bash
npm ci
npm run build
# Set DATABASE_URL and GATEWAY_SECURE_COOKIES=false for local HTTP.
bun gateway/server.js
```

For frontend development, run `npm run dev` in another terminal. Keep secure
cookies enabled in production. The repository uses npm workspaces for the
frontend, gateway, and generator.

## Rotate credentials

```bash
npm run rotate -- <public-hostname>
# Or keep or specify a UUID:
npm run rotate -- <public-hostname> --uuid <uuid>
```

This generates local profiles. Set the UUID in Coolify and **redeploy** to
apply it to the deployed server.

For security, troubleshooting, storage, and configuration details, see the
[operations reference](./docs/operations.md).
