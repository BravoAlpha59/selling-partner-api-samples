#!/usr/bin/env node

// HTTP (Streamable-HTTP) entry point for the hosted, multi-account service.
//
// One MCP session per connection. The target seller account is bound to the
// session from a request header (default: X-SP-API-Account) at initialize time,
// NOT chosen by the agent. Credentials for that account are resolved entirely
// server-side (see auth/account-credentials) and never leave the process.
//
// AUTH: when AUTH_ENABLED is set, /mcp requires a bearer PAT (the "B2" flow) —
// users authenticate once via OIDC at /auth/login and receive a token to send as
// `Authorization: Bearer`. See src/auth/. When AUTH_ENABLED is unset, /mcp is
// open (local/dev). Account selection stays via the X-SP-API-Account header; the
// simplified model is "any authenticated user may use any configured account".

import express, { type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { setInterval } from "node:timers";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { SharedServices } from "./services.js";
import { createMcpServer } from "./mcp-server.js";
import { TokenStore } from "./auth/token-store.js";
import { OidcClient } from "./auth/oidc.js";
import { createAuthRouter } from "./auth/auth-routes.js";
import {
  createRequireAuth,
  authEnabled,
  type AuthedRequest,
} from "./auth/auth-middleware.js";
import { logger } from "./utils/logger.js";

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataRoot = process.env.SP_API_DEV_ASSISTANT_DATA_DIR || __dirname;

const PORT = parseInt(process.env.PORT || "3000", 10);
const ACCOUNT_HEADER = (
  process.env.SP_API_ACCOUNT_HEADER || "x-sp-api-account"
).toLowerCase();
// Idle sessions are reaped so the session map can't grow unbounded when clients
// disconnect without sending DELETE. TTL is measured from the last request on
// the session; the sweep runs periodically.
const SESSION_TTL_MS = parseInt(
  process.env.SP_API_SESSION_TTL_MS || "1800000", // 30 minutes idle
  10,
);
const SESSION_SWEEP_MS = parseInt(
  process.env.SP_API_SESSION_SWEEP_MS || "60000", // sweep every minute
  10,
);

// Shared once for the whole process — model, catalog, and index load a single time.
const services = new SharedServices(dataRoot);
services.preload();

// B2 auth: a bearer-PAT gate in front of /mcp. No-op unless AUTH_ENABLED is set.
const tokenStore = new TokenStore();
const oidc = OidcClient.fromEnv();
const requireAuth = createRequireAuth(tokenStore);

interface Session {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

// Active sessions, keyed by MCP session id.
const sessions = new Map<string, Session>();

function firstHeader(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: false })); // dev-login form posts

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok", sessions: sessions.size, authEnabled: authEnabled() });
});

// Login / token endpoints (open — they issue and manage credentials).
app.use("/auth", createAuthRouter(tokenStore, oidc));

// Client -> server messages (and session initialization). Gated by requireAuth.
app.post("/mcp", requireAuth, async (req: Request, res: Response) => {
  const sessionId = firstHeader(req.headers["mcp-session-id"]);
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  let transport: StreamableHTTPServerTransport;

  if (existing) {
    existing.lastActivity = Date.now();
    transport = existing.transport;
  } else {
    // A new session may only be opened by an initialize request with no session id.
    if (sessionId || !isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message:
            "No valid session. Send an initialize request (without mcp-session-id) to start one.",
        },
        id: null,
      });
      return;
    }

    // Bind the account for this session from the gateway-supplied header.
    const accountCode = firstHeader(req.headers[ACCOUNT_HEADER]);
    // Authenticated identity (present only when AUTH_ENABLED) — for audit.
    const actor = (req as AuthedRequest).user;

    const newTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport: newTransport, lastActivity: Date.now() });
        logger.info(
          `MCP session ${id} initialized${
            accountCode
              ? ` bound to account ${accountCode}`
              : " (no bound account)"
          }${actor ? ` by user "${actor.username ?? actor.subject}"` : ""}`,
        );
      },
    });

    newTransport.onclose = () => {
      const id = newTransport.sessionId;
      if (id && sessions.delete(id)) {
        logger.info(`MCP session ${id} closed`);
      }
    };

    const server = createMcpServer(services, { accountCode });
    await server.connect(newTransport);

    transport = newTransport;
  }

  await transport.handleRequest(req, res, req.body);
});

// Server -> client SSE stream (GET) and explicit session teardown (DELETE).
async function handleSessionRequest(req: Request, res: Response): Promise<void> {
  const sessionId = firstHeader(req.headers["mcp-session-id"]);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  session.lastActivity = Date.now();
  await session.transport.handleRequest(req, res);
}

app.get("/mcp", requireAuth, handleSessionRequest);
app.delete("/mcp", requireAuth, handleSessionRequest);

// Reap sessions with no request activity within the TTL. Closing the transport
// fires its onclose (which removes it from the map); we also delete here so a
// slow/failed close can't keep the entry around.
function sweepIdleSessions(): void {
  const now = Date.now();
  for (const [id, session] of [...sessions]) {
    const idleMs = now - session.lastActivity;
    if (idleMs > SESSION_TTL_MS) {
      sessions.delete(id);
      logger.info(
        `Reaping idle MCP session ${id} (idle ${Math.round(idleMs / 1000)}s)`,
      );
      session.transport.close().catch(() => {});
    }
  }
}

// unref() so the sweep timer never keeps the process alive on its own.
setInterval(sweepIdleSessions, SESSION_SWEEP_MS).unref();

app.listen(PORT, () => {
  const auth = authEnabled()
    ? `auth ON (${oidc ? "OIDC" : "no OIDC — dev-login only"})`
    : "auth OFF";
  logger.info(
    `SP-API dev-assistant MCP (Streamable HTTP) listening on :${PORT} — account header "${ACCOUNT_HEADER}", ${auth}`,
  );
});
