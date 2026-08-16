// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { IDBFactory } from "fake-indexeddb";

import {
  BACKUP_VERSION,
  MAX_BACKUP_BYTES,
  MAX_BACKUP_WORLDS,
  backupSummary,
  createBackup,
  restoreBackup,
  validateBackup
} from "../extension/lib/backup.js";
import { DatabaseRepository } from "../extension/lib/database.js";

/** @typedef {Awaited<ReturnType<DatabaseRepository["listWorlds"]>>[number]} WorldRecord */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listEvents"]>>[number]} HistoryEvent */

const USER_A = "usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "usr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORLD_A = "wrld_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORLD_B = "wrld_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AT_1 = "2026-08-17T00:00:00.000Z";
const AT_2 = "2026-08-18T00:00:00.000Z";
const RESTORED_AT = "2026-08-20T00:00:00.000Z";

/**
 * @param {string} userId
 * @param {string} displayName
 * @returns {Parameters<DatabaseRepository["saveProfile"]>[0]}
 */
function profile(userId, displayName) {
  return {
    userId,
    displayName,
    firstSeenAt: AT_1,
    lastSuccessfulSyncAt: AT_2,
    createdBySchemaVersion: 1
  };
}

/**
 * @param {string} userId
 * @param {string} worldId
 * @param {string} name
 * @returns {WorldRecord}
 */
function world(userId, worldId, name) {
  return {
    userId,
    worldId,
    currentName: name,
    normalizedName: name.toLocaleLowerCase("ja-JP"),
    authorName: "作者",
    normalizedAuthorName: "作者",
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
    revision: 1,
    updatedAt: AT_2
  };
}

/**
 * @param {string} userId
 * @param {string} worldId
 * @returns {HistoryEvent}
 */
function event(userId, worldId) {
  return {
    eventId: `${userId}:${worldId}:1:name_changed`,
    userId,
    worldId,
    kind: "name_changed",
    observedAt: AT_2,
    before: "以前の名前",
    after: "現在の名前",
    evidence: { source: "bulk", httpStatus: 200 },
    syncId: `sync-${userId}`,
    notificationClaimedAt: null,
    notifiedAt: null,
    notificationError: null
  };
}

/**
 * @param {string} name
 */
async function repository(name) {
  const database = new DatabaseRepository({ factory: new IDBFactory(), name });
  await database.open();
  return database;
}

/**
 * @param {DatabaseRepository} database
 * @param {string} userId
 * @param {string} worldId
 * @param {string} displayName
 * @param {string} worldName
 */
async function seed(database, userId, worldId, displayName, worldName) {
  await database.commitSync({
    profile: profile(userId, displayName),
    worlds: [world(userId, worldId, worldName)],
    events: [event(userId, worldId)],
    syncRun: {
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
    },
    expectedWorldRevisions: [{ userId, worldId, revision: null }],
    expectedGeneration: 0,
    settings: {
      activeProfileId: userId,
      backoffUntil: null,
      consecutiveRateLimits: 0,
      lastSyncResult: "success"
    }
  });
}

test("one-profile backup round-trips without replacing another profile", async (context) => {
  const source = await repository(`backup-source-${context.name}`);
  const target = await repository(`backup-target-${context.name}`);
  context.after(() => {
    source.close();
    target.close();
  });

  await seed(source, USER_A, WORLD_A, "Alice", "保存するワールド");
  await source.setSetting("autoSyncEnabled", true);
  await source.setSetting("notificationsEnabled", false);
  await source.setSetting("backoffUntil", "secret-device-state-must-not-export");

  const text = await createBackup(source, USER_A, {
    appVersion: "1.2.3",
    exportedAt: AT_2
  });
  const sourceSnapshot = await source.getBackupSnapshot(USER_A);
  assert.equal(sourceSnapshot.profile?.displayName, "Alice");
  assert.equal(sourceSnapshot.worlds.length, 1);
  assert.equal(sourceSnapshot.events.length, 1);
  const parsed = validateBackup(text);
  assert.deepEqual(backupSummary(parsed), {
    userId: USER_A,
    displayName: "Alice",
    worldCount: 1,
    eventCount: 1,
    exportedAt: AT_2
  });
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(Object.getPrototypeOf(parsed.profile), null);
  assert.equal(parsed.preferences.autoSyncEnabled, true);
  assert.equal(parsed.preferences.notificationsEnabled, false);
  assert.equal(text.includes("backoffUntil"), false);
  assert.equal(text.includes("dataGeneration:"), false);

  await seed(target, USER_A, WORLD_A, "Alice old", "置換前");
  await seed(target, USER_B, WORLD_B, "Bob", "保持するワールド");
  await target.setSetting("nextSyncAt", "2026-08-21T00:00:00.000Z");
  await restoreBackup(target, text, { restoredAt: RESTORED_AT });

  assert.equal((await target.getProfile(USER_A))?.displayName, "Alice");
  assert.equal((await target.listWorlds(USER_A))[0]?.currentName, "保存するワールド");
  assert.equal((await target.listEvents(USER_A))[0]?.notificationClaimedAt, RESTORED_AT);
  assert.equal((await target.getProfile(USER_B))?.displayName, "Bob");
  assert.equal((await target.listWorlds(USER_B))[0]?.currentName, "保持するワールド");
  assert.equal(await target.getSetting("nextSyncAt"), "2026-08-21T00:00:00.000Z");
  assert.equal(await target.getSetting("autoSyncEnabled"), true);
  assert.equal(await target.getSetting("notificationsEnabled"), false);
  assert.equal(await target.getDataGeneration(USER_A), 2);
  assert.equal(await target.getDataGeneration(USER_B), 1);
});

