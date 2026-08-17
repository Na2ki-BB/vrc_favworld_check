// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  FavoriteGroupValidationError,
  MAX_FAVORITE_GROUP_NAME_HISTORY,
  createFavoriteGroupLabelMap,
  getFavoriteGroupLabel,
  reconcileFavoriteGroups,
} from "../extension/lib/favorite-groups.js";

const USER_ID = "usr_01234567-89ab-cdef-0123-456789abcdef";
const OTHER_USER_ID = "usr_abcdef01-2345-6789-abcd-ef0123456789";
const T0 = "2026-08-15T00:00:00.000Z";
const T1 = "2026-08-16T00:00:00.000Z";
const T2 = "2026-08-17T00:00:00.000Z";
const T3 = "2026-08-18T00:00:00.000Z";

/** @typedef {Parameters<typeof reconcileFavoriteGroups>[0]["previousGroups"][number]} FavoriteGroupRecord */
/** @typedef {Parameters<typeof reconcileFavoriteGroups>[0]["currentGroups"][number]} FavoriteGroupMetadata */

/**
 * @param {number} number
 * @param {Partial<FavoriteGroupMetadata>} [overrides]
 * @returns {FavoriteGroupMetadata}
 */
function makeMetadata(number, overrides = {}) {
  return {
    id: `fvgrp_00000000-0000-0000-0000-${String(number).padStart(12, "0")}`,
    name: `worlds${number}`,
    displayName: `リスト ${number}`,
    ownerId: USER_ID,
    type: number > 4 ? "vrcPlusWorld" : "world",
    ...overrides,
  };
}

/**
 * @param {number} number
 * @param {Partial<FavoriteGroupRecord>} [overrides]
 * @returns {FavoriteGroupRecord}
 */
function makeRecord(number, overrides = {}) {
  return {
    userId: USER_ID,
    groupId: `fvgrp_00000000-0000-0000-0000-${String(number).padStart(12, "0")}`,
    internalName: `worlds${number}`,
    displayName: `リスト ${number}`,
    normalizedDisplayName: `リスト ${number}`,
    type: number > 4 ? "vrcPlusWorld" : "world",
    active: true,
    missingCount: 0,
    firstSeenAt: T0,
    lastSeenAt: T0,
    displayNameHistory: [],
    updatedAt: T0,
    ...overrides,
  };
}

test("a complete initial snapshot creates active records without name history", () => {
  const result = reconcileFavoriteGroups({
    userId: USER_ID,
    previousGroups: [],
    currentGroups: [
      makeMetadata(5, {displayName: "  VRC+ 思い出  "}),
      makeMetadata(1, {displayName: "  また行きたい場所  "}),
    ],
    observedAt: T1,
  });

  assert.deepEqual(result.map((group) => group.groupId), [
    makeMetadata(1).id,
    makeMetadata(5).id,
  ]);
  assert.deepEqual(result[0], {
    userId: USER_ID,
    groupId: makeMetadata(1).id,
    internalName: "worlds1",
    displayName: "また行きたい場所",
    normalizedDisplayName: "また行きたい場所",
    type: "world",
    active: true,
    missingCount: 0,
    firstSeenAt: T1,
    lastSeenAt: T1,
    displayNameHistory: [],
    updatedAt: T1,
  });
  assert.equal(result[1]?.type, "vrcPlusWorld");
});

