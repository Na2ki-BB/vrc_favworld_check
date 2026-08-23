// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTH_COOKIE_BRIDGE_ERROR_CODES,
  AuthCookieBridge,
  AuthCookieBusyError,
  AuthCookieCleanupError,
  AuthCookieConflictError,
  AuthCookiePartitionedError,
  AuthCookieRequiredError,
  AuthCookieSetupError,
  BRIDGE_MARKER_NAME,
  BRIDGE_MARKER_PATH,
  BRIDGE_MARKER_URL,
  BRIDGE_MARKER_VALUE,
  MARKER_GRACE_SECONDS,
  SOURCE_AUTH_URL,
  TARGET_AUTH_URL,
  TARGET_COOKIE_PATH,
  TEMPORARY_COOKIE_LIFETIME_SECONDS
} from "../extension/lib/auth-cookie-bridge.js";

const NOW_MS = 1_700_000_000_000;
const NOW_SECONDS = NOW_MS / 1_000;
const STORE_ID = "0";
const AUTH_SECRET = "fixture-auth-value";
const TWO_FACTOR_SECRET = "fixture-two-factor-value";
const COOKIE_PERMISSION_HOSTS = ["vrchat.com", "vrchat.cloud", "api.vrchat.cloud"];

/** @typedef {{method: "get" | "getAll" | "set" | "remove", details: chrome.cookies.CookieDetails | chrome.cookies.GetAllDetails | chrome.cookies.SetDetails}} CookieCall */

class FakeCookies {
  /** @type {chrome.cookies.Cookie[]} */
  cookies;
  /** @type {CookieCall[]} */
  calls = [];
  /** @type {string | null} */
  setUndefinedName = null;
  /** @type {string | null} */
  setThrowName = null;
  /** @type {string | null} */
  removeUndefinedName = null;
  /** @type {string | null} */
  removeThrowName = null;
  /** @type {((details: chrome.cookies.GetAllDetails) => void) | null} */
  beforeGetAll = null;
  /** @type {Set<string>} */
  allowedCookieDomains;

  /**
   * @param {chrome.cookies.Cookie[]} [cookies]
   * @param {string[]} [allowedCookieDomains]
   */
  constructor(cookies = [], allowedCookieDomains = COOKIE_PERMISSION_HOSTS) {
    this.cookies = [...cookies];
    this.allowedCookieDomains = new Set(allowedCookieDomains);
  }

  /** @param {chrome.cookies.CookieDetails} details */
  async get(details) {
    this.calls.push({ method: "get", details: { ...details } });
    return this.#matching(details)
      .sort((left, right) => right.path.length - left.path.length)[0];
  }

  /** @param {chrome.cookies.GetAllDetails} details */
  async getAll(details) {
    this.calls.push({ method: "getAll", details: { ...details } });
    this.beforeGetAll?.(details);
    return this.#matching(details)
      .sort((left, right) => right.path.length - left.path.length);
  }

  /** @param {chrome.cookies.SetDetails} details */
  async set(details) {
    this.calls.push({ method: "set", details: { ...details } });
    if (details.name === this.setThrowName) {
      throw new Error(`browser rejected ${String(details.value)}`);
    }
    if (details.name === this.setUndefinedName) {
      return undefined;
    }

    const url = new URL(details.url);
    const name = details.name ?? "";
    const domain = url.hostname;
    const path = details.path ?? defaultCookiePath(url.pathname);
    const storeId = details.storeId ?? STORE_ID;
    const cookie = makeCookie({
      name,
      value: details.value ?? "",
      domain,
      path,
      storeId,
      hostOnly: details.domain === undefined,
      secure: details.secure ?? false,
      httpOnly: details.httpOnly ?? false,
      sameSite: details.sameSite ?? "unspecified",
      ...(details.expirationDate === undefined
        ? {}
        : { expirationDate: details.expirationDate })
    });

    this.cookies = this.cookies.filter((candidate) => !(
      candidate.name === cookie.name &&
      candidate.domain === cookie.domain &&
      candidate.path === cookie.path &&
      candidate.storeId === cookie.storeId &&
      candidate.partitionKey === undefined
    ));
    this.cookies.push(cookie);
    return cookie;
  }

