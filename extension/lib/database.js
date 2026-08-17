// @ts-check

import {
  EVENT_KIND_ORDER,
  isSchemaV2NotificationEligibleEventKind
} from "./domain.js";

export const DATABASE_NAME = "vrc-favworld-check";
export const DATABASE_VERSION = 2;
export const SYNC_RUN_RETENTION_PER_PROFILE = 100;
export const SYNC_RUN_RETENTION_ANONYMOUS = 20;
export const ANONYMOUS_RETENTION_OWNER = "__anonymous__";

const DATA_GENERATION_PREFIX = "dataGeneration:";
const UNREAD_COUNT_PREFIX = "unreadCount:";
const EVENT_KIND_SET = new Set(EVENT_KIND_ORDER);
const NOTIFICATION_ERROR_SET = /** @type {ReadonlySet<unknown>} */ (new Set([
  "api_rejected",
  "permission_denied",
  "unavailable",
  null
]));
const BACKUP_PREFERENCE_KEYS = Object.freeze([
  "autoSyncEnabled",
  "notificationsEnabled"
]);
const ALLOWED_SETTING_KEYS = new Set([
  ...BACKUP_PREFERENCE_KEYS,
  "lastManualSyncAt",
  "nextSyncAt",
  "backoffUntil",
  "consecutiveRateLimits",
  "activeProfileId",
  "lastSyncResult",
  "lastAlarmError",
  "watchdogUntil",
  "lastBackupAt",
  "purgePending",
  "favoriteGroupStatus"
]);

export class GenerationConflictError extends Error {
  /**
   * @param {string} userId
   * @param {number} expected
   * @param {number} actual
   */
  constructor(userId, expected, actual) {
    super(`Profile changed before operation: ${userId} (expected ${expected}, found ${actual})`);
    this.name = "GenerationConflictError";
    this.userId = userId;
    this.expected = expected;
    this.actual = actual;
  }
}

export class RevisionConflictError extends Error {
  /**
   * @param {string} worldId
   */
  constructor(worldId) {
    super(`World changed before sync commit: ${worldId}`);
    this.name = "RevisionConflictError";
  }
}

export class PurgePendingError extends Error {
  constructor() {
    super("Database writes are disabled while permanent data removal is pending");
    this.name = "PurgePendingError";
  }
}

export const STORES = Object.freeze({
  profiles: "profiles",
  worlds: "worlds",
  favoriteGroups: "favoriteGroups",
  events: "events",
  syncRuns: "syncRuns",
  settings: "settings",
  meta: "meta"
});

const INDEXES = Object.freeze({
  worldsByUser: "by-user",
  worldsByUpdated: "by-user-updated-at",
  worldsByMembership: "by-user-membership",
  worldsByAvailability: "by-user-availability",
  worldsByProbe: "by-user-probe",
  favoriteGroupsByUser: "by-user",
  favoriteGroupsByInternalName: "by-user-internal-name",
  eventsByUser: "by-user",
  eventsByObserved: "by-user-observed-at",
  eventsByKind: "by-user-kind-observed-at",
  eventsByWorld: "by-user-world-observed-at",
  syncRunsByUser: "by-user",
  syncRunsByStarted: "by-user-started-at",
  syncRunsByRetention: "by-retention-owner-started-at"
});

/**
 * @typedef {object} ProfileRecord
 * @property {string} userId
 * @property {string} displayName
 * @property {string} firstSeenAt
 * @property {string | null} lastSuccessfulSyncAt
 * @property {number} createdBySchemaVersion
 */

/**
 * @typedef {object} WorldRecord
 * @property {string} userId
 * @property {string} worldId
 * @property {string | null} currentName
 * @property {string | null} normalizedName
 * @property {string | null} authorName
 * @property {string | null} normalizedAuthorName
 * @property {string[]} favoriteTags
 * @property {string} firstSeenAt
 * @property {string | null} lastSeenFavoriteAt
 * @property {string | null} lastMetadataAt
 * @property {"favorited" | "missing_once" | "not_in_favorites"} membershipState
 * @property {0 | 1 | 2} membershipMissCount
 * @property {"unknown" | "accessible" | "unavailable_once" | "unavailable"} availabilityState
 * @property {0 | 1 | 2} unavailableCount
 * @property {"none" | "pending"} probeState
 * @property {string | null} lastProbeAt
 * @property {200 | 404 | null} lastEvidenceStatus
 * @property {number} revision
 * @property {string} updatedAt
 */

/**
 * @typedef {object} FavoriteGroupNameHistoryEntry
 * @property {string} displayName
 * @property {string} observedAt
 */

/**
 * @typedef {object} FavoriteGroupRecord
 * @property {string} userId
 * @property {string} groupId
 * @property {string} internalName
 * @property {string} displayName
 * @property {string} normalizedDisplayName
 * @property {"world" | "vrcPlusWorld"} type
 * @property {boolean} active
 * @property {0 | 1 | 2} missingCount
 * @property {string} firstSeenAt
 * @property {string} lastSeenAt
 * @property {FavoriteGroupNameHistoryEntry[]} displayNameHistory
 * @property {string} updatedAt
 */

/**
 * @typedef {object} EventEvidence
 * @property {"bulk" | "probe"} source
 * @property {200 | 404 | null} httpStatus
 */

/**
 * @typedef {object} HistoryEvent
 * @property {string} eventId
 * @property {string} userId
 * @property {string} worldId
 * @property {"name_changed" | "favorite_group_changed" | "favorite_missing_confirmed" | "favorite_restored" | "access_unavailable_confirmed" | "access_restored"} kind
 * @property {string} observedAt
 * @property {string} before
 * @property {string} after
 * @property {EventEvidence} evidence
 * @property {string} syncId
 * @property {boolean} notificationEligible
 * @property {string | null} notificationClaimedAt
 * @property {string | null} notifiedAt
 * @property {"api_rejected" | "permission_denied" | "unavailable" | null} notificationError
 */

/**
 * @typedef {object} SyncRunRecord
 * @property {string} syncId
 * @property {string | null} userId
 * @property {"manual" | "alarm" | "resume"} trigger
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {"success" | "auth_required" | "rate_limited" | "offline" | "api_incompatible" | "failed"} result
 * @property {number} favoriteCount
 * @property {number} metadataCount
 * @property {number} probeCount
 * @property {number} changeCount
 * @property {string | null} retryAt
 * @property {string} [retentionOwner] Repository-derived field present on stored v2 records
 */

/**
 * @typedef {object} SyncCommit
 * @property {ProfileRecord} profile
 * @property {readonly WorldRecord[]} worlds
 * @property {readonly FavoriteGroupRecord[]} favoriteGroups
 * @property {readonly HistoryEvent[]} events
 * @property {SyncRunRecord} syncRun
 * @property {readonly ExpectedWorldRevision[]} expectedWorldRevisions
 * @property {number} expectedGeneration
 * @property {SuccessSyncSettings} settings
 */

/**
 * @typedef {object} SuccessSyncSettings
 * @property {string} activeProfileId
 * @property {null} backoffUntil
 * @property {0} consecutiveRateLimits
 * @property {"success"} lastSyncResult
 * @property {"success" | "stale"} favoriteGroupStatus
 */

/**
 * @typedef {object} ExpectedWorldRevision
 * @property {string} userId
 * @property {string} worldId
 * @property {number | null} revision null means the world did not exist in the planning snapshot
 */

/**
 * @typedef {object} ProfileReplacement
 * @property {ProfileRecord} profile
 * @property {readonly WorldRecord[]} worlds
 * @property {readonly FavoriteGroupRecord[]} favoriteGroups
 * @property {readonly HistoryEvent[]} events
 * @property {Readonly<Record<string, boolean>>} [preferences]
 */

