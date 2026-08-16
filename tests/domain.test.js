// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  AVAILABILITY_STATES,
  EVENT_KINDS,
  MAX_PROBE_CANDIDATES,
  MEMBERSHIP_STATES,
  PROBE_STATES,
  normalizeSearchText,
  reconcileWorlds,
  selectProbeCandidates,
} from "../extension/lib/domain.js";

const USER_ID = "usr_01234567-89ab-cdef-0123-456789abcdef";
const T0 = "2026-08-15T00:00:00.000Z";
const T1 = "2026-08-16T00:00:00.000Z";
const T2 = "2026-08-17T00:00:00.000Z";
const T3 = "2026-08-18T00:00:00.000Z";

/** @typedef {Parameters<typeof reconcileWorlds>[0]["previousWorlds"][number]} WorldRecord */

/**
 * @param {Partial<WorldRecord>} [overrides]
 * @returns {WorldRecord}
 */
function makeWorld(overrides = {}) {
  return {
    userId: USER_ID,
    worldId: "wrld_default",
    currentName: "昔の名前",
    normalizedName: "昔の名前",
    authorName: "作者",
    normalizedAuthorName: "作者",
    favoriteTags: ["worlds1"],
    firstSeenAt: T0,
    lastSeenFavoriteAt: T0,
    lastMetadataAt: T0,
    membershipState: MEMBERSHIP_STATES.FAVORITED,
    membershipMissCount: 0,
    availabilityState: AVAILABILITY_STATES.ACCESSIBLE,
    unavailableCount: 0,
    probeState: PROBE_STATES.NONE,
    lastProbeAt: null,
    lastEvidenceStatus: 200,
    revision: 0,
    updatedAt: T0,
    ...overrides,
  };
}

test("normalizeSearchText normalizes width, case, trim, and whitespace", () => {
  assert.equal(normalizeSearchText("  ＶＲＣ\n  World　１２  "), "vrc world 12");
});

test("initial baseline records favorites without emitting notifications", () => {
  const result = reconcileWorlds({
    userId: USER_ID,
    previousWorlds: [],
    favoriteRelations: [
      {worldId: "wrld_a", tags: ["worlds2", "worlds1"]},
      {worldId: "wrld_a", tags: ["worlds1"]},
      {worldId: "wrld_b", tags: ["worlds3"]},
    ],
    metadata: [{
      worldId: "wrld_a",
      name: "  素敵な World  ",
      authorName: "  Alice  ",
      favoriteTags: ["worlds2"],
    }],
    probes: new Map(),
    observedAt: T1,
    syncId: "sync-baseline",
    isBaseline: true,
  });

  assert.deepEqual(result.events, []);
  assert.equal(result.worlds.length, 2);
  assert.deepEqual(result.worlds[0], {
    userId: USER_ID,
    worldId: "wrld_a",
    currentName: "素敵な World",
    normalizedName: "素敵な world",
    authorName: "Alice",
    normalizedAuthorName: "alice",
    favoriteTags: ["worlds1", "worlds2"],
    firstSeenAt: T1,
    lastSeenFavoriteAt: T1,
    lastMetadataAt: T1,
    membershipState: MEMBERSHIP_STATES.FAVORITED,
    membershipMissCount: 0,
    availabilityState: AVAILABILITY_STATES.ACCESSIBLE,
    unavailableCount: 0,
    probeState: PROBE_STATES.NONE,
    lastProbeAt: null,
    lastEvidenceStatus: 200,
    revision: 0,
    updatedAt: T1,
  });
  assert.equal(result.worlds[1]?.availabilityState, AVAILABILITY_STATES.UNKNOWN);
  assert.equal(result.worlds[1]?.probeState, PROBE_STATES.PENDING);
});

