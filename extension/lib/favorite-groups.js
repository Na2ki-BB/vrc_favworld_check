// @ts-check

import {normalizeSearchText} from "./domain.js";

export const MAX_FAVORITE_GROUP_NAME_HISTORY = 100;

export class FavoriteGroupValidationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "FavoriteGroupValidationError";
  }
}

const FAVORITE_GROUP_ID_PATTERN = /^fvgrp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const USER_ID_PATTERN = /^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const WORLD_GROUP_TYPES = new Set(["world", "vrcPlusWorld"]);
const MAX_TEXT_CODE_POINTS = 4_096;

/** @typedef {'world' | 'vrcPlusWorld'} FavoriteGroupType */

/**
 * @typedef {object} FavoriteGroupMetadata
 * @property {string} id
 * @property {string} name
 * @property {string} displayName
 * @property {string} ownerId
 * @property {FavoriteGroupType} type
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
 * @property {FavoriteGroupType} type
 * @property {boolean} active
 * @property {0 | 1 | 2} missingCount
 * @property {string} firstSeenAt
 * @property {string} lastSeenAt
 * @property {FavoriteGroupNameHistoryEntry[]} displayNameHistory
 * @property {string} updatedAt
 */

/**
 * @typedef {object} ReconcileFavoriteGroupsInput
 * @property {string} userId
 * @property {readonly FavoriteGroupRecord[]} previousGroups
 * @property {readonly FavoriteGroupMetadata[]} currentGroups
 * @property {string} observedAt
 */

/**
 * Reconcile a complete successful favorite-group snapshot. Missing groups are
 * retained as inactive so historic world tags can still be explained. A
 * rename stores the former display name and the time at which the change was
 * observed; the current name remains in the record's displayName field.
 *
 * @param {ReconcileFavoriteGroupsInput} input
 * @returns {FavoriteGroupRecord[]}
 */
export function reconcileFavoriteGroups(input) {
  assertUserId(input.userId, "userId");
  assertText(input.observedAt, "observedAt");

  /** @type {Map<string, FavoriteGroupRecord>} */
  const previousById = new Map();
  const previousInternalNames = new Set();
  for (const previous of input.previousGroups) {
    assertFavoriteGroupRecord(previous, input.userId);
    if (previousById.has(previous.groupId)) {
      throw new FavoriteGroupValidationError(
        "previousGroups must not contain duplicate groupId values",
      );
    }
    if (previous.active && previousInternalNames.has(previous.internalName)) {
      throw new FavoriteGroupValidationError(
        "Active previousGroups must not share an internalName",
      );
    }
    previousById.set(previous.groupId, previous);
    if (previous.active) {
      previousInternalNames.add(previous.internalName);
    }
  }

  /** @type {Map<string, FavoriteGroupMetadata>} */
  const currentById = new Map();
  const currentInternalNames = new Set();
  /** @type {Map<string, string>} */
  const currentIdByInternalName = new Map();
  for (const current of input.currentGroups) {
    assertFavoriteGroupMetadata(current, input.userId);
    if (currentById.has(current.id)) {
      throw new FavoriteGroupValidationError(
        "currentGroups must not contain duplicate id values",
      );
    }
    const internalName = current.name.trim();
    if (currentInternalNames.has(internalName)) {
      throw new FavoriteGroupValidationError(
        "currentGroups must not contain duplicate name values",
      );
    }
    currentById.set(current.id, current);
    currentInternalNames.add(internalName);
    currentIdByInternalName.set(internalName, current.id);
  }

  for (const previous of previousById.values()) {
    if (!previous.active) {
      continue;
    }
    const replacementId = currentIdByInternalName.get(previous.internalName.trim());
    if (replacementId !== undefined && replacementId !== previous.groupId) {
      throw new FavoriteGroupValidationError(
        "An active favorite group internalName must not move to another groupId",
      );
    }
  }

  /** @type {FavoriteGroupRecord[]} */
  const records = [];
  const groupIds = new Set([...previousById.keys(), ...currentById.keys()]);
  for (const groupId of [...groupIds].sort(compareText)) {
    const previous = previousById.get(groupId);
    const current = currentById.get(groupId);

    if (current === undefined) {
      if (previous === undefined) {
        continue;
      }
      records.push(cloneMissingGroup(previous, input.observedAt));
      continue;
    }

    const internalName = current.name.trim();
    const displayName = current.displayName.trim();
    if (previous === undefined) {
      records.push({
        userId: input.userId,
        groupId: current.id,
        internalName,
        displayName,
        normalizedDisplayName: normalizeSearchText(displayName),
        type: current.type,
        active: true,
        missingCount: 0,
        firstSeenAt: input.observedAt,
        lastSeenAt: input.observedAt,
        displayNameHistory: [],
        updatedAt: input.observedAt,
      });
      continue;
    }

    if (
      previous.internalName !== internalName
      || previous.type !== current.type
    ) {
      throw new FavoriteGroupValidationError(
        "Favorite group internalName and type must remain stable for a groupId",
      );
    }

    const displayNameHistory = previous.displayName === displayName
      ? cloneNameHistory(previous.displayNameHistory)
      : appendBoundedNameHistory(
        previous.displayNameHistory,
        previous.displayName,
        input.observedAt,
      );
    records.push({
      userId: input.userId,
      groupId: current.id,
      internalName,
      displayName,
      normalizedDisplayName: normalizeSearchText(displayName),
      type: current.type,
      active: true,
      missingCount: 0,
      firstSeenAt: previous.firstSeenAt,
      lastSeenAt: input.observedAt,
      displayNameHistory,
      updatedAt: input.observedAt,
    });
  }

  return records;
}

