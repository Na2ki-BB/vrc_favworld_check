// @ts-check

import { VrchatApi } from "./lib/api.js";
import { AuthCookieBridge } from "./lib/auth-cookie-bridge.js";
import { ActiveRateLimitError, ApiSessionCoordinator, AUTH_STATUS_CACHE_KEY, createAuthStatusChecker } from "./lib/auth-status.js";
import { calculateRateLimitBackoff } from "./lib/schedule.js";
import { openDatabase } from "./lib/database.js";
import { installUserAgentRule } from "./lib/dnr.js";
import {
  ATTENTION_NOTIFICATION_ID_PREFIX,
  NOTIFICATION_ID_PREFIX,
  SETTINGS_SCHEDULE_WARNING,
  SETTING_KEYS,
  SYNC_ALARM_NAME,
  THUMBNAIL_ALARM_NAME,
  SyncService
} from "./lib/sync-service.js";

export const VRCHAT_LOGIN_URL = "https://vrchat.com/home/login";
export const HISTORY_DASHBOARD_PATH = "dashboard.html#events";
export const ATTENTION_DASHBOARD_PATH = "dashboard.html#attention";
export const ALL_WORLDS_DASHBOARD_PATH = "dashboard.html#all";

export const MESSAGE_TYPES = Object.freeze({
  getStatus: "GET_STATUS",
  checkAuthStatus: "CHECK_AUTH_STATUS",
  startSync: "START_SYNC",
  openVrchat: "OPEN_VRCHAT",
  openDashboard: "OPEN_DASHBOARD",
  updateSettings: "UPDATE_SETTINGS",
  settingsChanged: "SETTINGS_CHANGED",
  markHistoryRead: "MARK_HISTORY_READ",
  hideWorld: "HIDE_WORLD",
  restoreHiddenWorld: "RESTORE_HIDDEN_WORLD",
  purgeHiddenWorld: "PURGE_HIDDEN_WORLD",
  purgeAndUninstall: "PURGE_AND_UNINSTALL"
});

export const KEEPALIVE_INTERVAL_MS = 25_000;

/**
 * Open only the packaged history route. Callers cannot supply a URL or hash,
 * so popup and notification input can never influence the navigation target.
 *
 * @param {{
 *   resolveExtensionUrl: (path: string) => string,
 *   createTab: (details: {url: string}) => Promise<unknown>
 * }} dependencies
 */
export function createHistoryDashboardOpener(dependencies) {
  return async function openHistoryDashboard() {
    await dependencies.createTab({
      url: dependencies.resolveExtensionUrl(HISTORY_DASHBOARD_PATH)
    });
  };
}

/**
 * Open only the packaged attention dashboard route used by notifications.
 * No caller-controlled value can influence the URL or hash.
 *
 * @param {{
 *   resolveExtensionUrl: (path: string) => string,
 *   createTab: (details: {url: string}) => Promise<unknown>
 * }} dependencies
 * @returns {() => Promise<void>}
 */
export function createAttentionDashboardOpener(dependencies) {
  return async function openAttentionDashboard() {
    await dependencies.createTab({
      url: dependencies.resolveExtensionUrl(ATTENTION_DASHBOARD_PATH)
    });
  };
}

/**
 * Open the full saved world list from the popup, including current favorites.
 * @param {{
 *   resolveExtensionUrl: (path: string) => string,
 *   createTab: (details: {url: string}) => Promise<unknown>
 * }} dependencies
 */
export function createAllWorldsDashboardOpener(dependencies) {
  return async function openAllWorldsDashboard() {
    await dependencies.createTab({
      url: dependencies.resolveExtensionUrl(ALL_WORLDS_DASHBOARD_PATH)
    });
  };
}

/**
 * Keep notification navigation testable and limited to notifications created
 * by this extension. Chrome ignores the returned promises; the registration
 * boundary consumes failures so they do not become unhandled rejections.
 *
 * @param {{
 *   openHistoryDashboard: () => Promise<void>,
 *   openAttentionDashboard: () => Promise<void>
 * }} dependencies
 */
