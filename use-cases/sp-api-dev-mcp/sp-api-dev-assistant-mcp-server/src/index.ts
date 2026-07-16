#!/usr/bin/env node

// stdio entry point.
//
// Launched as a subprocess by a local MCP client (Claude Desktop, Cursor, Kiro).
// A single connection => a single account context, resolved from SP_API_ACCOUNT_CODE
// / the sole vault account / SP_API_* env credentials (see auth/account-credentials).
// For the hosted, multi-account service, use the HTTP entry point in http.ts.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { SharedServices } from "./services.js";
import { createMcpServer } from "./mcp-server.js";

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// When running from the consolidated bundle, the wrapper sets this env var
// to point to the data directory (pre-built index, resources, etc.)
const dataRoot = process.env.SP_API_DEV_ASSISTANT_DATA_DIR || __dirname;

async function main(): Promise<void> {
  const services = new SharedServices(dataRoot);
  const server = createMcpServer(services);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Pre-load embedding model and initialize search index (non-blocking).
  services.preload();
}

main().catch(() => {
  process.exit(1);
});
