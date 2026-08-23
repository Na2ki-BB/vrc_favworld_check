// @ts-check

import {
  ApiSchemaError,
  AuthRequiredError,
  ForbiddenError,
  NetworkError,
  PaginationError,
  RateLimitedError,
  ServerError,
  UnexpectedRedirectError,
  VrchatApi
} from "./api.js";
import {
  AuthCookieBusyError,
  AuthCookieCleanupError,
  AuthCookieConflictError,
  AuthCookiePartitionedError,
  AuthCookieRequiredError,
  AuthCookieSetupError
} from "./auth-cookie-bridge.js";
import {
  DATABASE_VERSION,
  GenerationConflictError,
  RevisionConflictError
} from "./database.js";
import {
  MAX_PROBE_CANDIDATES,
  SCHEMA_V2_NOTIFICATION_ELIGIBLE_EVENT_KINDS,
  reconcileWorlds,
  selectProbeCandidates
} from "./domain.js";
import {
  FavoriteGroupValidationError,
  reconcileFavoriteGroups
} from "./favorite-groups.js";
import {
  calculateNextSyncAt,
  calculateRateLimitBackoff,
  repairStartupSchedule
} from "./schedule.js";

export const SYNC_ALARM_NAME = "sync-next";
export const MANUAL_SYNC_COOLDOWN_MS = 5 * 60 * 1_000;
export const SYNC_WATCHDOG_DELAY_MS = 10 * 60 * 1_000;
export const NOTIFICATION_ID_PREFIX = "vrc-favworld-check-change-";
export const SETTINGS_SCHEDULE_WARNING = "SCHEDULE_REPAIR_FAILED";
export const NOTIFICATION_EVENT_KINDS = SCHEMA_V2_NOTIFICATION_ELIGIBLE_EVENT_KINDS;

export const SETTING_KEYS = Object.freeze({
  autoSyncEnabled: "autoSyncEnabled",
  notificationsEnabled: "notificationsEnabled",
  lastManualSyncAt: "lastManualSyncAt",
  nextSyncAt: "nextSyncAt",
  backoffUntil: "backoffUntil",
  consecutiveRateLimits: "consecutiveRateLimits",
  activeProfileId: "activeProfileId",
  lastSyncResult: "lastSyncResult",
  favoriteGroupStatus: "favoriteGroupStatus",
  lastAlarmError: "lastAlarmError",
  watchdogUntil: "watchdogUntil",
  purgePending: "purgePending"
});

/** @typedef {"manual" | "alarm" | "resume"} SyncTrigger */
/** @typedef {"success" | "429" | "offline" | "5xx" | "auth" | "schema" | "conflict" | "other"} ScheduleResult */
/**
 * @typedef {{
 *   ok: true,
 *   changes?: number
 * } | {
 *   ok: false,
 *   error: "AUTH_REQUIRED" | "AUTH_COOKIE_UNAVAILABLE" | "AUTH_COOKIE_CONFLICT" | "AUTH_COOKIE_CLEANUP_FAILED" | "RATE_LIMITED" | "OFFLINE" | "VRCHAT_UNAVAILABLE" | "API_INCOMPATIBLE" | "MANUAL_COOLDOWN" | "SYNC_CONFLICT" | "SYNC_FAILED" | "STORAGE_UNAVAILABLE" | "MAINTENANCE_IN_PROGRESS",
 *   retryAt?: string
 * }} PublicSyncResult
 */

/**
 * @typedef {Pick<import("./database.js").DatabaseRepository,
 *   "getProfile" | "listProfiles" | "getProfileStats" |
 *   "getSyncSnapshot" | "getDataGeneration" | "getSetting" | "setSetting" |
 *   "setSettings" | "commitSync" | "recordSyncRun" | "claimEvents" |
 *   "updateNotificationResult" | "getUnreadCount" | "markEventsRead">} Repository
 */

/**
 * @typedef {object} AlarmAdapter
 * @property {(name: string) => Promise<{scheduledTime?: number} | undefined>} get
 * @property {(name: string, when: number) => Promise<void>} create
 * @property {(name: string) => Promise<boolean>} clear
 */

/**
 * @typedef {object} NotificationAdapter
 * @property {() => Promise<"granted" | "denied">} getPermissionLevel
 * @property {(id: string, options: chrome.notifications.NotificationCreateOptions) => Promise<string>} create
 */

/**
 * Application service that owns the entire sync boundary. It never receives,
 * reads, or persists login material, credential headers, or raw API responses.
 */
export class SyncService {
  /** @type {Repository} */
  #repository;
  /** @type {Pick<VrchatApi, "getCurrentUser" | "listAllFavoriteGroups" | "listAllFavoriteRelations" | "listAllFavoriteWorlds" | "getWorld">} */
  #api;
  /** @type {AlarmAdapter} */
  #alarms;
  /** @type {NotificationAdapter} */
  #notifications;
  /** @type {() => number} */
  #clock;
  /** @type {() => number} */
  #random;
  /** @type {() => string} */
  #idGenerator;
  /** @type {<T>(operation: () => Promise<T>) => Promise<T>} */
  #withApiSession;
  /** @type {Promise<PublicSyncResult> | null} */
  #activeSync = null;

