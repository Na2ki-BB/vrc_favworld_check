// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";

import {
  ANONYMOUS_RETENTION_OWNER,
  DATABASE_VERSION,
  DatabaseRepository,
  GenerationConflictError,
  PurgePendingError,
  RevisionConflictError,
  STORES,
  SYNC_RUN_RETENTION_ANONYMOUS,
  SYNC_RUN_RETENTION_PER_PROFILE,
  THUMBNAIL_BATCH_LIMIT,
  THUMBNAIL_MAX_BYTE_LENGTH
} from "../extension/lib/database.js";

/** @typedef {Awaited<ReturnType<DatabaseRepository["listWorlds"]>>[number]} WorldRecord */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listEvents"]>>[number]} HistoryEvent */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listFavoriteGroups"]>>[number]} FavoriteGroupRecord */
/** @typedef {Parameters<DatabaseRepository["commitSync"]>[0]["syncRun"]} SyncRunRecord */
/** @typedef {Parameters<DatabaseRepository["putThumbnail"]>[0]} ThumbnailRecord */

const USER_A = "usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "usr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORLD_A = "wrld_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORLD_B = "wrld_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORLD_C = "wrld_cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const WORLD_D = "wrld_dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const GROUP_A = "fvgrp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP_B = "fvgrp_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AT_1 = "2026-08-17T00:00:00.000Z";
const AT_2 = "2026-08-18T00:00:00.000Z";

Object.defineProperty(globalThis, "IDBKeyRange", {
  configurable: true,
  value: IDBKeyRange
});

/**
 * @param {string} userId
 * @param {string} [displayName]
 * @returns {Parameters<DatabaseRepository["saveProfile"]>[0]}
 */
function profile(userId, displayName = userId) {
  return {
    userId,
    displayName,
    firstSeenAt: AT_1,
    lastSuccessfulSyncAt: AT_1,
    createdBySchemaVersion: 1
  };
}

/**
 * @param {string} userId
 * @param {string} worldId
 * @param {number} [revision]
 * @returns {WorldRecord}
 */
function world(userId, worldId, revision = 1) {
  return {
    userId,
    worldId,
    currentName: `World ${worldId}`,
    normalizedName: `world ${worldId}`,
    authorName: "Author",
    normalizedAuthorName: "author",
    favoriteTags: ["worlds1"],
    firstSeenAt: AT_1,
    lastSeenFavoriteAt: AT_2,
    lastMetadataAt: AT_2,
    membershipState: "favorited",
    membershipMissCount: 0,
    availabilityState: "accessible",
    unavailableCount: 0,
    probeState: "none",
    lastProbeAt: null,
    lastEvidenceStatus: 200,
    revision,
    updatedAt: AT_2
  };
}

/**
 * @param {string} userId
 * @param {string} worldId
 * @param {Partial<ThumbnailRecord>} [overrides]
 * @returns {ThumbnailRecord}
 */
function thumbnail(userId, worldId, overrides = {}) {
  const blob = overrides.blob ?? new Blob([`webp:${worldId}`], { type: "image/webp" });
  const fileId = worldId.replace(/^wrld_/u, "file_");
  return {
    userId,
    worldId,
    width: 320,
    height: 180,
    capturedAt: AT_2,
    sourceUrl: `https://api.vrchat.cloud/api/1/file/${fileId}/1/file`,
    ...overrides,
    blob,
    byteLength: overrides.byteLength ?? blob.size
  };
}

/**
 * @param {string} userId
 * @param {string} worldId
 * @param {number} [revision]
 * @returns {HistoryEvent}
 */
function event(userId, worldId, revision = 1) {
  return {
    eventId: `${userId}:${worldId}:${revision}:name_changed`,
    userId,
    worldId,
    kind: "name_changed",
    observedAt: AT_2,
    before: "Old name",
    after: "New name",
    evidence: { source: "bulk", httpStatus: 200 },
    syncId: `sync-${userId}`,
    notificationEligible: true,
    notificationClaimedAt: null,
    notifiedAt: null,
    notificationError: null
  };
}

/**
 * @param {string} userId
 * @param {string} groupId
 * @param {Partial<FavoriteGroupRecord>} [overrides]
 * @returns {FavoriteGroupRecord}
 */
function favoriteGroup(userId, groupId, overrides = {}) {
  const active = overrides.active ?? true;
  return {
    userId,
    groupId,
    internalName: "worlds1",
    displayName: "お気に入り1",
    normalizedDisplayName: "お気に入り1",
    type: "world",
    active,
    missingCount: active ? 0 : 2,
    firstSeenAt: AT_1,
    lastSeenAt: AT_2,
    displayNameHistory: [],
    updatedAt: AT_2,
    ...overrides
  };
}

/**
 * @param {string} userId
 * @returns {SyncRunRecord}
 */
function syncRun(userId) {
  return {
    syncId: `sync-${userId}`,
    userId,
    trigger: "manual",
    startedAt: AT_1,
    finishedAt: AT_2,
    result: "success",
    favoriteCount: 1,
    metadataCount: 1,
    probeCount: 0,
    changeCount: 1,
    retryAt: null
  };
}

/**
 * @param {string} userId
 * @returns {Parameters<DatabaseRepository["commitSync"]>[0]["settings"]}
 */
function successSettings(userId) {
  return {
    activeProfileId: userId,
    backoffUntil: null,
    consecutiveRateLimits: 0,
    lastSyncResult: "success",
    favoriteGroupStatus: "success"
  };
}

/**
 * @param {string} name
 */
async function repository(name) {
  const factory = new IDBFactory();
  const value = new DatabaseRepository({ factory, name });
  await value.open();
  return value;
}

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

/**
 * @param {IDBTransaction} transaction
 * @returns {Promise<void>}
 */
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
}

/**
 * @param {IDBFactory} factory
 * @param {string} name
 * @returns {Promise<IDBDatabase>}
 */
function openRawDatabase(factory, name) {
  return requestValue(factory.open(name));
}

/**
 * @param {IDBFactory} factory
 * @param {string} name
 * @returns {Promise<Record<string, unknown[]>>}
 */
async function readAllStores(factory, name) {
  const raw = await openRawDatabase(factory, name);
  try {
    const storeNames = Object.values(STORES);
    const transaction = raw.transaction(storeNames, "readonly");
    const finished = transactionDone(transaction);
    const entries = await Promise.all(
      storeNames.map(async (storeName) => [
        storeName,
        await requestValue(transaction.objectStore(storeName).getAll())
      ])
    );
    await finished;
    return Object.fromEntries(entries);
  } finally {
    raw.close();
  }
}

/**
 * Create the exact store/index surface shipped as schema v1 and seed records
 * that must survive later upgrades.
 *
 * @param {IDBFactory} factory
 * @param {string} name
 * @returns {Promise<void>}
 */