  /** @param {chrome.cookies.CookieDetails} details */
  async remove(details) {
    this.calls.push({ method: "remove", details: { ...details } });
    if (details.name === this.removeThrowName) {
      throw new Error("browser remove failed");
    }
    if (details.name === this.removeUndefinedName) {
      return undefined;
    }

    const candidate = this.#matching(details)
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (candidate === undefined) {
      return undefined;
    }
    const index = this.cookies.indexOf(candidate);
    this.cookies.splice(index, 1);
    return { ...details };
  }

  /**
   * Read-only test inspection that does not count as a Cookie API call.
   * @param {chrome.cookies.GetAllDetails} details
   */
  peek(details) {
    return this.#matching(details);
  }

  /** @param {chrome.cookies.GetAllDetails} details */
  #matching(details) {
    return this.cookies.filter((cookie) => {
      const cookieDomain = cookie.domain.replace(/^\./u, "").toLowerCase();
      if (!this.allowedCookieDomains.has(cookieDomain)) {
        return false;
      }
      if (details.name !== undefined && cookie.name !== details.name) {
        return false;
      }
      if (details.storeId !== undefined && cookie.storeId !== details.storeId) {
        return false;
      }
      if (details.domain !== undefined &&
          cookie.domain.replace(/^\./u, "") !== details.domain.replace(/^\./u, "")) {
        return false;
      }
      if (details.url !== undefined && !cookieMatchesUrl(cookie, new URL(details.url))) {
        return false;
      }
      return true;
    });
  }
}

test("copies fixed auth cookies in order and always removes auth before marker", async () => {
  const fake = new FakeCookies([
    sourceCookie("auth", AUTH_SECRET, NOW_SECONDS + 600),
    sourceCookie("twoFactorAuth", TWO_FACTOR_SECRET, NOW_SECONDS + 3_600)
  ]);
  const bridge = createBridge(fake);
  let operationCalls = 0;

  const result = await bridge.withTemporaryApiCookies(() => {
    operationCalls += 1;
    const auth = fake.peek({ url: TARGET_AUTH_URL, name: "auth", storeId: STORE_ID });
    const twoFactor = fake.peek({
      url: TARGET_AUTH_URL,
      name: "twoFactorAuth",
      storeId: STORE_ID
    });
    assert.equal(auth[0]?.value, AUTH_SECRET);
    assert.equal(twoFactor[0]?.value, TWO_FACTOR_SECRET);
    return "operation-result";
  });

  assert.equal(result, "operation-result");
  assert.equal(operationCalls, 1);
  assert.deepEqual(fake.peek({ url: TARGET_AUTH_URL, name: "auth" }), []);
  assert.deepEqual(fake.peek({ url: TARGET_AUTH_URL, name: "twoFactorAuth" }), []);
  assert.deepEqual(fake.peek({ url: BRIDGE_MARKER_URL, name: BRIDGE_MARKER_NAME }), []);

  const sourceGets = fake.calls.filter((call) => (
    call.method === "get" && call.details.url === SOURCE_AUTH_URL
  ));
  assert.deepEqual(sourceGets.map((call) => call.details.name), [
    "auth",
    "twoFactorAuth"
  ]);
  assert.equal(fake.calls.some((call) => (
    call.method === "getAll" && call.details.url === SOURCE_AUTH_URL
  )), false);

  const sets = fake.calls.filter((call) => call.method === "set");
  assert.deepEqual(sets.map((call) => call.details.name), [
    BRIDGE_MARKER_NAME,
    "auth",
    "twoFactorAuth"
  ]);
  const markerSet = /** @type {chrome.cookies.SetDetails} */ (sets[0]?.details);
  const authSet = /** @type {chrome.cookies.SetDetails} */ (sets[1]?.details);
  const twoFactorSet = /** @type {chrome.cookies.SetDetails} */ (sets[2]?.details);
  assert.equal(Object.hasOwn(markerSet, "domain"), false);
  assert.equal(Object.hasOwn(authSet, "domain"), false);
  assert.equal(markerSet.path, BRIDGE_MARKER_PATH);
  assert.equal(authSet.path, TARGET_COOKIE_PATH);
  assert.equal(authSet.secure, true);
  assert.equal(authSet.httpOnly, true);
  assert.equal(authSet.sameSite, "strict");
  assert.equal(authSet.storeId, STORE_ID);
  assert.equal(authSet.expirationDate, NOW_SECONDS + 600);
  assert.equal(
    twoFactorSet.expirationDate,
    NOW_SECONDS + TEMPORARY_COOKIE_LIFETIME_SECONDS
  );
  assert.equal(
    markerSet.expirationDate,
    NOW_SECONDS + TEMPORARY_COOKIE_LIFETIME_SECONDS + MARKER_GRACE_SECONDS
  );

  const removes = fake.calls.filter((call) => call.method === "remove");
  assert.deepEqual(removes.map((call) => call.details.name), [
    "auth",
    "twoFactorAuth",
    BRIDGE_MARKER_NAME
  ]);
});

