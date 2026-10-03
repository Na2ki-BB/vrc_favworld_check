// @ts-check

import {
  ApiSchemaError,
  isAllowedVrchatImageUrl,
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
  RevisionConflictError,
  RecordStateConflictError
} from "./database.js";
import {
  ThumbnailError,
  ThumbnailFetchError,
  fetchAndEncodeThumbnail
} from "./thumbnail.js";
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

export const THUMBNAIL_ALARM_NAME = "thumbnail-next";
export const THUMBNAIL_BATCH_DELAY_MS = 60_000;
export const SYNC_ALARM_NAME = "sync-next";
export const MANUAL_SYNC_COOLDOWN_MS = 5 * 60 * 1_000;
export const SYNC_WATCHDOG_DELAY_MS = 10 * 60 * 1_000;
export const NOTIFICATION_ID_PREFIX = "vrc-favworld-check-change-";
export const ATTENTION_NOTIFICATION_ID_PREFIX = "vrc-favworld-check-attention-";
export const SETTINGS_SCHEDULE_WARNING = "SCHEDULE_REPAIR_FAILED";
export const THUMBNAIL_SCHEDULE_WARNING = "THUMBNAIL_SCHEDULE_REPAIR_FAILED";
export const NOTIFICATION_EVENT_KINDS = SCHEMA_V2_NOTIFICATION_ELIGIBLE_EVENT_KINDS;
export const THUMBNAIL_CAPTURE_INTERVAL_MS = 250;
export const THUMBNAIL_CAPTURE_TIME_BUDGET_MS = 30_000;
export const THUMBNAIL_CAPTURE_MAX_ATTEMPTS = 100;
export const THUMBNAIL_FETCH_TIMEOUT_MS = 5_000;
export const THUMBNAIL_RATE_LIMIT_FALLBACK_MS = 30 * 60 * 1_000;

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
  purgePending: "purgePending",
  thumbnailBackoffUntil: "thumbnailBackoffUntil",
  thumbnailCaptureStatus: "thumbnailCaptureStatus",
  thumbnailCaptureCursor: "thumbnailCaptureCursor",
  thumbnailJob: "thumbnailJob"
});

/** @typedef {"manual" | "alarm" | "resume" | "thumbnail"} SyncTrigger */
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
 *   "setSettings" | "setThumbnailSettings" | "commitSync" | "recordSyncRun" | "claimEvents" |
 *   "updateNotificationResult" | "getUnreadCount" | "markEventsRead" |
 *   "hideWorld" | "restoreHiddenWorld" | "purgeHiddenWorld"> &
 *   Partial<Pick<import("./database.js").DatabaseRepository,
 *   "listThumbnailMetadata" | "putThumbnail">>} Repository
 */

/** @typedef {{total:number,saved:number,remaining:number,failed:number,nextAttemptAt:string|null,state:"running"|"waiting"|"complete"|"partial"|"paused"}} ThumbnailProgress */
/** @typedef {{version:1,userId:string,generation:number,capturedAt:string,items:{id:string,thumbnailImageUrl:string,attempts:number}[],nextAttemptAt:number|null,state:ThumbnailProgress["state"]}} ThumbnailJob */
/** @param {unknown} value @returns {value is ThumbnailJob} */
function isThumbnailJob(value) {
  if (typeof value !== "object" || value === null) return false;
  const job = /** @type {Record<string, unknown>} */ (value);
  return job.version === 1 && typeof job.userId === "string" && Number.isSafeInteger(job.generation)
    && typeof job.capturedAt === "string" && Number.isFinite(Date.parse(job.capturedAt))
    && (job.nextAttemptAt === null || isFiniteTimestamp(job.nextAttemptAt))
    && ["running", "waiting", "complete", "partial", "paused"].includes(String(job.state))
    && Array.isArray(job.items) && job.items.length <= 10_000
    && job.items.every((item) => typeof item === "object" && item !== null
      && typeof item.id === "string" && /^wrld_[a-f0-9-]{36}$/.test(item.id)
      && typeof item.thumbnailImageUrl === "string" && isAllowedVrchatImageUrl(item.thumbnailImageUrl)
      && Number.isSafeInteger(item.attempts) && item.attempts >= 0 && item.attempts <= 3);
}

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

/** @typedef {Awaited<ReturnType<Repository["claimEvents"]>>[number]} ClaimedNotificationEvent */
/** @typedef {Awaited<ReturnType<VrchatApi["listAllFavoriteWorlds"]>>[number]} FavoriteWorldMetadata */
/** @typedef {Awaited<ReturnType<typeof fetchAndEncodeThumbnail>>} EncodedThumbnail */
/** @typedef {{timeoutMs: number, clock: () => number, signal: AbortSignal}} ThumbnailEncodeOptions */

