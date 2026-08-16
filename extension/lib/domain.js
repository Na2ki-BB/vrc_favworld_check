// @ts-check

/**
 * Pure favorite-world reconciliation. This module deliberately has no browser,
 * network, clock, or storage dependencies.
 */

export const MEMBERSHIP_STATES = Object.freeze({
  FAVORITED: "favorited",
  MISSING_ONCE: "missing_once",
  NOT_IN_FAVORITES: "not_in_favorites",
});

export const AVAILABILITY_STATES = Object.freeze({
  UNKNOWN: "unknown",
  ACCESSIBLE: "accessible",
  UNAVAILABLE_ONCE: "unavailable_once",
  UNAVAILABLE: "unavailable",
});

export const PROBE_STATES = Object.freeze({
  NONE: "none",
  PENDING: "pending",
});

export const EVENT_KINDS = Object.freeze({
  NAME_CHANGED: "name_changed",
  FAVORITE_MISSING_CONFIRMED: "favorite_missing_confirmed",
  FAVORITE_RESTORED: "favorite_restored",
  ACCESS_UNAVAILABLE_CONFIRMED: "access_unavailable_confirmed",
  ACCESS_RESTORED: "access_restored",
});

export const EVENT_KIND_ORDER = Object.freeze([
  EVENT_KINDS.NAME_CHANGED,
  EVENT_KINDS.FAVORITE_MISSING_CONFIRMED,
  EVENT_KINDS.FAVORITE_RESTORED,
  EVENT_KINDS.ACCESS_UNAVAILABLE_CONFIRMED,
  EVENT_KINDS.ACCESS_RESTORED,
]);

export const MAX_PROBE_CANDIDATES = 20;

/** @typedef {'favorited' | 'missing_once' | 'not_in_favorites'} MembershipState */
/** @typedef {'unknown' | 'accessible' | 'unavailable_once' | 'unavailable'} AvailabilityState */
/** @typedef {'none' | 'pending'} ProbeState */
/** @typedef {'name_changed' | 'favorite_missing_confirmed' | 'favorite_restored' | 'access_unavailable_confirmed' | 'access_restored'} EventKind */

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
 * @property {MembershipState} membershipState
 * @property {0 | 1 | 2} membershipMissCount
 * @property {AvailabilityState} availabilityState
 * @property {0 | 1 | 2} unavailableCount
 * @property {ProbeState} probeState
 * @property {string | null} lastProbeAt
 * @property {200 | 404 | null} lastEvidenceStatus
 * @property {number} revision
 * @property {string} updatedAt
 */

/**
 * @typedef {object} HistoryEvent
 * @property {string} eventId
 * @property {string} userId
 * @property {string} worldId
 * @property {EventKind} kind
 * @property {string} observedAt
 * @property {string} before
 * @property {string} after
 * @property {{source: 'bulk' | 'probe', httpStatus: 200 | 404 | null}} evidence
 * @property {string} syncId
 * @property {string | null} notificationClaimedAt
 * @property {string | null} notifiedAt
 * @property {'api_rejected' | 'permission_denied' | 'unavailable' | null} notificationError
 */

/** @typedef {{worldId: string, tags: readonly string[]}} FavoriteRelation */
/** @typedef {{worldId: string, name: string, authorName: string, favoriteTags: readonly string[]}} WorldMetadata */
/** @typedef {{worldId: string, status: 200 | 404, metadata?: WorldMetadata}} WorldProbe */
/** @typedef {{worldId?: string, status: 200 | 404, metadata?: WorldMetadata}} MappedWorldProbe */

/**
 * @typedef {object} ReconcileInput
 * @property {string} userId
 * @property {readonly WorldRecord[]} previousWorlds
 * @property {readonly FavoriteRelation[]} favoriteRelations
 * @property {readonly WorldMetadata[]} metadata
 * @property {Map<string, MappedWorldProbe> | readonly WorldProbe[]} probes
 * @property {string} observedAt
 * @property {string} syncId
 * @property {boolean} isBaseline
 */

