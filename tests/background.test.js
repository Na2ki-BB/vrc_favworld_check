// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import {
  KEEPALIVE_INTERVAL_MS,
  MESSAGE_TYPES,
  VRCHAT_LOGIN_URL,
  createAlarmEventHandler,
  createBadgeUpdater,
  createGatedSyncRunner,
  createMessageHandler,
  createPurgeController,
  keepServiceWorkerAlive
} from "../extension/background.js";
import {
  ApiSchemaError,
  NetworkError,
  RateLimitedError,
  VRCHAT_API_BASE_URL
} from "../extension/lib/api.js";
import {
  AuthCookieCleanupError,
  AuthCookieConflictError,
  AuthCookiePartitionedError,
  AuthCookieRequiredError,
  AuthCookieSetupError
} from "../extension/lib/auth-cookie-bridge.js";
import { DatabaseRepository } from "../extension/lib/database.js";
import { ActiveRateLimitError } from "../extension/lib/auth-status.js";
import {
  ATTENTION_NOTIFICATION_ID_PREFIX,
  MANUAL_SYNC_COOLDOWN_MS,
  NOTIFICATION_EVENT_KINDS,
  SETTINGS_SCHEDULE_WARNING,
  SETTING_KEYS,
  SYNC_ALARM_NAME,
  SYNC_WATCHDOG_DELAY_MS,
  THUMBNAIL_CAPTURE_INTERVAL_MS,
  THUMBNAIL_RATE_LIMIT_FALLBACK_MS,
  captureAvailableWorldThumbnails,
  SyncService
} from "../extension/lib/sync-service.js";
import {
  THUMBNAIL_ERROR_CODES,
  ThumbnailError,
  ThumbnailFetchError
} from "../extension/lib/thumbnail.js";
import {
  RECOVERY_MIN_DELAY_MS,
  REGULAR_INTERVAL_MS,
  STARTUP_MIN_DELAY_MS
} from "../extension/lib/schedule.js";

const NOW = Date.parse("2026-08-17T00:00:00.000Z");
const USER_ID = "usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORLD_ID = "wrld_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

Object.defineProperty(globalThis, "IDBKeyRange", {
  configurable: true,
  value: IDBKeyRange
});

test("VRChat login and API use the two reviewed fixed origins", () => {
  assert.equal(new URL(VRCHAT_LOGIN_URL).origin, "https://vrchat.com");
  assert.equal(new URL(VRCHAT_API_BASE_URL).origin, "https://api.vrchat.cloud");
  assert.notEqual(new URL(VRCHAT_LOGIN_URL).origin, new URL(VRCHAT_API_BASE_URL).origin);
});

test("thumbnail capture skips matching versions and stores only bounded encoded output", async () => {
  const secondWorldId = "wrld_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const existingUrl = "https://api.vrchat.cloud/api/1/file/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/file";
  const newUrl = "https://api.vrchat.cloud/api/1/file/file_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/1/file";
  /** @type {Array<{record: Parameters<DatabaseRepository["putThumbnail"]>[0], generation: number | undefined}>} */
  const stored = [];
  /** @type {number[]} */
  const waits = [];
  /** @type {string[]} */
  const encodedUrls = [];
  const result = await captureAvailableWorldThumbnails({
    userId: USER_ID,
    metadata: [
      {
        id: WORLD_ID,
        name: "保存済み",
        authorName: "作者",
        favoriteGroup: "worlds1",
        releaseStatus: "public",
        thumbnailImageUrl: existingUrl
      },
      {
        id: secondWorldId,
        name: "新規",
        authorName: "作者",
        favoriteGroup: "worlds2",
        releaseStatus: "public",
        thumbnailImageUrl: newUrl
      }
    ],
    generation: 4,
    capturedAt: "2026-08-24T00:00:00.000Z",
    repository: {
      listThumbnailMetadata: async () => [{
        userId: USER_ID,
        worldId: WORLD_ID,
        width: 320,
        height: 180,
        byteLength: 3,
        capturedAt: "2026-08-23T00:00:00.000Z",
        sourceUrl: existingUrl
      }],
      putThumbnail: async (record, generation) => {
        stored.push({ record, generation });
      }
    },
    encode: async (url) => {
      encodedUrls.push(url);
      return {
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "image/webp",
        width: 320,
        height: 180,
        sourceUrl: url
      };
    },
    wait: async (delayMs) => {
      waits.push(delayMs);
    }
  });

  assert.deepEqual(result, {
    saved: 1,
    skipped: 1,
    failed: 0,
    deferred: 0,
    retryAt: null
  });
  assert.deepEqual(encodedUrls, [newUrl]);
  assert.deepEqual(waits, []);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.generation, 4);
  assert.equal(stored[0]?.record.worldId, secondWorldId);
  assert.equal(stored[0]?.record.blob.type, "image/webp");
  assert.equal(stored[0]?.record.blob.size, 3);
});

test("thumbnail image failures are counted, paced, and do not block later worlds", async () => {
  const secondWorldId = "wrld_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const firstUrl = "https://api.vrchat.cloud/api/1/file/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/file";
  const secondUrl = "https://api.vrchat.cloud/api/1/file/file_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/1/file";
  /** @type {string[]} */
  const storedWorldIds = [];
  /** @type {number[]} */
  const waits = [];
  const result = await captureAvailableWorldThumbnails({
    userId: USER_ID,
    metadata: [
      { id: WORLD_ID, name: "A", authorName: "作者", favoriteGroup: "worlds1", releaseStatus: "public", thumbnailImageUrl: firstUrl },
      { id: secondWorldId, name: "B", authorName: "作者", favoriteGroup: "worlds2", releaseStatus: "public", thumbnailImageUrl: secondUrl }
    ],
    generation: 1,
    capturedAt: "2026-08-24T00:00:00.000Z",
    repository: {
      listThumbnailMetadata: async () => [],
      putThumbnail: async (record) => {
        storedWorldIds.push(record.worldId);
      }
    },
    encode: async (url) => {
      if (url === firstUrl) {
        throw new ThumbnailError(THUMBNAIL_ERROR_CODES.INVALID_MEDIA_TYPE);
      }
      return {
        bytes: new Uint8Array([4, 5]),
        contentType: "image/webp",
        width: 240,
        height: 135,
        sourceUrl: url
      };
    },
    wait: async (delayMs) => {
      waits.push(delayMs);
    }
  });

  assert.deepEqual(result, {
    saved: 1,
    skipped: 0,
    failed: 1,
    deferred: 0,
    retryAt: null
  });
  assert.deepEqual(storedWorldIds, [secondWorldId]);
  assert.deepEqual(waits, [THUMBNAIL_CAPTURE_INTERVAL_MS]);
});

test("thumbnail capture stops the batch after a systemic network failure", async () => {
  const metadata = Array.from({ length: 3 }, (_, index) => ({
    id: `wrld_00000000-0000-4000-8000-00000000000${index}`,
    name: `World ${index}`,
    authorName: "作者",
    favoriteGroup: "worlds1",
    releaseStatus: /** @type {const} */ ("public"),
    thumbnailImageUrl: `https://api.vrchat.cloud/api/1/image/file_00000000-0000-4000-8000-00000000000${index}/1/256`
  }));
  /** @type {string[]} */
  const encodedUrls = [];
  const result = await captureAvailableWorldThumbnails({
    userId: USER_ID,
    metadata,
    generation: 1,
    capturedAt: "2026-08-24T00:00:00.000Z",
    repository: {
      listThumbnailMetadata: async () => [],
      putThumbnail: async () => undefined
    },
    encode: async (url) => {
      encodedUrls.push(url);
      throw new ThumbnailFetchError(THUMBNAIL_ERROR_CODES.FETCH_FAILED);
    },
    wait: async () => undefined
  });

  assert.deepEqual(result, {
    saved: 0,
    skipped: 0,
    failed: 1,
    deferred: 2,
    retryAt: null
  });
  assert.deepEqual(encodedUrls, [metadata[0]?.thumbnailImageUrl]);
});

test("thumbnail capture stops on 429 and returns the validated retry deadline", async () => {
  const retryAt = NOW + 120_000;
  const metadata = Array.from({ length: 2 }, (_, index) => ({
    id: `wrld_10000000-0000-4000-8000-00000000000${index}`,
    name: `World ${index}`,
    authorName: "作者",
    favoriteGroup: "worlds1",
    releaseStatus: /** @type {const} */ ("public"),
    thumbnailImageUrl: `https://api.vrchat.cloud/api/1/image/file_10000000-0000-4000-8000-00000000000${index}/1/256`
  }));
  let encodeCount = 0;
  const result = await captureAvailableWorldThumbnails({
    userId: USER_ID,
    metadata,
    generation: 1,
    capturedAt: "2026-08-24T00:00:00.000Z",
    repository: {
      listThumbnailMetadata: async () => [],
      putThumbnail: async () => undefined
    },
    encode: async () => {
      encodeCount += 1;
      throw new ThumbnailFetchError(
        THUMBNAIL_ERROR_CODES.HTTP_STATUS,
        429,
        retryAt
      );
    },
    clock: () => NOW,
    wait: async () => undefined
  });

  assert.deepEqual(result, {
    saved: 0,
    skipped: 0,
    failed: 1,
    deferred: 1,
    retryAt
  });
  assert.equal(encodeCount, 1);

  const fallback = await captureAvailableWorldThumbnails({
    userId: USER_ID,
    metadata: metadata.slice(0, 1),
    generation: 1,
    capturedAt: "2026-08-24T00:00:00.000Z",
    repository: {
      listThumbnailMetadata: async () => [],
      putThumbnail: async () => undefined
    },
    encode: async () => {
      throw new ThumbnailFetchError(THUMBNAIL_ERROR_CODES.HTTP_STATUS, 429);
    },
    clock: () => NOW
  });
  assert.equal(fallback.retryAt, NOW + THUMBNAIL_RATE_LIMIT_FALLBACK_MS);
});

test("thumbnail capture defers remaining work at its time and attempt limits", async () => {
  const metadata = Array.from({ length: 5 }, (_, index) => ({
    id: `wrld_20000000-0000-4000-8000-00000000000${index}`,
    name: `World ${index}`,
    authorName: "作者",
    favoriteGroup: "worlds1",
    releaseStatus: /** @type {const} */ ("public"),
    thumbnailImageUrl: `https://api.vrchat.cloud/api/1/image/file_20000000-0000-4000-8000-00000000000${index}/1/256`
  }));
  let now = 0;
  let saved = 0;
  /** @type {number[]} */
  const encoderTimeouts = [];
  const result = await captureAvailableWorldThumbnails({
    userId: USER_ID,
    metadata,
    generation: 1,
    capturedAt: "2026-08-24T00:00:00.000Z",
    repository: {
      listThumbnailMetadata: async () => [],
      putThumbnail: async () => {
        saved += 1;
      }
    },
    encode: async (sourceUrl, options) => {
      encoderTimeouts.push(options.timeoutMs);
      assert.equal(options.signal.aborted, false);
      now += 11;
      return {
        bytes: new Uint8Array([1]),
        contentType: "image/webp",
        width: 1,
        height: 1,
        sourceUrl
      };
    },
    wait: async (delayMs) => {
      now += delayMs;
    },
    intervalMs: 10,
    timeBudgetMs: 25,
    maxAttempts: 4,
    clock: () => now
  });

  assert.deepEqual(result, {
    saved: 1,
    skipped: 0,
    failed: 0,
    deferred: 4,
    retryAt: null,
    timedOut: {worldId: "wrld_20000000-0000-4000-8000-000000000001", reason: "timeout_fetch"}
  });
  assert.equal(saved, 1);
  assert.deepEqual(encoderTimeouts, [25, 4]);

  now = 0;
  saved = 0;
  const attemptLimited = await captureAvailableWorldThumbnails({
    userId: USER_ID,
    metadata,
    generation: 1,
    capturedAt: "2026-08-24T00:00:00.000Z",
    repository: {
      listThumbnailMetadata: async () => [],
      putThumbnail: async () => {
        saved += 1;
      }
    },
    encode: async (sourceUrl) => ({
      bytes: new Uint8Array([1]),
      contentType: "image/webp",
      width: 1,
      height: 1,
      sourceUrl
    }),
    intervalMs: 0,
    maxAttempts: 2,
    clock: () => now
  });
  assert.equal(attemptLimited.saved, 2);
  assert.equal(attemptLimited.deferred, 3);
  assert.equal(saved, 2);
});

test("thumbnail capture aborts a stalled encoder at the overall deadline", async () => {
  /** @type {AbortSignal | null} */
  let encoderSignal = null;
  /** @type {number | null} */
  let encoderTimeout = null;
  const result = await captureAvailableWorldThumbnails({
    userId: USER_ID,
    metadata: [{
      id: WORLD_ID,
      name: "停止する画像",
      authorName: "作者",
      favoriteGroup: "worlds1",
      releaseStatus: "public",
      thumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256"
    }],
    generation: 1,
    capturedAt: "2026-08-24T00:00:00.000Z",
    repository: {
      listThumbnailMetadata: async () => [],
      putThumbnail: async () => undefined
    },
    encode: async (_sourceUrl, options) => {
      encoderSignal = options.signal;
      encoderTimeout = options.timeoutMs;
      return new Promise(() => {});
    },
    clock: () => 0,
    timeBudgetMs: 20
  });

  assert.deepEqual(result, {
    saved: 0,
    skipped: 0,
    failed: 0,
    deferred: 1,
    retryAt: null,
    timedOut: {worldId: WORLD_ID, reason: "timeout_fetch"}
  });
  assert.equal(encoderTimeout, 20);
  const capturedSignal = /** @type {AbortSignal | null} */ (
    /** @type {unknown} */ (encoderSignal)
  );
  assert.equal(capturedSignal?.aborted, true);
});

test("303 and 800 thumbnails complete across bounded capture batches", async (context) => {
  for (const worldCount of [303, 800]) {
    await context.test(`${worldCount} worlds`, async () => {
      const metadata = Array.from({ length: worldCount }, (_, index) => {
        const suffix = index.toString(16).padStart(12, "0");
        return {
          id: `wrld_30000000-0000-4000-8000-${suffix}`,
          name: `World ${index}`,
          authorName: "作者",
          favoriteGroup: "worlds1",
          releaseStatus: /** @type {const} */ ("public"),
          thumbnailImageUrl: `https://api.vrchat.cloud/api/1/image/file_30000000-0000-4000-8000-${suffix}/1/256`
        };
      });
      /** @type {Map<string, Awaited<ReturnType<DatabaseRepository["listThumbnailMetadata"]>>[number]>} */
      const stored = new Map();
      let captureCount = 0;

      while (stored.size < worldCount) {
        captureCount += 1;
        const result = await captureAvailableWorldThumbnails({
          userId: USER_ID,
          metadata,
          generation: 1,
          capturedAt: "2026-08-24T00:00:00.000Z",
          repository: {
            listThumbnailMetadata: async () => [...stored.values()],
            putThumbnail: async (record) => {
              stored.set(record.worldId, {
                userId: record.userId,
                worldId: record.worldId,
                width: record.width,
                height: record.height,
                byteLength: record.byteLength,
                capturedAt: record.capturedAt,
                sourceUrl: record.sourceUrl
              });
            }
          },
          encode: async (sourceUrl) => ({
            bytes: new Uint8Array([1]),
            contentType: "image/webp",
            width: 1,
            height: 1,
            sourceUrl
          }),
          intervalMs: 0,
          clock: () => NOW
        });
        assert.ok(result.saved <= 100);
        assert.equal(result.failed, 0);
        assert.equal(result.retryAt, null);
        assert.ok(captureCount <= Math.ceil(worldCount / 100));
      }

      assert.equal(stored.size, worldCount);
      assert.equal(captureCount, Math.ceil(worldCount / 100));
    });
  }
});

