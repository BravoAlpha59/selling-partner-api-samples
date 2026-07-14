import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveAuthenticator,
  createAuthenticatorForAccount,
  listAccountCodes,
  ENV_ACCOUNT_CODE,
  _resetVaultCacheForTests,
} from "../../src/auth/account-credentials.js";

const VAULT = {
  accounts: {
    USMAIN: {
      clientId: "amzn1.application-oa2-client.us",
      clientSecret: "secret-us",
      refreshToken: "Atzr|us",
      region: "NA",
    },
    UKPRIME: {
      clientId: "amzn1.application-oa2-client.uk",
      clientSecret: "secret-uk",
      refreshToken: "Atzr|uk",
      region: "EU",
    },
  },
};

const ENV_KEYS = [
  "SP_API_ACCOUNTS_FILE",
  "SP_API_ACCOUNT_CODE",
  "SP_API_CLIENT_ID",
  "SP_API_CLIENT_SECRET",
  "SP_API_REFRESH_TOKEN",
];

let tmp: string;
let savedEnv: Record<string, string | undefined>;

function writeVault(content: unknown): string {
  const path = join(tmp, "accounts.json");
  writeFileSync(path, JSON.stringify(content));
  process.env.SP_API_ACCOUNTS_FILE = path;
  _resetVaultCacheForTests();
  return path;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vault-"));
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  _resetVaultCacheForTests();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetVaultCacheForTests();
  rmSync(tmp, { recursive: true, force: true });
});

describe("account credential vault", () => {
  it("lists configured account codes", () => {
    writeVault(VAULT);
    expect(listAccountCodes().sort()).toEqual(["UKPRIME", "USMAIN"]);
  });

  it("resolves an authenticator for an explicit account code with region endpoint", () => {
    writeVault(VAULT);
    const auth = createAuthenticatorForAccount("UKPRIME");
    expect(auth.getBaseUrl()).toBe("https://sellingpartnerapi-eu.amazon.com");
  });

  it("keys the resolution by the requested account code", () => {
    writeVault(VAULT);
    const { accountCode } = resolveAuthenticator("USMAIN");
    expect(accountCode).toBe("USMAIN");
  });

  it("throws a non-enumerating error for an unknown code", () => {
    writeVault(VAULT);
    expect(() => createAuthenticatorForAccount("NOPE")).toThrow(
      /Unknown SP-API account code "NOPE"/,
    );
    // The error must not leak the set of configured codes to the caller.
    try {
      createAuthenticatorForAccount("NOPE");
    } catch (e) {
      expect((e as Error).message).not.toContain("USMAIN");
    }
  });

  it("auto-selects the sole account when no code is given", () => {
    writeVault({ accounts: { ONLYONE: VAULT.accounts.USMAIN } });
    const { accountCode } = resolveAuthenticator();
    expect(accountCode).toBe("ONLYONE");
  });

  it("honors SP_API_ACCOUNT_CODE as the default", () => {
    writeVault(VAULT);
    process.env.SP_API_ACCOUNT_CODE = "UKPRIME";
    const { accountCode } = resolveAuthenticator();
    expect(accountCode).toBe("UKPRIME");
  });

  it("falls back to SP_API_* env credentials when no vault is present", () => {
    process.env.SP_API_ACCOUNTS_FILE = join(tmp, "does-not-exist.json");
    process.env.SP_API_CLIENT_ID = "env-id";
    process.env.SP_API_CLIENT_SECRET = "env-secret";
    process.env.SP_API_REFRESH_TOKEN = "env-refresh";
    _resetVaultCacheForTests();
    const { accountCode } = resolveAuthenticator();
    expect(accountCode).toBe(ENV_ACCOUNT_CODE);
  });

  it("throws actionable guidance when nothing is configured", () => {
    process.env.SP_API_ACCOUNTS_FILE = join(tmp, "does-not-exist.json");
    _resetVaultCacheForTests();
    expect(() => resolveAuthenticator()).toThrow(/No SP-API account specified/);
  });

  it("rejects a malformed vault entry", () => {
    writeVault({ accounts: { BAD: { clientId: "only-id" } } });
    expect(() => listAccountCodes()).toThrow(/missing required fields/);
  });
});