/**
 * @typedef {object} ProbeCandidateInput
 * @property {readonly WorldRecord[]} previousWorlds
 * @property {readonly FavoriteRelation[]} favoriteRelations
 * @property {readonly WorldMetadata[]} metadata
 * @property {number} [limit]
 */

/**
 * @typedef {object} PendingEvent
 * @property {EventKind} kind
 * @property {string} before
 * @property {string} after
 * @property {{source: 'bulk' | 'probe', httpStatus: 200 | 404 | null}} evidence
 */

const USER_ID_PATTERN = /^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const EVENT_ORDER_INDEX = new Map(
  EVENT_KIND_ORDER.map((kind, index) => [kind, index]),
);

/**
 * Produce a stable, human-searchable form without discarding Japanese text.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeSearchText(value) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ja-JP").replace(/\s+/gu, " ");
}

/**
 * Reconcile one complete and successful favorite snapshot with persisted state.
 * Invalid HTTP outcomes (401, 429, 5xx, network failures) must be stopped before
 * this boundary, so only conclusive 200/404 probes are represented here.
 *
 * @param {ReconcileInput} input
 * @returns {{worlds: WorldRecord[], events: HistoryEvent[]}}
 */
export function reconcileWorlds(input) {
  assertUserId(input.userId);
  assertNonEmptyString(input.observedAt, "observedAt");
  assertNonEmptyString(input.syncId, "syncId");

  /** @type {Map<string, WorldRecord>} */
  const previousById = new Map();
  for (const world of input.previousWorlds) {
    if (world.userId !== input.userId) {
      throw new TypeError("Every previous world must belong to input.userId");
    }
    if (!Number.isSafeInteger(world.revision) || world.revision < 0) {
      throw new TypeError("World revision must be a non-negative safe integer");
    }
    previousById.set(world.worldId, world);
  }

  const relationTagsById = indexFavoriteRelations(input.favoriteRelations);
  const metadataById = indexMetadata(input.metadata);
  const probesById = indexProbes(input.probes);
  const worldIds = new Set([...previousById.keys(), ...relationTagsById.keys()]);
  /** @type {WorldRecord[]} */
  const worlds = [];
  /** @type {HistoryEvent[]} */
  const events = [];

  for (const worldId of [...worldIds].sort(compareText)) {
    const previous = previousById.get(worldId);
    const relationTags = relationTagsById.get(worldId);
    const bulkMetadata = metadataById.get(worldId);
    const probe = probesById.get(worldId);

    if (previous === undefined) {
      worlds.push(createWorldRecord({
        userId: input.userId,
        worldId,
        relationTags: relationTags ?? [],
        bulkMetadata,
        probe,
        observedAt: input.observedAt,
      }));
      continue;
    }

    const result = updateWorldRecord({
      previous,
      hasFavoriteRelation: relationTags !== undefined,
      relationTags: relationTags ?? [],
      bulkMetadata,
      probe,
      observedAt: input.observedAt,
      syncId: input.syncId,
      suppressEvents: input.isBaseline,
    });
    worlds.push(result.world);
    events.push(...result.events);
  }

  return {worlds, events};
}

/**
 * Select at most `limit` individual-world probes. Lower priority number wins;
 * within a priority, never-probed/oldest records win, then world ID provides a
 * deterministic tie-breaker. The architecture's hard ceiling of 20 is always
 * enforced even if a larger limit is supplied.
 *
 * @param {ProbeCandidateInput} input
 * @returns {string[]}
 */
