import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  listAccounts,
  listAccountCodes,
  _resetVaultCacheForTests,
} from "../../src/auth/account-credentials.js";

let tmp: string;
const saved = process.env.SP_API_ACCOUNTS_FILE;

function writeVault(accounts: Record<string, unknown>): string {
  const p = join(tmp, "accounts.json");
  writeFileSync(p, JSON.stringify({ accounts }));
  return p;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "acct-list-"));
  _resetVaultCacheForTests();
});
afterEach(() => {
  if (saved === undefined) delete process.env.SP_API_ACCOUNTS_FILE;
  else process.env.SP_API_ACCOUNTS_FILE = saved;
  _resetVaultCacheForTests();
  rmSync(tmp, { recursive: true, force: true });
});

const CREDS = {
  clientId: "amzn1.application-oa2-client.x",
  clientSecret: "amzn1.oa2-cs.v1.secret",
  refreshToken: "Atzr|secret-refresh",
};

describe("listAccounts", () => {
  it("returns each configured code with its region", () => {
    process.env.SP_API_ACCOUNTS_FILE = writeVault({
      SH: { ...CREDS, region: "NA" },
      DE: { ...CREDS, region: "EU" },
    });
    expect(listAccounts()).toEqual([
      { code: "SH", region: "NA" },
      { code: "DE", region: "EU" },
    ]);
  });

  it("NEVER exposes credentials — the code is all that may cross the boundary", () => {
    process.env.SP_API_ACCOUNTS_FILE = writeVault({
      SH: { ...CREDS, region: "NA" },
    });
    const serialized = JSON.stringify(listAccounts());
    expect(serialized).not.toContain(CREDS.clientSecret);
    expect(serialized).not.toContain(CREDS.refreshToken);
    expect(serialized).not.toContain(CREDS.clientId);
    expect(Object.keys(listAccounts()[0]).sort()).toEqual(["code", "region"]);
  });

  it("omits region when the account doesn't set one", () => {
    process.env.SP_API_ACCOUNTS_FILE = writeVault({ SH: { ...CREDS } });
    expect(listAccounts()).toEqual([{ code: "SH", region: undefined }]);
  });

  it("returns an empty list when no vault is configured (env-cred fallback)", () => {
    process.env.SP_API_ACCOUNTS_FILE = join(tmp, "does-not-exist.json");
    expect(listAccounts()).toEqual([]);
    expect(listAccountCodes()).toEqual([]);
  });
});
