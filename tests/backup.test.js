// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { IDBFactory } from "fake-indexeddb";

import {
  BACKUP_VERSION,
  MAX_BACKUP_BYTES,
  MAX_BACKUP_GROUPS,
  MAX_BACKUP_WORLDS,
  backupSummary,
  createBackup,
  restoreBackup,
  validateBackup
} from "../extension/lib/backup.js";
import { DatabaseRepository } from "../extension/lib/database.js";
import { normalizeSearchText } from "../extension/lib/domain.js";

/** @typedef {Awaited<ReturnType<DatabaseRepository["listWorlds"]>>[number]} WorldRecord */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listEvents"]>>[number]} HistoryEvent */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listFavoriteGroups"]>>[number]} FavoriteGroupRecord */

const USER_A = "usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "usr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORLD_A = "wrld_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORLD_B = "wrld_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GROUP_A = "fvgrp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP_B = "fvgrp_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AT_1 = "2026-08-17T00:00:00.000Z";
const AT_2 = "2026-08-18T00:00:00.000Z";
const RESTORED_AT = "2026-08-20T00:00:00.000Z";
const AFTER_FUTURE_AT = "2026-08-26T00:00:00.000Z";
const FRACTIONAL_RESTORED_AT = "2026-08-25T00:00:00.1Z";
const FRACTIONAL_EVENT_AT = "2026-08-25T00:00:00.11Z";
const FRACTIONAL_EVENT_CANONICAL = "2026-08-25T00:00:00.110Z";

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
  const displayName = overrides.displayName ?? "お気に入り1";
  const active = overrides.active ?? true;
  return {
    userId,
    groupId,
    internalName: "worlds1",
    displayName,
    normalizedDisplayName: normalizeSearchText(displayName),
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
    favoriteGroups: [favoriteGroup(userId, GROUP_A)],
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
      lastSyncResult: "success",
      favoriteGroupStatus: "success"
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
  assert.equal(sourceSnapshot.favoriteGroups.length, 1);
  assert.equal(sourceSnapshot.events.length, 1);
  const parsed = validateBackup(text);
  assert.deepEqual(backupSummary(parsed), {
    userId: USER_A,
    displayName: "Alice",
    worldCount: 1,
    eventCount: 1,
    groupCount: 1,
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
  assert.equal((await target.listFavoriteGroups(USER_A))[0]?.displayName, "お気に入り1");
  assert.equal((await target.listEvents(USER_A))[0]?.notificationClaimedAt, RESTORED_AT);
  assert.equal((await target.getProfile(USER_B))?.displayName, "Bob");
  assert.equal((await target.listWorlds(USER_B))[0]?.currentName, "保持するワールド");
  assert.equal(await target.getSetting("nextSyncAt"), "2026-08-21T00:00:00.000Z");
  assert.equal(await target.getSetting("autoSyncEnabled"), true);
  assert.equal(await target.getSetting("notificationsEnabled"), false);
  assert.equal(await target.getDataGeneration(USER_A), 2);
  assert.equal(await target.getDataGeneration(USER_B), 1);
});

test("fractional timestamps normalize before restore max and immediate re-export", async (context) => {
  const source = await repository(`backup-future-source-${context.name}`);
  const target = await repository(`backup-future-target-${context.name}`);
  context.after(() => {
    source.close();
    target.close();
  });
  await seed(source, USER_A, WORLD_A, "Clock skew", "未来時刻の履歴");
  const futureBackup = JSON.parse(
    await createBackup(source, USER_A, { exportedAt: AT_2 })
  );
  futureBackup.events[0].observedAt = FRACTIONAL_EVENT_AT;
  futureBackup.events[0].notificationClaimedAt = null;
  const futureText = JSON.stringify(futureBackup);
  assert.equal(
    validateBackup(futureText).events[0]?.observedAt,
    FRACTIONAL_EVENT_CANONICAL
  );

  await restoreBackup(target, futureText, { restoredAt: FRACTIONAL_RESTORED_AT });
  assert.equal(
    (await target.listEvents(USER_A))[0]?.notificationClaimedAt,
    FRACTIONAL_EVENT_CANONICAL
  );

  const reExported = await createBackup(target, USER_A, { exportedAt: AFTER_FUTURE_AT });
  const validatedRoundTrip = validateBackup(reExported);
  assert.equal(validatedRoundTrip.events[0]?.observedAt, FRACTIONAL_EVENT_CANONICAL);
  assert.equal(
    validatedRoundTrip.events[0]?.notificationClaimedAt,
    FRACTIONAL_EVENT_CANONICAL
  );
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
    favoriteGroups: [],
    events: [{ ...event(USER_A, WORLD_A), after: "After event" }],
    preferences: { autoSyncEnabled: false, notificationsEnabled: false }
  });
  const [snapshot] = await Promise.all([snapshotPromise, replacementPromise]);

  const isBefore = snapshot.profile?.displayName === "Before profile";
  const isAfter = snapshot.profile?.displayName === "After profile";
  assert.equal(isBefore || isAfter, true);
  assert.equal(snapshot.worlds[0]?.currentName, isBefore ? "Before world" : "After world");
  assert.equal(snapshot.events[0]?.after, isBefore ? "現在の名前" : "After event");
  assert.equal(snapshot.favoriteGroups.length, isBefore ? 1 : 0);
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

test("v1 backups import as canonical v2 data without favorite groups", async (context) => {
  const source = await repository(`backup-v1-source-${context.name}`);
  const target = await repository(`backup-v1-target-${context.name}`);
  context.after(() => {
    source.close();
    target.close();
  });
  await seed(source, USER_A, WORLD_A, "Alice", "v1から復元");
  await seed(target, USER_A, WORLD_A, "Before", "置換前");

  const raw = /** @type {Record<string, unknown>} */ (
    JSON.parse(await createBackup(source, USER_A, { exportedAt: AT_2 }))
  );
  raw.version = 1;
  delete raw.favoriteGroups;
  for (const rawEvent of /** @type {Record<string, unknown>[]} */ (raw.events)) {
    delete rawEvent.notificationEligible;
  }
  const rawProfile = /** @type {Record<string, unknown>} */ (raw.profile);
  rawProfile.createdBySchemaVersion = 1;
  const v1Text = JSON.stringify(raw);

  const canonical = validateBackup(v1Text);
  assert.equal(canonical.version, BACKUP_VERSION);
  assert.deepEqual(canonical.favoriteGroups, []);
  assert.equal(canonical.events[0]?.notificationEligible, true);
  assert.equal(backupSummary(canonical).groupCount, 0);
  const summary = await restoreBackup(target, v1Text, { restoredAt: RESTORED_AT });
  assert.equal(summary.groupCount, 0);
  assert.deepEqual(await target.listFavoriteGroups(USER_A), []);
  assert.equal((await target.listWorlds(USER_A))[0]?.currentName, "v1から復元");
  assert.equal(await target.getUnreadCount(USER_A), 0);
});

test("createdBySchemaVersion is validated against the source and database versions", async (context) => {
  const database = await repository(`backup-schema-version-${context.name}`);
  context.after(() => database.close());
  await seed(database, USER_A, WORLD_A, "Alice", "Schema version");
  const valid = JSON.parse(await createBackup(database, USER_A, { exportedAt: AT_2 }));

  for (const schemaVersion of [1, 2]) {
    const candidate = structuredClone(valid);
    candidate.profile.createdBySchemaVersion = schemaVersion;
    assert.equal(validateBackup(JSON.stringify(candidate)).profile.createdBySchemaVersion, schemaVersion);
  }
  for (const schemaVersion of [0, 3]) {
    const candidate = structuredClone(valid);
    candidate.profile.createdBySchemaVersion = schemaVersion;
    assert.throws(() => validateBackup(JSON.stringify(candidate)), /createdBySchemaVersion/);
  }

  const v1WithFutureSchema = structuredClone(valid);
  v1WithFutureSchema.version = 1;
  delete v1WithFutureSchema.favoriteGroups;
  v1WithFutureSchema.profile.createdBySchemaVersion = 2;
  assert.throws(() => validateBackup(JSON.stringify(v1WithFutureSchema)), /createdBySchemaVersion/);
});

test("v2 favorite groups reject invalid IDs, ownership, type, duplication, history, and time", async (context) => {
  const database = await repository(`backup-groups-invalid-${context.name}`);
  context.after(() => database.close());
  await seed(database, USER_A, WORLD_A, "Alice", "Group validation");
  const valid = validateBackup(await createBackup(database, USER_A, { exportedAt: AT_2 }));
  const knownGroup = valid.favoriteGroups[0];
  if (knownGroup === undefined) {
    throw new Error("group fixture is missing");
  }

  const inactiveDuplicateName = favoriteGroup(USER_A, GROUP_B, {
    active: false,
    internalName: knownGroup.internalName
  });
  assert.equal(
    validateBackup(JSON.stringify({ ...valid, favoriteGroups: [knownGroup, inactiveDuplicateName] }))
      .favoriteGroups.length,
    2
  );
  assert.equal(
    validateBackup(JSON.stringify({
      ...valid,
      favoriteGroups: [{ ...knownGroup, missingCount: 1 }]
    })).favoriteGroups[0]?.missingCount,
    1
  );

  const longHistory = Array.from({ length: 101 }, (_, index) => ({
    displayName: `旧名${index}`,
    observedAt: AT_1
  }));
  const invalidGroups = [
    { ...knownGroup, groupId: "fvgrp_invalid" },
    { ...knownGroup, userId: USER_B },
    { ...knownGroup, type: "avatar" },
    { ...knownGroup, missingCount: 2 },
    { ...knownGroup, active: false, missingCount: 1 },
    { ...knownGroup, normalizedDisplayName: "不一致" },
    { ...knownGroup, lastSeenAt: "2026-08-16T00:00:00.000Z" },
    { ...knownGroup, displayNameHistory: longHistory },
    { ...knownGroup, unsupportedField: true },
    { ...knownGroup, authToken: "must-never-be-imported" }
  ];
  for (const invalidGroup of invalidGroups) {
    assert.throws(
      () => validateBackup(JSON.stringify({ ...valid, favoriteGroups: [invalidGroup] })),
      /Invalid backup/
    );
  }

  assert.throws(
    () => validateBackup(JSON.stringify({ ...valid, favoriteGroups: [knownGroup, knownGroup] })),
    /duplicate group IDs/
  );
  assert.throws(
    () => validateBackup(JSON.stringify({
      ...valid,
      favoriteGroups: [knownGroup, favoriteGroup(USER_A, GROUP_B)]
    })),
    /duplicate active internal names/
  );
  assert.throws(
    () => validateBackup(JSON.stringify({ ...valid, favoriteGroups: undefined })),
    /favoriteGroups/
  );
  assert.throws(
    () => validateBackup(JSON.stringify({
      ...valid,
      favoriteGroups: Array.from({ length: MAX_BACKUP_GROUPS + 1 }, () => knownGroup)
    })),
    /at most/
  );
});

test("favorite_group_changed events use bounded unique canonical JSON arrays", async (context) => {
  const database = await repository(`backup-group-event-${context.name}`);
  context.after(() => database.close());
  await seed(database, USER_A, WORLD_A, "Alice", "Event validation");
  const valid = validateBackup(await createBackup(database, USER_A, { exportedAt: AT_2 }));
  const baseEvent = valid.events[0];
  if (baseEvent === undefined) {
    throw new Error("event fixture is missing");
  }
  const groupEvent = {
    ...baseEvent,
    eventId: `${USER_A}:${WORLD_A}:1:favorite_group_changed`,
    kind: /** @type {const} */ ("favorite_group_changed"),
    notificationEligible: false,
    before: JSON.stringify(["worlds2", "worlds1"]),
    after: JSON.stringify(["worlds3"]),
    evidence: { source: /** @type {const} */ ("bulk"), httpStatus: null }
  };
  const canonical = validateBackup(JSON.stringify({ ...valid, events: [groupEvent] }));
  assert.equal(canonical.events[0]?.before, JSON.stringify(["worlds1", "worlds2"]));
  assert.equal(canonical.events[0]?.after, JSON.stringify(["worlds3"]));

  const invalidEvents = [
    { ...groupEvent, before: "not-json" },
    { ...groupEvent, before: JSON.stringify(["worlds1", "worlds1"]) },
    { ...groupEvent, before: JSON.stringify([" worlds1 "]) },
    { ...groupEvent, before: JSON.stringify([123]) },
    { ...groupEvent, before: JSON.stringify(["x".repeat(201)]) },
    {
      ...groupEvent,
      before: JSON.stringify(Array.from({ length: 101 }, (_, index) => `worlds${index}`))
    },
    { ...groupEvent, after: JSON.stringify(["worlds1", "worlds2"]) },
    { ...groupEvent, evidence: { source: "probe", httpStatus: null } },
    { ...groupEvent, evidence: { source: "bulk", httpStatus: 200 } },
    { ...groupEvent, notificationEligible: true },
    { ...baseEvent, notificationEligible: false },
    { ...groupEvent, notificationEligible: "false" },
    { ...groupEvent, notificationEligible: undefined },
    { ...groupEvent, notificationClaimedAt: AT_1 },
    { ...groupEvent, notificationClaimedAt: AT_2, notifiedAt: AT_1 }
  ];
  for (const invalidEvent of invalidEvents) {
    assert.throws(
      () => validateBackup(JSON.stringify({ ...valid, events: [invalidEvent] })),
      /Invalid backup/
    );
  }

  const v1WithGroupEvent = JSON.parse(JSON.stringify({ ...valid, events: [groupEvent] }));
  v1WithGroupEvent.version = 1;
  delete v1WithGroupEvent.favoriteGroups;
  delete v1WithGroupEvent.events[0].notificationEligible;
  assert.throws(() => validateBackup(JSON.stringify(v1WithGroupEvent)), /unsupported value/);

  await restoreBackup(
    database,
    JSON.stringify({ ...valid, events: [groupEvent] }),
    { restoredAt: RESTORED_AT }
  );
  assert.equal((await database.listEvents(USER_A))[0]?.notificationClaimedAt, null);
});

test("v2 backup deterministically round-trips 800 worlds and 8 favorite groups", async (context) => {
  const source = await repository(`backup-capacity-source-${context.name}`);
  const target = await repository(`backup-capacity-target-${context.name}`);
  context.after(() => {
    source.close();
    target.close();
  });

  const favoriteGroups = Array.from({ length: 8 }, (_, index) => {
    const plusGroup = index >= 4;
    return favoriteGroup(
      USER_A,
      `fvgrp_${index.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      {
        internalName: plusGroup ? `vrcPlusWorlds${index - 3}` : `worlds${index + 1}`,
        displayName: `リスト${index + 1}`,
        normalizedDisplayName: normalizeSearchText(`リスト${index + 1}`),
        type: plusGroup ? "vrcPlusWorld" : "world"
      }
    );
  });
  const worlds = Array.from({ length: 800 }, (_, index) => {
    const group = favoriteGroups[index % favoriteGroups.length];
    if (group === undefined) {
      throw new Error("capacity group fixture is missing");
    }
    return {
      ...world(
        USER_A,
        `wrld_${index.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        `World ${String(index).padStart(3, "0")}`
      ),
      favoriteTags: [group.internalName]
    };
  });
  const firstWorld = worlds[0];
  if (firstWorld === undefined) {
    throw new Error("capacity world fixture is missing");
  }
  const groupEvent = {
    ...event(USER_A, firstWorld.worldId),
    eventId: `${USER_A}:${firstWorld.worldId}:1:favorite_group_changed`,
    kind: /** @type {const} */ ("favorite_group_changed"),
    notificationEligible: false,
    before: JSON.stringify(["worlds1"]),
    after: JSON.stringify(["worlds2"]),
    evidence: { source: /** @type {const} */ ("bulk"), httpStatus: null },
    syncId: "sync-capacity"
  };
  await source.commitSync({
    profile: { ...profile(USER_A, "Capacity"), createdBySchemaVersion: 2 },
    worlds,
    favoriteGroups,
    events: [groupEvent],
    syncRun: {
      syncId: "sync-capacity",
      userId: USER_A,
      trigger: "manual",
      startedAt: AT_1,
      finishedAt: AT_2,
      result: "success",
      favoriteCount: worlds.length,
      metadataCount: worlds.length,
      probeCount: 0,
      changeCount: 1,
      retryAt: null
    },
    expectedWorldRevisions: worlds.map((record) => ({
      userId: USER_A,
      worldId: record.worldId,
      revision: null
    })),
    expectedGeneration: 0,
    settings: {
      activeProfileId: USER_A,
      backoffUntil: null,
      consecutiveRateLimits: 0,
      lastSyncResult: "success",
      favoriteGroupStatus: "success"
    }
  });
  await source.setSettings({
    lastBackupAt: Date.parse(AT_1),
    purgePending: false
  });

  const options = { appVersion: "2.0.0", exportedAt: AT_2 };
  const firstExport = await createBackup(source, USER_A, options);
  const secondExport = await createBackup(source, USER_A, options);
  assert.equal(firstExport, secondExport);
  assert.equal(firstExport.includes("lastBackupAt"), false);
  assert.equal(firstExport.includes("purgePending"), false);
  const validated = validateBackup(firstExport);
  assert.deepEqual(backupSummary(validated), {
    userId: USER_A,
    displayName: "Capacity",
    worldCount: 800,
    eventCount: 1,
    groupCount: 8,
    exportedAt: AT_2
  });

  await restoreBackup(target, firstExport, { restoredAt: RESTORED_AT });
  assert.equal((await target.listWorlds(USER_A)).length, 800);
  assert.equal((await target.listFavoriteGroups(USER_A)).length, 8);
  assert.equal((await target.listEvents(USER_A))[0]?.kind, "favorite_group_changed");
  assert.equal(await target.getUnreadCount(USER_A), 0);
});
