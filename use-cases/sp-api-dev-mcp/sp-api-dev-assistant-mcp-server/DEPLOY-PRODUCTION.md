# Production deployment (Synology NAS, public domains, no Tailscale)

This runbook deploys the SP-API dev-assistant as a public, authenticated service on
a Synology NAS. Both the identity provider (Authentik) and this service run on the
same NAS, each behind its own public domain with a real TLS certificate.

Throughout, substitute your own values for these placeholders:

| Placeholder | Meaning | Example |
|---|---|---|
| `mcp.example.com` | Public domain for **this** service | `mcp.yourco.com` |
| `auth.example.com` | Public domain for **Authentik** | `auth.yourco.com` |
| `<slug>` | Authentik application slug | `sp-api-dev-assistant` |
| `NAS_LAN_IP` | The NAS's LAN address (upstream target) | `10.0.0.20` |
| `NGINX_LAN_IP` | The NGINX proxy host's LAN address | `10.0.0.10` |

**Assumed topology (per your setup):** a dedicated **NGINX reverse-proxy host** on the LAN
fronts every public access point. It terminates TLS (holds the Let's Encrypt certs) and
forwards **plain HTTP over the LAN** to the NAS. TLS ends at NGINX; NAS↔NGINX is HTTP.

---

## 1. How this differs from the home-lab setup

Removing Tailscale removes two problems and adds two responsibilities.

**Gone:** Tailscale userspace-mode unreachability, and the MTU blackhole. Both were
artifacts of the tunnel; on a normal LAN with a reverse proxy they don't exist.

**Now yours to provide:**

1. **TLS termination.** The container speaks plain HTTP on `:3000` — it has no TLS of
   its own. `tailscale serve` used to terminate HTTPS; in production a **reverse proxy**
   does (Synology's built-in reverse proxy, with a Let's Encrypt cert per domain).

2. **The container → Authentik back-channel.** During login the container calls
   Authentik server-to-server (discovery, token exchange, userinfo). If it tries to reach
   `https://auth.example.com` and your router can't hairpin (NAS → its own public IP →
   back in), that call times out. This is the **same failure** the split-horizon feature
   already solves — so we keep `OIDC_INTERNAL_ORIGIN` pointed at Authentik's local
   address. `OIDC_ISSUER` stays the public URL the browser uses.

### Target topology

```
                 Internet
                    │  :443 → forwarded to the NGINX host only
          ┌─────────▼───────────┐
          │  NGINX proxy host    │  NGINX_LAN_IP
          │  (separate LAN box)  │  Let's Encrypt certs; terminates TLS
          └──┬───────────────┬───┘
   mcp.example.com        auth.example.com
     ↓ HTTP over LAN         ↓ HTTP over LAN
   NAS_LAN_IP:3000        NAS_LAN_IP:9900
          │                    │        ┌──────── the NAS ────────┐
   ┌──────▼──────┐      ┌───────▼──────┐ │                        │
   │ dev-assistant│     │  Authentik   │ │                        │
   │  :3000 (HTTP)│     │  ak-server   │ │                        │
   └──────┬───────┘     └───────▲──────┘ │                        │
          │  back-channel (never leaves the NAS)                  │
          └─ OIDC_INTERNAL_ORIGIN=http://172.17.0.1:9900          │
             (X-Forwarded-Host: auth.example.com)                 │
          └──────────────────────────────────────────────────────┘
```

Note the back-channel stays **inside the NAS** (Docker bridge) — it does not traverse the
NGINX host. Only the two browser-facing legs go through NGINX.

---

## 2. Prerequisites

