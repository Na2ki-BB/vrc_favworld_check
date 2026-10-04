// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { ApiSessionCoordinator, AUTH_STATUS_CACHE_MS, createAuthStatusChecker } from "../extension/lib/auth-status.js";
import { AuthRequiredError, TwoFactorRequiredError, RateLimitedError, NetworkError, ServerError, ApiSchemaError } from "../extension/lib/api.js";
import { AuthCookieRequiredError, AuthCookieBusyError, AuthCookieCleanupError, AuthCookieConflictError } from "../extension/lib/auth-cookie-bridge.js";
import { SAFE_PREFERENCE_KEYS } from "../extension/lib/backup.js";

function fixture() {
  let now = Date.parse("2026-10-04T12:00:00Z");
  let allowed = true;
  let maintenance = false;
  /** @type {number | null} */ let backoff = null;
  /** @type {unknown} */ let failure = null;
  let calls = 0;
  let rules = 0;
  const sessions = new ApiSessionCoordinator();
  const checker = createAuthStatusChecker({
    sessions,
    canCheck: () => allowed,
    isMaintenancePending: async () => maintenance,
    getBackoffUntil: async () => backoff,
    recordRateLimit: async (error) => { backoff = Math.max(now + 60_000, error.retryAt ?? 0); return backoff; },
    ensureUserAgentRule: async () => { rules += 1; },
    probe: async () => { calls += 1; if (failure) throw failure; return {id: "not-returned", displayName: "not-returned"}; },
    clock: () => now
  });
  return { checker, sessions, get calls() { return calls; }, get rules() { return rules; },
    advance: (/** @type {number} */ ms) => { now += ms; },
    fail: (/** @type {unknown} */ error) => { failure = error; },
    allow: (/** @type {boolean} */ value) => { allowed = value; },
    maintain: () => { maintenance = true; },
    limit: (/** @type {number} */ ms) => { backoff = now + ms; }
  };
}

test("auth checks share in-flight work, cache for one minute, and return no account data", async () => {
  const f = fixture();
  const first = f.checker.check();
  assert.equal(first, f.checker.check());
  const status = await first;
  assert.deepEqual(Object.keys(status), ["state", "checkedAt", "retryAt"]);
  assert.equal(status.state, "authenticated");
  assert.equal(await f.checker.check(), status);
  assert.equal(f.calls, 1);
  f.advance(AUTH_STATUS_CACHE_MS);
  await f.checker.check();
  assert.equal(f.calls, 2);
  assert.equal(f.rules, 2);
});

test("credential-free cache survives worker restart, expires, and stays outside backups", async () => {
  let now = Date.parse("2026-10-04T12:00:00Z");
  /** @type {unknown} */ let stored = null;
  let calls = 0;
  let maintenance = false;
  const make = () => createAuthStatusChecker({
    sessions: new ApiSessionCoordinator(), canCheck: () => true,
    isMaintenancePending: async () => maintenance, getBackoffUntil: async () => null,
    recordRateLimit: async () => now + 60_000, ensureUserAgentRule: async () => {},
    probe: async () => { calls += 1; }, clock: () => now,
    loadCache: async () => stored,
    saveCache: async (status) => { stored = status; }
  });
  const first = await make().check();
  stored = {...first, token: "must-not-escape"};
  now += 35_000;
  assert.deepEqual(await make().check(), first);
  assert.equal(calls, 1);
  maintenance = true;
  assert.equal((await make().check()).state, "busy");
  maintenance = false;
  now += 25_000;
  await make().check();
  assert.equal(calls, 2);
  stored = {state: ["authenticated"], checkedAt: new Date(now).toISOString(), retryAt: null};
  await make().check();
  assert.equal(calls, 3, "malformed persisted enum is not accepted");
  assert.deepEqual(SAFE_PREFERENCE_KEYS, ["autoSyncEnabled", "notificationsEnabled"]);
});

test("a short 429 remains cached for sixty seconds across worker restart", async () => {
  let now = Date.parse("2026-10-04T12:00:00Z");
  /** @type {unknown} */ let stored = null;
  let calls = 0;
  /** @type {number | null} */ let backoff = null;
  const make = () => createAuthStatusChecker({
    sessions: new ApiSessionCoordinator(), canCheck: () => true,
    isMaintenancePending: async () => false, getBackoffUntil: async () => backoff,
    recordRateLimit: async () => { backoff = now + 30_000; return backoff; },
    ensureUserAgentRule: async () => {}, probe: async () => { calls += 1; throw new RateLimitedError(now + 30_000, now); },
    clock: () => now, loadCache: async () => stored, saveCache: async (status) => { stored = status; }
  });
  assert.equal((await make().check()).state, "rate_limited");
  now += 35_000;
  assert.equal((await make().check()).state, "rate_limited");
  assert.equal(calls, 1);
  now += 25_000;
  await make().check();
  assert.equal(calls, 2);
});

