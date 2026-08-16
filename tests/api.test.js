// @ts-check

import test from "node:test";
import assert from "node:assert/strict";

import {
  API_ERROR_CODES,
  API_MAX_PAGE_REQUESTS,
  API_MAX_RESPONSE_BYTES,
  API_MAX_TAGS,
  API_MAX_TEXT_CODE_POINTS,
  ApiSchemaError,
  AuthRequiredError,
  NetworkError,
  PaginationError,
  RateLimitedError,
  ServerError,
  UnexpectedRedirectError,
  VRCHAT_API_BASE_URL,
  VrchatApi
} from "../extension/lib/api.js";

const USER_ID = "usr_00000000-0000-0000-0000-000000000001";
const WORLD_ID = "wrld_00000000-0000-0000-0000-000000000001";

/**
 * @typedef {(input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>} ResponseFactory
 * @typedef {Response | Error | ResponseFactory} ResponseStep
 * @typedef {{url: string, init: RequestInit | undefined, startedAt: number}} FetchCall
 */

/**
 * @param {ResponseStep[]} steps
 * @param {{startAt?: number, timeoutMs?: number, randomValue?: number}} [options]
 */
function createHarness(steps, options = {}) {
  let nowMs = options.startAt ?? 1_700_000_000_000;
  const pending = [...steps];
  /** @type {FetchCall[]} */
  const calls = [];
  /** @type {number[]} */
  const sleeps = [];

  /** @type {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>} */
  const fetch = async (input, init) => {
    calls.push({ url: String(input), init, startedAt: nowMs });
    const step = pending.shift();
    if (step === undefined) {
      throw new Error("Unexpected test request");
    }
    if (step instanceof Error) {
      throw step;
    }
    return typeof step === "function" ? await step(input, init) : step;
  };

  const api = new VrchatApi({
    fetch,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
      nowMs += delayMs;
    },
    clock: () => nowMs,
    random: () => options.randomValue ?? 0,
    timeoutMs: options.timeoutMs ?? 1_000
  });

  return { api, calls, sleeps, pending, now: () => nowMs };
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 */
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

/** @param {number} number */
function worldId(number) {
  return `wrld_00000000-0000-0000-0000-${String(number).padStart(12, "0")}`;
}

/** @param {number} number */
function relation(number) {
  return { favoriteId: worldId(number), tags: ["worlds1"], type: "world" };
}

/** @param {number} number */
function favoriteWorld(number) {
  return {
    id: worldId(number),
    name: `ワールド ${number}`,
    authorName: "作者",
    favoriteGroup: "worlds1",
    releaseStatus: "public"
  };
}

test("getCurrentUser uses fixed read-only options and projects only safe fields", async () => {
  const harness = createHarness([
    jsonResponse({
      id: USER_ID,
      displayName: "利用者",
      bio: "保存しない値",
      profile: { status: "active" }
    })
  ]);

  const user = await harness.api.getCurrentUser();

  assert.deepEqual(user, { id: USER_ID, displayName: "利用者" });
  assert.equal(harness.calls.length, 1);
  const call = harness.calls[0];
  assert.ok(call);
  assert.equal(call.url, `${VRCHAT_API_BASE_URL}/auth/user`);
  assert.equal(call.init?.method, "GET");
  assert.equal(call.init?.credentials, "include");
  assert.equal(call.init?.cache, "no-store");
  assert.equal(call.init?.redirect, "manual");
  assert.equal(call.init?.body, undefined);
  assert.ok(call.init?.signal instanceof AbortSignal);
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get("Accept"), "application/json");
  assert.equal(headers.has("Authorization"), false);
});