async function createV1Database(factory, name) {
  const request = factory.open(name, 1);
  request.addEventListener("upgradeneeded", () => {
    const raw = request.result;
    raw.createObjectStore("profiles", { keyPath: "userId" });
    const worlds = raw.createObjectStore("worlds", { keyPath: ["userId", "worldId"] });
    worlds.createIndex("by-user", "userId", { unique: false });
    worlds.createIndex("by-user-updated-at", ["userId", "updatedAt"], { unique: false });
    worlds.createIndex("by-user-membership", ["userId", "membershipState"], { unique: false });
    worlds.createIndex("by-user-availability", ["userId", "availabilityState"], { unique: false });
    worlds.createIndex("by-user-probe", ["userId", "probeState", "lastProbeAt"], {
      unique: false
    });
    const events = raw.createObjectStore("events", { keyPath: "eventId" });
    events.createIndex("by-user", "userId", { unique: false });
    events.createIndex("by-user-observed-at", ["userId", "observedAt"], { unique: false });
    events.createIndex("by-user-kind-observed-at", ["userId", "kind", "observedAt"], {
      unique: false
    });
    events.createIndex("by-user-world-observed-at", ["userId", "worldId", "observedAt"], {
      unique: false
    });
    const runs = raw.createObjectStore("syncRuns", { keyPath: "syncId" });
    runs.createIndex("by-user", "userId", { unique: false });
    runs.createIndex("by-user-started-at", ["userId", "startedAt"], { unique: false });
    raw.createObjectStore("settings", { keyPath: "key" });
    raw.createObjectStore("meta", { keyPath: "key" });

    const transaction = request.transaction;
    if (transaction === null) {
      throw new Error("v1 upgrade transaction is unavailable");
    }
    transaction.objectStore("profiles").put(profile(USER_A, "v1 Alice"));
    transaction.objectStore("worlds").put(world(USER_A, WORLD_A));
    const legacyEvent = /** @type {Record<string, unknown>} */ ({
      ...event(USER_A, WORLD_A)
    });
    delete legacyEvent.notificationEligible;
    transaction.objectStore("events").put(legacyEvent);
    transaction.objectStore("syncRuns").put(syncRun(USER_A));
    transaction.objectStore("settings").put({ key: "autoSyncEnabled", value: true });
    transaction.objectStore("meta").put({ key: "schemaVersion", value: 1 });
    transaction.objectStore("meta").put({ key: "backupFormatVersion", value: 1 });
    transaction.objectStore("meta").put({ key: "lastMigration", value: 1 });
  });
  const raw = await requestValue(request);
  raw.close();
}

/**
 * Build a valid schema-v2 database from the v1 fixture so the v2 -> v3 path is
 * exercised independently from the direct v1 -> v3 migration.
 *
 * @param {IDBFactory} factory
 * @param {string} name
 * @returns {Promise<void>}
 */
async function createV2Database(factory, name) {
  await createV1Database(factory, name);
  const request = factory.open(name, 2);
  request.addEventListener("upgradeneeded", () => {
    const raw = request.result;
    const groups = raw.createObjectStore("favoriteGroups", {
      keyPath: ["userId", "groupId"]
    });
    groups.createIndex("by-user", "userId", { unique: false });
    groups.createIndex("by-user-internal-name", ["userId", "internalName"], {
      unique: false
    });
    groups.put(favoriteGroup(USER_A, GROUP_A));

    const transaction = request.transaction;
    if (transaction === null) {
      throw new Error("v2 upgrade transaction is unavailable");
    }
    const runs = transaction.objectStore("syncRuns");
    runs.createIndex(
      "by-retention-owner-started-at",
      ["retentionOwner", "startedAt", "syncId"],
      { unique: false }
    );
    const runRequest = runs.openCursor();
    runRequest.addEventListener("success", () => {
      const cursor = runRequest.result;
      if (cursor === null) {
        return;
      }
      const existing = /** @type {SyncRunRecord} */ (cursor.value);
      cursor.update({ ...existing, retentionOwner: existing.userId ?? ANONYMOUS_RETENTION_OWNER });
      cursor.continue();
    });

    const eventRequest = transaction.objectStore("events").openCursor();
    eventRequest.addEventListener("success", () => {
      const cursor = eventRequest.result;
      if (cursor === null) {
        return;
      }
      cursor.update({
        ...(/** @type {Record<string, unknown>} */ (cursor.value)),
        notificationEligible: true
      });
      cursor.continue();
    });
    transaction.objectStore("meta").put({ key: "schemaVersion", value: 2 });
    transaction.objectStore("meta").put({ key: "backupFormatVersion", value: 2 });
    transaction.objectStore("meta").put({ key: "lastMigration", value: 2 });
  });
  const raw = await requestValue(request);
  raw.close();
}

/**
 * @param {string | null} userId
 * @param {string} syncId
 * @param {number} ordinal
 * @returns {SyncRunRecord}
 */
function failedSyncRun(userId, syncId, ordinal) {
  const startedAt = new Date(Date.parse(AT_1) + ordinal * 60_000).toISOString();
  return {
    syncId,
    userId,
    trigger: "alarm",
    startedAt,
    finishedAt: startedAt,
    result: "failed",
    favoriteCount: 0,
    metadataCount: 0,
    probeCount: 0,
    changeCount: 0,
    retryAt: null
  };
}

test("commitSync stores a profile, worlds, groups, and events atomically", async (context) => {
  const database = await repository(`database-commit-${context.name}`);
  context.after(() => database.close());

  const committedGeneration = await database.commitSync({
    profile: profile(USER_A, "Alice"),
    worlds: [world(USER_A, WORLD_A)],
    favoriteGroups: [
      favoriteGroup(USER_A, GROUP_A, { missingCount: 1 }),
      favoriteGroup(USER_A, GROUP_B, { active: false })
    ],
    events: [event(USER_A, WORLD_A)],
    syncRun: syncRun(USER_A),
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: null }],
    expectedGeneration: 0,
    settings: successSettings(USER_A)
  });

  assert.equal(committedGeneration, 1);
  assert.equal((await database.getSyncSnapshot(USER_A)).generation, 1);
  assert.equal((await database.getProfile(USER_A))?.displayName, "Alice");
  assert.deepEqual(
    (await database.listWorlds(USER_A)).map((record) => record.worldId),
    [WORLD_A]
  );
  assert.deepEqual(
    (await database.listEvents(USER_A)).map((record) => record.eventId),
    [`${USER_A}:${WORLD_A}:1:name_changed`]
  );
  assert.deepEqual(
    (await database.listFavoriteGroups(USER_A)).map((record) => record.groupId),
    [GROUP_A, GROUP_B]
  );
  assert.equal((await database.getSyncSnapshot(USER_A)).favoriteGroups.length, 2);
  assert.equal((await database.listFavoriteGroups(USER_A))[0]?.missingCount, 1);
  await assert.rejects(
    database.commitSync({
      profile: profile(USER_A, "Must not replace missing count"),
      worlds: [world(USER_A, WORLD_A)],
      favoriteGroups: [favoriteGroup(USER_A, GROUP_A, { missingCount: 2 })],
      events: [],
      syncRun: { ...syncRun(USER_A), syncId: "sync-invalid-group-missing-count" },
      expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: 1 }],
      expectedGeneration: 1,
      settings: successSettings(USER_A)
    }),
    /missing count is inconsistent/
  );
  await assert.rejects(
    database.commitSync({
      profile: profile(USER_A, "Must not replace groups"),
      worlds: [world(USER_A, WORLD_A)],
      favoriteGroups: [favoriteGroup(USER_A, GROUP_A), favoriteGroup(USER_A, GROUP_B)],
      events: [],
      syncRun: { ...syncRun(USER_A), syncId: "sync-duplicate-active-groups" },
      expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: 1 }],
      expectedGeneration: 1,
      settings: successSettings(USER_A)
    }),
    /Duplicate active favorite group name/
  );
  assert.equal((await database.listFavoriteGroups(USER_A))[1]?.active, false);
  assert.equal(await database.getSetting("activeProfileId"), USER_A);
  assert.equal(await database.getSetting("backoffUntil"), null);
  assert.equal(await database.getSetting("consecutiveRateLimits"), 0);
  assert.equal(await database.getSetting("lastSyncResult"), "success");

  await database.setSetting("autoSyncEnabled", true);
  assert.equal(await database.getSetting("autoSyncEnabled"), true);
});