/**
 * @typedef {object} NotificationPresentation
 * @property {boolean} attention Whether the notification contains at least one confirmed attention event.
 * @property {string} title Notification title that never contains world metadata.
 * @property {string} message Notification message that contains counts only.
 * @property {string} buttonTitle Label for the single fixed-destination notification button.
 */

/**
 * Build count-only notification text from the claimed outbox batch. Confirmed
 * missing and unavailable counts are independently de-duplicated by world ID;
 * the headline attention count is the union of both sets.
 *
 * @param {readonly ClaimedNotificationEvent[]} events Claimed notification-eligible events.
 * @returns {NotificationPresentation} Immutable-by-convention presentation values.
 */
export function createNotificationPresentation(events) {
  const missingWorldIds = new Set();
  const unavailableWorldIds = new Set();
  let otherEventCount = 0;

  for (const event of events) {
    if (event.kind === "favorite_missing_confirmed") {
      missingWorldIds.add(event.worldId);
    } else if (event.kind === "access_unavailable_confirmed") {
      unavailableWorldIds.add(event.worldId);
    } else {
      otherEventCount += 1;
    }
  }

  const attentionWorldIds = new Set([...missingWorldIds, ...unavailableWorldIds]);
  if (attentionWorldIds.size === 0) {
    return {
      attention: false,
      title: "お気に入りワールドに変化があります",
      message: `${events.length}件の変化を記録しました。履歴を確認してください。`,
      buttonTitle: "履歴を見る"
    };
  }

  const attentionSummary = unavailableWorldIds.size > 0
    ? `要確認: ${attentionWorldIds.size}件（現在アクセス不可${unavailableWorldIds.size}件・お気に入り一覧にない${missingWorldIds.size}件）。`
    : `要確認: ${attentionWorldIds.size}件（お気に入り一覧にない${missingWorldIds.size}件）。手動でお気に入り解除した場合も含まれます。`;
  return {
    attention: true,
    title: unavailableWorldIds.size > 0
      ? "現在アクセスできないワールドがあります"
      : "お気に入り一覧にないワールドがあります",
    message: otherEventCount === 0
      ? attentionSummary
      : `${attentionSummary}その他の変化: ${otherEventCount}件。`,
    buttonTitle: "保存済みの情報を見る"
  };
}

/**
 * Save only thumbnails whose source version is not already present. Every
 * failure is counted and retried on a later successful sync; the authoritative
 * name/state transaction has already committed before this optional stage.
 *
 * @param {{
 *   userId: string,
 *   metadata: readonly (FavoriteWorldMetadata | import("./api.js").WorldMetadata | {id: string, thumbnailImageUrl?: string})[],
 *   generation: number,
 *   capturedAt: string,
 *   repository: Pick<import("./database.js").DatabaseRepository, "listThumbnailMetadata" | "putThumbnail">,
 *   encode?: (sourceUrl: string, options: ThumbnailEncodeOptions) => Promise<EncodedThumbnail>,
 *   wait?: (delayMs: number) => Promise<void>,
 *   intervalMs?: number,
 *   clock?: () => number,
 *   timeBudgetMs?: number,
 *   maxAttempts?: number,
 *   startAfterWorldId?: string,
 *   onAttempt?: (worldId: string) => void | Promise<void>
 * }} input
 * @returns {Promise<{
 *   saved: number,
 *   skipped: number,
 *   failed: number,
 *   deferred: number,
 *   retryAt: number | null
 * }>}
 */