test("a rename archives the former display name once and caps history", () => {
  const fullHistory = Array.from(
    {length: MAX_FAVORITE_GROUP_NAME_HISTORY},
    (_, index) => ({displayName: `旧名 ${index}`, observedAt: T0}),
  );
  const previous = makeRecord(1, {displayNameHistory: fullHistory});
  const renamed = reconcileFavoriteGroups({
    userId: USER_ID,
    previousGroups: [previous],
    currentGroups: [makeMetadata(1, {displayName: "新しいリスト名"})],
    observedAt: T1,
  });

  assert.equal(renamed[0]?.displayName, "新しいリスト名");
  assert.equal(renamed[0]?.normalizedDisplayName, "新しいリスト名");
  assert.equal(renamed[0]?.displayNameHistory.length, MAX_FAVORITE_GROUP_NAME_HISTORY);
  assert.equal(renamed[0]?.displayNameHistory[0]?.displayName, "旧名 1");
  assert.deepEqual(renamed[0]?.displayNameHistory.at(-1), {
    displayName: previous.displayName,
    observedAt: T1,
  });
  assert.equal(previous.displayNameHistory.length, MAX_FAVORITE_GROUP_NAME_HISTORY);

  const replay = reconcileFavoriteGroups({
    userId: USER_ID,
    previousGroups: renamed,
    currentGroups: [makeMetadata(1, {displayName: "新しいリスト名"})],
    observedAt: T2,
  });
  assert.deepEqual(replay[0]?.displayNameHistory, renamed[0]?.displayNameHistory);
});

test("groups become inactive only after two complete missing snapshots", () => {
  const previous = makeRecord(1);
  const missingOnce = reconcileFavoriteGroups({
    userId: USER_ID,
    previousGroups: [previous],
    currentGroups: [],
    observedAt: T1,
  });

  assert.equal(missingOnce[0]?.active, true);
  assert.equal(missingOnce[0]?.missingCount, 1);
  assert.equal(missingOnce[0]?.lastSeenAt, T0);
  assert.equal(missingOnce[0]?.updatedAt, T1);

  const missingTwice = reconcileFavoriteGroups({
    userId: USER_ID,
    previousGroups: missingOnce,
    currentGroups: [],
    observedAt: T2,
  });
  assert.equal(missingTwice[0]?.active, false);
  assert.equal(missingTwice[0]?.missingCount, 2);
  assert.equal(missingTwice[0]?.lastSeenAt, T0);
  assert.equal(missingTwice[0]?.updatedAt, T2);

  const stillMissing = reconcileFavoriteGroups({
    userId: USER_ID,
    previousGroups: missingTwice,
    currentGroups: [],
    observedAt: T3,
  });
  assert.equal(stillMissing[0]?.active, false);
  assert.equal(stillMissing[0]?.missingCount, 2);
  assert.equal(stillMissing[0]?.updatedAt, T2);
});

test("a group returning after one missing snapshot resets its counter", () => {
  const missingOnce = reconcileFavoriteGroups({
    userId: USER_ID,
    previousGroups: [makeRecord(1)],
    currentGroups: [],
    observedAt: T1,
  });
  const restored = reconcileFavoriteGroups({
    userId: USER_ID,
    previousGroups: missingOnce,
    currentGroups: [makeMetadata(1)],
    observedAt: T2,
  });

  assert.equal(restored[0]?.active, true);
  assert.equal(restored[0]?.missingCount, 0);
  assert.equal(restored[0]?.firstSeenAt, T0);
  assert.equal(restored[0]?.lastSeenAt, T2);
});

test("an inactive group returning later becomes active with a zero counter", () => {
  const inactive = makeRecord(1, {
    active: false,
    missingCount: 2,
    updatedAt: T2,
  });
  const restored = reconcileFavoriteGroups({
    userId: USER_ID,
    previousGroups: [inactive],
    currentGroups: [makeMetadata(1)],
    observedAt: T3,
  });

  assert.equal(restored[0]?.active, true);
  assert.equal(restored[0]?.missingCount, 0);
  assert.equal(restored[0]?.firstSeenAt, T0);
  assert.equal(restored[0]?.lastSeenAt, T3);
  assert.equal(restored[0]?.updatedAt, T3);
});