test("Chrome-style undefined twoFactorAuth is optional and no other source cookies are read", async () => {
  const fake = new FakeCookies([
    sourceCookie("auth", AUTH_SECRET),
    sourceCookie("unrelated", "must-not-be-read")
  ]);
  const bridge = createBridge(fake);

  await bridge.withTemporaryApiCookies(async () => {});

  const sourceReads = fake.calls.filter((call) => call.details.url === SOURCE_AUTH_URL);
  assert.deepEqual(sourceReads.map((call) => [call.method, call.details.name]), [
    ["get", "auth"],
    ["get", "twoFactorAuth"]
  ]);
  const setNames = fake.calls
    .filter((call) => call.method === "set")
    .map((call) => call.details.name);
  assert.deepEqual(setNames, [BRIDGE_MARKER_NAME, "auth"]);
});

test("marker recovery window stays twenty minutes when source expires sooner", async () => {
  const fake = new FakeCookies([
    sourceCookie("auth", AUTH_SECRET, NOW_SECONDS + 60)
  ]);

  await createBridge(fake).withTemporaryApiCookies(async () => {});

  const markerSet = fake.calls.find((call) => (
    call.method === "set" && call.details.name === BRIDGE_MARKER_NAME
  ));
  const markerDetails = /** @type {chrome.cookies.SetDetails | undefined} */ (
    markerSet?.details
  );
  assert.equal(
    markerDetails?.expirationDate,
    NOW_SECONDS + TEMPORARY_COOKIE_LIFETIME_SECONDS + MARKER_GRACE_SECONDS
  );
});

test("Chrome-style undefined source auth fails as auth-required without running the operation", async () => {
  const fake = new FakeCookies();
  const bridge = createBridge(fake);
  let operationCalls = 0;

  await assert.rejects(
    bridge.withTemporaryApiCookies(() => {
      operationCalls += 1;
    }),
    (error) => {
      assert.ok(error instanceof AuthCookieRequiredError);
      assert.equal(error.code, AUTH_COOKIE_BRIDGE_ERROR_CODES.AUTH_REQUIRED);
      return true;
    }
  );
  assert.equal(operationCalls, 0);
  assert.equal(fake.calls.some((call) => call.method === "set"), false);
});

test("stale target cookies are preserved before source auth is read", async () => {
  const fake = new FakeCookies([
    markerCookie(NOW_SECONDS + 1_200),
    targetCookie("auth", "stale-owned-value")
  ]);
  let operationCalls = 0;

  await assert.rejects(
    createBridge(fake).withTemporaryApiCookies(() => {
      operationCalls += 1;
    }),
    AuthCookieCleanupError
  );

  assert.equal(operationCalls, 0);
  assert.equal(fake.peek({ url: TARGET_AUTH_URL, name: "auth" }).length, 1);
  assert.equal(
    fake.peek({ url: BRIDGE_MARKER_URL, name: BRIDGE_MARKER_NAME }).length,
    1
  );
  assert.equal(fake.calls.some((call) => (
    call.method === "get" &&
    call.details.url === SOURCE_AUTH_URL &&
    call.details.name === "auth"
  )), false);
  assert.equal(fake.calls.some((call) => call.method === "remove"), false);
});

