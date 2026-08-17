// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  HISTORY_DASHBOARD_PATH,
  createHistoryDashboardOpener,
  createHistoryNotificationHandlers
} from "../extension/background.js";
import {
  commandErrorMessage,
  eventDetail,
  favoriteGroupLabels,
  filterEvents,
  filterWorlds,
  formatDateTime,
  normalizeCommandResponse,
  normalizePurgeResponse,
  normalizeStatusResponse,
  parseFavoriteGroupTags,
  presentEventKind,
  presentStatus,
  purgeErrorMessage,
  summarizeHistory,
  takeVisibleItems,
  worldMatchesFilter,
  worldStateTags
} from "../extension/lib/ui.js";

/** @typedef {import("../extension/lib/database.js").DatabaseRepository} DatabaseRepository */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listWorlds"]>>[number]} WorldRecord */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listEvents"]>>[number]} HistoryEvent */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listFavoriteGroups"]>>[number]} FavoriteGroupRecord */

const USER_ID = "usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORLD_A = "wrld_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORLD_B = "wrld_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("notification and history actions open the fixed events route", async () => {
  /** @type {string[]} */
  const resolvedPaths = [];
  /** @type {{url: string}[]} */
  const openedTabs = [];
  const openHistoryDashboard = createHistoryDashboardOpener({
    resolveExtensionUrl: (path) => {
      resolvedPaths.push(path);
      return `chrome-extension://fixed-id/${path}`;
    },
    createTab: async (details) => {
      openedTabs.push(details);
    }
  });
  const handlers = createHistoryNotificationHandlers({ openHistoryDashboard });

  await handlers.onClicked("vrc-favworld-check-change-sync-1");
  await handlers.onButtonClicked("vrc-favworld-check-change-sync-2", 0);
  await handlers.onClicked("another-extension-notification");
  await handlers.onButtonClicked("vrc-favworld-check-change-sync-3", 1);

  assert.equal(HISTORY_DASHBOARD_PATH, "dashboard.html#events");
  assert.deepEqual(resolvedPaths, [HISTORY_DASHBOARD_PATH, HISTORY_DASHBOARD_PATH]);
  assert.deepEqual(openedTabs, [
    { url: "chrome-extension://fixed-id/dashboard.html#events" },
    { url: "chrome-extension://fixed-id/dashboard.html#events" }
  ]);
});

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
    notificationEligible: kind !== "favorite_group_changed",
    notificationClaimedAt: null,
    notifiedAt: null,
    notificationError: null,
    ...rest
  };
}

/**
 * @param {Partial<FavoriteGroupRecord>} [overrides]
 * @returns {FavoriteGroupRecord}
 */
function favoriteGroup(overrides = {}) {
  return {
    userId: USER_ID,
    groupId: "fvgrp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    internalName: "worlds1",
    displayName: "大切な場所",
    normalizedDisplayName: "大切な場所",
    type: "world",
    active: true,
    missingCount: 0,
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: "2026-08-12T00:00:00.000Z",
    displayNameHistory: [
      { displayName: "思い出リスト", observedAt: "2026-08-01T00:00:00.000Z" }
    ],
    updatedAt: "2026-08-12T00:00:00.000Z",
    ...overrides
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
      pendingProbeCount: 3,
      unreadCount: 2,
      favoriteGroupStatus: "success",
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
    pendingProbeCount: 3,
    unreadCount: 2,
    favoriteGroupStatus: "success",
    lastResult: "success"
  });
  assert.equal(presentStatus(status).tone, "working");
});