export function selectProbeCandidates(input) {
  const requestedLimit = input.limit ?? MAX_PROBE_CANDIDATES;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 0) {
    throw new TypeError("limit must be a non-negative integer");
  }
  const limit = Math.min(requestedLimit, MAX_PROBE_CANDIDATES);
  if (limit === 0) {
    return [];
  }

  const previousById = new Map(input.previousWorlds.map((world) => [world.worldId, world]));
  const relationIds = new Set(input.favoriteRelations.map((relation) => relation.worldId));
  const metadataIds = new Set(input.metadata.map((world) => world.worldId));
  /** @type {Map<string, {worldId: string, priority: number, lastProbeAt: string | null}>} */
  const candidates = new Map();

  /**
   * @param {string} worldId
   * @param {number} priority
   */
  const offer = (worldId, priority) => {
    const existing = candidates.get(worldId);
    if (existing !== undefined && existing.priority <= priority) {
      return;
    }
    candidates.set(worldId, {
      worldId,
      priority,
      lastProbeAt: previousById.get(worldId)?.lastProbeAt ?? null,
    });
  };

  for (const world of input.previousWorlds) {
    if (world.probeState === PROBE_STATES.PENDING) {
      offer(world.worldId, 1);
    }
  }
  for (const worldId of relationIds) {
    if (!metadataIds.has(worldId)) {
      offer(worldId, 2);
    }
  }
  for (const world of input.previousWorlds) {
    if (!relationIds.has(world.worldId) && world.membershipState === MEMBERSHIP_STATES.FAVORITED) {
      offer(world.worldId, 3);
    }
  }
  for (const world of input.previousWorlds) {
    if (
      world.membershipState === MEMBERSHIP_STATES.MISSING_ONCE
      || world.availabilityState === AVAILABILITY_STATES.UNAVAILABLE_ONCE
    ) {
      offer(world.worldId, 4);
    }
  }

  return [...candidates.values()]
    .sort(compareProbeCandidates)
    .slice(0, limit)
    .map((candidate) => candidate.worldId);
}

/**
 * @param {{
 *   userId: string,
 *   worldId: string,
 *   relationTags: readonly string[],
 *   bulkMetadata: WorldMetadata | undefined,
 *   probe: WorldProbe | undefined,
 *   observedAt: string,
 * }} input
 * @returns {WorldRecord}
 */
function createWorldRecord(input) {
  const successful = getSuccessfulEvidence(input.bulkMetadata, input.probe);
  const name = selectMetadataText(input.probe, input.bulkMetadata, "name")?.value ?? null;
  const authorName = selectMetadataText(input.probe, input.bulkMetadata, "authorName")?.value ?? null;
  const is404 = !successful.present && input.probe?.status === 404;
  const favoriteTags = collectCurrentFavoriteTags(
    input.relationTags,
    input.bulkMetadata,
    input.probe,
  );

  return {
    userId: input.userId,
    worldId: input.worldId,
    currentName: name,
    normalizedName: name === null ? null : normalizeSearchText(name),
    authorName,
    normalizedAuthorName: authorName === null ? null : normalizeSearchText(authorName),
    favoriteTags,
    firstSeenAt: input.observedAt,
    lastSeenFavoriteAt: input.observedAt,
    lastMetadataAt: successful.present ? input.observedAt : null,
    membershipState: MEMBERSHIP_STATES.FAVORITED,
    membershipMissCount: 0,
    availabilityState: successful.present
      ? AVAILABILITY_STATES.ACCESSIBLE
      : is404
        ? AVAILABILITY_STATES.UNAVAILABLE_ONCE
        : AVAILABILITY_STATES.UNKNOWN,
    unavailableCount: is404 ? 1 : 0,
    probeState: input.probe === undefined && input.bulkMetadata === undefined
      ? PROBE_STATES.PENDING
      : PROBE_STATES.NONE,
    lastProbeAt: input.probe === undefined ? null : input.observedAt,
    lastEvidenceStatus: successful.present ? 200 : is404 ? 404 : null,
    revision: 0,
    updatedAt: input.observedAt,
  };
}

/**
 * @param {{
 *   previous: WorldRecord,
 *   hasFavoriteRelation: boolean,
 *   relationTags: readonly string[],
 *   bulkMetadata: WorldMetadata | undefined,
 *   probe: WorldProbe | undefined,
 *   observedAt: string,
 *   syncId: string,
 *   suppressEvents: boolean,
 * }} input
 * @returns {{world: WorldRecord, events: HistoryEvent[]}}
 */
