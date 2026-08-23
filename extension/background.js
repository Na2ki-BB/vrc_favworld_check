// @ts-check

import { VrchatApi } from "./lib/api.js";
import { AuthCookieBridge } from "./lib/auth-cookie-bridge.js";
import { openDatabase } from "./lib/database.js";
import { installUserAgentRule } from "./lib/dnr.js";
import {
  NOTIFICATION_ID_PREFIX,
  SETTINGS_SCHEDULE_WARNING,
  SETTING_KEYS,
  SYNC_ALARM_NAME,
  SyncService
} from "./lib/sync-service.js";

export const VRCHAT_LOGIN_URL = "https://vrchat.com/home/login";
export const HISTORY_DASHBOARD_PATH = "dashboard.html#events";

export const MESSAGE_TYPES = Object.freeze({
  getStatus: "GET_STATUS",
  startSync: "START_SYNC",
  openVrchat: "OPEN_VRCHAT",
  openDashboard: "OPEN_DASHBOARD",
  updateSettings: "UPDATE_SETTINGS",
  settingsChanged: "SETTINGS_CHANGED",
  markHistoryRead: "MARK_HISTORY_READ",
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
 * Keep notification navigation testable and limited to notifications created
 * by this extension. Chrome ignores the returned promises; the registration
 * boundary consumes failures so they do not become unhandled rejections.
 *
 * @param {{openHistoryDashboard: () => Promise<void>}} dependencies
 */
export function createHistoryNotificationHandlers(dependencies) {
  return {
    /** @param {string} notificationId */
    async onClicked(notificationId) {
      if (notificationId.startsWith(NOTIFICATION_ID_PREFIX)) {
        await dependencies.openHistoryDashboard();
      }
    },
    /** @param {string} notificationId @param {number} buttonIndex */
    async onButtonClicked(notificationId, buttonIndex) {
      if (notificationId.startsWith(NOTIFICATION_ID_PREFIX) && buttonIndex === 0) {
        await dependencies.openHistoryDashboard();
      }
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
 *   startSync: (trigger: "manual" | "alarm" | "resume") => Promise<Awaited<ReturnType<SyncService["start"]>>>,
 *   keepAlive: <T>(operation: Promise<T>) => Promise<T>,
 *   canStart?: () => boolean | Promise<boolean>,
 *   afterSync?: () => unknown
 * }} dependencies
 */
export function createGatedSyncRunner(dependencies) {
  /** @type {Promise<Awaited<ReturnType<SyncService["start"]>> | {ok: false, error: "SECURITY_RULE_UNAVAILABLE" | "MAINTENANCE_IN_PROGRESS"}> | null} */
  let active = null;

  /** @param {"manual" | "alarm" | "resume"} trigger */
  return function runSync(trigger) {
    if (active !== null) {
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
      }
    });
    active = tracked;
    return tracked;
  };
}

/**
 * Build the unread badge solely from durable IndexedDB state. Badge failures
 * never alter synchronization or history state.
 *
 * @param {{
 *   repository: Pick<import("./lib/database.js").DatabaseRepository, "getSetting" | "getUnreadCount">,
 *   setBadgeText: (details: {text: string}) => Promise<void>,
 *   setBadgeBackgroundColor: (details: {color: string}) => Promise<void>
 * }} dependencies
 */
export function createBadgeUpdater(dependencies) {
  return async function updateBadge() {
    const activeProfileId = await dependencies.repository.getSetting(
      SETTING_KEYS.activeProfileId
    );
    const unreadCount = typeof activeProfileId === "string"
      ? await dependencies.repository.getUnreadCount(activeProfileId)
      : 0;
    const text = unreadCount <= 0 ? "" : unreadCount > 99 ? "99+" : String(unreadCount);
    await dependencies.setBadgeBackgroundColor({ color: "#B4234D" });
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
 *   service: Pick<SyncService, "syncing" | "repairScheduleBestEffort">,
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
    if (purging || dependencies.service.syncing) {
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
 *     "rearmWatchdogForActiveSync" | "repairScheduleBestEffort">>,
 *   getRunner: () => Promise<ReturnType<typeof createGatedSyncRunner>>
 * }} dependencies
 */
export function createAlarmEventHandler(dependencies) {
  /** @param {{name: string, scheduledTime?: number}} alarm */
  return async function handleAlarm(alarm) {
    if (alarm.name !== SYNC_ALARM_NAME) {
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
      if (!await service.prepareAutomaticSync()) {
        return;
      }
      const trigger = await service.resolveAlarmTrigger(alarm.scheduledTime);
      if (trigger === "resume" && await service.rearmWatchdogForActiveSync()) {
        await runSync(trigger);
        return;
      }
      const result = await runSync(trigger);
      if (!result.ok && result.error === "SECURITY_RULE_UNAVAILABLE") {
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
        await service.repairScheduleBestEffort();
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
 *   service: Pick<SyncService, "getStatus" | "updateSettings" | "repairSchedule" | "markHistoryRead">,
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
    api: new VrchatApi(),
    alarms: alarmAdapter,
    notifications: {
      getPermissionLevel: () => chrome.notifications.getPermissionLevel(),
      create: (id, options) => chrome.notifications.create(id, options)
    },
    withApiSession: (operation) => authCookieBridge.withTemporaryApiCookies(operation)
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
    const cookieCleanup = authCookieBridge.cleanupStaleCookies().catch(() => undefined);
    try {
      const service = await servicePromise;
      await service.repairScheduleBestEffort();
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
  const openDashboard = createHistoryDashboardOpener({
    resolveExtensionUrl: (path) => chrome.runtime.getURL(path),
    createTab: async (details) => {
      await chrome.tabs.create(details);
    }
  });
  const notificationHandlers = createHistoryNotificationHandlers({
    openHistoryDashboard: openDashboard
  });

  const purgeControllerPromise = Promise.all([servicePromise, repositoryPromise])
    .then(([service, repository]) => createPurgeController({
      service,
      repository,
      clearAlarm: () => chrome.alarms.clear(SYNC_ALARM_NAME),
      cleanupAuthCookies: () => authCookieBridge.cleanupStaleCookies(),
      clearBadge: () => chrome.action.setBadgeText({ text: "" }),
      uninstallSelf: () => chrome.management.uninstallSelf({ showConfirmDialog: true })
    }));
  const runnerPromise = Promise.all([servicePromise, purgeControllerPromise])
    .then(([service, purgeController]) => createGatedSyncRunner({
      ensureUserAgentRule,
      startSync: (trigger) => service.start(trigger),
      keepAlive: (operation) => keepServiceWorkerAlive(operation),
      canStart: purgeController.canStartSync,
      afterSync: refreshBadge
    }));
  const handlerPromise = Promise.all([
    servicePromise,
    runnerPromise,
    purgeControllerPromise
  ])
    .then(([service, startSync, purgeController]) => createMessageHandler({
      service,
      startSync,
      openVrchat,
      openDashboard,
      refreshBadge,
      purgeAndUninstall: purgeController.purgeAndUninstall
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

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (typeof chrome !== "undefined" && typeof chrome.runtime?.id === "string") {
  registerChromeBackground();
}