- DSM 7.2+ with **Container Manager**.
- A dedicated **NGINX reverse-proxy host** on the LAN (this runbook's assumption).
- Two DNS A/AAAA records — `mcp.example.com` and `auth.example.com` — pointing at your
  public IP.
- Router forwards **only** TCP 443 to the **NGINX host** (`NGINX_LAN_IP`), not the NAS.
- The NAS is reachable from the NGINX host on the LAN at `NAS_LAN_IP:3000` and `:9900`.
  On the NAS firewall (Control Panel → Security → Firewall), **allow those two ports only
  from `NGINX_LAN_IP`**, and deny them elsewhere — the container speaks plain HTTP, so it
  must never be reachable except from the proxy.
- Authentik already running on the NAS with your LDAP source configured and users syncing.
- The project cloned on the NAS (on `main`), same as the home-lab layout.

---

## 3. Certificates

Certificates live on the **NGINX host**, managed however you already manage TLS there
(certbot, acme.sh, etc.). You need valid certs for `mcp.example.com` and `auth.example.com`
(or one cert with both as SANs). The NAS holds no certificates — TLS terminates at NGINX,
and NGINX→NAS is plain HTTP over the trusted LAN.

The container never validates a public cert on the back-channel (it uses plain HTTP to
Authentik locally, §7), so no `NODE_EXTRA_CA_CERTS` is ever needed. Certs matter only for
the two browser-facing legs, and those are handled entirely by NGINX.

---

## 4. NGINX configuration

Two server blocks on your NGINX host. The single directive that matters most is
**`proxy_buffering off`** — without it the MCP stream breaks (see the warning below).

Put this `map` once at `http {}` scope (it drives the connection-upgrade header):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

**Server block — this service (`mcp.example.com`):**

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name mcp.example.com;

    ssl_certificate     /etc/letsencrypt/live/mcp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.example.com/privkey.pem;

    location / {
        proxy_pass http://NAS_LAN_IP:3000;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;   # tells the app it's https
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;

        # --- Streamable-HTTP / SSE: the part that is easy to get wrong ---
        proxy_buffering    off;        # REQUIRED — buffering breaks the event stream
        proxy_cache        off;
        proxy_read_timeout 3600s;      # the server→client stream is long-lived
        proxy_send_timeout 3600s;
    }
}
```

**Server block — Authentik (`auth.example.com`):**

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name auth.example.com;

    ssl_certificate     /etc/letsencrypt/live/auth.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/auth.example.com/privkey.pem;

    location / {
        proxy_pass http://NAS_LAN_IP:9900;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;   # Authentik derives its issuer from this
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;
    }
}
```

Reload with `nginx -t && nginx -s reload`.

### ⚠ Why `proxy_buffering off` is not optional

MCP's Streamable-HTTP transport holds a long-lived **Server-Sent Events** stream open for
server→client messages. With nginx's default response buffering, the client connects,
`initialize` returns, and then everything **hangs** — nginx sits on the stream waiting for a
buffer to fill that never fills. `tailscale serve` (home lab) proxied SSE transparently, so
this failure mode is new in production. If a client stalls right after `initialize`, this is
the cause 95% of the time.

`http2 on` is fine and recommended, but do not put this behind an HTTP/1.0-only or
aggressively-caching front layer — the stream needs HTTP/1.1 keep-alive end to end.

---

## 5. Authentik provider

Providers → your OAuth2/OpenID provider → **Redirect URIs** (matching mode **Strict**):

```
https://mcp.example.com/auth/callback
```

That is the single most common cause of a login failing before the password prompt — it
must match `OIDC_REDIRECT_URI` (§6) **byte for byte**: `https`, no port, no trailing slash.

**Trusted proxies — check this or logins break subtly.** Authentik only honors
`X-Forwarded-*` from proxies it trusts; from an untrusted source it ignores them and derives
the issuer from the raw request, producing a wrong `authorization_endpoint`. Two proxies must
be trusted here:

1. The **NGINX host** (`NGINX_LAN_IP`) — for browser logins.
2. The **container's back-channel** (Docker bridge, `172.16.0.0/12`) — for §7.

Authentik trusts private CIDRs by default (`AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS`), which
covers both **as long as `NGINX_LAN_IP` is in a private range** — which it is on a normal LAN.
If you've narrowed that setting, or the NGINX host is on a public/DMZ address, add
`NGINX_LAN_IP/32` and `172.16.0.0/12` explicitly.