export function createHistoryNotificationHandlers(dependencies) {
  /** @param {string} notificationId */
  async function openKnownNotificationDestination(notificationId) {
    if (notificationId.startsWith(ATTENTION_NOTIFICATION_ID_PREFIX)) {
      await dependencies.openAttentionDashboard();
      return;
    }
    if (notificationId.startsWith(NOTIFICATION_ID_PREFIX)) {
      await dependencies.openHistoryDashboard();
    }
  }

  return {
    /** @param {string} notificationId */
    async onClicked(notificationId) {
      await openKnownNotificationDestination(notificationId);
    },
    /** @param {string} notificationId @param {number} buttonIndex */
    async onButtonClicked(notificationId, buttonIndex) {
      if (buttonIndex !== 0) {
        return;
      }
      await openKnownNotificationDestination(notificationId);
    }
  };
}

/**
 * Keep the MV3 worker alive only while one explicitly requested sync promise
 * is pending. Chrome recommends a harmless extension API call inside a
 * sub-30-second interval for long operations.
 *
 * @template T
 * @param {Promise<T>} operation
 * @param {{
 *   pulse?: () => unknown,
 *   setInterval?: typeof globalThis.setInterval,
 *   clearInterval?: typeof globalThis.clearInterval
 * }} [dependencies]
 * @returns {Promise<T>}
 */
export async function keepServiceWorkerAlive(operation, dependencies = {}) {
  const pulse = dependencies.pulse ?? (() => chrome.runtime.getPlatformInfo());
  const startInterval = dependencies.setInterval ?? globalThis.setInterval;
  const stopInterval = dependencies.clearInterval ?? globalThis.clearInterval;
  const timer = startInterval(() => {
    void Promise.resolve().then(pulse).catch(() => undefined);
  }, KEEPALIVE_INTERVAL_MS);
  try {
    return await operation;
  } finally {
    stopInterval(timer);
  }
}

/**
 * Gate every network-capable sync behind successful DNR installation and
 * share one keepalive wrapper across concurrent callers.
 *
 * @param {{
 *   ensureUserAgentRule: () => Promise<void>,
 *   startSync: (trigger: "manual" | "alarm" | "resume" | "thumbnail") => Promise<Awaited<ReturnType<SyncService["start"]>>>,
 *   keepAlive: <T>(operation: Promise<T>) => Promise<T>,
 *   canStart?: () => boolean | Promise<boolean>,
 *   afterSync?: () => unknown
 * }} dependencies
 */
export function createGatedSyncRunner(dependencies) {
  /** @type {Promise<Awaited<ReturnType<SyncService["start"]>> | {ok: false, error: "SECURITY_RULE_UNAVAILABLE" | "MAINTENANCE_IN_PROGRESS"}> | null} */
  let active = null;
  /** @type {"manual" | "alarm" | "resume" | "thumbnail" | null} */
  let activeTrigger = null;

  /**
   * @param {"manual" | "alarm" | "resume" | "thumbnail"} trigger
   * @returns {Promise<Awaited<ReturnType<SyncService["start"]>> | {ok: false, error: "SECURITY_RULE_UNAVAILABLE" | "MAINTENANCE_IN_PROGRESS"}>}
   */
  return function runSync(trigger) {
    if (active !== null) {
      if (activeTrigger === "thumbnail" && trigger !== "thumbnail") {
        return active.then(() => runSync(trigger));
      }
      return active;
    }
    const operation = (async () => {
      if (dependencies.canStart !== undefined && !await dependencies.canStart()) {
        return /** @type {const} */ ({ ok: false, error: "MAINTENANCE_IN_PROGRESS" });
      }
      try {
        await dependencies.ensureUserAgentRule();
      } catch {
        return /** @type {const} */ ({ ok: false, error: "SECURITY_RULE_UNAVAILABLE" });
      }
      if (dependencies.canStart !== undefined && !await dependencies.canStart()) {
        return /** @type {const} */ ({ ok: false, error: "MAINTENANCE_IN_PROGRESS" });
      }
      const result = await dependencies.keepAlive(dependencies.startSync(trigger));
      try {
        await dependencies.afterSync?.();
      } catch {
        // Badge refresh is a derived, best-effort view of durable history.
      }
      return result;
    })();
    const tracked = operation.finally(() => {
      if (active === tracked) {
        active = null;
        activeTrigger = null;
      }
    });
    active = tracked;
    activeTrigger = trigger;
    return tracked;
  };
}