test("thumbnail reads are profile-scoped, projected, and batched in caller order", async (context) => {
  const database = await repository(`database-thumbnails-${context.name}`);
  context.after(() => database.close());
  await database.commitSync({
    profile: profile(USER_A),
    worlds: [world(USER_A, WORLD_A), world(USER_A, WORLD_B)],
    favoriteGroups: [],
    events: [],
    syncRun: syncRun(USER_A),
    expectedWorldRevisions: [
      { userId: USER_A, worldId: WORLD_A, revision: null },
      { userId: USER_A, worldId: WORLD_B, revision: null }
    ],
    expectedGeneration: 0,
    settings: successSettings(USER_A)
  });

  const first = thumbnail(USER_A, WORLD_A);
  const second = thumbnail(USER_A, WORLD_B, { capturedAt: AT_1, width: 256, height: 144 });
  await database.putThumbnail(first, 1);
  await database.putThumbnail(second);

  const stored = await database.getThumbnail(USER_A, WORLD_A);
  assert.equal(stored?.blob.type, "image/webp");
  assert.equal(await stored?.blob.text(), await first.blob.text());
  assert.equal(await database.getThumbnail(USER_B, WORLD_A), null);
  assert.deepEqual(
    (await database.getThumbnails(USER_A, [WORLD_B, WORLD_A, WORLD_B, WORLD_C]))
      .map((record) => record.worldId),
    [WORLD_B, WORLD_A]
  );

  const metadata = await database.listThumbnailMetadata(USER_A);
  assert.deepEqual(metadata.map((record) => record.worldId), [WORLD_A, WORLD_B]);
  assert.equal(Object.hasOwn(metadata[0] ?? {}, "blob"), false);
  assert.equal(metadata[0]?.byteLength, first.blob.size);
  assert.deepEqual(await database.listThumbnailMetadata(USER_B), []);

  await assert.rejects(
    database.getThumbnails(
      USER_A,
      Array.from({ length: THUMBNAIL_BATCH_LIMIT + 1 }, (_, index) => `wrld_${index}`)
    ),
    /limited/u
  );
  await assert.rejects(
    database.getThumbnails(USER_A, /** @type {string[]} */ (/** @type {unknown} */ (null))),
    /must be an array/u
  );
  await assert.rejects(database.getThumbnails(USER_A, [" "]), /bounded string/u);
});

test("thumbnail writes validate durable data and retain the previous image on failure", async (context) => {
  const database = await repository(`database-thumbnail-validation-${context.name}`);
  context.after(() => database.close());
  await database.commitSync({
    profile: profile(USER_A),
    worlds: [world(USER_A, WORLD_A)],
    favoriteGroups: [],
    events: [],
    syncRun: syncRun(USER_A),
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: null }],
    expectedGeneration: 0,
    settings: successSettings(USER_A)
  });
  const original = thumbnail(USER_A, WORLD_A);
  await database.putThumbnail(original, 1);

  const oversizedBlob = new Blob(
    [new Uint8Array(THUMBNAIL_MAX_BYTE_LENGTH + 1)],
    { type: "image/webp" }
  );
  const invalidRecords = [
    thumbnail(USER_A, WORLD_A, {
      blob: new Blob(["png"], { type: "image/png" })
    }),
    thumbnail(USER_A, WORLD_A, { byteLength: original.byteLength + 1 }),
    thumbnail(USER_A, WORLD_A, { blob: oversizedBlob }),
    thumbnail(USER_A, WORLD_A, { width: 0 }),
    thumbnail(USER_A, WORLD_A, { width: 321 }),
    thumbnail(USER_A, WORLD_A, { height: 321 }),
    thumbnail(USER_A, WORLD_A, { capturedAt: "not-a-timestamp" }),
    thumbnail(USER_A, WORLD_A, { sourceUrl: "javascript:alert(1)" }),
    thumbnail(USER_A, WORLD_A, { sourceUrl: "https://user:secret@example.com/image.webp" }),
    thumbnail(USER_A, WORLD_A, { sourceUrl: "https://example.com/image.webp" }),
    thumbnail(USER_A, WORLD_A, { sourceUrl: `https://example.com/${"a".repeat(8_192)}` })
  ];
  for (const invalid of invalidRecords) {
    await assert.rejects(database.putThumbnail(invalid, 1));
  }
  await assert.rejects(
    database.putThumbnail(thumbnail(USER_A, WORLD_B), 1),
    /target world is not stored/u
  );

  const afterFailures = await database.getThumbnail(USER_A, WORLD_A);
  assert.equal(await afterFailures?.blob.text(), await original.blob.text());
  assert.equal(afterFailures?.capturedAt, original.capturedAt);
});

test("thumbnail writes snapshot allowed fields before the first asynchronous boundary", async (context) => {
  const database = await repository(`database-thumbnail-snapshot-${context.name}`);
  context.after(() => database.close());
  await database.commitSync({
    profile: profile(USER_A),
    worlds: [world(USER_A, WORLD_A)],
    favoriteGroups: [],
    events: [],
    syncRun: syncRun(USER_A),
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: null }],
    expectedGeneration: 0,
    settings: successSettings(USER_A)
  });

  const originalBlob = new Blob(["immutable-webp"], { type: "image/webp" });
  const candidate = /** @type {ThumbnailRecord & { unexpectedPayload: Blob }} */ ({
    ...thumbnail(USER_A, WORLD_A, { blob: originalBlob, capturedAt: AT_1 }),
    unexpectedPayload: new Blob([new Uint8Array(THUMBNAIL_MAX_BYTE_LENGTH)])
  });
  const write = database.putThumbnail(candidate, 1);
  candidate.userId = USER_B;
  candidate.worldId = WORLD_B;
  candidate.blob = new Blob(
    [new Uint8Array(THUMBNAIL_MAX_BYTE_LENGTH + 1)],
    { type: "image/webp" }
  );
  candidate.byteLength = candidate.blob.size;
  candidate.width = 0;
  candidate.sourceUrl = "javascript:alert(1)";
  await write;

  const stored = await database.getThumbnail(USER_A, WORLD_A);
  assert.equal(await stored?.blob.text(), await originalBlob.text());
  assert.equal(stored?.capturedAt, AT_1);
  assert.equal(stored?.width, 320);
  assert.equal(Object.hasOwn(stored ?? {}, "unexpectedPayload"), false);
  assert.equal(await database.getThumbnail(USER_B, WORLD_B), null);
});

test("thumbnail writes honor generation conflicts and the durable purge guard", async (context) => {
  const database = await repository(`database-thumbnail-conflict-${context.name}`);
  context.after(() => database.close());
  await database.commitSync({
    profile: profile(USER_A),
    worlds: [world(USER_A, WORLD_A)],
    favoriteGroups: [],
    events: [],
    syncRun: syncRun(USER_A),
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: null }],
    expectedGeneration: 0,
    settings: successSettings(USER_A)
  });
  const original = thumbnail(USER_A, WORLD_A);
  await database.putThumbnail(original, 1);
  await database.replaceProfileData({
    profile: profile(USER_A, "Restored"),
    worlds: [world(USER_A, WORLD_A)],
    favoriteGroups: [],
    events: []
  });

  const replacement = thumbnail(USER_A, WORLD_A, { capturedAt: AT_1 });
  await assert.rejects(database.putThumbnail(replacement, 1), GenerationConflictError);
  assert.equal((await database.getThumbnail(USER_A, WORLD_A))?.capturedAt, AT_2);

  assert.equal(await database.beginPurge(), true);
  await assert.rejects(database.putThumbnail(replacement), PurgePendingError);
  assert.equal((await database.getThumbnail(USER_A, WORLD_A))?.capturedAt, AT_2);
});