test("one missing snapshot is provisional and preserves known metadata", () => {
  const previous = makeWorld({worldId: "wrld_missing"});
  const result = reconcileWorlds({
    userId: USER_ID,
    previousWorlds: [previous],
    favoriteRelations: [],
    metadata: [],
    probes: [],
    observedAt: T1,
    syncId: "sync-missing-1",
    isBaseline: false,
  });

  assert.deepEqual(result.events, []);
  assert.equal(result.worlds[0]?.membershipState, MEMBERSHIP_STATES.MISSING_ONCE);
  assert.equal(result.worlds[0]?.membershipMissCount, 1);
  assert.equal(result.worlds[0]?.currentName, previous.currentName);
  assert.equal(result.worlds[0]?.authorName, previous.authorName);
  assert.deepEqual(result.worlds[0]?.favoriteTags, previous.favoriteTags);
  assert.equal(result.worlds[0]?.availabilityState, AVAILABILITY_STATES.ACCESSIBLE);
  assert.equal(result.worlds[0]?.probeState, PROBE_STATES.PENDING);
  assert.equal(result.worlds[0]?.revision, 1);
});

test("two missing snapshots confirm removal exactly once", () => {
  const once = makeWorld({
    worldId: "wrld_missing",
    membershipState: MEMBERSHIP_STATES.MISSING_ONCE,
    membershipMissCount: 1,
    probeState: PROBE_STATES.PENDING,
    revision: 1,
  });
  const confirmed = reconcileWorlds({
    userId: USER_ID,
    previousWorlds: [once],
    favoriteRelations: [],
    metadata: [],
    probes: [{worldId: "wrld_missing", status: 200}],
    observedAt: T2,
    syncId: "sync-missing-2",
    isBaseline: false,
  });

  assert.equal(confirmed.worlds[0]?.membershipState, MEMBERSHIP_STATES.NOT_IN_FAVORITES);
  assert.equal(confirmed.worlds[0]?.membershipMissCount, 2);
  assert.equal(confirmed.events.length, 1);
  assert.equal(confirmed.events[0]?.kind, EVENT_KINDS.FAVORITE_MISSING_CONFIRMED);
  assert.equal(
    confirmed.events[0]?.eventId,
    `${USER_ID}:wrld_missing:2:${EVENT_KINDS.FAVORITE_MISSING_CONFIRMED}`,
  );

  const replay = reconcileWorlds({
    userId: USER_ID,
    previousWorlds: confirmed.worlds,
    favoriteRelations: [],
    metadata: [],
    probes: [{worldId: "wrld_missing", status: 200}],
    observedAt: T3,
    syncId: "sync-missing-replay",
    isBaseline: false,
  });
  assert.deepEqual(replay.events, []);
  assert.equal(replay.worlds[0]?.revision, 2);
});

test("a 200 probe restores accessibility but does not erase the saved name", () => {
  const previous = makeWorld({
    worldId: "wrld_probe_200",
    availabilityState: AVAILABILITY_STATES.UNAVAILABLE_ONCE,
    unavailableCount: 1,
    probeState: PROBE_STATES.PENDING,
    lastEvidenceStatus: 404,
  });
  const result = reconcileWorlds({
    userId: USER_ID,
    previousWorlds: [previous],
    favoriteRelations: [{worldId: previous.worldId, tags: ["worlds1"]}],
    metadata: [],
    probes: new Map([[previous.worldId, {status: 200}]]),
    observedAt: T1,
    syncId: "sync-probe-200",
    isBaseline: false,
  });

  assert.deepEqual(result.events, []);
  assert.equal(result.worlds[0]?.availabilityState, AVAILABILITY_STATES.ACCESSIBLE);
  assert.equal(result.worlds[0]?.unavailableCount, 0);
  assert.equal(result.worlds[0]?.currentName, previous.currentName);
  assert.equal(result.worlds[0]?.lastMetadataAt, T1);
  assert.equal(result.worlds[0]?.lastProbeAt, T1);
  assert.equal(result.worlds[0]?.lastEvidenceStatus, 200);
});