/**
 * Build labels for current tags. Active records take precedence; if a group
 * disappeared, its last known display name remains usable for history.
 *
 * @param {readonly FavoriteGroupRecord[]} groups
 * @returns {Map<string, string>}
 */
export function createFavoriteGroupLabelMap(groups) {
  const sorted = [...groups].sort(compareLabelCandidates);
  const labels = new Map();
  for (const group of sorted) {
    if (!labels.has(group.internalName)) {
      labels.set(group.internalName, group.displayName);
    }
  }
  return labels;
}

/**
 * @param {string} internalName
 * @param {ReadonlyMap<string, string>} labels
 * @returns {string}
 */
export function getFavoriteGroupLabel(internalName, labels) {
  const normalizedInternalName = assertText(internalName, "internalName");
  const knownLabel = labels.get(normalizedInternalName);
  if (knownLabel !== undefined && knownLabel.trim() !== "") {
    return knownLabel.trim();
  }
  const numberedWorldGroup = /^worlds([1-9][0-9]*)$/iu.exec(normalizedInternalName);
  if (numberedWorldGroup !== null) {
    return `リスト${numberedWorldGroup[1]}（${normalizedInternalName}）`;
  }
  const numberedPlusWorldGroup = /^vrcplusworlds([1-4])$/iu.exec(normalizedInternalName);
  return numberedPlusWorldGroup === null
    ? `お気に入りリスト（${normalizedInternalName}）`
    : `リスト${Number(numberedPlusWorldGroup[1]) + 4}（${normalizedInternalName}）`;
}

/**
 * @param {FavoriteGroupRecord} previous
 * @param {string} observedAt
 * @returns {FavoriteGroupRecord}
 */
function cloneMissingGroup(previous, observedAt) {
  if (!previous.active) {
    return {
      ...previous,
      missingCount: 2,
      displayNameHistory: cloneNameHistory(previous.displayNameHistory),
    };
  }
  const missingCount = previous.missingCount === 0 ? 1 : 2;
  return {
    ...previous,
    active: missingCount < 2,
    missingCount,
    displayNameHistory: cloneNameHistory(previous.displayNameHistory),
    updatedAt: observedAt,
  };
}

/**
 * @param {readonly FavoriteGroupNameHistoryEntry[]} history
 * @param {string} formerDisplayName
 * @param {string} observedAt
 * @returns {FavoriteGroupNameHistoryEntry[]}
 */
function appendBoundedNameHistory(history, formerDisplayName, observedAt) {
  const appended = [
    ...cloneNameHistory(history),
    {displayName: formerDisplayName, observedAt},
  ];
  return appended.slice(-MAX_FAVORITE_GROUP_NAME_HISTORY);
}

/**
 * @param {readonly FavoriteGroupNameHistoryEntry[]} history
 * @returns {FavoriteGroupNameHistoryEntry[]}
 */
function cloneNameHistory(history) {
  return history.map((entry) => ({...entry}));
}

/**
 * @param {FavoriteGroupMetadata} group
 * @param {string} expectedUserId
 */
