// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { IDBFactory } from "fake-indexeddb";

import {
  KEEPALIVE_INTERVAL_MS,
  MESSAGE_TYPES,
  createAlarmEventHandler,
  createGatedSyncRunner,
  createMessageHandler,
  keepServiceWorkerAlive
} from "../extension/background.js";
import { NetworkError, RateLimitedError } from "../extension/lib/api.js";
import { DatabaseRepository } from "../extension/lib/database.js";
import {
  MANUAL_SYNC_COOLDOWN_MS,
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

/** @typedef {import("../extension/lib/api.js").VrchatApi} VrchatApi */
/** @typedef {Pick<VrchatApi, "getCurrentUser" | "listAllFavoriteRelations" | "listAllFavoriteWorlds" | "getWorld">} ApiPort */

class FakeApi {
  /** @type {string[]} */
  calls = [];
  /** @type {"user" | "relations" | "metadata" | "probe" | null} */
  failureStep = null;
  /** @type {unknown} */
  failure = new Error("fake API failure");
  worldName = "最初の名前";
  /** @type {(() => Promise<void>) | null} */
  beforeUser = null;

  /** @returns {ReturnType<VrchatApi["getCurrentUser"]>} */
  async getCurrentUser() {
    this.calls.push("user");
    if (this.beforeUser !== null) {
      await this.beforeUser();
    }
    this.#throwAt("user");
    return { id: USER_ID, displayName: "テストユーザー" };
  }

  /** @returns {ReturnType<VrchatApi["listAllFavoriteRelations"]>} */
  async listAllFavoriteRelations() {
    this.calls.push("relations");
    this.#throwAt("relations");
    return [{ favoriteId: WORLD_ID, tags: ["worlds1"], type: "world" }];
  }

  /** @returns {ReturnType<VrchatApi["listAllFavoriteWorlds"]>} */
  async listAllFavoriteWorlds() {
    this.calls.push("metadata");
    this.#throwAt("metadata");
    return [{
      id: WORLD_ID,
      name: this.worldName,
      authorName: "作者",
      favoriteGroup: "worlds1",
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

  /** @param {"user" | "relations" | "metadata" | "probe"} step */
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
 *   now?: {value: number}
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
    idGenerator: () => `test-${++syncSequence}`
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
  assert.deepEqual(api.calls, ["user", "relations", "metadata"]);
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
  assert.deepEqual(api.calls, ["user", "relations", "metadata"]);
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
  assert.deepEqual(api.calls, ["user", "relations", "metadata"]);
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
    }
  });

  assert.deepEqual(await handler({ type: MESSAGE_TYPES.openVrchat }), { ok: true });
  assert.deepEqual(await handler({ type: MESSAGE_TYPES.openDashboard }), { ok: true });
  assert.equal(openedVrchat, 1);
  assert.equal(openedDashboard, 1);
  assert.deepEqual(
    await handler({ type: "OPEN_URL", url: "https://attacker.invalid/" }),
    { ok: false, error: "INVALID_REQUEST" }
  );
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