function updateWorldRecord(input) {
  const {previous} = input;
  /** @type {PendingEvent[]} */
  const pendingEvents = [];

  /** @type {MembershipState} */
  let membershipState;
  /** @type {0 | 1 | 2} */
  let membershipMissCount;
  if (input.hasFavoriteRelation) {
    membershipState = MEMBERSHIP_STATES.FAVORITED;
    membershipMissCount = 0;
    if (previous.membershipState === MEMBERSHIP_STATES.NOT_IN_FAVORITES) {
      pendingEvents.push({
        kind: EVENT_KINDS.FAVORITE_RESTORED,
        before: previous.membershipState,
        after: membershipState,
        evidence: {source: "bulk", httpStatus: null},
      });
    }
  } else {
    membershipMissCount = incrementSaturated(previous.membershipMissCount);
    membershipState = membershipMissCount === 1
      ? MEMBERSHIP_STATES.MISSING_ONCE
      : MEMBERSHIP_STATES.NOT_IN_FAVORITES;
    if (
      membershipMissCount === 2
      && previous.membershipState !== MEMBERSHIP_STATES.NOT_IN_FAVORITES
    ) {
      pendingEvents.push({
        kind: EVENT_KINDS.FAVORITE_MISSING_CONFIRMED,
        before: previous.membershipState,
        after: membershipState,
        evidence: {source: "bulk", httpStatus: null},
      });
    }
  }

  const successful = getSuccessfulEvidence(input.bulkMetadata, input.probe);
  const has404 = !successful.present && input.probe?.status === 404;
  /** @type {AvailabilityState} */
  let availabilityState = previous.availabilityState;
  /** @type {0 | 1 | 2} */
  let unavailableCount = previous.unavailableCount;

  if (successful.present) {
    availabilityState = AVAILABILITY_STATES.ACCESSIBLE;
    unavailableCount = 0;
    if (previous.availabilityState === AVAILABILITY_STATES.UNAVAILABLE) {
      pendingEvents.push({
        kind: EVENT_KINDS.ACCESS_RESTORED,
        before: previous.availabilityState,
        after: availabilityState,
        evidence: {source: successful.source, httpStatus: 200},
      });
    }
  } else if (has404) {
    unavailableCount = incrementSaturated(previous.unavailableCount);
    availabilityState = unavailableCount === 1
      ? AVAILABILITY_STATES.UNAVAILABLE_ONCE
      : AVAILABILITY_STATES.UNAVAILABLE;
    if (
      unavailableCount === 2
      && previous.availabilityState !== AVAILABILITY_STATES.UNAVAILABLE
    ) {
      pendingEvents.push({
        kind: EVENT_KINDS.ACCESS_UNAVAILABLE_CONFIRMED,
        before: previous.availabilityState,
        after: availabilityState,
        evidence: {source: "probe", httpStatus: 404},
      });
    }
  }

  const selectedName = selectMetadataText(input.probe, input.bulkMetadata, "name");
  const selectedAuthor = selectMetadataText(input.probe, input.bulkMetadata, "authorName");
  const currentName = selectedName?.value ?? previous.currentName;
  const authorName = selectedAuthor?.value ?? previous.authorName;
  if (
    selectedName !== undefined
    && previous.currentName !== null
    && selectedName.value !== previous.currentName
  ) {
    pendingEvents.push({
      kind: EVENT_KINDS.NAME_CHANGED,
      before: previous.currentName,
      after: selectedName.value,
      evidence: {source: selectedName.source, httpStatus: 200},
    });
  }

  const needsProbe = previous.probeState === PROBE_STATES.PENDING
    || (input.hasFavoriteRelation && input.bulkMetadata === undefined)
    || (!input.hasFavoriteRelation && previous.membershipState === MEMBERSHIP_STATES.FAVORITED)
    || previous.membershipState === MEMBERSHIP_STATES.MISSING_ONCE
    || previous.availabilityState === AVAILABILITY_STATES.UNAVAILABLE_ONCE;
  const probeState = input.probe !== undefined
    ? PROBE_STATES.NONE
    : needsProbe
      ? PROBE_STATES.PENDING
      : PROBE_STATES.NONE;

  const favoriteTags = input.hasFavoriteRelation
    ? collectCurrentFavoriteTags(input.relationTags, input.bulkMetadata, input.probe)
    : previous.favoriteTags.slice();
  const lastEvidenceStatus = successful.present
    ? 200
    : has404
      ? 404
      : previous.lastEvidenceStatus;

  pendingEvents.sort((left, right) => (
    (EVENT_ORDER_INDEX.get(left.kind) ?? Number.MAX_SAFE_INTEGER)
    - (EVENT_ORDER_INDEX.get(right.kind) ?? Number.MAX_SAFE_INTEGER)
  ));

  const membershipChanged = previous.membershipState !== membershipState;
  const availabilityChanged = previous.availabilityState !== availabilityState;
  const nameChanged = previous.currentName !== currentName;
  const hasMembershipEvent = pendingEvents.some((event) => (
    event.kind === EVENT_KINDS.FAVORITE_MISSING_CONFIRMED
    || event.kind === EVENT_KINDS.FAVORITE_RESTORED
  ));
  const hasAvailabilityEvent = pendingEvents.some((event) => (
    event.kind === EVENT_KINDS.ACCESS_UNAVAILABLE_CONFIRMED
    || event.kind === EVENT_KINDS.ACCESS_RESTORED
  ));
  const hasNameEvent = pendingEvents.some((event) => event.kind === EVENT_KINDS.NAME_CHANGED);

  let revision = previous.revision;
  if (input.suppressEvents) {
    revision += Number(membershipChanged) + Number(availabilityChanged) + Number(nameChanged);
  } else {
    revision += Number(membershipChanged && !hasMembershipEvent);
    revision += Number(availabilityChanged && !hasAvailabilityEvent);
    revision += Number(nameChanged && !hasNameEvent);
  }
  /** @type {HistoryEvent[]} */
  const events = [];
  if (!input.suppressEvents) {
    for (const pending of pendingEvents) {
      revision += 1;
      events.push({
        eventId: `${previous.userId}:${previous.worldId}:${revision}:${pending.kind}`,
        userId: previous.userId,
        worldId: previous.worldId,
        kind: pending.kind,
        observedAt: input.observedAt,
        before: pending.before,
        after: pending.after,
        evidence: pending.evidence,
        syncId: input.syncId,
        notificationClaimedAt: null,
        notifiedAt: null,
        notificationError: null,
      });
    }
  }

  return {
    world: {
      ...previous,
      userId: previous.userId,
      worldId: previous.worldId,
      currentName,
      normalizedName: currentName === null ? null : normalizeSearchText(currentName),
      authorName,
      normalizedAuthorName: authorName === null ? null : normalizeSearchText(authorName),
      favoriteTags,
      lastSeenFavoriteAt: input.hasFavoriteRelation ? input.observedAt : previous.lastSeenFavoriteAt,
      lastMetadataAt: successful.present ? input.observedAt : previous.lastMetadataAt,
      membershipState,
      membershipMissCount,
      availabilityState,
      unavailableCount,
      probeState,
      lastProbeAt: input.probe === undefined ? previous.lastProbeAt : input.observedAt,
      lastEvidenceStatus,
      revision,
      updatedAt: input.observedAt,
    },
    events,
  };
}