  /**
   * @param {{
   *   repository: Repository,
   *   api?: Pick<VrchatApi, "getCurrentUser" | "listAllFavoriteGroups" | "listAllFavoriteRelations" | "listAllFavoriteWorlds" | "getWorld">,
   *   alarms: AlarmAdapter,
   *   notifications: NotificationAdapter,
   *   clock?: () => number,
   *   random?: () => number,
   *   idGenerator?: () => string,
   *   withApiSession?: <T>(operation: () => Promise<T>) => Promise<T>
   * }} dependencies
   */
  constructor(dependencies) {
    this.#repository = dependencies.repository;
    this.#api = dependencies.api ?? new VrchatApi();
    this.#alarms = dependencies.alarms;
    this.#notifications = dependencies.notifications;
    this.#clock = dependencies.clock ?? Date.now;
    this.#random = dependencies.random ?? Math.random;
    this.#idGenerator = dependencies.idGenerator ?? (() => crypto.randomUUID());
    this.#withApiSession = dependencies.withApiSession ?? (async (operation) => operation());
  }

  get syncing() {
    return this.#activeSync !== null;
  }

  /**
   * A concurrent caller shares the already-running promise and cannot start
   * another API sequence.
   *
   * @param {SyncTrigger} trigger
   * @returns {Promise<PublicSyncResult>}
   */
  start(trigger) {
    if (trigger !== "manual" && trigger !== "alarm" && trigger !== "resume") {
      return Promise.resolve({ ok: false, error: "SYNC_FAILED" });
    }
    if (this.#activeSync !== null) {
      return this.#activeSync;
    }

    const started = this.#startNewSync(trigger);
    /** @type {Promise<PublicSyncResult>} */
    let tracked;
    tracked = started.finally(() => {
      if (this.#activeSync === tracked) {
        this.#activeSync = null;
      }
    });
    this.#activeSync = tracked;
    return tracked;
  }

  /**
   * @returns {Promise<{
   *   syncing: boolean,
   *   authRequired: boolean,
   *   lastSuccessfulSyncAt: string | null,
   *   nextSyncAt: string | null,
   *   activeProfileId: string | null,
   *   worldCount: number,
   *   eventCount: number,
   *   pendingProbeCount: number,
   *   unreadCount: number,
   *   favoriteGroupStatus: "success" | "stale" | null,
   *   lastResult: string | null
   * }>}
   */
  async getStatus() {
    const activeProfileId = await this.#repository.getSetting(SETTING_KEYS.activeProfileId);
    const nextSyncAt = await this.#repository.getSetting(SETTING_KEYS.nextSyncAt);
    const lastResult = await this.#repository.getSetting(SETTING_KEYS.lastSyncResult);
    const favoriteGroupStatus = await this.#repository.getSetting(
      SETTING_KEYS.favoriteGroupStatus
    );
    const profileId = typeof activeProfileId === "string" ? activeProfileId : null;
    const profile = profileId === null
      ? null
      : await this.#repository.getProfile(profileId);
    const stats = profileId === null
      ? { worldCount: 0, eventCount: 0, pendingProbeCount: 0 }
      : await this.#repository.getProfileStats(profileId);
    const unreadCount = profileId === null
      ? 0
      : await this.#repository.getUnreadCount(profileId);

