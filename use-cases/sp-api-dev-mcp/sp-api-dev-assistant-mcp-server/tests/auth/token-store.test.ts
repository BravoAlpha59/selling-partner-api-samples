import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TokenStore } from "../../src/auth/token-store.js";

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tokens-"));
  file = join(tmp, "tokens.json");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("TokenStore", () => {
  it("issues a prefixed token and validates it", () => {
    const store = new TokenStore(file);
    const { token, record } = store.issue({ subject: "user1", username: "u1" });
    expect(token.startsWith("spat_")).toBe(true);
    expect(record.subject).toBe("user1");
    const v = store.verify(token);
    expect(v.ok).toBe(true);
    expect(v.record?.subject).toBe("user1");
  });

  it("never persists the plaintext token, only a hash", () => {
    const store = new TokenStore(file);
    const { token } = store.issue({ subject: "user1" });
    const onDisk = readFileSync(file, "utf-8");
    expect(onDisk).not.toContain(token);
    expect(onDisk).toContain("hash");
  });

  it("does not expose the hash in returned records", () => {
    const store = new TokenStore(file);
    const { record } = store.issue({ subject: "user1" });
    expect((record as Record<string, unknown>).hash).toBeUndefined();
    expect((store.list()[0] as Record<string, unknown>).hash).toBeUndefined();
  });

  it("rejects unknown and malformed tokens", () => {
    const store = new TokenStore(file);
    expect(store.verify("spat_nope").ok).toBe(false);
    expect(store.verify("not-a-token").reason).toBe("malformed");
  });

  it("rejects revoked tokens and scopes revoke by subject", () => {
    const store = new TokenStore(file);
    const a = store.issue({ subject: "userA" });
    // Wrong subject cannot revoke.
    expect(store.revoke(a.record.id, "userB")).toBe(false);
    expect(store.verify(a.token).ok).toBe(true);
    // Correct subject can.
    expect(store.revoke(a.record.id, "userA")).toBe(true);
    const v = store.verify(a.token);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("revoked");
  });

  it("rejects expired tokens", () => {
    const store = new TokenStore(file);
    const { token } = store.issue({ subject: "user1", ttlMs: -1000 }); // already expired
    const v = store.verify(token);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("expired");
  });

  it("persists across reloads and keeps tokens valid", () => {
    const store1 = new TokenStore(file);
    const { token } = store1.issue({ subject: "user1", label: "cli" });
    expect(existsSync(file)).toBe(true);

    const store2 = new TokenStore(file);
    expect(store2.verify(token).ok).toBe(true);
    expect(store2.list("user1")).toHaveLength(1);
  });

  it("lists only a subject's tokens when filtered", () => {
    const store = new TokenStore(file);
    store.issue({ subject: "a" });
    store.issue({ subject: "a" });
    store.issue({ subject: "b" });
    expect(store.list("a")).toHaveLength(2);
    expect(store.list("b")).toHaveLength(1);
    expect(store.list()).toHaveLength(3);
  });
});