test("label helpers prefer active names and provide deterministic fallbacks", () => {
  const inactive = makeRecord(1, {
    displayName: "過去の名前",
    normalizedDisplayName: "過去の名前",
    active: false,
    missingCount: 2,
    lastSeenAt: T1,
  });
  const active = makeRecord(2, {
    internalName: "worlds1",
    displayName: "現在の名前",
    normalizedDisplayName: "現在の名前",
    lastSeenAt: T0,
  });
  const labels = createFavoriteGroupLabelMap([inactive, active]);

  assert.equal(getFavoriteGroupLabel("worlds1", labels), "現在の名前");
  assert.equal(getFavoriteGroupLabel("worlds8", labels), "リスト8（worlds8）");
  assert.equal(
    getFavoriteGroupLabel("vrcPlusWorlds1", labels),
    "リスト5（vrcPlusWorlds1）",
  );
  assert.equal(
    getFavoriteGroupLabel("vrcPlusWorlds4", labels),
    "リスト8（vrcPlusWorlds4）",
  );
  assert.equal(
    getFavoriteGroupLabel("custom-list", labels),
    "お気に入りリスト（custom-list）",
  );
});

test("reconciliation rejects cross-user, malformed, and duplicate snapshots", () => {
  assert.throws(
    () => reconcileFavoriteGroups({
      userId: USER_ID,
      previousGroups: [],
      currentGroups: [makeMetadata(1, {ownerId: OTHER_USER_ID})],
      observedAt: T1,
    }),
    (error) => {
      assert.ok(error instanceof FavoriteGroupValidationError);
      assert.equal(error.name, "FavoriteGroupValidationError");
      assert.match(error.message, /ownerId must match/u);
      return true;
    },
  );

  assert.throws(() => reconcileFavoriteGroups({
    userId: USER_ID,
    previousGroups: [],
    currentGroups: [makeMetadata(1, {id: "fvgrp_invalid"})],
    observedAt: T1,
  }), /fvgrp_ UUID/u);

  assert.throws(() => reconcileFavoriteGroups({
    userId: USER_ID,
    previousGroups: [],
    currentGroups: [makeMetadata(1), makeMetadata(2, {name: "worlds1"})],
    observedAt: T1,
  }), /duplicate name/u);

  assert.throws(() => reconcileFavoriteGroups({
    userId: USER_ID,
    previousGroups: [makeRecord(1, {normalizedDisplayName: "不一致"})],
    currentGroups: [],
    observedAt: T1,
  }), /inconsistent/u);

  assert.throws(() => reconcileFavoriteGroups({
    userId: USER_ID,
    previousGroups: [makeRecord(1)],
    currentGroups: [makeMetadata(1, {name: "worlds-renumbered"})],
    observedAt: T1,
  }), /must remain stable/u);

  assert.throws(() => reconcileFavoriteGroups({
    userId: USER_ID,
    previousGroups: [makeRecord(1)],
    currentGroups: [makeMetadata(1, {type: "vrcPlusWorld"})],
    observedAt: T1,
  }), /must remain stable/u);

  assert.throws(() => reconcileFavoriteGroups({
    userId: USER_ID,
    previousGroups: [makeRecord(1, {active: true, missingCount: 2})],
    currentGroups: [],
    observedAt: T1,
  }), /active and missingCount are inconsistent/u);

  assert.throws(() => reconcileFavoriteGroups({
    userId: USER_ID,
    previousGroups: [makeRecord(1, {active: false, missingCount: 1})],
    currentGroups: [],
    observedAt: T1,
  }), /active and missingCount are inconsistent/u);

  assert.throws(
    () => reconcileFavoriteGroups({
      userId: USER_ID,
      previousGroups: [makeRecord(1)],
      currentGroups: [makeMetadata(2, {name: "worlds1"})],
      observedAt: T1,
    }),
    (error) => {
      assert.ok(error instanceof FavoriteGroupValidationError);
      assert.match(error.message, /must not move to another groupId/u);
      return true;
    },
  );
});

test("unexpected TypeError values are not converted into validation failures", () => {
  const unexpected = new TypeError("unexpected programming failure");
  const input = /** @type {Parameters<typeof reconcileFavoriteGroups>[0]} */ (
    /** @type {unknown} */ ({
      userId: USER_ID,
      get previousGroups() {
        throw unexpected;
      },
      currentGroups: [],
      observedAt: T1,
    })
  );

  assert.throws(
    () => reconcileFavoriteGroups(input),
    (error) => error === unexpected
      && !(error instanceof FavoriteGroupValidationError),
  );
});
