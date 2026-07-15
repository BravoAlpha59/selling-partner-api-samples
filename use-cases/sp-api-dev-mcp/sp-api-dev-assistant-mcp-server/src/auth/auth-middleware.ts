// src/auth/auth-middleware.ts
//
// Bearer-token auth for the HTTP MCP endpoint (the "B2" gateway). When auth is
// enabled, every /mcp request must carry a valid PAT (see token-store.ts).
//
// Authorization model is intentionally coarse: a valid token == an authenticated
// user, and any authenticated user may act as any configured seller account
// (the X-SP-API-Account header stays a free selector). The identity is attached
// to the request only for audit logging.

import type { Request, Response, NextFunction } from "express";
import type { TokenStore } from "./token-store.js";

export interface AuthedUser {
  subject: string;
  username?: string;
  tokenId: string;
}

export type AuthedRequest = Request & { user?: AuthedUser };

/** Auth is off unless AUTH_ENABLED is truthy, so local dev / stdio are unaffected. */
export function authEnabled(): boolean {
  const v = (process.env.AUTH_ENABLED || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function extractBearer(req: Request): string | undefined {
  const h = req.headers["authorization"];
  const value = Array.isArray(h) ? h[0] : h;
  if (!value) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  return m ? m[1].trim() : undefined;
}

/**
 * Express middleware that requires a valid bearer PAT. No-op when auth is
 * disabled. On success, attaches `req.user`.
 */
export function createRequireAuth(store: TokenStore) {
  return function requireAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (!authEnabled()) {
      next();
      return;
    }

    const token = extractBearer(req);
    if (!token) {
      res
        .status(401)
        .set("WWW-Authenticate", 'Bearer realm="sp-api-dev-assistant"')
        .json({
          error: "unauthorized",
          message:
            "Missing bearer token. Authenticate at /auth/login and send the issued token as 'Authorization: Bearer <token>'.",
        });
      return;
    }

    const result = store.verify(token);
    if (!result.ok || !result.record) {
      res
        .status(401)
        .set(
          "WWW-Authenticate",
          'Bearer realm="sp-api-dev-assistant", error="invalid_token"',
        )
        .json({
          error: "invalid_token",
          message: `Token ${result.reason ?? "invalid"}.`,
        });
      return;
    }

    (req as AuthedRequest).user = {
      subject: result.record.subject,
      username: result.record.username,
      tokenId: result.record.id,
    };
    next();
  };
}