export async function captureAvailableWorldThumbnails(input) {
  const intervalMs = input.intervalMs ?? THUMBNAIL_CAPTURE_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new RangeError("thumbnail intervalMs must be a non-negative finite number");
  }
  const timeBudgetMs = input.timeBudgetMs ?? THUMBNAIL_CAPTURE_TIME_BUDGET_MS;
  if (!Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0) {
    throw new RangeError("thumbnail timeBudgetMs must be a positive finite number");
  }
  const maxAttempts = input.maxAttempts ?? THUMBNAIL_CAPTURE_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new RangeError("thumbnail maxAttempts must be a positive safe integer");
  }
  const encode = input.encode ?? fetchAndEncodeThumbnail;
  const wait = input.wait ?? waitForThumbnailInterval;
  const clock = input.clock ?? Date.now;
  const startedAt = readThumbnailClock(clock);
  const deadlineAt = startedAt + timeBudgetMs;
  if (!isFiniteTimestamp(deadlineAt)) {
    throw new RangeError("thumbnail deadline must be a finite timestamp");
  }
  const existing = await runBeforeThumbnailDeadline(
    () => input.repository.listThumbnailMetadata(input.userId),
    thumbnailRemainingMs(deadlineAt, clock)
  );
  const existingSourceByWorld = new Map(
    existing.map((record) => [record.worldId, record.sourceUrl])
  );
  const orderedCandidates = input.metadata.filter((world) => (
    typeof world.thumbnailImageUrl === "string"
    && existingSourceByWorld.get(world.id) !== world.thumbnailImageUrl
  )).sort((left, right) => left.id.localeCompare(right.id, "en"));
  const resumeIndex = input.startAfterWorldId === undefined ? 0 : orderedCandidates.findIndex(
    (world) => world.id > /** @type {string} */ (input.startAfterWorldId)
  );
  const startIndex = Math.max(0, resumeIndex);
  const candidates = [
    ...orderedCandidates.slice(startIndex),
    ...orderedCandidates.slice(0, startIndex)
  ];
  let saved = 0;
  let failed = 0;
  let deferred = 0;
  /** @type {number | null} */
  let retryAt = null;
  for (const [index, world] of candidates.entries()) {
    if (
      index >= maxAttempts
      || thumbnailRemainingMs(deadlineAt, clock) <= 0
    ) {
      deferred += candidates.length - index;
      break;
    }
    if (index > 0 && intervalMs > 0) {
      const waitBudgetMs = thumbnailRemainingMs(deadlineAt, clock);
      if (waitBudgetMs <= intervalMs) {
        deferred += candidates.length - index;
        break;
      }
      try {
        await runBeforeThumbnailDeadline(() => wait(intervalMs), waitBudgetMs);
      } catch (error) {
        if (!(error instanceof ThumbnailCaptureDeadlineError)) {
          throw error;
        }
        deferred += candidates.length - index;
        break;
      }
    }
    const sourceUrl = world.thumbnailImageUrl;
    if (sourceUrl === undefined) {
      continue;
    }
    try {
      if (input.onAttempt !== undefined) {
        await runBeforeThumbnailDeadline(
          async () => input.onAttempt?.(world.id),
          thumbnailRemainingMs(deadlineAt, clock)
        );
      }
      const encodeBudgetMs = thumbnailRemainingMs(deadlineAt, clock);
      if (encodeBudgetMs <= 0) {
        throw new ThumbnailCaptureDeadlineError();
      }
      const encodeController = new AbortController();
      const encoded = await runBeforeThumbnailDeadline(
        () => encode(sourceUrl, {
          timeoutMs: Math.max(
            1,
            Math.min(THUMBNAIL_FETCH_TIMEOUT_MS, Math.floor(encodeBudgetMs))
          ),
          clock,
          signal: encodeController.signal
        }),
        encodeBudgetMs,
        () => encodeController.abort()
      );
      if (thumbnailRemainingMs(deadlineAt, clock) <= 0) {
        throw new ThumbnailCaptureDeadlineError();
      }
      const buffer = new ArrayBuffer(encoded.bytes.byteLength);
      new Uint8Array(buffer).set(encoded.bytes);
      await runBeforeThumbnailDeadline(
        () => input.repository.putThumbnail({
          userId: input.userId,
          worldId: world.id,
          blob: new Blob([buffer], { type: encoded.contentType }),
          width: encoded.width,
          height: encoded.height,
          byteLength: encoded.bytes.byteLength,
          capturedAt: input.capturedAt,
          sourceUrl: encoded.sourceUrl
        }, input.generation, input.userId),
        thumbnailRemainingMs(deadlineAt, clock)
      );
      saved += 1;
    } catch (error) {
      if (error instanceof ThumbnailFetchError && error.status === 429) {
        failed += 1;
        deferred += candidates.length - index - 1;
        retryAt = error.retryAt
          ?? readThumbnailClock(clock) + THUMBNAIL_RATE_LIMIT_FALLBACK_MS;
        break;
      }
      if (
        error instanceof ThumbnailCaptureDeadlineError
        || thumbnailRemainingMs(deadlineAt, clock) <= 0
      ) {
        deferred += candidates.length - index;
        break;
      }
      failed += 1;
      if (error instanceof GenerationConflictError) {
        deferred += candidates.length - index - 1;
        break;
      }
      if (error instanceof ThumbnailError) {
        if (shouldStopThumbnailBatch(error)) {
          deferred += candidates.length - index - 1;
          break;
        }
        continue;
      }
      deferred += candidates.length - index - 1;
      break;
    }
  }
  return {
    saved,
    skipped: input.metadata.length - candidates.length,
    failed,
    deferred,
    retryAt
  };
}

