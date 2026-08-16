// @ts-check

import { VrchatApi } from "./lib/api.js";
import { openDatabase } from "./lib/database.js";
import { installUserAgentRule } from "./lib/dnr.js";
import {
  NOTIFICATION_ID_PREFIX,
  SYNC_ALARM_NAME,
  SyncService
} from "./lib/sync-service.js";

export const VRCHAT_LOGIN_URL = "https://vrchat.com/home/login";

export const MESSAGE_TYPES = Object.freeze({
  getStatus: "GET_STATUS",
  startSync: "START_SYNC",
  openVrchat: "OPEN_VRCHAT",
  openDashboard: "OPEN_DASHBOARD",
  updateSettings: "UPDATE_SETTINGS",
  settingsChanged: "SETTINGS_CHANGED"
});

export const KEEPALIVE_INTERVAL_MS = 25_000;

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
 *   keepAlive: <T>(operation: Promise<T>) => Promise<T>
 * }} dependencies
 */
export function createGatedSyncRunner(dependencies) {
  /** @type {Promise<Awaited<ReturnType<SyncService["start"]>> | {ok: false, error: "SECURITY_RULE_UNAVAILABLE"}> | null} */
  let active = null;

  /** @param {"manual" | "alarm" | "resume"} trigger */
  return function runSync(trigger) {
    if (active !== null) {
      return active;
    }
    const operation = (async () => {
      try {
        await dependencies.ensureUserAgentRule();
      } catch {
        return /** @type {const} */ ({ ok: false, error: "SECURITY_RULE_UNAVAILABLE" });
      }
      return dependencies.keepAlive(dependencies.startSync(trigger));
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
 *   service: Pick<SyncService, "getStatus" | "updateSettings" | "repairSchedule">,
 *   startSync: ReturnType<typeof createGatedSyncRunner>,
 *   openVrchat: () => Promise<void>,
 *   openDashboard: () => Promise<void>
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
        await dependencies.service.updateSettings({
          autoSyncEnabled: message.autoSyncEnabled,
          notificationsEnabled: message.notificationsEnabled
        });
        return { ok: true };
      }
      if (message.type === MESSAGE_TYPES.settingsChanged) {
        await dependencies.service.repairSchedule();
        return { ok: true };
      }
      return { ok: false, error: "INVALID_REQUEST" };
    } catch {
      return { ok: false, error: "INTERNAL_ERROR" };
    }
  };
}

function registerChromeBackground() {
  const repositoryPromise = openDatabase();
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
    alarms: {
      get: (name) => chrome.alarms.get(name),
      create: async (name, when) => {
        await chrome.alarms.create(name, { when });
      },
      clear: (name) => chrome.alarms.clear(name)
    },
    notifications: {
      getPermissionLevel: () => chrome.notifications.getPermissionLevel(),
      create: (id, options) => chrome.notifications.create(id, options)
    }
  }));

  const initialize = async () => {
    const ruleReady = installRule();
    const service = await servicePromise;
    await service.repairSchedule();
    await ruleReady;
  };

  const openVrchat = async () => {
    await chrome.tabs.create({ url: VRCHAT_LOGIN_URL });
  };
  const openDashboard = async () => {
    await chrome.runtime.openOptionsPage();
  };

  const runnerPromise = servicePromise.then((service) => createGatedSyncRunner({
    ensureUserAgentRule,
    startSync: (trigger) => service.start(trigger),
    keepAlive: (operation) => keepServiceWorkerAlive(operation)
  }));
  const handlerPromise = Promise.all([servicePromise, runnerPromise])
    .then(([service, startSync]) => createMessageHandler({
      service,
      startSync,
      openVrchat,
      openDashboard
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
    if (notificationId.startsWith(NOTIFICATION_ID_PREFIX)) {
      void openDashboard();
    }
  });
  chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
    if (notificationId.startsWith(NOTIFICATION_ID_PREFIX) && buttonIndex === 0) {
      void openDashboard();
    }
  });
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (typeof chrome !== "undefined" && typeof chrome.runtime?.id === "string") {
  registerChromeBackground();
}
