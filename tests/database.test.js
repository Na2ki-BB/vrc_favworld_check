// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { IDBFactory } from "fake-indexeddb";

import {
  DatabaseRepository,
  GenerationConflictError,
  RevisionConflictError
} from "../extension/lib/database.js";

/** @typedef {Awaited<ReturnType<DatabaseRepository["listWorlds"]>>[number]} WorldRecord */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listEvents"]>>[number]} HistoryEvent */
/** @typedef {Parameters<DatabaseRepository["commitSync"]>[0]["syncRun"]} SyncRunRecord */

const USER_A = "usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "usr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORLD_A = "wrld_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORLD_B = "wrld_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AT_1 = "2026-08-17T00:00:00.000Z";
const AT_2 = "2026-08-18T00:00:00.000Z";

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
    notificationClaimedAt: null,
    notifiedAt: null,
    notificationError: null
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
    lastSyncResult: "success"
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

test("commitSync stores a profile, worlds, and events atomically", async (context) => {
  const database = await repository(`database-commit-${context.name}`);
  context.after(() => database.close());

  const committedGeneration = await database.commitSync({
    profile: profile(USER_A, "Alice"),
    worlds: [world(USER_A, WORLD_A)],
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
  assert.equal(await database.getSetting("activeProfileId"), USER_A);
  assert.equal(await database.getSetting("backoffUntil"), null);
  assert.equal(await database.getSetting("consecutiveRateLimits"), 0);
  assert.equal(await database.getSetting("lastSyncResult"), "success");

  await database.setSetting("autoSyncEnabled", true);
  assert.equal(await database.getSetting("autoSyncEnabled"), true);
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
  assert.equal(await database.getDataGeneration(USER_A), 1);
  assert.equal(await database.getSetting("activeProfileId"), USER_B);
});

test("a stale world revision aborts the complete sync plan", async (context) => {
  const database = await repository(`database-conflict-${context.name}`);
  context.after(() => database.close());
  await database.commitSync({
    profile: profile(USER_A, "Revision one"),
    worlds: [world(USER_A, WORLD_A, 1)],
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
    events: [revisionTwoEvent],
    syncRun: { ...syncRun(USER_A), syncId: "sync-revision-two" },
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: 1 }],
    expectedGeneration: 1,
    settings: successSettings(USER_A)
  });

  const uncheckedStalePlan = {
    profile: profile(USER_A, "Unchecked stale profile"),
    worlds: [{ ...world(USER_A, WORLD_A, 2), currentName: "Unchecked stale world" }],
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
    events: [event(USER_A, WORLD_A, 1)]
  });
  assert.equal(replacedGeneration, 2);

  await assert.rejects(
    database.commitSync({
      profile: profile(USER_A, "Stale"),
      worlds: [{ ...world(USER_A, WORLD_A, 1), currentName: "Stale world" }],
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
    events: [event(USER_A, WORLD_A)],
    syncRun: syncRun(USER_A),
    expectedWorldRevisions: [{ userId: USER_A, worldId: WORLD_A, revision: null }],
    expectedGeneration: 0,
    settings: successSettings(USER_A)
  });
  await database.commitSync({
    profile: profile(USER_B, "Bob"),
    worlds: [world(USER_B, WORLD_B)],
    events: [event(USER_B, WORLD_B)],
    syncRun: syncRun(USER_B),
    expectedWorldRevisions: [{ userId: USER_B, worldId: WORLD_B, revision: null }],
    expectedGeneration: 0,
    settings: successSettings(USER_B)
  });

  const replacementGeneration = await database.replaceProfileData({
    profile: profile(USER_A, "Alice restored"),
    worlds: [],
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

  const clearedGeneration = await database.clearProfile(USER_A);
  assert.equal(clearedGeneration, 3);
  assert.equal(await database.getDataGeneration(USER_A), 3);
  assert.equal(await database.getProfile(USER_A), null);
  assert.equal((await database.getProfile(USER_B))?.displayName, "Bob");
  assert.equal((await database.listEvents(USER_B)).length, 1);
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
