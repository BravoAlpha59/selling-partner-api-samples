// src/auth/account-credentials.ts
//
// Multi-account credential vault for the dev-assistant MCP server.
//
// Only `sp_api_execute` needs SP-API credentials. In a hosted, multi-user
// deployment the LWA credentials must stay hidden from both the end user and
// the agent/tools: the agent supplies only a non-secret account *code*, and
// this module resolves that code to credentials entirely server-side.
//
// Credentials come from a mounted JSON "vault" file (read-only), so secrets are
// never baked into the image or passed through tool arguments/results. Path is
// SP_API_ACCOUNTS_FILE, defaulting to /etc/sp-api/accounts.json.
//
// Vault shape:
//   {
//     "accounts": {
//       "USMAIN": {
//         "clientId": "amzn1.application-oa2-client.xxx",
//         "clientSecret": "amzn1.oa2-cs.v1.xxx",
//         "refreshToken": "Atzr|xxx",
//         "region": "NA",         // optional; "NA" | "EU" | "FE" or a country code
//         "label": "US Main"      // optional; human name shown by sp_api_accounts
//         // "baseUrl": "https://sellingpartnerapi-na.amazon.com"  // optional override
//       }
//     }
//   }

import { existsSync, readFileSync } from "fs";
import {
  SpApiAuthenticator,
  createAuthenticatorFromEnv,
} from "./sp-api-auth.js";
import { resolveRegionEndpoint } from "../tools/execute-api-tool.js";
import { logger } from "../utils/logger.js";

export interface AccountCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Optional selling region ("NA" | "EU" | "FE" or a country code). */
  region?: string;
  /** Optional explicit base URL; overrides region-derived endpoint. */
  baseUrl?: string;
  /**
   * Optional human-readable name (e.g. "Sincerely Hers"), surfaced by
   * sp_api_accounts so the agent can map prose to a code. Non-secret.
   */
  label?: string;
}

/** Sentinel account code used when falling back to SP_API_* env credentials. */
export const ENV_ACCOUNT_CODE = "__env__";

const DEFAULT_ACCOUNTS_FILE = "/etc/sp-api/accounts.json";

/** Lazily-loaded, process-lifetime vault cache. */
let vaultCache: Map<string, AccountCredentials> | null = null;

function accountsFilePath(): string {
  return process.env.SP_API_ACCOUNTS_FILE || DEFAULT_ACCOUNTS_FILE;
}

function isValidAccount(value: unknown): value is AccountCredentials {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.clientId === "string" &&
    a.clientId.length > 0 &&
    typeof a.clientSecret === "string" &&
    a.clientSecret.length > 0 &&
    typeof a.refreshToken === "string" &&
    a.refreshToken.length > 0
  );
}

/**
 * Load and cache the vault from the mounted JSON file. A missing file is not an
 * error — it yields an empty vault so the env-credential fallback still works
 * for local single-account development. Malformed content throws (surfaced only
 * when sp_api_execute is used, so the other five tools keep working).
 *
 * Never logs credential values — only the file path and account codes.
 */
function loadVault(): Map<string, AccountCredentials> {
  if (vaultCache) return vaultCache;

  const path = accountsFilePath();
  const map = new Map<string, AccountCredentials>();

  if (!existsSync(path)) {
    logger.info(
      `SP-API accounts vault not found at ${path}; relying on SP_API_* env credentials if present.`,
    );
    vaultCache = map;
    return map;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(
      `Failed to parse SP-API accounts vault at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const accounts = (parsed as { accounts?: unknown })?.accounts;
  if (typeof accounts !== "object" || accounts === null) {
    throw new Error(
      `SP-API accounts vault at ${path} must contain an "accounts" object.`,
    );
  }

  for (const [code, value] of Object.entries(
    accounts as Record<string, unknown>,
  )) {
    if (!isValidAccount(value)) {
      throw new Error(
        `SP-API accounts vault entry "${code}" is missing required fields (clientId, clientSecret, refreshToken).`,
      );
    }
    map.set(code, value);
  }

  logger.info(
    `Loaded ${map.size} SP-API account(s) from vault at ${path}: [${[
      ...map.keys(),
    ].join(", ")}]`,
  );
  vaultCache = map;
  return map;
}

/** Account codes configured in the vault (non-secret labels). */
export function listAccountCodes(): string[] {
  return [...loadVault().keys()];
}

/** A configured account, with only the non-secret fields. */
export interface AccountSummary {
  code: string;
  region?: string;
  label?: string;
}

/**
 * Non-secret summaries of the configured accounts, for agent-facing discovery.
 * Deliberately projects an explicit whitelist rather than spreading the account
 * — clientId/clientSecret/refreshToken must never cross the tool boundary, so a
 * new secret-bearing field can't leak here by accident.
 */
export function listAccounts(): AccountSummary[] {
  return [...loadVault().entries()].map(([code, account]) => ({
    code,
    region: account.region,
    label: account.label,
  }));
}

/**
 * Build an authenticator for a specific configured account code.
 * @throws if the code is not present in the vault.
 */
export function createAuthenticatorForAccount(
  code: string,
): SpApiAuthenticator {
  const account = loadVault().get(code);
  if (!account) {
    // Do not enumerate configured codes back to the caller/agent — treat the
    // set of accounts as need-to-know. Available codes are logged server-side.
    logger.info(
      `Rejected unknown SP-API account code "${code}". Configured: [${listAccountCodes().join(
        ", ",
      )}]`,
    );
    throw new Error(
      `Unknown SP-API account code "${code}". It is not configured in the accounts vault.`,
    );
  }

  const baseUrl =
    account.baseUrl ||
    (account.region ? resolveRegionEndpoint(account.region) : null) ||
    undefined;

  return new SpApiAuthenticator({
    clientId: account.clientId,
    clientSecret: account.clientSecret,
    refreshToken: account.refreshToken,
    baseUrl,
  });
}

/**
 * Resolve an authenticator for a request, returning the resolved account code
 * (used as a per-account cache key by callers).
 *
 * Resolution order:
 *   1. Explicit `accountCode` (from the tool arg or, later, the session/gateway)
 *   2. SP_API_ACCOUNT_CODE env default
 *   3. The sole vault account, if exactly one is configured
 *   4. Legacy SP_API_* env credentials (single-account local dev)
 *
 * @throws with actionable guidance if none apply.
 */
export function resolveAuthenticator(accountCode?: string): {
  accountCode: string;
  authenticator: SpApiAuthenticator;
} {
  const code = accountCode || process.env.SP_API_ACCOUNT_CODE;

  if (code) {
    return {
      accountCode: code,
      authenticator: createAuthenticatorForAccount(code),
    };
  }

  const codes = listAccountCodes();
  if (codes.length === 1) {
    return {
      accountCode: codes[0],
      authenticator: createAuthenticatorForAccount(codes[0]),
    };
  }

  const envAuth = createAuthenticatorFromEnv();
  if (envAuth) {
    return { accountCode: ENV_ACCOUNT_CODE, authenticator: envAuth };
  }

  throw new Error(
    "No SP-API account specified. Provide an account_code that is configured " +
      "in the accounts vault, set SP_API_ACCOUNT_CODE, or supply SP_API_CLIENT_ID / " +
      "SP_API_CLIENT_SECRET / SP_API_REFRESH_TOKEN environment credentials.",
  );
}

/** Test hook: clear the cached vault so a new SP_API_ACCOUNTS_FILE is re-read. */
export function _resetVaultCacheForTests(): void {
  vaultCache = null;
}