test("two consecutive 404 probes confirm unavailability exactly once", () => {
  const previous = makeWorld({worldId: "wrld_404"});
  const first = reconcileWorlds({
    userId: USER_ID,
    previousWorlds: [previous],
    favoriteRelations: [{worldId: previous.worldId, tags: ["worlds1"]}],
    metadata: [],
    probes: [{worldId: previous.worldId, status: 404}],
    observedAt: T1,
    syncId: "sync-404-1",
    isBaseline: false,
  });
  assert.deepEqual(first.events, []);
  assert.equal(first.worlds[0]?.availabilityState, AVAILABILITY_STATES.UNAVAILABLE_ONCE);
  assert.equal(first.worlds[0]?.unavailableCount, 1);
  assert.equal(first.worlds[0]?.currentName, previous.currentName);

  const second = reconcileWorlds({
    userId: USER_ID,
    previousWorlds: first.worlds,
    favoriteRelations: [{worldId: previous.worldId, tags: ["worlds1"]}],
    metadata: [],
    probes: [{worldId: previous.worldId, status: 404}],
    observedAt: T2,
    syncId: "sync-404-2",
    isBaseline: false,
  });
  assert.equal(second.worlds[0]?.availabilityState, AVAILABILITY_STATES.UNAVAILABLE);
  assert.equal(second.events[0]?.kind, EVENT_KINDS.ACCESS_UNAVAILABLE_CONFIRMED);
  assert.equal(second.events[0]?.before, AVAILABILITY_STATES.UNAVAILABLE_ONCE);
  assert.equal(second.events[0]?.after, AVAILABILITY_STATES.UNAVAILABLE);

  const replay = reconcileWorlds({
    userId: USER_ID,
    previousWorlds: second.worlds,
    favoriteRelations: [{worldId: previous.worldId, tags: ["worlds1"]}],
    metadata: [],
    probes: [{worldId: previous.worldId, status: 404}],
    observedAt: T3,
    syncId: "sync-404-replay",
    isBaseline: false,
  });
  assert.deepEqual(replay.events, []);
  assert.equal(replay.worlds[0]?.revision, 2);
});

test("a trimmed name change emits one revision-backed event", () => {
  const previous = makeWorld({worldId: "wrld_rename", revision: 4});
  const metadata = [{
    worldId: previous.worldId,
    name: "  新しい名前  ",
    authorName: "作者",
    favoriteTags: ["worlds1"],
  }];
  const changed = reconcileWorlds({
    userId: USER_ID,
    previousWorlds: [previous],
    favoriteRelations: [{worldId: previous.worldId, tags: ["worlds1"]}],
    metadata,
    probes: [],
    observedAt: T1,
    syncId: "sync-rename",
    isBaseline: false,
  });

  assert.equal(changed.worlds[0]?.currentName, "新しい名前");
  assert.equal(changed.worlds[0]?.revision, 5);
  assert.deepEqual(changed.events.map(({kind, before, after}) => ({kind, before, after})), [{
    kind: EVENT_KINDS.NAME_CHANGED,
    before: "昔の名前",
    after: "新しい名前",
  }]);
  assert.equal(
    changed.events[0]?.eventId,
    `${USER_ID}:wrld_rename:5:${EVENT_KINDS.NAME_CHANGED}`,
  );

  const replay = reconcileWorlds({
    userId: USER_ID,
    previousWorlds: changed.worlds,
    favoriteRelations: [{worldId: previous.worldId, tags: ["worlds1"]}],
    metadata,
    probes: [],
    observedAt: T2,
    syncId: "sync-rename-replay",
    isBaseline: false,
  });
  assert.deepEqual(replay.events, []);
  assert.equal(replay.worlds[0]?.revision, 5);
});

test("favorite and access restoration are independent events", () => {
  const previous = makeWorld({
    worldId: "wrld_restored",
    membershipState: MEMBERSHIP_STATES.NOT_IN_FAVORITES,
    membershipMissCount: 2,
    availabilityState: AVAILABILITY_STATES.UNAVAILABLE,
    unavailableCount: 2,
    lastEvidenceStatus: 404,
    revision: 9,
  });
  const result = reconcileWorlds({
    userId: USER_ID,
    previousWorlds: [previous],
    favoriteRelations: [{worldId: previous.worldId, tags: ["worlds2"]}],
    metadata: [],
    probes: [{
      worldId: previous.worldId,
      status: 200,
      metadata: {
        worldId: previous.worldId,
        name: "昔の名前",
        authorName: "作者",
        favoriteTags: ["worlds2"],
      },
    }],
    observedAt: T2,
    syncId: "sync-restored",
    isBaseline: false,
  });

  assert.equal(result.worlds[0]?.membershipState, MEMBERSHIP_STATES.FAVORITED);
  assert.equal(result.worlds[0]?.availabilityState, AVAILABILITY_STATES.ACCESSIBLE);
  assert.deepEqual(result.events.map((event) => event.kind), [
    EVENT_KINDS.FAVORITE_RESTORED,
    EVENT_KINDS.ACCESS_RESTORED,
  ]);
  assert.deepEqual(result.events.map((event) => event.eventId), [
    `${USER_ID}:wrld_restored:10:${EVENT_KINDS.FAVORITE_RESTORED}`,
    `${USER_ID}:wrld_restored:11:${EVENT_KINDS.ACCESS_RESTORED}`,
  ]);
});