test("getCurrentUser fails closed on a nested sensitive field without exposing it", async () => {
  const secret = "do-not-copy-this-value";
  const harness = createHarness([
    jsonResponse({
      id: USER_ID,
      displayName: "利用者",
      nested: { auth_token: secret }
    })
  ]);

  await assert.rejects(harness.api.getCurrentUser(), (error) => {
    assert.ok(error instanceof ApiSchemaError);
    assert.equal(error.code, API_ERROR_CODES.API_INCOMPATIBLE);
    assert.equal(error.category, "schema");
    assert.equal(error.message.includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
  assert.equal(harness.calls.length, 1);
});

test("getCurrentUser rejects unknown credential-like keys but accepts known friendKey", async () => {
  for (const field of ["accessKey", "privateKey", "authenticationKey", "signing_key"]) {
    const harness = createHarness([
      jsonResponse({
        id: USER_ID,
        displayName: "利用者",
        nested: { [field]: "fixture-value" }
      })
    ]);

    await assert.rejects(
      harness.api.getCurrentUser(),
      ApiSchemaError,
      `credential-like field must be rejected: ${field}`
    );
    assert.equal(harness.calls.length, 1);
  }

  const compatible = createHarness([
    jsonResponse({
      id: USER_ID,
      displayName: "利用者",
      friendKey: "known-vrchat-field"
    })
  ]);
  assert.deepEqual(await compatible.api.getCurrentUser(), {
    id: USER_ID,
    displayName: "利用者"
  });

  const misplacedKnownField = createHarness([
    jsonResponse({
      id: USER_ID,
      displayName: "利用者",
      nested: { friendKey: "unexpected-location" }
    })
  ]);
  await assert.rejects(misplacedKnownField.api.getCurrentUser(), ApiSchemaError);
});

test("getCurrentUser rejects invalid and excessively deep schemas", async () => {
  /** @type {Record<string, unknown>} */
  const deep = { id: USER_ID, displayName: "利用者" };
  /** @type {Record<string, unknown>} */
  let cursor = deep;
  for (let index = 0; index < 10; index += 1) {
    const nested = {};
    cursor.next = nested;
    cursor = nested;
  }

  const invalidIdHarness = createHarness([
    jsonResponse({ id: "not-a-user-id", displayName: "利用者" })
  ]);
  await assert.rejects(
    invalidIdHarness.api.getCurrentUser(),
    ApiSchemaError
  );

  const deepHarness = createHarness([jsonResponse(deep)]);
  await assert.rejects(deepHarness.api.getCurrentUser(), ApiSchemaError);
});

test("successful responses require bounded JSON and bounded text fields", async () => {
  const wrongMediaType = createHarness([
    new Response(JSON.stringify({ id: USER_ID, displayName: "利用者" }), {
      status: 200,
      headers: { "Content-Type": "text/plain" }
    })
  ]);
  await assert.rejects(wrongMediaType.api.getCurrentUser(), ApiSchemaError);

  const oversizedDeclaration = createHarness([
    jsonResponse(
      { id: USER_ID, displayName: "利用者" },
      200,
      { "Content-Length": String(API_MAX_RESPONSE_BYTES + 1) }
    )
  ]);
  await assert.rejects(oversizedDeclaration.api.getCurrentUser(), ApiSchemaError);

  const oversizedName = createHarness([
    jsonResponse({
      id: USER_ID,
      displayName: "x".repeat(API_MAX_TEXT_CODE_POINTS + 1)
    })
  ]);
  await assert.rejects(oversizedName.api.getCurrentUser(), ApiSchemaError);

  const tooManyTags = createHarness([
    jsonResponse([{
      favoriteId: WORLD_ID,
      tags: Array.from({ length: API_MAX_TAGS + 1 }, (_, index) => `tag-${index}`),
      type: "world"
    }])
  ]);
  await assert.rejects(tooManyTags.api.listAllFavoriteRelations(), ApiSchemaError);
});

test("favorite relation pagination continues after short pages and ends only on empty", async () => {
  const harness = createHarness([
    jsonResponse([relation(1), relation(2)]),
    jsonResponse([relation(3)]),
    jsonResponse([])
  ]);

  const result = await harness.api.listAllFavoriteRelations();

  assert.deepEqual(result, [relation(1), relation(2), relation(3)]);
  assert.deepEqual(
    harness.calls.map((call) => call.url),
    [
      `${VRCHAT_API_BASE_URL}/favorites?type=world&n=100&offset=0`,
      `${VRCHAT_API_BASE_URL}/favorites?type=world&n=100&offset=2`,
      `${VRCHAT_API_BASE_URL}/favorites?type=world&n=100&offset=3`
    ]
  );
  assert.deepEqual(harness.sleeps, [2_000, 2_000]);
});

test("favorite world pagination includes releaseStatus=all and validates metadata", async () => {
  const harness = createHarness([
    jsonResponse([{ ...favoriteWorld(1), releaseStatus: "private" }]),
    jsonResponse([])
  ]);

  const result = await harness.api.listAllFavoriteWorlds();

  assert.deepEqual(result, [{ ...favoriteWorld(1), releaseStatus: "private" }]);
  assert.equal(
    harness.calls[0]?.url,
    `${VRCHAT_API_BASE_URL}/worlds/favorites?n=100&offset=0&releaseStatus=all`
  );
  assert.equal(
    harness.calls[1]?.url,
    `${VRCHAT_API_BASE_URL}/worlds/favorites?n=100&offset=1&releaseStatus=all`
  );

  const invalidHarness = createHarness([
    jsonResponse([{ ...favoriteWorld(1), favoriteGroup: null }])
  ]);
  await assert.rejects(
    invalidHarness.api.listAllFavoriteWorlds(),
    ApiSchemaError
  );
});

test("an initially empty page is a complete empty snapshot", async () => {
  const harness = createHarness([jsonResponse([])]);
  assert.deepEqual(await harness.api.listAllFavoriteRelations(), []);
  assert.equal(harness.calls.length, 1);
});

test("repeated non-empty page fingerprints stop pagination", async () => {
  const page = [relation(1)];
  const sameIdsWithChangedFields = [{ ...relation(1), tags: ["worlds2"] }];
  const harness = createHarness([
    jsonResponse(page),
    jsonResponse(sameIdsWithChangedFields)
  ]);

  await assert.rejects(
    harness.api.listAllFavoriteRelations(),
    PaginationError
  );
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.pending.length, 0);
});

test("pagination makes at most 101 requests without an empty terminator", async () => {
  const responses = Array.from(
    { length: API_MAX_PAGE_REQUESTS },
    (_, index) => jsonResponse([relation(index + 1)])
  );
  const harness = createHarness(responses);

  await assert.rejects(
    harness.api.listAllFavoriteRelations(),
    PaginationError
  );
  assert.equal(harness.calls.length, API_MAX_PAGE_REQUESTS);
});

test("getWorld returns only 200 metadata or a 404 observation", async () => {
  const world = {
    id: WORLD_ID,
    name: "思い出のワールド",
    authorName: "作者",
    releaseStatus: "hidden",
    description: "保存しない"
  };
  const foundHarness = createHarness([jsonResponse(world)]);
  assert.deepEqual(await foundHarness.api.getWorld(WORLD_ID), {
    status: 200,
    world: {
      id: WORLD_ID,
      name: "思い出のワールド",
      authorName: "作者",
      releaseStatus: "hidden"
    }
  });

  const missingHarness = createHarness([new Response(null, { status: 404 })]);
  assert.deepEqual(await missingHarness.api.getWorld(WORLD_ID), {
    status: 404,
    world: null
  });

  const list404Harness = createHarness([new Response(null, { status: 404 })]);
  await assert.rejects(
    list404Harness.api.listAllFavoriteRelations(),
    ApiSchemaError
  );
});

test("401 and auth endpoint 403 stop immediately without retry", async () => {
  const unauthorized = createHarness([new Response(null, { status: 401 })]);
  await assert.rejects(unauthorized.api.getCurrentUser(), (error) => {
    assert.ok(error instanceof AuthRequiredError);
    assert.equal(error.code, API_ERROR_CODES.AUTH_REQUIRED);
    return true;
  });
  assert.equal(unauthorized.calls.length, 1);

  const forbidden = createHarness([new Response(null, { status: 403 })]);
  await assert.rejects(forbidden.api.getCurrentUser(), AuthRequiredError);
  assert.equal(forbidden.calls.length, 1);
});

test("429 parses Retry-After and stops the paged operation without another request", async () => {
  const harness = createHarness([
    jsonResponse([relation(1)]),
    new Response(null, { status: 429, headers: { "Retry-After": "120" } })
  ]);

  await assert.rejects(harness.api.listAllFavoriteRelations(), (error) => {
    assert.ok(error instanceof RateLimitedError);
    assert.equal(error.code, API_ERROR_CODES.RATE_LIMITED);
    assert.equal(error.retryAfterMs, 120_000);
    assert.equal(error.retryAt, harness.now() + 120_000);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(harness.calls.length, 2);
  assert.deepEqual(harness.sleeps, [2_000]);
});

test("5xx and network failures retry at most twice with short jittered delays", async () => {
  const serverHarness = createHarness([
    new Response(null, { status: 503 }),
    new Response(null, { status: 503 }),
    new Response(null, { status: 503 })
  ]);
  await assert.rejects(serverHarness.api.getCurrentUser(), (error) => {
    assert.ok(error instanceof ServerError);
    assert.equal(error.code, API_ERROR_CODES.SERVER_ERROR);
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(serverHarness.calls.length, 3);
  assert.deepEqual(serverHarness.sleeps, [2_000, 4_000]);

  const networkHarness = createHarness([
    new TypeError("network fixture"),
    new TypeError("network fixture"),
    new TypeError("network fixture")
  ]);
  await assert.rejects(networkHarness.api.getCurrentUser(), NetworkError);
  assert.equal(networkHarness.calls.length, 3);
  assert.deepEqual(networkHarness.sleeps, [2_000, 4_000]);
});

test("manual redirects are rejected and never retried", async () => {
  const harness = createHarness([
    new Response(null, {
      status: 302,
      headers: { Location: "https://example.invalid/collect" }
    })
  ]);

  await assert.rejects(harness.api.getCurrentUser(), (error) => {
    assert.ok(error instanceof UnexpectedRedirectError);
    assert.equal(error.code, API_ERROR_CODES.UNEXPECTED_REDIRECT);
    return true;
  });
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0]?.init?.redirect, "manual");
});

test("concurrent calls are serialized and start at least two seconds apart", async () => {
  /** @type {number[]} */
  const starts = [];
  const harness = createHarness([
    () => {
      starts.push(harness.now());
      return jsonResponse({ id: USER_ID, displayName: "利用者" });
    },
    () => {
      starts.push(harness.now());
      return jsonResponse({
        id: WORLD_ID,
        name: "ワールド",
        authorName: "作者",
        releaseStatus: "public"
      });
    }
  ]);

  await Promise.all([
    harness.api.getCurrentUser(),
    harness.api.getWorld(WORLD_ID)
  ]);

  assert.equal(starts.length, 2);
  assert.ok(starts[1] !== undefined && starts[0] !== undefined);
  assert.ok(starts[1] - starts[0] >= 2_000);
});

test("request timeout is classified as a retried network failure", async () => {
  /** @type {ResponseFactory} */
  const neverCompletes = (input, init) => new Promise((resolve, reject) => {
    void input;
    void resolve;
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
  const harness = createHarness(
    [neverCompletes, neverCompletes, neverCompletes],
    { timeoutMs: 1 }
  );

  await assert.rejects(harness.api.getCurrentUser(), NetworkError);
  assert.equal(harness.calls.length, 3);
});