test("a non-Secure source is accepted while the temporary target stays Secure", async () => {
  const fake = new FakeCookies([
    sourceCookie("auth", AUTH_SECRET, undefined, { secure: false }),
    sourceCookie("twoFactorAuth", TWO_FACTOR_SECRET, undefined, { secure: false })
  ]);

  await createBridge(fake).withTemporaryApiCookies(async () => {
    const authTarget = fake.peek({
      url: TARGET_AUTH_URL,
      name: "auth",
      storeId: STORE_ID
    });
    const twoFactorTarget = fake.peek({
      url: TARGET_AUTH_URL,
      name: "twoFactorAuth",
      storeId: STORE_ID
    });
    assert.equal(authTarget[0]?.secure, true);
    assert.equal(twoFactorTarget[0]?.secure, true);
  });

  const authSource = fake.peek({
    url: SOURCE_AUTH_URL,
    name: "auth",
    storeId: STORE_ID
  });
  const twoFactorSource = fake.peek({
    url: SOURCE_AUTH_URL,
    name: "twoFactorAuth",
    storeId: STORE_ID
  });
  assert.equal(authSource[0]?.secure, false);
  assert.equal(twoFactorSource[0]?.secure, false);
  assert.deepEqual(fake.peek({ url: TARGET_AUTH_URL, name: "auth" }), []);
  assert.deepEqual(fake.peek({ url: TARGET_AUTH_URL, name: "twoFactorAuth" }), []);
});

test("an unmarked target cookie at any API path is a non-destructive conflict", async () => {
  const target = targetCookie("auth", "another-session", {
    path: "/api/1/favorites"
  });
  const fake = new FakeCookies([
    sourceCookie("auth", AUTH_SECRET),
    target
  ]);
  const bridge = createBridge(fake);

  await assert.rejects(
    bridge.withTemporaryApiCookies(async () => {}),
    AuthCookieConflictError
  );

  assert.equal(fake.calls.some((call) => call.method === "set"), false);
  assert.equal(fake.calls.some((call) => call.method === "remove"), false);
  assert.equal(fake.peek({ domain: "api.vrchat.cloud", name: "auth" })[0], target);
});

test("a parent-domain auth cookie that would reach the API is also a conflict", async () => {
  const target = targetCookie("auth", "parent-domain-session", {
    domain: ".vrchat.cloud",
    hostOnly: false,
    path: "/"
  });
  const fake = new FakeCookies([
    sourceCookie("auth", AUTH_SECRET),
    target
  ]);

  await assert.rejects(
    createBridge(fake).withTemporaryApiCookies(async () => {}),
    AuthCookieConflictError
  );

  assert.equal(fake.calls.some((call) => call.method === "set"), false);
  assert.equal(fake.calls.some((call) => call.method === "remove"), false);
  assert.equal(fake.peek({ url: TARGET_AUTH_URL, name: "auth" })[0], target);
});

test("Chrome-style host permission filtering requires the parent-domain permission", async () => {
  const parent = targetCookie("auth", "parent-domain-session", {
    domain: ".vrchat.cloud",
    hostOnly: false,
    path: "/"
  });
  const withoutParentPermission = new FakeCookies(
    [parent],
    ["vrchat.com", "api.vrchat.cloud"]
  );
  const withParentPermission = new FakeCookies([parent]);

  assert.deepEqual(
    await withoutParentPermission.getAll({ name: "auth", storeId: STORE_ID }),
    []
  );
  assert.equal(
    (await withParentPermission.getAll({ name: "auth", storeId: STORE_ID }))[0],
    parent
  );
});

test("an orphaned stale marker is removed before a fresh bridge", async () => {
  const fake = new FakeCookies([
    sourceCookie("auth", AUTH_SECRET),
    markerCookie(NOW_SECONDS + 1_200)
  ]);
  const bridge = createBridge(fake);

  await bridge.withTemporaryApiCookies(() => {
    assert.equal(
      fake.peek({ url: TARGET_AUTH_URL, name: "auth" })[0]?.value,
      AUTH_SECRET
    );
  });

  const firstSetIndex = fake.calls.findIndex((call) => call.method === "set");
  const firstMarkerRemoveIndex = fake.calls.findIndex((call) => (
    call.method === "remove" && call.details.name === BRIDGE_MARKER_NAME
  ));
  assert.ok(firstMarkerRemoveIndex >= 0);
  assert.ok(firstMarkerRemoveIndex < firstSetIndex);
});

