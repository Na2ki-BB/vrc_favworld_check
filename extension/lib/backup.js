// @ts-check

import { DATABASE_VERSION } from "./database.js";
import {
  isSchemaV2NotificationEligibleEventKind,
  normalizeSearchText
} from "./domain.js";

/** @typedef {import("./database.js").DatabaseRepository} DatabaseRepository */
/** @typedef {NonNullable<Awaited<ReturnType<DatabaseRepository["getProfile"]>>>} ProfileRecord */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listWorlds"]>>[number]} WorldRecord */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listEvents"]>>[number]} HistoryEvent */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listFavoriteGroups"]>>[number]} FavoriteGroupRecord */

export const BACKUP_FORMAT = "vrc_favworld_check-backup";
export const BACKUP_VERSION = 2;
export const MAX_BACKUP_BYTES = 25 * 1024 * 1024;
export const MAX_BACKUP_WORLDS = 10_000;
export const MAX_BACKUP_EVENTS = 100_000;
export const MAX_BACKUP_GROUPS = 100;
export const MAX_STRING_CODE_POINTS = 4_096;
export const SAFE_PREFERENCE_KEYS = Object.freeze([
  "autoSyncEnabled",
  "notificationsEnabled"
]);

const MAX_ARRAY_NESTING = 4;
const MAX_OBJECT_NESTING = 8;
const MAX_FAVORITE_TAGS = 100;
const MAX_FAVORITE_GROUP_NAME_HISTORY = 100;
const MAX_OBJECT_FIELDS = 64;
const MAX_GRAPH_NODES = 2_000_000;

const USER_ID_PATTERN = /^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORLD_ID_PATTERN = /^wrld_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAVORITE_GROUP_ID_PATTERN = /^fvgrp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYNC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const EVENT_KINDS_V1 = new Set([
  "name_changed",
  "favorite_missing_confirmed",
  "favorite_restored",
  "access_unavailable_confirmed",
  "access_restored"
]);
const EVENT_KINDS_V2 = new Set([...EVENT_KINDS_V1, "favorite_group_changed"]);
const FAVORITE_GROUP_TYPES = new Set(["world", "vrcPlusWorld"]);
const MEMBERSHIP_STATES = new Set(["favorited", "missing_once", "not_in_favorites"]);
const AVAILABILITY_STATES = new Set([
  "unknown",
  "accessible",
  "unavailable_once",
  "unavailable"
]);
const PROBE_STATES = new Set(["none", "pending"]);
const EVIDENCE_SOURCES = new Set(["bulk", "probe"]);
const NOTIFICATION_ERRORS = new Set([
  "api_rejected",
  "permission_denied",
  "unavailable"
]);
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SECRET_KEY_PATTERN = /(?:password|passwd|cookie|token|secret|session|authorization|credential)/i;

const TOP_LEVEL_FIELDS_V1 = new Set([
  "format",
  "version",
  "exportedAt",
  "appVersion",
  "profile",
  "worlds",
  "events",
  "preferences"
]);
const TOP_LEVEL_FIELDS_V2 = new Set([...TOP_LEVEL_FIELDS_V1, "favoriteGroups"]);
const PROFILE_FIELDS = new Set([
  "userId",
  "displayName",
  "firstSeenAt",
  "lastSuccessfulSyncAt",
  "createdBySchemaVersion"
]);
const WORLD_FIELDS = new Set([
  "userId",
  "worldId",
  "currentName",
  "normalizedName",
  "authorName",
  "normalizedAuthorName",
  "favoriteTags",
  "firstSeenAt",
  "lastSeenFavoriteAt",
  "lastMetadataAt",
  "membershipState",
  "membershipMissCount",
  "availabilityState",
  "unavailableCount",
  "probeState",
  "lastProbeAt",
  "lastEvidenceStatus",
  "revision",
  "updatedAt"
]);
const FAVORITE_GROUP_FIELDS = new Set([
  "userId",
  "groupId",
  "internalName",
  "displayName",
  "normalizedDisplayName",
  "type",
  "active",
  "missingCount",
  "firstSeenAt",
  "lastSeenAt",
  "displayNameHistory",
  "updatedAt"
]);
const FAVORITE_GROUP_HISTORY_FIELDS = new Set(["displayName", "observedAt"]);
const EVENT_FIELDS_V1 = new Set([
  "eventId",
  "userId",
  "worldId",
  "kind",
  "observedAt",
  "before",
  "after",
  "evidence",
  "syncId",
  "notificationClaimedAt",
  "notifiedAt",
  "notificationError"
]);
const EVENT_FIELDS_V2 = new Set([...EVENT_FIELDS_V1, "notificationEligible"]);
const EVIDENCE_FIELDS = new Set(["source", "httpStatus"]);
const PREFERENCE_FIELDS = new Set(SAFE_PREFERENCE_KEYS);

