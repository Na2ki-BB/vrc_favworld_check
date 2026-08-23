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
import {
  MANUAL_SYNC_COOLDOWN_MS,
  NOTIFICATION_EVENT_KINDS,
  SETTINGS_SCHEDULE_WARNING,
  SETTING_KEYS,
  SYNC_ALARM_NAME,
  SYNC_WATCHDOG_DELAY_MS,
  SyncService
} from "../extension/lib/sync-service.js";
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
    return [{ favoriteId: WORLD_ID, tags: [...this.relationTags], type: "world" }];
  }

  /** @returns {ReturnType<VrchatApi["listAllFavoriteWorlds"]>} */
  async listAllFavoriteWorlds() {
    this.calls.push("metadata");
    this.#throwAt("metadata");
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
    return {
      status: 200,
      world: {
        id: worldId,
        name: this.worldName,
        authorName: "作者",
        releaseStatus: "public"
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
    assert.equal(name, SYNC_ALARM_NAME);
    return this.scheduledAt === null ? undefined : { scheduledTime: this.scheduledAt };
  }

  /** @param {string} name @param {number} when */
  async create(name, when) {
    this.createAttempts += 1;
    if (this.createAttempts === this.failCreateAttempt) {
      throw new Error("simulated alarm create failure");
    }
    this.scheduledAt = when;
    this.creates.push({ name, when });
  }

  /** @param {string} name */
  async clear(name) {
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
 *   withApiSession?: <T>(operation: () => Promise<T>) => Promise<T>
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
      : { withApiSession: input.withApiSession })
  });
  return { service, alarms, notifications, time };
}

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
      getUnreadCount: async () => 123
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
  assert.deepEqual(colors, [{ color: "#B4234D" }]);
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
        syncing: false,
        authRequired: false,
        lastSuccessfulSyncAt: null,
        nextSyncAt: null,
        activeProfileId: null,
        worldCount: 0,
        eventCount: 0,
        pendingProbeCount: 0,
        unreadCount: 0,
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
 *   "commitSync" | "claimEvents" | "getDataGeneration" | "setSettings">>} overrides
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
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