    return {
      syncing: this.syncing,
      authRequired: lastResult === "auth_required",
      lastSuccessfulSyncAt: profile?.lastSuccessfulSyncAt ?? null,
      nextSyncAt: isFiniteTimestamp(nextSyncAt)
        ? new Date(nextSyncAt).toISOString()
        : null,
      activeProfileId: profileId,
      worldCount: stats.worldCount,
      eventCount: stats.eventCount,
      pendingProbeCount: stats.pendingProbeCount,
      unreadCount,
      favoriteGroupStatus:
        favoriteGroupStatus === "success" || favoriteGroupStatus === "stale"
          ? favoriteGroupStatus
          : null,
      lastResult: typeof lastResult === "string" ? lastResult : null
    };
  }

  /**
   * Mark the active profile's durable history as read. The caller never
   * supplies a profile ID, so extension messages cannot target arbitrary DB
   * keys.
   *
   * @returns {Promise<boolean>} false when no profile has been established
   */
  async markHistoryRead() {
    const activeProfileId = await this.#repository.getSetting(SETTING_KEYS.activeProfileId);
    if (typeof activeProfileId !== "string") {
      return false;
    }
    await this.#repository.markEventsRead(activeProfileId);
    return true;
  }

  /**
   * @param {{autoSyncEnabled: boolean, notificationsEnabled: boolean}} settings
   * @returns {Promise<{
   *   settingsSaved: true,
   *   scheduleWarning: typeof SETTINGS_SCHEDULE_WARNING | null
   * }>}
   */
  async updateSettings(settings) {
    if (
      typeof settings.autoSyncEnabled !== "boolean"
      || typeof settings.notificationsEnabled !== "boolean"
    ) {
      throw new TypeError("Settings must be booleans");
    }
    await this.#repository.setSettings({
      [SETTING_KEYS.autoSyncEnabled]: settings.autoSyncEnabled,
      [SETTING_KEYS.notificationsEnabled]: settings.notificationsEnabled
    });
    try {
      await this.repairSchedule();
      return { settingsSaved: true, scheduleWarning: null };
    } catch {
      // The user settings above are already the durable source of truth.
      // Alarm state is derived and can be repaired on the next lifecycle
      // event, so report that secondary failure without misreporting the save.
      await this.#recordAlarmFailureBestEffort();
      return {
        settingsSaved: true,
        scheduleWarning: SETTINGS_SCHEDULE_WARNING
      };
    }
  }

  /**
   * Distinguish a crash-recovery watchdog from an ordinary scheduled alarm.
   * Either trigger starts a new complete sync from authentication.
   *
   * @param {number | undefined} scheduledTime
   * @returns {Promise<"alarm" | "resume">}
   */
  async resolveAlarmTrigger(scheduledTime) {
    const watchdogUntil = await this.#repository.getSetting(SETTING_KEYS.watchdogUntil);
    return isFiniteTimestamp(scheduledTime)
      && isFiniteTimestamp(watchdogUntil)
      && Math.abs(scheduledTime - watchdogUntil) < 1_000
      ? "resume"
      : "alarm";
  }

  /**
   * A watchdog may fire while the original single-flight is still healthy.
   * Replace it before sharing that flight so a later worker crash remains
   * recoverable.
   */
  async rearmWatchdogForActiveSync() {
    if (!this.syncing) {
      return false;
    }
    await this.#armWatchdog(this.#now());
    return true;
  }

  /**
   * Fail closed before an alarm/resume sync. A disabled or unreadable setting
   * never reaches DNR installation or the network path. Manual sync does not
   * use this gate.
   */
  async prepareAutomaticSync() {
    let enabledSetting;
    let purgePending;
    try {
      [enabledSetting, purgePending] = await Promise.all([
        this.#repository.getSetting(SETTING_KEYS.autoSyncEnabled),
        this.#repository.getSetting(SETTING_KEYS.purgePending)
      ]);
    } catch {
      await this.#recordAlarmFailureBestEffort();
      return false;
    }
    if (purgePending === true) {
      try {
        await this.#alarms.clear(SYNC_ALARM_NAME);
      } catch {
        // The durable guard still prevents every sync and database write.
      }
      return false;
    }
    if (enabledSetting === undefined || enabledSetting === true) {
      return true;
    }
    await this.#clearAutomaticScheduleBestEffort();
    return false;
  }

  /**
   * Restore the single named one-shot alarm after install/startup or settings
   * import. Existing future schedules are retained.
   */
  async repairSchedule() {
    const [enabledSetting, purgePending] = await Promise.all([
      this.#repository.getSetting(SETTING_KEYS.autoSyncEnabled),
      this.#repository.getSetting(SETTING_KEYS.purgePending)
    ]);
    if (purgePending === true) {
      await this.#alarms.clear(SYNC_ALARM_NAME);
      return;
    }
    const enabled = purgePending !== true
      && (enabledSetting === undefined ? true : enabledSetting === true);
    const storedNext = await this.#repository.getSetting(SETTING_KEYS.nextSyncAt);
    const storedWatchdog = await this.#repository.getSetting(SETTING_KEYS.watchdogUntil);
    const existing = await this.#alarms.get(SYNC_ALARM_NAME);
    const now = this.#now();
    const repair = repairStartupSchedule({
      automaticSyncEnabled: enabled,
      storedNextSyncAt: isFiniteTimestamp(storedNext) ? storedNext : null,
      existingAlarmWhen: isFiniteTimestamp(existing?.scheduledTime)
        ? existing.scheduledTime
        : null,
      nowMs: now,
      randomValue: this.#randomValue()
    });

    if (repair.action === "clear") {
      await this.#alarms.clear(SYNC_ALARM_NAME);
      await this.#repository.setSettings({
        [SETTING_KEYS.nextSyncAt]: null,
        [SETTING_KEYS.watchdogUntil]: null,
        [SETTING_KEYS.lastAlarmError]: null
      });
      return;
    }
    if (repair.action === "create" && repair.when !== null) {
      await this.#alarms.create(SYNC_ALARM_NAME, repair.when);
    }
    /** @type {Record<string, unknown>} */
    const repairedSettings = { [SETTING_KEYS.nextSyncAt]: repair.nextSyncAt };
    if (repair.nextSyncAt !== storedWatchdog) {
      repairedSettings[SETTING_KEYS.watchdogUntil] = null;
    }
    repairedSettings[SETTING_KEYS.lastAlarmError] = null;
    await this.#repository.setSettings(repairedSettings);
  }

  /**
   * Closed recovery path for an alarm event. It never throws: first use the
   * persisted schedule repair, then place a conservative startup-jitter alarm
   * if repair itself failed and automatic sync is confirmed enabled.
   */
  async repairScheduleBestEffort() {
    try {
      await this.repairSchedule();
      return;
    } catch {
      await this.#recordAlarmFailureBestEffort();
    }

    let enabledSetting;
    let purgePending;
    try {
      [enabledSetting, purgePending] = await Promise.all([
        this.#repository.getSetting(SETTING_KEYS.autoSyncEnabled),
        this.#repository.getSetting(SETTING_KEYS.purgePending)
      ]);
    } catch {
      await this.#recordAlarmFailureBestEffort();
      return;
    }
    if (purgePending === true) {
      try {
        await this.#alarms.clear(SYNC_ALARM_NAME);
      } catch {
        return;
      }
      return;
    }
    if (enabledSetting !== undefined && enabledSetting !== true) {
      await this.#clearAutomaticScheduleBestEffort();
      return;
    }

    const now = this.#nowForRecovery();
    const randomValue = this.#randomForRecovery();
    if (now === null || randomValue === null) {
      await this.#recordAlarmFailureBestEffort();
      return;
    }
    const fallback = repairStartupSchedule({
      automaticSyncEnabled: true,
      storedNextSyncAt: null,
      existingAlarmWhen: null,
      nowMs: now,
      randomValue
    });
    if (fallback.when === null) {
      await this.#recordAlarmFailureBestEffort();
      return;
    }
    try {
      await this.#alarms.create(SYNC_ALARM_NAME, fallback.when);
    } catch {
      await this.#recordAlarmFailureBestEffort();
      return;
    }
    try {
      await this.#repository.setSettings({
        [SETTING_KEYS.nextSyncAt]: fallback.when,
        [SETTING_KEYS.watchdogUntil]: null,
        [SETTING_KEYS.lastAlarmError]: "unavailable"
      });
    } catch {
      await this.#recordAlarmFailureBestEffort();
    }
  }

  /** @param {SyncTrigger} trigger @returns {Promise<PublicSyncResult>} */
  async #startNewSync(trigger) {
    try {
      if (await this.#repository.getSetting(SETTING_KEYS.purgePending) === true) {
        return { ok: false, error: "MAINTENANCE_IN_PROGRESS" };
      }
      const now = this.#now();
      const backoffUntil = await this.#repository.getSetting(SETTING_KEYS.backoffUntil);
      if (isFutureTimestamp(backoffUntil, now)) {
        await this.#scheduleAtBackoff(backoffUntil);
        return {
          ok: false,
          error: /** @type {const} */ ("RATE_LIMITED"),
          retryAt: new Date(backoffUntil).toISOString()
        };
      }

      if (trigger === "manual") {
        const lastManualSyncAt = await this.#repository.getSetting(
          SETTING_KEYS.lastManualSyncAt
        );
        if (
          isFiniteTimestamp(lastManualSyncAt)
          && now - lastManualSyncAt < MANUAL_SYNC_COOLDOWN_MS
        ) {
          return {
            ok: false,
            error: /** @type {const} */ ("MANUAL_COOLDOWN"),
            retryAt: new Date(lastManualSyncAt + MANUAL_SYNC_COOLDOWN_MS).toISOString()
          };
        }
        await this.#repository.setSetting(SETTING_KEYS.lastManualSyncAt, now);
      }

      return await this.#executeSync(trigger);
    } catch {
      return { ok: false, error: "STORAGE_UNAVAILABLE" };
    }
  }

  /** @param {SyncTrigger} trigger @returns {Promise<PublicSyncResult>} */
  async #executeSync(trigger) {
    const startedAtMs = this.#now();
    const startedAt = new Date(startedAtMs).toISOString();
    const syncId = `sync-${this.#idGenerator()}`;
    /** @type {ScheduleResult} */
    let scheduleResult = "other";
    /** @type {number | null} */
    let scheduledBackoff = null;
    /** @type {PublicSyncResult} */
    let publicResult = /** @type {PublicSyncResult} */ ({
      ok: false,
      error: "SYNC_FAILED"
    });
    /** @type {string | null} */
    let userId = null;
    let favoriteCount = 0;
    let metadataCount = 0;
    let probeCount = 0;
    let committed = false;
    let committedChangeCount = 0;

    try {
      await this.#armWatchdog(startedAtMs);
      await this.#withApiSession(async () => {
      const user = await this.#api.getCurrentUser();
      userId = user.id;
      const initialSnapshot = await this.#repository.getSyncSnapshot(user.id);

      /** @type {Awaited<ReturnType<VrchatApi["listAllFavoriteGroups"]>>} */
      let apiFavoriteGroups = [];
      let groupSnapshotComplete = true;
      try {
        apiFavoriteGroups = await this.#api.listAllFavoriteGroups(user.id);
      } catch (error) {
        if (
          error instanceof ApiSchemaError
          || error instanceof PaginationError
          || error instanceof ForbiddenError
        ) {
          groupSnapshotComplete = false;
        } else {
          throw error;
        }
      }

      const apiRelations = await this.#api.listAllFavoriteRelations();
      favoriteCount = apiRelations.length;
      const apiMetadata = await this.#api.listAllFavoriteWorlds();
      metadataCount = apiMetadata.length;
      if (
        groupSnapshotComplete
        && !isFavoriteGroupSnapshotConsistent({
          currentGroups: apiFavoriteGroups,
          relations: apiRelations,
          metadata: apiMetadata
        })
      ) {
        groupSnapshotComplete = false;
      }
      const favoriteRelations = apiRelations.map((relation) => ({
        worldId: relation.favoriteId,
        tags: relation.tags
      }));
      const metadata = apiMetadata.map((world) => ({
        worldId: world.id,
        name: world.name,
        authorName: world.authorName,
        favoriteTags: [world.favoriteGroup]
      }));

      const candidates = selectProbeCandidates({
        previousWorlds: initialSnapshot.worlds,
        favoriteRelations,
        metadata,
        limit: MAX_PROBE_CANDIDATES
      });
      /** @type {Map<string, import("./domain.js").MappedWorldProbe>} */
      const probes = new Map();
      for (const worldId of candidates) {
        const result = await this.#api.getWorld(worldId);
        probeCount += 1;
        if (result.status === 404) {
          probes.set(worldId, { worldId, status: 404 });
        } else {
          probes.set(worldId, {
            worldId,
            status: 200,
            metadata: {
              worldId: result.world.id,
              name: result.world.name,
              authorName: result.world.authorName,
              favoriteTags: []
            }
          });
        }
      }

      const observedAt = new Date(this.#now()).toISOString();
      const committedPlan = await this.#commitReconciledSnapshot({
        user,
        trigger,
        syncId,
        startedAt,
        observedAt,
        initialSnapshot,
        apiFavoriteGroups,
        groupSnapshotComplete,
        favoriteRelations,
        metadata,
        probes,
        favoriteCount,
        metadataCount,
        probeCount
      });

      committed = true;
      committedChangeCount = committedPlan.changeCount;
      scheduleResult = "success";
      publicResult = { ok: true, changes: committedPlan.changeCount };
      await this.#deliverNotifications(user.id, syncId, committedPlan.generation);
      });
    } catch (error) {
      if (committed && error instanceof AuthCookieCleanupError) {
        publicResult = { ok: false, error: "AUTH_COOKIE_CLEANUP_FAILED" };
      } else if (!committed) {
        const failure = await this.#recordFailure({
          error,
          syncId,
          userId,
          trigger,
          startedAt,
          favoriteCount,
          metadataCount,
          probeCount
        });
        scheduleResult = failure.scheduleResult;
        scheduledBackoff = failure.backoffUntil;
        publicResult = failure.publicResult;
      } else {
        publicResult = { ok: true, changes: committedChangeCount };
      }
    } finally {
      try {
        await this.#scheduleAfterSync(scheduleResult, scheduledBackoff);
      } catch {
        await this.#recordAlarmFailureBestEffort();
      }
    }

    return publicResult;
  }

  /**
   * Replan at most once if an import/replacement changed the profile after the
   * API snapshot was fetched. The retry uses only already-fetched API data.
   *
   * @param {{
   *   user: Awaited<ReturnType<VrchatApi["getCurrentUser"]>>,
   *   trigger: SyncTrigger,
   *   syncId: string,
   *   startedAt: string,
   *   observedAt: string,
   *   initialSnapshot: Awaited<ReturnType<import("./database.js").DatabaseRepository["getSyncSnapshot"]>>,
   *   apiFavoriteGroups: Awaited<ReturnType<VrchatApi["listAllFavoriteGroups"]>>,
   *   groupSnapshotComplete: boolean,
   *   favoriteRelations: Parameters<typeof reconcileWorlds>[0]["favoriteRelations"],
   *   metadata: Parameters<typeof reconcileWorlds>[0]["metadata"],
   *   probes: Parameters<typeof reconcileWorlds>[0]["probes"],
   *   favoriteCount: number,
   *   metadataCount: number,
   *   probeCount: number
   * }} input
   */
  async #commitReconciledSnapshot(input) {
    let snapshot = input.initialSnapshot;
    let groupSnapshotComplete = input.groupSnapshotComplete;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const plan = reconcileWorlds({
        userId: input.user.id,
        previousWorlds: snapshot.worlds,
        favoriteRelations: input.favoriteRelations,
        metadata: input.metadata,
        probes: input.probes,
        observedAt: input.observedAt,
        syncId: input.syncId,
        isBaseline: snapshot.profile === null
      });
      let favoriteGroups = snapshot.favoriteGroups;
      /** @type {"success" | "stale"} */
      let favoriteGroupStatus = "stale";
      if (groupSnapshotComplete) {
        try {
          favoriteGroups = reconcileFavoriteGroups({
            userId: input.user.id,
            previousGroups: snapshot.favoriteGroups,
            currentGroups: input.apiFavoriteGroups,
            observedAt: input.observedAt
          });
          favoriteGroupStatus = favoriteGroups.some((group) => group.missingCount === 1)
            ? "stale"
            : "success";
        } catch (error) {
          if (!(error instanceof FavoriteGroupValidationError)) {
            throw error;
          }
          groupSnapshotComplete = false;
          favoriteGroups = snapshot.favoriteGroups;
        }
      }
      const previousRevisions = new Map(
        snapshot.worlds.map((world) => [world.worldId, world.revision])
      );
      try {
        const generation = await this.#repository.commitSync({
          profile: {
            userId: input.user.id,
            displayName: input.user.displayName,
            firstSeenAt: snapshot.profile?.firstSeenAt ?? input.observedAt,
            lastSuccessfulSyncAt: input.observedAt,
            createdBySchemaVersion:
              snapshot.profile?.createdBySchemaVersion ?? DATABASE_VERSION
          },
          worlds: plan.worlds,
          events: plan.events,
          favoriteGroups,
          expectedWorldRevisions: plan.worlds.map((world) => ({
            userId: input.user.id,
            worldId: world.worldId,
            revision: previousRevisions.get(world.worldId) ?? null
          })),
          expectedGeneration: snapshot.generation,
          settings: {
            activeProfileId: input.user.id,
            backoffUntil: null,
            consecutiveRateLimits: 0,
            lastSyncResult: "success",
            favoriteGroupStatus
          },
          syncRun: {
            syncId: input.syncId,
            userId: input.user.id,
            trigger: input.trigger,
            startedAt: input.startedAt,
            finishedAt: input.observedAt,
            result: "success",
            favoriteCount: input.favoriteCount,
            metadataCount: input.metadataCount,
            probeCount: input.probeCount,
            changeCount: plan.events.length,
            retryAt: null
          }
        });
        return { changeCount: plan.events.length, generation };
      } catch (error) {
        if (!(error instanceof GenerationConflictError) || attempt === 1) {
          throw error;
        }
        snapshot = await this.#repository.getSyncSnapshot(input.user.id);
      }
    }
    throw new GenerationConflictError(input.user.id, snapshot.generation, snapshot.generation);
  }

  /**
   * @param {{
   *   error: unknown,
   *   syncId: string,
   *   userId: string | null,
   *   trigger: SyncTrigger,
   *   startedAt: string,
   *   favoriteCount: number,
   *   metadataCount: number,
   *   probeCount: number
   * }} input
   * @returns {Promise<{
   *   scheduleResult: ScheduleResult,
   *   backoffUntil: number | null,
   *   publicResult: PublicSyncResult
   * }>}
   */
  async #recordFailure(input) {
    const now = this.#now();
    const classified = classifyFailure(input.error);
    /** @type {number | null} */
    let backoffUntil = null;

    if (input.error instanceof RateLimitedError) {
      const previousCount = await this.#repository.getSetting(
        SETTING_KEYS.consecutiveRateLimits
      );
      const retryAfter = input.error.retryAfterMs === null
        ? null
        : String(Math.max(1, Math.ceil(input.error.retryAfterMs / 1_000)));
      const backoff = calculateRateLimitBackoff({
        nowMs: now,
        previousCount: isNonNegativeInteger(previousCount) ? previousCount : 0,
        retryAfter,
        randomValue: this.#randomValue()
      });
      backoffUntil = backoff.backoffUntil;
      await this.#repository.setSettings({
        [SETTING_KEYS.consecutiveRateLimits]: backoff.consecutiveRateLimits,
        [SETTING_KEYS.backoffUntil]: backoffUntil,
        [SETTING_KEYS.lastSyncResult]: classified.runResult
      });
    } else {
      await this.#repository.setSettings({
        [SETTING_KEYS.lastSyncResult]: classified.runResult,
        ...(input.trigger === "manual" && isAuthCookiePreflightFailure(input.error)
          ? { [SETTING_KEYS.lastManualSyncAt]: null }
          : {})
      });
    }

    const retryAt = backoffUntil === null ? null : new Date(backoffUntil).toISOString();
    await this.#repository.recordSyncRun({
      syncId: input.syncId,
      userId: input.userId,
      trigger: input.trigger,
      startedAt: input.startedAt,
      finishedAt: new Date(now).toISOString(),
      result: classified.runResult,
      favoriteCount: input.favoriteCount,
      metadataCount: input.metadataCount,
      probeCount: input.probeCount,
      changeCount: 0,
      retryAt
    });

    return {
      scheduleResult: classified.scheduleResult,
      backoffUntil,
      publicResult: retryAt === null
        ? classified.publicResult
        : /** @type {PublicSyncResult} */ ({ ...classified.publicResult, retryAt })
    };
  }

  /** @param {string} userId @param {string} syncId @param {number} expectedGeneration */
  async #deliverNotifications(userId, syncId, expectedGeneration) {
    const claimedAt = new Date(this.#now()).toISOString();
    const claimed = await this.#repository.claimEvents(
      userId,
      claimedAt,
      undefined,
      {
        expectedGeneration,
        allowedKinds: NOTIFICATION_EVENT_KINDS
      }
    );
    if (claimed.length === 0) {
      return;
    }
    const eventIds = claimed.map((event) => event.eventId);
    const enabled = await this.#repository.getSetting(SETTING_KEYS.notificationsEnabled);
    if (enabled === false) {
      return;
    }

    let permission;
    try {
      permission = await this.#notifications.getPermissionLevel();
    } catch {
      await this.#repository.updateNotificationResult(eventIds, {
        notifiedAt: null,
        notificationError: "unavailable"
      }, { expectedGeneration });
      return;
    }
    if (permission !== "granted") {
      await this.#repository.updateNotificationResult(eventIds, {
        notifiedAt: null,
        notificationError: "permission_denied"
      }, { expectedGeneration });
      return;
    }

    if (await this.#repository.getDataGeneration(userId) !== expectedGeneration) {
      return;
    }

    let notificationId;
    try {
      notificationId = await this.#notifications.create(
        `${NOTIFICATION_ID_PREFIX}${safeNotificationSuffix(syncId)}`,
        {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "お気に入りワールドに変化があります",
          message: `${claimed.length}件の変化を記録しました。履歴を確認してください。`,
          buttons: [{ title: "履歴を見る" }]
        }
      );
    } catch {
      await this.#repository.updateNotificationResult(eventIds, {
        notifiedAt: null,
        notificationError: "unavailable"
      }, { expectedGeneration });
      return;
    }
    await this.#repository.updateNotificationResult(eventIds, {
      notifiedAt: notificationId === "" ? null : new Date(this.#now()).toISOString(),
      notificationError: notificationId === "" ? "api_rejected" : null
    }, { expectedGeneration });
  }

  /** @param {ScheduleResult} result @param {number | null} backoffUntil */
  async #scheduleAfterSync(result, backoffUntil) {
    const enabledSetting = await this.#repository.getSetting(SETTING_KEYS.autoSyncEnabled);
    const enabled = enabledSetting === undefined ? true : enabledSetting === true;
    if (!enabled) {
      await this.#alarms.clear(SYNC_ALARM_NAME);
      await this.#repository.setSettings({
        [SETTING_KEYS.nextSyncAt]: null,
        [SETTING_KEYS.watchdogUntil]: null
      });
      return;
    }

    const now = this.#now();
    const calculationResult = result === "conflict" ? "offline" : result;
    const when = result === "429"
      ? calculateNextSyncAt({ result, nowMs: now, backoffUntil })
      : calculateNextSyncAt({
          result: calculationResult,
          nowMs: now,
          randomValue: this.#randomValue()
        });
    await this.#alarms.create(SYNC_ALARM_NAME, when);
    await this.#repository.setSettings({
      [SETTING_KEYS.nextSyncAt]: when,
      [SETTING_KEYS.watchdogUntil]: result === "conflict" ? when : null,
      [SETTING_KEYS.lastAlarmError]: null
    });
  }

  async #recordAlarmFailureBestEffort() {
    try {
      await this.#repository.setSettings({
        [SETTING_KEYS.lastAlarmError]: "unavailable"
      });
    } catch {
      return;
    }
  }

  async #clearAutomaticScheduleBestEffort() {
    let failed = false;
    try {
      await this.#alarms.clear(SYNC_ALARM_NAME);
    } catch {
      failed = true;
    }
    try {
      await this.#repository.setSettings({
        [SETTING_KEYS.nextSyncAt]: null,
        [SETTING_KEYS.watchdogUntil]: null
      });
    } catch {
      failed = true;
    }
    if (failed) {
      await this.#recordAlarmFailureBestEffort();
    }
  }

  #nowForRecovery() {
    try {
      return this.#now();
    } catch {
      return null;
    }
  }

  #randomForRecovery() {
    try {
      return this.#randomValue();
    } catch {
      return null;
    }
  }

  /** @param {number} startedAt */
  async #armWatchdog(startedAt) {
    const enabledSetting = await this.#repository.getSetting(SETTING_KEYS.autoSyncEnabled);
    const enabled = enabledSetting === undefined ? true : enabledSetting === true;
    if (!enabled) {
      return;
    }
    const watchdogUntil = startedAt + SYNC_WATCHDOG_DELAY_MS;
    await this.#alarms.create(SYNC_ALARM_NAME, watchdogUntil);
    await this.#repository.setSettings({
      [SETTING_KEYS.nextSyncAt]: watchdogUntil,
      [SETTING_KEYS.watchdogUntil]: watchdogUntil
    });
  }

  /** @param {number} backoffUntil */
  async #scheduleAtBackoff(backoffUntil) {
    const enabledSetting = await this.#repository.getSetting(SETTING_KEYS.autoSyncEnabled);
    const enabled = enabledSetting === undefined ? true : enabledSetting === true;
    if (!enabled) {
      await this.#alarms.clear(SYNC_ALARM_NAME);
      await this.#repository.setSettings({
        [SETTING_KEYS.nextSyncAt]: null,
        [SETTING_KEYS.watchdogUntil]: null
      });
      return;
    }
    await this.#alarms.create(SYNC_ALARM_NAME, backoffUntil);
    await this.#repository.setSettings({
      [SETTING_KEYS.nextSyncAt]: backoffUntil,
      [SETTING_KEYS.watchdogUntil]: null
    });
  }

  #now() {
    const value = this.#clock();
    if (!isFiniteTimestamp(value)) {
      throw new RangeError("clock must return a non-negative finite timestamp");
    }
    return value;
  }

  #randomValue() {
    const value = this.#random();
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError("random must return a value between 0 and 1");
    }
    return value;
  }
}