test("partitioned cookies returned by the adapter fail closed", async (t) => {
  await t.test("source", async () => {
    const fake = new FakeCookies([
      sourceCookie("auth", AUTH_SECRET, undefined, {
        partitionKey: { topLevelSite: "https://vrchat.com" }
      })
    ]);
    await assert.rejects(
      createBridge(fake).withTemporaryApiCookies(async () => {}),
      AuthCookiePartitionedError
    );
    assert.equal(fake.calls.some((call) => call.method === "set"), false);
  });

  await t.test("target", async () => {
    const fake = new FakeCookies([
      sourceCookie("auth", AUTH_SECRET),
      targetCookie("auth", "partitioned-target", {
        partitionKey: { topLevelSite: "https://vrchat.com" }
      })
    ]);
    await assert.rejects(
      createBridge(fake).withTemporaryApiCookies(async () => {}),
      AuthCookiePartitionedError
    );
    assert.equal(fake.calls.some((call) => call.method === "remove"), false);
  });

  await t.test("marker", async () => {
    const fake = new FakeCookies([
      sourceCookie("auth", AUTH_SECRET),
      markerCookie(NOW_SECONDS + 1_200, {
        partitionKey: { topLevelSite: "https://vrchat.com" }
      })
    ]);
    await assert.rejects(
      createBridge(fake).withTemporaryApiCookies(async () => {}),
      AuthCookiePartitionedError
    );
    assert.equal(fake.calls.some((call) => call.method === "remove"), false);
  });
});

test("operation errors are preserved after temporary cookies are cleaned", async () => {
  const fake = new FakeCookies([sourceCookie("auth", AUTH_SECRET)]);
  const bridge = createBridge(fake);
  const operationError = new Error("operation failed");

  await assert.rejects(
    bridge.withTemporaryApiCookies(() => {
      throw operationError;
    }),
    (error) => error === operationError
  );

  assert.deepEqual(fake.peek({ url: TARGET_AUTH_URL, name: "auth" }), []);
  assert.deepEqual(fake.peek({ url: BRIDGE_MARKER_URL, name: BRIDGE_MARKER_NAME }), []);
});

test("a target cookie changed during the operation is preserved and fails cleanup", async () => {
  const fake = new FakeCookies([sourceCookie("auth", AUTH_SECRET)]);

  await assert.rejects(
    createBridge(fake).withTemporaryApiCookies(async () => {
      await fake.set({
        url: TARGET_AUTH_URL,
        name: "auth",
        value: "changed-by-another-owner",
        path: TARGET_COOKIE_PATH,
        secure: true,
        httpOnly: true,
        sameSite: "strict",
        expirationDate: NOW_SECONDS + TEMPORARY_COOKIE_LIFETIME_SECONDS,
        storeId: STORE_ID
      });
    }),
    AuthCookieCleanupError
  );

  assert.equal(
    fake.peek({ url: TARGET_AUTH_URL, name: "auth" })[0]?.value,
    "changed-by-another-owner"
  );
  assert.equal(
    fake.peek({ url: BRIDGE_MARKER_URL, name: BRIDGE_MARKER_NAME }).length,
    1
  );
  assert.equal(fake.calls.some((call) => call.method === "remove"), false);
});

test("a target cookie changed after the first cleanup check is not removed", async () => {
  const fake = new FakeCookies([sourceCookie("auth", AUTH_SECRET)]);
  let authReadsUntilMutation = 2;
  fake.beforeGetAll = (details) => {
    if (details.name !== "auth" || authReadsUntilMutation <= 0) {
      return;
    }
    authReadsUntilMutation -= 1;
    if (authReadsUntilMutation === 0) {
      const targetIndex = fake.cookies.findIndex((cookie) => (
        cookie.name === "auth" && cookie.domain === "api.vrchat.cloud"
      ));
      const target = fake.cookies[targetIndex];
      if (targetIndex >= 0 && target !== undefined) {
        fake.cookies[targetIndex] = {
          ...target,
          value: "changed-between-check-and-remove"
        };
      }
    }
  };

  await assert.rejects(
    createBridge(fake).withTemporaryApiCookies(async () => {
      authReadsUntilMutation = 2;
    }),
    AuthCookieCleanupError
  );

  assert.equal(
    fake.peek({ url: TARGET_AUTH_URL, name: "auth" })[0]?.value,
    "changed-between-check-and-remove"
  );
  assert.equal(
    fake.calls.some((call) => call.method === "remove" && call.details.name === "auth"),
    false
  );
});

