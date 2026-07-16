import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createSplitHorizonFetch, OidcClient } from "../../src/auth/oidc.js";

// A stand-in IdP on loopback. It echoes back what it actually received, so the
// assertions below reflect real undici behaviour rather than a mock's guesses.
interface Seen {
  url: string;
  method: string;
  host?: string;
  xfHost?: string;
  xfProto?: string;
  auth?: string;
  body: string;
}
let server: http.Server;
let internalOrigin: string;
let last: Seen;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      last = {
        url: req.url ?? "",
        method: req.method ?? "",
        host: req.headers.host,
        xfHost: req.headers["x-forwarded-host"] as string | undefined,
        xfProto: req.headers["x-forwarded-proto"] as string | undefined,
        auth: req.headers.authorization,
        body,
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  internalOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const PUBLIC_ISSUER = "https://idp.example.ts.net:8943/application/o/app/";

describe("createSplitHorizonFetch", () => {
  it("rewrites the issuer origin to the back-channel and preserves the path", async () => {
    const f = createSplitHorizonFetch(PUBLIC_ISSUER, internalOrigin);
    const res = await f(
      "https://idp.example.ts.net:8943/application/o/app/.well-known/openid-configuration",
      {},
    );
    expect(res.status).toBe(200);
    expect(last.url).toBe(
      "/application/o/app/.well-known/openid-configuration",
    );
  });

  it("declares the public host/proto via X-Forwarded-* so the IdP advertises browser-reachable endpoints", async () => {
    const f = createSplitHorizonFetch(PUBLIC_ISSUER, internalOrigin);
    await f("https://idp.example.ts.net:8943/application/o/app/token/", {});
    expect(last.xfHost).toBe("idp.example.ts.net:8943");
    expect(last.xfProto).toBe("https");
  });

  it("does NOT rely on the Host header (the Fetch spec forbids overriding it)", async () => {
    const f = createSplitHorizonFetch(PUBLIC_ISSUER, internalOrigin);
    await f("https://idp.example.ts.net:8943/application/o/app/token/", {});
    // Host is the real connect target, not the public name — which is exactly
    // why the public name has to travel in X-Forwarded-Host instead.
    expect(last.host).toBe(new URL(internalOrigin).host);
    expect(last.host).not.toContain("idp.example.ts.net");
  });

  it("preserves method, body, and headers (the token exchange is a POST)", async () => {
    const f = createSplitHorizonFetch(PUBLIC_ISSUER, internalOrigin);
    await f("https://idp.example.ts.net:8943/application/o/app/token/", {
      method: "POST",
      body: "grant_type=authorization_code&code=abc",
      headers: { authorization: "Basic Zm9vOmJhcg==" },
    } as never);
    expect(last.method).toBe("POST");
    expect(last.body).toBe("grant_type=authorization_code&code=abc");
    expect(last.auth).toBe("Basic Zm9vOmJhcg==");
  });

  it("passes through a non-issuer origin untouched", async () => {
    // Point the "public" issuer somewhere unrelated so our request doesn't match.
    const f = createSplitHorizonFetch(
      "https://other.example.com/",
      "http://127.0.0.1:1",
    );
    const res = await f(`${internalOrigin}/direct`, {});
    expect(res.status).toBe(200);
    expect(last.url).toBe("/direct");
    // No forwarding headers invented for origins we aren't rewriting.
    expect(last.xfHost).toBeUndefined();
    expect(last.xfProto).toBeUndefined();
  });
});

describe("OidcClient.fromEnv split-horizon wiring", () => {
  const saved = { ...process.env };
  afterAll(() => {
    process.env = { ...saved };
  });

  it("is inert when OIDC_INTERNAL_ORIGIN is unset (default behaviour unchanged)", () => {
    process.env.OIDC_ISSUER = PUBLIC_ISSUER;
    process.env.OIDC_CLIENT_ID = "cid";
    process.env.OIDC_REDIRECT_URI = "http://gw.example:3000/auth/callback";
    delete process.env.OIDC_INTERNAL_ORIGIN;
    const c = OidcClient.fromEnv();
    expect(c).not.toBeNull();
    expect(
      (c as unknown as { internalOrigin?: string }).internalOrigin,
    ).toBeUndefined();
  });

  it("picks up OIDC_INTERNAL_ORIGIN when set", () => {
    process.env.OIDC_ISSUER = PUBLIC_ISSUER;
    process.env.OIDC_CLIENT_ID = "cid";
    process.env.OIDC_REDIRECT_URI = "http://gw.example:3000/auth/callback";
    process.env.OIDC_INTERNAL_ORIGIN = "http://172.17.0.1:9900";
    const c = OidcClient.fromEnv();
    expect((c as unknown as { internalOrigin?: string }).internalOrigin).toBe(
      "http://172.17.0.1:9900",
    );
  });
});
