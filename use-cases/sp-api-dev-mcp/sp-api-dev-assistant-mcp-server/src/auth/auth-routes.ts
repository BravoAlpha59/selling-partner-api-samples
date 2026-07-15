// src/auth/auth-routes.ts
//
// /auth/* routes for the B2 flow:
//   GET  /auth/login            -> redirect to the OIDC provider (or a dev form)
//   GET  /auth/callback         -> finish OIDC, mint a PAT, show it once
//   POST /auth/dev-login        -> (dev only) mint a PAT without OIDC, for testing
//   GET  /auth/tokens           -> list the caller's own tokens
//   POST /auth/tokens/:id/revoke-> revoke one of the caller's tokens

import { Router, type Request, type Response } from "express";
import { TokenStore } from "./token-store.js";
import { OidcClient } from "./oidc.js";
import {
  createRequireAuth,
  type AuthedRequest,
} from "./auth-middleware.js";
import { logger } from "../utils/logger.js";

function devLoginEnabled(): boolean {
  const v = (process.env.AUTH_DEV_LOGIN || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function tokenTtlMs(): number | null {
  const days = parseFloat(process.env.AUTH_TOKEN_TTL_DAYS || "90");
  if (!Number.isFinite(days) || days <= 0) return null; // no expiry
  return Math.round(days * 24 * 60 * 60 * 1000);
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] as string,
  );
}

function baseUrl(req: Request): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined) || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function renderTokenPage(
  req: Request,
  token: string,
  who: string | undefined,
): string {
  const url = `${baseUrl(req)}/mcp`;
  const cmd = `claude mcp add --transport http sp-api-dev-assistant ${url} \\\n  --header "Authorization: Bearer ${token}" \\\n  --header "X-SP-API-Account: <ACCOUNT_CODE>"`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Your SP-API token</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:3rem auto;padding:0 1rem;line-height:1.5}
code,pre{background:#f4f4f5;border-radius:6px}pre{padding:1rem;overflow-x:auto}.tok{font-size:1.05rem;word-break:break-all}
.warn{background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:.75rem 1rem}</style></head>
<body><h1>Your personal access token</h1>
<p>Signed in${who ? ` as <strong>${escapeHtml(who)}</strong>` : ""}. This token is shown <strong>once</strong> — copy it now.</p>
<p class="tok"><code>${escapeHtml(token)}</code></p>
<div class="warn">Store it like a password. Anyone with this token can use the service as you.</div>
<h2>Add it to your MCP client</h2>
<pre>${escapeHtml(cmd)}</pre>
<p>Replace <code>&lt;ACCOUNT_CODE&gt;</code> with the seller account you want (e.g. <code>SH</code>), then reload your client.</p>
</body></html>`;
}

export function createAuthRouter(
  store: TokenStore,
  oidc: OidcClient | null,
): Router {
  const router = Router();
  const requireAuth = createRequireAuth(store);

  router.get("/login", async (req: Request, res: Response) => {
    if (oidc) {
      try {
        res.redirect(await oidc.beginLogin());
      } catch (e) {
        logger.error(
          `OIDC begin-login failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        res.status(502).send("Login provider unavailable.");
      }
      return;
    }
    if (devLoginEnabled()) {
      res
        .type("html")
        .send(
          `<form method="post" action="dev-login"><label>Username <input name="username" value="dev"></label> <button>Get token (DEV)</button></form>`,
        );
      return;
    }
    res
      .status(503)
      .send("No login method configured. Set OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_REDIRECT_URI.");
  });

  router.get("/callback", async (req: Request, res: Response) => {
    if (!oidc) {
      res.status(503).send("OIDC not configured.");
      return;
    }
    try {
      const currentUrl = new URL(req.originalUrl, baseUrl(req));
      const user = await oidc.completeLogin(currentUrl);
      const { token } = store.issue({
        subject: user.subject,
        username: user.username,
        label: "oidc",
        ttlMs: tokenTtlMs(),
      });
      logger.info(`Minted token for OIDC user "${user.username || user.subject}"`);
      res.type("html").send(renderTokenPage(req, token, user.username || user.email));
    } catch (e) {
      logger.error(
        `OIDC callback failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      res.status(400).send("Login failed or expired. Start again at /auth/login.");
    }
  });

  // Dev-only shortcut to mint a token without a real IdP — for local testing.
  router.post("/dev-login", (req: Request, res: Response) => {
    if (!devLoginEnabled()) {
      res.status(404).end();
      return;
    }
    const raw = (req.body as { username?: unknown } | undefined)?.username;
    const username = typeof raw === "string" && raw.trim() ? raw.trim() : "dev";
    const { token } = store.issue({
      subject: `dev:${username}`,
      username,
      label: "dev-login",
      ttlMs: tokenTtlMs(),
    });
    logger.warn(
      `DEV login issued a token for "${username}" — AUTH_DEV_LOGIN must NOT be set in production`,
    );
    if ((req.headers.accept || "").includes("application/json")) {
      res.json({ token });
    } else {
      res.type("html").send(renderTokenPage(req, token, username));
    }
  });

  router.get("/tokens", requireAuth, (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user;
    if (!user) {
      res.status(404).end();
      return;
    }
    res.json({ tokens: store.list(user.subject) });
  });

  router.post(
    "/tokens/:id/revoke",
    requireAuth,
    (req: Request, res: Response) => {
      const user = (req as AuthedRequest).user;
      if (!user) {
        res.status(404).end();
        return;
      }
      const ok = store.revoke(req.params.id, user.subject);
      res.status(ok ? 200 : 404).json({ revoked: ok });
    },
  );

  return router;
}