class ThumbnailCaptureDeadlineError extends Error {
  constructor() {
    super("Thumbnail capture deadline exceeded");
    this.name = "ThumbnailCaptureDeadlineError";
  }
}

/**
 * @template T
 * @param {() => Promise<T>} operation
 * @param {number} remainingMs
 * @param {() => void} [onTimeout]
 * @returns {Promise<T>}
 */
async function runBeforeThumbnailDeadline(operation, remainingMs, onTimeout = () => {}) {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new ThumbnailCaptureDeadlineError();
  }
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        onTimeout();
      } finally {
        reject(new ThumbnailCaptureDeadlineError());
      }
    }, Math.max(1, Math.ceil(remainingMs)));
  });
  try {
    return /** @type {T} */ (await Promise.race([operation(), timeout]));
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

/** @param {ThumbnailError} error */
function shouldStopThumbnailBatch(error) {
  if (error.code === "FETCH_FAILED" || error.code === "UNEXPECTED_REDIRECT") {
    return true;
  }
  if (!(error instanceof ThumbnailFetchError) || error.code !== "HTTP_STATUS") {
    return false;
  }
  return error.status === null
    || error.status === 401
    || error.status === 403
    || error.status === 408
    || error.status === 429
    || (error.status !== null && error.status >= 500);
}

/** @param {() => number} clock */
function readThumbnailClock(clock) {
  const value = clock();
  if (!isFiniteTimestamp(value)) {
    throw new RangeError("thumbnail clock must return a non-negative finite timestamp");
  }
  return value;
}

/** @param {number} deadlineAt @param {() => number} clock */
function thumbnailRemainingMs(deadlineAt, clock) {
  return Math.max(0, deadlineAt - readThumbnailClock(clock));
}

/** @param {number} delayMs */
function waitForThumbnailInterval(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Application service that owns the entire sync boundary. It never receives,
 * reads, or persists login material, credential headers, or raw API responses.
 */
export class SyncService {
  /** @type {Repository} */
  #repository;
  /** @type {SyncTrigger|null} */
  #activeTrigger = null;
  /** @type {Promise<void>} */
  #thumbnailMutationTail = Promise.resolve();
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
  /** @type {(sourceUrl: string, options: ThumbnailEncodeOptions) => Promise<EncodedThumbnail>} */
  #encodeThumbnail;
  /** @type {(delayMs: number) => Promise<void>} */
  #thumbnailWait;
  /** @type {Promise<PublicSyncResult> | null} */
  #activeSync = null;
  #recordMutationReserved = false;

  /**
   * @param {{
   *   repository: Repository,
   *   api?: Pick<VrchatApi, "getCurrentUser" | "listAllFavoriteGroups" | "listAllFavoriteRelations" | "listAllFavoriteWorlds" | "getWorld">,
   *   alarms: AlarmAdapter,
   *   notifications: NotificationAdapter,
   *   clock?: () => number,
   *   random?: () => number,
   *   idGenerator?: () => string,
   *   withApiSession?: <T>(operation: () => Promise<T>) => Promise<T>,
   *   encodeThumbnail?: (sourceUrl: string, options: ThumbnailEncodeOptions) => Promise<EncodedThumbnail>,
   *   thumbnailWait?: (delayMs: number) => Promise<void>
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
    this.#encodeThumbnail = dependencies.encodeThumbnail ?? fetchAndEncodeThumbnail;
    this.#thumbnailWait = dependencies.thumbnailWait ?? waitForThumbnailInterval;
  }

  get syncing() {
    return this.#activeSync !== null;
  }

  get recordMutating() {
    return this.#recordMutationReserved;
  }

  /**
   * Reserve before the first await, then share the existing thumbnail mutation
   * lock. Waiting image jobs are safe; executing sync/image batches are not.
   * Database guards remain authoritative across other pages and worker restarts.
   * @param {"hide" | "restore" | "purge"} action
   * @param {Parameters<import("./database.js").DatabaseRepository["hideWorld"]>[0]} input
   */
  async mutateRecord(action, input) {
    if (this.syncing || this.#recordMutationReserved) {
      return /** @type {const} */ ({ ok: false, error: "SYNC_IN_PROGRESS" });
    }
    this.#recordMutationReserved = true;
    try {
      return await this.#withThumbnailMutationLock(async () => {
        if (await this.#repository.getSetting(SETTING_KEYS.purgePending) === true) {
          return /** @type {const} */ ({ ok: false, error: "MAINTENANCE_IN_PROGRESS" });
        }
        const activeProfile = await this.#repository.getSetting(SETTING_KEYS.activeProfileId);
        if (typeof activeProfile !== "string") {
          return /** @type {const} */ ({ ok: false, error: "NO_ACTIVE_PROFILE" });
        }
        if (activeProfile !== input.userId) {
          return /** @type {const} */ ({ ok: false, error: "RECORD_CHANGED" });
        }
        const result = action === "hide" ? await this.#repository.hideWorld(input)
          : action === "restore" ? await this.#repository.restoreHiddenWorld(input)
            : action === "purge" ? await this.#repository.purgeHiddenWorld(input) : null;
        if (result === null) {
          return /** @type {const} */ ({ ok: false, error: "INVALID_REQUEST" });
        }
        /** @type {typeof THUMBNAIL_SCHEDULE_WARNING | null} */
        let thumbnailScheduleWarning = null;
        try {
          await this.#repairThumbnailSchedule();
        } catch {
          // The record transaction committed. Never turn a derived alarm
          // failure into an ambiguous delete failure or invite an auto-retry.
          thumbnailScheduleWarning = THUMBNAIL_SCHEDULE_WARNING;
        }
        return { ok: /** @type {const} */ (true), recordSaved: /** @type {const} */ (true),
          ...result, thumbnailScheduleWarning };
      });
    } catch (error) {
      if (error instanceof GenerationConflictError || error instanceof RevisionConflictError
        || error instanceof RecordStateConflictError) {
        return /** @type {const} */ ({ ok: false, error: "RECORD_CHANGED" });
      }
      return /** @type {const} */ ({ ok: false, error: "RECORD_UPDATE_FAILED" });
    } finally {
      this.#recordMutationReserved = false;
    }
  }

  /**
   * A concurrent caller shares the already-running promise and cannot start
   * another API sequence.
   *
   * @param {SyncTrigger} trigger
   * @returns {Promise<PublicSyncResult>}
   */
  start(trigger) {
    if (trigger !== "manual" && trigger !== "alarm" && trigger !== "resume" && trigger !== "thumbnail") {
      return Promise.resolve({ ok: false, error: "SYNC_FAILED" });
    }
    if (this.#recordMutationReserved) {
      return Promise.resolve({ ok: false, error: "MAINTENANCE_IN_PROGRESS" });
    }
    if (this.#activeSync !== null) {
      if (this.#activeTrigger === "thumbnail" && trigger !== "thumbnail") {
        return this.#activeSync.then(() => this.start(trigger));
      }
      return this.#activeSync;
    }

    this.#activeTrigger = trigger;
    const started = this.#withThumbnailMutationLock(() => trigger === "thumbnail"
      ? this.#continueThumbnails() : this.#startNewSync(trigger));
    /** @type {Promise<PublicSyncResult>} */
    let tracked;
    tracked = started.finally(() => {
      if (this.#activeSync === tracked) {
        this.#activeSync = null;
        this.#activeTrigger = null;
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
   *   attentionWorldCount: number,
   *   missingCount: number,
   *   unavailableCount: number,
   *   unreadCount: number,
   *   unreadSummary: {exact: boolean, uncertain: boolean, count: number | null},
   *   generation: number,
   *   dataGeneration: number,
   *   presentationGeneration: number,
   *   hiddenCount: number,
   *   recordMutating: boolean,
   *   favoriteGroupStatus: "success" | "stale" | null,
   *   lastResult: string | null,
   *   thumbnailProgress: ThumbnailProgress | null,
   *   thumbnailSavedCount: number | null
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
      ? {
          worldCount: 0,
          eventCount: 0,
          pendingProbeCount: 0,
          attentionWorldCount: 0,
          missingCount: 0,
          unavailableCount: 0,
          hiddenCount: 0,
          generation: 0,
          presentationGeneration: 0,
          unreadSummary: { exact: true, uncertain: false, count: 0 }
        }
      : await this.#repository.getProfileStats(profileId);
    // Counts, dispositions, generations and unread certainty are one DB view.
    // Never pair a fresh generation with a separate, stale unread/count read.
    const unreadSummary = stats.unreadSummary;
    const unreadCount = unreadSummary.count ?? 0;
    // Saved images survive upgrades independently of the current capture job.
    // A missing/unreadable job must not erase the independently known count.
    const thumbnailSavedCount = profileId === null ? 0
      : this.#repository.listThumbnailMetadata === undefined ? null
        : await this.#repository.listThumbnailMetadata(profileId)
          .then((images) => images.length, () => null);

    return {
      thumbnailSavedCount,
      thumbnailProgress: await this.#thumbnailProgress().catch(() => null),
      syncing: this.syncing,
      recordMutating: this.recordMutating,
      authRequired: lastResult === "auth_required",
      lastSuccessfulSyncAt: profile?.lastSuccessfulSyncAt ?? null,
      nextSyncAt: isFiniteTimestamp(nextSyncAt)
        ? new Date(nextSyncAt).toISOString()
        : null,
      activeProfileId: profileId,
      worldCount: stats.worldCount,
      eventCount: stats.eventCount,
      pendingProbeCount: stats.pendingProbeCount,
      attentionWorldCount: stats.attentionWorldCount,
      missingCount: stats.missingCount,
      unavailableCount: stats.unavailableCount,
      unreadCount,
      unreadSummary,
      generation: stats.generation,
      dataGeneration: stats.generation,
      presentationGeneration: stats.presentationGeneration,
      hiddenCount: stats.hiddenCount,
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

  /** @returns {Promise<ThumbnailJob|null>} */
  async #currentThumbnailJob() {
    const job = await this.#repository.getSetting(SETTING_KEYS.thumbnailJob);
    if (!isThumbnailJob(job) || await this.#repository.getSetting(SETTING_KEYS.purgePending) === true
      || await this.#repository.getSetting(SETTING_KEYS.activeProfileId) !== job.userId
      || await this.#repository.getDataGeneration(job.userId) !== job.generation) return null;
    return job;
  }

  /** @param {ThumbnailJob} job @param {Record<string, unknown>} [extra] */
  async #saveThumbnailJob(job, extra = {}) {
    await this.#repository.setThumbnailSettings(job.userId, job.generation, {
      ...extra, [SETTING_KEYS.thumbnailJob]: job
    });
  }

  /** @returns {Promise<ThumbnailProgress|null>} */
  async #thumbnailProgress() {
    const job = await this.#currentThumbnailJob();
    if (job === null || this.#repository.listThumbnailMetadata === undefined) return null;
    const stored = new Map((await this.#repository.listThumbnailMetadata(job.userId)).map((item) => [item.worldId, item.sourceUrl]));
    const missing = job.items.filter((item) => stored.get(item.id) !== item.thumbnailImageUrl);
    const failed = missing.filter((item) => item.attempts >= 3).length;
    return { total: job.items.length, saved: job.items.length - missing.length,
      remaining: missing.length - failed, failed,
      nextAttemptAt: job.nextAttemptAt === null ? null : new Date(job.nextAttemptAt).toISOString(),
      state: job.state };
  }

  /**
   * Serialize every sync and schedule repair that can replace a thumbnail job.
   * Reads used for presentation remain independent.
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  #withThumbnailMutationLock(operation) {
    const result = this.#thumbnailMutationTail.then(operation);
    this.#thumbnailMutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async repairThumbnailSchedule() {
    return this.#withThumbnailMutationLock(() => this.#repairThumbnailSchedule());
  }

  async #repairThumbnailSchedule() {
    const job = await this.#currentThumbnailJob();
    if (job === null || job.state === "complete" || job.state === "partial") {
      await this.#alarms.clear(THUMBNAIL_ALARM_NAME);
      return;
    }
    const backoff = await this.#repository.getSetting(SETTING_KEYS.backoffUntil);
    const imageBackoff = await this.#repository.getSetting(SETTING_KEYS.thumbnailBackoffUntil);
    const when = Math.max(this.#now() + THUMBNAIL_BATCH_DELAY_MS, job.nextAttemptAt ?? 0,
      isFiniteTimestamp(backoff) ? backoff : 0, isFiniteTimestamp(imageBackoff) ? imageBackoff : 0);
    await this.#alarms.create(THUMBNAIL_ALARM_NAME, when);
    job.nextAttemptAt = when;
    job.state = "waiting";
    await this.#saveThumbnailJob(job);
  }

  async repairThumbnailScheduleBestEffort() {
    return this.#withThumbnailMutationLock(async () => {
      try { await this.#repairThumbnailSchedule(); }
      catch {
        const job = await this.#currentThumbnailJob().catch(() => null);
        if (job !== null && job.state !== "complete" && job.state !== "partial") {
          job.state = "paused";
          await this.#saveThumbnailJob(job).catch(() => undefined);
        }
      }
    });
  }

  /** @returns {Promise<PublicSyncResult>} */
  async #continueThumbnails() {
    let job = null;
    try {
      job = await this.#currentThumbnailJob();
      if (job === null || this.#repository.listThumbnailMetadata === undefined || this.#repository.putThumbnail === undefined) {
        await this.#alarms.clear(THUMBNAIL_ALARM_NAME);
        return { ok: true };
      }
      if (job.state === "complete" || job.state === "partial") return { ok: true };
      const now = this.#now();
      const backoff = await this.#repository.getSetting(SETTING_KEYS.backoffUntil);
      const imageBackoff = await this.#repository.getSetting(SETTING_KEYS.thumbnailBackoffUntil);
      const next = Math.max(job.nextAttemptAt ?? 0, isFiniteTimestamp(backoff) ? backoff : 0,
        isFiniteTimestamp(imageBackoff) ? imageBackoff : 0);
      if (next > now) {
        job.nextAttemptAt = next;
        job.state = "waiting";
        await this.#saveThumbnailJob(job);
        await this.#alarms.create(THUMBNAIL_ALARM_NAME, next);
        return { ok: true };
      }
      job.state = "running";
      job.nextAttemptAt = now + THUMBNAIL_BATCH_DELAY_MS;
      await this.#saveThumbnailJob(job);
      await this.#alarms.create(THUMBNAIL_ALARM_NAME, job.nextAttemptAt);
      const activeJob = job;
      const stored = new Map((await this.#repository.listThumbnailMetadata(job.userId)).map((item) => [item.worldId, item.sourceUrl]));
      const pending = job.items.filter((item) => item.attempts < 3 && stored.get(item.id) !== item.thumbnailImageUrl);
      const minAttempts = Math.min(...pending.map((item) => item.attempts));
      const result = await captureAvailableWorldThumbnails({
        userId: job.userId, generation: job.generation, capturedAt: job.capturedAt,
        metadata: pending.filter((item) => item.attempts === minAttempts),
        repository: { listThumbnailMetadata: this.#repository.listThumbnailMetadata.bind(this.#repository),
          putThumbnail: this.#repository.putThumbnail.bind(this.#repository) },
        encode: this.#encodeThumbnail, wait: this.#thumbnailWait, clock: this.#clock,
        onAttempt: async (worldId) => {
          const item = activeJob.items.find((entry) => entry.id === worldId);
          if (item !== undefined) item.attempts += 1;
          await this.#saveThumbnailJob(activeJob);
        }
      });
      const progress = await this.#thumbnailProgress();
      if (progress === null) return { ok: true };
      job.state = progress.remaining === 0 ? (progress.failed === 0 ? "complete" : "partial") : "waiting";
      job.nextAttemptAt = progress.remaining === 0 ? null : Math.max(this.#now() + THUMBNAIL_BATCH_DELAY_MS, result.retryAt ?? 0);
      await this.#saveThumbnailJob(job, {
        [SETTING_KEYS.thumbnailCaptureStatus]: {userId: job.userId, capturedAt: job.capturedAt, ...result},
        [SETTING_KEYS.thumbnailBackoffUntil]: result.retryAt,
        ...(result.retryAt === null ? {} : {[SETTING_KEYS.backoffUntil]: result.retryAt})
      });
      if (job.nextAttemptAt === null) await this.#alarms.clear(THUMBNAIL_ALARM_NAME);
      else await this.#alarms.create(THUMBNAIL_ALARM_NAME, job.nextAttemptAt);
      return { ok: true };
    } catch {
      if (job !== null) {
        job.state = "paused";
        try { await this.#saveThumbnailJob(job, {
          [SETTING_KEYS.thumbnailCaptureStatus]: {userId: job.userId, capturedAt: job.capturedAt, saved: 0, skipped: 0, failed: 1, deferred: job.items.length, retryAt: null}
        }); } catch { return {ok: false, error: "STORAGE_UNAVAILABLE"}; }
      }
      return {ok: false, error: "STORAGE_UNAVAILABLE"};
    }
  }

  /** @param {Exclude<SyncTrigger, "thumbnail">} trigger @returns {Promise<PublicSyncResult>} */
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

  /** @param {Exclude<SyncTrigger, "thumbnail">} trigger @returns {Promise<PublicSyncResult>} */
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
      const thumbnailCapturePlan = await this.#withApiSession(async () => {
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
        limit: MAX_PROBE_CANDIDATES,
        worldDispositions: initialSnapshot.worldDispositions
      });
      const initiallyPurgedIds = new Set(initialSnapshot.worldDispositions
        .filter((row) => row.state === "purged").map((row) => row.worldId));
      // Older releases did not save images. Use spare probe slots for recorded
      // accessible worlds outside the current favorites, until their image is saved.
      if (this.#repository.listThumbnailMetadata !== undefined && candidates.length < MAX_PROBE_CANDIDATES) {
        // A broken optional image store must not prevent committing world history.
        const storedImages = await this.#repository.listThumbnailMetadata(user.id)
          .catch(() => null);
        const imageWorldIds = new Set(storedImages?.map((record) => record.worldId));
        const knownMetadataIds = new Set(apiMetadata.map((world) => world.id));
        const selectedIds = new Set(candidates);
        const imageProbeCandidates = initialSnapshot.worlds.filter((world) => (
          storedImages !== null && world.availabilityState === "accessible"
          && !initiallyPurgedIds.has(world.worldId)
          && !knownMetadataIds.has(world.worldId)
          && !imageWorldIds.has(world.worldId)
          && !selectedIds.has(world.worldId)
        )).sort((left, right) => (
          (left.lastProbeAt ?? "").localeCompare(right.lastProbeAt ?? "", "en")
          || left.worldId.localeCompare(right.worldId, "en")
        ));
        candidates.push(...imageProbeCandidates
          .slice(0, MAX_PROBE_CANDIDATES - candidates.length)
          .map((world) => world.worldId));
      }
      /** @type {Map<string, import("./domain.js").MappedWorldProbe>} */
      const probes = new Map();
      const thumbnailMetadata = new Map(
        apiMetadata.map((world) => [world.id, /** @type {import("./api.js").WorldMetadata} */ (world)])
      );
      for (const worldId of candidates) {
        const result = await this.#api.getWorld(worldId);
        probeCount += 1;
        if (result.status === 404) {
          probes.set(worldId, { worldId, status: 404 });
        } else {
          thumbnailMetadata.set(result.world.id, result.world);
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
      return {
        userId: user.id,
        metadata: [...thumbnailMetadata.values()]
          .filter((world) => committedPlan.worldIds.has(world.id))
          .map((world) => ({ ...world })),
        generation: committedPlan.generation,
        capturedAt: observedAt
      };
      });
      if (this.#repository.listThumbnailMetadata !== undefined && this.#repository.putThumbnail !== undefined) {
        const previous = await this.#repository.getSetting(SETTING_KEYS.thumbnailJob);
        const attempts = new Map(isThumbnailJob(previous) && previous.userId === thumbnailCapturePlan.userId
          ? previous.items.map((item) => [`${item.id}:${item.thumbnailImageUrl}`, item.attempts]) : []);
        /** @type {ThumbnailJob} */
        const job = {
          version: 1, userId: thumbnailCapturePlan.userId, generation: thumbnailCapturePlan.generation,
          capturedAt: thumbnailCapturePlan.capturedAt,
          items: thumbnailCapturePlan.metadata.filter((world) => typeof world.thumbnailImageUrl === "string"
            && isAllowedVrchatImageUrl(world.thumbnailImageUrl)).map((world) => ({
              id: world.id, thumbnailImageUrl: /** @type {string} */ (world.thumbnailImageUrl),
              attempts: previous !== undefined && isThumbnailJob(previous) && previous.state !== "complete" && previous.state !== "partial"
                ? attempts.get(`${world.id}:${world.thumbnailImageUrl}`) ?? 0 : 0
            })),
          nextAttemptAt: null, state: "waiting"
        };
        try {
          await this.#saveThumbnailJob(job);
        } catch {
          // Retry the exact guarded checkpoint once; no image request is allowed
          // before the initial durable job exists.
          job.state = "paused";
          await this.#saveThumbnailJob(job);
        }
        await this.#continueThumbnails();
      }
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
   *   trigger: Exclude<SyncTrigger, "thumbnail">,
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
        isBaseline: snapshot.profile === null,
        worldDispositions: snapshot.worldDispositions,
        // Fetched evidence may only release a pre-existing suppression on the
        // original commit. Replans never release even previously purged IDs.
        allowPurgedReintroduction: attempt === 0
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
          releasedPurgedWorldIds: plan.releasedPurgedWorldIds,
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
        return { changeCount: plan.events.length, generation,
          worldIds: new Set(plan.worlds.map((world) => world.worldId)) };
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
   *   trigger: Exclude<SyncTrigger, "thumbnail">,
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
      const presentation = createNotificationPresentation(claimed);
      notificationId = await this.#notifications.create(
        `${presentation.attention
          ? ATTENTION_NOTIFICATION_ID_PREFIX
          : NOTIFICATION_ID_PREFIX}${safeNotificationSuffix(syncId)}`,
        {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: presentation.title,
          message: presentation.message,
          buttons: [{ title: presentation.buttonTitle }]
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