test("a failed commitSync rolls back every store", async (context) => {
  const database = await repository(`database-rollback-${context.name}`);
  context.after(() => database.close());
  await database.saveProfile(profile(USER_A, "Before"));
  await database.setSetting("activeProfileId", USER_B);

  const invalidWorld = {
    ...world(USER_A, WORLD_A),
    favoriteTags: [() => "cannot be cloned"]
  };
  await assert.rejects(
    database.commitSync({
      profile: profile(USER_A, "Must roll back"),
      worlds: [/** @type {WorldRecord} */ (/** @type {unknown} */ (invalidWorld))],
      favoriteGroups: [],
      events: [event(USER_A, WORLD_A)],
      syncRun: syncRun(USER_A),
      expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: null }],
      expectedGeneration: 1,
      settings: successSettings(USER_A)
    })
  );

  assert.equal((await database.getProfile(USER_A))?.displayName, "Before");
  assert.deepEqual(await database.listWorlds(USER_A), []);
  assert.deepEqual(await database.listEvents(USER_A), []);
  assert.equal(await database.getUnreadCount(USER_A), 0);
  assert.equal(await database.getDataGeneration(USER_A), 1);
  assert.equal(await database.getSetting("activeProfileId"), USER_B);
});

test("a stale world revision aborts the complete sync plan", async (context) => {
  const database = await repository(`database-conflict-${context.name}`);
  context.after(() => database.close());
  await database.commitSync({
    profile: profile(USER_A, "Revision one"),
    worlds: [world(USER_A, WORLD_A, 1)],
    favoriteGroups: [],
    events: [event(USER_A, WORLD_A, 1)],
    syncRun: syncRun(USER_A),
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: null }],
    expectedGeneration: 0,
    settings: successSettings(USER_A)
  });

  const revisionTwoEvent = event(USER_A, WORLD_A, 2);
  await database.commitSync({
    profile: profile(USER_A, "Revision two"),
    worlds: [world(USER_A, WORLD_A, 2)],
    favoriteGroups: [],
    events: [revisionTwoEvent],
    syncRun: { ...syncRun(USER_A), syncId: "sync-revision-two" },
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: 1 }],
    expectedGeneration: 1,
    settings: successSettings(USER_A)
  });

  const uncheckedStalePlan = {
    profile: profile(USER_A, "Unchecked stale profile"),
    worlds: [{ ...world(USER_A, WORLD_A, 2), currentName: "Unchecked stale world" }],
    favoriteGroups: [],
    events: [],
    syncRun: { ...syncRun(USER_A), syncId: "sync-unchecked-stale" },
    expectedGeneration: 2,
    settings: successSettings(USER_A)
  };
  await assert.rejects(
    database.commitSync(
      /** @type {Parameters<DatabaseRepository["commitSync"]>[0]} */ (
        /** @type {unknown} */ (uncheckedStalePlan)
      )
    ),
    /expectedWorldRevisions is required/
  );

  await assert.rejects(
    database.commitSync({
      profile: profile(USER_A, "Stale profile must roll back"),
      worlds: [{ ...world(USER_A, WORLD_A, 2), currentName: "Stale world" }],
      favoriteGroups: [],
      events: [{ ...revisionTwoEvent, after: "Stale name" }],
      syncRun: { ...syncRun(USER_A), syncId: "sync-stale" },
      expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: 1 }],
      expectedGeneration: 2,
      settings: successSettings(USER_A)
    }),
    RevisionConflictError
  );
  assert.equal((await database.getProfile(USER_A))?.displayName, "Revision two");
  assert.notEqual((await database.listWorlds(USER_A))[0]?.currentName, "Stale world");
  assert.notEqual((await database.listEvents(USER_A))[1]?.after, "Stale name");
});

test("generation rejects a same-revision plan after profile replacement", async (context) => {
  const database = await repository(`database-generation-${context.name}`);
  context.after(() => database.close());
  await database.commitSync({
    profile: profile(USER_A, "Original"),
    worlds: [world(USER_A, WORLD_A, 1)],
    favoriteGroups: [],
    events: [event(USER_A, WORLD_A, 1)],
    syncRun: syncRun(USER_A),
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: null }],
    expectedGeneration: 0,
    settings: successSettings(USER_A)
  });
  const staleSnapshot = await database.getSyncSnapshot(USER_A);

  const replacedGeneration = await database.replaceProfileData({
    profile: profile(USER_A, "Restored"),
    worlds: [{ ...world(USER_A, WORLD_A, 1), currentName: "Restored world" }],
    favoriteGroups: [],
    events: [event(USER_A, WORLD_A, 1)]
  });
  assert.equal(replacedGeneration, 2);

  await assert.rejects(
    database.commitSync({
      profile: profile(USER_A, "Stale"),
      worlds: [{ ...world(USER_A, WORLD_A, 1), currentName: "Stale world" }],
      favoriteGroups: [],
      events: [],
      syncRun: { ...syncRun(USER_A), syncId: "sync-generation-stale", changeCount: 0 },
      expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: 1 }],
      expectedGeneration: staleSnapshot.generation,
      settings: successSettings(USER_A)
    }),
    GenerationConflictError
  );
  const current = await database.getSyncSnapshot(USER_A);
  assert.equal(current.generation, 2);
  assert.equal(current.profile?.displayName, "Restored");
  assert.equal(current.worlds[0]?.currentName, "Restored world");

  await database.recordSyncRun({
    ...syncRun(USER_A),
    syncId: "sync-failure-without-generation",
    result: "failed",
    changeCount: 0
  });
  assert.equal(await database.getDataGeneration(USER_A), 2);
});

test("an eventless state transition may advance a checked revision", async (context) => {
  const database = await repository(`database-silent-revision-${context.name}`);
  context.after(() => database.close());
  await database.commitSync({
    profile: profile(USER_A),
    worlds: [world(USER_A, WORLD_A, 0)],
    favoriteGroups: [],
    events: [],
    syncRun: { ...syncRun(USER_A), changeCount: 0 },
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: null }],
    expectedGeneration: 0,
    settings: successSettings(USER_A)
  });

  await database.commitSync({
    profile: profile(USER_A),
    worlds: [
      {
        ...world(USER_A, WORLD_A, 1),
        membershipState: "missing_once",
        membershipMissCount: 1
      }
    ],
    favoriteGroups: [],
    events: [],
    syncRun: { ...syncRun(USER_A), syncId: "sync-silent-revision", changeCount: 0 },
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: 0 }],
    expectedGeneration: 1,
    settings: successSettings(USER_A)
  });

  const [stored] = await database.listWorlds(USER_A);
  assert.equal(stored?.revision, 1);
  assert.equal(stored?.membershipState, "missing_once");
  assert.deepEqual(await database.listEvents(USER_A), []);
});