/**
 * A syntactically valid, non-empty group response can still be truncated.
 * Preserve the previous classification unless every group name referenced by
 * the two complete world snapshots is present. Empty, unreferenced groups use
 * the reconciler's two-snapshot missingCount confirmation instead.
 *
 * @param {{
 *   currentGroups: Awaited<ReturnType<VrchatApi["listAllFavoriteGroups"]>>,
 *   relations: Awaited<ReturnType<VrchatApi["listAllFavoriteRelations"]>>,
 *   metadata: Awaited<ReturnType<VrchatApi["listAllFavoriteWorlds"]>>
 * }} input
 */
function isFavoriteGroupSnapshotConsistent(input) {
  const currentNames = new Set(input.currentGroups.map((group) => group.name));
  if (input.relations.some((relation) => (
    relation.tags.some((tag) => !currentNames.has(tag))
  ))) {
    return false;
  }
  return !input.metadata.some((world) => !currentNames.has(world.favoriteGroup));
}

/** @param {unknown} error */
function classifyFailure(error) {
  if (error instanceof AuthCookieRequiredError) {
    return failureClassification("auth", "auth_required", "AUTH_REQUIRED");
  }
  if (error instanceof AuthCookieConflictError) {
    return failureClassification("other", "failed", "AUTH_COOKIE_CONFLICT");
  }
  if (error instanceof AuthCookieCleanupError) {
    return failureClassification("other", "failed", "AUTH_COOKIE_CLEANUP_FAILED");
  }
  if (
    error instanceof AuthCookiePartitionedError
    || error instanceof AuthCookieSetupError
    || error instanceof AuthCookieBusyError
  ) {
    return failureClassification("other", "failed", "AUTH_COOKIE_UNAVAILABLE");
  }
  if (error instanceof AuthRequiredError) {
    return failureClassification("auth", "auth_required", "AUTH_REQUIRED");
  }
  if (error instanceof RateLimitedError) {
    return failureClassification("429", "rate_limited", "RATE_LIMITED");
  }
  if (error instanceof NetworkError) {
    return failureClassification("offline", "offline", "OFFLINE");
  }
  if (error instanceof ServerError) {
    return failureClassification("5xx", "failed", "VRCHAT_UNAVAILABLE");
  }
  if (
    error instanceof ApiSchemaError
    || error instanceof PaginationError
    || error instanceof UnexpectedRedirectError
    || error instanceof ForbiddenError
  ) {
    return failureClassification("schema", "api_incompatible", "API_INCOMPATIBLE");
  }
  if (error instanceof GenerationConflictError || error instanceof RevisionConflictError) {
    return failureClassification("conflict", "failed", "SYNC_CONFLICT");
  }
  return failureClassification("other", "failed", "SYNC_FAILED");
}