test("undefined set results and secret-bearing browser errors become sanitized setup errors", async (t) => {
  await t.test("undefined result", async () => {
    const fake = new FakeCookies([sourceCookie("auth", AUTH_SECRET)]);
    fake.setUndefinedName = "auth";

    await assert.rejects(
      createBridge(fake).withTemporaryApiCookies(async () => {}),
      AuthCookieSetupError
    );
    assert.deepEqual(fake.peek({ url: BRIDGE_MARKER_URL, name: BRIDGE_MARKER_NAME }), []);
  });

  await t.test("browser exception", async () => {
    const fake = new FakeCookies([sourceCookie("auth", AUTH_SECRET)]);
    fake.setThrowName = "auth";

    await assert.rejects(
      createBridge(fake).withTemporaryApiCookies(async () => {}),
      (error) => {
        assert.ok(error instanceof AuthCookieSetupError);
        assert.equal(error.message.includes(AUTH_SECRET), false);
        assert.equal(error.stack?.includes(AUTH_SECRET), false);
        assert.equal(JSON.stringify(error).includes(AUTH_SECRET), false);
        return true;
      }
    );
  });
});

test("undefined remove results become cleanup errors and never report success", async () => {
  const fake = new FakeCookies([sourceCookie("auth", AUTH_SECRET)]);
  fake.removeUndefinedName = "auth";

  await assert.rejects(
    createBridge(fake).withTemporaryApiCookies(() => "not-returned"),
    (error) => {
      assert.ok(error instanceof AuthCookieCleanupError);
      assert.equal(error.code, AUTH_COOKIE_BRIDGE_ERROR_CODES.CLEANUP_FAILED);
      return true;
    }
  );
});

test("public stale cleanup verifies failures and never touches unmarked target cookies", async (t) => {
  await t.test("unmarked target", async () => {
    const target = targetCookie("auth", "unowned", { path: "/" });
    const fake = new FakeCookies([target]);

    await createBridge(fake).cleanupStaleCookies();
    assert.deepEqual(
      fake.calls
        .filter((call) => call.method === "getAll")
        .map((call) => call.details.name),
      [BRIDGE_MARKER_NAME]
    );
    assert.equal(fake.calls.some((call) => call.method === "remove"), false);
    assert.equal(fake.peek({ url: TARGET_AUTH_URL, name: "auth" })[0], target);
  });

  await t.test("owned cleanup failure", async () => {
    const fake = new FakeCookies([
      markerCookie(NOW_SECONDS + 1_200),
      targetCookie("auth", "owned")
    ]);
    fake.removeThrowName = "auth";

    await assert.rejects(
      createBridge(fake).cleanupStaleCookies(),
      AuthCookieCleanupError
    );
  });

  await t.test("orphaned marker cleanup success", async () => {
    const fake = new FakeCookies([
      markerCookie(NOW_SECONDS + 1_200)
    ]);

    await createBridge(fake).cleanupStaleCookies();
    assert.deepEqual(fake.peek({ url: TARGET_AUTH_URL, name: "auth" }), []);
    assert.deepEqual(fake.peek({ url: BRIDGE_MARKER_URL, name: BRIDGE_MARKER_NAME }), []);
  });

  await t.test("server-refreshed attributes are preserved and fail cleanup", async () => {
    const refreshed = targetCookie("auth", "server-refreshed-value", {
      domain: ".vrchat.cloud",
      hostOnly: false,
      path: "/api/1/favorites",
      httpOnly: false,
      sameSite: "lax",
      expirationDate: NOW_SECONDS + 86_400
    });
    const fake = new FakeCookies([
      markerCookie(NOW_SECONDS + 1_200),
      refreshed
    ]);

    await assert.rejects(
      createBridge(fake).cleanupStaleCookies(),
      AuthCookieCleanupError
    );
    assert.equal(fake.calls.some((call) => call.method === "remove"), false);
    assert.equal(fake.peek({ name: "auth" })[0], refreshed);
    assert.equal(
      fake.peek({ url: BRIDGE_MARKER_URL, name: BRIDGE_MARKER_NAME }).length,
      1
    );
  });
});