test("replace and clear affect only the selected profile", async (context) => {
  const database = await repository(`database-profiles-${context.name}`);
  context.after(() => database.close());

  await database.commitSync({
    profile: profile(USER_A, "Alice old"),
    worlds: [world(USER_A, WORLD_A)],
    favoriteGroups: [],
    events: [event(USER_A, WORLD_A)],
    syncRun: syncRun(USER_A),
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: null }],
    expectedGeneration: 0,
    settings: successSettings(USER_A)
  });
  await database.commitSync({
    profile: profile(USER_B, "Bob"),
    worlds: [world(USER_B, WORLD_B)],
    favoriteGroups: [],
    events: [event(USER_B, WORLD_B)],
    syncRun: syncRun(USER_B),
    expectedWorldRevisions: [{ userId: USER_B, worldId: WORLD_B, revision: null }],
    expectedGeneration: 0,
    settings: successSettings(USER_B)
  });
  await database.putThumbnail(thumbnail(USER_A, WORLD_A), 1);
  await database.putThumbnail(thumbnail(USER_B, WORLD_B), 1);

  const replacementGeneration = await database.replaceProfileData({
    profile: profile(USER_A, "Alice restored"),
    worlds: [],
    favoriteGroups: [],
    events: [],
    preferences: { notificationsEnabled: false }
  });
  assert.equal(replacementGeneration, 2);

  assert.equal((await database.getProfile(USER_A))?.displayName, "Alice restored");
  assert.deepEqual(await database.listWorlds(USER_A), []);
  assert.equal((await database.getProfile(USER_B))?.displayName, "Bob");
  assert.deepEqual(
    (await database.listWorlds(USER_B)).map((record) => record.worldId),
    [WORLD_B]
  );
  assert.equal(await database.getSetting("notificationsEnabled"), false);
  assert.equal((await database.getThumbnail(USER_A, WORLD_A))?.worldId, WORLD_A);
  assert.equal((await database.getThumbnail(USER_B, WORLD_B))?.worldId, WORLD_B);

  const clearedGeneration = await database.clearProfile(USER_A);
  assert.equal(clearedGeneration, 3);
  assert.equal(await database.getDataGeneration(USER_A), 3);
  assert.equal(await database.getProfile(USER_A), null);
  assert.equal((await database.getProfile(USER_B))?.displayName, "Bob");
  assert.equal((await database.listEvents(USER_B)).length, 1);
  assert.equal(await database.getThumbnail(USER_A, WORLD_A), null);
  assert.equal((await database.getThumbnail(USER_B, WORLD_B))?.worldId, WORLD_B);
  assert.equal(await database.getDataGeneration(USER_B), 1);
});

test("setSettings commits all values or rolls every value back", async (context) => {
  const database = await repository(`database-settings-${context.name}`);
  context.after(() => database.close());
  await database.setSettings({
    autoSyncEnabled: true,
    notificationsEnabled: true,
    watchdogUntil: null
  });

  await assert.rejects(
    database.setSettings({
      autoSyncEnabled: false,
      watchdogUntil: () => "not cloneable"
    })
  );
  assert.equal(await database.getSetting("autoSyncEnabled"), true);
  assert.equal(await database.getSetting("notificationsEnabled"), true);
  assert.equal(await database.getSetting("watchdogUntil"), null);
});

test("notification claims are permanent and result updates require a claim", async (context) => {
  const database = await repository(`database-claims-${context.name}`);
  context.after(() => database.close());
  const historyEvent = event(USER_A, WORLD_A);
  await database.commitSync({
    profile: profile(USER_A),
    worlds: [world(USER_A, WORLD_A)],
    favoriteGroups: [],
    events: [historyEvent],
    syncRun: syncRun(USER_A),
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: null }],
    expectedGeneration: 0,
    settings: successSettings(USER_A)
  });

  const firstClaim = await database.claimEvents(USER_A, AT_2, undefined, {
    expectedGeneration: 1
  });
  const secondClaim = await database.claimEvents(
    USER_A,
    "2026-08-19T00:00:00.000Z",
    undefined,
    { expectedGeneration: 1 }
  );
  assert.equal(firstClaim.length, 1);
  assert.deepEqual(secondClaim, []);

  await database.updateNotificationResult([historyEvent.eventId], {
    notifiedAt: null,
    notificationError: "permission_denied"
  }, { expectedGeneration: 1 });
  const [stored] = await database.listEvents(USER_A);
  assert.equal(stored?.notificationClaimedAt, AT_2);
  assert.equal(stored?.notificationError, "permission_denied");

  await database.replaceProfileData({
    profile: profile(USER_A),
    worlds: [world(USER_A, WORLD_A)],
    favoriteGroups: [],
    events: [historyEvent]
  });
  await assert.rejects(
    database.claimEvents(USER_A, "2026-08-20T00:00:00.000Z", undefined, {
      expectedGeneration: 1
    }),
    GenerationConflictError
  );
  assert.equal((await database.listEvents(USER_A))[0]?.notificationClaimedAt, null);
  const replacementClaim = await database.claimEvents(USER_A, AT_1, undefined, {
    expectedGeneration: 2
  });
  assert.equal(replacementClaim.length, 1);
  await database.replaceProfileData({
    profile: profile(USER_A),
    worlds: [world(USER_A, WORLD_A)],
    favoriteGroups: [],
    events: replacementClaim
  });
  await assert.rejects(
    database.updateNotificationResult(
      [historyEvent.eventId],
      { notifiedAt: AT_2, notificationError: null },
      { expectedGeneration: 2 }
    ),
    GenerationConflictError
  );
  assert.equal((await database.listEvents(USER_A))[0]?.notifiedAt, null);
});

test("notification claims use an event-kind allowlist before mutating the outbox", async (context) => {
  const database = await repository(`database-claim-kinds-${context.name}`);
  context.after(() => database.close());
  const nameEvent = event(USER_A, WORLD_A);
  const groupEvent = {
    ...event(USER_A, WORLD_A, 2),
    kind: /** @type {const} */ ("favorite_group_changed"),
    notificationEligible: false,
    before: "[\"worlds1\"]",
    after: "[\"worlds2\"]"
  };
  await database.commitSync({
    profile: profile(USER_A),
    worlds: [world(USER_A, WORLD_A)],
    favoriteGroups: [],
    events: [nameEvent, groupEvent],
    syncRun: { ...syncRun(USER_A), changeCount: 2 },
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: null }],
    expectedGeneration: 0,
    settings: successSettings(USER_A)
  });

  const claimed = await database.claimEvents(USER_A, AT_1, undefined, {
    expectedGeneration: 1,
    allowedKinds: ["name_changed", "favorite_group_changed"]
  });
  assert.deepEqual(claimed.map((candidate) => candidate.eventId), [nameEvent.eventId]);
  const stored = await database.listEvents(USER_A);
  assert.notEqual(
    stored.find((candidate) => candidate.kind === "name_changed")?.notificationClaimedAt,
    null
  );
  assert.equal(
    stored.find((candidate) => candidate.kind === "name_changed")?.notificationClaimedAt,
    AT_2
  );
  assert.equal(
    stored.find((candidate) => candidate.kind === "favorite_group_changed")
      ?.notificationClaimedAt,
    null
  );

  await assert.rejects(database.updateNotificationResult([nameEvent.eventId], {
    notifiedAt: AT_2,
    notificationError: "unavailable"
  }, { expectedGeneration: 1 }), /mutually exclusive/u);
  const unsafeResult = /** @type {Parameters<DatabaseRepository["updateNotificationResult"]>[1]} */ (
    /** @type {unknown} */ ({ notifiedAt: null, notificationError: "raw-provider-message" })
  );
  await assert.rejects(
    database.updateNotificationResult([nameEvent.eventId], unsafeResult, {
      expectedGeneration: 1
    }),
    /fixed error code/u
  );
  const unchangedAfterInvalidResults = (await database.listEvents(USER_A))
    .find((candidate) => candidate.kind === "name_changed");
  assert.equal(unchangedAfterInvalidResults?.notifiedAt, null);
  assert.equal(unchangedAfterInvalidResults?.notificationError, null);

  await database.updateNotificationResult([nameEvent.eventId], {
    notifiedAt: AT_1,
    notificationError: null
  }, { expectedGeneration: 1 });
  assert.equal(
    (await database.listEvents(USER_A))
      .find((candidate) => candidate.kind === "name_changed")?.notifiedAt,
    AT_2
  );

  await assert.rejects(database.replaceProfileData({
    profile: profile(USER_A),
    worlds: [world(USER_A, WORLD_A)],
    favoriteGroups: [],
    events: [{ ...groupEvent, notificationEligible: true }]
  }), /notification eligibility/u);
});