test("new status counters fail closed and stale sync is actionable after 36 hours", () => {
  const malformed = normalizeStatusResponse({
    pendingProbeCount: -1,
    unreadCount: Number.NaN,
    favoriteGroupStatus: "unknown"
  });
  assert.equal(malformed.pendingProbeCount, 0);
  assert.equal(malformed.unreadCount, 0);
  assert.equal(malformed.favoriteGroupStatus, null);

  const status = normalizeStatusResponse({
    lastSuccessfulSyncAt: "2026-08-10T00:00:00.000Z",
    lastResult: "success"
  });
  assert.equal(
    presentStatus(status, Date.parse("2026-08-11T12:00:00.000Z")).tone,
    "ready"
  );
  const stalled = presentStatus(status, Date.parse("2026-08-11T12:00:00.001Z"));
  assert.equal(stalled.tone, "error");
  assert.match(stalled.title, /36時間/u);
  assert.match(stalled.detail, /今すぐ確認/u);
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

test("purge responses never claim deletion without explicit evidence", () => {
  assert.deepEqual(normalizePurgeResponse({ ok: true }), {
    ok: false,
    error: "unavailable",
    dataDeleted: false
  });
  assert.deepEqual(normalizePurgeResponse({
    ok: false,
    error: "UNINSTALL_FAILED",
    dataDeleted: true
  }), {
    ok: false,
    error: "uninstall_failed",
    dataDeleted: true
  });
  assert.match(purgeErrorMessage("sync_in_progress", false), /確認中/u);
  assert.match(purgeErrorMessage("delete_blocked", false), /ほかの/u);
  assert.match(purgeErrorMessage("uninstall_failed", true), /削除済み/u);
  assert.match(purgeErrorMessage("uninstall_failed", true), /手動/u);
  assert.match(purgeErrorMessage("delete_failed", false), /状態を確認できません/u);
  assert.doesNotMatch(purgeErrorMessage("delete_failed", false), /記録は残っています/u);
  assert.doesNotMatch(purgeErrorMessage("uninstall_failed", false), /記録は残っています/u);
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

test("favorite list display names support cards, search, filtering, and history", () => {
  const groups = [favoriteGroup()];
  const groupedWorld = world({ worldId: WORLD_A, favoriteTags: ["worlds1"] });
  const ungroupedWorld = world({ worldId: WORLD_B, favoriteTags: ["worlds2"] });
  const groupChange = historyEvent({
    eventId: "event-group",
    worldId: WORLD_A,
    kind: "favorite_group_changed",
    before: JSON.stringify(["worlds2"]),
    after: JSON.stringify(["worlds1"])
  });

  assert.deepEqual(favoriteGroupLabels(groupedWorld.favoriteTags, groups), ["大切な場所"]);
  assert.deepEqual(favoriteGroupLabels(ungroupedWorld.favoriteTags, groups), ["リスト2（worlds2）"]);
  assert.deepEqual(parseFavoriteGroupTags('["worlds1","worlds1"]'), ["worlds1"]);
  assert.deepEqual(parseFavoriteGroupTags('{"worlds1":true}'), []);
  assert.deepEqual(
    filterWorlds([groupedWorld, ungroupedWorld], [groupChange], "大切", "all", null, groups)
      .map((item) => item.worldId),
    [WORLD_A]
  );
  assert.deepEqual(
    filterWorlds([groupedWorld, ungroupedWorld], [groupChange], "思い出リスト", "all", null, groups)
      .map((item) => item.worldId),
    [WORLD_A]
  );
  assert.deepEqual(
    filterWorlds([groupedWorld, ungroupedWorld], [], "", "all", "worlds1", groups)
      .map((item) => item.worldId),
    [WORLD_A]
  );
  assert.deepEqual(filterEvents([groupChange], "group"), [groupChange]);
  assert.equal(presentEventKind(groupChange.kind).tag, "リスト変更");
  assert.match(eventDetail(groupChange, groupedWorld, groups), /大切な場所/u);
});

test("800 worlds remain filterable and are exposed in 200-item stages", () => {
  const worlds = Array.from({ length: 800 }, (_, index) => world({
    worldId: `wrld_${String(index).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    currentName: `Batch World ${String(index).padStart(3, "0")}`,
    normalizedName: `batch world ${String(index).padStart(3, "0")}`,
    favoriteTags: [`worlds${Math.floor(index / 100) + 1}`]
  }));
  const matching = filterWorlds(worlds, [], "batch world", "all");
  assert.equal(matching.length, 800);
  assert.equal(takeVisibleItems(matching, 200).length, 200);
  assert.equal(takeVisibleItems(matching, 400).length, 400);
  assert.equal(takeVisibleItems(matching, 600).length, 600);
  assert.equal(takeVisibleItems(matching, 800).length, 800);
  assert.equal(filterWorlds(worlds, [], "", "all", "worlds8").length, 100);
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

test("backup restore keeps restored data explicit across settings follow-up outcomes", async () => {
  const dashboard = await readFile(
    new URL("../extension/dashboard.js", import.meta.url),
    "utf8"
  );

  assert.match(
    dashboard,
    /rawResponse\.ok !== true\s+\|\| rawResponse\.settingsSaved !== true/u
  );
  assert.match(dashboard, /rawResponse\.scheduleWarning === null/u);
  assert.match(
    dashboard,
    /rawResponse\.scheduleWarning === SETTINGS_SCHEDULE_WARNING/u
  );
  assert.equal(
    dashboard.match(/classifySettingsUpdateResponse\(/gu)?.length,
    3,
    "normal settings and restore must share the closed response classifier"
  );
  assert.match(
    dashboard,
    /const rawSettingsResponse = await sendMessage\([\s\S]*settingsOutcome = classifySettingsUpdateResponse\(rawSettingsResponse\)/u
  );
  assert.match(
    dashboard,
    /settingsOutcome === SETTINGS_UPDATE_OUTCOMES\.scheduleRepairFailed[\s\S]*自動確認の予定を更新できませんでした。ブラウザを再起動すると自動で修復を試みます。/u
  );
  assert.match(
    dashboard,
    /settingsOutcome === SETTINGS_UPDATE_OUTCOMES\.success\s+&& restoredDataLoaded/u
  );
  assert.match(dashboard, /記録は復元済みです。ワールド/u);
  assert.match(
    dashboard,
    /画面または自動確認の設定結果を確認できませんでした。ブラウザを再起動して、この画面で設定を確認してください。/u
  );
  assert.doesNotMatch(dashboard, /followupCompleted/u);
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
  assert.match(dashboard, /type: "MARK_HISTORY_READ"/u);
  assert.match(
    dashboard,
    /const initialTab = initialTabFromHash\(window\.location\.hash\);\s+activateTab\(initialTab\);/u
  );
  assert.match(
    dashboard,
    /repository = await openDatabase\(\);\s+await loadData\(\);\s+if \(initialTab === "events"\) \{\s+await markHistoryAsRead\(\);/u
  );
  assert.match(dashboard, /type: "PURGE_AND_UNINSTALL"/u);
  assert.match(dashboard, /setSetting\("lastBackupAt", backedUpAt\)/u);
  assert.match(dashboard, /repository\.close\(\);\s+repository = null;\s+\n\s+let response/u);
  assert.match(dashboard, /navigator\.storage\.estimate\(\)/u);
  assert.match(dashboard, /const WORLD_WARNING_COUNT = 8_000/u);
  assert.match(dashboard, /const EVENT_WARNING_COUNT = 80_000/u);
  assert.match(dashboard, /const STORAGE_WARNING_BYTES = 20 \* 1024 \* 1024/u);
  assert.match(dashboard, /favoriteGroupStatus === "stale"/u);
  assert.match(dashboard, /rawResponse\.settingsSaved !== true/u);
  assert.match(dashboard, /rawResponse\.scheduleWarning === SETTINGS_SCHEDULE_WARNING/u);
  assert.match(dashboard, /"設定は保存しました"/u);
  assert.match(
    dashboard,
    /database\.getSetting\("autoSyncEnabled"\)[\s\S]*database\.getSetting\("notificationsEnabled"\)/u
  );
  assert.doesNotMatch(dashboard, /設定は変更していません/u);
  assert.match(
    dashboard,
    /importInput\.disabled = repository === null \|\| state\.status\.syncing \|\| restoring/u
  );
  assert.match(dashboard, /syncNowButton\.disabled = state\.status\.syncing \|\| restoring/u);
  assert.match(dashboard, /if \(freshStatus\.syncing\)/u);
  assert.match(dashboard, /if \(restoring\)/u);
});