/**
 * Build the unread badge solely from durable IndexedDB state. Badge failures
 * never alter synchronization or history state.
 *
 * @param {{
 *   repository: Pick<import("./lib/database.js").DatabaseRepository, "getSetting" | "getUnreadSummary">,
 *   setBadgeText: (details: {text: string}) => Promise<void>,
 *   setBadgeBackgroundColor: (details: {color: string}) => Promise<void>
 * }} dependencies
 */
export function createBadgeUpdater(dependencies) {
  return async function updateBadge() {
    const activeProfileId = await dependencies.repository.getSetting(
      SETTING_KEYS.activeProfileId
    );
    const summary = typeof activeProfileId === "string"
      ? await dependencies.repository.getUnreadSummary(activeProfileId)
      : { exact: true, uncertain: false, count: 0 };
    const unreadCount = summary.count ?? 0;
    const text = !summary.exact || summary.uncertain ? "?"
      : unreadCount <= 0 ? "" : unreadCount > 99 ? "99+" : String(unreadCount);
    await dependencies.setBadgeBackgroundColor({ color: "#8B3028" });
    await dependencies.setBadgeText({ text });
  };
}

/**
 * Coordinate the only destructive operation. A persistent gate is written
 * before alarms are stopped. All user records are cleared atomically while a
 * minimal guard remains in the same database, then uninstall is requested.
 * Every worker/browser interruption boundary therefore remains fail-closed.
 *
 * @param {{
 *   service: Pick<SyncService, "syncing" | "repairScheduleBestEffort"> &
 *     Partial<Pick<SyncService, "repairThumbnailScheduleBestEffort" | "recordMutating">>,
 *   repository: Pick<import("./lib/database.js").DatabaseRepository, "beginPurge" | "recoverFromFailedPurge" | "purgeAllData">,
 *   clearAlarm: () => Promise<boolean>,
 *   cleanupAuthCookies: () => Promise<void>,
 *   clearBadge: () => Promise<void>,
 *   uninstallSelf: () => Promise<void>
 * }} dependencies
 */
export function createPurgeController(dependencies) {
  let purging = false;

  const canStartSync = () => !purging;

  const resetGuardBestEffort = async () => {
    try {
      await dependencies.repository.recoverFromFailedPurge();
      return true;
    } catch {
      return false;
    }
  };

  const purgeAndUninstall = async () => {
    if (purging || dependencies.service.syncing || dependencies.service.recordMutating) {
      return /** @type {const} */ ({
        ok: false,
        error: "SYNC_IN_PROGRESS",
        dataDeleted: false
      });
    }
    purging = true;
    let guardEnabledByThisCall = false;

    try {
      guardEnabledByThisCall = await dependencies.repository.beginPurge();
      await dependencies.clearAlarm();
      await dependencies.cleanupAuthCookies();
      await dependencies.repository.purgeAllData();
    } catch {
      if (guardEnabledByThisCall && await resetGuardBestEffort()) {
        purging = false;
        try {
          await dependencies.service.repairScheduleBestEffort();
          await dependencies.service.repairThumbnailScheduleBestEffort?.();
        } catch {
          // The failed purge remains recoverable at browser startup.
        }
      }
      return /** @type {const} */ ({
        ok: false,
        error: "DELETE_FAILED",
        dataDeleted: false
      });
    }

    try {
      await dependencies.clearBadge();
    } catch {
      // User records are already purged; a cosmetic badge failure cannot undo it.
    }

    try {
      await dependencies.uninstallSelf();
      return /** @type {const} */ ({ ok: true, dataDeleted: true });
    } catch {
      return /** @type {const} */ ({
        ok: false,
        error: "UNINSTALL_FAILED",
        dataDeleted: true
      });
    }
  };

  return { canStartSync, purgeAndUninstall };
}

