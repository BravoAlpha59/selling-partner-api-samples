// src/auth/token-store.ts
//
// Personal Access Token (PAT) store for the "B2" auth path: after a user
// authenticates once in the browser (OIDC), the gateway mints a long-lived,
// revocable token that the user configures as an `Authorization: Bearer` header
// in their MCP client. The gateway validates that token on every /mcp request.
//
// Tokens are opaque random strings; only their SHA-256 hash is persisted, so a
// leaked store file cannot be used to recover live tokens. Persisted as JSON at
// SP_API_TOKENS_FILE (default: <MCP_CACHE_DIR>/tokens.json), which lives on the
// mounted cache volume so tokens survive container restarts.

import { randomBytes, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { MCP_CACHE_DIR } from "../utils/paths.js";
import { logger } from "../utils/logger.js";

/** Public view of a token (never includes the secret or its hash). */
export interface TokenRecord {
  id: string;
  subject: string;
  username?: string;
  label?: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt?: string;
  revoked?: boolean;
}

interface StoredToken extends TokenRecord {
  hash: string;
}

const TOKEN_PREFIX = "spat_";

function defaultTokensFile(): string {
  return process.env.SP_API_TOKENS_FILE || join(MCP_CACHE_DIR, "tokens.json");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class TokenStore {
  private readonly byId = new Map<string, StoredToken>();
  private readonly byHash = new Map<string, StoredToken>();
  private readonly filePath: string;

  constructor(filePath: string = defaultTokensFile()) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as StoredToken[];
      for (const t of raw) {
        this.byId.set(t.id, t);
        this.byHash.set(t.hash, t);
      }
      logger.info(`Loaded ${this.byId.size} API token(s) from ${this.filePath}`);
    } catch (e) {
      logger.error(
        `Failed to read token store ${this.filePath}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(
      this.filePath,
      JSON.stringify([...this.byId.values()], null, 2),
    );
  }

  private redact(t: StoredToken): TokenRecord {
    // Strip the hash from anything returned to callers.
    const { hash: _hash, ...rest } = t;
    void _hash;
    return rest;
  }

  /**
   * Mint a new token. Returns the plaintext token ONCE (never stored/recoverable
   * afterward) plus its public record.
   */
  issue(opts: {
    subject: string;
    username?: string;
    label?: string;
    ttlMs?: number | null;
  }): { token: string; record: TokenRecord } {
    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const id = randomBytes(9).toString("base64url");
    const now = Date.now();
    const stored: StoredToken = {
      id,
      hash: hashToken(token),
      subject: opts.subject,
      username: opts.username,
      label: opts.label,
      createdAt: new Date(now).toISOString(),
      expiresAt:
        opts.ttlMs == null ? null : new Date(now + opts.ttlMs).toISOString(),
    };
    this.byId.set(id, stored);
    this.byHash.set(stored.hash, stored);
    this.persist();
    logger.info(
      `Issued API token ${id} for subject "${opts.subject}"${
        opts.label ? ` (${opts.label})` : ""
      }`,
    );
    return { token, record: this.redact(stored) };
  }

  /** Validate a presented token. Never logs the token value. */
  verify(token: string): { ok: boolean; record?: TokenRecord; reason?: string } {
    if (!token || !token.startsWith(TOKEN_PREFIX)) {
      return { ok: false, reason: "malformed" };
    }
    const stored = this.byHash.get(hashToken(token));
    if (!stored) return { ok: false, reason: "unknown" };
    if (stored.revoked) return { ok: false, reason: "revoked" };
    if (stored.expiresAt && Date.parse(stored.expiresAt) <= Date.now()) {
      return { ok: false, reason: "expired" };
    }
    // Best-effort last-used tracking (in-memory only; not persisted per request).
    stored.lastUsedAt = new Date().toISOString();
    return { ok: true, record: this.redact(stored) };
  }

  /** Revoke a token by id. If `subject` is given, only revokes that subject's token. */
  revoke(id: string, subject?: string): boolean {
    const stored = this.byId.get(id);
    if (!stored) return false;
    if (subject !== undefined && stored.subject !== subject) return false;
    if (!stored.revoked) {
      stored.revoked = true;
      this.persist();
      logger.info(`Revoked API token ${id}`);
    }
    return true;
  }

  /** List token records (redacted), optionally filtered to one subject. */
  list(subject?: string): TokenRecord[] {
    return [...this.byId.values()]
      .filter((t) => subject === undefined || t.subject === subject)
      .map((t) => this.redact(t));
  }
}