/**
 * @typedef {object} ValidatedBackup
 * @property {typeof BACKUP_FORMAT} format
 * @property {2} version
 * @property {string} exportedAt
 * @property {string} appVersion
 * @property {ProfileRecord} profile
 * @property {WorldRecord[]} worlds
 * @property {FavoriteGroupRecord[]} favoriteGroups
 * @property {HistoryEvent[]} events
 * @property {{ autoSyncEnabled?: boolean, notificationsEnabled?: boolean }} preferences
 */

/**
 * @typedef {object} BackupSummary
 * @property {string} userId
 * @property {string} displayName
 * @property {number} worldCount
 * @property {number} eventCount
 * @property {number} groupCount
 * @property {string} exportedAt
 */

/**
 * @param {string} message
 * @returns {never}
 */
function invalid(message) {
  throw new TypeError(`Invalid backup: ${message}`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reject prototype-pollution names, secret-bearing field names, and excessive
 * nesting before schema-specific processing.
 *
 * @param {unknown} root
 */
function inspectObjectGraph(root) {
  let visitedNodes = 0;

  /**
   * @param {unknown} value
   * @param {number} arrayDepth
   * @param {number} objectDepth
   * @param {string} path
   */
  function visit(value, arrayDepth, objectDepth, path) {
    visitedNodes += 1;
    if (visitedNodes > MAX_GRAPH_NODES) {
      invalid("object graph contains too many values");
    }
    if (value === null || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      const nextArrayDepth = arrayDepth + 1;
      if (value.length > MAX_BACKUP_EVENTS) {
        invalid(`${path} contains too many entries`);
      }
      if (nextArrayDepth > MAX_ARRAY_NESTING) {
        invalid(`${path} has too many nested arrays`);
      }
      for (let index = 0; index < value.length; index += 1) {
        visit(value[index], nextArrayDepth, objectDepth, `${path}[${index}]`);
      }
      return;
    }

    const nextObjectDepth = objectDepth + 1;
    if (nextObjectDepth > MAX_OBJECT_NESTING) {
      invalid(`${path} is nested too deeply`);
    }
    const record = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(record);
    if (keys.length > MAX_OBJECT_FIELDS) {
      invalid(`${path} contains too many fields`);
    }
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) {
        invalid(`${path} contains forbidden field ${key}`);
      }
      if (SECRET_KEY_PATTERN.test(key)) {
        invalid(`${path} contains a secret-bearing field`);
      }
      visit(record[key], arrayDepth, nextObjectDepth, `${path}.${key}`);
    }
  }

  visit(root, 0, 0, "$");
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function withoutPrototypes(value) {
  if (Array.isArray(value)) {
    return value.map((item) => withoutPrototypes(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  /** @type {Record<string, unknown>} */
  const normalized = Object.create(null);
  for (const key of Object.keys(value)) {
    normalized[key] = withoutPrototypes(value[key]);
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {Set<string>} fields
 * @returns {Record<string, unknown>}
 */
function exactRecord(value, path, fields) {
  if (!isRecord(value)) {
    invalid(`${path} must be an object`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      invalid(`${path}.${field} is required`);
    }
  }
  for (const field of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(field)) {
      invalid(`${path} contains forbidden field ${field}`);
    }
    if (SECRET_KEY_PATTERN.test(field)) {
      invalid(`${path} contains a secret-bearing field`);
    }
    if (!fields.has(field)) {
      invalid(`${path}.${field} is not supported`);
    }
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {{ allowEmpty?: boolean, maximum?: number }} [options]
 * @returns {string}
 */
function stringValue(value, path, options = {}) {
  if (typeof value !== "string") {
    invalid(`${path} must be a string`);
  }
  if (!(options.allowEmpty ?? false) && value.length === 0) {
    invalid(`${path} must not be empty`);
  }
  const maximum = options.maximum ?? MAX_STRING_CODE_POINTS;
  let codePoints = 0;
  for (const character of value) {
    void character;
    codePoints += 1;
    if (codePoints > maximum) {
      invalid(`${path} is too long`);
    }
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string | null}
 */
function nullableString(value, path) {
  return value === null ? null : stringValue(value, path);
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string}
 */
function isoDate(value, path) {
  const date = stringValue(value, path, { maximum: 40 });
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(date);
  const timestamp = Date.parse(date);
  const canonical =
    match === null
      ? null
      : `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  if (!Number.isFinite(timestamp)) {
    invalid(`${path} must be a UTC ISO 8601 timestamp`);
  }
  const normalized = new Date(timestamp).toISOString();
  if (normalized !== canonical) {
    invalid(`${path} must be a UTC ISO 8601 timestamp`);
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string | null}
 */
function nullableIsoDate(value, path) {
  return value === null ? null : isoDate(value, path);
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {number} minimum
 * @param {number} maximum
 * @returns {number}
 */
function integer(value, path, minimum, maximum) {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    invalid(`${path} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {Set<string>} allowed
 * @returns {string}
 */
function enumValue(value, path, allowed) {
  const selected = stringValue(value, path, { maximum: 100 });
  if (!allowed.has(selected)) {
    invalid(`${path} has an unsupported value`);
  }
  return selected;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {RegExp} pattern
 * @returns {string}
 */
function identifier(value, path, pattern) {
  const id = stringValue(value, path, { maximum: 200 });
  if (!pattern.test(id)) {
    invalid(`${path} has an invalid ID`);
  }
  return id;
}

/**
 * Locale-independent ordering keeps exported bytes stable across machines.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * @param {unknown} value
 * @param {1 | 2} sourceVersion
 * @returns {ProfileRecord}
 */
function profileRecord(value, sourceVersion) {
  const record = exactRecord(value, "$.profile", PROFILE_FIELDS);
  const createdBySchemaVersion = integer(
    record.createdBySchemaVersion,
    "$.profile.createdBySchemaVersion",
    1,
    sourceVersion === 1 ? 1 : DATABASE_VERSION
  );
  const profile = {
    userId: identifier(record.userId, "$.profile.userId", USER_ID_PATTERN),
    displayName: stringValue(record.displayName, "$.profile.displayName"),
    firstSeenAt: isoDate(record.firstSeenAt, "$.profile.firstSeenAt"),
    lastSuccessfulSyncAt: nullableIsoDate(
      record.lastSuccessfulSyncAt,
      "$.profile.lastSuccessfulSyncAt"
    ),
    createdBySchemaVersion
  };
  if (
    profile.lastSuccessfulSyncAt !== null &&
    profile.lastSuccessfulSyncAt < profile.firstSeenAt
  ) {
    invalid("$.profile.lastSuccessfulSyncAt must not precede firstSeenAt");
  }
  return profile;
}

/**
 * @param {unknown} value
 * @param {number} index
 * @param {string} userId
 * @returns {WorldRecord}
 */
function worldRecord(value, index, userId) {
  const path = `$.worlds[${index}]`;
  const record = exactRecord(value, path, WORLD_FIELDS);
  const recordUserId = identifier(record.userId, `${path}.userId`, USER_ID_PATTERN);
  if (recordUserId !== userId) {
    invalid(`${path}.userId does not match the profile`);
  }
  if (!Array.isArray(record.favoriteTags) || record.favoriteTags.length > MAX_FAVORITE_TAGS) {
    invalid(`${path}.favoriteTags must be a bounded array`);
  }
  const favoriteTags = record.favoriteTags.map((tag, tagIndex) =>
    stringValue(tag, `${path}.favoriteTags[${tagIndex}]`, { maximum: 200 })
  );
  if (new Set(favoriteTags).size !== favoriteTags.length) {
    invalid(`${path}.favoriteTags contains duplicates`);
  }

  const membershipMissCount = integer(record.membershipMissCount, `${path}.membershipMissCount`, 0, 2);
  const unavailableCount = integer(record.unavailableCount, `${path}.unavailableCount`, 0, 2);
  const lastEvidenceStatus = record.lastEvidenceStatus;
  if (lastEvidenceStatus !== null && lastEvidenceStatus !== 200 && lastEvidenceStatus !== 404) {
    invalid(`${path}.lastEvidenceStatus is invalid`);
  }

  const membershipState = /** @type {WorldRecord["membershipState"]} */ (
    enumValue(record.membershipState, `${path}.membershipState`, MEMBERSHIP_STATES)
  );
  const availabilityState = /** @type {WorldRecord["availabilityState"]} */ (
    enumValue(record.availabilityState, `${path}.availabilityState`, AVAILABILITY_STATES)
  );
  const expectedMembershipMissCount =
    membershipState === "favorited" ? 0 : membershipState === "missing_once" ? 1 : 2;
  if (membershipMissCount !== expectedMembershipMissCount) {
    invalid(`${path}.membershipMissCount is inconsistent with membershipState`);
  }
  const expectedUnavailableCount =
    availabilityState === "unavailable_once" ? 1 : availabilityState === "unavailable" ? 2 : 0;
  if (unavailableCount !== expectedUnavailableCount) {
    invalid(`${path}.unavailableCount is inconsistent with availabilityState`);
  }

  const world = {
    userId: recordUserId,
    worldId: identifier(record.worldId, `${path}.worldId`, WORLD_ID_PATTERN),
    currentName: nullableString(record.currentName, `${path}.currentName`),
    normalizedName: nullableString(record.normalizedName, `${path}.normalizedName`),
    authorName: nullableString(record.authorName, `${path}.authorName`),
    normalizedAuthorName: nullableString(record.normalizedAuthorName, `${path}.normalizedAuthorName`),
    favoriteTags,
    firstSeenAt: isoDate(record.firstSeenAt, `${path}.firstSeenAt`),
    lastSeenFavoriteAt: nullableIsoDate(record.lastSeenFavoriteAt, `${path}.lastSeenFavoriteAt`),
    lastMetadataAt: nullableIsoDate(record.lastMetadataAt, `${path}.lastMetadataAt`),
    membershipState,
    membershipMissCount: /** @type {0 | 1 | 2} */ (membershipMissCount),
    availabilityState,
    unavailableCount: /** @type {0 | 1 | 2} */ (unavailableCount),
    probeState: /** @type {WorldRecord["probeState"]} */ (
      enumValue(record.probeState, `${path}.probeState`, PROBE_STATES)
    ),
    lastProbeAt: nullableIsoDate(record.lastProbeAt, `${path}.lastProbeAt`),
    lastEvidenceStatus: /** @type {200 | 404 | null} */ (lastEvidenceStatus),
    revision: integer(record.revision, `${path}.revision`, 0, Number.MAX_SAFE_INTEGER),
    updatedAt: isoDate(record.updatedAt, `${path}.updatedAt`)
  };
  /** @type {Array<[string, string | null]>} */
  const relatedTimestamps = [
    ["lastSeenFavoriteAt", world.lastSeenFavoriteAt],
    ["lastMetadataAt", world.lastMetadataAt],
    ["lastProbeAt", world.lastProbeAt]
  ];
  for (const [fieldName, timestamp] of relatedTimestamps) {
    if (timestamp !== null && (timestamp < world.firstSeenAt || timestamp > world.updatedAt)) {
      invalid(`${path}.${fieldName} is outside the world record lifetime`);
    }
  }
  if (world.updatedAt < world.firstSeenAt) {
    invalid(`${path}.updatedAt must not precede firstSeenAt`);
  }
  return world;
}

/**
 * @param {unknown} value
 * @param {number} index
 * @param {string} userId
 * @returns {FavoriteGroupRecord}
 */
function favoriteGroupRecord(value, index, userId) {
  const path = `$.favoriteGroups[${index}]`;
  const record = exactRecord(value, path, FAVORITE_GROUP_FIELDS);
  const recordUserId = identifier(record.userId, `${path}.userId`, USER_ID_PATTERN);
  if (recordUserId !== userId) {
    invalid(`${path}.userId does not match the profile`);
  }
  if (typeof record.active !== "boolean") {
    invalid(`${path}.active must be boolean`);
  }
  const missingCount = integer(record.missingCount, `${path}.missingCount`, 0, 2);
  if (
    (record.active && missingCount !== 0 && missingCount !== 1) ||
    (!record.active && missingCount !== 2)
  ) {
    invalid(`${path}.missingCount is inconsistent with active`);
  }
  if (
    !Array.isArray(record.displayNameHistory) ||
    record.displayNameHistory.length > MAX_FAVORITE_GROUP_NAME_HISTORY
  ) {
    invalid(
      `${path}.displayNameHistory must contain at most ${MAX_FAVORITE_GROUP_NAME_HISTORY} entries`
    );
  }

  const displayName = stringValue(record.displayName, `${path}.displayName`);
  if (displayName !== displayName.trim()) {
    invalid(`${path}.displayName must not have surrounding whitespace`);
  }
  const internalName = stringValue(record.internalName, `${path}.internalName`, {
    maximum: 200
  });
  if (internalName !== internalName.trim()) {
    invalid(`${path}.internalName must not have surrounding whitespace`);
  }
  const normalizedDisplayName = stringValue(
    record.normalizedDisplayName,
    `${path}.normalizedDisplayName`,
    { allowEmpty: true }
  );
  if (normalizedDisplayName !== normalizeSearchText(displayName)) {
    invalid(`${path}.normalizedDisplayName is inconsistent with displayName`);
  }

  const firstSeenAt = isoDate(record.firstSeenAt, `${path}.firstSeenAt`);
  const lastSeenAt = isoDate(record.lastSeenAt, `${path}.lastSeenAt`);
  const updatedAt = isoDate(record.updatedAt, `${path}.updatedAt`);
  if (lastSeenAt < firstSeenAt || updatedAt < lastSeenAt) {
    invalid(`${path} timestamps are not chronological`);
  }

  let previousObservedAt = firstSeenAt;
  const displayNameHistory = record.displayNameHistory.map((entry, historyIndex) => {
    const historyPath = `${path}.displayNameHistory[${historyIndex}]`;
    const historyRecord = exactRecord(entry, historyPath, FAVORITE_GROUP_HISTORY_FIELDS);
    const historyDisplayName = stringValue(
      historyRecord.displayName,
      `${historyPath}.displayName`
    );
    if (historyDisplayName !== historyDisplayName.trim()) {
      invalid(`${historyPath}.displayName must not have surrounding whitespace`);
    }
    const observedAt = isoDate(historyRecord.observedAt, `${historyPath}.observedAt`);
    if (observedAt < previousObservedAt || observedAt > updatedAt) {
      invalid(`${historyPath}.observedAt is outside chronological order`);
    }
    previousObservedAt = observedAt;
    return { displayName: historyDisplayName, observedAt };
  });

  return {
    userId: recordUserId,
    groupId: identifier(record.groupId, `${path}.groupId`, FAVORITE_GROUP_ID_PATTERN),
    internalName,
    displayName,
    normalizedDisplayName,
    type: /** @type {FavoriteGroupRecord["type"]} */ (
      enumValue(record.type, `${path}.type`, FAVORITE_GROUP_TYPES)
    ),
    active: record.active,
    missingCount: /** @type {0 | 1 | 2} */ (missingCount),
    firstSeenAt,
    lastSeenAt,
    displayNameHistory,
    updatedAt
  };
}

/**
 * Validate and canonicalize the JSON-array representation used by
 * favorite_group_changed event payloads.
 *
 * @param {unknown} value
 * @param {string} path
 * @returns {string}
 */
function favoriteGroupChangeValue(value, path) {
  const encoded = stringValue(value, path, { maximum: 25_000 });
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    invalid(`${path} must be a JSON array`);
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_FAVORITE_TAGS) {
    invalid(`${path} must be a JSON array with at most ${MAX_FAVORITE_TAGS} entries`);
  }
  const values = parsed.map((entry, index) => {
    const groupName = stringValue(entry, `${path}[${index}]`, { maximum: 200 });
    if (groupName !== groupName.trim()) {
      invalid(`${path}[${index}] must not have surrounding whitespace`);
    }
    return groupName;
  });
  if (new Set(values).size !== values.length) {
    invalid(`${path} contains duplicate group names`);
  }
  values.sort(compareText);
  return JSON.stringify(values);
}

/**
 * @param {unknown} value
 * @param {number} index
 * @param {string} userId
 * @param {Map<string, WorldRecord>} worlds
 * @param {1 | 2} sourceVersion
 * @returns {HistoryEvent}
 */
function eventRecord(value, index, userId, worlds, sourceVersion) {
  const path = `$.events[${index}]`;
  const record = exactRecord(
    value,
    path,
    sourceVersion === 1 ? EVENT_FIELDS_V1 : EVENT_FIELDS_V2
  );
  const recordUserId = identifier(record.userId, `${path}.userId`, USER_ID_PATTERN);
  if (recordUserId !== userId) {
    invalid(`${path}.userId does not match the profile`);
  }
  const worldId = identifier(record.worldId, `${path}.worldId`, WORLD_ID_PATTERN);
  const world = worlds.get(worldId);
  if (world === undefined) {
    invalid(`${path}.worldId does not refer to a world in this backup`);
  }
  const kind = /** @type {HistoryEvent["kind"]} */ (
    enumValue(
      record.kind,
      `${path}.kind`,
      sourceVersion === 1 ? EVENT_KINDS_V1 : EVENT_KINDS_V2
    )
  );
  const eventId = stringValue(record.eventId, `${path}.eventId`, { maximum: 500 });
  const prefix = `${userId}:${worldId}:`;
  const suffix = `:${kind}`;
  if (!eventId.startsWith(prefix) || !eventId.endsWith(suffix)) {
    invalid(`${path}.eventId does not match its user, world, and kind`);
  }
  const revisionText = eventId.slice(prefix.length, -suffix.length);
  if (!/^(?:0|[1-9]\d*)$/.test(revisionText)) {
    invalid(`${path}.eventId has an invalid revision`);
  }
  const revision = Number(revisionText);
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > world.revision) {
    invalid(`${path}.eventId revision is inconsistent with its world`);
  }

  const evidenceRecord = exactRecord(record.evidence, `${path}.evidence`, EVIDENCE_FIELDS);
  const httpStatus = evidenceRecord.httpStatus;
  if (httpStatus !== null && httpStatus !== 200 && httpStatus !== 404) {
    invalid(`${path}.evidence.httpStatus is invalid`);
  }
  const notificationClaimedAt = nullableIsoDate(
    record.notificationClaimedAt,
    `${path}.notificationClaimedAt`
  );
  const notifiedAt = nullableIsoDate(record.notifiedAt, `${path}.notifiedAt`);
  const observedAt = isoDate(record.observedAt, `${path}.observedAt`);
  const notificationError =
    record.notificationError === null
      ? null
      : /** @type {NonNullable<HistoryEvent["notificationError"]>} */ (
          enumValue(record.notificationError, `${path}.notificationError`, NOTIFICATION_ERRORS)
        );
  const expectedNotificationEligibility = isSchemaV2NotificationEligibleEventKind(kind);
  const notificationEligible = sourceVersion === 1
    ? true
    : record.notificationEligible;
  if (
    typeof notificationEligible !== "boolean"
    || notificationEligible !== expectedNotificationEligibility
  ) {
    invalid(`${path}.notificationEligible does not match the event kind`);
  }
  if (notificationClaimedAt === null && (notifiedAt !== null || notificationError !== null)) {
    invalid(`${path} has a notification result without a claim`);
  }
  if (notifiedAt !== null && notificationError !== null) {
    invalid(`${path} has conflicting notification results`);
  }
  if (
    !notificationEligible
    && (
      notificationClaimedAt !== null
      || notifiedAt !== null
      || notificationError !== null
    )
  ) {
    invalid(`${path} has notification state for a suppressed event`);
  }
  if (notificationClaimedAt !== null && notificationClaimedAt < observedAt) {
    invalid(`${path}.notificationClaimedAt must not precede observedAt`);
  }
  if (
    notifiedAt !== null &&
    notificationClaimedAt !== null &&
    notifiedAt < notificationClaimedAt
  ) {
    invalid(`${path}.notifiedAt must not precede notificationClaimedAt`);
  }

  const before = kind === "favorite_group_changed"
    ? favoriteGroupChangeValue(record.before, `${path}.before`)
    : stringValue(record.before, `${path}.before`, { allowEmpty: false });
  const after = kind === "favorite_group_changed"
    ? favoriteGroupChangeValue(record.after, `${path}.after`)
    : stringValue(record.after, `${path}.after`, { allowEmpty: false });
  /** @type {Readonly<Record<Exclude<HistoryEvent["kind"], "favorite_group_changed">, readonly [string, string] | null>>} */
  const transitions = {
    name_changed: null,
    favorite_missing_confirmed: ["missing_once", "not_in_favorites"],
    favorite_restored: ["not_in_favorites", "favorited"],
    access_unavailable_confirmed: ["unavailable_once", "unavailable"],
    access_restored: ["unavailable", "accessible"]
  };
  if (kind === "favorite_group_changed") {
    if (before === after) {
      invalid(`${path}.before and ${path}.after must describe a change`);
    }
    if (evidenceRecord.source !== "bulk" || httpStatus !== null) {
      invalid(`${path}.evidence is invalid for a favorite group change`);
    }
  } else {
    const expectedTransition = transitions[kind];
    if (
      expectedTransition !== null &&
      (before !== expectedTransition[0] || after !== expectedTransition[1])
    ) {
      invalid(`${path}.before and ${path}.after do not match the event kind`);
    }
  }

  return {
    eventId,
    userId: recordUserId,
    worldId,
    kind,
    observedAt,
    before,
    after,
    evidence: {
      source: /** @type {"bulk" | "probe"} */ (
        enumValue(evidenceRecord.source, `${path}.evidence.source`, EVIDENCE_SOURCES)
      ),
      httpStatus
    },
    syncId: identifier(record.syncId, `${path}.syncId`, SYNC_ID_PATTERN),
    notificationEligible,
    notificationClaimedAt,
    notifiedAt,
    notificationError
  };
}

/**
 * @param {unknown} value
 * @returns {{ autoSyncEnabled?: boolean, notificationsEnabled?: boolean }}
 */
function preferenceRecord(value) {
  if (!isRecord(value)) {
    invalid("$.preferences must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!PREFERENCE_FIELDS.has(key)) {
      invalid(`$.preferences.${key} is not a safe preference`);
    }
    if (typeof value[key] !== "boolean") {
      invalid(`$.preferences.${key} must be boolean`);
    }
  }
  /** @type {{ autoSyncEnabled?: boolean, notificationsEnabled?: boolean }} */
  const preferences = {};
  if (typeof value.autoSyncEnabled === "boolean") {
    preferences.autoSyncEnabled = value.autoSyncEnabled;
  }
  if (typeof value.notificationsEnabled === "boolean") {
    preferences.notificationsEnabled = value.notificationsEnabled;
  }
  return preferences;
}

/**
 * Validate untrusted backup text and return a newly allocated allowlisted graph.
 * No input object is reused.
 *
 * @param {unknown} input
 * @returns {ValidatedBackup}
 */
export function validateBackup(input) {
  if (typeof input !== "string") {
    invalid("input must be JSON text");
  }
  if (new TextEncoder().encode(input).byteLength > MAX_BACKUP_BYTES) {
    invalid(`file exceeds ${MAX_BACKUP_BYTES} bytes`);
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    invalid("file is not valid JSON");
  }

  inspectObjectGraph(parsed);
  if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== 2)) {
    invalid("version is not supported");
  }
  const sourceVersion = /** @type {1 | 2} */ (parsed.version);
  const top = exactRecord(
    parsed,
    "$",
    sourceVersion === 1 ? TOP_LEVEL_FIELDS_V1 : TOP_LEVEL_FIELDS_V2
  );
  if (top.format !== BACKUP_FORMAT) {
    invalid("format is not supported");
  }
  const exportedAt = isoDate(top.exportedAt, "$.exportedAt");
  const appVersion = stringValue(top.appVersion, "$.appVersion", { maximum: 100 });
  const profile = profileRecord(top.profile, sourceVersion);

  if (!Array.isArray(top.worlds) || top.worlds.length > MAX_BACKUP_WORLDS) {
    invalid(`$.worlds must contain at most ${MAX_BACKUP_WORLDS} entries`);
  }
  if (!Array.isArray(top.events) || top.events.length > MAX_BACKUP_EVENTS) {
    invalid(`$.events must contain at most ${MAX_BACKUP_EVENTS} entries`);
  }
  const rawFavoriteGroups = sourceVersion === 1 ? [] : top.favoriteGroups;
  if (!Array.isArray(rawFavoriteGroups) || rawFavoriteGroups.length > MAX_BACKUP_GROUPS) {
    invalid(`$.favoriteGroups must contain at most ${MAX_BACKUP_GROUPS} entries`);
  }

  const worlds = top.worlds.map((world, index) => worldRecord(world, index, profile.userId));
  worlds.sort((left, right) => compareText(left.worldId, right.worldId));
  const worldsById = new Map(worlds.map((world) => [world.worldId, world]));
  if (worldsById.size !== worlds.length) {
    invalid("$.worlds contains duplicate world IDs");
  }

  const favoriteGroups = rawFavoriteGroups.map((group, index) =>
    favoriteGroupRecord(group, index, profile.userId)
  );
  favoriteGroups.sort((left, right) => compareText(left.groupId, right.groupId));
  if (new Set(favoriteGroups.map((group) => group.groupId)).size !== favoriteGroups.length) {
    invalid("$.favoriteGroups contains duplicate group IDs");
  }
  const activeInternalNames = favoriteGroups
    .filter((group) => group.active)
    .map((group) => group.internalName);
  if (new Set(activeInternalNames).size !== activeInternalNames.length) {
    invalid("$.favoriteGroups contains duplicate active internal names");
  }

  const events = top.events.map((event, index) =>
    eventRecord(event, index, profile.userId, worldsById, sourceVersion)
  );
  events.sort((left, right) => compareText(left.eventId, right.eventId));
  if (new Set(events.map((event) => event.eventId)).size !== events.length) {
    invalid("$.events contains duplicate event IDs");
  }

  const validated = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    appVersion,
    profile,
    worlds,
    favoriteGroups,
    events,
    preferences: preferenceRecord(top.preferences)
  };
  return /** @type {ValidatedBackup} */ (withoutPrototypes(validated));
}

/** Alias describing the parse-and-validate operation. */
export const parseBackup = validateBackup;

/**
 * @param {ValidatedBackup} backup
 * @returns {BackupSummary}
 */
export function backupSummary(backup) {
  return {
    userId: backup.profile.userId,
    displayName: backup.profile.displayName,
    worldCount: backup.worlds.length,
    eventCount: backup.events.length,
    groupCount: backup.favoriteGroups.length,
    exportedAt: backup.exportedAt
  };
}

/**
 * Export one profile as deterministic, human-readable JSON.
 *
 * @param {DatabaseRepository} repository
 * @param {string} userId
 * @param {{ appVersion?: string, exportedAt?: string }} [options]
 * @returns {Promise<string>}
 */
export async function createBackup(repository, userId, options = {}) {
  const snapshot = await repository.getBackupSnapshot(userId);
  if (snapshot.profile === null) {
    throw new Error(`Profile not found: ${userId}`);
  }

  const candidate = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    appVersion: options.appVersion ?? "0.1.7",
    profile: snapshot.profile,
    worlds: snapshot.worlds,
    favoriteGroups: snapshot.favoriteGroups,
    events: snapshot.events,
    preferences: snapshot.preferences
  };
  const validated = validateBackup(JSON.stringify(candidate));
  const text = `${JSON.stringify(validated, null, 2)}\n`;
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) {
    invalid(`file exceeds ${MAX_BACKUP_BYTES} bytes`);
  }
  return text;
}

export const exportProfileBackup = createBackup;

/**
 * Validate and atomically restore one profile. Past, unclaimed events are
 * permanently claimed at restore time so importing never emits old notices.
 *
 * @param {DatabaseRepository} repository
 * @param {unknown} input
 * @param {{ restoredAt?: string }} [options]
 * @returns {Promise<BackupSummary>}
 */
export async function restoreBackup(repository, input, options = {}) {
  const backup = validateBackup(input);
  const restoredAt = isoDate(options.restoredAt ?? new Date().toISOString(), "restoredAt");
  const events = backup.events.map((event) =>
    event.notificationEligible && event.notificationClaimedAt === null
      ? {
          ...event,
          notificationClaimedAt: event.observedAt > restoredAt ? event.observedAt : restoredAt
        }
      : event
  );

  await repository.replaceProfileData({
    profile: backup.profile,
    worlds: backup.worlds,
    favoriteGroups: backup.favoriteGroups,
    events,
    preferences: backup.preferences
  });
  return backupSummary(backup);
}

export const importProfileBackup = restoreBackup;