test("sync commits reject notification eligibility inconsistent with event kind", async (context) => {
  const database = await repository(`database-event-eligibility-${context.name}`);
  context.after(() => database.close());
  const invalidEvent = { ...event(USER_A, WORLD_A), notificationEligible: false };

  await assert.rejects(database.commitSync({
    profile: profile(USER_A),
    worlds: [world(USER_A, WORLD_A)],
    favoriteGroups: [],
    events: [invalidEvent],
    syncRun: syncRun(USER_A),
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: null }],
    expectedGeneration: 0,
    settings: successSettings(USER_A)
  }), /notification eligibility/u);
  assert.equal(await database.getProfile(USER_A), null);
});

test("v1 databases migrate in place without losing records", async (context) => {
  const name = `database-migration-${context.name}`;
  const factory = new IDBFactory();
  await createV1Database(factory, name);
  const database = new DatabaseRepository({ factory, name });
  await database.open();
  context.after(() => database.close());

  assert.equal((await database.getProfile(USER_A))?.displayName, "v1 Alice");
  assert.deepEqual((await database.listWorlds(USER_A)).map((record) => record.worldId), [WORLD_A]);
  const migratedEvents = await database.listEvents(USER_A);
  assert.equal(migratedEvents.length, 1);
  assert.equal(migratedEvents[0]?.notificationEligible, true);
  assert.deepEqual(await database.listFavoriteGroups(USER_A), []);
  assert.equal((await database.getSyncSnapshot(USER_A)).generation, 0);

  const stores = await readAllStores(factory, name);
  assert.equal(stores.favoriteGroups?.length, 0);
  assert.deepEqual(stores.thumbnails, []);
  assert.equal(
    (/** @type {Array<{ retentionOwner?: string }>} */ (stores.syncRuns))[0]?.retentionOwner,
    USER_A
  );
  assert.deepEqual(
    (/** @type {Array<{ key: string, value: unknown }>} */ (stores.meta))
      .sort((left, right) => left.key.localeCompare(right.key)),
    [
      { key: "backupFormatVersion", value: 2 },
      { key: "lastMigration", value: DATABASE_VERSION },
      { key: "schemaVersion", value: DATABASE_VERSION }
    ]
  );

  const raw = await openRawDatabase(factory, name);
  try {
    const transaction = raw.transaction([STORES.syncRuns, STORES.thumbnails], "readonly");
    assert.equal(
      transaction.objectStore(STORES.syncRuns).indexNames.contains(
        "by-retention-owner-started-at"
      ),
      true
    );
    const thumbnailStore = transaction.objectStore(STORES.thumbnails);
    assert.deepEqual(thumbnailStore.keyPath, ["userId", "worldId"]);
    assert.equal(thumbnailStore.indexNames.contains("by-user"), true);
    await transactionDone(transaction);
  } finally {
    raw.close();
  }
});

test("v2 databases add the thumbnail store without rewriting existing data", async (context) => {
  const name = `database-v2-migration-${context.name}`;
  const factory = new IDBFactory();
  await createV2Database(factory, name);
  const database = new DatabaseRepository({ factory, name });
  await database.open();
  context.after(() => database.close());

  assert.equal((await database.getProfile(USER_A))?.displayName, "v1 Alice");
  assert.deepEqual((await database.listWorlds(USER_A)).map((record) => record.worldId), [WORLD_A]);
  assert.deepEqual(
    (await database.listFavoriteGroups(USER_A)).map((record) => record.groupId),
    [GROUP_A]
  );
  assert.equal((await database.listEvents(USER_A)).length, 1);
  assert.deepEqual(await database.listThumbnailMetadata(USER_A), []);

  const stores = await readAllStores(factory, name);
  assert.deepEqual(stores.thumbnails, []);
  assert.equal((/** @type {unknown[]} */ (stores.profiles)).length, 1);
  assert.equal((/** @type {unknown[]} */ (stores.worlds)).length, 1);
  assert.equal((/** @type {unknown[]} */ (stores.favoriteGroups)).length, 1);
  assert.deepEqual(
    (/** @type {Array<{ key: string, value: unknown }>} */ (stores.meta))
      .sort((left, right) => left.key.localeCompare(right.key)),
    [
      { key: "backupFormatVersion", value: 2 },
      { key: "lastMigration", value: DATABASE_VERSION },
      { key: "schemaVersion", value: DATABASE_VERSION }
    ]
  );
});

test("sync run retention is independent per profile and bounded for anonymous failures", async (context) => {
  const name = `database-retention-${context.name}`;
  const factory = new IDBFactory();
  const database = new DatabaseRepository({ factory, name });
  await database.open();
  context.after(() => database.close());

  for (let ordinal = 0; ordinal <= SYNC_RUN_RETENTION_PER_PROFILE; ordinal += 1) {
    await database.recordSyncRun(
      failedSyncRun(USER_A, `profile-a-${String(ordinal).padStart(3, "0")}`, ordinal)
    );
    await database.recordSyncRun(
      failedSyncRun(USER_B, `profile-b-${String(ordinal).padStart(3, "0")}`, ordinal)
    );
  }
  for (let ordinal = 0; ordinal <= SYNC_RUN_RETENTION_ANONYMOUS; ordinal += 1) {
    await database.recordSyncRun(
      failedSyncRun(null, `anonymous-${String(ordinal).padStart(3, "0")}`, ordinal)
    );
  }

  const stores = await readAllStores(factory, name);
  const runs = /** @type {Array<SyncRunRecord & { retentionOwner: string }>} */ (
    stores.syncRuns
  );
  const userARuns = runs.filter((run) => run.retentionOwner === USER_A);
  const userBRuns = runs.filter((run) => run.retentionOwner === USER_B);
  const anonymousRuns = runs.filter(
    (run) => run.retentionOwner === ANONYMOUS_RETENTION_OWNER
  );
  assert.equal(userARuns.length, SYNC_RUN_RETENTION_PER_PROFILE);
  assert.equal(userBRuns.length, SYNC_RUN_RETENTION_PER_PROFILE);
  assert.equal(anonymousRuns.length, SYNC_RUN_RETENTION_ANONYMOUS);
  assert.equal(userARuns.some((run) => run.syncId === "profile-a-000"), false);
  assert.equal(userBRuns.some((run) => run.syncId === "profile-b-000"), false);
  assert.equal(anonymousRuns.some((run) => run.syncId === "anonymous-000"), false);
  await assert.rejects(
    database.recordSyncRun({
      ...failedSyncRun(USER_A, "noncanonical-retention-time", 0),
      startedAt: "2026-08-17T00:00:00Z"
    }),
    /retention fields are invalid/
  );
});