/** @typedef {import("../extension/lib/api.js").VrchatApi} VrchatApi */
/** @typedef {Pick<VrchatApi, "getCurrentUser" | "listAllFavoriteGroups" | "listAllFavoriteRelations" | "listAllFavoriteWorlds" | "getWorld">} ApiPort */

class FakeApi {
  /** @type {string[]} */
  calls = [];
  /** @type {"user" | "groups" | "relations" | "metadata" | "probe" | null} */
  failureStep = null;
  /** @type {unknown} */
  failure = new Error("fake API failure");
  worldName = "最初の名前";
  groupName = "worlds1";
  groupDisplayName = "いつもの場所";
  relationTags = ["worlds1"];
  metadataFavoriteGroup = "worlds1";
  /** @type {Record<string, unknown>} */
  currentUserExtra = {};
  /** @type {Awaited<ReturnType<VrchatApi["listAllFavoriteGroups"]>> | null} */
  favoriteGroupsOverride = null;
  /** @type {Awaited<ReturnType<VrchatApi["listAllFavoriteRelations"]>> | null} */
  favoriteRelationsOverride = null;
  /** @type {Awaited<ReturnType<VrchatApi["listAllFavoriteWorlds"]>> | null} */
  favoriteWorldsOverride = null;
  /** @type {200 | 404} */
  probeStatus = 200;
  /** @type {string | undefined} */
  probeThumbnailImageUrl;
  /** @type {(() => Promise<void>) | null} */
  beforeUser = null;

  /** @returns {ReturnType<VrchatApi["getCurrentUser"]>} */
  async getCurrentUser() {
    this.calls.push("user");
    if (this.beforeUser !== null) {
      await this.beforeUser();
    }
    this.#throwAt("user");
    return {
      ...this.currentUserExtra,
      id: USER_ID,
      displayName: "テストユーザー"
    };
  }

  /** @returns {ReturnType<VrchatApi["listAllFavoriteGroups"]>} */
  async listAllFavoriteGroups() {
    this.calls.push("groups");
    this.#throwAt("groups");
    if (this.favoriteGroupsOverride !== null) {
      return this.favoriteGroupsOverride.map((group) => ({ ...group }));
    }
    return [{
      id: "fvgrp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: this.groupName,
      displayName: this.groupDisplayName,
      ownerId: USER_ID,
      type: "world"
    }];
  }

  /** @returns {ReturnType<VrchatApi["listAllFavoriteRelations"]>} */
  async listAllFavoriteRelations() {
    this.calls.push("relations");
    this.#throwAt("relations");
    if (this.favoriteRelationsOverride !== null) {
      return this.favoriteRelationsOverride.map((relation) => ({
        ...relation,
        tags: [...relation.tags]
      }));
    }
    return [{ favoriteId: WORLD_ID, tags: [...this.relationTags], type: "world" }];
  }

  /** @returns {ReturnType<VrchatApi["listAllFavoriteWorlds"]>} */
  async listAllFavoriteWorlds() {
    this.calls.push("metadata");
    this.#throwAt("metadata");
    if (this.favoriteWorldsOverride !== null) {
      return this.favoriteWorldsOverride.map((world) => ({ ...world }));
    }
    return [{
      id: WORLD_ID,
      name: this.worldName,
      authorName: "作者",
      favoriteGroup: this.metadataFavoriteGroup,
      releaseStatus: "public"
    }];
  }

  /** @param {string} worldId @returns {ReturnType<VrchatApi["getWorld"]>} */
  async getWorld(worldId) {
    this.calls.push(`probe:${worldId}`);
    this.#throwAt("probe");
    if (this.probeStatus === 404) {
      return { status: 404, world: null };
    }
    return {
      status: 200,
      world: {
        id: worldId,
        name: this.worldName,
        authorName: "作者",
        releaseStatus: "public",
        ...(this.probeThumbnailImageUrl === undefined ? {} : {
          thumbnailImageUrl: this.probeThumbnailImageUrl
        })
      }
    };
  }

  /** @param {"user" | "groups" | "relations" | "metadata" | "probe"} step */
  #throwAt(step) {
    if (this.failureStep === step) {
      throw this.failure;
    }
  }
}

class FakeAlarms {
  /** @type {number | null} */
  thumbnailAt = null;
  failThumbnailCreate = false;
  /** @type {number | null} */
  scheduledAt = null;
  /** @type {{name: string, when: number}[]} */
  creates = [];
  createAttempts = 0;
  /** @type {number | null} */
  failCreateAttempt = null;
  failClear = false;
  clearCount = 0;

  /** @param {string} name */
  async get(name) {
    if (name === "thumbnail-next") return this.thumbnailAt === null ? undefined : {scheduledTime: this.thumbnailAt};
    assert.equal(name, SYNC_ALARM_NAME);
    return this.scheduledAt === null ? undefined : { scheduledTime: this.scheduledAt };
  }

  /** @param {string} name @param {number} when */
  async create(name, when) {
    if (name === "thumbnail-next") {
      if (this.failThumbnailCreate) throw new Error("synthetic image alarm failure");
      this.thumbnailAt = when; return;
    }
    this.createAttempts += 1;
    if (this.createAttempts === this.failCreateAttempt) {
      throw new Error("simulated alarm create failure");
    }
    this.scheduledAt = when;
    this.creates.push({ name, when });
  }

  /** @param {string} name */
  async clear(name) {
    if (name === "thumbnail-next") { this.thumbnailAt = null; return true; }
    assert.equal(name, SYNC_ALARM_NAME);
    if (this.failClear) {
      throw new Error("simulated alarm clear failure");
    }
    this.scheduledAt = null;
    this.clearCount += 1;
    return true;
  }
}

class FakeNotifications {
  /** @type {"granted" | "denied"} */
  permission = "granted";
  /** @type {{id: string, options: chrome.notifications.NotificationCreateOptions}[]} */
  created = [];
  /** @type {(() => Promise<void>) | null} */
  beforeCreate = null;

  async getPermissionLevel() {
    return this.permission;
  }

  /** @param {string} id @param {chrome.notifications.NotificationCreateOptions} options */
  async create(id, options) {
    if (this.beforeCreate !== null) {
      await this.beforeCreate();
    }
    this.created.push({ id, options });
    return id;
  }
}

let databaseSequence = 0;
let syncSequence = 0;

async function createRepository() {
  databaseSequence += 1;
  return new DatabaseRepository({
    factory: new IDBFactory(),
    name: `background-test-${databaseSequence}`
  }).open();
}

/**
 * @param {{
 *   repository: DatabaseRepository,
 *   api: FakeApi,
 *   alarms?: FakeAlarms,
 *   notifications?: FakeNotifications,
 *   now?: {value: number},
 *   withApiSession?: <T>(operation: () => Promise<T>) => Promise<T>,
 *   encodeThumbnail?: (sourceUrl: string, options: import("../extension/lib/sync-service.js").ThumbnailEncodeOptions) => Promise<{
 *     bytes: Uint8Array,
 *     contentType: "image/webp",
 *     width: number,
 *     height: number,
 *     sourceUrl: string
 *   }>,
 *   thumbnailWait?: (delayMs: number) => Promise<void>
 * }} input
 */
function createService(input) {
  const alarms = input.alarms ?? new FakeAlarms();
  const notifications = input.notifications ?? new FakeNotifications();
  const time = input.now ?? { value: NOW };
  const service = new SyncService({
    repository: input.repository,
    api: /** @type {ApiPort} */ (input.api),
    alarms,
    notifications,
    clock: () => time.value,
    random: () => 0,
    idGenerator: () => `test-${++syncSequence}`,
    ...(input.withApiSession === undefined
      ? {}
      : { withApiSession: input.withApiSession }),
    ...(input.encodeThumbnail === undefined
      ? {}
      : { encodeThumbnail: input.encodeThumbnail }),
    ...(input.thumbnailWait === undefined
      ? {}
      : { thumbnailWait: input.thumbnailWait })
  });
  return { service, alarms, notifications, time };
}

test("successful sync stores local thumbnails and later image failures retain them", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const firstUrl = "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256";
  const changedUrl = "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/2/256";
  api.favoriteWorldsOverride = [{
    id: WORLD_ID,
    name: "画像を残すワールド",
    authorName: "作者",
    favoriteGroup: "worlds1",
    releaseStatus: "public",
    thumbnailImageUrl: firstUrl
  }];
  /** @type {string[]} */
  const encodedUrls = [];
  /** @type {string[]} */
  const phases = [];
  let failEncoding = false;
  const { service } = createService({
    repository,
    api,
    withApiSession: async (operation) => {
      phases.push("session-start");
      const result = await operation();
      phases.push("session-cleaned");
      return result;
    },
    encodeThumbnail: async (sourceUrl) => {
      assert.equal(phases.at(-1), "session-cleaned");
      encodedUrls.push(sourceUrl);
      if (failEncoding) {
        throw new ThumbnailError("FETCH_FAILED");
      }
      return {
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "image/webp",
        width: 320,
        height: 180,
        sourceUrl
      };
    },
    thumbnailWait: async () => undefined
  });

  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });
  const stored = await repository.getThumbnail(USER_ID, WORLD_ID);
  assert.equal(stored?.sourceUrl, firstUrl);
  assert.equal(stored?.blob.type, "image/webp");
  assert.deepEqual(encodedUrls, [firstUrl]);
  assert.deepEqual(phases, ["session-start", "session-cleaned"]);
  assert.deepEqual(await repository.getSetting(SETTING_KEYS.thumbnailCaptureStatus), {
    userId: USER_ID,
    capturedAt: new Date(NOW).toISOString(),
    saved: 1,
    skipped: 0,
    failed: 0,
    deferred: 0,
    retryAt: null
  });

  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });
  assert.deepEqual(encodedUrls, [firstUrl]);

  const currentMetadata = api.favoriteWorldsOverride[0];
  assert.ok(currentMetadata !== undefined);
  api.favoriteWorldsOverride[0] = {
    ...currentMetadata,
    thumbnailImageUrl: changedUrl
  };
  failEncoding = true;
  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });
  assert.deepEqual(encodedUrls, [firstUrl, changedUrl]);
  assert.equal((await repository.getThumbnail(USER_ID, WORLD_ID))?.sourceUrl, firstUrl);
  assert.deepEqual(await repository.getSetting(SETTING_KEYS.thumbnailCaptureStatus), {
    userId: USER_ID,
    capturedAt: new Date(NOW).toISOString(),
    saved: 0,
    skipped: 0,
    failed: 1,
    deferred: 0,
    retryAt: null
  });
});

test("old accessible worlds outside favorites acquire images through spare probes", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const { service } = createService({ repository, api });
  await service.start("alarm");
  api.favoriteRelationsOverride = [];
  api.favoriteWorldsOverride = [];
  await service.start("alarm");
  await service.start("alarm");
  assert.equal((await repository.listWorlds(USER_ID))[0]?.membershipState, "not_in_favorites");
  api.probeThumbnailImageUrl = "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256";
  const imageService = createService({
    repository,
    api,
    encodeThumbnail: async (sourceUrl) => ({
      bytes: new Uint8Array([1, 2, 3]), contentType: "image/webp",
      width: 1, height: 1, sourceUrl
    })
  }).service;
  assert.deepEqual(await imageService.start("alarm"), { ok: true, changes: 0 });
  assert.equal((await repository.getThumbnail(USER_ID, WORLD_ID))?.sourceUrl, api.probeThumbnailImageUrl);
  const probeCount = api.calls.filter((call) => call.startsWith("probe:")).length;
  await imageService.start("alarm");
  assert.equal(api.calls.filter((call) => call.startsWith("probe:")).length, probeCount);
});