/**
 * Build an alarm event boundary that always consumes failures. Automatic sync
 * is checked before the DNR/network runner, and any rejected stage attempts a
 * non-network schedule recovery so a consumed one-shot alarm is not silently
 * lost.
 *
 * @param {{
 *   getService: () => Promise<Pick<SyncService,
 *     "prepareAutomaticSync" | "resolveAlarmTrigger" |
 *     "rearmWatchdogForActiveSync" | "repairScheduleBestEffort"> &
 *     Partial<Pick<SyncService, "repairThumbnailScheduleBestEffort">>>,
 *   getRunner: () => Promise<ReturnType<typeof createGatedSyncRunner>>
 * }} dependencies
 */
export function createAlarmEventHandler(dependencies) {
  /** @param {{name: string, scheduledTime?: number}} alarm */
  return async function handleAlarm(alarm) {
    if (alarm.name !== SYNC_ALARM_NAME && alarm.name !== THUMBNAIL_ALARM_NAME) {
      return;
    }

    /** @type {Awaited<ReturnType<typeof dependencies.getService>> | null} */
    let service = null;
    try {
      const resolved = await Promise.all([
        dependencies.getService(),
        dependencies.getRunner()
      ]);
      service = resolved[0];
      const runSync = resolved[1];
      if (alarm.name === THUMBNAIL_ALARM_NAME) {
        await runSync("thumbnail");
        await service.repairThumbnailScheduleBestEffort?.();
        return;
      }
      if (!await service.prepareAutomaticSync()) {
        return;
      }
      const trigger = await service.resolveAlarmTrigger(alarm.scheduledTime);
      if (trigger === "resume" && await service.rearmWatchdogForActiveSync()) {
        await runSync(trigger);
        return;
      }
      const result = await runSync(trigger);
      if (!result.ok && (result.error === "SECURITY_RULE_UNAVAILABLE"
        || result.error === "MAINTENANCE_IN_PROGRESS")) {
        // A one-shot alarm is already consumed, even when a short record
        // reservation keeps it out of the runner. Recover the ordinary sync
        // schedule; the service still honors purge and disabled-auto guards.
        await service.repairScheduleBestEffort();
      }
    } catch {
      if (service === null) {
        try {
          service = await dependencies.getService();
        } catch {
          return;
        }
      }
      try {
        if (alarm.name === THUMBNAIL_ALARM_NAME) {
          await service.repairThumbnailScheduleBestEffort?.();
        } else {
          await service.repairScheduleBestEffort();
        }
      } catch {
        return;
      }
    }
  };
}

/**
 * Create the closed command router used by popup/dashboard pages. It never
 * accepts a URL, API path, request headers, credentials, or arbitrary DB key.
 *
 * @param {{
 *   service: Pick<SyncService, "getStatus" | "updateSettings" | "repairSchedule" | "markHistoryRead"> &
 *     Partial<Pick<SyncService, "repairThumbnailScheduleBestEffort" | "mutateRecord">>,
 *   canMutateRecord?: () => boolean,
 *   checkAuthStatus?: () => Promise<import("./lib/auth-status.js").AuthStatus>,
 *   startSync: ReturnType<typeof createGatedSyncRunner>,
 *   openVrchat: () => Promise<void>,
 *   openDashboard: () => Promise<void>,
 *   refreshBadge: () => Promise<void>,
 *   purgeAndUninstall: () => Promise<
 *     {ok: true, dataDeleted: true} |
 *     {ok: false, error: "SYNC_IN_PROGRESS" | "DELETE_FAILED" | "UNINSTALL_FAILED", dataDeleted: boolean}
 *   >
 * }} dependencies
 */