test("unread counts are atomic, idempotent, and reset by restore and clear", async (context) => {
  const database = await repository(`database-unread-${context.name}`);
  context.after(() => database.close());
  const historyEvent = event(USER_A, WORLD_A, 1);
  await database.commitSync({
    profile: profile(USER_A),
    worlds: [world(USER_A, WORLD_A, 1)],
    favoriteGroups: [],
    events: [historyEvent],
    syncRun: syncRun(USER_A),
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: null }],
    expectedGeneration: 0,
    settings: successSettings(USER_A)
  });
  assert.equal(await database.getUnreadCount(USER_A), 1);

  await database.markEventsRead(USER_A);
  assert.equal(await database.getUnreadCount(USER_A), 0);
  await database.commitSync({
    profile: profile(USER_A),
    worlds: [world(USER_A, WORLD_A, 1)],
    favoriteGroups: [],
    events: [historyEvent],
    syncRun: { ...syncRun(USER_A), syncId: "sync-idempotent-replay" },
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: 1 }],
    expectedGeneration: 1,
    settings: successSettings(USER_A)
  });
  assert.equal(await database.getUnreadCount(USER_A), 0);
  assert.equal((await database.listEvents(USER_A)).length, 1);

  const secondEvent = event(USER_A, WORLD_A, 2);
  await database.commitSync({
    profile: profile(USER_A),
    worlds: [world(USER_A, WORLD_A, 2)],
    favoriteGroups: [],
    events: [secondEvent],
    syncRun: { ...syncRun(USER_A), syncId: "sync-second-event" },
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: 1 }],
    expectedGeneration: 2,
    settings: successSettings(USER_A)
  });
  assert.equal(await database.getUnreadCount(USER_A), 1);

  await database.replaceProfileData({
    profile: profile(USER_A),
    worlds: [world(USER_A, WORLD_A, 2)],
    favoriteGroups: [],
    events: [historyEvent, secondEvent]
  });
  assert.equal(await database.getUnreadCount(USER_A), 0);
  await database.clearProfile(USER_A);
  assert.equal(await database.getUnreadCount(USER_A), 0);
});

test("getProfileStats counts worlds, events, and pending probes without double counting", async (context) => {
  const database = await repository(`database-stats-${context.name}`);
  context.after(() => database.close());
  const worlds = [
    { ...world(USER_A, WORLD_A), probeState: /** @type {const} */ ("pending") },
    {
      ...world(USER_A, WORLD_B),
      availabilityState: /** @type {const} */ ("unavailable_once"),
      unavailableCount: /** @type {const} */ (1)
    },
    {
      ...world(USER_A, WORLD_C),
      probeState: /** @type {const} */ ("pending"),
      availabilityState: /** @type {const} */ ("unavailable_once"),
      unavailableCount: /** @type {const} */ (1)
    },
    {
      ...world(USER_A, WORLD_D),
      membershipState: /** @type {const} */ ("not_in_favorites"),
      membershipMissCount: /** @type {const} */ (2),
      availabilityState: /** @type {const} */ ("unavailable"),
      unavailableCount: /** @type {const} */ (2)
    }
  ];
  await database.commitSync({
    profile: profile(USER_A),
    worlds,
    favoriteGroups: [],
    events: [event(USER_A, WORLD_A), event(USER_A, WORLD_B)],
    syncRun: syncRun(USER_A),
    expectedWorldRevisions: worlds.map((record) => ({
      userId: USER_A,
      worldId: record.worldId,
      revision: null
    })),
    expectedGeneration: 0,
    settings: successSettings(USER_A)
  });

  assert.deepEqual(await database.getProfileStats(USER_A), {
    worldCount: 4,
    eventCount: 2,
    pendingProbeCount: 3,
    attentionWorldCount: 1,
    missingCount: 1,
    unavailableCount: 1
  });
  assert.deepEqual(await database.getProfileStats(USER_B), {
    worldCount: 0,
    eventCount: 0,
    pendingProbeCount: 0,
    attentionWorldCount: 0,
    missingCount: 0,
    unavailableCount: 0
  });
});

test("beginPurge atomically distinguishes a new guard from a resumed purge", async (context) => {
  const name = `database-begin-purge-${context.name}`;
  const factory = new IDBFactory();
  const first = new DatabaseRepository({ factory, name });
  const second = new DatabaseRepository({ factory, name });
  await Promise.all([first.open(), second.open()]);
  context.after(() => {
    first.close();
    second.close();
  });

  const results = await Promise.all([first.beginPurge(), second.beginPurge()]);
  assert.equal(results.filter((result) => result).length, 1);
  assert.equal(results.filter((result) => !result).length, 1);
  assert.equal(await first.getSetting("purgePending"), true);
  await assert.rejects(first.setSetting("purgePending", false), PurgePendingError);

  await second.recoverFromFailedPurge();
  assert.equal(await first.getSetting("purgePending"), false);
  assert.equal(await first.beginPurge(), true);
  assert.equal(await second.beginPurge(), false);
});

test("purgeAllData atomically leaves only the purge guard and schema metadata", async (context) => {
  const name = `database-purge-${context.name}`;
  const factory = new IDBFactory();
  const database = new DatabaseRepository({ factory, name });
  await database.open();
  context.after(() => database.close());
  await database.commitSync({
    profile: profile(USER_A),
    worlds: [world(USER_A, WORLD_A)],
    favoriteGroups: [favoriteGroup(USER_A, GROUP_A)],
    events: [event(USER_A, WORLD_A)],
    syncRun: syncRun(USER_A),
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: null }],
    expectedGeneration: 0,
    settings: successSettings(USER_A)
  });
  await database.putThumbnail(thumbnail(USER_A, WORLD_A), 1);
  await database.recordSyncRun(failedSyncRun(null, "anonymous-before-purge", 0));
  await database.setSettings({
    autoSyncEnabled: true,
    notificationsEnabled: true,
    lastBackupAt: Date.parse(AT_2)
  });
  assert.equal(await database.beginPurge(), true);

  await database.purgeAllData();

  assert.deepEqual(await database.listProfiles(), []);
  assert.deepEqual(await database.listWorlds(USER_A), []);
  assert.deepEqual(await database.listThumbnailMetadata(USER_A), []);
  assert.deepEqual(await database.listFavoriteGroups(USER_A), []);
  assert.deepEqual(await database.listEvents(USER_A), []);
  assert.equal(await database.getUnreadCount(USER_A), 0);
  assert.equal(await database.getDataGeneration(USER_A), 0);
  assert.equal(await database.getSetting("autoSyncEnabled"), undefined);
  assert.equal(await database.getSetting("purgePending"), true);

  const stores = await readAllStores(factory, name);
  for (const storeName of [
    "profiles",
    "worlds",
    "thumbnails",
    "favoriteGroups",
    "events",
    "syncRuns"
  ]) {
    assert.deepEqual(stores[storeName], []);
  }
  assert.deepEqual(stores.settings, [{ key: "purgePending", value: true }]);
  assert.deepEqual(
    (/** @type {Array<{ key: string, value: unknown }>} */ (stores.meta))
      .sort((left, right) => left.key.localeCompare(right.key)),
    [
      { key: "backupFormatVersion", value: 2 },
      { key: "lastMigration", value: DATABASE_VERSION },
      { key: "schemaVersion", value: DATABASE_VERSION }
    ]
  );
});

test("purgeAllData aborts without partial deletion when a store operation fails", async (context) => {
  const database = await repository(`database-purge-abort-${context.name}`);
  context.after(() => database.close());
  await database.commitSync({
    profile: profile(USER_A, "Before failed purge"),
    worlds: [world(USER_A, WORLD_A)],
    favoriteGroups: [favoriteGroup(USER_A, GROUP_A)],
    events: [event(USER_A, WORLD_A)],
    syncRun: syncRun(USER_A),
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: null }],
    expectedGeneration: 0,
    settings: successSettings(USER_A)
  });
  await database.putThumbnail(thumbnail(USER_A, WORLD_A), 1);
  assert.equal(await database.beginPurge(), true);

  const originalClear = IDBObjectStore.prototype.clear;
  IDBObjectStore.prototype.clear = function clearWithInjectedFailure() {
    if (this.name === STORES.events) {
      throw new Error("injected purge failure");
    }
    return originalClear.call(this);
  };
  try {
    await assert.rejects(database.purgeAllData());
  } finally {
    IDBObjectStore.prototype.clear = originalClear;
  }

  assert.equal((await database.getProfile(USER_A))?.displayName, "Before failed purge");
  assert.equal((await database.listWorlds(USER_A)).length, 1);
  assert.equal((await database.listThumbnailMetadata(USER_A)).length, 1);
  assert.equal((await database.listFavoriteGroups(USER_A)).length, 1);
  assert.equal((await database.listEvents(USER_A)).length, 1);
  assert.equal(await database.getUnreadCount(USER_A), 1);
  assert.equal(await database.getSetting("purgePending"), true);
});

