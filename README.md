# V2Ray Manager

Manage VLESS, VMess, Trojan, and Shadowsocks connections over WebSocket behind
Cloudflare and Coolify.

```text
Client :443 -> Cloudflare -> Coolify -> gateway :53217 -> V2Ray
```

The Bun gateway handles VLESS, VMess, Trojan, and Shadowsocks in one process and forwards
WebSockets directly to V2Ray. It owns authentication, blocking, dashboard state,
and a single PostgreSQL pool capped at two connections.

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
5. On **Subscriptions**, enter a name and choose **Create subscription**. Save its
   private subscription URL, add it in v2rayNG, and update subscriptions.
   Clients connect on port **443**.

Tunnel access uses subscription-specific private paths and credentials, not dashboard cookies.
The gateway forwards WebSockets directly to V2Ray, without intermediate proxy
workers. Tunnel authorization uses an in-memory snapshot updated by subscription
controls and periodic database reconciliation, not a database query per connection.
Do not expose V2Ray's internal ports or its unauthenticated management API.

For filtered networks, configure v2rayNG's tunneled DNS and hostname recovery;
connection-link subscriptions cannot set these app preferences. See
[DNS poisoning protection](./docs/operations.md#dns-poisoning-protection).

## Independent subscriptions

Administrators can create as many named subscriptions as needed, without
creating or activating dashboard accounts. **Users** manages dashboard access
only. Each subscription has its own credentials, URL, controls, and traffic
statistics across VLESS, VMess, Trojan, and Shadowsocks.

Each subscription response sorts links alphabetically by URL scheme without
changing existing credentials or connection settings.
VMess keeps its original embedded `vmess-ws` name and
has no URL fragment.

After deploying the update, refresh existing subscription URLs to receive the
additional Shadowsocks profile; existing VLESS, VMess, and Trojan profiles remain
unchanged. Shadowsocks uses `aes-256-gcm` over WebSocket + TLS on the same hostname
and port 443. For current v2rayNG clients, the gateway detects their default
`v2rayNG/<version>` User-Agent and supplies Shadowsocks as a native `v2rayn://`
profile, preserving WebSocket, TLS, SNI, Host, and path. v2rayNG's `ss://` importer
ignores these plugin settings, causing a raw TCP connection to HTTPS port 443 and
`cipher: message authentication failed` / `io: read/write on closed pipe`.
Update v2rayNG, leave its subscription User-Agent at the default, and refresh the
existing subscription after deploying this fix.
Other clients receive a SIP002 `ss://` link specifying `v2ray-plugin`, TLS, and
`mux=0`; they must support that plugin/transport. This is TCP over WebSocket,
not a native Shadowsocks UDP listener. Each subscription has its own private
Shadowsocks inbound and password; no new public port or database migration is needed.

Administrators can **Pause**, **Resume**, **Reset credentials**, **Delete subscription**, or
**Replace subscription URL** from **Subscriptions**. Pausing closes only that subscription's
tunnels; changes are applied live without restarting V2Ray or other users.
The same profiles work after resuming. Resetting credentials invalidates old
profiles and issues a new subscription URL. Private subscription URLs remain
visible and copyable in the administrator's responsive user cards after reloading.
Older connections store only a token hash: their URLs keep working, but an
administrator must replace the URL once to make it displayable.
Deleting a subscription requires confirmation, closes its tunnels, and permanently
removes its credentials and URL without affecting other subscriptions.
Set a **Concurrent IP limit** when creating a subscription or edit it later.
`0` means unlimited (the default for new and existing subscriptions). The limit
counts active public IPs across all four protocols, not physical devices.
New IPs are rejected at the limit; existing IPs can keep opening tunnels.
Lowering the limit does not disconnect existing IPs. Devices sharing a public
IP count together, and one device can use more than one IP.

The gateway expects the current database schema. Legacy subscription schemas
are no longer upgraded automatically; existing deployments must already have
the schema changes applied.

Administrator-only API and realtime snapshots retain each subscription's open gateway tunnels,
oldest open tunnel time, upload/download speed, and last observed socket traffic.
The Subscriptions page shows these statistics, connected IPs, and accumulated
core upload/download totals alongside management controls, without explanatory panels.
When no tunnels are open, saved totals and previous activity remain visible.
Each card shows a green **Online** badge while at least one gateway tunnel is open,
or a red **Offline** badge when none are open, separately from Enabled/Paused.
If live updates fail, the badge turns gray and reads **Status unknown** until updates resume.
These are socket measurements, not device counts or proof of authentication.
Separate V2Ray totals retain accumulated traffic attributed to authenticated credentials,
persisted with Sequelize in embedded SQLite across gateway and V2Ray restarts.
Both update about every five seconds; collection or storage failures mark core
totals stale instead of reporting zero. Preserve the `gateway-metrics` volume.
Accumulated totals are separate from the charts' 24-hour retention.
Traffic not sampled before a V2Ray reset cannot be recovered.
Redeploy `init` and V2Ray once to enable
the StatsService and user counters.

Subscription cards also show **Recent destinations**: the latest 50
observed domains and their last observation times. Domains are attributed to
authenticated V2Ray credentials, saved in SQLite, and removed after the configured
retention period without another observation (24 hours by default). Administrators
can save a positive whole number of hours under **Domain retention (hours)** on
the **Destinations** tab. This applies to all subscriptions and survives restarts.
Shortening retention expires older history; increasing it cannot restore deleted
history. Only administrators can view domains or change retention. Background apps
also generate connections; this is not browser history or proof of a page visit.
Inform subscribers about destination monitoring. Rebuild/redeploy **init, V2Ray,
and gateway** to enable the required `LoggerService` and sniffed-destination
logging policy. Collection begins after deployment; old activity is not imported.

The administrator-only **Destinations** tab searches all saved domains from the
configured retention window by domain or subscription name. It shows the subscription and last
observation time, with 50 rows per page and no 50-record history cap. Search and
pagination run on the server; use **Refresh** to return to the newest results.

The gateway automatically discovers Coolify's `coolify-proxy` container through
Docker DNS at startup and refreshes its addresses every 30 seconds. No proxy-IP
configuration or hardcoded container address is needed. Coolify's automatically
injected `COOLIFY_RESOURCE_UUID` also scopes a lookup to the application network,
so both shared-network and application-network proxy addresses are discovered.
Only that service's
private IPv4/IPv6 addresses are trusted, not every private IP or subnet.
The gateway reads `X-Forwarded-For` from the discovered proxy, stopping at the
first untrusted address from the right. Discovery failures are logged and clear
proxy trust until DNS recovers; direct clients still use their socket IP.
Keep the gateway port private and have Traefik
sanitize incoming forwarded headers. Cloudflare detection is automatic by default
(`GATEWAY_TRUST_CLOUDFLARE_HEADERS=auto`): use `CF-Connecting-IP` and `CF-IPCountry`
when the socket peer, or source resolved through trusted proxies, belongs to
Cloudflare's published IP ranges. Otherwise use the forwarded or direct socket IP.
The presence of Cloudflare headers alone does not establish trust.

The deployment no longer accepts `V2RAY_UUID` or shared FTP profiles. Existing
clients need new private subscriptions after upgrading. Remove old FTP exports
manually. Expiration and physical-device identification are not implemented.

## Dashboard and history

The **Status** page shows connections, CPU, memory, and proxy throughput.
Administrators also see **Online subscriptions**, listing subscription names,
connected IPs, open tunnels, upload/download speeds, and connection start times.
Connect/disconnect changes arrive live; rates update every five seconds.
Online means an open gateway tunnel, not verified browsing health.
The **Active clients by IP** table also shows all associated subscriptions for
each IP; expand an IP to see the exact subscription alongside each connection's
country. Shared IPs can belong to multiple subscriptions. These details are
administrator-only.
Select **Show history graphs** to see time ranges, zoom, and lowest/highest
values for these metrics. Graphs are hidden by default. Connection attempts
and proxy failures are cumulative and reset when the gateway restarts.
Samples are recorded every five seconds and retained for 24 hours in the
`gateway-metrics` volume in `metrics.sqlite`. Preserve that volume across redeploys.
The SQLite upgrade starts fresh: old LevelDB files are left untouched but are not
imported. Charts start empty; traffic totals start from the currently available
V2Ray counters. PostgreSQL accounts and subscriptions are unchanged.

The administrator can block IPs from the dashboard.
`GATEWAY_TRUST_CLOUDFLARE_HEADERS=false` disables Cloudflare metadata.
The `true` setting also requires a verified Cloudflare source; merely sending
Cloudflare headers cannot override a direct client's IP.

Gateway logs are readable plain text. Every five seconds, a connection snapshot
lists connected subscriptions and client IPs, protocols, open tunnels, and
upload/download Mbps, followed by protocol totals. Errors retain readable
details and stacks rather than inline JSON. Logs contain subscription names
and IPs; restrict access and retention. Credentials and subscription URLs are
not included in snapshots.

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
not modify deployed subscription credentials. Use **Reset credentials** on **Subscriptions**
for managed connections.

For security, troubleshooting, storage, and configuration details, see the
[operations reference](./docs/operations.md).
