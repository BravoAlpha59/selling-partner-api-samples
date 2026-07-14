#!/usr/bin/env node

// HTTP (Streamable-HTTP) entry point for the hosted, multi-account service.
//
// One MCP session per connection. The target seller account is bound to the
// session from a request header (default: X-SP-API-Account) at initialize time,
// NOT chosen by the agent. Credentials for that account are resolved entirely
// server-side (see auth/account-credentials) and never leave the process.
//
// SECURITY: /mcp must sit behind a trusted authenticating gateway (ALB + auth,
// API gateway, or an auth middleware added here) that:
//   1. authenticates the user, and
//   2. STRIPS any client-supplied account header and sets its own based on the
//      user's entitlement.
// Without that, a direct caller could set the header to any account code. This
// entry point wires transport + binding; authentication is a separate layer.

import express, { type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { SharedServices } from "./services.js";
import { createMcpServer } from "./mcp-server.js";
import { logger } from "./utils/logger.js";

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataRoot = process.env.SP_API_DEV_ASSISTANT_DATA_DIR || __dirname;

const PORT = parseInt(process.env.PORT || "3000", 10);
const ACCOUNT_HEADER = (
  process.env.SP_API_ACCOUNT_HEADER || "x-sp-api-account"
).toLowerCase();

// Shared once for the whole process — model, catalog, and index load a single time.
const services = new SharedServices(dataRoot);
services.preload();

// Active sessions, keyed by MCP session id.
const transports = new Map<string, StreamableHTTPServerTransport>();

function firstHeader(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok", sessions: transports.size });
});

// Client -> server messages (and session initialization).
app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = firstHeader(req.headers["mcp-session-id"]);
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
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

    const newTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, newTransport);
        logger.info(
          `MCP session ${id} initialized${
            accountCode ? ` bound to account ${accountCode}` : " (no bound account)"
          }`,
        );
      },
    });

    newTransport.onclose = () => {
      const id = newTransport.sessionId;
      if (id && transports.delete(id)) {
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
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transport.handleRequest(req, res);
}

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

app.listen(PORT, () => {
  logger.info(
    `SP-API dev-assistant MCP (Streamable HTTP) listening on :${PORT} — account header "${ACCOUNT_HEADER}"`,
  );
});
