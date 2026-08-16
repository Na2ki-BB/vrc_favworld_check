// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  commandErrorMessage,
  eventDetail,
  filterEvents,
  filterWorlds,
  formatDateTime,
  normalizeCommandResponse,
  normalizeStatusResponse,
  presentEventKind,
  presentStatus,
  summarizeHistory,
  worldMatchesFilter,
  worldStateTags
} from "../extension/lib/ui.js";

/** @typedef {import("../extension/lib/database.js").DatabaseRepository} DatabaseRepository */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listWorlds"]>>[number]} WorldRecord */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listEvents"]>>[number]} HistoryEvent */

const USER_ID = "usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORLD_A = "wrld_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORLD_B = "wrld_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/**
 * @param {Partial<WorldRecord> & { worldId: string }} overrides
 * @returns {WorldRecord}
 */
function world(overrides) {
  const { worldId, ...rest } = overrides;
  return {
    userId: USER_ID,
    worldId,
    currentName: "静かな森",
    normalizedName: "静かな森",
    authorName: "作者A",
    normalizedAuthorName: "作者a",
    favoriteTags: [],
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    lastSeenFavoriteAt: "2026-08-10T00:00:00.000Z",
    lastMetadataAt: "2026-08-10T00:00:00.000Z",
    membershipState: "favorited",
    membershipMissCount: 0,
    availabilityState: "accessible",
    unavailableCount: 0,
    probeState: "none",
    lastProbeAt: null,
    lastEvidenceStatus: 200,
    revision: 1,
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...rest
  };
}

/**
 * @param {Partial<HistoryEvent> & Pick<HistoryEvent, "eventId" | "worldId" | "kind">} overrides
 * @returns {HistoryEvent}
 */
function historyEvent(overrides) {
  const { eventId, worldId, kind, ...rest } = overrides;
  return {
    eventId,
    userId: USER_ID,
    worldId,
    kind,
    observedAt: "2026-08-12T00:00:00.000Z",
    before: "before",
    after: "after",
    evidence: { source: "bulk", httpStatus: null },
    syncId: "sync-1",
    notificationClaimedAt: null,
    notifiedAt: null,
    notificationError: null,
    ...rest
  };
}

test("service-worker status is normalized without reflecting unknown values", () => {
  const status = normalizeStatusResponse({
    ok: true,
    status: {
      syncing: true,
      authRequired: false,
      activeProfileId: USER_ID,
      lastSuccessfulSyncAt: "2026-08-10T00:00:00.000Z",
      nextSyncAt: "2026-08-11T00:00:00.000Z",
      worldCount: 42,
      eventCount: -1,
      lastResult: "success",
      unexpected: "do not display"
    }
  });

  assert.deepEqual(status, {
    syncing: true,
    authRequired: false,
    activeProfileId: USER_ID,
    lastSuccessfulSyncAt: "2026-08-10T00:00:00.000Z",
    nextSyncAt: "2026-08-11T00:00:00.000Z",
    worldCount: 42,
    eventCount: 0,
    lastResult: "success"
  });
  assert.equal(presentStatus(status).tone, "working");
});

test("auth and failure status use actionable Japanese messages", () => {
  const auth = normalizeStatusResponse({ lastResult: "auth_required" });
  assert.equal(auth.authRequired, true);
  assert.match(presentStatus(auth).detail, /公式サイト/u);
  assert.match(commandErrorMessage("offline"), /接続/u);
  assert.match(commandErrorMessage("cooldown", "2026-08-10T00:00:00.000Z"), /以降/u);
  assert.match(commandErrorMessage("manual_cooldown"), /時間をあけ/u);
  assert.match(commandErrorMessage("vrchat_unavailable"), /VRChat側/u);
  assert.match(commandErrorMessage("storage_unavailable"), /ブラウザ/u);
  assert.match(commandErrorMessage("sync_failed"), /保存済み/u);
  assert.equal(formatDateTime("not-a-date"), "—");
});

test("command envelopes fail closed", () => {
  assert.deepEqual(normalizeCommandResponse({ ok: true, extra: "ignored" }), { ok: true });
  assert.deepEqual(normalizeCommandResponse({ ok: false, error: "offline", retryAt: 123 }), {
    ok: false,
    error: "offline",
    retryAt: null
  });
  assert.deepEqual(normalizeCommandResponse({ ok: false, code: "AUTH_REQUIRED" }), {
    ok: false,
    error: "auth_required",
    retryAt: null
  });
  assert.deepEqual(normalizeCommandResponse("unexpected"), {
    ok: false,
    error: "unavailable",
    retryAt: null
  });
});

test("every uppercase public sync error maps to actionable copy", () => {
  const expectedWords = new Map([
    ["AUTH_REQUIRED", "公式サイト"],
    ["RATE_LIMITED", "時間をあけ"],
    ["OFFLINE", "接続"],
    ["VRCHAT_UNAVAILABLE", "VRChat側"],
    ["API_INCOMPATIBLE", "新しい版"],
    ["MANUAL_COOLDOWN", "時間をあけ"],
    ["SYNC_FAILED", "保存済み"],
    ["STORAGE_UNAVAILABLE", "ブラウザ"],
    ["SECURITY_RULE_UNAVAILABLE", "安全な通信設定"],
    ["SYNC_CONFLICT", "古い結果"]
  ]);
  for (const [publicCode, expectedWord] of expectedWords) {
    const normalized = normalizeCommandResponse({ ok: false, error: publicCode });
    assert.equal(normalized.ok, false);
    if (!normalized.ok) {
      assert.match(commandErrorMessage(normalized.error), new RegExp(expectedWord, "u"));
    }
  }
});