test("concurrent bridge calls are rejected while the first operation remains active", async () => {
  const fake = new FakeCookies([sourceCookie("auth", AUTH_SECRET)]);
  const bridge = createBridge(fake);
  /** @type {() => void} */
  let release = () => {};
  const blocked = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  /** @type {() => void} */
  let entered = () => {};
  const operationEntered = new Promise((resolve) => {
    entered = () => resolve(undefined);
  });

  const first = bridge.withTemporaryApiCookies(async () => {
    entered();
    await blocked;
    return "first";
  });
  await operationEntered;

  await assert.rejects(
    bridge.withTemporaryApiCookies(() => "second"),
    (error) => {
      assert.ok(error instanceof AuthCookieBusyError);
      assert.equal(error.code, AUTH_COOKIE_BRIDGE_ERROR_CODES.BUSY);
      return true;
    }
  );
  release();
  assert.equal(await first, "first");
});

/** @param {FakeCookies} cookies */
function createBridge(cookies) {
  return new AuthCookieBridge({ cookies, clock: () => NOW_MS });
}

/**
 * @param {string} name
 * @param {string} value
 * @param {number} [expirationDate]
 * @param {Partial<chrome.cookies.Cookie>} [overrides]
 */
function sourceCookie(name, value, expirationDate, overrides = {}) {
  return makeCookie({
    name,
    value,
    domain: "vrchat.com",
    path: "/",
    storeId: STORE_ID,
    hostOnly: true,
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    ...(expirationDate === undefined ? {} : { expirationDate }),
    ...overrides
  });
}

/**
 * @param {string} name
 * @param {string} value
 * @param {Partial<chrome.cookies.Cookie>} [overrides]
 */
function targetCookie(name, value, overrides = {}) {
  return makeCookie({
    name,
    value,
    domain: "api.vrchat.cloud",
    path: TARGET_COOKIE_PATH,
    storeId: STORE_ID,
    hostOnly: true,
    secure: true,
    httpOnly: true,
    sameSite: "strict",
    expirationDate: NOW_SECONDS + TEMPORARY_COOKIE_LIFETIME_SECONDS,
    ...overrides
  });
}

/**
 * @param {number} expirationDate
 * @param {Partial<chrome.cookies.Cookie>} [overrides]
 */
function markerCookie(expirationDate, overrides = {}) {
  return makeCookie({
    name: BRIDGE_MARKER_NAME,
    value: BRIDGE_MARKER_VALUE,
    domain: "api.vrchat.cloud",
    path: BRIDGE_MARKER_PATH,
    storeId: STORE_ID,
    hostOnly: true,
    secure: true,
    httpOnly: true,
    sameSite: "strict",
    expirationDate,
    ...overrides
  });
}

/**
 * @param {{
 *   name: string,
 *   value: string,
 *   domain: string,
 *   path: string,
 *   storeId: string,
 *   hostOnly: boolean,
 *   secure: boolean,
 *   httpOnly: boolean,
 *   sameSite: `${chrome.cookies.SameSiteStatus}`,
 *   expirationDate?: number,
 *   partitionKey?: chrome.cookies.CookiePartitionKey
 * }} input
 * @returns {chrome.cookies.Cookie}
 */
function makeCookie(input) {
  return {
    name: input.name,
    value: input.value,
    domain: input.domain,
    path: input.path,
    storeId: input.storeId,
    hostOnly: input.hostOnly,
    secure: input.secure,
    httpOnly: input.httpOnly,
    sameSite: input.sameSite,
    session: input.expirationDate === undefined,
    ...(input.expirationDate === undefined ? {} : { expirationDate: input.expirationDate }),
    ...(input.partitionKey === undefined ? {} : { partitionKey: input.partitionKey })
  };
}

/**
 * @param {chrome.cookies.Cookie} cookie
 * @param {URL} url
 */
function cookieMatchesUrl(cookie, url) {
  const domain = cookie.domain.startsWith(".")
    ? cookie.domain.slice(1)
    : cookie.domain;
  const domainMatches = cookie.hostOnly
    ? url.hostname === domain
    : url.hostname === domain || url.hostname.endsWith(`.${domain}`);
  const pathMatches = url.pathname === cookie.path ||
    (url.pathname.startsWith(cookie.path) &&
     (cookie.path.endsWith("/") || url.pathname.at(cookie.path.length) === "/"));
  return domainMatches && pathMatches && (!cookie.secure || url.protocol === "https:");
}

/** @param {string} pathname */
function defaultCookiePath(pathname) {
  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash + 1);
}