export function createMessageHandler(dependencies) {
  /** @param {unknown} message */
  return async function handleMessage(message) {
    if (!isRecord(message) || typeof message.type !== "string") {
      return { ok: false, error: "INVALID_REQUEST" };
    }

    try {
      if (message.type === MESSAGE_TYPES.getStatus) {
        return { ok: true, status: await dependencies.service.getStatus() };
      }
      if (message.type === MESSAGE_TYPES.checkAuthStatus && dependencies.checkAuthStatus) {
        return { ok: true, auth: await dependencies.checkAuthStatus() };
      }
      if (message.type === MESSAGE_TYPES.startSync) {
        return dependencies.startSync("manual");
      }
      if (message.type === MESSAGE_TYPES.openVrchat) {
        await dependencies.openVrchat();
        return { ok: true };
      }
      if (message.type === MESSAGE_TYPES.openDashboard) {
        await dependencies.openDashboard();
        return { ok: true };
      }
      if (message.type === MESSAGE_TYPES.updateSettings) {
        if (
          typeof message.autoSyncEnabled !== "boolean"
          || typeof message.notificationsEnabled !== "boolean"
        ) {
          return { ok: false, error: "INVALID_REQUEST" };
        }
        const result = await dependencies.service.updateSettings({
          autoSyncEnabled: message.autoSyncEnabled,
          notificationsEnabled: message.notificationsEnabled
        });
        try {
          await dependencies.refreshBadge();
        } catch {
          // Settings are durable; the badge is repaired on the next lifecycle event.
        }
        return {
          ok: true,
          settingsSaved: result.settingsSaved,
          scheduleWarning: result.scheduleWarning === SETTINGS_SCHEDULE_WARNING
            ? SETTINGS_SCHEDULE_WARNING
            : null
        };
      }
      if (message.type === MESSAGE_TYPES.settingsChanged) {
        await dependencies.service.repairSchedule();
        await dependencies.service.repairThumbnailScheduleBestEffort?.();
        try {
          await dependencies.refreshBadge();
        } catch {
          // Imported settings are durable even if the derived badge is unavailable.
        }
        return { ok: true };
      }
      if (message.type === MESSAGE_TYPES.markHistoryRead) {
        if (!await dependencies.service.markHistoryRead()) {
          return { ok: false, error: "NO_ACTIVE_PROFILE" };
        }
        try {
          await dependencies.refreshBadge();
        } catch {
          // The read marker is the source of truth; badge repair is best-effort.
        }
        return { ok: true, unreadCount: 0 };
      }
      if (message.type === MESSAGE_TYPES.hideWorld
        || message.type === MESSAGE_TYPES.restoreHiddenWorld
        || message.type === MESSAGE_TYPES.purgeHiddenWorld) {
        if (!isRecordMutationMessage(message) || dependencies.service.mutateRecord === undefined) {
          return { ok: false, error: "INVALID_REQUEST" };
        }
        // This synchronous in-worker gate pairs with the service's immediate
        // reservation, so whole-profile purge cannot slip between the two.
        if (dependencies.canMutateRecord?.() === false) {
          return { ok: false, error: "MAINTENANCE_IN_PROGRESS" };
        }
        const result = await dependencies.service.mutateRecord(
          message.type === MESSAGE_TYPES.hideWorld ? "hide"
            : message.type === MESSAGE_TYPES.restoreHiddenWorld ? "restore" : "purge",
          {
            userId: message.userId,
            worldId: message.worldId,
            expectedGeneration: message.expectedGeneration,
            expectedPresentationGeneration: message.expectedPresentationGeneration,
            expectedRevision: message.expectedRevision
          }
        );
        if (result.ok) {
          try { await dependencies.refreshBadge(); }
          catch { /* The committed record remains the source of truth. */ }
        }
        return result;
      }
      if (message.type === MESSAGE_TYPES.purgeAndUninstall) {
        return dependencies.purgeAndUninstall();
      }
      return { ok: false, error: "INVALID_REQUEST" };
    } catch {
      return { ok: false, error: "INTERNAL_ERROR" };
    }
  };
}