Confirm the published issuer is the **public** domain:

```
https://auth.example.com/application/o/<slug>/.well-known/openid-configuration
```

The `issuer` field must read `https://auth.example.com/...`. If it shows a local address,
the reverse proxy isn't forwarding `Host`/`X-Forwarded-Proto` and browser logins will break.

---

## 6. The `.env` file

In the project directory on the NAS, beside `docker-compose.yml`. This file is gitignored;
real secrets live here and nowhere tracked.

```dotenv
# Compose project name — keep stable so CLI and Container Manager target one stack
COMPOSE_PROJECT_NAME=spapi-mcp-server

# --- Auth: MANDATORY in production ---
AUTH_ENABLED=1

# Public issuer (browser-facing). Copy EXACTLY from the discovery doc's `issuer`.
OIDC_ISSUER=https://auth.example.com/application/o/<slug>/
OIDC_CLIENT_ID=<from Authentik>
OIDC_CLIENT_SECRET=<from Authentik>

# Must byte-match the Authentik redirect URI. https, no port, no trailing slash.
OIDC_REDIRECT_URI=https://mcp.example.com/auth/callback

# This service's public base URL — used to render the token page and build the
# callback URL. SET THIS in production so it doesn't depend on proxy headers.
PUBLIC_URL=https://mcp.example.com

# Back-channel to Authentik on the same host, so login doesn't depend on NAT
# hairpin. OIDC_ISSUER stays public; only server-to-server calls take this path.
# Drop this line ONLY if you've confirmed the container can reach
# https://auth.example.com directly.
OIDC_INTERNAL_ORIGIN=http://172.17.0.1:9900

# Shorter token life is reasonable for a public service (default 90).
AUTH_TOKEN_TTL_DAYS=30

# AUTH_DEV_LOGIN must NOT be set. Its presence mints tokens with no IdP.
```

Lock it down:

```
chmod 600 .env accounts.json
```

---

## 7. Why the back-channel, not the public URL

`OIDC_INTERNAL_ORIGIN=http://172.17.0.1:9900` sends the container's OIDC calls to
Authentik's locally-published port over the Docker bridge, while `X-Forwarded-Host:
auth.example.com` tells Authentik to keep advertising the public endpoints the browser
needs. This is deterministic — it doesn't depend on your router hairpinning NAT, which many
consumer/prosumer routers don't. It's plain HTTP but never leaves the NAS.

Confirm Authentik still publishes `9900→9000` (`sudo docker ps | grep ak-server`). If your
Authentik uses a different local port, adjust the origin. A more robust alternative is to put
both stacks on a shared Docker network and use `http://ak-server:9000`; the bridge-gateway
form above is what's already proven in this deployment.

---

## 8. `accounts.json`

Same as home lab: the gitignored vault beside the compose file, mounted read-only. Each
account is `{clientId, clientSecret, refreshToken, region, label}`. `label` is the human name
`sp_api_accounts` surfaces. Back this file up — it is load-bearing and untracked.

---

## 9. Deploy

```
cd <project-dir-on-NAS>
git pull                       # ensure latest main
sudo docker compose up -d --build
sudo docker compose logs -f
```

Watch the startup line for `auth ON (OIDC)`, and — on the first `/auth/login` — the
back-channel line:

```
OIDC: reaching issuer https://auth.example.com via back-channel http://172.17.0.1:9900
```

---

## 10. Verify (in order — each step isolates a layer)

```
# 1. TLS + health, from anywhere on the internet
curl -s https://mcp.example.com/healthz
#    expect: {"status":"ok","sessions":N,"authEnabled":true}

# 2. Auth is enforced (no token → 401)
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mcp.example.com/mcp
#    expect: 401

# 3. Back-channel reaches Authentik (from the container)
sudo docker exec spapi-mcp-server-dev-assistant-1 node -e \
  "fetch('http://172.17.0.1:9900/application/o/<slug>/.well-known/openid-configuration',{headers:{'x-forwarded-host':'auth.example.com','x-forwarded-proto':'https'}}).then(r=>r.json()).then(j=>console.log('issuer:',j.issuer))"
#    expect: issuer: https://auth.example.com/application/o/<slug>/

# 4. Full login — in a browser
#    https://mcp.example.com/auth/login  → Authentik → token page
```