function assertFavoriteGroupMetadata(group, expectedUserId) {
  if (!FAVORITE_GROUP_ID_PATTERN.test(group.id)) {
    throw new FavoriteGroupValidationError("Favorite group id must be an fvgrp_ UUID");
  }
  assertText(group.name, "Favorite group name");
  assertText(group.displayName, "Favorite group displayName");
  assertUserId(group.ownerId, "Favorite group ownerId");
  if (group.ownerId !== expectedUserId) {
    throw new FavoriteGroupValidationError("Favorite group ownerId must match userId");
  }
  assertFavoriteGroupType(group.type);
}

/**
 * @param {FavoriteGroupRecord} group
 * @param {string} expectedUserId
 */
function assertFavoriteGroupRecord(group, expectedUserId) {
  assertUserId(group.userId, "Favorite group userId");
  if (group.userId !== expectedUserId) {
    throw new FavoriteGroupValidationError(
      "Every previous group must belong to input.userId",
    );
  }
  if (!FAVORITE_GROUP_ID_PATTERN.test(group.groupId)) {
    throw new FavoriteGroupValidationError(
      "Favorite group groupId must be an fvgrp_ UUID",
    );
  }
  assertText(group.internalName, "Favorite group internalName");
  const displayName = assertText(group.displayName, "Favorite group displayName");
  if (group.normalizedDisplayName !== normalizeSearchText(displayName)) {
    throw new FavoriteGroupValidationError(
      "Favorite group normalizedDisplayName is inconsistent",
    );
  }
  assertFavoriteGroupType(group.type);
  if (typeof group.active !== "boolean") {
    throw new FavoriteGroupValidationError("Favorite group active must be boolean");
  }
  if (
    !Number.isInteger(group.missingCount)
    || group.missingCount < 0
    || group.missingCount > 2
    || (group.active && group.missingCount === 2)
    || (!group.active && group.missingCount !== 2)
  ) {
    throw new FavoriteGroupValidationError(
      "Favorite group active and missingCount are inconsistent",
    );
  }
  assertText(group.firstSeenAt, "Favorite group firstSeenAt");
  assertText(group.lastSeenAt, "Favorite group lastSeenAt");
  assertText(group.updatedAt, "Favorite group updatedAt");
  if (
    !Array.isArray(group.displayNameHistory)
    || group.displayNameHistory.length > MAX_FAVORITE_GROUP_NAME_HISTORY
  ) {
    throw new FavoriteGroupValidationError(
      "Favorite group displayNameHistory is invalid",
    );
  }
  for (const entry of group.displayNameHistory) {
    assertText(entry.displayName, "Favorite group history displayName");
    assertText(entry.observedAt, "Favorite group history observedAt");
  }
}

/**
 * @param {FavoriteGroupType} type
 */
function assertFavoriteGroupType(type) {
  if (!WORLD_GROUP_TYPES.has(type)) {
    throw new FavoriteGroupValidationError(
      "Favorite group type must be world or vrcPlusWorld",
    );
  }
}

/**
 * @param {string} userId
 * @param {string} fieldName
 */
function assertUserId(userId, fieldName) {
  if (!USER_ID_PATTERN.test(userId)) {
    throw new FavoriteGroupValidationError(`${fieldName} must be a VRChat usr_ UUID`);
  }
}

/**
 * @param {string} value
 * @param {string} fieldName
 * @returns {string}
 */
function assertText(value, fieldName) {
  if (typeof value !== "string") {
    throw new FavoriteGroupValidationError(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new FavoriteGroupValidationError(`${fieldName} must not be empty`);
  }
  let codePointCount = 0;
  for (const character of trimmed) {
    codePointCount += 1;
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePointCount > MAX_TEXT_CODE_POINTS
      || codePoint <= 31
      || (codePoint >= 127 && codePoint <= 159)
    ) {
      throw new FavoriteGroupValidationError(`${fieldName} contains unsupported text`);
    }
  }
  return trimmed;
}

/**
 * @param {FavoriteGroupRecord} left
 * @param {FavoriteGroupRecord} right
 * @returns {number}
 */
function compareLabelCandidates(left, right) {
  if (left.active !== right.active) {
    return left.active ? -1 : 1;
  }
  if (left.lastSeenAt !== right.lastSeenAt) {
    return compareText(right.lastSeenAt, left.lastSeenAt);
  }
  return compareText(left.groupId, right.groupId);
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
