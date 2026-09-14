import assert from "node:assert/strict";
import test from "node:test";

import {
  checkRateLimit,
  extractCredential,
  insecurePostureWarnings,
  isCacheableRead,
  isReplaySafeMethod,
  loadRegions,
  RateLimiter,
} from "./index.mjs";
import { authorizeRevocation, resetRevocationBoundaryForTest } from "./jwt-revocation-boundary.mjs";

test("consolidated worker preserves cache and replay safety", () => {
  const url = "https://api.fiducia.cloud/v1/kv?key=flags/x&cache=30";
  assert.equal(isCacheableRead(new Request(url)), true);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(isReplaySafeMethod(method), false);
    assert.equal(isCacheableRead(new Request(url, { method })), false);
  }
});

test("configured rate limiting fails closed without the Durable Object binding", async () => {
  const result = await checkRateLimit(
    new Request("https://api.fiducia.cloud/v1/kv?key=x"),
    { FIDUCIA_RATE_LIMIT_PER_MINUTE: "1" },
  );
  assert.deepEqual(result, { ok: false, configurationError: true });
});

test("Durable Object increments are serialized", async () => {
  let counter;
  let tail = Promise.resolve();
  const storage = {
    transaction(fn) {
      const run = tail.then(() => fn({
        get: async () => counter,
        put: async (_key, value) => { counter = value; },
      }));
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
    setAlarm: async () => {},
    deleteAll: async () => { counter = undefined; },
  };
  const limiter = new RateLimiter({ storage });
  const request = () => new Request("https://rate-limiter.internal/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit: 1, windowSeconds: 60, now: 120 }),
  });
  const responses = await Promise.all([limiter.fetch(request()), limiter.fetch(request())]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 429]);
});

test("revocation cache stays fail closed across stale positive authority failure", async () => {
  resetRevocationBoundaryForTest();
  const claims = {
    sub: "org-1", org_id: "org-1", scopes: ["kv:read"], iss: "fiducia-auth",
    aud: "fiducia-api", iat: 900, exp: 1800, jti: "token-1",
  };
  const env = {
    FIDUCIA_DEPLOYMENT_MODE: "test",
    FIDUCIA_REVOCATION_READER_SECRET: "r".repeat(48),
    FIDUCIA_REVOCATION_CHECK_URL: "http://revocation.test/v1/revocations/check",
    FIDUCIA_REVOCATION_CACHE_TTL_SECONDS: "1",
    FIDUCIA_REVOCATION_TIMEOUT_MS: "5",
  };
  const deny = async () => Response.json({
    decision: { revoked: true, matched_target: "token_id", generation: 1, expires_at: 1700 },
  });
  assert.equal((await authorizeRevocation(claims, env, { nowMs: 1_000_000, fetchImpl: deny })).kind, "deny");
  const unavailable = async () => { throw new Error("authority unavailable"); };
  const result = await authorizeRevocation(claims, env, { nowMs: 1_002_000, fetchImpl: unavailable });
  assert.equal(result.kind, "deny");
  assert.equal(result.reason, "stale_revocation_unconfirmed");
});

test("auth and region helpers survived consolidation", () => {
  assert.equal(extractCredential(new Request("https://api.fiducia.cloud", {
    headers: { authorization: "Bearer fdc_live_id.secret" },
  })), "fdc_live_id.secret");
  assert.equal(loadRegions({ FIDUCIA_REGIONS: "not json" }).length, 0);
  assert.deepEqual(insecurePostureWarnings({
    FIDUCIA_AUTH_REQUIRED: "true",
    FIDUCIA_RATE_LIMIT_PER_MINUTE: "60",
  }), []);
});