/**
 * @param {readonly FavoriteRelation[]} relations
 * @returns {Map<string, string[]>}
 */
function indexFavoriteRelations(relations) {
  /** @type {Map<string, Set<string>>} */
  const sets = new Map();
  for (const relation of relations) {
    let tags = sets.get(relation.worldId);
    if (tags === undefined) {
      tags = new Set();
      sets.set(relation.worldId, tags);
    }
    for (const tag of relation.tags) {
      const normalized = tag.trim();
      if (normalized !== "") {
        tags.add(normalized);
      }
    }
  }
  return new Map(
    [...sets].map(([worldId, tags]) => [worldId, [...tags].sort(compareText)]),
  );
}

/**
 * @param {readonly WorldMetadata[]} metadata
 * @returns {Map<string, WorldMetadata>}
 */
function indexMetadata(metadata) {
  return new Map(metadata.map((world) => [world.worldId, world]));
}

/**
 * @param {Map<string, MappedWorldProbe> | readonly WorldProbe[]} probes
 * @returns {Map<string, WorldProbe>}
 */
function indexProbes(probes) {
  /** @type {Map<string, WorldProbe>} */
  const result = new Map();
  if (probes instanceof Map) {
    for (const [worldId, probe] of probes) {
      if (probe.worldId !== undefined && probe.worldId !== worldId) {
        throw new TypeError("Probe map key and probe.worldId must match");
      }
      result.set(worldId, probe.metadata === undefined
        ? {worldId, status: probe.status}
        : {worldId, status: probe.status, metadata: probe.metadata});
    }
    return result;
  }
  for (const probe of probes) {
    result.set(probe.worldId, probe);
  }
  return result;
}