test("thumbnail progress resumes past permanent failures across service restarts", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  api.favoriteWorldsOverride = Array.from({ length: 101 }, (_, index) => ({
    id: `wrld_aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    name: "画像取得の継続テスト", authorName: "作者", favoriteGroup: "worlds1",
    releaseStatus: /** @type {const} */ ("public"),
    thumbnailImageUrl: `https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}/1/256`
  }));
  api.favoriteRelationsOverride = api.favoriteWorldsOverride.map((world) => ({
    favoriteId: world.id, tags: ["worlds1"], type: "world"
  }));
  const lastWorld = api.favoriteWorldsOverride.at(-1);
  assert.ok(lastWorld !== undefined);
  /** @type {string[]} */
  const attempts = [];
  /** @param {string} sourceUrl */
  const encodeThumbnail = async (sourceUrl) => {
    attempts.push(sourceUrl);
    if (sourceUrl !== lastWorld.thumbnailImageUrl) {
      throw new ThumbnailFetchError(THUMBNAIL_ERROR_CODES.HTTP_STATUS, 404);
    }
    return {
      bytes: new Uint8Array([1, 2, 3]), contentType: /** @type {const} */ ("image/webp"),
      width: 1, height: 1, sourceUrl
    };
  };
  const dependencies = { repository, api, encodeThumbnail, thumbnailWait: async () => undefined };
  assert.deepEqual(await createService(dependencies).service.start("alarm"), { ok: true, changes: 0 });
  assert.equal(attempts.length, 100);
  assert.equal(await repository.getThumbnail(USER_ID, lastWorld.id), null);
  assert.deepEqual(await createService(dependencies).service.start("alarm"), { ok: true, changes: 0 });
  assert.equal(attempts[100], lastWorld.thumbnailImageUrl);
  assert.equal((await repository.getThumbnail(USER_ID, lastWorld.id))?.sourceUrl, lastWorld.thumbnailImageUrl);
});

test("thumbnail store errors are reported without rolling back world history", async () => {
  const repository = await createRepository();
  const { service } = createService({ repository, api: new FakeApi() });
  repository.listThumbnailMetadata = async () => { throw new Error("synthetic image store error"); };
  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });
  assert.equal((await repository.listWorlds(USER_ID)).length, 1);
  const status = await repository.getSetting(SETTING_KEYS.thumbnailCaptureStatus);
  assert.ok(typeof status === "object" && status !== null && "failed" in status);
  assert.equal(status.failed, 1);
});

test("thumbnail 429 persists Retry-After and prevents more VRChat requests until it expires", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const sourceUrl = "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256";
  api.favoriteWorldsOverride = [{
    id: WORLD_ID,
    name: "画像待機中でも同期するワールド",
    authorName: "作者",
    favoriteGroup: "worlds1",
    releaseStatus: "public",
    thumbnailImageUrl: sourceUrl
  }];
  const now = { value: NOW };
  const retryAt = NOW + 120_000;
  let encodeCount = 0;
  let rateLimited = true;
  const { service } = createService({
    repository,
    api,
    now,
    encodeThumbnail: async (url) => {
      encodeCount += 1;
      if (rateLimited) {
        throw new ThumbnailFetchError(
          THUMBNAIL_ERROR_CODES.HTTP_STATUS,
          429,
          retryAt
        );
      }
      return {
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "image/webp",
        width: 320,
        height: 180,
        sourceUrl: url
      };
    },
    thumbnailWait: async () => undefined
  });

  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });
  assert.equal(encodeCount, 1);
  assert.equal(
    await repository.getSetting(SETTING_KEYS.thumbnailBackoffUntil),
    retryAt
  );
  assert.equal(await repository.getSetting(SETTING_KEYS.backoffUntil), retryAt);

  const apiCallCount = api.calls.length;
  assert.deepEqual(await service.start("alarm"), {
    ok: false,
    error: "RATE_LIMITED",
    retryAt: new Date(retryAt).toISOString()
  });
  assert.equal(encodeCount, 1);
  assert.equal(api.calls.length, apiCallCount);

  rateLimited = false;
  now.value = retryAt + 1;
  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });
  assert.equal(encodeCount, 2);
  assert.equal(
    await repository.getSetting(SETTING_KEYS.thumbnailBackoffUntil),
    null
  );
  assert.equal((await repository.getThumbnail(USER_ID, WORLD_ID))?.sourceUrl, sourceUrl);
});

test("successful snapshots commit with revisions and claim before one notification attempt", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const { service, alarms, notifications } = createService({ repository, api });

  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });
  const baseline = await repository.listWorlds(USER_ID);
  assert.equal(baseline.length, 1);
  assert.equal(baseline[0]?.currentName, "最初の名前");
  assert.equal(baseline[0]?.revision, 0);
  assert.equal(notifications.created.length, 0);
  assert.equal(alarms.creates[0]?.when, NOW + SYNC_WATCHDOG_DELAY_MS);
  assert.equal(alarms.scheduledAt, NOW + REGULAR_INTERVAL_MS);
  assert.equal(await repository.getSetting(SETTING_KEYS.watchdogUntil), null);

  api.worldName = "変更後の名前";
  notifications.beforeCreate = async () => {
    const eventsBeforeAttempt = await repository.listEvents(USER_ID);
    assert.equal(eventsBeforeAttempt.length, 1);
    assert.notEqual(eventsBeforeAttempt[0]?.notificationClaimedAt, null);
    assert.equal(eventsBeforeAttempt[0]?.notifiedAt, null);
  };

  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 1 });
  const changed = await repository.listWorlds(USER_ID);
  const events = await repository.listEvents(USER_ID);
  assert.equal(changed[0]?.currentName, "変更後の名前");
  assert.equal(changed[0]?.revision, 1);
  assert.equal(events[0]?.kind, "name_changed");
  assert.notEqual(events[0]?.notificationClaimedAt, null);
  assert.notEqual(events[0]?.notifiedAt, null);
  assert.equal(notifications.created.length, 1);
  assert.equal(await repository.getSetting(SETTING_KEYS.activeProfileId), USER_ID);
  assert.equal(await repository.getSetting(SETTING_KEYS.lastSyncResult), "success");
  assert.equal(await repository.getSetting(SETTING_KEYS.favoriteGroupStatus), "success");
  assert.equal((await repository.listFavoriteGroups(USER_ID))[0]?.displayName, "いつもの場所");
  assert.equal(await repository.getUnreadCount(USER_ID), 1);
});

test("confirmed disappearance is the notification headline and counts one world once", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const notifications = new FakeNotifications();
  const { service } = createService({ repository, api, notifications });

  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });
  api.favoriteRelationsOverride = [];
  api.favoriteWorldsOverride = [];
  api.probeStatus = 404;

  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });
  assert.equal(notifications.created.length, 0);
  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 2 });

  assert.equal(notifications.created.length, 1);
  const notification = notifications.created[0];
  assert.ok(notification?.id.startsWith(ATTENTION_NOTIFICATION_ID_PREFIX));
  assert.equal(notification?.options.title, "現在アクセスできないワールドがあります");
  assert.equal(
    notification?.options.message,
    "要確認: 1件（現在アクセス不可1件・お気に入り一覧にない1件）。"
  );
  assert.equal(notification?.options.buttons?.[0]?.title, "保存済みの情報を見る");

  const status = await service.getStatus();
  assert.equal(status.attentionWorldCount, 1);
  assert.equal(status.missingCount, 1);
  assert.equal(status.unavailableCount, 1);
});

test("sync never persists extra CurrentUser fields", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const secret = "current-user-secret-sentinel";
  api.currentUserExtra = {
    authToken: secret,
    usesGeneratedPassword: true,
    nested: { sessionToken: secret }
  };
  const { service } = createService({ repository, api });

  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });

  const profile = await repository.getProfile(USER_ID);
  assert.ok(profile);
  assert.deepEqual(Object.keys(profile).sort(), [
    "createdBySchemaVersion",
    "displayName",
    "firstSeenAt",
    "lastSuccessfulSyncAt",
    "userId"
  ]);
  assert.equal(JSON.stringify(await repository.getBackupSnapshot(USER_ID)).includes(secret), false);
});

test("favorite-list moves stay unread history but never enter the OS notification outbox", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const notifications = new FakeNotifications();
  const { service } = createService({ repository, api, notifications });
  await service.start("alarm");

  api.relationTags = ["worlds2"];
  api.metadataFavoriteGroup = "worlds2";
  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 1 });
  let events = await repository.listEvents(USER_ID);
  assert.equal(events[0]?.kind, "favorite_group_changed");
  assert.equal(events[0]?.notificationEligible, false);
  assert.equal(events[0]?.notificationClaimedAt, null);
  assert.equal((await service.getStatus()).unreadCount, 1);
  assert.equal(notifications.created.length, 0);

  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });
  events = await repository.listEvents(USER_ID);
  assert.equal(events[0]?.notificationClaimedAt, null);
  assert.equal(notifications.created.length, 0);

  api.worldName = "通知対象の名称変更";
  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 1 });
  events = await repository.listEvents(USER_ID);
  const groupEvent = events.find((event) => event.kind === "favorite_group_changed");
  const nameEvent = events.find((event) => event.kind === "name_changed");
  assert.equal(groupEvent?.notificationClaimedAt, null);
  assert.equal(groupEvent?.notificationEligible, false);
  assert.notEqual(nameEvent?.notificationClaimedAt, null);
  assert.equal(nameEvent?.notificationEligible, true);
  assert.equal(notifications.created.length, 1);
  assert.equal(notifications.created[0]?.options.message, "1件の変化を記録しました。履歴を確認してください。");
});

test("notification outbox allowlist exactly matches confirmed FR-NOTIFY-01 events", () => {
  assert.deepEqual(NOTIFICATION_EVENT_KINDS, [
    "name_changed",
    "favorite_missing_confirmed",
    "favorite_restored",
    "access_unavailable_confirmed",
    "access_restored"
  ]);
  assert.equal(NOTIFICATION_EVENT_KINDS.includes("favorite_group_changed"), false);
});

test("favorite-group schema failure preserves prior labels without blocking core world sync", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const { service } = createService({ repository, api });
  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });
  const groupsBefore = await repository.listFavoriteGroups(USER_ID);

  api.failureStep = "groups";
  api.failure = new ApiSchemaError();
  api.worldName = "グループAPI不調中の変更";
  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 1 });

  assert.deepEqual(await repository.listFavoriteGroups(USER_ID), groupsBefore);
  assert.equal((await repository.listWorlds(USER_ID))[0]?.currentName, "グループAPI不調中の変更");
  assert.equal(await repository.getSetting(SETTING_KEYS.favoriteGroupStatus), "stale");
});

test("favorite-group identity drift is isolated as stale while world changes still commit", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const { service } = createService({ repository, api });
  await service.start("alarm");
  const groupsBefore = await repository.listFavoriteGroups(USER_ID);

  api.groupName = "worlds8";
  api.worldName = "識別子変化中のワールド名";
  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 1 });
  assert.deepEqual(await repository.listFavoriteGroups(USER_ID), groupsBefore);
  assert.equal((await repository.listWorlds(USER_ID))[0]?.currentName, "識別子変化中のワールド名");
  assert.equal(await repository.getSetting(SETTING_KEYS.favoriteGroupStatus), "stale");
});

test("favorite-group ID replacement is isolated as stale while world changes still commit", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const { service } = createService({ repository, api });
  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });
  const groupsBefore = await repository.listFavoriteGroups(USER_ID);

  api.favoriteGroupsOverride = [{
    id: "fvgrp_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "worlds1",
    displayName: "置き換わったID",
    ownerId: USER_ID,
    type: "world"
  }];
  api.worldName = "グループID置換中のワールド名";

  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 1 });
  assert.deepEqual(await repository.listFavoriteGroups(USER_ID), groupsBefore);
  assert.equal(
    (await repository.listWorlds(USER_ID))[0]?.currentName,
    "グループID置換中のワールド名"
  );
  assert.equal(await repository.getSetting(SETTING_KEYS.favoriteGroupStatus), "stale");
});

test("an unreferenced favorite group needs two missing snapshots before deactivation", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const firstGroup = {
    id: "fvgrp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "worlds1",
    displayName: "いつもの場所",
    ownerId: USER_ID,
    type: /** @type {const} */ ("world")
  };
  const secondGroup = {
    id: "fvgrp_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "worlds2",
    displayName: "あとで行く場所",
    ownerId: USER_ID,
    type: /** @type {const} */ ("world")
  };
  api.favoriteGroupsOverride = [firstGroup, secondGroup];
  const { service } = createService({ repository, api });
  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });
  const groupsBefore = await repository.listFavoriteGroups(USER_ID);
  assert.equal(groupsBefore.length, 2);

  api.favoriteGroupsOverride = [firstGroup];
  api.worldName = "部分応答中の名前変更";
  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 1 });
  const missingOnce = await repository.listFavoriteGroups(USER_ID);
  assert.equal(missingOnce[1]?.displayName, groupsBefore[1]?.displayName);
  assert.equal(missingOnce[1]?.active, true);
  assert.equal(missingOnce[1]?.missingCount, 1);
  assert.equal(await repository.getSetting(SETTING_KEYS.favoriteGroupStatus), "stale");
  assert.equal(
    (await repository.listWorlds(USER_ID))[0]?.currentName,
    "部分応答中の名前変更"
  );

  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });
  const missingTwice = await repository.listFavoriteGroups(USER_ID);
  assert.equal(missingTwice[1]?.displayName, groupsBefore[1]?.displayName);
  assert.equal(missingTwice[1]?.active, false);
  assert.equal(missingTwice[1]?.missingCount, 2);
  assert.equal(await repository.getSetting(SETTING_KEYS.favoriteGroupStatus), "success");
});

test("favorite-group display-name changes update group history without a world event", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const { service } = createService({ repository, api });
  await service.start("alarm");

  api.groupDisplayName = "名前を変えたリスト";
  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });
  const group = (await repository.listFavoriteGroups(USER_ID))[0];
  assert.equal(group?.displayName, "名前を変えたリスト");
  assert.deepEqual(group?.displayNameHistory, [{
    displayName: "いつもの場所",
    observedAt: new Date(NOW).toISOString()
  }]);
  assert.deepEqual(await repository.listEvents(USER_ID), []);
});

test("favorite-group network failure aborts the complete sync and preserves state", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const { service } = createService({ repository, api });
  await service.start("alarm");
  const worldsBefore = await repository.listWorlds(USER_ID);
  const groupsBefore = await repository.listFavoriteGroups(USER_ID);

  api.failureStep = "groups";
  api.failure = new NetworkError();
  api.worldName = "保存してはいけない名前";
  assert.deepEqual(await service.start("alarm"), { ok: false, error: "OFFLINE" });
  assert.deepEqual(await repository.listWorlds(USER_ID), worldsBefore);
  assert.deepEqual(await repository.listFavoriteGroups(USER_ID), groupsBefore);
});

test("status exposes pending probes and durable unread history, then marks it read", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const { service } = createService({ repository, api });
  await service.start("alarm");
  api.worldName = "未読になる変更";
  await service.start("alarm");

  const status = await service.getStatus();
  assert.equal(status.unreadCount, 1);
  assert.equal(status.pendingProbeCount, 0);
  assert.equal(status.attentionWorldCount, 0);
  assert.equal(status.missingCount, 0);
  assert.equal(status.unavailableCount, 0);
  assert.equal(status.favoriteGroupStatus, "success");
  assert.equal(await service.markHistoryRead(), true);
  assert.equal((await service.getStatus()).unreadCount, 0);
});

test("a final alarm-create failure cannot turn a committed success into failure", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const alarms = new FakeAlarms();
  alarms.failCreateAttempt = 2;
  const { service } = createService({ repository, api, alarms });

  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });
  assert.equal((await repository.listWorlds(USER_ID)).length, 1);
  assert.equal(await repository.getSetting(SETTING_KEYS.lastSyncResult), "success");
  assert.equal(await repository.getSetting(SETTING_KEYS.lastAlarmError), "unavailable");
  assert.equal(alarms.scheduledAt, NOW + SYNC_WATCHDOG_DELAY_MS);
});

test("a post-alarm schedule-setting failure preserves success and a fixed diagnostic", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  let scheduleWrites = 0;
  /** @param {Readonly<Record<string, unknown>>} updates */
  const failFinalScheduleWrite = async (updates) => {
    if (Object.hasOwn(updates, SETTING_KEYS.nextSyncAt)) {
      scheduleWrites += 1;
      if (scheduleWrites === 2) {
        throw new Error("simulated schedule settings failure");
      }
    }
    await repository.setSettings(updates);
  };
  const failingRepository = bindRepositoryWithOverrides(repository, {
    setSettings: failFinalScheduleWrite
  });
  const { service, alarms } = createService({ repository: failingRepository, api });

  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });
  assert.equal((await repository.listWorlds(USER_ID)).length, 1);
  assert.equal(await repository.getSetting(SETTING_KEYS.lastSyncResult), "success");
  assert.equal(await repository.getSetting(SETTING_KEYS.lastAlarmError), "unavailable");
  assert.equal(alarms.scheduledAt, NOW + REGULAR_INTERVAL_MS);
  assert.equal(
    await repository.getSetting(SETTING_KEYS.nextSyncAt),
    NOW + SYNC_WATCHDOG_DELAY_MS
  );
});

test("network failure records only the run and leaves world/event state unchanged", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const { service, alarms } = createService({ repository, api });
  await service.start("alarm");
  const worldsBefore = await repository.listWorlds(USER_ID);
  const eventsBefore = await repository.listEvents(USER_ID);

  api.failureStep = "relations";
  api.failure = new NetworkError();
  assert.deepEqual(await service.start("alarm"), { ok: false, error: "OFFLINE" });

  assert.deepEqual(await repository.listWorlds(USER_ID), worldsBefore);
  assert.deepEqual(await repository.listEvents(USER_ID), eventsBefore);
  assert.equal(await repository.getSetting(SETTING_KEYS.lastSyncResult), "offline");
  assert.equal(alarms.scheduledAt, NOW + RECOVERY_MIN_DELAY_MS);
  assert.equal(api.calls.at(-1), "relations");
});

test("the API session boundary wraps the complete sync and records bridge failures", async (context) => {
  await context.test("successful bridge", async () => {
    const repository = await createRepository();
    const api = new FakeApi();
    /** @type {string[]} */
    const order = [];
    const { service } = createService({
      repository,
      api,
      withApiSession: async (operation) => {
        order.push("bridge-start");
        const result = await operation();
        order.push("bridge-finish");
        return result;
      }
    });

    assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });
    assert.deepEqual(order, ["bridge-start", "bridge-finish"]);
    assert.deepEqual(api.calls, ["user", "groups", "relations", "metadata"]);
  });

  const cases = [
    [new AuthCookieRequiredError(), "AUTH_REQUIRED", "auth_required"],
    [new AuthCookieConflictError(), "AUTH_COOKIE_CONFLICT", "failed"],
    [new AuthCookiePartitionedError(), "AUTH_COOKIE_UNAVAILABLE", "failed"],
    [new AuthCookieSetupError(), "AUTH_COOKIE_UNAVAILABLE", "failed"]
  ];
  for (const [failure, publicCode, runResult] of cases) {
    await context.test(String(publicCode), async () => {
      const repository = await createRepository();
      const api = new FakeApi();
      const { service } = createService({
        repository,
        api,
        withApiSession: async () => {
          throw failure;
        }
      });

      assert.deepEqual(await service.start("alarm"), {
        ok: false,
        error: publicCode
      });
      assert.deepEqual(api.calls, []);
      assert.equal(await repository.getSetting(SETTING_KEYS.lastSyncResult), runResult);
      assert.deepEqual(await repository.listWorlds(USER_ID), []);
    });
  }
});

test("a cleanup failure after commit reports recovery without discarding history", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const { service, alarms } = createService({
    repository,
    api,
    withApiSession: async (operation) => {
      await operation();
      throw new AuthCookieCleanupError();
    }
  });

  assert.deepEqual(await service.start("alarm"), {
    ok: false,
    error: "AUTH_COOKIE_CLEANUP_FAILED"
  });
  assert.equal((await repository.listWorlds(USER_ID)).length, 1);
  assert.equal(await repository.getSetting(SETTING_KEYS.lastSyncResult), "success");
  assert.equal(alarms.scheduledAt, NOW + REGULAR_INTERVAL_MS);
});

test("a Cookie preflight failure does not impose manual cooldown after login is repaired", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  let sourceReady = false;
  const { service } = createService({
    repository,
    api,
    withApiSession: async (operation) => {
      if (!sourceReady) {
        throw new AuthCookieRequiredError();
      }
      return operation();
    }
  });

  assert.deepEqual(await service.start("manual"), {
    ok: false,
    error: "AUTH_REQUIRED"
  });
  assert.equal(await repository.getSetting(SETTING_KEYS.lastManualSyncAt), null);

  sourceReady = true;
  assert.deepEqual(await service.start("manual"), { ok: true, changes: 0 });
  assert.deepEqual(api.calls, ["user", "groups", "relations", "metadata"]);
});

test("schedule failure after an API failure preserves the safe fixed API result", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  api.failureStep = "user";
  api.failure = new NetworkError();
  const alarms = new FakeAlarms();
  alarms.failCreateAttempt = 2;
  const { service } = createService({ repository, api, alarms });

  assert.deepEqual(await service.start("alarm"), { ok: false, error: "OFFLINE" });
  assert.equal(await repository.getSetting(SETTING_KEYS.lastSyncResult), "offline");
  assert.equal(await repository.getSetting(SETTING_KEYS.lastAlarmError), "unavailable");
  assert.deepEqual(await repository.listWorlds(USER_ID), []);
});

test("queued sync honors a probe's existing backoff without counting a second 429", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const { service, alarms } = createService({repository, api, withApiSession: async () => {
    // Simulate a probe observing 429 while this sync waits for its session.
    await repository.setSettings({[SETTING_KEYS.backoffUntil]: NOW + 30_000, [SETTING_KEYS.consecutiveRateLimits]: 1});
    throw new ActiveRateLimitError(NOW + 30_000, NOW);
  }});
  assert.deepEqual(await service.start("alarm"), {ok: false, error: "RATE_LIMITED", retryAt: new Date(NOW + 30_000).toISOString()});
  assert.equal(await repository.getSetting(SETTING_KEYS.consecutiveRateLimits), 1);
  assert.equal(await repository.getSetting(SETTING_KEYS.backoffUntil), NOW + 30_000);
  assert.equal(alarms.scheduledAt, NOW + 30_000);
  assert.equal(api.calls.length, 0);
});

test("429 persists saturated state and blocks every API call until backoff", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const { service, alarms } = createService({ repository, api });
  api.failureStep = "user";
  api.failure = new RateLimitedError(NOW + 120_000, NOW);
  await repository.setSetting(SETTING_KEYS.consecutiveRateLimits, 2);

  const first = await service.start("alarm");
  assert.deepEqual(first, {
    ok: false,
    error: "RATE_LIMITED",
    retryAt: new Date(NOW + 120_000).toISOString()
  });
  assert.equal(await repository.getSetting(SETTING_KEYS.consecutiveRateLimits), 3);
  assert.equal(await repository.getSetting(SETTING_KEYS.backoffUntil), NOW + 120_000);
  assert.equal(alarms.scheduledAt, NOW + 120_000);
  assert.equal(api.calls.length, 1);

  const blocked = await service.start("manual");
  assert.deepEqual(blocked, first);
  assert.equal(api.calls.length, 1);
  assert.equal(await repository.getSetting(SETTING_KEYS.consecutiveRateLimits), 3);
});

test("one generation conflict replans without repeating any API request", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  let commitAttempts = 0;
  /** @param {Parameters<DatabaseRepository["commitSync"]>[0]} commit */
  const commitWithOneConflict = async (commit) => {
    commitAttempts += 1;
    if (commitAttempts === 1) {
      await repository.saveProfile({ ...commit.profile, displayName: "復元された表示名" });
    }
    return repository.commitSync(commit);
  };
  const conflictingRepository = bindRepositoryWithOverrides(repository, {
    commitSync: commitWithOneConflict
  });
  const { service } = createService({ repository: conflictingRepository, api });

  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 0 });
  assert.equal(commitAttempts, 2);
  assert.deepEqual(api.calls, ["user", "groups", "relations", "metadata"]);
  assert.equal((await repository.listWorlds(USER_ID)).length, 1);
});

test("a second generation conflict stops unchanged and schedules a short resume", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  let commitAttempts = 0;
  /** @param {Parameters<DatabaseRepository["commitSync"]>[0]} commit */
  const alwaysConflict = async (commit) => {
    commitAttempts += 1;
    await repository.saveProfile({
      ...commit.profile,
      displayName: `外部変更${commitAttempts}`
    });
    return repository.commitSync(commit);
  };
  const conflictingRepository = bindRepositoryWithOverrides(repository, {
    commitSync: alwaysConflict
  });
  const { service, alarms } = createService({ repository: conflictingRepository, api });

  assert.deepEqual(await service.start("alarm"), {
    ok: false,
    error: "SYNC_CONFLICT"
  });
  assert.equal(commitAttempts, 2);
  assert.deepEqual(api.calls, ["user", "groups", "relations", "metadata"]);
  assert.deepEqual(await repository.listWorlds(USER_ID), []);
  assert.equal(alarms.scheduledAt, NOW + RECOVERY_MIN_DELAY_MS);
  assert.equal(
    await repository.getSetting(SETTING_KEYS.watchdogUntil),
    NOW + RECOVERY_MIN_DELAY_MS
  );
  assert.equal(
    await service.resolveAlarmTrigger(NOW + RECOVERY_MIN_DELAY_MS),
    "resume"
  );
});

test("post-commit notification storage failure never rewrites a successful sync as failed", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const initial = createService({ repository, api });
  await initial.service.start("alarm");

  api.worldName = "通知前に変更";
  const claimFailureRepository = bindRepositoryWithOverrides(repository, {
    claimEvents: async () => {
      throw new Error("simulated claim storage failure");
    }
  });
  const interrupted = createService({ repository: claimFailureRepository, api });
  assert.deepEqual(await interrupted.service.start("alarm"), { ok: true, changes: 1 });
  const pendingEvent = (await repository.listEvents(USER_ID))[0];
  assert.equal(pendingEvent?.kind, "name_changed");
  assert.equal(pendingEvent?.notificationClaimedAt, null);
  assert.equal(await repository.getSetting(SETTING_KEYS.lastSyncResult), "success");

  const recoveredNotifications = new FakeNotifications();
  const recovered = createService({
    repository,
    api,
    notifications: recoveredNotifications
  });
  assert.deepEqual(await recovered.service.start("alarm"), { ok: true, changes: 0 });
  assert.equal(recoveredNotifications.created.length, 1);
  assert.notEqual(
    (await repository.listEvents(USER_ID))[0]?.notificationClaimedAt,
    null
  );
});

test("a generation change immediately before notification create suppresses the attempt", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  await createService({ repository, api }).service.start("alarm");
  api.worldName = "世代確認後の名前";

  let generationChecks = 0;
  const changingRepository = bindRepositoryWithOverrides(repository, {
    getDataGeneration: async (userId) => {
      generationChecks += 1;
      const profile = await repository.getProfile(userId);
      assert.ok(profile);
      await repository.saveProfile({ ...profile, displayName: "復元処理と競合" });
      return repository.getDataGeneration(userId);
    }
  });
  const notifications = new FakeNotifications();
  const service = createService({
    repository: changingRepository,
    api,
    notifications
  }).service;

  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 1 });
  assert.equal(generationChecks, 1);
  assert.equal(notifications.created.length, 0);
  const event = (await repository.listEvents(USER_ID))[0];
  assert.notEqual(event?.notificationClaimedAt, null);
  assert.equal(event?.notifiedAt, null);
});

test("manual cooldown and single-flight prevent duplicate API sequences", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const { service } = createService({ repository, api });

  await service.start("manual");
  const callCount = api.calls.length;
  assert.deepEqual(await service.start("manual"), {
    ok: false,
    error: "MANUAL_COOLDOWN",
    retryAt: new Date(NOW + MANUAL_SYNC_COOLDOWN_MS).toISOString()
  });
  assert.equal(api.calls.length, callCount);
});

test("an active sync rearms a consumed watchdog before sharing its flight", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const time = { value: NOW };
  const { service, alarms } = createService({ repository, api, now: time });
  /** @type {() => void} */
  let signalEntered = () => {};
  /** @type {() => void} */
  let releaseUser = () => {};
  /** @type {Promise<void>} */
  const entered = new Promise((resolve) => {
    signalEntered = resolve;
  });
  /** @type {Promise<void>} */
  const release = new Promise((resolve) => {
    releaseUser = resolve;
  });
  api.beforeUser = async () => {
    signalEntered();
    await release;
  };

  const running = service.start("alarm");
  await entered;
  const firstWatchdog = NOW + SYNC_WATCHDOG_DELAY_MS;
  assert.equal(alarms.scheduledAt, firstWatchdog);
  assert.equal(await service.resolveAlarmTrigger(firstWatchdog), "resume");

  time.value = firstWatchdog;
  assert.equal(await service.rearmWatchdogForActiveSync(), true);
  assert.equal(alarms.scheduledAt, firstWatchdog + SYNC_WATCHDOG_DELAY_MS);
  releaseUser();
  assert.deepEqual(await running, { ok: true, changes: 0 });
  assert.equal(alarms.scheduledAt, firstWatchdog + REGULAR_INTERVAL_MS);
});

test("disabled automatic sync clears residual state before DNR/API while manual remains allowed", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const alarms = new FakeAlarms();
  alarms.scheduledAt = NOW + 10_000;
  await repository.setSettings({
    [SETTING_KEYS.autoSyncEnabled]: false,
    [SETTING_KEYS.nextSyncAt]: NOW + 10_000,
    [SETTING_KEYS.watchdogUntil]: NOW + 10_000
  });
  const { service } = createService({ repository, api, alarms });
  let ruleChecks = 0;
  const runner = createGatedSyncRunner({
    ensureUserAgentRule: async () => {
      ruleChecks += 1;
    },
    startSync: (trigger) => service.start(trigger),
    keepAlive: async (operation) => operation
  });
  const handler = createAlarmEventHandler({
    getService: async () => service,
    getRunner: async () => runner
  });

  await handler({ name: SYNC_ALARM_NAME, scheduledTime: NOW + 10_000 });
  assert.equal(ruleChecks, 0);
  assert.equal(api.calls.length, 0);
  assert.equal(alarms.scheduledAt, null);
  assert.equal(await repository.getSetting(SETTING_KEYS.nextSyncAt), null);
  assert.equal(await repository.getSetting(SETTING_KEYS.watchdogUntil), null);

  assert.deepEqual(await runner("manual"), { ok: true, changes: 0 });
  assert.equal(ruleChecks, 1);
  assert.deepEqual(api.calls, ["user", "groups", "relations", "metadata"]);
});

test("disabled automatic sync stays fail-closed when residual alarm clear fails", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const alarms = new FakeAlarms();
  alarms.scheduledAt = NOW + 10_000;
  alarms.failClear = true;
  await repository.setSettings({
    [SETTING_KEYS.autoSyncEnabled]: false,
    [SETTING_KEYS.nextSyncAt]: NOW + 10_000,
    [SETTING_KEYS.watchdogUntil]: NOW + 10_000
  });
  const { service } = createService({ repository, api, alarms });
  let starts = 0;
  const runner = createGatedSyncRunner({
    ensureUserAgentRule: async () => {
      starts += 1;
    },
    startSync: (trigger) => service.start(trigger),
    keepAlive: async (operation) => operation
  });
  const handler = createAlarmEventHandler({
    getService: async () => service,
    getRunner: async () => runner
  });

  await handler({ name: SYNC_ALARM_NAME, scheduledTime: NOW + 10_000 });
  assert.equal(starts, 0);
  assert.equal(api.calls.length, 0);
  assert.equal(await repository.getSetting(SETTING_KEYS.nextSyncAt), null);
  assert.equal(await repository.getSetting(SETTING_KEYS.watchdogUntil), null);
  assert.equal(await repository.getSetting(SETTING_KEYS.lastAlarmError), "unavailable");
});

test("a durable purge guard clears alarms without attempting blocked setting writes", async () => {
  const repository = await createRepository();
  await repository.setSettings({
    [SETTING_KEYS.autoSyncEnabled]: true,
    [SETTING_KEYS.purgePending]: true
  });
  const alarms = new FakeAlarms();
  alarms.scheduledAt = NOW + 60_000;
  const { service } = createService({ repository, api: new FakeApi(), alarms });

  await service.repairSchedule();
  assert.equal(alarms.scheduledAt, null);
  assert.equal(await repository.getSetting(SETTING_KEYS.purgePending), true);

  alarms.scheduledAt = NOW + 120_000;
  assert.equal(await service.prepareAutomaticSync(), false);
  assert.equal(alarms.scheduledAt, null);
  assert.equal(await repository.getSetting(SETTING_KEYS.purgePending), true);
});

test("settings stay committed when automatic schedule repair fails", async () => {
  const repository = await createRepository();
  const alarms = new FakeAlarms();
  alarms.failCreateAttempt = 1;
  const { service } = createService({ repository, api: new FakeApi(), alarms });

  assert.deepEqual(await service.updateSettings({
    autoSyncEnabled: true,
    notificationsEnabled: false
  }), {
    settingsSaved: true,
    scheduleWarning: SETTINGS_SCHEDULE_WARNING
  });
  assert.equal(await repository.getSetting(SETTING_KEYS.autoSyncEnabled), true);
  assert.equal(await repository.getSetting(SETTING_KEYS.notificationsEnabled), false);
  assert.equal(await repository.getSetting(SETTING_KEYS.lastAlarmError), "unavailable");
});

test("disabled automatic setting stays committed when residual alarm clearing fails", async () => {
  const repository = await createRepository();
  const alarms = new FakeAlarms();
  alarms.scheduledAt = NOW + 60_000;
  alarms.failClear = true;
  const { service } = createService({ repository, api: new FakeApi(), alarms });

  assert.deepEqual(await service.updateSettings({
    autoSyncEnabled: false,
    notificationsEnabled: true
  }), {
    settingsSaved: true,
    scheduleWarning: SETTINGS_SCHEDULE_WARNING
  });
  assert.equal(await repository.getSetting(SETTING_KEYS.autoSyncEnabled), false);
  assert.equal(await repository.getSetting(SETTING_KEYS.notificationsEnabled), true);
  assert.equal(await repository.getSetting(SETTING_KEYS.lastAlarmError), "unavailable");
});

test("settings message distinguishes a durable save from a schedule warning", async () => {
  const repository = await createRepository();
  const alarms = new FakeAlarms();
  alarms.failCreateAttempt = 1;
  const { service } = createService({ repository, api: new FakeApi(), alarms });
  const handler = createMessageHandler({
    service,
    startSync: createGatedSyncRunner({
      ensureUserAgentRule: async () => {},
      startSync: (trigger) => service.start(trigger),
      keepAlive: async (operation) => operation
    }),
    openVrchat: async () => {},
    openDashboard: async () => {},
    refreshBadge: async () => {},
    purgeAndUninstall: async () => ({ ok: true, dataDeleted: true })
  });

  assert.deepEqual(await handler({
    type: MESSAGE_TYPES.updateSettings,
    autoSyncEnabled: true,
    notificationsEnabled: false
  }), {
    ok: true,
    settingsSaved: true,
    scheduleWarning: SETTINGS_SCHEDULE_WARNING
  });
  assert.equal(await repository.getSetting(SETTING_KEYS.autoSyncEnabled), true);
  assert.equal(await repository.getSetting(SETTING_KEYS.notificationsEnabled), false);
});

test("alarm boundary catches resolve, rearm, run, and repair rejection stages", async (context) => {
  for (const stage of ["resolve", "rearm", "run", "repair"]) {
    await context.test(stage, async () => {
      let repairAttempts = 0;
      const service = /** @type {Pick<SyncService,
       * "prepareAutomaticSync" | "resolveAlarmTrigger" |
       * "rearmWatchdogForActiveSync" | "repairScheduleBestEffort">} */ ({
        prepareAutomaticSync: async () => true,
        resolveAlarmTrigger: async () => {
          if (stage === "resolve") {
            throw new Error("resolve failure");
          }
          return stage === "rearm" ? "resume" : "alarm";
        },
        rearmWatchdogForActiveSync: async () => {
          if (stage === "rearm") {
            throw new Error("rearm failure");
          }
          return false;
        },
        repairScheduleBestEffort: async () => {
          repairAttempts += 1;
          if (stage === "repair" && repairAttempts === 1) {
            throw new Error("repair failure");
          }
        }
      });
      const runner = /** @type {ReturnType<typeof createGatedSyncRunner>} */ (
        async () => {
          if (stage === "run") {
            throw new Error("run failure");
          }
          return stage === "repair"
            ? { ok: false, error: "SECURITY_RULE_UNAVAILABLE" }
            : { ok: true };
        }
      );
      const handler = createAlarmEventHandler({
        getService: async () => service,
        getRunner: async () => runner
      });

      await assert.doesNotReject(
        handler({ name: SYNC_ALARM_NAME, scheduledTime: NOW })
      );
      assert.equal(repairAttempts, stage === "repair" ? 2 : 1);
    });
  }
});

test("best-effort repair creates a startup-jitter fallback after normal repair rejects", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const alarms = new FakeAlarms();
  alarms.get = async () => {
    throw new Error("simulated alarm read failure");
  };
  const { service } = createService({ repository, api, alarms });

  await assert.doesNotReject(service.repairScheduleBestEffort());
  assert.equal(alarms.scheduledAt, NOW + STARTUP_MIN_DELAY_MS);
  assert.equal(
    await repository.getSetting(SETTING_KEYS.nextSyncAt),
    NOW + STARTUP_MIN_DELAY_MS
  );
  assert.equal(await repository.getSetting(SETTING_KEYS.watchdogUntil), null);
  assert.equal(await repository.getSetting(SETTING_KEYS.lastAlarmError), "unavailable");
  assert.equal(api.calls.length, 0);
});

test("DNR gate failure returns a fixed code and never invokes the sync/API entry", async () => {
  let starts = 0;
  const runner = createGatedSyncRunner({
    ensureUserAgentRule: async () => {
      throw new Error("DNR unavailable");
    },
    startSync: async () => {
      starts += 1;
      return { ok: true };
    },
    keepAlive: async (operation) => operation
  });

  assert.deepEqual(await runner("manual"), {
    ok: false,
    error: "SECURITY_RULE_UNAVAILABLE"
  });
  assert.equal(starts, 0);
});

test("maintenance gate is checked again after DNR before the API entry", async () => {
  let allowed = true;
  let starts = 0;
  const runner = createGatedSyncRunner({
    canStart: () => allowed,
    ensureUserAgentRule: async () => {
      allowed = false;
    },
    startSync: async () => {
      starts += 1;
      return { ok: true };
    },
    keepAlive: async (operation) => operation
  });

  assert.deepEqual(await runner("manual"), {
    ok: false,
    error: "MAINTENANCE_IN_PROGRESS"
  });
  assert.equal(starts, 0);
});

test("badge uses durable unread count and caps its display", async () => {
  /** @type {{text: string}[]} */
  const texts = [];
  /** @type {{color: string}[]} */
  const colors = [];
  /**
   * @template T
   * @returns {Promise<T | undefined>}
   */
  async function getActiveProfileSetting() {
    return /** @type {T} */ (/** @type {unknown} */ (USER_ID));
  }
  const updateBadge = createBadgeUpdater({
    repository: {
      getSetting: getActiveProfileSetting,
      getUnreadSummary: async () => ({exact: true, uncertain: false, count: 123})
    },
    setBadgeText: async (details) => {
      texts.push(details);
    },
    setBadgeBackgroundColor: async (details) => {
      colors.push(details);
    }
  });

  await updateBadge();
  assert.deepEqual(texts, [{ text: "99+" }]);
  assert.deepEqual(colors, [{ color: "#8B3028" }]);
});

test("purge clears user records before uninstall and never uninstalls after a purge failure", async () => {
  /** @type {string[]} */
  const order = [];
  const success = createPurgeController({
    service: { syncing: false, repairScheduleBestEffort: async () => {} },
    repository: {
      beginPurge: async () => {
        order.push("begin-purge:new");
        return true;
      },
      recoverFromFailedPurge: async () => {
        order.push("recover-purge");
      },
      purgeAllData: async () => {
        order.push("purge");
      }
    },
    clearAlarm: async () => {
      order.push("clear-alarm");
      return true;
    },
    cleanupAuthCookies: async () => {
      order.push("cleanup-auth-cookies");
    },
    clearBadge: async () => {
      order.push("clear-badge");
    },
    uninstallSelf: async () => {
      order.push("uninstall");
    }
  });
  assert.deepEqual(await success.purgeAndUninstall(), { ok: true, dataDeleted: true });
  assert.deepEqual(order, [
    "begin-purge:new",
    "clear-alarm",
    "cleanup-auth-cookies",
    "purge",
    "clear-badge",
    "uninstall"
  ]);

  let uninstallCalls = 0;
  let scheduleRepairs = 0;
  let purgeRecoveries = 0;
  const blocked = createPurgeController({
    service: {
      syncing: false,
      repairScheduleBestEffort: async () => {
        scheduleRepairs += 1;
      }
    },
    repository: {
      beginPurge: async () => true,
      recoverFromFailedPurge: async () => {
        purgeRecoveries += 1;
      },
      purgeAllData: async () => {
        throw new Error("purge transaction failed");
      }
    },
    clearAlarm: async () => true,
    cleanupAuthCookies: async () => {},
    clearBadge: async () => {},
    uninstallSelf: async () => {
      uninstallCalls += 1;
    }
  });
  assert.deepEqual(await blocked.purgeAndUninstall(), {
    ok: false,
    error: "DELETE_FAILED",
    dataDeleted: false
  });
  assert.equal(uninstallCalls, 0);
  assert.equal(scheduleRepairs, 1);
  assert.equal(purgeRecoveries, 1);
});

test("a resumed purge keeps its existing guard on failure and retries deletion on success", async () => {
  let recoveries = 0;
  let repairs = 0;
  let uninstallCalls = 0;
  let purgeCalls = 0;
  const controller = createPurgeController({
    service: {
      syncing: false,
      repairScheduleBestEffort: async () => {
        repairs += 1;
      }
    },
    repository: {
      beginPurge: async () => false,
      recoverFromFailedPurge: async () => {
        recoveries += 1;
      },
      purgeAllData: async () => {
        purgeCalls += 1;
        throw new Error("resumed purge failed");
      }
    },
    clearAlarm: async () => true,
    cleanupAuthCookies: async () => {},
    clearBadge: async () => {},
    uninstallSelf: async () => {
      uninstallCalls += 1;
    }
  });

  assert.deepEqual(await controller.purgeAndUninstall(), {
    ok: false,
    error: "DELETE_FAILED",
    dataDeleted: false
  });
  assert.equal(recoveries, 0);
  assert.equal(repairs, 0);
  assert.equal(uninstallCalls, 0);
  assert.equal(purgeCalls, 1);
  assert.equal(controller.canStartSync(), false);

  const restartedController = createPurgeController({
    service: { syncing: false, repairScheduleBestEffort: async () => {} },
    repository: {
      beginPurge: async () => false,
      recoverFromFailedPurge: async () => {
        recoveries += 1;
      },
      purgeAllData: async () => {
        purgeCalls += 1;
      }
    },
    clearAlarm: async () => true,
    cleanupAuthCookies: async () => {},
    clearBadge: async () => {},
    uninstallSelf: async () => {
      uninstallCalls += 1;
    }
  });
  assert.deepEqual(await restartedController.purgeAndUninstall(), {
    ok: true,
    dataDeleted: true
  });
  assert.equal(recoveries, 0);
  assert.equal(uninstallCalls, 1);
  assert.equal(purgeCalls, 2);
});

test("purge never deletes records or uninstalls when owned Cookie cleanup fails", async () => {
  let purgeCalls = 0;
  let uninstallCalls = 0;
  let recoveries = 0;
  let repairs = 0;
  const controller = createPurgeController({
    service: {
      syncing: false,
      repairScheduleBestEffort: async () => {
        repairs += 1;
      }
    },
    repository: {
      beginPurge: async () => true,
      recoverFromFailedPurge: async () => {
        recoveries += 1;
      },
      purgeAllData: async () => {
        purgeCalls += 1;
      }
    },
    clearAlarm: async () => true,
    cleanupAuthCookies: async () => {
      throw new AuthCookieCleanupError();
    },
    clearBadge: async () => {},
    uninstallSelf: async () => {
      uninstallCalls += 1;
    }
  });

  assert.deepEqual(await controller.purgeAndUninstall(), {
    ok: false,
    error: "DELETE_FAILED",
    dataDeleted: false
  });
  assert.equal(purgeCalls, 0);
  assert.equal(uninstallCalls, 0);
  assert.equal(recoveries, 1);
  assert.equal(repairs, 1);
});

test("failed self-uninstall reports purged data while the durable gate remains closed", async () => {
  const controller = createPurgeController({
    service: { syncing: false, repairScheduleBestEffort: async () => {} },
    repository: {
      beginPurge: async () => true,
      recoverFromFailedPurge: async () => {},
      purgeAllData: async () => {}
    },
    clearAlarm: async () => true,
    cleanupAuthCookies: async () => {},
    clearBadge: async () => {},
    uninstallSelf: async () => {
      throw new Error("user cancelled");
    }
  });

  assert.deepEqual(await controller.purgeAndUninstall(), {
    ok: false,
    error: "UNINSTALL_FAILED",
    dataDeleted: true
  });
  assert.equal(controller.canStartSync(), false);
});

test("each completed gated sync performs a fresh security-rule verification", async () => {
  let verifications = 0;
  let starts = 0;
  const runner = createGatedSyncRunner({
    ensureUserAgentRule: async () => {
      verifications += 1;
    },
    startSync: async () => {
      starts += 1;
      return { ok: true };
    },
    keepAlive: async (operation) => operation
  });

  await runner("manual");
  await runner("alarm");
  assert.equal(verifications, 2);
  assert.equal(starts, 2);
});

test("keepalive pulses below 30 seconds and always clears its interval", async () => {
  /** @type {(() => void)[]} */
  const ticks = [];
  /** @type {unknown} */
  let cleared = null;
  let pulseCount = 0;
  /** @type {(value: string) => void} */
  let resolveOperation = () => {};
  const operation = new Promise((resolve) => {
    resolveOperation = resolve;
  });
  /** @param {() => void} callback @param {number} delay */
  const fakeSetInterval = (callback, delay) => {
    assert.equal(delay, KEEPALIVE_INTERVAL_MS);
    ticks.push(callback);
    return /** @type {ReturnType<typeof globalThis.setInterval>} */ (
      /** @type {unknown} */ (123)
    );
  };
  const kept = keepServiceWorkerAlive(operation, {
    pulse: () => {
      pulseCount += 1;
      return Promise.reject(new Error("pulse unavailable"));
    },
    setInterval: /** @type {typeof globalThis.setInterval} */ (fakeSetInterval),
    clearInterval: /** @type {typeof globalThis.clearInterval} */ ((timer) => {
      cleared = timer;
    })
  });

  assert.equal(ticks.length, 1);
  ticks[0]?.();
  await Promise.resolve();
  assert.equal(pulseCount, 1);
  resolveOperation("done");
  assert.equal(await kept, "done");
  assert.equal(cleared, 123);
});

test("auth command is separate from status polling and cannot switch stored profiles", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const { service } = createService({ repository, api });
  await repository.setSettings({[SETTING_KEYS.lastSyncResult]: "auth_required"});
  let checks = 0;
  const handler = createMessageHandler({
    service,
    checkAuthStatus: async () => {
      checks += 1;
      return {state: "authenticated", checkedAt: new Date(NOW).toISOString(), retryAt: null};
    },
    startSync: createGatedSyncRunner({
      ensureUserAgentRule: async () => {}, startSync: (trigger) => service.start(trigger),
      keepAlive: async (operation) => operation
    }),
    openVrchat: async () => {}, openDashboard: async () => {}, refreshBadge: async () => {},
    purgeAndUninstall: async () => ({ok: true, dataDeleted: true})
  });
  for (let i = 0; i < 5; i += 1) await handler({type: MESSAGE_TYPES.getStatus});
  assert.equal(checks, 0);
  const response = await handler({type: MESSAGE_TYPES.checkAuthStatus, url: "https://example.invalid", userId: "ignored"});
  assert.deepEqual(response, {ok: true, auth: {state: "authenticated", checkedAt: new Date(NOW).toISOString(), retryAt: null}});
  assert.equal(checks, 1);
  assert.equal(api.calls.length, 0);
  assert.equal((await service.getStatus()).activeProfileId, null);
  assert.equal(await repository.getSetting(SETTING_KEYS.lastSyncResult), "auth_required");
});

test("message router exposes only fixed operations and never accepts a URL", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const { service } = createService({ repository, api });
  let openedVrchat = 0;
  let openedDashboard = 0;
  const handler = createMessageHandler({
    service,
    startSync: createGatedSyncRunner({
      ensureUserAgentRule: async () => {},
      startSync: (trigger) => service.start(trigger),
      keepAlive: async (operation) => operation
    }),
    openVrchat: async () => {
      openedVrchat += 1;
    },
    openDashboard: async () => {
      openedDashboard += 1;
    },
    refreshBadge: async () => {},
    purgeAndUninstall: async () => ({ ok: true, dataDeleted: true })
  });

  assert.deepEqual(await handler({ type: MESSAGE_TYPES.openVrchat }), { ok: true });
  assert.deepEqual(await handler({ type: MESSAGE_TYPES.openDashboard }), { ok: true });
  assert.equal(openedVrchat, 1);
  assert.equal(openedDashboard, 1);
  assert.deepEqual(await handler({ type: MESSAGE_TYPES.markHistoryRead }), {
    ok: false,
    error: "NO_ACTIVE_PROFILE"
  });
  assert.deepEqual(await handler({ type: MESSAGE_TYPES.purgeAndUninstall }), {
    ok: true,
    dataDeleted: true
  });
  assert.deepEqual(
    await handler({ type: "OPEN_URL", url: "https://attacker.invalid/" }),
    { ok: false, error: "INVALID_REQUEST" }
  );
});

test("durable settings and read markers stay successful when badge refresh rejects", async () => {
  let updates = 0;
  let repairs = 0;
  let marks = 0;
  const handler = createMessageHandler({
    service: {
      getStatus: async () => ({
        thumbnailProgress: null,
        thumbnailSavedCount: 0,
        syncing: false,
        authRequired: false,
        lastSuccessfulSyncAt: null,
        nextSyncAt: null,
        activeProfileId: null,
        worldCount: 0,
        eventCount: 0,
        pendingProbeCount: 0,
        attentionWorldCount: 0,
        missingCount: 0,
        unavailableCount: 0,
        unreadCount: 0,
        unreadSummary: {exact: true, uncertain: false, count: 0},
        generation: 0, dataGeneration: 0, presentationGeneration: 0, hiddenCount: 0, recordMutating: false,
        favoriteGroupStatus: null,
        lastResult: null
      }),
      updateSettings: async () => {
        updates += 1;
        return { settingsSaved: true, scheduleWarning: null };
      },
      repairSchedule: async () => {
        repairs += 1;
      },
      markHistoryRead: async () => {
        marks += 1;
        return true;
      }
    },
    startSync: /** @type {ReturnType<typeof createGatedSyncRunner>} */ (
      async () => ({ ok: true })
    ),
    openVrchat: async () => {},
    openDashboard: async () => {},
    refreshBadge: async () => {
      throw new Error("badge unavailable");
    },
    purgeAndUninstall: async () => ({ ok: true, dataDeleted: true })
  });

  assert.deepEqual(await handler({
    type: MESSAGE_TYPES.updateSettings,
    autoSyncEnabled: true,
    notificationsEnabled: true
  }), { ok: true, settingsSaved: true, scheduleWarning: null });
  assert.deepEqual(await handler({ type: MESSAGE_TYPES.settingsChanged }), { ok: true });
  assert.deepEqual(await handler({ type: MESSAGE_TYPES.markHistoryRead }), {
    ok: true,
    unreadCount: 0
  });
  assert.equal(updates, 1);
  assert.equal(repairs, 1);
  assert.equal(marks, 1);
});

/**
 * Preserve DatabaseRepository private-field receivers while overriding a
 * small public operation for a race-injection test.
 *
 * @param {DatabaseRepository} repository
 * @param {Partial<Pick<DatabaseRepository,
 *   "commitSync" | "claimEvents" | "getDataGeneration" | "setSettings" | "hideWorld" | "getProfileStats" | "getUnreadCount">>} overrides
 * @returns {DatabaseRepository}
 */
function bindRepositoryWithOverrides(repository, overrides) {
  return new Proxy(repository, {
    get(target, property) {
      if (property === "commitSync" && overrides.commitSync !== undefined) {
        return overrides.commitSync;
      }
      if (property === "claimEvents" && overrides.claimEvents !== undefined) {
        return overrides.claimEvents;
      }
      if (property === "getDataGeneration" && overrides.getDataGeneration !== undefined) {
        return overrides.getDataGeneration;
      }
      if (property === "setSettings" && overrides.setSettings !== undefined) {
        return overrides.setSettings;
      }
      if (property === "hideWorld" && overrides.hideWorld !== undefined) return overrides.hideWorld;
      if (property === "getProfileStats" && overrides.getProfileStats !== undefined) return overrides.getProfileStats;
      if (property === "getUnreadCount" && overrides.getUnreadCount !== undefined) return overrides.getUnreadCount;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

test("one manual sync automatically completes 303 and 800 images across restarted workers without metadata refetch", async (context) => {
  for (const count of [303, 800]) {
    await context.test(`${count} images`, async () => {
      const repository = await createRepository();
      const api = new FakeApi();
      const now = {value: NOW};
      const alarms = new FakeAlarms();
      api.favoriteWorldsOverride = Array.from({length: count}, (_, index) => ({
        id: `wrld_aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
        name: "画像", authorName: "作者", favoriteGroup: "worlds1",
        releaseStatus: /** @type {const} */ ("public"),
        thumbnailImageUrl: `https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}/1/256`
      }));
      api.favoriteRelationsOverride = api.favoriteWorldsOverride.map((world) => ({favoriteId: world.id, tags: ["worlds1"], type: "world"}));
      const attempts = new Set();
      const deps = {repository, api, now, alarms, thumbnailWait: async () => undefined,
        /** @param {string} sourceUrl */
        encodeThumbnail: async (sourceUrl) => {
          assert.equal(attempts.has(sourceUrl), false, "saved source is never fetched twice");
          attempts.add(sourceUrl);
          return {bytes: new Uint8Array([1]), contentType: /** @type {const} */ ("image/webp"), width: 1, height: 1, sourceUrl};
        }};
      await repository.setSetting(SETTING_KEYS.autoSyncEnabled, false);
      let service = createService(deps).service;
      assert.equal((await service.start("manual")).ok, true);
      assert.equal(attempts.size, 100);
      const calls = api.calls.length;
      for (let batch = 0; batch < 9 && alarms.thumbnailAt !== null; batch += 1) {
        service = createService(deps).service;
        await service.repairThumbnailSchedule();
        assert.ok(alarms.thumbnailAt !== null);
        now.value = alarms.thumbnailAt;
        assert.deepEqual(await service.start("thumbnail"), {ok: true});
        assert.equal(api.calls.length, calls);
      }
      assert.equal(attempts.size, count);
      assert.equal(alarms.thumbnailAt, null);
      assert.deepEqual((await service.getStatus()).thumbnailProgress, {
        total: count, saved: count, remaining: 0, failed: 0, nextAttemptAt: null, state: "complete"
      });
    });
  }
});