test("backup snapshot never mixes records with a concurrent profile replacement", async (context) => {
  const database = await repository(`backup-atomic-snapshot-${context.name}`);
  context.after(() => database.close());
  await seed(database, USER_A, WORLD_A, "Before profile", "Before world");
  await database.setSettings({ autoSyncEnabled: true, notificationsEnabled: true });

  const snapshotPromise = database.getBackupSnapshot(USER_A);
  const replacementPromise = database.replaceProfileData({
    profile: profile(USER_A, "After profile"),
    worlds: [world(USER_A, WORLD_A, "After world")],
    events: [{ ...event(USER_A, WORLD_A), after: "After event" }],
    preferences: { autoSyncEnabled: false, notificationsEnabled: false }
  });
  const [snapshot] = await Promise.all([snapshotPromise, replacementPromise]);

  const isBefore = snapshot.profile?.displayName === "Before profile";
  const isAfter = snapshot.profile?.displayName === "After profile";
  assert.equal(isBefore || isAfter, true);
  assert.equal(snapshot.worlds[0]?.currentName, isBefore ? "Before world" : "After world");
  assert.equal(snapshot.events[0]?.after, isBefore ? "現在の名前" : "After event");
  assert.equal(snapshot.preferences.autoSyncEnabled, isBefore);
  assert.equal(snapshot.preferences.notificationsEnabled, isBefore);
});

test("malicious, inconsistent, future, and corrupt backups are rejected before writes", async (context) => {
  const source = await repository(`backup-invalid-source-${context.name}`);
  const target = await repository(`backup-invalid-target-${context.name}`);
  context.after(() => {
    source.close();
    target.close();
  });
  await seed(source, USER_A, WORLD_A, "Alice", "正常");
  await seed(target, USER_A, WORLD_A, "Before", "変更してはいけない");
  const text = await createBackup(source, USER_A, { exportedAt: AT_2 });
  const valid = validateBackup(text);

  const maliciousPrototype = text.replace(
    '"format": "vrc_favworld_check-backup"',
    '"__proto__": {"polluted": true}, "format": "vrc_favworld_check-backup"'
  );
  const secretField = JSON.stringify({
    ...valid,
    profile: { ...valid.profile, authToken: "must-never-be-imported" }
  });
  const badEnum = JSON.stringify({
    ...valid,
    worlds: [{ ...valid.worlds[0], membershipState: "deleted" }]
  });
  const duplicateWorld = JSON.stringify({
    ...valid,
    worlds: [valid.worlds[0], valid.worlds[0]]
  });
  const brokenReference = JSON.stringify({
    ...valid,
    events: [
      {
        ...valid.events[0],
        eventId: `${USER_A}:${WORLD_B}:1:name_changed`,
        worldId: WORLD_B
      }
    ]
  });
  const futureVersion = JSON.stringify({ ...valid, version: BACKUP_VERSION + 1 });
  const wrongFormat = JSON.stringify({ ...valid, format: "some-other-tool" });
  const invalidUserId = JSON.stringify({
    ...valid,
    profile: { ...valid.profile, userId: "usr_not-a-vrchat-id" }
  });
  const invalidDate = JSON.stringify({ ...valid, exportedAt: "2026-02-31T00:00:00.000Z" });
  const oversizedName = JSON.stringify({
    ...valid,
    profile: { ...valid.profile, displayName: "名".repeat(4_097) }
  });
  const unsafePreference = JSON.stringify({
    ...valid,
    preferences: { ...valid.preferences, nextSyncAt: AT_2 }
  });
  const tooManyWorlds = JSON.stringify({
    ...valid,
    worlds: Array.from({ length: MAX_BACKUP_WORLDS + 1 }, () => null),
    events: []
  });

  for (const candidate of [
    maliciousPrototype,
    secretField,
    badEnum,
    duplicateWorld,
    brokenReference,
    futureVersion,
    wrongFormat,
    invalidUserId,
    invalidDate,
    oversizedName,
    unsafePreference,
    tooManyWorlds,
    "{not-json"
  ]) {
    assert.throws(() => validateBackup(candidate), /Invalid backup/);
    await assert.rejects(restoreBackup(target, candidate, { restoredAt: RESTORED_AT }), /Invalid backup/);
  }

  assert.equal((await target.getProfile(USER_A))?.displayName, "Before");
  assert.equal((await target.listWorlds(USER_A))[0]?.currentName, "変更してはいけない");
});

test("oversized backups and secret-bearing database records are refused", async (context) => {
  assert.throws(() => validateBackup(" ".repeat(MAX_BACKUP_BYTES + 1)), /exceeds/);

  const database = await repository(`backup-secrets-${context.name}`);
  context.after(() => database.close());
  const unsafeProfile = {
    ...profile(USER_A, "Alice"),
    sessionToken: "must-not-leave-the-device"
  };
  await database.saveProfile(
    /** @type {Parameters<DatabaseRepository["saveProfile"]>[0]} */ (
      /** @type {unknown} */ (unsafeProfile)
    )
  );

  await assert.rejects(createBackup(database, USER_A, { exportedAt: AT_2 }), /secret-bearing field/);
});
