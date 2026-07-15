// src/auth/oidc.ts
//
// OIDC relying-party for the browser login half of the "B2" flow. The user logs
// in once against an OIDC provider (Synology SSO / Keycloak / Authentik / any
// standard OIDC IdP via discovery); on success the gateway mints a PAT.
//
// Uses openid-client v6. Login state (PKCE verifier, state, nonce) is held in
// memory keyed by `state` for a few minutes — fine for a single-process gateway.

import * as client from "openid-client";
import { logger } from "../utils/logger.js";

export interface OidcUser {
  subject: string;
  username?: string;
  email?: string;
}

interface PendingLogin {
  codeVerifier: string;
  state: string;
  nonce: string;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

export class OidcClient {
  private configPromise: Promise<client.Configuration> | null = null;
  private readonly pending = new Map<string, PendingLogin>();

  constructor(
    private readonly issuer: string,
    private readonly clientId: string,
    private readonly clientSecret: string | undefined,
    private readonly redirectUri: string,
    private readonly scope: string = "openid profile email",
  ) {}

  /** Build from OIDC_* env vars, or null if not configured. */
  static fromEnv(): OidcClient | null {
    const issuer = process.env.OIDC_ISSUER;
    const clientId = process.env.OIDC_CLIENT_ID;
    const redirectUri = process.env.OIDC_REDIRECT_URI;
    if (!issuer || !clientId || !redirectUri) return null;
    return new OidcClient(
      issuer,
      clientId,
      process.env.OIDC_CLIENT_SECRET,
      redirectUri,
      process.env.OIDC_SCOPE || "openid profile email",
    );
  }

  private config(): Promise<client.Configuration> {
    if (!this.configPromise) {
      this.configPromise = client.discovery(
        new URL(this.issuer),
        this.clientId,
        this.clientSecret,
      );
    }
    return this.configPromise;
  }

  /** Start a login: returns the authorization URL to redirect the browser to. */
  async beginLogin(): Promise<string> {
    const config = await this.config();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();

    this.gcPending();
    this.pending.set(state, { codeVerifier, state, nonce, createdAt: Date.now() });

    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri,
      scope: this.scope,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return url.href;
  }

  /** Complete a login from the callback URL; returns the authenticated user. */
  async completeLogin(currentUrl: URL): Promise<OidcUser> {
    const config = await this.config();
    const state = currentUrl.searchParams.get("state") ?? "";
    const pending = this.pending.get(state);
    if (!pending) {
      throw new Error("Unknown or expired login state");
    }
    this.pending.delete(state);

    const tokens = await client.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: pending.codeVerifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
    });

    const claims = (tokens.claims() ?? {}) as Record<string, unknown>;
    const subject = typeof claims.sub === "string" ? claims.sub : "";
    if (!subject) {
      throw new Error("OIDC response contained no subject (sub) claim");
    }

    let username =
      (typeof claims.preferred_username === "string" && claims.preferred_username) ||
      (typeof claims.name === "string" && claims.name) ||
      undefined;
    let email = typeof claims.email === "string" ? claims.email : undefined;

    // userinfo is optional enrichment; ignore failures.
    try {
      const info = (await client.fetchUserInfo(
        config,
        tokens.access_token,
        subject,
      )) as Record<string, unknown>;
      username =
        username ||
        (typeof info.preferred_username === "string" && info.preferred_username) ||
        (typeof info.name === "string" && info.name) ||
        undefined;
      email =
        email || (typeof info.email === "string" ? info.email : undefined);
    } catch (e) {
      logger.debug(
        `OIDC userinfo fetch skipped: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    return { subject, username, email };
  }

  private gcPending(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) {
      if (now - v.createdAt > PENDING_TTL_MS) this.pending.delete(k);
    }
  }
}
