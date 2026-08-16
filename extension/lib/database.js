// @ts-check

export const DATABASE_NAME = "vrc-favworld-check";
export const DATABASE_VERSION = 1;

const DATA_GENERATION_PREFIX = "dataGeneration:";
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
  "watchdogUntil"
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

export const STORES = Object.freeze({
  profiles: "profiles",
  worlds: "worlds",
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
  eventsByUser: "by-user",
  eventsByObserved: "by-user-observed-at",
  eventsByKind: "by-user-kind-observed-at",
  eventsByWorld: "by-user-world-observed-at",
  syncRunsByUser: "by-user",
  syncRunsByStarted: "by-user-started-at"
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
 * @typedef {object} EventEvidence
 * @property {"bulk" | "probe"} source
 * @property {200 | 404 | null} httpStatus
 */

/**
 * @typedef {object} HistoryEvent
 * @property {string} eventId
 * @property {string} userId
 * @property {string} worldId
 * @property {"name_changed" | "favorite_missing_confirmed" | "favorite_restored" | "access_unavailable_confirmed" | "access_restored"} kind
 * @property {string} observedAt
 * @property {string} before
 * @property {string} after
 * @property {EventEvidence} evidence
 * @property {string} syncId
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
 */

/**
 * @typedef {object} SyncCommit
 * @property {ProfileRecord} profile
 * @property {readonly WorldRecord[]} worlds
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
 * @property {readonly HistoryEvent[]} events
 * @property {Readonly<Record<string, boolean>>} [preferences]
 */

/** @typedef {{ key: string, value: unknown }} StoredValue */

/**
 * @typedef {object} SyncSnapshot
 * @property {ProfileRecord | null} profile
 * @property {WorldRecord[]} worlds
 * @property {number} generation
 */

/**
 * @typedef {object} BackupSnapshot
 * @property {ProfileRecord | null} profile
 * @property {WorldRecord[]} worlds
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
    if (!(abortError instanceof DOMException && abortError.name === "InvalidStateError")) {
      throw new AggregateError([error, abortError], "IndexedDB transaction cleanup failed", {
        cause: abortError
      });
    }
  }
  try {
    await finished;
  } catch (transactionError) {
    if (!(transactionError instanceof DOMException && transactionError.name === "AbortError")) {
      throw new AggregateError([error, transactionError], "IndexedDB transaction aborted", {
        cause: transactionError
      });
    }
  }
  throw error;
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
    "lastSyncResult"
  ];
  if (keys.length !== required.length || required.some((key) => !Object.hasOwn(settings, key))) {
    throw new Error("Successful sync settings must contain every required key only");
  }
  if (
    settings.activeProfileId !== userId ||
    settings.backoffUntil !== null ||
    settings.consecutiveRateLimits !== 0 ||
    settings.lastSyncResult !== "success"
  ) {
    throw new Error("Successful sync settings are inconsistent with the committed profile");
  }
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

  database.createObjectStore(STORES.settings, { keyPath: "key" });
  database.createObjectStore(STORES.meta, { keyPath: "key" });
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
      if ((/** @type {IDBVersionChangeEvent} */ (event)).oldVersion === 0) {
        installSchema(request.result);
        request.transaction?.objectStore(STORES.meta).put({
          key: "schemaVersion",
          value: DATABASE_VERSION
        });
        request.transaction?.objectStore(STORES.meta).put({
          key: "backupFormatVersion",
          value: 1
        });
        request.transaction?.objectStore(STORES.meta).put({
          key: "lastMigration",
          value: DATABASE_VERSION
        });
      }
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
      [STORES.profiles, STORES.worlds, STORES.meta],
      "readonly"
    );
    const [profileValue, worldValues, generationRecord] = await completeRead(
      transaction,
      Promise.all([
        getValue(transaction.objectStore(STORES.profiles), userId),
        getAllValues(
          transaction.objectStore(STORES.worlds).index(INDEXES.worldsByUser),
          userId
        ),
        getValue(transaction.objectStore(STORES.meta), generationKey(userId))
      ])
    );
    const worlds = /** @type {WorldRecord[]} */ (worldValues);
    worlds.sort((left, right) => left.worldId.localeCompare(right.worldId));
    return {
      profile:
        profileValue === undefined ? null : /** @type {ProfileRecord} */ (profileValue),
      worlds,
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
      [STORES.profiles, STORES.worlds, STORES.events, STORES.settings],
      "readonly"
    );
    const [profileValue, worldValues, eventValues, autoSyncRecord, notificationRecord] =
      await completeRead(
        transaction,
        Promise.all([
          getValue(transaction.objectStore(STORES.profiles), userId),
          getAllValues(
            transaction.objectStore(STORES.worlds).index(INDEXES.worldsByUser),
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
      [STORES.profiles, STORES.meta],
      "readwrite"
    );
    const finished = transactionFinished(transaction);
    try {
      const metaStore = transaction.objectStore(STORES.meta);
      const storedGeneration = await getValue(metaStore, generationKey(profile.userId));
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
      putSettings(transaction.objectStore(STORES.settings), updates);
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
    for (const event of commit.events) {
      if (event.userId !== commit.profile.userId) {
        throw new Error(`Committed event belongs to another profile: ${event.eventId}`);
      }
      if (!committedWorldKeys.has(`${event.userId}\u0000${event.worldId}`)) {
        throw new Error(`Event target is not part of the sync plan: ${event.eventId}`);
      }
    }

    const transaction = this.#requireDatabase().transaction(
      [
        STORES.profiles,
        STORES.worlds,
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
      const metaStore = transaction.objectStore(STORES.meta);
      const [storedGeneration, currentWorlds] = await Promise.all([
        getValue(metaStore, generationKey(commit.profile.userId)),
        Promise.all(
          commit.worlds.map((world) => getValue(worldStore, [world.userId, world.worldId]))
        )
      ]);
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

      transaction.objectStore(STORES.profiles).put(commit.profile);
      for (const world of commit.worlds) {
        worldStore.put(world);
      }
      const events = transaction.objectStore(STORES.events);
      for (const event of commit.events) {
        events.put(event);
      }
      transaction.objectStore(STORES.syncRuns).put(commit.syncRun);
      putSettings(transaction.objectStore(STORES.settings), {
        activeProfileId: commit.settings.activeProfileId,
        backoffUntil: commit.settings.backoffUntil,
        consecutiveRateLimits: commit.settings.consecutiveRateLimits,
        lastSyncResult: commit.settings.lastSyncResult
      });
      metaStore.put({
        key: generationKey(commit.profile.userId),
        value: nextGeneration
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
    const transaction = this.#requireDatabase().transaction(STORES.syncRuns, "readwrite");
    const finished = transactionFinished(transaction);
    try {
      transaction.objectStore(STORES.syncRuns).put(syncRun);
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
   * @param {{ expectedGeneration: number }} options
   * @returns {Promise<HistoryEvent[]>}
   */
  async claimEvents(userId, claimedAt, eventIds, options) {
    requireGeneration(options.expectedGeneration, "expectedGeneration");
    const transaction = this.#requireDatabase().transaction(
      [STORES.events, STORES.meta],
      "readwrite"
    );
    const finished = transactionFinished(transaction);
    const store = transaction.objectStore(STORES.events);
    const allowedIds = eventIds === undefined ? null : new Set(eventIds);
    /** @type {HistoryEvent[]} */
    const claimed = [];

    try {
      const storedGeneration = await getValue(
        transaction.objectStore(STORES.meta),
        generationKey(userId)
      );
      const actualGeneration = generationValue(storedGeneration, userId);
      if (actualGeneration !== options.expectedGeneration) {
        throw new GenerationConflictError(userId, options.expectedGeneration, actualGeneration);
      }

      const request = store.index(INDEXES.eventsByUser).openCursor(userId);
      request.addEventListener("success", () => {
        const cursor = request.result;
        if (cursor === null) {
          return;
        }
        const event = /** @type {HistoryEvent} */ (cursor.value);
        if (
          event.notificationClaimedAt === null &&
          (allowedIds === null || allowedIds.has(event.eventId))
        ) {
          const updated = { ...event, notificationClaimedAt: claimedAt };
          cursor.update(updated);
          claimed.push(updated);
        }
        cursor.continue();
      });
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
    if (eventIds.length === 0) {
      throw new Error("At least one event is required to update a notification result");
    }
    const transaction = this.#requireDatabase().transaction(
      [STORES.events, STORES.meta],
      "readwrite"
    );
    const finished = transactionFinished(transaction);
    const store = transaction.objectStore(STORES.events);

    try {
      const values = await Promise.all(eventIds.map((eventId) => getValue(store, eventId)));
      /** @type {HistoryEvent[]} */
      const events = [];
      for (let index = 0; index < eventIds.length; index += 1) {
        const eventId = eventIds[index];
        const value = values[index];
        if (eventId === undefined || value === undefined) {
          throw new Error(`Unknown notification event: ${eventId ?? "missing event ID"}`);
        }
        const event = /** @type {HistoryEvent} */ (value);
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
        store.put({
          ...event,
          notifiedAt: result.notifiedAt,
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
    const { profile, worlds, events, preferences = {} } = replacement;
    if (worlds.some((world) => world.userId !== profile.userId)) {
      throw new Error("Replacement contains a world owned by another profile");
    }
    if (events.some((event) => event.userId !== profile.userId)) {
      throw new Error("Replacement contains an event owned by another profile");
    }
    for (const key of Object.keys(preferences)) {
      if (!BACKUP_PREFERENCE_KEYS.includes(key)) {
        throw new Error(`Replacement contains an unsafe preference: ${key}`);
      }
      if (typeof preferences[key] !== "boolean") {
        throw new Error(`Replacement preference must be boolean: ${key}`);
      }
    }

    const transaction = this.#requireDatabase().transaction(
      [STORES.profiles, STORES.worlds, STORES.events, STORES.settings, STORES.meta],
      "readwrite"
    );
    const finished = transactionFinished(transaction);
    /** @type {number} */
    let nextGeneration;

    try {
      const metaStore = transaction.objectStore(STORES.meta);
      const storedGeneration = await getValue(metaStore, generationKey(profile.userId));
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
        )
      ]);

      transaction.objectStore(STORES.profiles).put(profile);
      const worldStore = transaction.objectStore(STORES.worlds);
      for (const world of worlds) {
        worldStore.put(world);
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
      [STORES.profiles, STORES.worlds, STORES.events, STORES.syncRuns, STORES.meta],
      "readwrite"
    );
    const finished = transactionFinished(transaction);
    /** @type {number} */
    let nextGeneration;
    try {
      const metaStore = transaction.objectStore(STORES.meta);
      const storedGeneration = await getValue(metaStore, generationKey(userId));
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
          transaction.objectStore(STORES.syncRuns).index(INDEXES.syncRunsByUser),
          userId
        )
      ]);
      metaStore.put({ key: generationKey(userId), value: nextGeneration });
    } catch (error) {
      return abortAndThrow(transaction, error, finished);
    }
    await finished;
    return nextGeneration;
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