test("purge cleanup waits until an auth observation cache write finishes", async () => {
  const sessions = new ApiSessionCoordinator();
  /** @type {() => void} */ let release = () => {};
  const saving = new Promise((resolve) => { release = () => resolve(undefined); });
  /** @type {() => void} */ let started = () => {};
  const didStart = new Promise((resolve) => { started = () => resolve(undefined); });
  const checker = createAuthStatusChecker({
    sessions, canCheck: () => true, isMaintenancePending: async () => false,
    getBackoffUntil: async () => null, recordRateLimit: async () => 0,
    ensureUserAgentRule: async () => {}, probe: async () => {},
    saveCache: async () => { started(); await saving; }
  });
  const checking = checker.check();
  await didStart;
  let purged = false;
  const purge = sessions.run(async () => { purged = true; });
  await Promise.resolve();
  assert.equal(purged, false);
  release(); await checking; await purge;
  assert.equal(purged, true);
});

test("auth error states distinguish 401, 2FA, missing cookies and unverifiable results", async () => {
  /** @type {[unknown, string][]} */
  const cases = [
    [new AuthRequiredError(401), "auth_required"],
    [new TwoFactorRequiredError(), "two_factor_required"],
    [new AuthCookieRequiredError(), "auth_required"],
    [new AuthRequiredError(403), "unknown"],
    [new NetworkError(), "unknown"],
    [new ServerError(503), "unknown"],
    [new ApiSchemaError(), "unknown"],
    [new AuthCookieBusyError(), "unknown"],
    [new AuthCookieCleanupError(), "unknown"],
    [new AuthCookieConflictError(), "unknown"]
  ];
  for (const [error, expected] of cases) {
    const f = fixture(); f.fail(error);
    assert.equal((await f.checker.check()).state, expected);
    await f.checker.check();
    assert.equal(f.calls, 1, "failed checks are cached too");
  }
});

test("auth checks honor shared backoff and preserve a newly observed Retry-After", async () => {
  const f = fixture(); f.limit(120_000);
  assert.equal((await f.checker.check()).state, "rate_limited");
  assert.equal(f.calls, 0);
  f.advance(60_001);
  assert.equal((await f.checker.check()).state, "rate_limited");
  assert.equal(f.calls, 0);
  f.advance(60_000);
  assert.equal((await f.checker.check()).state, "authenticated");
  const g = fixture();
  g.fail(new RateLimitedError(Date.parse("2026-10-04T12:03:00Z"), Date.parse("2026-10-04T12:00:00Z")));
  assert.equal((await g.checker.check()).retryAt, "2026-10-04T12:03:00.000Z");
  g.advance(61_000);
  await g.checker.check();
  assert.equal(g.calls, 1);
});

test("busy or maintenance never probes and busy is not cached", async () => {
  const f = fixture(); f.allow(false);
  assert.equal((await f.checker.check()).state, "busy");
  f.allow(true);
  assert.equal((await f.checker.check()).state, "authenticated");
  const g = fixture(); g.maintain();
  assert.equal((await g.checker.check()).state, "busy");
  assert.equal(g.calls, 0);
});

test("bridge sessions serialize sync, probes and cleanup, and recover after rejection", async () => {
  const f = fixture();
  /** @type {() => void} */ let release = () => {};
  const held = new Promise((resolve) => { release = () => resolve(undefined); });
  const sync = f.sessions.run(() => held);
  assert.equal((await f.checker.check()).state, "busy");
  let cleanup = false;
  const cleaned = f.sessions.run(async () => { cleanup = true; throw new Error("cleanup failed"); });
  const rejection = assert.rejects(cleaned, /cleanup failed/u);
  assert.equal(cleanup, false);
  release(); await sync; await rejection;
  assert.equal(cleanup, true);
  assert.equal((await f.checker.check()).state, "authenticated");
});

test("auth rechecks the maintenance gate after async rule setup", async () => {
  let allowed = true;
  let calls = 0;
  const checker = createAuthStatusChecker({
    sessions: new ApiSessionCoordinator(), canCheck: () => allowed,
    isMaintenancePending: async () => false, getBackoffUntil: async () => null,
    recordRateLimit: async () => 0,
    ensureUserAgentRule: async () => { allowed = false; },
    probe: async () => { calls += 1; }
  });
  assert.equal((await checker.check()).state, "busy");
  assert.equal(calls, 0);
});

test("background keeps auth separate from GET_STATUS and shares the bridge coordinator", async () => {
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  assert.match(source, /message\.type === MESSAGE_TYPES\.getStatus\)\s*\{\s*return \{ ok: true, status: await dependencies\.service\.getStatus\(\) \};/u);
  assert.match(source, /checkAuthStatus: "CHECK_AUTH_STATUS"/u);
  assert.match(source, /withApiSession: \(operation\) => apiSessions\.run/u);
  assert.equal(source.match(/apiSessions\.run\(\(\) => authCookieBridge\.cleanupStaleCookies\(\)\)/gu)?.length, 2);
  assert.match(source, /api\.getCurrentUser\(\{maxRetries: 0, timeoutMs: 5_000\}\)/u);
});
