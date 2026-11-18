# Blocked IP notice plan

## Goal and limitations

Give someone whose IP is blocked from the V2Ray gateway a page explaining
the block and how to contact the administrator. The person must open the
gateway's own URL, for example `https://gateway.example/blocked`, directly
or through another working connection.

Do not intercept DNS, install certificates, or try to replace arbitrary
websites. The gateway rejects a blocked client's WebSocket handshake before
website traffic reaches V2Ray. A proxy client cannot display the handshake
response as a browser page, and an HTTPS destination cannot be replaced with
the gateway's page without a trusted certificate for that destination.
There is no automatic browser redirect to the notice.

## Proposed implementation

1. Add a dedicated, unauthenticated `GET /blocked` page on the gateway's
   existing public hostname. Use the existing HTTPS termination and certificate
   if already configured; this feature must not require certificate changes.
   Keep the page self-contained so it can render without frontend assets or
   JavaScript. Say "Your IP address is blocked from using this proxy" and
   advise contacting the administrator. Do not display private tunnel or
   subscription URLs.
2. Resolve the request's client IP with the same `clientAddress` helper and
   proxy-trust settings used for WebSocket upgrades. Pass the existing stored
   blocklist, logger, `trustProxy`, and Cloudflare-header setting to the HTTP
   handler; do not independently trust forwarded headers or use Express's
   request IP with different trust rules.
3. Check the current blocklist on each request. Return the HTML notice with
   HTTP 403 for a blocked IP. For an unblocked IP, return a clear "Your IP
   address is not blocked" message with HTTP 200. If the IP cannot be
   determined, return an explicit error rather than claiming either result.
   Support `HEAD` consistently with `GET`, reject other methods, and prevent
   caches from retaining the result.
4. Keep the existing behavior everywhere else: blocking still disconnects
   matching tunnels and rejects new WebSocket upgrades; unblocking allows
   future connections. Preserve access to the status page, management APIs,
   subscriptions, `/healthz`, and normal tunnel routing. Do not redirect
   unrelated requests or expose block status through credential-bearing URLs.
5. Document the direct notice URL and its limitations in
   [operations.md](./operations.md). Explain that the browser must reach the
   gateway independently if the blocked proxy is its only network route, and
   that a shared or changed public IP can affect the result. Operators must
   expose the notice path through any external gateway access policy.

## Verification

- Exercise `GET` and `HEAD` for blocked and unblocked IPv4 and IPv6 addresses,
  then block and unblock an address and confirm the result changes immediately.
- Verify unknown client IP and unsupported methods produce explicit errors,
  responses are not cached, and forwarded headers cannot spoof the client IP
  from an untrusted peer. Cover trusted reverse proxy and Cloudflare behavior
  using the same rules as tunnel upgrades.
- Confirm blocking still disconnects active tunnels and rejects new upgrades,
  unblocking restores them, and the status page, management APIs,
  subscriptions, health check, and unrelated routes retain their behavior.
- Check the notice in a browser using the gateway URL, without installing a
  certificate or modifying DNS. Verify it works with JavaScript disabled.