function registerChromeBackground() {
  const repositoryPromise = openDatabase();
  const authCookieBridge = new AuthCookieBridge({ cookies: chrome.cookies });
  const apiSessions = new ApiSessionCoordinator();
  const api = new VrchatApi();
  const alarmAdapter = {
    get: (/** @type {string} */ name) => chrome.alarms.get(name),
    create: async (
      /** @type {string} */ name,
      /** @type {number} */ when
    ) => {
      await chrome.alarms.create(name, { when });
    },
    clear: (/** @type {string} */ name) => chrome.alarms.clear(name)
  };
  const installRule = () => installUserAgentRule({
    runtimeId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    updateDynamicRules: (update) => (
      chrome.declarativeNetRequest.updateDynamicRules(update)
    ),
    getDynamicRules: () => chrome.declarativeNetRequest.getDynamicRules()
  });
  const ensureUserAgentRule = () => installRule();
  const servicePromise = repositoryPromise.then((repository) => new SyncService({
    repository,
    api,
    alarms: alarmAdapter,
    notifications: {
      getPermissionLevel: () => chrome.notifications.getPermissionLevel(),
      create: (id, options) => chrome.notifications.create(id, options)
    },
    withApiSession: (operation) => apiSessions.run(async () => {
      // A queued sync must also honor a limit observed by an earlier auth probe.
      const until = await repository.getSetting(SETTING_KEYS.backoffUntil);
      if (typeof until === "number" && Number.isFinite(until) && until > Date.now()) {
        throw new ActiveRateLimitError(until, Date.now());
      }
      return authCookieBridge.withTemporaryApiCookies(operation);
    })
  }));

  const badgeUpdaterPromise = repositoryPromise.then((repository) => createBadgeUpdater({
    repository,
    setBadgeText: (details) => chrome.action.setBadgeText(details),
    setBadgeBackgroundColor: (details) => chrome.action.setBadgeBackgroundColor(details)
  }));
  const refreshBadge = async () => {
    const updateBadge = await badgeUpdaterPromise;
    await updateBadge();
  };

  const initialize = async () => {
    const ruleReady = installRule().catch(() => undefined);
    const cookieCleanup = apiSessions.run(() => authCookieBridge.cleanupStaleCookies()).catch(() => undefined);
    try {
      const service = await servicePromise;
      await service.repairScheduleBestEffort();
      await service.repairThumbnailScheduleBestEffort();
    } catch {
      // A later lifecycle event or user action retries initialization.
    }
    await ruleReady;
    await cookieCleanup;
    try {
      await refreshBadge();
    } catch {
      // Badge state is repaired again after the next sync or history visit.
    }
  };

  const openVrchat = async () => {
    await chrome.tabs.create({ url: VRCHAT_LOGIN_URL });
  };
  /** @type {{
   *   resolveExtensionUrl: (path: string) => string,
   *   createTab: (details: {url: string}) => Promise<unknown>
   * }} */
  const openerDependencies = {
    resolveExtensionUrl: (path) => chrome.runtime.getURL(path),
    createTab: async (details) => {
      await chrome.tabs.create(details);
    }
  };
  const openDashboard = createAttentionDashboardOpener(openerDependencies);
  const openHistoryDashboard = createHistoryDashboardOpener(openerDependencies);
  const notificationHandlers = createHistoryNotificationHandlers({
    openHistoryDashboard,
    openAttentionDashboard: createAttentionDashboardOpener(openerDependencies)
  });

  const purgeControllerPromise = Promise.all([servicePromise, repositoryPromise])
    .then(([service, repository]) => createPurgeController({
      service,
      repository,
      clearAlarm: async () => {
        const cleared = await chrome.alarms.clear(SYNC_ALARM_NAME);
        await chrome.alarms.clear(THUMBNAIL_ALARM_NAME);
        return cleared;
      },
      cleanupAuthCookies: () => apiSessions.run(() => authCookieBridge.cleanupStaleCookies()),
      clearBadge: () => chrome.action.setBadgeText({ text: "" }),
      uninstallSelf: () => chrome.management.uninstallSelf({ showConfirmDialog: true })
    }));
  const runnerPromise = Promise.all([servicePromise, purgeControllerPromise])
    .then(([service, purgeController]) => createGatedSyncRunner({
      ensureUserAgentRule,
      startSync: (trigger) => service.start(trigger),
      keepAlive: (operation) => keepServiceWorkerAlive(operation),
      canStart: () => purgeController.canStartSync() && !service.recordMutating,
      afterSync: refreshBadge
    }));
  const authCheckerPromise = Promise.all([repositoryPromise, servicePromise, purgeControllerPromise])
    .then(([repository, service, purgeController]) => createAuthStatusChecker({
      sessions: apiSessions,
      loadCache: () => repository.getSetting(AUTH_STATUS_CACHE_KEY),
      saveCache: (status) => repository.setSetting(AUTH_STATUS_CACHE_KEY, status),
      canCheck: () => purgeController.canStartSync() && !service.syncing && !service.recordMutating,
      isMaintenancePending: async () => await repository.getSetting(SETTING_KEYS.purgePending) === true,
      getBackoffUntil: async () => {
        const until = await repository.getSetting(SETTING_KEYS.backoffUntil);
        return typeof until === "number" && Number.isFinite(until) ? until : null;
      },
      recordRateLimit: async (error) => {
        const now = Date.now();
        const previous = await repository.getSetting(SETTING_KEYS.consecutiveRateLimits);
        const existing = await repository.getSetting(SETTING_KEYS.backoffUntil);
        const backoff = calculateRateLimitBackoff({
          nowMs: now,
          previousCount: typeof previous === "number" && Number.isSafeInteger(previous) && previous >= 0 ? previous : 0,
          retryAfter: error.retryAt === null ? null : String(Math.max(1, Math.ceil((error.retryAt - now) / 1_000))),
          randomValue: Math.random()
        });
        const until = Math.max(backoff.backoffUntil, typeof existing === "number" && Number.isFinite(existing) ? existing : 0);
        await repository.setSettings({
          [SETTING_KEYS.backoffUntil]: until,
          [SETTING_KEYS.consecutiveRateLimits]: backoff.consecutiveRateLimits
        });
        return until;
      },
      ensureUserAgentRule,
      probe: () => authCookieBridge.withTemporaryApiCookies(() => api.getCurrentUser({maxRetries: 0, timeoutMs: 5_000}))
    }));
  const handlerPromise = Promise.all([
    servicePromise,
    runnerPromise,
    purgeControllerPromise,
    authCheckerPromise
  ])
    .then(([service, startSync, purgeController, authChecker]) => createMessageHandler({
      service,
      checkAuthStatus: () => authChecker.check(),
      startSync,
      openVrchat,
      openDashboard,
      refreshBadge,
      purgeAndUninstall: purgeController.purgeAndUninstall,
      canMutateRecord: purgeController.canStartSync
    }));
  const handleAlarm = createAlarmEventHandler({
    getService: () => servicePromise,
    getRunner: () => runnerPromise
  });

  chrome.runtime.onInstalled.addListener(() => {
    void initialize();
  });
  chrome.runtime.onStartup.addListener(() => {
    void initialize();
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    void handleAlarm(alarm);
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    void handlerPromise
      .then((handler) => handler(message))
      .then(sendResponse, () => sendResponse({ ok: false, error: "INTERNAL_ERROR" }));
    return true;
  });
  chrome.notifications.onClicked.addListener((notificationId) => {
    void notificationHandlers.onClicked(notificationId).catch(() => undefined);
  });
  chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
    void notificationHandlers.onButtonClicked(notificationId, buttonIndex)
      .catch(() => undefined);
  });
}

/**
 * A closed schema prevents arbitrary store/key selection and coerced IDs or
 * generations. Canonical identifiers are checked again by the transaction.
 * @param {Record<string, unknown>} value
 * @returns {value is {type: string, userId: string, worldId: string,
 *   expectedGeneration: number, expectedPresentationGeneration: number, expectedRevision: number}}
 */
function isRecordMutationMessage(value) {
  const keys = ["type", "userId", "worldId", "expectedGeneration", "expectedPresentationGeneration", "expectedRevision"];
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
    && typeof value.type === "string"
    && typeof value.userId === "string"
    && /^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.userId)
    && typeof value.worldId === "string"
    && /^wrld_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.worldId)
    && [value.expectedGeneration, value.expectedPresentationGeneration, value.expectedRevision]
      .every((number) => typeof number === "number" && Number.isSafeInteger(number) && number >= 0);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (typeof chrome !== "undefined" && typeof chrome.runtime?.id === "string") {
  registerChromeBackground();
}