Then wire a client with the token the page prints, reload, and ask
"which accounts do we have?" — a live `sp_api_accounts` proves the whole chain.

---

## 11. Security hardening checklist

- [ ] `AUTH_ENABLED=1` and `/mcp` returns 401 without a token (verified above).
- [ ] `AUTH_DEV_LOGIN` is unset. Confirm: `docker exec … env | grep AUTH_DEV_LOGIN` → empty.
- [ ] Router forwards 443 to the NGINX host only. NAS `:3000`/`:9900` accept traffic solely
      from `NGINX_LAN_IP` (NAS firewall); 9000 is never published off-host.
- [ ] `.env` and `accounts.json` are `chmod 600` and owned by the deploy user.
- [ ] TLS certs valid for both domains; auto-renewal on.
- [ ] `AUTH_TOKEN_TTL_DAYS` set to your policy (default 90; 30 suggested).
- [ ] Redirect URI in Authentik is Strict and matches `OIDC_REDIRECT_URI` exactly.
- [ ] Offboarding path understood: remove the user from LDAP; revoke any live tokens
      (`POST /auth/tokens/:id/revoke`) — LDAP removal blocks new logins but does not
      auto-revoke an already-issued PAT.
- [ ] Consider rate-limiting `/auth/*` at the reverse proxy or a fail2ban jail; these
      endpoints are now internet-facing.

---

## 12. Operations

**Tokens survive redeploys.** They persist as SHA-256 hashes in `tokens.json` inside the
`sp-api-cache` named volume. A `docker compose up -d --build` keeps them. Deleting the
volume invalidates **every** issued token (and drops the search index, which rebuilds).

**Rotating a leaked credential:**
- OIDC client secret → regenerate in Authentik, update `.env`, `docker compose up -d`.
- A user PAT → `POST https://mcp.example.com/auth/tokens/:id/revoke` (list with
  `GET /auth/tokens`, authenticated as that user).

**Backups (do this — both are gitignored and irreplaceable):**
- `accounts.json` — the credential vault.
- `.env` — the deployment config incl. the OIDC secret.

**Updating the code:**
```
cd <project-dir>; git pull; sudo docker compose up -d --build
```
Clients reconnect on their own; a container restart ends in-flight MCP sessions, so users
re-run their client's reconnect (tokens remain valid).

**Rollback:** `git checkout <previous-good-commit>` then rebuild. The vault, tokens, and
config are all outside the image, so a rollback touches only code.

---

## 13. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `/healthz` times out from the internet | NGINX server block wrong, cert issue, 443 not forwarded to NGINX, or NAS firewall blocking `NGINX_LAN_IP` |
| Client connects, then hangs after `initialize` | `proxy_buffering off` missing on the `mcp.example.com` block (§4) |
| Login rejected before password prompt | Redirect URI mismatch (scheme/port/slash) between Authentik and `OIDC_REDIRECT_URI` |
| `OIDC begin-login failed: fetch failed` | Back-channel can't reach Authentik — check `OIDC_INTERNAL_ORIGIN` port and `docker ps` |
| Discovery `issuer` shows a local address | NGINX not sending `Host`/`X-Forwarded-Proto`, or `NGINX_LAN_IP` not in Authentik's trusted CIDRs (§5) |
| `/auth/callback` → "Invalid URL" | `PUBLIC_URL` malformed (stray comment/CRLF in `.env`) |
| Env var set but behavior stale | Container not recreated — `up -d` alone won't rebuild the image; use `--build` |
| Two containers, wrong one serving | `COMPOSE_PROJECT_NAME` mismatch between CLI and Container Manager |