/** @typedef {{ key: string, value: unknown }} StoredValue */

/**
 * @typedef {object} SyncSnapshot
 * @property {ProfileRecord | null} profile
 * @property {WorldRecord[]} worlds
 * @property {FavoriteGroupRecord[]} favoriteGroups
 * @property {number} generation
 */

/**
 * @typedef {object} BackupSnapshot
 * @property {ProfileRecord | null} profile
 * @property {WorldRecord[]} worlds
 * @property {FavoriteGroupRecord[]} favoriteGroups
 * @property {HistoryEvent[]} events
 * @property {{ autoSyncEnabled?: boolean, notificationsEnabled?: boolean }} preferences
 */

/**
 * Convert an IndexedDB request into a promise without changing transaction
 * boundaries. Callers queue all writes before awaiting transaction completion.
 *
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("IndexedDB request failed")),
      { once: true }
    );
  });
}

/**
 * @param {IDBTransaction} transaction
 * @returns {Promise<void>}
 */
function transactionFinished(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new DOMException("IndexedDB transaction aborted", "AbortError")),
      { once: true }
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("IndexedDB transaction failed")),
      { once: true }
    );
  });
}

/**
 * @param {IDBTransaction} transaction
 * @param {unknown} error
 * @param {Promise<void>} finished
 * @returns {Promise<never>}
 */
async function abortAndThrow(transaction, error, finished) {
  try {
    transaction.abort();
  } catch (abortError) {
    if (!hasErrorName(abortError, "InvalidStateError")) {
      throw new AggregateError([error, abortError], "IndexedDB transaction cleanup failed", {
        cause: abortError
      });
    }
  }
  try {
    await finished;
  } catch (transactionError) {
    if (!hasErrorName(transactionError, "AbortError")) {
      throw new AggregateError([error, transactionError], "IndexedDB transaction aborted", {
        cause: transactionError
      });
    }
  }
  throw error;
}

/**
 * IndexedDB errors may originate in another realm, so `instanceof
 * DOMException` is not a reliable discriminator.
 *
 * @param {unknown} error
 * @param {string} name
 * @returns {boolean}
 */
function hasErrorName(error, name) {
  return typeof error === "object" && error !== null && "name" in error && error.name === name;
}

/**
 * Settle both an IndexedDB read request and its transaction. If either fails,
 * also settle the transaction's abort path so no rejection is left detached.
 *
 * @template T
 * @param {IDBTransaction} transaction
 * @param {Promise<T>} result
 * @returns {Promise<T>}
 */
async function completeRead(transaction, result) {
  const finished = transactionFinished(transaction);
  try {
    const value = await result;
    await finished;
    return value;
  } catch (error) {
    return abortAndThrow(transaction, error, finished);
  }
}

/**
 * @param {IDBObjectStore} store
 * @param {IDBValidKey} key
 * @returns {Promise<unknown>}
 */
async function getValue(store, key) {
  const request = /** @type {IDBRequest<unknown>} */ (store.get(key));
  return requestResult(request);
}

/**
 * @param {string} userId
 * @returns {string}
 */
function generationKey(userId) {
  return `${DATA_GENERATION_PREFIX}${userId}`;
}

/**
 * @param {string} userId
 * @returns {string}
 */
function unreadCountKey(userId) {
  return `${UNREAD_COUNT_PREFIX}${userId}`;
}

/**
 * @param {unknown} stored
 * @param {string} userId
 * @returns {number}
 */
function generationValue(stored, userId) {
  if (stored === undefined) {
    return 0;
  }
  const value = (/** @type {StoredValue} */ (stored)).value;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Stored data generation is invalid: ${userId}`);
  }
  return value;
}

/**
 * @param {unknown} stored
 * @param {string} userId
 * @returns {number}
 */
function unreadCountValue(stored, userId) {
  if (stored === undefined) {
    return 0;
  }
  const value = (/** @type {StoredValue} */ (stored)).value;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Stored unread event count is invalid: ${userId}`);
  }
  return value;
}

/**
 * @param {unknown} stored
 */
function requireWritesAllowed(stored) {
  if (
    stored !== undefined &&
    (/** @type {StoredValue} */ (stored)).value !== false
  ) {
    throw new PurgePendingError();
  }
}

/**
 * @param {number} generation
 * @param {string} label
 */
function requireGeneration(generation, label) {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

/**
 * @param {number} current
 * @param {string} userId
 * @returns {number}
 */
function incrementGeneration(current, userId) {
  if (current === Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`Data generation is exhausted: ${userId}`);
  }
  return current + 1;
}

/**
 * @param {IDBObjectStore} store
 * @param {Readonly<Record<string, unknown>>} updates
 */
function putSettings(store, updates) {
  for (const key of Object.keys(updates)) {
    if (!ALLOWED_SETTING_KEYS.has(key)) {
      throw new Error(`Unknown setting key: ${key}`);
    }
    store.put({ key, value: updates[key] });
  }
}

/**
 * @param {SuccessSyncSettings} settings
 * @param {string} userId
 */
function validateSuccessSettings(settings, userId) {
  const keys = Object.keys(settings);
  const required = [
    "activeProfileId",
    "backoffUntil",
    "consecutiveRateLimits",
    "lastSyncResult",
    "favoriteGroupStatus"
  ];
  if (keys.length !== required.length || required.some((key) => !Object.hasOwn(settings, key))) {
    throw new Error("Successful sync settings must contain every required key only");
  }
  if (
    settings.activeProfileId !== userId ||
    settings.backoffUntil !== null ||
    settings.consecutiveRateLimits !== 0 ||
    settings.lastSyncResult !== "success" ||
    (settings.favoriteGroupStatus !== "success" && settings.favoriteGroupStatus !== "stale")
  ) {
    throw new Error("Successful sync settings are inconsistent with the committed profile");
  }
}

/**
 * @param {readonly FavoriteGroupRecord[]} groups
 * @param {string} userId
 */
function validateFavoriteGroupPlan(groups, userId) {
  if (!Array.isArray(groups)) {
    throw new Error("favoriteGroups is required for every sync or replacement");
  }
  const groupIds = new Set();
  const activeInternalNames = new Set();
  for (const group of groups) {
    if (group.userId !== userId) {
      throw new Error(`Favorite group belongs to another profile: ${group.groupId}`);
    }
    if (groupIds.has(group.groupId)) {
      throw new Error(`Duplicate favorite group: ${group.groupId}`);
    }
    groupIds.add(group.groupId);
    if (
      (group.active && group.missingCount !== 0 && group.missingCount !== 1) ||
      (!group.active && group.missingCount !== 2)
    ) {
      throw new Error(`Favorite group missing count is inconsistent: ${group.groupId}`);
    }
    if (group.active) {
      if (activeInternalNames.has(group.internalName)) {
        throw new Error(`Duplicate active favorite group name: ${group.internalName}`);
      }
      activeInternalNames.add(group.internalName);
    }
  }
}

/**
 * Notification eligibility is immutable event evidence, not a live policy
 * lookup. Keeping the kind-to-boolean mapping strict prevents a future
 * outbox allowlist expansion from notifying historical suppressed events.
 *
 * @param {readonly HistoryEvent[]} events
 */
function validateEventPlan(events) {
  for (const event of events) {
    if (!EVENT_KIND_SET.has(event.kind)) {
      throw new Error(`Unknown event kind: ${event.eventId}`);
    }
    const expectedEligibility = isSchemaV2NotificationEligibleEventKind(event.kind);
    if (
      typeof event.notificationEligible !== "boolean"
      || event.notificationEligible !== expectedEligibility
    ) {
      throw new Error(`Event notification eligibility is inconsistent: ${event.eventId}`);
    }
    if (
      !event.notificationEligible
      && (
        event.notificationClaimedAt !== null
        || event.notifiedAt !== null
        || event.notificationError !== null
      )
    ) {
      throw new Error(`Suppressed event has notification delivery state: ${event.eventId}`);
    }
  }
}