test("a durable purge guard blocks every repository write from another connection", async (context) => {
  const name = `database-purge-guard-${context.name}`;
  const factory = new IDBFactory();
  const primary = new DatabaseRepository({ factory, name });
  const staleDashboard = new DatabaseRepository({ factory, name });
  await Promise.all([primary.open(), staleDashboard.open()]);
  context.after(() => {
    primary.close();
    staleDashboard.close();
  });
  const historyEvent = event(USER_A, WORLD_A);
  await primary.commitSync({
    profile: profile(USER_A, "Before guard"),
    worlds: [world(USER_A, WORLD_A)],
    favoriteGroups: [favoriteGroup(USER_A, GROUP_A)],
    events: [historyEvent],
    syncRun: syncRun(USER_A),
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: null }],
    expectedGeneration: 0,
    settings: successSettings(USER_A)
  });
  await primary.claimEvents(USER_A, AT_2, undefined, { expectedGeneration: 1 });
  assert.equal(await primary.beginPurge(), true);

  const replacement = {
    profile: profile(USER_A, "Must not restore"),
    worlds: [world(USER_A, WORLD_A)],
    favoriteGroups: [favoriteGroup(USER_A, GROUP_A)],
    events: [historyEvent]
  };
  const blockedWrites = [
    () => staleDashboard.saveProfile(profile(USER_B)),
    () => staleDashboard.replaceProfileData(replacement),
    () => staleDashboard.clearProfile(USER_A),
    () => staleDashboard.markEventsRead(USER_A),
    () => staleDashboard.recordSyncRun(failedSyncRun(USER_A, "blocked-sync-run", 1)),
    () => staleDashboard.claimEvents(USER_A, AT_2, undefined, { expectedGeneration: 1 }),
    () => staleDashboard.updateNotificationResult(
      [historyEvent.eventId],
      { notifiedAt: AT_2, notificationError: null },
      { expectedGeneration: 1 }
    ),
    () => staleDashboard.setSetting("lastBackupAt", Date.parse(AT_2)),
    () => staleDashboard.commitSync({
      profile: profile(USER_A, "Must not sync"),
      worlds: [world(USER_A, WORLD_A)],
      favoriteGroups: [favoriteGroup(USER_A, GROUP_A)],
      events: [],
      syncRun: { ...syncRun(USER_A), syncId: "blocked-success-run" },
      expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: 1 }],
      expectedGeneration: 1,
      settings: successSettings(USER_A)
    })
  ];
  for (const startBlockedWrite of blockedWrites) {
    await assert.rejects(startBlockedWrite(), PurgePendingError);
  }

  assert.equal((await primary.getProfile(USER_A))?.displayName, "Before guard");
  assert.equal(await primary.getProfile(USER_B), null);
  assert.equal((await primary.listWorlds(USER_A)).length, 1);
  assert.equal((await primary.listFavoriteGroups(USER_A)).length, 1);
  assert.equal((await primary.listEvents(USER_A)).length, 1);
  assert.equal(await primary.getDataGeneration(USER_A), 1);
  assert.equal(await primary.getUnreadCount(USER_A), 1);
  assert.equal(await primary.getSetting("purgePending"), true);

  await assert.rejects(
    staleDashboard.setSetting("purgePending", false),
    PurgePendingError
  );
  assert.equal(await primary.getSetting("purgePending"), true);
  await primary.recoverFromFailedPurge();
  await staleDashboard.setSetting("lastBackupAt", Date.parse(AT_2));
  assert.equal(await primary.getSetting("purgePending"), false);
  await assert.rejects(
    primary.recoverFromFailedPurge(),
    /requires an active purge guard/
  );
});

test("a restore started before the guard commits first and is then erased by purge", async (context) => {
  const name = `database-purge-race-${context.name}`;
  const factory = new IDBFactory();
  const primary = new DatabaseRepository({ factory, name });
  const dashboard = new DatabaseRepository({ factory, name });
  await Promise.all([primary.open(), dashboard.open()]);
  context.after(() => {
    primary.close();
    dashboard.close();
  });
  await primary.commitSync({
    profile: profile(USER_A, "Before race"),
    worlds: [world(USER_A, WORLD_A)],
    favoriteGroups: [],
    events: [event(USER_A, WORLD_A)],
    syncRun: syncRun(USER_A),
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: null }],
    expectedGeneration: 0,
    settings: successSettings(USER_A)
  });

  const restore = dashboard.replaceProfileData({
    profile: profile(USER_A, "Restore won before guard"),
    worlds: [world(USER_A, WORLD_A)],
    favoriteGroups: [favoriteGroup(USER_A, GROUP_A)],
    events: []
  });
  const enableGuard = primary.beginPurge();
  const [, guardEnabled] = await Promise.all([restore, enableGuard]);
  assert.equal(guardEnabled, true);
  assert.equal((await primary.getProfile(USER_A))?.displayName, "Restore won before guard");
  assert.equal(await primary.getSetting("purgePending"), true);

  await primary.purgeAllData();
  assert.deepEqual(await dashboard.listProfiles(), []);
  assert.deepEqual(await dashboard.listWorlds(USER_A), []);
  assert.deepEqual(await dashboard.listFavoriteGroups(USER_A), []);
  assert.deepEqual(await dashboard.listEvents(USER_A), []);
  assert.equal(await dashboard.getUnreadCount(USER_A), 0);
  assert.equal(await dashboard.getDataGeneration(USER_A), 0);
  assert.equal(await dashboard.getSetting("purgePending"), true);
});

test("thumbnail checkpoints validate bounded data and atomically reject stale profiles, generations, and purge", async (context) => {
  const database = await repository(`thumbnail-checkpoint-${context.name}`);
  context.after(() => database.close());
  await database.setSetting("activeProfileId", USER_A);
  const job = {version: 1, userId: USER_A, generation: 0, capturedAt: AT_1,
    items: [{id: WORLD_A, thumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256", attempts: 0}],
    nextAttemptAt: null, state: "waiting"};
  await database.setThumbnailSettings(USER_A, 0, {thumbnailJob: job});
  await assert.rejects(database.setThumbnailSettings(USER_A, 1, {thumbnailJob: job}), GenerationConflictError);
  await assert.rejects(database.setSetting("thumbnailJob", {...job, token: "synthetic-not-a-secret"}), /Invalid thumbnail job/);
  await assert.rejects(database.setSetting("thumbnailJob", {...job, items: Array(10_001).fill(job.items[0])}), /Invalid thumbnail job/);
  await assert.rejects(database.setSetting("thumbnailJob", {...job, items: [{...job.items[0], thumbnailImageUrl: "https://example.com/image?signature=synthetic"}]}), /Invalid thumbnail job/);
  assert.deepEqual(await database.getSetting("thumbnailJob"), job);
  await database.setSetting("activeProfileId", USER_B);
  await assert.rejects(database.setThumbnailSettings(USER_A, 0, {thumbnailJob: job}), GenerationConflictError);
  await database.beginPurge();
  await assert.rejects(database.setThumbnailSettings(USER_A, 0, {thumbnailJob: job}), PurgePendingError);
});