test("multiple confirmations in one sync use a deterministic kind order", () => {
  const previous = makeWorld({
    worldId: "wrld_compound",
    membershipState: MEMBERSHIP_STATES.MISSING_ONCE,
    membershipMissCount: 1,
    availabilityState: AVAILABILITY_STATES.UNAVAILABLE_ONCE,
    unavailableCount: 1,
    lastEvidenceStatus: 404,
    revision: 2,
  });
  const result = reconcileWorlds({
    userId: USER_ID,
    previousWorlds: [previous],
    favoriteRelations: [],
    metadata: [],
    probes: [{worldId: previous.worldId, status: 404}],
    observedAt: T2,
    syncId: "sync-compound",
    isBaseline: false,
  });

  assert.deepEqual(result.events.map((event) => event.kind), [
    EVENT_KINDS.FAVORITE_MISSING_CONFIRMED,
    EVENT_KINDS.ACCESS_UNAVAILABLE_CONFIRMED,
  ]);
  assert.deepEqual(result.events.map((event) => event.eventId), [
    `${USER_ID}:wrld_compound:3:${EVENT_KINDS.FAVORITE_MISSING_CONFIRMED}`,
    `${USER_ID}:wrld_compound:4:${EVENT_KINDS.ACCESS_UNAVAILABLE_CONFIRMED}`,
  ]);
});

test("probe selection respects priority, fairness, caller limit, and hard limit", () => {
  const previousWorlds = [
    makeWorld({
      worldId: "wrld_pending_newer",
      probeState: PROBE_STATES.PENDING,
      lastProbeAt: T1,
    }),
    makeWorld({
      worldId: "wrld_pending_never_b",
      probeState: PROBE_STATES.PENDING,
      lastProbeAt: null,
    }),
    makeWorld({
      worldId: "wrld_pending_never_a",
      probeState: PROBE_STATES.PENDING,
      lastProbeAt: null,
    }),
    makeWorld({worldId: "wrld_first_missing"}),
    makeWorld({
      worldId: "wrld_second_check",
      membershipState: MEMBERSHIP_STATES.MISSING_ONCE,
      membershipMissCount: 1,
    }),
  ];
  const selected = selectProbeCandidates({
    previousWorlds,
    favoriteRelations: [{worldId: "wrld_no_metadata", tags: ["worlds1"]}],
    metadata: [],
    limit: 5,
  });
  assert.deepEqual(selected, [
    "wrld_pending_never_a",
    "wrld_pending_never_b",
    "wrld_pending_newer",
    "wrld_no_metadata",
    "wrld_first_missing",
  ]);

  const manyRelations = Array.from({length: MAX_PROBE_CANDIDATES + 5}, (_, index) => ({
    worldId: `wrld_${String(index).padStart(2, "0")}`,
    tags: ["worlds1"],
  }));
  const capped = selectProbeCandidates({
    previousWorlds: [],
    favoriteRelations: manyRelations,
    metadata: [],
    limit: 100,
  });
  assert.equal(capped.length, MAX_PROBE_CANDIDATES);
  assert.equal(capped[0], "wrld_00");
  assert.equal(capped.at(-1), "wrld_19");
});

test("rejects a missing or non-VRChat user ID at the domain boundary", () => {
  assert.throws(() => reconcileWorlds({
    userId: "usr_not-a-uuid",
    previousWorlds: [],
    favoriteRelations: [],
    metadata: [],
    probes: [],
    observedAt: T1,
    syncId: "sync-invalid-user",
    isBaseline: true,
  }), /usr_ UUID/u);
});
