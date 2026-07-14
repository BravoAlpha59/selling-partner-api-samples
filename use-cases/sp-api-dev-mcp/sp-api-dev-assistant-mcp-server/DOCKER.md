# Running the Dev Assistant locally with Docker Desktop

Spin up the multi-account HTTP service in a container for testing. This is the
**pre-auth** setup — there is no authentication gateway yet, so run it locally
only and do not expose the port to a network.

## Prerequisites

- Docker Desktop (Compose v2)
- One or more sets of SP-API LWA credentials (client id / secret / refresh token)

## 1. Create your credential vault

The vault maps non-secret **account codes** to LWA credentials and is mounted
read-only. Real vault files are gitignored.

```bash
cp accounts.example.json accounts.json
# edit accounts.json — set a code (e.g. USMAIN) and its clientId/clientSecret/refreshToken/region
```

## 2. Build and run

```bash
docker compose up --build
```

The first build downloads the embedding model and clones the swagger catalog
into the image (a few minutes). Subsequent runs are fast.

- Server: `http://localhost:3000/mcp`
- Health: `http://localhost:3000/healthz` → `{"status":"ok","sessions":N}`

What's baked into the image vs. persisted on the `sp-api-cache` volume:

| Baked at build (in image) | Runtime, on the named volume |
| ------------------------- | ---------------------------- |
| embedding model (`sp_api_reference`) | docs search index (built on first `sp_api_reference`; needs network once) |
| swagger catalog (`sp_api_explore_catalog`, `sp_api_execute`) | SDK clone (fetched on demand by code-generation `clone_repo`) |

## 3. Connect a client

The server speaks MCP Streamable HTTP. Each session is bound to one account via
the `X-SP-API-Account` header at connect time — set it to a code from your vault.

**MCP Inspector** (quickest):

```bash
npx @modelcontextprotocol/inspector
```

In the UI: Transport = "Streamable HTTP", URL = `http://localhost:3000/mcp`, and
add a header `X-SP-API-Account: USMAIN`. Connect, then list/call tools.

**MCP client config** (clients that support HTTP servers, e.g. Cursor):

```json
{
  "mcpServers": {
    "sp-api-dev-assistant": {
      "url": "http://localhost:3000/mcp",
      "headers": { "X-SP-API-Account": "USMAIN" }
    }
  }
}
```

## 4. Quick sanity checks

```bash
# Health
curl -s http://localhost:3000/healthz

# Watch the server bind each session to an account
docker compose logs -f dev-assistant
```

Tools that need no credentials (`sp_api_reference`, `sp_api_optimize`,
`sp_api_generate_code_sample`, `sp_api_migration_assistant`,
`sp_api_explore_catalog`) work immediately. `sp_api_execute` uses the credentials
resolved from the vault for the session's bound account.

## Notes

- The header-bound account **overrides** any `account_code` the agent passes to
  `sp_api_execute` — the account is chosen server-side, and credentials are never
  exposed to the client or the agent.
- Change the header name with `SP_API_ACCOUNT_HEADER`; set a default account with
  `SP_API_ACCOUNT_CODE`; tune session reaping with `SP_API_SESSION_TTL_MS`.
- **Security:** before exposing this beyond localhost, put it behind an
  authenticating gateway that authenticates the user, strips any client-supplied
  account header, and sets its own based on the user's entitlement.