test("world search includes current name, author, ID, and historical names", () => {
  const worlds = [
    world({ worldId: WORLD_A, currentName: "新しい名前" }),
    world({ worldId: WORLD_B, currentName: "別の場所", authorName: "Example Maker" })
  ];
  const events = [
    historyEvent({
      eventId: "event-a",
      worldId: WORLD_A,
      kind: "name_changed",
      before: "思い出の海辺",
      after: "新しい名前"
    })
  ];

  assert.deepEqual(filterWorlds(worlds, events, "思い出", "all").map((item) => item.worldId), [WORLD_A]);
  assert.deepEqual(filterWorlds(worlds, events, "example maker", "all").map((item) => item.worldId), [WORLD_B]);
  assert.deepEqual(filterWorlds(worlds, events, WORLD_A.slice(-8), "all").map((item) => item.worldId), [WORLD_A]);
});

test("world filters distinguish confirmed and pending states", () => {
  const missing = world({
    worldId: WORLD_A,
    membershipState: "not_in_favorites",
    membershipMissCount: 2,
    availabilityState: "unavailable",
    unavailableCount: 2
  });
  const pending = world({
    worldId: WORLD_B,
    membershipState: "missing_once",
    membershipMissCount: 1,
    availabilityState: "unavailable_once",
    unavailableCount: 1,
    probeState: "pending"
  });

  assert.equal(worldMatchesFilter(missing, "missing"), true);
  assert.equal(worldMatchesFilter(missing, "unavailable"), true);
  assert.equal(worldMatchesFilter(pending, "pending"), true);
  assert.deepEqual(worldStateTags(missing).map((tag) => tag.label), [
    "お気に入り一覧にない",
    "現在アクセス不可"
  ]);
  assert.ok(worldStateTags(pending).every((tag) => tag.tone === "pending"));
});

test("event filtering groups recovery events and always sorts newest first", () => {
  const events = [
    historyEvent({
      eventId: "older",
      worldId: WORLD_A,
      kind: "favorite_restored",
      observedAt: "2026-08-10T00:00:00.000Z"
    }),
    historyEvent({
      eventId: "newer",
      worldId: WORLD_A,
      kind: "access_restored",
      observedAt: "2026-08-12T00:00:00.000Z"
    }),
    historyEvent({
      eventId: "missing",
      worldId: WORLD_B,
      kind: "favorite_missing_confirmed",
      observedAt: "2026-08-11T00:00:00.000Z"
    })
  ];

  assert.deepEqual(filterEvents(events, "restored").map((event) => event.eventId), ["newer", "older"]);
  assert.deepEqual(filterEvents(events, "missing").map((event) => event.eventId), ["missing"]);
});

test("event and summary copy does not claim deletion or privacy", () => {
  const unavailableEvent = historyEvent({
    eventId: "unavailable",
    worldId: WORLD_A,
    kind: "access_unavailable_confirmed",
    before: "accessible",
    after: "unavailable",
    evidence: { source: "probe", httpStatus: 404 }
  });
  const unavailableWorld = world({
    worldId: WORLD_A,
    availabilityState: "unavailable",
    unavailableCount: 2,
    membershipState: "not_in_favorites",
    membershipMissCount: 2
  });

  assert.equal(presentEventKind(unavailableEvent.kind).title, "現在アクセスできないことを確認しました");
  assert.match(eventDetail(unavailableEvent, unavailableWorld), /断定しません/u);
  assert.deepEqual(summarizeHistory([unavailableWorld], [unavailableEvent]), {
    total: 1,
    unavailable: 1,
    missing: 1,
    renamed: 0
  });
});

test("extension UI sources avoid unsafe HTML and credential APIs", async () => {
  const sources = await Promise.all([
    readFile(new URL("../extension/popup.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/dashboard.js", import.meta.url), "utf8")
  ]);
  const combined = sources.join("\n");
  assert.doesNotMatch(combined, /innerHTML|outerHTML|insertAdjacentHTML/u);
  assert.doesNotMatch(combined, /chrome\.cookies|authorization|password|token/iu);
  assert.doesNotMatch(combined, /console\./u);
  assert.doesNotMatch(combined, /https?:\/\//u);

  const dashboard = sources[1] ?? "";
  assert.ok(dashboard.indexOf("file.size > MAX_BACKUP_BYTES") < dashboard.indexOf("await file.text()"));
  assert.ok(dashboard.indexOf("parseBackup(text)") < dashboard.indexOf("globalThis.confirm"));
  const restoreStatusCheck = dashboard.lastIndexOf('type: "GET_STATUS"');
  assert.ok(dashboard.indexOf("parseBackup(text)") < restoreStatusCheck);
  assert.ok(restoreStatusCheck < dashboard.indexOf("globalThis.confirm"));
  assert.ok(dashboard.indexOf("globalThis.confirm") < dashboard.indexOf("await restoreBackup"));
  assert.match(dashboard, /preview\.exportedAt/u);
  assert.match(dashboard, /URL\.revokeObjectURL/u);
  assert.match(dashboard, /const PAGE_SIZE = 200/u);
  assert.match(
    dashboard,
    /importInput\.disabled = repository === null \|\| state\.status\.syncing \|\| restoring/u
  );
  assert.match(dashboard, /syncNowButton\.disabled = state\.status\.syncing \|\| restoring/u);
  assert.match(dashboard, /if \(freshStatus\.syncing\)/u);
  assert.match(dashboard, /if \(restoring\)/u);
});