test("thumbnail continuation honors Retry-After and terminates permanent failures after three attempts", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const now = {value: NOW};
  const alarms = new FakeAlarms();
  api.favoriteWorldsOverride = [{id: WORLD_ID, name: "画像", authorName: "作者", favoriteGroup: "worlds1", releaseStatus: "public",
    thumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256"}];
  let attempts = 0;
  const {service} = createService({repository, api, now, alarms, encodeThumbnail: async () => {
    attempts += 1;
    throw new ThumbnailFetchError(THUMBNAIL_ERROR_CODES.HTTP_STATUS, attempts === 1 ? 429 : 404, attempts === 1 ? NOW + 120_000 : null);
  }});
  await service.start("manual");
  assert.equal(attempts, 1);
  const metadataCalls = api.calls.length;
  now.value += 60_000;
  await service.start("thumbnail");
  assert.equal(attempts, 1);
  now.value += 60_000;
  await service.start("thumbnail");
  assert.equal(attempts, 2);
  now.value += 60_000;
  await service.start("thumbnail");
  assert.equal(attempts, 3);
  assert.equal(alarms.thumbnailAt, null);
  await service.start("thumbnail");
  assert.equal(attempts, 3);
  assert.equal(api.calls.length, metadataCalls);
  assert.deepEqual((await service.getStatus()).thumbnailProgress, {
    total: 1, saved: 0, remaining: 0, failed: 1, nextAttemptAt: null, state: "partial", failureReasons: ["not_found"]
  });
});

test("thumbnail alarms bypass periodic-sync preference and repair after gated failure", async () => {
  let repaired = 0;
  let gateChecks = 0;
  const service = {
    prepareAutomaticSync: async () => {gateChecks += 1; return false;},
    resolveAlarmTrigger: async () => /** @type {const} */ ("alarm"),
    rearmWatchdogForActiveSync: async () => false,
    repairScheduleBestEffort: async () => {},
    repairThumbnailScheduleBestEffort: async () => {repaired += 1;}
  };
  /** @type {string[]} */
  const triggers = [];
  const handler = createAlarmEventHandler({getService: async () => service,
    getRunner: async () => async (trigger) => {triggers.push(trigger); return {ok: false, error: "SECURITY_RULE_UNAVAILABLE"};}});
  await handler({name: "thumbnail-next", scheduledTime: NOW});
  assert.deepEqual(triggers, ["thumbnail"]);
  assert.equal(gateChecks, 0);
  assert.equal(repaired, 1);
});

test("manual request during an active image batch runs a full sync afterward", async () => {
  /** @type {(() => void) | undefined} */
  let finish;
  const pending = new Promise((resolve) => {finish = () => resolve(undefined);});
  /** @type {string[]} */
  const triggers = [];
  const runner = createGatedSyncRunner({ensureUserAgentRule: async () => {},
    startSync: async (trigger) => {triggers.push(trigger); if (trigger === "thumbnail") await pending; return {ok: true};},
    keepAlive: async (operation) => operation});
  const imageRun = runner("thumbnail");
  const manualRun = runner("manual");
  finish?.();
  await Promise.all([imageRun, manualRun]);
  assert.deepEqual(triggers, ["thumbnail", "manual"]);
});

test("failed image alarm reservation is visible and startup repair resumes without another sync", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const now = {value: NOW};
  const alarms = new FakeAlarms();
  alarms.failThumbnailCreate = true;
  api.favoriteWorldsOverride = [{id: WORLD_ID, name: "画像", authorName: "作者", favoriteGroup: "worlds1", releaseStatus: "public",
    thumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256"}];
  let attempts = 0;
  const {service} = createService({repository, api, now, alarms, encodeThumbnail: async (sourceUrl) => {
    attempts += 1;
    return {bytes: new Uint8Array([1]), contentType: "image/webp", width: 1, height: 1, sourceUrl};
  }});
  assert.equal((await service.start("manual")).ok, true);
  assert.equal(attempts, 0);
  assert.equal((await service.getStatus()).thumbnailProgress?.state, "paused");
  const calls = api.calls.length;
  alarms.failThumbnailCreate = false;
  await service.repairThumbnailScheduleBestEffort();
  assert.ok(alarms.thumbnailAt !== null);
  now.value = alarms.thumbnailAt;
  await service.start("thumbnail");
  assert.equal(attempts, 1);
  assert.equal(api.calls.length, calls);
  assert.equal((await service.getStatus()).thumbnailProgress?.state, "complete");
});

test("restored generations, switched profiles, and purge suppress persisted image jobs", async (context) => {
  for (const mode of ["restore", "profile", "purge"]) {
    await context.test(mode, async () => {
      const repository = await createRepository();
      const api = new FakeApi();
      const now = {value: NOW};
      const alarms = new FakeAlarms();
      api.favoriteWorldsOverride = [{id: WORLD_ID, name: "画像", authorName: "作者", favoriteGroup: "worlds1", releaseStatus: "public",
        thumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256"}];
      let attempts = 0;
      const {service} = createService({repository, api, now, alarms, encodeThumbnail: async () => {
        attempts += 1;
        throw new ThumbnailFetchError(THUMBNAIL_ERROR_CODES.HTTP_STATUS, 404);
      }});
      await service.start("manual");
      assert.equal(attempts, 1);
      if (mode === "purge") await repository.beginPurge();
      if (mode === "profile") await repository.setSetting(SETTING_KEYS.activeProfileId, "usr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
      if (mode === "restore") {
        const profile = await repository.getProfile(USER_ID);
        assert.ok(profile !== null);
        await repository.replaceProfileData({profile, worlds: await repository.listWorlds(USER_ID), favoriteGroups: [], events: []});
      }
      now.value += 60_000;
      await service.start("thumbnail");
      assert.equal(attempts, 1);
      assert.equal(alarms.thumbnailAt, null);
      assert.equal((await service.getStatus()).thumbnailProgress, null);
    });
  }
});

test("thumbnail checkpoint deadline prevents network requests after slow or stalled checkpoints", async (context) => {
  for (const mode of ["slow", "stalled"]) {
    await context.test(mode, async () => {
      let now = NOW;
      let encodes = 0;
      const result = await captureAvailableWorldThumbnails({userId: USER_ID, generation: 1,
        capturedAt: new Date(NOW).toISOString(), timeBudgetMs: 20, clock: () => now,
        metadata: [{id: WORLD_ID, thumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256"}],
        repository: {listThumbnailMetadata: async () => [], putThumbnail: async () => {}},
        onAttempt: async () => {
          if (mode === "slow") {now += 21; return;}
          await new Promise(() => {});
        },
        encode: async (sourceUrl) => {
          encodes += 1;
          return {bytes: new Uint8Array([1]), contentType: "image/webp", width: 1, height: 1, sourceUrl};
        }
      });
      assert.equal(encodes, 0);
      assert.equal(result.deferred, 1);
      assert.equal(result.saved, 0);
    });
  }
});

test("image metadata read failure does not hide successful world sync status", async () => {
  const repository = await createRepository();
  const {service} = createService({repository, api: new FakeApi()});
  await service.start("manual");
  repository.listThumbnailMetadata = async () => {throw new Error("synthetic image-only failure");};
  const status = await service.getStatus();
  assert.equal(status.worldCount, 1);
  assert.equal(status.lastSuccessfulSyncAt, new Date(NOW).toISOString());
  assert.equal(status.thumbnailProgress, null);
  assert.equal(status.thumbnailSavedCount, null);
});

test("saved image count remains available without an image job after upgrade", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  api.favoriteWorldsOverride = [{id: WORLD_ID, name: "画像", authorName: "作者", favoriteGroup: "worlds1", releaseStatus: "public",
    thumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256"}];
  const {service} = createService({repository, api, thumbnailWait: async () => undefined,
    encodeThumbnail: async (sourceUrl) => ({bytes: new Uint8Array([1]), contentType: "image/webp", width: 1, height: 1, sourceUrl})});
  assert.equal((await service.start("manual")).ok, true);
  assert.equal((await service.getStatus()).thumbnailSavedCount, 1);
  await repository.setSetting(SETTING_KEYS.thumbnailJob, null);
  const status = await service.getStatus();
  assert.equal(status.thumbnailProgress, null);
  assert.equal(status.thumbnailSavedCount, 1);
  assert.equal(status.worldCount, 1);
});

test("a transient initial image job write failure is retried before image network access", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  api.favoriteWorldsOverride = [{id: WORLD_ID, name: "画像", authorName: "作者", favoriteGroup: "worlds1", releaseStatus: "public",
    thumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256"}];
  const original = repository.setThumbnailSettings.bind(repository);
  let writes = 0;
  repository.setThumbnailSettings = async (...args) => {
    writes += 1;
    if (writes === 1) throw new Error("synthetic one-time checkpoint failure");
    return original(...args);
  };
  let encodes = 0;
  const {service} = createService({repository, api, encodeThumbnail: async (sourceUrl) => {
    assert.ok(writes >= 2);
    assert.ok(await repository.getSetting(SETTING_KEYS.thumbnailJob));
    encodes += 1;
    return {bytes: new Uint8Array([1]), contentType: "image/webp", width: 1, height: 1, sourceUrl};
  }});
  assert.equal((await service.start("manual")).ok, true);
  assert.equal(encodes, 1);
  assert.equal((await service.getStatus()).thumbnailProgress?.state, "complete");
});

test("image schedule repair and batches cannot overwrite each other's durable attempts", async (context) => {
  for (const failRepair of [false, true]) {
    await context.test(failRepair ? "failed repair recovery" : "successful repair", async () => {
      const repository = await createRepository();
      const api = new FakeApi();
      const now = {value: NOW};
      const alarms = new FakeAlarms();
      api.favoriteWorldsOverride = [{id: WORLD_ID, name: "画像", authorName: "作者", favoriteGroup: "worlds1", releaseStatus: "public",
        thumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256"}];
      let attempts = 0;
      const {service} = createService({repository, api, now, alarms, encodeThumbnail: async () => {
        attempts += 1;
        throw new ThumbnailFetchError(THUMBNAIL_ERROR_CODES.HTTP_STATUS, 404);
      }});
      await service.start("manual");
      assert.equal(attempts, 1);
      now.value += 60_000;
      /** @type {(() => void) | undefined} */
      let release;
      /** @type {(() => void) | undefined} */
      let entered;
      const blocked = new Promise((resolve) => {release = () => resolve(undefined);});
      const created = new Promise((resolve) => {entered = () => resolve(undefined);});
      const originalCreate = alarms.create.bind(alarms);
      let pauseNext = true;
      alarms.create = async (name, when) => {
        if (name === "thumbnail-next" && pauseNext) {
          pauseNext = false;
          entered?.();
          await blocked;
          if (failRepair) throw new Error("synthetic delayed repair failure");
        }
        return originalCreate(name, when);
      };
      const repair = service.repairThumbnailScheduleBestEffort();
      await created;
      const batch = service.start("thumbnail");
      assert.equal(attempts, 1, "batch waits for repair checkpoint including its failure handler");
      now.value += 60_000;
      release?.();
      await Promise.all([repair, batch]);
      assert.equal(attempts, 2);
      const job = /** @type {import("../extension/lib/sync-service.js").ThumbnailJob} */ (await repository.getSetting(SETTING_KEYS.thumbnailJob));
      assert.equal(job.items[0]?.attempts, 2);
      assert.equal(job.state, "waiting");
      assert.equal(job.nextAttemptAt, alarms.thumbnailAt);
      now.value += 60_000;
      await service.start("thumbnail");
      assert.equal(attempts, 3);
      await service.repairThumbnailScheduleBestEffort();
      assert.equal((await service.getStatus()).thumbnailProgress?.state, "partial");
      assert.equal(alarms.thumbnailAt, null);
    });
  }
});

/** @param {DatabaseRepository} repository */
async function recordMutationInput(repository) {
  const snapshot = await repository.getDisplaySnapshot(USER_ID);
  const world = snapshot.worlds.find((item) => item.worldId === WORLD_ID);
  assert.ok(world);
  return { userId: USER_ID, worldId: WORLD_ID, expectedGeneration: snapshot.generation,
    expectedPresentationGeneration: snapshot.presentationGeneration, expectedRevision: world.revision };
}

/** @param {DatabaseRepository} repository @param {FakeApi} api */
async function seedMissingRecord(repository, api) {
  const { service } = createService({ repository, api });
  assert.equal((await service.start("alarm")).ok, true);
  api.favoriteRelationsOverride = [];
  api.favoriteWorldsOverride = [];
  api.probeStatus = 404;
  assert.equal((await service.start("alarm")).ok, true);
  assert.equal((await service.start("alarm")).ok, true);
  return service;
}

/** @param {SyncService} service @param {Partial<Parameters<typeof createMessageHandler>[0]>} [overrides] */
function recordMessageHandler(service, overrides = {}) {
  return createMessageHandler({
    service,
    startSync: createGatedSyncRunner({ ensureUserAgentRule: async () => {},
      startSync: (trigger) => service.start(trigger), keepAlive: async (operation) => operation }),
    openVrchat: async () => {}, openDashboard: async () => {}, refreshBadge: async () => {},
    purgeAndUninstall: async () => ({ ok: true, dataDeleted: true }), ...overrides
  });
}

test("closed record commands validate IDs, generations and allowlisted fields before writing", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const service = await seedMissingRecord(repository, api);
  const handler = recordMessageHandler(service);
  const input = await recordMutationInput(repository);
  const valid = { type: MESSAGE_TYPES.hideWorld, ...input };
  for (const message of [
    { ...valid, userId: "usr_other" }, { ...valid, worldId: "wrld_other" },
    { ...valid, expectedGeneration: "3" }, { ...valid, expectedRevision: -1 },
    { ...valid, expectedPresentationGeneration: NaN }, { ...valid, store: "worlds" },
    { type: MESSAGE_TYPES.hideWorld, userId: USER_ID, worldId: WORLD_ID }
  ]) {
    assert.deepEqual(await handler(message), { ok: false, error: "INVALID_REQUEST" });
  }
  assert.deepEqual(await repository.listWorldDispositions(USER_ID), []);
  const result = await handler(valid);
  assert.equal(result.ok, true);
  assert.equal((await repository.listWorldDispositions(USER_ID))[0]?.state, "hidden");
  assert.deepEqual(await handler(valid), { ok: false, error: "RECORD_CHANGED" });
  const restored = await handler({ type: MESSAGE_TYPES.restoreHiddenWorld, ...await recordMutationInput(repository) });
  assert.equal(restored.ok, true);
  assert.deepEqual(await repository.listWorldDispositions(USER_ID), []);
  assert.deepEqual(await handler({ type: MESSAGE_TYPES.purgeHiddenWorld, ...await recordMutationInput(repository) }),
    { ok: false, error: "RECORD_CHANGED" });
});

test("record reservations reject overlapping sync, mutations and purge before asynchronous storage", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  await seedMissingRecord(repository, api);
  let release = () => {};
  const gate = new Promise((resolve) => { release = () => resolve(undefined); });
  const wrapped = bindRepositoryWithOverrides(repository, {
    hideWorld: async (input) => { await gate; return repository.hideWorld(input); }
  });
  const { service } = createService({ repository: wrapped, api });
  const input = await recordMutationInput(repository);
  const mutation = service.mutateRecord("hide", input);
  assert.equal(service.recordMutating, true);
  assert.deepEqual(await service.start("alarm"), { ok: false, error: "MAINTENANCE_IN_PROGRESS" });
  assert.deepEqual(await service.mutateRecord("hide", input), { ok: false, error: "SYNC_IN_PROGRESS" });
  let beganPurge = false;
  const purge = createPurgeController({ service,
    repository: { beginPurge: async () => { beganPurge = true; return true; },
      recoverFromFailedPurge: async () => {}, purgeAllData: async () => {} },
    clearAlarm: async () => true, cleanupAuthCookies: async () => {},
    clearBadge: async () => {}, uninstallSelf: async () => {}
  });
  assert.deepEqual(await purge.purgeAndUninstall(), { ok: false, error: "SYNC_IN_PROGRESS", dataDeleted: false });
  assert.equal(beganPurge, false);
  release();
  assert.equal((await mutation).ok, true);
  assert.equal(service.recordMutating, false);
  assert.deepEqual(await recordMessageHandler(service, { canMutateRecord: () => false })({
    type: MESSAGE_TYPES.restoreHiddenWorld, ...await recordMutationInput(repository)
  }), { ok: false, error: "MAINTENANCE_IN_PROGRESS" });
});

test("record mutation rejects active API and image batches and releases reservations after errors", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const service = await seedMissingRecord(repository, api);
  const input = await recordMutationInput(repository);
  let releaseUser = () => {};
  let userEntered = false;
  api.beforeUser = () => new Promise((resolve) => { userEntered = true; releaseUser = () => resolve(); });
  const sync = service.start("alarm");
  while (!userEntered) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await service.mutateRecord("hide", input), { ok: false, error: "SYNC_IN_PROGRESS" });
  releaseUser();
  await sync;
  api.beforeUser = null;
  const failed = createService({ repository: bindRepositoryWithOverrides(repository, {
    hideWorld: async () => { throw new Error("synthetic write failure"); }
  }), api }).service;
  assert.deepEqual(await failed.mutateRecord("hide", await recordMutationInput(repository)),
    { ok: false, error: "RECORD_UPDATE_FAILED" });
  assert.equal(failed.recordMutating, false);
  const sourceUrl = "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256";
  const generation = await repository.getDataGeneration(USER_ID);
  await repository.setSetting(SETTING_KEYS.thumbnailJob, {
    version: 1, userId: USER_ID, generation, capturedAt: new Date(NOW).toISOString(),
    items: [{id: WORLD_ID, thumbnailImageUrl: sourceUrl, attempts: 0}], nextAttemptAt: null, state: "waiting"
  });
  let releaseImage = () => {};
  let encoding = false;
  const imageService = createService({ repository, api, encodeThumbnail: async () => {
    encoding = true;
    await new Promise((resolve) => { releaseImage = () => resolve(undefined); });
    return {bytes: new Uint8Array([1]), contentType: "image/webp", width: 1, height: 1, sourceUrl};
  }}).service;
  const imageBatch = imageService.start("thumbnail");
  while (!encoding) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await imageService.mutateRecord("hide", await recordMutationInput(repository)),
    { ok: false, error: "SYNC_IN_PROGRESS" });
  releaseImage();
  await imageBatch;
});

test("hidden records keep sync history and notifications while atomic status excludes attention", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const service = await seedMissingRecord(repository, api);
  const before = await repository.getUnreadSummary(USER_ID);
  assert.equal((await service.mutateRecord("hide", await recordMutationInput(repository))).ok, true);
  const hidden = await service.getStatus();
  assert.equal(hidden.hiddenCount, 1);
  assert.equal(hidden.worldCount, 1);
  assert.equal(hidden.attentionWorldCount, 0);
  assert.deepEqual(hidden.unreadSummary, before);
  api.favoriteRelationsOverride = null;
  api.favoriteWorldsOverride = null;
  api.worldName = "非表示のまま新しい名前";
  const { service: recoveredService, notifications } = createService({ repository, api });
  assert.equal((await recoveredService.start("alarm")).ok, true);
  assert.equal((await repository.listWorldDispositions(USER_ID))[0]?.state, "hidden");
  assert.equal((await repository.listWorlds(USER_ID))[0]?.currentName, api.worldName);
  assert.ok((await repository.listEvents(USER_ID)).some((event) => event.kind === "name_changed"));
  assert.equal(notifications.created.length, 1);
  // A separate legacy count read would mix different committed generations.
  const atomicService = createService({ repository: bindRepositoryWithOverrides(repository, {
    getUnreadCount: async () => { throw new Error("must not read count separately"); }
  }), api }).service;
  assert.deepEqual((await atomicService.getStatus()).unreadSummary, await repository.getUnreadSummary(USER_ID));
});

test("purged relation-only IDs are not probed and fresh favorite metadata creates a silent new baseline", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const service = await seedMissingRecord(repository, api);
  await service.mutateRecord("hide", await recordMutationInput(repository));
  assert.equal((await service.mutateRecord("purge", await recordMutationInput(repository))).ok, true);
  api.calls = [];
  api.favoriteRelationsOverride = null;
  assert.equal((await service.start("alarm")).ok, true);
  assert.deepEqual(api.calls, ["user", "groups", "relations", "metadata"]);
  assert.deepEqual(await repository.listWorlds(USER_ID), []);
  assert.equal((await repository.listWorldDispositions(USER_ID))[0]?.state, "purged");
  api.favoriteWorldsOverride = null;
  api.failureStep = "metadata";
  api.failure = new NetworkError();
  assert.equal((await service.start("alarm")).ok, false);
  assert.equal((await repository.listWorldDispositions(USER_ID))[0]?.state, "purged");
  api.failureStep = null;
  api.worldName = "新規に保存した名前";
  const { service: fresh, notifications } = createService({ repository, api, now: {value: NOW + 86_400_000} });
  assert.deepEqual(await fresh.start("alarm"), { ok: true, changes: 0 });
  const world = (await repository.listWorlds(USER_ID))[0];
  assert.equal(world?.currentName, api.worldName);
  assert.equal(world?.firstSeenAt, new Date(NOW + 86_400_000).toISOString());
  assert.equal(world?.revision, 0);
  assert.deepEqual(await repository.listWorldDispositions(USER_ID), []);
  assert.deepEqual(await repository.listEvents(USER_ID), []);
  assert.equal(notifications.created.length, 0);
});

test("sync replan excludes a concurrently purged ID from records, events and image jobs", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  await seedMissingRecord(repository, api);
  const secondId = "wrld_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const snapshot = await repository.getDisplaySnapshot(USER_ID);
  const original = snapshot.worlds[0];
  assert.ok(original);
  await repository.replaceProfileData({ profile: /** @type {NonNullable<typeof snapshot.profile>} */ (snapshot.profile),
    worlds: [original, {...original, worldId: secondId, membershipState: "favorited", membershipMissCount: 0,
      availabilityState: "accessible", unavailableCount: 0}], events: snapshot.events, favoriteGroups: snapshot.favoriteGroups });
  await repository.hideWorld(await recordMutationInput(repository));
  api.favoriteWorldsOverride = [{id: WORLD_ID, name: "古い取得結果", authorName: "作者", favoriteGroup: "worlds1",
    releaseStatus: "public", thumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256"},
  {id: secondId, name: "他の記録は更新する", authorName: "作者", favoriteGroup: "worlds1", releaseStatus: "public"}];
  api.favoriteRelationsOverride = [{favoriteId: WORLD_ID, tags: ["worlds1"], type: "world"},
    {favoriteId: secondId, tags: ["worlds1"], type: "world"}];
  let commits = 0;
  let images = 0;
  const wrapped = bindRepositoryWithOverrides(repository, {
    commitSync: async (commit) => {
      commits += 1;
      if (commits === 1) await repository.purgeHiddenWorld(await recordMutationInput(repository));
      return repository.commitSync(commit);
    }
  });
  const { service } = createService({ repository: wrapped, api, encodeThumbnail: async (sourceUrl) => {
    images += 1;
    return {bytes: new Uint8Array([1]), contentType: "image/webp", width: 1, height: 1, sourceUrl};
  }});
  assert.deepEqual(await service.start("alarm"), { ok: true, changes: 1 });
  assert.equal(commits, 2);
  assert.equal(images, 0);
  assert.deepEqual((await repository.listWorlds(USER_ID)).map((world) => [world.worldId, world.currentName]),
    [[secondId, "他の記録は更新する"]]);
  assert.deepEqual((await repository.listEvents(USER_ID)).map((event) => [event.worldId, event.kind]),
    [[secondId, "name_changed"]]);
  assert.deepEqual((await repository.getSetting(SETTING_KEYS.thumbnailJob)).items, []);
  assert.equal((await repository.listWorldDispositions(USER_ID))[0]?.state, "purged");
});

test("any generation replan disables suppression release even for initial purged IDs", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const initial = await seedMissingRecord(repository, api);
  await initial.mutateRecord("hide", await recordMutationInput(repository));
  await initial.mutateRecord("purge", await recordMutationInput(repository));
  api.favoriteWorldsOverride = null;
  api.favoriteRelationsOverride = null;
  let commits = 0;
  const wrapped = bindRepositoryWithOverrides(repository, {
    commitSync: async (commit) => {
      commits += 1;
      if (commits === 1) await repository.saveProfile(commit.profile);
      return repository.commitSync(commit);
    }
  });
  assert.deepEqual(await createService({repository: wrapped, api}).service.start("alarm"), {ok: true, changes: 0});
  assert.equal(commits, 2);
  assert.deepEqual(await repository.listWorlds(USER_ID), []);
  assert.equal((await repository.listWorldDispositions(USER_ID))[0]?.state, "purged");
});

test("badge shows uncertainty without inventing a count", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  await createService({repository, api}).service.start("alarm");
  /** @type {string[]} */
  const texts = [];
  const update = createBadgeUpdater({ repository: {
    getSetting: repository.getSetting.bind(repository),
    getUnreadSummary: async () => ({exact: false, uncertain: true, count: null})
  }, setBadgeText: async ({text}) => { texts.push(text); }, setBadgeBackgroundColor: async () => {} });
  await update();
  assert.deepEqual(texts, ["?"]);
});

test("waiting image jobs permit record purge and alarm failures remain committed success", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  await seedMissingRecord(repository, api);
  const secondId = "wrld_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const snapshot = await repository.getDisplaySnapshot(USER_ID);
  const original = snapshot.worlds[0];
  assert.ok(original);
  await repository.replaceProfileData({ profile: /** @type {NonNullable<typeof snapshot.profile>} */ (snapshot.profile),
    worlds: [original, {...original, worldId: secondId}], events: snapshot.events,
    favoriteGroups: snapshot.favoriteGroups });
  await repository.hideWorld(await recordMutationInput(repository));
  const generation = await repository.getDataGeneration(USER_ID);
  const sourceUrl = "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256";
  const nextAttemptAt = NOW + 3_600_000;
  const secondItem = {id: secondId, thumbnailImageUrl: sourceUrl, attempts: 2};
  await repository.setSetting(SETTING_KEYS.thumbnailJob, {version: 1, userId: USER_ID, generation,
    capturedAt: new Date(NOW).toISOString(), items: [{id: WORLD_ID, thumbnailImageUrl: sourceUrl, attempts: 1}, secondItem],
    nextAttemptAt, state: "waiting"});
  const alarms = new FakeAlarms();
  alarms.failThumbnailCreate = true;
  const {service} = createService({repository, api, alarms});
  const handler = recordMessageHandler(service, {refreshBadge: async () => { throw new Error("badge unavailable"); }});
  const result = await handler({type: MESSAGE_TYPES.purgeHiddenWorld, ...await recordMutationInput(repository)});
  assert.equal(result.ok, true);
  assert.equal("recordSaved" in result && result.recordSaved, true);
  assert.equal("thumbnailScheduleWarning" in result && result.thumbnailScheduleWarning, "THUMBNAIL_SCHEDULE_REPAIR_FAILED");
  const job = await repository.getSetting(SETTING_KEYS.thumbnailJob);
  assert.deepEqual(job.items, [secondItem]);
  assert.equal(job.generation, generation + 1);
  assert.equal(job.nextAttemptAt, nextAttemptAt);
  assert.equal((await repository.listWorldDispositions(USER_ID))[0]?.state, "purged");
  assert.equal(service.recordMutating, false);
});

test("record commands never silently retarget after an account change", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const service = await seedMissingRecord(repository, api);
  const input = await recordMutationInput(repository);
  await repository.setSetting(SETTING_KEYS.activeProfileId, "usr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  assert.deepEqual(await service.mutateRecord("hide", input), {ok: false, error: "RECORD_CHANGED"});
  assert.deepEqual(await repository.listWorldDispositions(USER_ID), []);
  await repository.setSetting(SETTING_KEYS.activeProfileId, null);
  assert.deepEqual(await service.mutateRecord("hide", input), {ok: false, error: "NO_ACTIVE_PROFILE"});
  await repository.setSetting(SETTING_KEYS.activeProfileId, USER_ID);
  await repository.beginPurge();
  assert.deepEqual(await service.mutateRecord("hide", input), {ok: false, error: "MAINTENANCE_IN_PROGRESS"});
  assert.equal(service.recordMutating, false);
});

test("a due automatic alarm consumed during record mutation is rearmed and syncs after the reservation", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  await seedMissingRecord(repository, api);
  let release = () => {};
  let hideEntered = false;
  const gate = new Promise((resolve) => { release = () => resolve(undefined); });
  const wrapped = bindRepositoryWithOverrides(repository, {
    hideWorld: async (input) => { hideEntered = true; await gate; return repository.hideWorld(input); }
  });
  const alarms = new FakeAlarms();
  const now = {value: NOW};
  const {service} = createService({repository: wrapped, api, alarms, now});
  await repository.setSettings({[SETTING_KEYS.nextSyncAt]: NOW, [SETTING_KEYS.watchdogUntil]: null});
  api.calls = [];
  let securityChecks = 0;
  const runner = createGatedSyncRunner({
    ensureUserAgentRule: async () => { securityChecks += 1; },
    startSync: (trigger) => service.start(trigger), keepAlive: async (operation) => operation,
    canStart: () => !service.recordMutating
  });
  const handleAlarm = createAlarmEventHandler({getService: async () => service, getRunner: async () => runner});
  const mutation = service.mutateRecord("hide", await recordMutationInput(repository));
  while (!hideEntered) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.recordMutating, true);
  // Chrome removes a one-shot alarm before dispatching this event.
  alarms.scheduledAt = null;
  await handleAlarm({name: SYNC_ALARM_NAME, scheduledTime: NOW});
  assert.equal(securityChecks, 0);
  assert.deepEqual(api.calls, []);
  assert.equal(alarms.scheduledAt, NOW + STARTUP_MIN_DELAY_MS);
  assert.equal(await repository.getSetting(SETTING_KEYS.nextSyncAt), alarms.scheduledAt);
  release();
  assert.equal((await mutation).ok, true);
  const rearmedAt = alarms.scheduledAt;
  assert.ok(rearmedAt !== null);
  now.value = rearmedAt;
  alarms.scheduledAt = null;
  await handleAlarm({name: SYNC_ALARM_NAME, scheduledTime: rearmedAt});
  assert.equal(securityChecks, 1);
  assert.deepEqual(api.calls, ["user", "groups", "relations", "metadata"]);
  assert.equal((await repository.listWorldDispositions(USER_ID))[0]?.state, "hidden");
  assert.ok(alarms.scheduledAt !== null && alarms.scheduledAt > now.value);
});