/**
 * @param {SyncRunRecord} syncRun
 */
function validateSyncRun(syncRun) {
  if (
    typeof syncRun.syncId !== "string" ||
    syncRun.syncId.length === 0 ||
    (syncRun.userId !== null &&
      (typeof syncRun.userId !== "string" || syncRun.userId.length === 0)) ||
    !isCanonicalUtcTimestamp(syncRun.startedAt) ||
    !isCanonicalUtcTimestamp(syncRun.finishedAt) ||
    syncRun.finishedAt < syncRun.startedAt
  ) {
    throw new Error("Sync run identity and retention fields are invalid");
  }
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isCanonicalUtcTimestamp(value) {
  if (typeof value !== "string") {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

/**
 * Notification delivery fields may legitimately differ when an idempotent
 * sync plan is replayed. Every immutable event field must still match.
 *
 * @param {HistoryEvent} left
 * @param {HistoryEvent} right
 * @returns {boolean}
 */
function sameEventPayload(left, right) {
  return (
    left.eventId === right.eventId &&
    left.userId === right.userId &&
    left.worldId === right.worldId &&
    left.kind === right.kind &&
    left.observedAt === right.observedAt &&
    left.before === right.before &&
    left.after === right.after &&
    left.evidence.source === right.evidence.source &&
    left.evidence.httpStatus === right.evidence.httpStatus &&
    left.syncId === right.syncId &&
    left.notificationEligible === right.notificationEligible
  );
}

/**
 * @param {IDBIndex} index
 * @param {IDBValidKey | IDBKeyRange} query
 * @returns {Promise<unknown[]>}
 */
async function getAllValues(index, query) {
  const request = /** @type {IDBRequest<unknown[]>} */ (index.getAll(query));
  return requestResult(request);
}

/**
 * Delete every object selected by an index. Cursor deletion keeps the operation
 * inside the caller's transaction.
 *
 * @param {IDBIndex} index
 * @param {IDBValidKey | IDBKeyRange} query
 * @returns {Promise<void>}
 */
function deleteByIndex(index, query) {
  return new Promise((resolve, reject) => {
    const request = index.openCursor(query);
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB cursor failed")), {
      once: true
    });
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    });
  });
}

/**
 * @param {SyncRunRecord} syncRun
 * @returns {string}
 */
function retentionOwnerFor(syncRun) {
  return syncRun.userId ?? ANONYMOUS_RETENTION_OWNER;
}

/**
 * Insert one diagnostic and delete the oldest excess records for the same
 * retention owner before the caller's transaction commits.
 *
 * @param {IDBObjectStore} store
 * @param {SyncRunRecord} syncRun
 * @returns {Promise<void>}
 */
function putSyncRunAndPrune(store, syncRun) {
  validateSyncRun(syncRun);
  const retentionOwner = retentionOwnerFor(syncRun);
  const limit = retentionOwner === ANONYMOUS_RETENTION_OWNER
    ? SYNC_RUN_RETENTION_ANONYMOUS
    : SYNC_RUN_RETENTION_PER_PROFILE;
  store.put({ ...syncRun, retentionOwner });

  return new Promise((resolve, reject) => {
    /** @type {IDBValidKey[]} */
    const retainedKeys = [];
    const request = store.index(INDEXES.syncRunsByRetention).openCursor();
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("IndexedDB retention cursor failed"));
    }, { once: true });
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve();
        return;
      }
      const record = /** @type {SyncRunRecord} */ (cursor.value);
      if (record.retentionOwner === retentionOwner) {
        retainedKeys.push(cursor.primaryKey);
        if (retainedKeys.length > limit) {
          const oldest = retainedKeys.shift();
          if (oldest !== undefined) {
            store.delete(oldest);
          }
        }
      }
      cursor.continue();
    });
  });
}

/**
 * @param {IDBDatabase} database
 */
function installSchema(database) {
  const profiles = database.createObjectStore(STORES.profiles, { keyPath: "userId" });
  void profiles;

  const worlds = database.createObjectStore(STORES.worlds, {
    keyPath: ["userId", "worldId"]
  });
  worlds.createIndex(INDEXES.worldsByUser, "userId", { unique: false });
  worlds.createIndex(INDEXES.worldsByUpdated, ["userId", "updatedAt"], { unique: false });
  worlds.createIndex(INDEXES.worldsByMembership, ["userId", "membershipState"], {
    unique: false
  });
  worlds.createIndex(INDEXES.worldsByAvailability, ["userId", "availabilityState"], {
    unique: false
  });
  worlds.createIndex(INDEXES.worldsByProbe, ["userId", "probeState", "lastProbeAt"], {
    unique: false
  });

  const favoriteGroups = database.createObjectStore(STORES.favoriteGroups, {
    keyPath: ["userId", "groupId"]
  });
  favoriteGroups.createIndex(INDEXES.favoriteGroupsByUser, "userId", { unique: false });
  favoriteGroups.createIndex(
    INDEXES.favoriteGroupsByInternalName,
    ["userId", "internalName"],
    { unique: false }
  );

  const events = database.createObjectStore(STORES.events, { keyPath: "eventId" });
  events.createIndex(INDEXES.eventsByUser, "userId", { unique: false });
  events.createIndex(INDEXES.eventsByObserved, ["userId", "observedAt"], { unique: false });
  events.createIndex(INDEXES.eventsByKind, ["userId", "kind", "observedAt"], {
    unique: false
  });
  events.createIndex(INDEXES.eventsByWorld, ["userId", "worldId", "observedAt"], {
    unique: false
  });

  const syncRuns = database.createObjectStore(STORES.syncRuns, { keyPath: "syncId" });
  syncRuns.createIndex(INDEXES.syncRunsByUser, "userId", { unique: false });
  syncRuns.createIndex(INDEXES.syncRunsByStarted, ["userId", "startedAt"], { unique: false });
  syncRuns.createIndex(
    INDEXES.syncRunsByRetention,
    ["retentionOwner", "startedAt", "syncId"],
    { unique: false }
  );

  database.createObjectStore(STORES.settings, { keyPath: "key" });
  database.createObjectStore(STORES.meta, { keyPath: "key" });
}

/**
 * Upgrade an existing v1 database in place. The upgrade transaction owns all
 * writes, so a cursor failure aborts both the new schema and record backfill.
 *
 * @param {IDBDatabase} database
 * @param {IDBTransaction} transaction
 */
function migrateV1ToV2(database, transaction) {
  const favoriteGroups = database.createObjectStore(STORES.favoriteGroups, {
    keyPath: ["userId", "groupId"]
  });
  favoriteGroups.createIndex(INDEXES.favoriteGroupsByUser, "userId", { unique: false });
  favoriteGroups.createIndex(
    INDEXES.favoriteGroupsByInternalName,
    ["userId", "internalName"],
    { unique: false }
  );

  const syncRuns = transaction.objectStore(STORES.syncRuns);
  syncRuns.createIndex(
    INDEXES.syncRunsByRetention,
    ["retentionOwner", "startedAt", "syncId"],
    { unique: false }
  );
  const request = syncRuns.openCursor();
  request.addEventListener("error", () => {
    transaction.abort();
  }, { once: true });
  request.addEventListener("success", () => {
    const cursor = request.result;
    if (cursor === null) {
      return;
    }
    const existing = /** @type {SyncRunRecord} */ (cursor.value);
    cursor.update({ ...existing, retentionOwner: retentionOwnerFor(existing) });
    cursor.continue();
  });

  const eventRequest = transaction.objectStore(STORES.events).openCursor();
  eventRequest.addEventListener("error", () => {
    transaction.abort();
  }, { once: true });
  eventRequest.addEventListener("success", () => {
    const cursor = eventRequest.result;
    if (cursor === null) {
      return;
    }
    const existing = /** @type {Omit<HistoryEvent, "notificationEligible">} */ (cursor.value);
    cursor.update({ ...existing, notificationEligible: true });
    cursor.continue();
  });
}