/**
 * @param {WorldMetadata | undefined} bulkMetadata
 * @param {WorldProbe | undefined} probe
 * @returns {{present: false} | {present: true, source: 'bulk' | 'probe'}}
 */
function getSuccessfulEvidence(bulkMetadata, probe) {
  if (probe?.status === 200) {
    return {present: true, source: "probe"};
  }
  if (bulkMetadata !== undefined) {
    return {present: true, source: "bulk"};
  }
  return {present: false};
}

/**
 * @param {WorldProbe | undefined} probe
 * @param {WorldMetadata | undefined} bulkMetadata
 * @param {'name' | 'authorName'} field
 * @returns {{value: string, source: 'probe' | 'bulk'} | undefined}
 */
function selectMetadataText(probe, bulkMetadata, field) {
  if (probe?.status === 200 && probe.metadata !== undefined) {
    const value = trimNonEmpty(probe.metadata[field]);
    if (value !== null) {
      return {value, source: "probe"};
    }
  }
  if (bulkMetadata !== undefined) {
    const value = trimNonEmpty(bulkMetadata[field]);
    if (value !== null) {
      return {value, source: "bulk"};
    }
  }
  return undefined;
}

/**
 * @param {readonly string[]} relationTags
 * @param {WorldMetadata | undefined} bulkMetadata
 * @param {WorldProbe | undefined} probe
 * @returns {string[]}
 */
function collectCurrentFavoriteTags(relationTags, bulkMetadata, probe) {
  /** @type {Set<string>} */
  const tags = new Set();
  for (const tag of relationTags) {
    const normalized = tag.trim();
    if (normalized !== "") {
      tags.add(normalized);
    }
  }
  if (bulkMetadata !== undefined) {
    addTags(tags, bulkMetadata.favoriteTags);
  }
  if (probe?.status === 200 && probe.metadata !== undefined) {
    addTags(tags, probe.metadata.favoriteTags);
  }
  return [...tags].sort(compareText);
}

/**
 * @param {Set<string>} target
 * @param {readonly string[]} values
 */
function addTags(target, values) {
  for (const tag of values) {
    const normalized = tag.trim();
    if (normalized !== "") {
      target.add(normalized);
    }
  }
}

/**
 * @param {0 | 1 | 2} count
 * @returns {1 | 2}
 */
function incrementSaturated(count) {
  return count >= 1 ? 2 : 1;
}

/**
 * @param {{priority: number, lastProbeAt: string | null, worldId: string}} left
 * @param {{priority: number, lastProbeAt: string | null, worldId: string}} right
 * @returns {number}
 */
function compareProbeCandidates(left, right) {
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }
  if (left.lastProbeAt === null && right.lastProbeAt !== null) {
    return -1;
  }
  if (left.lastProbeAt !== null && right.lastProbeAt === null) {
    return 1;
  }
  if (left.lastProbeAt !== right.lastProbeAt) {
    return compareText(left.lastProbeAt ?? "", right.lastProbeAt ?? "");
  }
  return compareText(left.worldId, right.worldId);
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * @param {string} value
 * @returns {string | null}
 */
function trimNonEmpty(value) {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * @param {string} userId
 */
function assertUserId(userId) {
  if (!USER_ID_PATTERN.test(userId)) {
    throw new TypeError("userId must be a VRChat usr_ UUID");
  }
}

/**
 * @param {string} value
 * @param {string} fieldName
 */
function assertNonEmptyString(value, fieldName) {
  if (value.trim() === "") {
    throw new TypeError(`${fieldName} must not be empty`);
  }
}
