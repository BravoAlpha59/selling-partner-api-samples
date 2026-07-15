import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TokenStore } from "../../src/auth/token-store.js";
import {
  createRequireAuth,
  authEnabled,
  type AuthedRequest,
} from "../../src/auth/auth-middleware.js";

let tmp: string;
let store: TokenStore;
const savedAuthEnabled = process.env.AUTH_ENABLED;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "authmw-"));
  store = new TokenStore(join(tmp, "tokens.json"));
});
afterEach(() => {
  if (savedAuthEnabled === undefined) delete process.env.AUTH_ENABLED;
  else process.env.AUTH_ENABLED = savedAuthEnabled;
  rmSync(tmp, { recursive: true, force: true });
});

// Minimal express-ish mocks.
function mockReq(headers: Record<string, string> = {}) {
  return { headers } as unknown as AuthedRequest;
}
function mockRes() {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    set(k: string, v: string) {
      this.headers[k] = v;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

describe("requireAuth middleware", () => {
  it("is a no-op when AUTH_ENABLED is unset", () => {
    delete process.env.AUTH_ENABLED;
    expect(authEnabled()).toBe(false);
    const next = vi.fn();
    const res = mockRes();
    createRequireAuth(store)(mockReq(), res as any, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it("401s a missing token when enabled, with WWW-Authenticate", () => {
    process.env.AUTH_ENABLED = "1";
    const next = vi.fn();
    const res = mockRes();
    createRequireAuth(store)(mockReq(), res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toContain("Bearer");
  });

  it("401s an invalid token when enabled", () => {
    process.env.AUTH_ENABLED = "true";
    const next = vi.fn();
    const res = mockRes();
    createRequireAuth(store)(
      mockReq({ authorization: "Bearer spat_bogus" }),
      res as any,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: string }).error).toBe("invalid_token");
  });

  it("passes a valid token and attaches req.user", () => {
    process.env.AUTH_ENABLED = "1";
    const { token } = store.issue({ subject: "sub-1", username: "alice" });
    const next = vi.fn();
    const res = mockRes();
    const req = mockReq({ authorization: `Bearer ${token}` });
    createRequireAuth(store)(req, res as any, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
    expect(req.user).toEqual({
      subject: "sub-1",
      username: "alice",
      tokenId: expect.any(String),
    });
  });
});