/** @param {unknown} error */
function isAuthCookiePreflightFailure(error) {
  return error instanceof AuthCookieRequiredError
    || error instanceof AuthCookieConflictError
    || error instanceof AuthCookiePartitionedError
    || error instanceof AuthCookieSetupError
    || error instanceof AuthCookieBusyError;
}

/**
 * @param {ScheduleResult} scheduleResult
 * @param {"success" | "auth_required" | "rate_limited" | "offline" | "api_incompatible" | "failed"} runResult
 * @param {"AUTH_REQUIRED" | "AUTH_COOKIE_UNAVAILABLE" | "AUTH_COOKIE_CONFLICT" | "AUTH_COOKIE_CLEANUP_FAILED" | "RATE_LIMITED" | "OFFLINE" | "VRCHAT_UNAVAILABLE" | "API_INCOMPATIBLE" | "SYNC_CONFLICT" | "SYNC_FAILED"} error
 */
function failureClassification(scheduleResult, runResult, error) {
  return {
    scheduleResult,
    runResult,
    publicResult: /** @type {PublicSyncResult} */ ({ ok: false, error })
  };
}

/** @param {unknown} value @returns {value is number} */
function isFiniteTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** @param {unknown} value @param {number} now @returns {value is number} */
function isFutureTimestamp(value, now) {
  return isFiniteTimestamp(value) && value > now;
}

/** @param {unknown} value @returns {value is number} */
function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** @param {string} value */
function safeNotificationSuffix(value) {
  const safe = value.replace(/[^a-zA-Z0-9_-]/gu, "-").slice(0, 80);
  return safe === "" ? "change" : safe;
}
