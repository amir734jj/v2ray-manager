# V2Ray Manager

Manage VLESS, VMess, and Trojan connections over WebSocket behind
Cloudflare and Coolify.

```text
Client :443 -> Cloudflare -> Coolify -> gateway :53217 -> V2Ray
```

## Deploy

1. Deploy [docker-compose.yaml](./docker-compose.yaml) in Coolify with:

   ```text
   V2RAY_HOST=<public hostname>
   DATABASE_URL=<PostgreSQL connection URL>
   ```

   PostgreSQL stores management accounts, sessions, tunnel connections, and blocked IPs. Its user
   needs permission to create and update tables and indexes.
2. Attach your public hostname to **gateway port 53217** with WebSocket
   upgrades. Do not attach it to `init` or `v2ray`.
3. Enable Cloudflare proxying and WebSockets. Use **Full (strict)** TLS with
   a valid origin certificate, and exclude tunnel paths, `/subscriptions/`, and `/socket.io/`
   from caching and interactive challenges.
4. Restrict access to the management page, then open `/register` over HTTPS.
   **The first registrant becomes the administrator.** Later accounts need
   administrator approval.
5. On **Users**, activate an account and choose **Create connection**. Save its
   private subscription URL, add it in v2rayNG, and update subscriptions.
   Clients connect on port **443**.

Tunnel access uses per-user private paths and credentials, not dashboard cookies.
Do not expose V2Ray's internal ports or its unauthenticated management API.

## Per-user connections

Administrators can **Pause**, **Resume**, **Reset credentials**, or
**Replace subscription URL** from **Users**. Pausing closes only that user's
tunnels; changes are applied live without restarting V2Ray or other users.
The same profiles work after resuming. Resetting credentials invalidates old
profiles and issues a new subscription URL. Private subscription URLs remain
visible and copyable in the administrator's responsive user cards after reloading.
Older connections store only a token hash: their URLs keep working, but an
administrator must replace the URL once to make it displayable.

The administrator's Users page also shows each user's open gateway tunnels,
oldest open tunnel time, upload/download speed, and last observed socket traffic.
These are socket measurements, not device counts or proof of authentication.
Separate V2Ray totals show traffic attributed to authenticated credentials since
the core started. Both update about every five seconds; failures mark core
totals stale instead of reporting zero. Redeploy `init` and V2Ray once to enable
the StatsService and user counters.

The deployment no longer accepts `V2RAY_UUID` or shared FTP profiles. Existing
clients need new private subscriptions after upgrading. Remove old FTP exports
manually. Expiration and device limits are not implemented yet.

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
# Set DATABASE_URL, V2RAY_HOST, V2RAY_API_ADDRESS, and
# GATEWAY_SECURE_COOKIES=false for local HTTP.
bun gateway/server.js
```

For frontend development, run `npm run dev` in another terminal. Keep secure
cookies enabled in production. The repository uses npm workspaces for the
frontend, gateway, and generator.

## Offline profile generation

```bash
npm run rotate -- <public-hostname>
# Or keep or specify a UUID:
npm run rotate -- <public-hostname> --uuid <uuid>
```

This generates standalone local profiles, not managed subscriptions. It does
not modify deployed per-user credentials. Use **Reset credentials** on **Users**
for managed connections.

For security, troubleshooting, storage, and configuration details, see the
[operations reference](./docs/operations.md).