/**
 * IndexedDB repository used by the extension service worker and UI.
 */
export class DatabaseRepository {
  /** @type {IDBFactory} */
  #factory;

  /** @type {string} */
  #name;

  /** @type {IDBDatabase | null} */
  #database = null;

  /**
   * @param {{ factory?: IDBFactory, name?: string }} [options]
   */
  constructor(options = {}) {
    if (options.factory === undefined && globalThis.indexedDB === undefined) {
      throw new Error("IndexedDB is not available");
    }
    this.#factory = options.factory ?? globalThis.indexedDB;
    this.#name = options.name ?? DATABASE_NAME;
  }

  /**
   * @returns {Promise<DatabaseRepository>}
   */
  async open() {
    if (this.#database !== null) {
      return this;
    }

    const request = this.#factory.open(this.#name, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", (event) => {
      const oldVersion = (/** @type {IDBVersionChangeEvent} */ (event)).oldVersion;
      const transaction = request.transaction;
      if (transaction === null) {
        throw new Error("IndexedDB upgrade transaction is unavailable");
      }
      if (oldVersion === 0) {
        installSchema(request.result);
      } else if (oldVersion === 1) {
        migrateV1ToV2(request.result, transaction);
      }
      transaction.objectStore(STORES.meta).put({
        key: "schemaVersion",
        value: DATABASE_VERSION
      });
      transaction.objectStore(STORES.meta).put({
        key: "backupFormatVersion",
        value: 2
      });
      transaction.objectStore(STORES.meta).put({
        key: "lastMigration",
        value: DATABASE_VERSION
      });
    });

    const database = await requestResult(request);
    database.addEventListener("versionchange", () => database.close());
    this.#database = database;
    return this;
  }

  close() {
    this.#database?.close();
    this.#database = null;
  }

  /**
   * @returns {IDBDatabase}
   */
  #requireDatabase() {
    if (this.#database === null) {
      throw new Error("DatabaseRepository.open() must be called first");
    }
    return this.#database;
  }

  /**
   * @param {string} userId
   * @returns {Promise<ProfileRecord | null>}
   */
  async getProfile(userId) {
    const transaction = this.#requireDatabase().transaction(STORES.profiles, "readonly");
    const value = await completeRead(
      transaction,
      getValue(transaction.objectStore(STORES.profiles), userId)
    );
    return value === undefined ? null : /** @type {ProfileRecord} */ (value);
  }

  /**
   * Read all inputs used to plan a sync from one IndexedDB snapshot.
   *
   * @param {string} userId
   * @returns {Promise<SyncSnapshot>}
   */
  async getSyncSnapshot(userId) {
    const transaction = this.#requireDatabase().transaction(
      [STORES.profiles, STORES.worlds, STORES.favoriteGroups, STORES.meta],
      "readonly"
    );
    const [profileValue, worldValues, favoriteGroupValues, generationRecord] = await completeRead(
      transaction,
      Promise.all([
        getValue(transaction.objectStore(STORES.profiles), userId),
        getAllValues(
          transaction.objectStore(STORES.worlds).index(INDEXES.worldsByUser),
          userId
        ),
        getAllValues(
          transaction.objectStore(STORES.favoriteGroups).index(INDEXES.favoriteGroupsByUser),
          userId
        ),
        getValue(transaction.objectStore(STORES.meta), generationKey(userId))
      ])
    );
    const worlds = /** @type {WorldRecord[]} */ (worldValues);
    worlds.sort((left, right) => left.worldId.localeCompare(right.worldId));
    const favoriteGroups = /** @type {FavoriteGroupRecord[]} */ (favoriteGroupValues);
    favoriteGroups.sort((left, right) => left.groupId.localeCompare(right.groupId));
    return {
      profile:
        profileValue === undefined ? null : /** @type {ProfileRecord} */ (profileValue),
      worlds,
      favoriteGroups,
      generation: generationValue(generationRecord, userId)
    };
  }

  /**
   * @param {string} userId
   * @returns {Promise<number>}
   */
  async getDataGeneration(userId) {
    const transaction = this.#requireDatabase().transaction(STORES.meta, "readonly");
    const stored = await completeRead(
      transaction,
      getValue(transaction.objectStore(STORES.meta), generationKey(userId))
    );
    return generationValue(stored, userId);
  }

  /**
   * Read every exported field in one transaction. Generation and operational
   * settings are intentionally absent from the returned backup snapshot.
   *
   * @param {string} userId
   * @returns {Promise<BackupSnapshot>}
   */
  async getBackupSnapshot(userId) {
    const transaction = this.#requireDatabase().transaction(
      [
        STORES.profiles,
        STORES.worlds,
        STORES.favoriteGroups,
        STORES.events,
        STORES.settings
      ],
      "readonly"
    );
    const [
      profileValue,
      worldValues,
      favoriteGroupValues,
      eventValues,
      autoSyncRecord,
      notificationRecord
    ] =
      await completeRead(
        transaction,
        Promise.all([
          getValue(transaction.objectStore(STORES.profiles), userId),
          getAllValues(
            transaction.objectStore(STORES.worlds).index(INDEXES.worldsByUser),
            userId
          ),
          getAllValues(
            transaction.objectStore(STORES.favoriteGroups).index(INDEXES.favoriteGroupsByUser),
            userId
          ),
          getAllValues(
            transaction.objectStore(STORES.events).index(INDEXES.eventsByUser),
            userId
          ),
          getValue(transaction.objectStore(STORES.settings), "autoSyncEnabled"),
          getValue(transaction.objectStore(STORES.settings), "notificationsEnabled")
        ])
      );

    const worlds = /** @type {WorldRecord[]} */ (worldValues);
    worlds.sort((left, right) => left.worldId.localeCompare(right.worldId));
    const favoriteGroups = /** @type {FavoriteGroupRecord[]} */ (favoriteGroupValues);
    favoriteGroups.sort((left, right) => left.groupId.localeCompare(right.groupId));
    const events = /** @type {HistoryEvent[]} */ (eventValues);
    events.sort((left, right) => left.eventId.localeCompare(right.eventId));
    /** @type {{ autoSyncEnabled?: boolean, notificationsEnabled?: boolean }} */
    const preferences = {};
    const autoSyncEnabled =
      autoSyncRecord === undefined
        ? undefined
        : (/** @type {StoredValue} */ (autoSyncRecord)).value;
    const notificationsEnabled =
      notificationRecord === undefined
        ? undefined
        : (/** @type {StoredValue} */ (notificationRecord)).value;
    if (typeof autoSyncEnabled === "boolean") {
      preferences.autoSyncEnabled = autoSyncEnabled;
    }
    if (typeof notificationsEnabled === "boolean") {
      preferences.notificationsEnabled = notificationsEnabled;
    }
    return {
      profile:
        profileValue === undefined ? null : /** @type {ProfileRecord} */ (profileValue),
      worlds,
      favoriteGroups,
      events,
      preferences
    };
  }

  /**
   * @returns {Promise<ProfileRecord[]>}
   */
  async listProfiles() {
    const transaction = this.#requireDatabase().transaction(STORES.profiles, "readonly");
    const request = /** @type {IDBRequest<unknown[]>} */ (
      transaction.objectStore(STORES.profiles).getAll()
    );
    const values = await completeRead(transaction, requestResult(request));
    return /** @type {ProfileRecord[]} */ (values).sort((left, right) =>
      left.userId.localeCompare(right.userId)
    );
  }

  /**
   * @param {ProfileRecord} profile
   * @returns {Promise<void>}
   */
  async saveProfile(profile) {
    const transaction = this.#requireDatabase().transaction(
      [STORES.profiles, STORES.settings, STORES.meta],
      "readwrite"
    );
    const finished = transactionFinished(transaction);
    try {
      const metaStore = transaction.objectStore(STORES.meta);
      const [storedGeneration, storedPurgePending] = await Promise.all([
        getValue(metaStore, generationKey(profile.userId)),
        getValue(transaction.objectStore(STORES.settings), "purgePending")
      ]);
      requireWritesAllowed(storedPurgePending);
      const nextGeneration = incrementGeneration(
        generationValue(storedGeneration, profile.userId),
        profile.userId
      );
      transaction.objectStore(STORES.profiles).put(profile);
      metaStore.put({ key: generationKey(profile.userId), value: nextGeneration });
    } catch (error) {
      return abortAndThrow(transaction, error, finished);
    }
    await finished;
  }

  /** Alias retained for call sites that use put terminology. */
  /**
   * @param {ProfileRecord} profile
   * @returns {Promise<void>}
   */
  putProfile(profile) {
    return this.saveProfile(profile);
  }

  /**
   * @param {string} userId
   * @returns {Promise<WorldRecord[]>}
   */
  async listWorlds(userId) {
    const transaction = this.#requireDatabase().transaction(STORES.worlds, "readonly");
    const values = await completeRead(
      transaction,
      getAllValues(
        transaction.objectStore(STORES.worlds).index(INDEXES.worldsByUser),
        userId
      )
    );
    return /** @type {WorldRecord[]} */ (values).sort((left, right) =>
      left.worldId.localeCompare(right.worldId)
    );
  }

  /**
   * @param {string} userId
   * @returns {Promise<FavoriteGroupRecord[]>}
   */
  async listFavoriteGroups(userId) {
    const transaction = this.#requireDatabase().transaction(STORES.favoriteGroups, "readonly");
    const values = await completeRead(
      transaction,
      getAllValues(
        transaction.objectStore(STORES.favoriteGroups).index(INDEXES.favoriteGroupsByUser),
        userId
      )
    );
    return /** @type {FavoriteGroupRecord[]} */ (values).sort((left, right) =>
      left.groupId.localeCompare(right.groupId)
    );
  }

  /**
   * @param {string} userId
   * @returns {Promise<HistoryEvent[]>}
   */
  async listEvents(userId) {
    const transaction = this.#requireDatabase().transaction(STORES.events, "readonly");
    const values = await completeRead(
      transaction,
      getAllValues(
        transaction.objectStore(STORES.events).index(INDEXES.eventsByUser),
        userId
      )
    );
    return /** @type {HistoryEvent[]} */ (values).sort((left, right) => {
      const byTime = right.observedAt.localeCompare(left.observedAt);
      return byTime === 0 ? left.eventId.localeCompare(right.eventId) : byTime;
    });
  }

  /**
   * Count profile data without materializing all records. Pending probes are
   * counted once per world from the same readonly snapshot as both totals.
   *
   * @param {string} userId
   * @returns {Promise<{ worldCount: number, eventCount: number, pendingProbeCount: number }>}
   */
  async getProfileStats(userId) {
    const transaction = this.#requireDatabase().transaction(
      [STORES.worlds, STORES.events],
      "readonly"
    );
    const worldIndex = transaction.objectStore(STORES.worlds).index(INDEXES.worldsByUser);
    const eventIndex = transaction.objectStore(STORES.events).index(INDEXES.eventsByUser);
    /** @type {Promise<number>} */
    const pendingProbeCount = new Promise((resolve, reject) => {
      let count = 0;
      const request = worldIndex.openCursor(userId);
      request.addEventListener("error", () => {
        reject(request.error ?? new Error("IndexedDB profile stats cursor failed"));
      }, { once: true });
      request.addEventListener("success", () => {
        const cursor = request.result;
        if (cursor === null) {
          resolve(count);
          return;
        }
        const world = /** @type {WorldRecord} */ (cursor.value);
        if (world.probeState === "pending" || world.availabilityState === "unavailable_once") {
          count += 1;
        }
        cursor.continue();
      });
    });
    const [worldCount, eventCount, pendingCount] = await completeRead(
      transaction,
      Promise.all([
        requestResult(worldIndex.count(userId)),
        requestResult(eventIndex.count(userId)),
        pendingProbeCount
      ])
    );
    return { worldCount, eventCount, pendingProbeCount: pendingCount };
  }

  /**
   * @param {string} userId
   * @returns {Promise<number>}
   */
  async getUnreadCount(userId) {
    const transaction = this.#requireDatabase().transaction(STORES.meta, "readonly");
    const stored = await completeRead(
      transaction,
      getValue(transaction.objectStore(STORES.meta), unreadCountKey(userId))
    );
    return unreadCountValue(stored, userId);
  }

  /**
   * @param {string} userId
   * @returns {Promise<void>}
   */
  async markEventsRead(userId) {
    const transaction = this.#requireDatabase().transaction(
      [STORES.settings, STORES.meta],
      "readwrite"
    );
    const finished = transactionFinished(transaction);
    try {
      const storedPurgePending = await getValue(
        transaction.objectStore(STORES.settings),
        "purgePending"
      );
      requireWritesAllowed(storedPurgePending);
      transaction.objectStore(STORES.meta).put({ key: unreadCountKey(userId), value: 0 });
    } catch (error) {
      return abortAndThrow(transaction, error, finished);
    }
    await finished;
  }

  /**
   * @template T
   * @param {string} key
   * @returns {Promise<T | undefined>}
   */
  async getSetting(key) {
    const transaction = this.#requireDatabase().transaction(STORES.settings, "readonly");
    const stored = await completeRead(
      transaction,
      getValue(transaction.objectStore(STORES.settings), key)
    );
    if (stored === undefined) {
      return undefined;
    }
    return /** @type {T} */ ((/** @type {StoredValue} */ (stored)).value);
  }

  /**
   * @param {string} key
   * @param {unknown} value
   * @returns {Promise<void>}
   */
  async setSetting(key, value) {
    return this.setSettings({ [key]: value });
  }

  /**
   * @param {Readonly<Record<string, unknown>>} updates
   * @returns {Promise<void>}
   */
  async setSettings(updates) {
    const transaction = this.#requireDatabase().transaction(STORES.settings, "readwrite");
    const finished = transactionFinished(transaction);
    try {
      const settingsStore = transaction.objectStore(STORES.settings);
      const storedPurgePending = await getValue(settingsStore, "purgePending");
      requireWritesAllowed(storedPurgePending);
      putSettings(settingsStore, updates);
    } catch (error) {
      return abortAndThrow(transaction, error, finished);
    }
    await finished;
  }

  /**
   * Atomically enable the durable purge guard. Concurrent and resumed callers
   * can safely retry: exactly one false-to-true transition returns true, while
   * an already-active guard returns false without weakening it.
   *
   * @returns {Promise<boolean>} true only when this call enabled the guard
   */
  async beginPurge() {
    const transaction = this.#requireDatabase().transaction(STORES.settings, "readwrite");
    const finished = transactionFinished(transaction);
    try {
      const settingsStore = transaction.objectStore(STORES.settings);
      const storedPurgePending = await getValue(settingsStore, "purgePending");
      if (storedPurgePending !== undefined) {
        const value = (/** @type {StoredValue} */ (storedPurgePending)).value;
        if (value === true) {
          await finished;
          return false;
        }
        if (value !== false) {
          throw new Error("Stored purge guard is invalid");
        }
      }
      settingsStore.put({ key: "purgePending", value: true });
    } catch (error) {
      return abortAndThrow(transaction, error, finished);
    }
    await finished;
    return true;
  }

  /**
   * Clear the durable write guard only after the background confirms that a
   * purge/uninstall attempt failed and normal operation should be repaired.
   * General setting APIs deliberately cannot perform this transition.
   *
   * @returns {Promise<void>}
   */
  async recoverFromFailedPurge() {
    const transaction = this.#requireDatabase().transaction(STORES.settings, "readwrite");
    const finished = transactionFinished(transaction);
    try {
      const settingsStore = transaction.objectStore(STORES.settings);
      const storedPurgePending = await getValue(settingsStore, "purgePending");
      if (
        storedPurgePending === undefined ||
        (/** @type {StoredValue} */ (storedPurgePending)).value !== true
      ) {
        throw new Error("Purge recovery requires an active purge guard");
      }
      settingsStore.put({ key: "purgePending", value: false });
    } catch (error) {
      return abortAndThrow(transaction, error, finished);
    }
    await finished;
  }

  /**
   * Persist one successful, already-reconciled sync plan atomically.
   *
   * @param {SyncCommit} commit
   * @returns {Promise<number>} the committed data generation
   */
  async commitSync(commit) {
    requireGeneration(commit.expectedGeneration, "expectedGeneration");
    if (!Array.isArray(commit.expectedWorldRevisions)) {
      throw new Error("expectedWorldRevisions is required for every sync commit");
    }
    if (commit.profile === null || typeof commit.profile !== "object") {
      throw new Error("Successful sync requires a profile");
    }
    if (commit.syncRun.result !== "success") {
      throw new Error("Failed sync runs must use recordSyncRun()");
    }
    if (commit.syncRun.userId !== commit.profile.userId) {
      throw new Error("Successful sync run does not belong to the committed profile");
    }
    validateSuccessSettings(commit.settings, commit.profile.userId);
    validateFavoriteGroupPlan(commit.favoriteGroups, commit.profile.userId);
    validateEventPlan(commit.events);

    /** @type {Map<string, number | null>} */
    const expectedRevisions = new Map();
    for (const expected of commit.expectedWorldRevisions) {
      if (
        expected.revision !== null &&
        (!Number.isSafeInteger(expected.revision) || expected.revision < 0)
      ) {
        throw new Error(`Invalid expected world revision: ${expected.worldId}`);
      }
      const key = `${expected.userId}\u0000${expected.worldId}`;
      if (expectedRevisions.has(key)) {
        throw new Error(`Duplicate expected world revision: ${expected.worldId}`);
      }
      expectedRevisions.set(key, expected.revision);
    }
    if (expectedRevisions.size !== commit.worlds.length) {
      throw new Error("Expected revisions must cover every committed world");
    }
    const committedWorldKeys = new Set();
    for (const world of commit.worlds) {
      if (world.userId !== commit.profile.userId) {
        throw new Error(`Committed world belongs to another profile: ${world.worldId}`);
      }
      if (!Number.isSafeInteger(world.revision) || world.revision < 0) {
        throw new Error(`Invalid committed world revision: ${world.worldId}`);
      }
      const key = `${world.userId}\u0000${world.worldId}`;
      if (committedWorldKeys.has(key)) {
        throw new Error(`Duplicate committed world: ${world.worldId}`);
      }
      committedWorldKeys.add(key);
    }
    const committedEventIds = new Set();
    for (const event of commit.events) {
      if (event.userId !== commit.profile.userId) {
        throw new Error(`Committed event belongs to another profile: ${event.eventId}`);
      }
      if (!committedWorldKeys.has(`${event.userId}\u0000${event.worldId}`)) {
        throw new Error(`Event target is not part of the sync plan: ${event.eventId}`);
      }
      if (committedEventIds.has(event.eventId)) {
        throw new Error(`Duplicate committed event: ${event.eventId}`);
      }
      committedEventIds.add(event.eventId);
    }

    const transaction = this.#requireDatabase().transaction(
      [
        STORES.profiles,
        STORES.worlds,
        STORES.favoriteGroups,
        STORES.events,
        STORES.syncRuns,
        STORES.settings,
        STORES.meta
      ],
      "readwrite"
    );
    const finished = transactionFinished(transaction);
    /** @type {number} */
    let nextGeneration;

    try {
      const worldStore = transaction.objectStore(STORES.worlds);
      const eventStore = transaction.objectStore(STORES.events);
      const settingsStore = transaction.objectStore(STORES.settings);
      const metaStore = transaction.objectStore(STORES.meta);
      const [
        storedPurgePending,
        storedGeneration,
        storedUnreadCount,
        currentWorlds,
        currentEvents
      ] = await Promise.all([
        getValue(settingsStore, "purgePending"),
        getValue(metaStore, generationKey(commit.profile.userId)),
        getValue(metaStore, unreadCountKey(commit.profile.userId)),
        Promise.all(
          commit.worlds.map((world) => getValue(worldStore, [world.userId, world.worldId]))
        ),
        Promise.all(commit.events.map((event) => getValue(eventStore, event.eventId)))
      ]);
      requireWritesAllowed(storedPurgePending);
      const actualGeneration = generationValue(storedGeneration, commit.profile.userId);
      if (actualGeneration !== commit.expectedGeneration) {
        throw new GenerationConflictError(
          commit.profile.userId,
          commit.expectedGeneration,
          actualGeneration
        );
      }
      nextGeneration = incrementGeneration(actualGeneration, commit.profile.userId);

      for (let index = 0; index < commit.worlds.length; index += 1) {
        const next = commit.worlds[index];
        if (next === undefined) {
          throw new Error("World revision validation failed");
        }
        const currentValue = currentWorlds[index];
        const currentRevision =
          currentValue === undefined ? null : (/** @type {WorldRecord} */ (currentValue)).revision;
        const expectedKey = `${next.userId}\u0000${next.worldId}`;
        if (!expectedRevisions.has(expectedKey)) {
          throw new Error(`Missing expected world revision: ${next.worldId}`);
        }
        const expectedRevision = expectedRevisions.get(expectedKey);
        const conflictsWithSnapshot = currentRevision !== expectedRevision;
        const plannedRevisionMovesBackwards =
          expectedRevision !== undefined &&
          expectedRevision !== null &&
          next.revision < expectedRevision;
        if (
          conflictsWithSnapshot ||
          plannedRevisionMovesBackwards
        ) {
          throw new RevisionConflictError(next.worldId);
        }
      }

      const currentUnreadCount = unreadCountValue(
        storedUnreadCount,
        commit.profile.userId
      );
      let newEventCount = 0;
      for (let index = 0; index < commit.events.length; index += 1) {
        const plannedEvent = commit.events[index];
        const currentEvent = currentEvents[index];
        if (plannedEvent === undefined) {
          throw new Error("Event validation failed");
        }
        if (currentEvent === undefined) {
          newEventCount += 1;
        } else if (!sameEventPayload(/** @type {HistoryEvent} */ (currentEvent), plannedEvent)) {
          throw new Error(`Event ID collision: ${plannedEvent.eventId}`);
        }
      }
      if (currentUnreadCount > Number.MAX_SAFE_INTEGER - newEventCount) {
        throw new RangeError(`Unread event count is exhausted: ${commit.profile.userId}`);
      }

      transaction.objectStore(STORES.profiles).put(commit.profile);
      for (const world of commit.worlds) {
        worldStore.put(world);
      }
      const favoriteGroupStore = transaction.objectStore(STORES.favoriteGroups);
      await deleteByIndex(
        favoriteGroupStore.index(INDEXES.favoriteGroupsByUser),
        commit.profile.userId
      );
      for (const favoriteGroup of commit.favoriteGroups) {
        favoriteGroupStore.put(favoriteGroup);
      }
      for (let index = 0; index < commit.events.length; index += 1) {
        const event = commit.events[index];
        if (event !== undefined && currentEvents[index] === undefined) {
          eventStore.put(event);
        }
      }
      await putSyncRunAndPrune(transaction.objectStore(STORES.syncRuns), commit.syncRun);
      putSettings(settingsStore, {
        activeProfileId: commit.settings.activeProfileId,
        backoffUntil: commit.settings.backoffUntil,
        consecutiveRateLimits: commit.settings.consecutiveRateLimits,
        lastSyncResult: commit.settings.lastSyncResult,
        favoriteGroupStatus: commit.settings.favoriteGroupStatus
      });
      metaStore.put({
        key: generationKey(commit.profile.userId),
        value: nextGeneration
      });
      metaStore.put({
        key: unreadCountKey(commit.profile.userId),
        value: currentUnreadCount + newEventCount
      });
    } catch (error) {
      return abortAndThrow(transaction, error, finished);
    }

    await finished;
    return nextGeneration;
  }

  /**
   * Persist a failed sync diagnostic without touching profile data generation.
   *
   * @param {SyncRunRecord} syncRun
   * @returns {Promise<void>}
   */
  async recordSyncRun(syncRun) {
    if (syncRun.result === "success") {
      throw new Error("Successful sync runs must use commitSync()");
    }
    const transaction = this.#requireDatabase().transaction(
      [STORES.syncRuns, STORES.settings],
      "readwrite"
    );
    const finished = transactionFinished(transaction);
    try {
      const storedPurgePending = await getValue(
        transaction.objectStore(STORES.settings),
        "purgePending"
      );
      requireWritesAllowed(storedPurgePending);
      await putSyncRunAndPrune(transaction.objectStore(STORES.syncRuns), syncRun);
    } catch (error) {
      return abortAndThrow(transaction, error, finished);
    }
    await finished;
  }

  /**
   * Permanently claim all currently-unclaimed events for one user. Supplying
   * event IDs narrows the claim to a specific sync/outbox batch.
   *
   * @param {string} userId
   * @param {string} claimedAt
   * @param {readonly string[] | undefined} eventIds
   * @param {{
   *   expectedGeneration: number,
   *   allowedKinds?: ReadonlyArray<HistoryEvent["kind"]>
   * }} options
   * @returns {Promise<HistoryEvent[]>}
   */
  async claimEvents(userId, claimedAt, eventIds, options) {
    requireGeneration(options.expectedGeneration, "expectedGeneration");
    if (!isCanonicalUtcTimestamp(claimedAt)) {
      throw new TypeError("claimedAt must be a canonical UTC timestamp");
    }
    const transaction = this.#requireDatabase().transaction(
      [STORES.events, STORES.settings, STORES.meta],
      "readwrite"
    );
    const finished = transactionFinished(transaction);
    const store = transaction.objectStore(STORES.events);
    const allowedIds = eventIds === undefined ? null : new Set(eventIds);
    const allowedKinds = options.allowedKinds === undefined
      ? null
      : new Set(options.allowedKinds);
    /** @type {HistoryEvent[]} */
    const claimed = [];

    try {
      const [storedPurgePending, storedGeneration] = await Promise.all([
        getValue(transaction.objectStore(STORES.settings), "purgePending"),
        getValue(transaction.objectStore(STORES.meta), generationKey(userId))
      ]);
      requireWritesAllowed(storedPurgePending);
      const actualGeneration = generationValue(storedGeneration, userId);
      if (actualGeneration !== options.expectedGeneration) {
        throw new GenerationConflictError(userId, options.expectedGeneration, actualGeneration);
      }

      /** @type {unknown[][]} */
      let candidateGroups;
      if (allowedKinds === null) {
        candidateGroups = [await getAllValues(store.index(INDEXES.eventsByUser), userId)];
      } else {
        const index = store.index(INDEXES.eventsByKind);
        candidateGroups = await Promise.all([...allowedKinds].map((kind) => getAllValues(
          index,
          IDBKeyRange.bound([userId, kind, ""], [userId, kind, "\uffff"])
        )));
      }
      for (const candidate of candidateGroups.flat()) {
        const event = /** @type {HistoryEvent} */ (candidate);
        if (
          event.notificationEligible === true
          && event.notificationClaimedAt === null
          && (allowedIds === null || allowedIds.has(event.eventId))
        ) {
          const effectiveClaimedAt = event.observedAt > claimedAt
            ? event.observedAt
            : claimedAt;
          const updated = { ...event, notificationClaimedAt: effectiveClaimedAt };
          store.put(updated);
          claimed.push(updated);
        }
      }
    } catch (error) {
      return abortAndThrow(transaction, error, finished);
    }

    await finished;
    return claimed.sort((left, right) => left.eventId.localeCompare(right.eventId));
  }

  /**
   * Store the result of one notification attempt. The permanent claim is never
   * removed, even for an explicit failure.
   *
   * @param {readonly string[]} eventIds
   * @param {{ notifiedAt: string | null, notificationError: "api_rejected" | "permission_denied" | "unavailable" | null }} result
   * @param {{ expectedGeneration: number }} options
   * @returns {Promise<void>}
   */
  async updateNotificationResult(eventIds, result, options) {
    requireGeneration(options.expectedGeneration, "expectedGeneration");
    if (result.notifiedAt !== null && !isCanonicalUtcTimestamp(result.notifiedAt)) {
      throw new TypeError("notifiedAt must be a canonical UTC timestamp or null");
    }
    if (!NOTIFICATION_ERROR_SET.has(result.notificationError)) {
      throw new TypeError("notificationError must be a fixed error code or null");
    }
    if (result.notifiedAt !== null && result.notificationError !== null) {
      throw new TypeError("Notification success and error results are mutually exclusive");
    }
    if (eventIds.length === 0) {
      throw new Error("At least one event is required to update a notification result");
    }
    const transaction = this.#requireDatabase().transaction(
      [STORES.events, STORES.settings, STORES.meta],
      "readwrite"
    );
    const finished = transactionFinished(transaction);
    const store = transaction.objectStore(STORES.events);

    try {
      const [storedPurgePending, values] = await Promise.all([
        getValue(transaction.objectStore(STORES.settings), "purgePending"),
        Promise.all(eventIds.map((eventId) => getValue(store, eventId)))
      ]);
      requireWritesAllowed(storedPurgePending);
      /** @type {HistoryEvent[]} */
      const events = [];
      for (let index = 0; index < eventIds.length; index += 1) {
        const eventId = eventIds[index];
        const value = values[index];
        if (eventId === undefined || value === undefined) {
          throw new Error(`Unknown notification event: ${eventId ?? "missing event ID"}`);
        }
        const event = /** @type {HistoryEvent} */ (value);
        if (!event.notificationEligible) {
          throw new Error(`Notification event is suppressed: ${eventId}`);
        }
        if (event.notificationClaimedAt === null) {
          throw new Error(`Notification event is not claimed: ${eventId}`);
        }
        events.push(event);
      }
      const userId = events[0]?.userId;
      if (userId === undefined || events.some((event) => event.userId !== userId)) {
        throw new Error("Notification events must belong to one profile");
      }
      const storedGeneration = await getValue(
        transaction.objectStore(STORES.meta),
        generationKey(userId)
      );
      const actualGeneration = generationValue(storedGeneration, userId);
      if (actualGeneration !== options.expectedGeneration) {
        throw new GenerationConflictError(userId, options.expectedGeneration, actualGeneration);
      }
      for (const event of events) {
        const effectiveNotifiedAt = result.notifiedAt !== null
          && event.notificationClaimedAt !== null
          && event.notificationClaimedAt > result.notifiedAt
          ? event.notificationClaimedAt
          : result.notifiedAt;
        store.put({
          ...event,
          notifiedAt: effectiveNotifiedAt,
          notificationError: result.notificationError
        });
      }
    } catch (error) {
      return abortAndThrow(transaction, error, finished);
    }
    await finished;
  }

  /**
   * Atomically replace profile/world/event data for exactly one user and merge
   * explicitly supplied boolean preferences. Other users are untouched.
   *
   * @param {ProfileReplacement} replacement
   * @returns {Promise<number>} the replacement data generation
   */
  async replaceProfileData(replacement) {
    const { profile, worlds, favoriteGroups, events, preferences = {} } = replacement;
    if (worlds.some((world) => world.userId !== profile.userId)) {
      throw new Error("Replacement contains a world owned by another profile");
    }
    if (events.some((event) => event.userId !== profile.userId)) {
      throw new Error("Replacement contains an event owned by another profile");
    }
    validateFavoriteGroupPlan(favoriteGroups, profile.userId);
    validateEventPlan(events);
    for (const key of Object.keys(preferences)) {
      if (!BACKUP_PREFERENCE_KEYS.includes(key)) {
        throw new Error(`Replacement contains an unsafe preference: ${key}`);
      }
      if (typeof preferences[key] !== "boolean") {
        throw new Error(`Replacement preference must be boolean: ${key}`);
      }
    }

    const transaction = this.#requireDatabase().transaction(
      [
        STORES.profiles,
        STORES.worlds,
        STORES.favoriteGroups,
        STORES.events,
        STORES.settings,
        STORES.meta
      ],
      "readwrite"
    );
    const finished = transactionFinished(transaction);
    /** @type {number} */
    let nextGeneration;

    try {
      const metaStore = transaction.objectStore(STORES.meta);
      const [storedPurgePending, storedGeneration] = await Promise.all([
        getValue(transaction.objectStore(STORES.settings), "purgePending"),
        getValue(metaStore, generationKey(profile.userId))
      ]);
      requireWritesAllowed(storedPurgePending);
      nextGeneration = incrementGeneration(
        generationValue(storedGeneration, profile.userId),
        profile.userId
      );
      await Promise.all([
        deleteByIndex(
          transaction.objectStore(STORES.worlds).index(INDEXES.worldsByUser),
          profile.userId
        ),
        deleteByIndex(
          transaction.objectStore(STORES.events).index(INDEXES.eventsByUser),
          profile.userId
        ),
        deleteByIndex(
          transaction.objectStore(STORES.favoriteGroups).index(INDEXES.favoriteGroupsByUser),
          profile.userId
        )
      ]);

      transaction.objectStore(STORES.profiles).put(profile);
      const worldStore = transaction.objectStore(STORES.worlds);
      for (const world of worlds) {
        worldStore.put(world);
      }
      const favoriteGroupStore = transaction.objectStore(STORES.favoriteGroups);
      for (const favoriteGroup of favoriteGroups) {
        favoriteGroupStore.put(favoriteGroup);
      }
      const eventStore = transaction.objectStore(STORES.events);
      for (const event of events) {
        eventStore.put(event);
      }
      const settingStore = transaction.objectStore(STORES.settings);
      for (const key of Object.keys(preferences)) {
        settingStore.put({ key, value: preferences[key] });
      }
      metaStore.put({ key: generationKey(profile.userId), value: nextGeneration });
      metaStore.put({ key: unreadCountKey(profile.userId), value: 0 });
    } catch (error) {
      return abortAndThrow(transaction, error, finished);
    }

    await finished;
    return nextGeneration;
  }

  /** Alias for consumers that do not use the Data suffix. */
  /**
   * @param {ProfileReplacement} replacement
   * @returns {Promise<number>}
   */
  replaceProfile(replacement) {
    return this.replaceProfileData(replacement);
  }

  /**
   * Delete all durable data owned by one profile in a single transaction.
   * Global settings and metadata are intentionally retained.
   *
   * @param {string} userId
   * @returns {Promise<number>} the cleared data generation
   */
  async clearProfile(userId) {
    const transaction = this.#requireDatabase().transaction(
      [
        STORES.profiles,
        STORES.worlds,
        STORES.favoriteGroups,
        STORES.events,
        STORES.syncRuns,
        STORES.settings,
        STORES.meta
      ],
      "readwrite"
    );
    const finished = transactionFinished(transaction);
    /** @type {number} */
    let nextGeneration;
    try {
      const metaStore = transaction.objectStore(STORES.meta);
      const [storedPurgePending, storedGeneration] = await Promise.all([
        getValue(transaction.objectStore(STORES.settings), "purgePending"),
        getValue(metaStore, generationKey(userId))
      ]);
      requireWritesAllowed(storedPurgePending);
      nextGeneration = incrementGeneration(generationValue(storedGeneration, userId), userId);
      transaction.objectStore(STORES.profiles).delete(userId);
      await Promise.all([
        deleteByIndex(
          transaction.objectStore(STORES.worlds).index(INDEXES.worldsByUser),
          userId
        ),
        deleteByIndex(
          transaction.objectStore(STORES.events).index(INDEXES.eventsByUser),
          userId
        ),
        deleteByIndex(
          transaction.objectStore(STORES.favoriteGroups).index(INDEXES.favoriteGroupsByUser),
          userId
        ),
        deleteByIndex(
          transaction.objectStore(STORES.syncRuns).index(INDEXES.syncRunsByUser),
          userId
        )
      ]);
      metaStore.put({ key: generationKey(userId), value: nextGeneration });
      metaStore.delete(unreadCountKey(userId));
    } catch (error) {
      return abortAndThrow(transaction, error, finished);
    }
    await finished;
    return nextGeneration;
  }

  /**
   * Atomically erase every user-owned record while keeping the minimum schema
   * and purge guard metadata. Keeping the database itself avoids the
   * uncancellable `deleteDatabase()` blocked-request race.
   *
   * @returns {Promise<void>}
   */
  async purgeAllData() {
    const transaction = this.#requireDatabase().transaction(
      Object.values(STORES),
      "readwrite"
    );
    const finished = transactionFinished(transaction);
    try {
      for (const storeName of Object.values(STORES)) {
        transaction.objectStore(storeName).clear();
      }
      transaction.objectStore(STORES.settings).put({ key: "purgePending", value: true });
      const metaStore = transaction.objectStore(STORES.meta);
      metaStore.put({ key: "schemaVersion", value: DATABASE_VERSION });
      metaStore.put({ key: "backupFormatVersion", value: 2 });
      metaStore.put({ key: "lastMigration", value: DATABASE_VERSION });
    } catch (error) {
      return abortAndThrow(transaction, error, finished);
    }
    await finished;
  }
}

/**
 * @param {{ factory?: IDBFactory, name?: string }} [options]
 * @returns {Promise<DatabaseRepository>}
 */
export async function openDatabase(options = {}) {
  const repository = new DatabaseRepository(options);
  await repository.open();
  return repository;
}