test("maintenance alarm recovery stays fail closed when autosync is disabled or purge begins", async (context) => {
  for (const guard of ["disabled", "purge"]) {
    await context.test(guard, async () => {
      const repository = await createRepository();
      const api = new FakeApi();
      const alarms = new FakeAlarms();
      const {service} = createService({repository, api, alarms});
      await repository.setSettings({[SETTING_KEYS.nextSyncAt]: NOW, [SETTING_KEYS.watchdogUntil]: null});
      const runner = createGatedSyncRunner({
        ensureUserAgentRule: async () => {}, startSync: (trigger) => service.start(trigger),
        keepAlive: async (operation) => operation,
        canStart: async () => {
          // The state changes after prepareAutomaticSync accepted this alarm.
          if (guard === "disabled") await repository.setSetting(SETTING_KEYS.autoSyncEnabled, false);
          else await repository.beginPurge();
          return false;
        }
      });
      await createAlarmEventHandler({getService: async () => service, getRunner: async () => runner})(
        {name: SYNC_ALARM_NAME, scheduledTime: NOW});
      assert.equal(alarms.scheduledAt, null);
      assert.deepEqual(api.calls, []);
      assert.equal(alarms.creates.length, 0);
    });
  }
});


test("thumbnail failure classification is checkpointed and cleared on successful retry", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const now = {value: NOW};
  const alarms = new FakeAlarms();
  api.favoriteWorldsOverride = [{id: WORLD_ID, name: "画像", authorName: "作者", favoriteGroup: "worlds1", releaseStatus: "public",
    thumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256"}];
  const failed = createService({repository, api, now, alarms, encodeThumbnail: async () => {
    throw new ThumbnailError("DECODE_FAILED");
  }}).service;
  await failed.start("manual");
  const readJob = async () => /** @type {import("../extension/lib/sync-service.js").ThumbnailJob} */ (await repository.getSetting("thumbnailJob"));
  assert.equal((await readJob()).items[0]?.failureReason, "decode");
  assert.equal((await readJob()).items[0]?.attempts, 1);
  // A new service represents worker restart; use the existing continuation path.
  const recovered = createService({repository, api, now, alarms, encodeThumbnail: async (sourceUrl) => ({
    bytes: new Uint8Array([1]), contentType: "image/webp", width: 1, height: 1, sourceUrl
  })}).service;
  now.value += 60_000;
  await recovered.start("thumbnail");
  assert.equal((await readJob()).items[0]?.failureReason, undefined);
  assert.equal((await recovered.getStatus()).thumbnailProgress?.state, "complete");
  assert.equal((await recovered.getStatus()).thumbnailProgress?.failureReasons, undefined);
});

test("thumbnail capture records storage quota separately without leaking exception text", async () => {
  /** @type {unknown[]} */
  const failures = [];
  const result = await captureAvailableWorldThumbnails({userId: USER_ID, generation: 1, capturedAt: new Date(NOW).toISOString(),
    metadata: [{id: WORLD_ID, thumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256"}],
    repository: {listThumbnailMetadata: async () => [], putThumbnail: async () => { throw new DOMException("private text", "QuotaExceededError"); }},
    encode: async (sourceUrl) => ({bytes: new Uint8Array([1]), contentType: "image/webp", width: 1, height: 1, sourceUrl}),
    onFailure: (id, reason) => { failures.push([id, reason]); }
  });
  assert.deepEqual(failures, [[WORLD_ID, "storage_full"]]);
  assert.equal(result.failed, 1);
  assert.doesNotMatch(JSON.stringify({result, failures}), /private text/u);
});

test("existing continuation can retry just eight failed images without refetching saved images or metadata", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const now = {value: NOW};
  const alarms = new FakeAlarms();
  api.favoriteWorldsOverride = Array.from({length: 10}, (_, index) => ({
    id: `wrld_aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    name: "ダミー", authorName: "作者", favoriteGroup: "worlds1", releaseStatus: /** @type {const} */ ("public"),
    thumbnailImageUrl: `https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}/1/256`
  }));
  api.favoriteRelationsOverride = api.favoriteWorldsOverride.map((world) => ({favoriteId: world.id, tags: ["worlds1"], type: "world"}));
  const targets = new Set(api.favoriteWorldsOverride.slice(0, 8).map((world) => world.id));
  const failedSources = new Set(api.favoriteWorldsOverride.slice(0, 8).map((world) => world.thumbnailImageUrl));
  /** @type {string[]} */
  const requested = [];
  let recovered = false;
  const dependencies = {repository, api, now, alarms, encodeThumbnail: async (/** @type {string} */ sourceUrl) => {
    requested.push(sourceUrl);
    if (!recovered && failedSources.has(sourceUrl)) throw new ThumbnailError("DECODE_FAILED");
    return {bytes: new Uint8Array([1]), contentType: /** @type {const} */ ("image/webp"), width: 1, height: 1, sourceUrl};
  }};
  const service = createService(dependencies).service;
  await service.start("manual");
  for (let round = 0; round < 2; round += 1) {
    now.value += 60_000;
    await service.start("thumbnail");
  }
  assert.equal((await service.getStatus()).thumbnailProgress?.failed, 8);
  const job = /** @type {import("../extension/lib/sync-service.js").ThumbnailJob} */ (await repository.getSetting("thumbnailJob"));
  // This is a one-off, explicitly scoped local repair, not a new product command.
  for (const item of job.items) if (targets.has(item.id)) { item.attempts = 0; delete item.failureReason; }
  job.state = "waiting";
  job.nextAttemptAt = now.value;
  await repository.setThumbnailSettings(USER_ID, job.generation, {thumbnailJob: job});
  recovered = true;
  requested.length = 0;
  const metadataCalls = api.calls.length;
  await createService(dependencies).service.start("thumbnail");
  assert.equal(requested.length, 8);
  assert.deepEqual(new Set(requested), failedSources);
  assert.equal(api.calls.length, metadataCalls);
  assert.equal((await service.getStatus()).thumbnailProgress?.state, "complete");
});

test("failed or stalled reason checkpoints preserve Retry-After and the batch deadline", async () => {
  for (const onFailure of [async () => { throw new Error("checkpoint failed"); }, () => new Promise(() => {})]) {
    const retryAt = Date.now() + 120_000;
    const result = await captureAvailableWorldThumbnails({userId: USER_ID, generation: 1, capturedAt: new Date(NOW).toISOString(),
      metadata: [{id: WORLD_ID, thumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256"}],
      repository: {listThumbnailMetadata: async () => [], putThumbnail: async () => {}},
      encode: async () => { throw new ThumbnailFetchError("HTTP_STATUS", 429, retryAt); },
      timeBudgetMs: 100, onFailure
    });
    assert.equal(result.retryAt, retryAt);
    assert.equal(result.failed, 1);
  }
});

test("sync preserves reasons with unfinished attempts, but a completed batch resets them", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const now = {value: NOW};
  const alarms = new FakeAlarms();
  api.favoriteWorldsOverride = [{id: WORLD_ID, name: "画像", authorName: "作者", favoriteGroup: "worlds1", releaseStatus: "public",
    thumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256"}];
  const {service} = createService({repository, api, now, alarms, encodeThumbnail: async () => { throw new ThumbnailError("DECODE_FAILED"); }});
  await service.start("manual");
  const job = /** @type {import("../extension/lib/sync-service.js").ThumbnailJob} */ (await repository.getSetting("thumbnailJob"));
  assert.ok(job.items[0]);
  job.items[0].attempts = 3;
  job.items[0].failureReason = "network";
  job.state = "waiting";
  await repository.setThumbnailSettings(USER_ID, job.generation, {thumbnailJob: job});
  now.value += 60_000;
  await service.start("alarm");
  assert.deepEqual((await service.getStatus()).thumbnailProgress?.failureReasons, ["network"]);
  now.value += 60_000;
  await service.start("alarm");
  const reset = /** @type {import("../extension/lib/sync-service.js").ThumbnailJob} */ (await repository.getSetting("thumbnailJob"));
  assert.equal(reset.items[0]?.attempts, 1);
  assert.equal(reset.items[0]?.failureReason, "decode");
});

test("deadline reports the stalled stage without invoking a diagnostic write after expiry", async () => {
  for (const stage of /** @type {const} */ (["checkpoint", "fetch", "decode", "resize", "storage"])) {
    let writes = 0;
    let failures = 0;
    const result = await captureAvailableWorldThumbnails({userId: USER_ID, generation: 1, capturedAt: new Date(NOW).toISOString(),
      timeBudgetMs: 20, clock: () => NOW,
      metadata: [{id: WORLD_ID, thumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256"}],
      repository: {listThumbnailMetadata: async () => [], putThumbnail: async () => {writes += 1; await new Promise(() => {});}},
      onAttempt: async () => {if (stage === "checkpoint") await new Promise(() => {});},
      onFailure: async () => {failures += 1; await new Promise(() => {});},
      encode: async (sourceUrl, options) => {
        if (stage === "fetch" || stage === "decode" || stage === "resize") {
          options.onStage?.(stage);
          return new Promise(() => {});
        }
        return {bytes: new Uint8Array([1]), contentType: "image/webp", width: 1, height: 1, sourceUrl};
      }
    });
    assert.deepEqual(result.timedOut, {worldId: WORLD_ID, reason: `timeout_${stage}`});
    assert.equal(result.deferred, 1);
    assert.equal(failures, 0);
    assert.equal(writes, stage === "storage" ? 1 : 0);
  }
});

test("deadline reason survives the normal guarded checkpoint and stops after the existing three attempts", async () => {
  const repository = await createRepository();
  const api = new FakeApi();
  const now = {value: NOW};
  const alarms = new FakeAlarms();
  api.favoriteWorldsOverride = [{id: WORLD_ID, name: "ダミー", authorName: "作者", favoriteGroup: "worlds1", releaseStatus: "public",
    thumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256"}];
  let encodes = 0;
  const {service} = createService({repository, api, now, alarms, encodeThumbnail: async (sourceUrl, options) => {
    encodes += 1;
    options.onStage?.("decode");
    now.value += 30_001;
    return {bytes: new Uint8Array([1]), contentType: "image/webp", width: 1, height: 1, sourceUrl};
  }});
  await service.start("manual");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const job = /** @type {import("../extension/lib/sync-service.js").ThumbnailJob} */ (await repository.getSetting("thumbnailJob"));
    assert.equal(job.items[0]?.failureReason, "timeout_decode");
    assert.equal(job.items[0]?.attempts, attempt);
    assert.doesNotMatch(JSON.stringify(await repository.getSetting("thumbnailCaptureStatus")), /timedOut|worldId/u);
    now.value += 60_000;
    await service.start("thumbnail");
  }
  assert.equal(encodes, 3);
  assert.equal(alarms.thumbnailAt, null);
  assert.deepEqual((await service.getStatus()).thumbnailProgress?.failureReasons, ["timeout_decode"]);
});

test("a slow failure checkpoint does not relabel a known image error as an operation timeout", async () => {
  let now = NOW;
  /** @type {string[]} */
  const reasons = [];
  const result = await captureAvailableWorldThumbnails({userId: USER_ID, generation: 1, capturedAt: new Date(NOW).toISOString(),
    timeBudgetMs: 20, clock: () => now,
    metadata: [{id: WORLD_ID, thumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256"}],
    repository: {listThumbnailMetadata: async () => [], putThumbnail: async () => {}},
    encode: async (_url, options) => {options.onStage?.("decode"); throw new ThumbnailError("DECODE_FAILED");},
    onFailure: async (_id, reason) => {reasons.push(reason); now += 21;}
  });
  assert.deepEqual(reasons, ["decode"]);
  assert.equal(result.timedOut, undefined);
  assert.equal(result.deferred, 1);
});
