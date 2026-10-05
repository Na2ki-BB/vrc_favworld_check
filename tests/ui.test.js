// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ALL_WORLDS_DASHBOARD_PATH,
  createAllWorldsDashboardOpener,
  ATTENTION_DASHBOARD_PATH,
  HISTORY_DASHBOARD_PATH,
  createAttentionDashboardOpener,
  createHistoryDashboardOpener,
  createHistoryNotificationHandlers
} from "../extension/background.js";
import {
  ATTENTION_NOTIFICATION_ID_PREFIX,
  NOTIFICATION_ID_PREFIX,
  createNotificationPresentation
} from "../extension/lib/sync-service.js";
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
  normalizeThumbnailProgress,
  presentThumbnailProgress,
  readThumbnailCount,
  parseFavoriteGroupTags,
  presentEventKind,
  presentStatus,
  presentWorldOverview,
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

test("explicit all-record opener and notifications retain their fixed routes", async () => {
  /** @type {string[]} */
  const resolvedPaths = [];
  /** @type {{url: string}[]} */
  const openedTabs = [];
  /** @type {{
   *   resolveExtensionUrl: (path: string) => string,
   *   createTab: (details: {url: string}) => Promise<void>
   * }} */
  const openerDependencies = {
    resolveExtensionUrl: (path) => {
      resolvedPaths.push(path);
      return `chrome-extension://fixed-id/${path}`;
    },
    createTab: async (details) => {
      openedTabs.push(details);
    }
  };
  const openAttentionDashboard = createAttentionDashboardOpener(openerDependencies);
  const openHistoryDashboard = createHistoryDashboardOpener(openerDependencies);
  const handlers = createHistoryNotificationHandlers({
    openHistoryDashboard,
    openAttentionDashboard
  });

  await createAllWorldsDashboardOpener(openerDependencies)();
  await openAttentionDashboard();
  await handlers.onClicked(`${NOTIFICATION_ID_PREFIX}sync-1`);
  await handlers.onButtonClicked(`${NOTIFICATION_ID_PREFIX}sync-2`, 0);
  await handlers.onClicked(`${ATTENTION_NOTIFICATION_ID_PREFIX}sync-3`);
  await handlers.onButtonClicked(`${ATTENTION_NOTIFICATION_ID_PREFIX}sync-4`, 0);
  await handlers.onClicked("another-extension-notification");
  await handlers.onButtonClicked(`${ATTENTION_NOTIFICATION_ID_PREFIX}sync-5`, 1);

  assert.equal(HISTORY_DASHBOARD_PATH, "dashboard.html#events");
  assert.equal(ATTENTION_DASHBOARD_PATH, "dashboard.html#attention");
  assert.equal(ALL_WORLDS_DASHBOARD_PATH, "dashboard.html#all");
  assert.deepEqual(resolvedPaths, [
    ALL_WORLDS_DASHBOARD_PATH,
    ATTENTION_DASHBOARD_PATH,
    HISTORY_DASHBOARD_PATH,
    HISTORY_DASHBOARD_PATH,
    ATTENTION_DASHBOARD_PATH,
    ATTENTION_DASHBOARD_PATH
  ]);
  assert.deepEqual(openedTabs, [
    { url: "chrome-extension://fixed-id/dashboard.html#all" },
    { url: "chrome-extension://fixed-id/dashboard.html#attention" },
    { url: "chrome-extension://fixed-id/dashboard.html#events" },
    { url: "chrome-extension://fixed-id/dashboard.html#events" },
    { url: "chrome-extension://fixed-id/dashboard.html#attention" },
    { url: "chrome-extension://fixed-id/dashboard.html#attention" }
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

test("notification copy prioritizes unique attention worlds without exposing names", () => {
  const attention = createNotificationPresentation([
    historyEvent({
      eventId: "missing-a",
      worldId: WORLD_A,
      kind: "favorite_missing_confirmed"
    }),
    historyEvent({
      eventId: "unavailable-a",
      worldId: WORLD_A,
      kind: "access_unavailable_confirmed",
      evidence: { source: "probe", httpStatus: 404 }
    }),
    historyEvent({
      eventId: "missing-b",
      worldId: WORLD_B,
      kind: "favorite_missing_confirmed"
    }),
    historyEvent({
      eventId: "renamed-b",
      worldId: WORLD_B,
      kind: "name_changed",
      before: "秘密にしたい以前の名前",
      after: "秘密にしたい現在名"
    })
  ]);
  assert.deepEqual(attention, {
    attention: true,
    title: "現在アクセスできないワールドがあります",
    message: "要確認: 2件（現在アクセス不可1件・お気に入り一覧にない2件）。その他の変化: 1件。",
    buttonTitle: "保存済みの情報を見る"
  });
  assert.doesNotMatch(JSON.stringify(attention), /秘密にしたい|wrld_/u);

  assert.deepEqual(createNotificationPresentation([
    historyEvent({ eventId: "renamed-a", worldId: WORLD_A, kind: "name_changed" })
  ]), {
    attention: false,
    title: "お気に入りワールドに変化があります",
    message: "1件の変化を記録しました。履歴を確認してください。",
    buttonTitle: "履歴を見る"
  });

  assert.deepEqual(createNotificationPresentation([
    historyEvent({
      eventId: "missing-only",
      worldId: WORLD_A,
      kind: "favorite_missing_confirmed"
    })
  ]), {
    attention: true,
    title: "お気に入り一覧にないワールドがあります",
    message: "要確認: 1件（お気に入り一覧にない1件）。手動でお気に入り解除した場合も含まれます。",
    buttonTitle: "保存済みの情報を見る"
  });
});

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
      attentionWorldCount: 4,
      missingCount: 2,
      unavailableCount: 3,
      favoriteGroupStatus: "success",
      lastResult: "success",
      unexpected: "do not display"
    }
  });

  assert.deepEqual(status, {
    thumbnailProgress: null,
    thumbnailSavedCount: null,
    syncing: true,
    authRequired: false,
    activeProfileId: USER_ID,
    lastSuccessfulSyncAt: "2026-08-10T00:00:00.000Z",
    nextSyncAt: "2026-08-11T00:00:00.000Z",
    worldCount: 42,
    eventCount: 0,
    pendingProbeCount: 3,
    generation: 0, presentationGeneration: 0, hiddenCount: 0,
    unreadSummary: {exact: true, uncertain: false, count: 2},
    unreadCount: 2,
    attentionWorldCount: 4,
    missingCount: 2,
    unavailableCount: 3,
    favoriteGroupStatus: "success",
    lastResult: "success"
  });
  assert.equal(presentStatus(status).tone, "working");
});

test("new status counters fail closed and stale sync is actionable after 36 hours", () => {
  const malformed = normalizeStatusResponse({
    pendingProbeCount: -1,
    unreadCount: Number.NaN,
    attentionWorldCount: -1,
    missingCount: "1",
    unavailableCount: Number.NaN,
    favoriteGroupStatus: "unknown"
  });
  assert.equal(malformed.pendingProbeCount, 0);
  assert.equal(malformed.unreadCount, 0);
  assert.equal(malformed.attentionWorldCount, 0);
  assert.equal(malformed.missingCount, 0);
  assert.equal(malformed.unavailableCount, 0);
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

  const attention = normalizeStatusResponse({
    lastSuccessfulSyncAt: "2026-08-11T00:00:00.000Z",
    lastResult: "success",
    attentionWorldCount: 2,
    missingCount: 2,
    unavailableCount: 1
  });
  const attentionPresentation = presentStatus(
    attention,
    Date.parse("2026-08-11T01:00:00.000Z")
  );
  assert.equal(attentionPresentation.tone, "attention");
  assert.match(attentionPresentation.title, /アクセスできないワールドが1件/u);
  assert.match(attentionPresentation.detail, /一覧から外れたワールドは2件/u);
  assert.match(attentionPresentation.detail, /保存済みの名前と画像/u);
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
  assert.match(commandErrorMessage("auth_cookie_unavailable"), /Chrome/u);
  assert.match(commandErrorMessage("auth_cookie_conflict"), /安全/u);
  assert.match(commandErrorMessage("auth_cookie_cleanup_failed"), /終了/u);
  assert.match(commandErrorMessage("auth_cookie_cleanup_failed"), /15分/u);
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
    ["AUTH_COOKIE_UNAVAILABLE", "Chrome"],
    ["AUTH_COOKIE_CONFLICT", "安全"],
    ["AUTH_COOKIE_CLEANUP_FAILED", "終了"],
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
  assert.equal(worldMatchesFilter(missing, "attention"), true);
  assert.equal(worldMatchesFilter(pending, "pending"), true);
  assert.equal(worldMatchesFilter(pending, "attention"), false);
  assert.deepEqual(worldStateTags(missing).map((tag) => tag.label), [
    "お気に入り一覧にない",
    "現在アクセス不可"
  ]);
  assert.ok(worldStateTags(pending).every((tag) => tag.tone === "pending"));
});

test("attention view shows each confirmed world once and orders latest confirmations first", () => {
  const olderBothStates = world({
    worldId: WORLD_A,
    membershipState: "not_in_favorites",
    membershipMissCount: 2,
    availabilityState: "unavailable",
    unavailableCount: 2
  });
  const newerUnavailable = world({
    worldId: WORLD_B,
    availabilityState: "unavailable",
    unavailableCount: 2
  });
  const events = [
    historyEvent({
      eventId: "older-missing",
      worldId: WORLD_A,
      kind: "favorite_missing_confirmed",
      observedAt: "2026-08-10T00:00:00.000Z"
    }),
    historyEvent({
      eventId: "older-unavailable",
      worldId: WORLD_A,
      kind: "access_unavailable_confirmed",
      observedAt: "2026-08-10T00:00:00.000Z",
      evidence: { source: "probe", httpStatus: 404 }
    }),
    historyEvent({
      eventId: "newer-unavailable",
      worldId: WORLD_B,
      kind: "access_unavailable_confirmed",
      observedAt: "2026-08-11T00:00:00.000Z",
      evidence: { source: "probe", httpStatus: 404 }
    })
  ];

  assert.deepEqual(
    filterWorlds([olderBothStates, newerUnavailable], events, "", "attention")
      .map((item) => item.worldId),
    [WORLD_B, WORLD_A]
  );
  assert.deepEqual(
    filterEvents(events, "attention").map((event) => event.eventId),
    ["newer-unavailable", "older-missing", "older-unavailable"]
  );
  assert.deepEqual(summarizeHistory([olderBothStates, newerUnavailable], events), {
    attention: 2,
    total: 2,
    unavailable: 2,
    missing: 1,
    renamed: 0
  });
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
    attention: 1,
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

test("dashboard prioritizes confirmed attention and puts secondary controls behind disclosure", async () => {
  const [html, css, popupHtml, popupScript, popupCss] = await Promise.all([
    readFile(new URL("../extension/dashboard.html", import.meta.url), "utf8"),
    readFile(new URL("../extension/styles/dashboard.css", import.meta.url), "utf8"),
    readFile(new URL("../extension/popup.html", import.meta.url), "utf8"),
    readFile(new URL("../extension/popup.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/styles/popup.css", import.meta.url), "utf8")
  ]);

  assert.match(html, /<option value="attention" selected>消えた可能性のあるワールド<\/option>/u);
  assert.doesNotMatch(html, /summary-card|primary-focus-button/u);
  assert.match(html, /<details id="world-filter-panel"/u);
  assert.match(html, /href="#settings"/u);
  assert.match(html, /id="primary-focus"/u);
  assert.match(html, /保存済みの記録を読み込んでいます/u);
  assert.match(css, /select\s*\{\s*color-scheme:\s*light;/u);
  assert.match(
    css,
    /select option\s*\{[^}]*color:\s*#252923;[^}]*background-color:\s*#fff;/iu
  );
  assert.match(
    css,
    /\.select-field select\s*\{[^}]*color:\s*#252923;[^}]*background:\s*#fff;/iu
  );
  assert.ok(html.indexOf('id="primary-focus"') < html.indexOf('id="world-list"'));
  assert.ok(popupHtml.indexOf('id="attention-card"') < popupHtml.indexOf('class="status-card"'));
  assert.ok(popupHtml.indexOf('id="dashboard-button"') < popupHtml.indexOf('id="sync-button"'));
  assert.match(popupScript, /attentionCard\.classList\.toggle\("is-alert", hasAttention\)/u);
  assert.match(popupScript, /presentation\.tone === "attention"/u);
  assert.match(popupCss, /\.attention-card\.is-alert/u);
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
  const restoreStatusCheck = dashboard.indexOf('type: "GET_STATUS"', dashboard.indexOf("parseBackup(text)"));
  assert.ok(dashboard.indexOf("parseBackup(text)") < restoreStatusCheck);
  assert.ok(restoreStatusCheck < dashboard.indexOf("globalThis.confirm"));
  assert.ok(dashboard.indexOf("globalThis.confirm") < dashboard.indexOf("await restoreBackup"));
  assert.match(dashboard, /preview\.exportedAt/u);
  assert.match(dashboard, /URL\.revokeObjectURL/u);
  assert.match(dashboard, /URL\.createObjectURL\(record\.blob\)/u);
  assert.doesNotMatch(dashboard, /image\.src\s*=\s*record\.sourceUrl/u);
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
  assert.match(dashboard, /const STORAGE_WARNING_BYTES = 250 \* 1024 \* 1024/u);
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

test("thumbnail loading distinguishes missing, read errors, image errors and stale profiles", async () => {
  const source = await readFile(new URL("../extension/dashboard.js", import.meta.url), "utf8");
  const start = source.indexOf("async function hydrateWorldThumbnails(");
  const end = source.indexOf("\n/**", start);
  const functionSource = source.slice(start, end);
  class Element {
    dataset = { worldId: WORLD_A };
    /** @type {Element[]} */
    children = [];
    /** @type {Map<string, () => void>} */
    listeners = new Map();
    /** @param {string} selector */
    querySelector(selector) { return selector === "img" ? null : this; }
    /** @param {...Element} children */
    replaceChildren(...children) { this.children = children; }
    /** @param {string} type @param {() => void} callback */
    addEventListener(type, callback) { this.listeners.set(type, callback); }
  }
  const container = new Element();
  /** @type {Element[]} */
  const images = [];
  /** @type {[Element, string, string?, (() => void)?][]} */
  const messages = [];
  /** @type {string[]} */
  const revoked = [];
  const profileState = { profile: { userId: "user-a" }, status: { thumbnailProgress: null } };
  /** @type {() => Promise<{worldId: string, blob: Blob}[]>} */
  let fetchRecords = async () => [];
  const repository = { getThumbnails: () => fetchRecords() };
  const hydrate = new Function(
    "repository", "state", "thumbnailRenderGeneration", "requireRepository", "worldList",
    "HTMLElement", "showThumbnailMessage", "renderWorlds", "syncNowButton", "URL",
    "activeThumbnailObjectUrls", "document",
    `const pageClosed = false; ${functionSource}; return hydrateWorldThumbnails;`
  )(
    repository, profileState, 1, () => repository, { querySelectorAll: () => [container] },
    Element, /** @param {[Element, string, string?, (() => void)?]} args */ (...args) => messages.push(args), () => {}, { click() {} },
    { createObjectURL: () => "blob:test", revokeObjectURL: /** @param {string} url */ (url) => revoked.push(url) },
    new Set(), { createElement: () => { const image = new Element(); images.push(image); return image; } }
  );
  const world = { worldId: WORLD_A, currentName: "Test", availabilityState: "available" };
  await hydrate([world], 1);
  assert.equal(messages[messages.length - 1]?.[1], "画像はまだ保存されていません");
  assert.equal(messages[messages.length - 1]?.[2], undefined);
  await hydrate([{ ...world, availabilityState: "unavailable" }], 1);
  assert.match(messages[messages.length - 1]?.[1] ?? "", /現在アクセスできないため取得できません/u);
  fetchRecords = async () => { throw new Error("read failed"); };
  await hydrate([world], 1);
  assert.equal(messages[messages.length - 1]?.[1], "保存画像を読み出せませんでした");
  assert.equal(messages[messages.length - 1]?.[2], "再読み込み");
  fetchRecords = async () => [{ worldId: WORLD_A, blob: new Blob(["image"]) }];
  await hydrate([world], 1);
  assert.equal(container.children[0], images[0]);
  images[0]?.listeners.get("error")?.();
  assert.equal(messages[messages.length - 1]?.[1], "保存画像を表示できませんでした");
  assert.deepEqual(revoked, ["blob:test"]);
  const before = messages.length;
  profileState.profile.userId = "user-b";
  images[0]?.listeners.get("error")?.();
  assert.equal(messages.length, before, "old profile's image error cannot replace the current UI");
  fetchRecords = async () => { profileState.profile.userId = "user-c"; return []; };
  await hydrate([world], 1);
  assert.equal(messages.length, before, "pending reads cannot replace the new profile's UI");
});

test("dashboard defaults to attention while preserving explicit all and history links", async () => {
  const source = await readFile(new URL("../extension/dashboard.js", import.meta.url), "utf8");
  const start = source.indexOf("function applyInitialRouteFilters(");
  const end = source.indexOf("\n}\n", start) + 2;
  const worldFilter = { value: "" };
  const eventFilter = { value: "" };
  const applyRoute = new Function("worldFilter", "eventFilter", `${source.slice(start, end)}; return applyInitialRouteFilters;`)(worldFilter, eventFilter);
  for (const hash of ["", "#worlds", "#unexpected"]) {
    applyRoute(hash);
    assert.equal(worldFilter.value, "attention");
  }
  applyRoute("#all");
  assert.equal(worldFilter.value, "all");
  applyRoute("#hidden");
  assert.equal(worldFilter.value, "hidden");
  applyRoute("#attention");
  assert.equal(worldFilter.value, "attention");
  applyRoute("#attention-events");
  assert.equal(eventFilter.value, "attention");
});

test("thumbnail progress rejects malformed counts and presents automatic continuation separately", () => {
  const running = { total: 300, saved: 30, remaining: 268, failed: 2, state: "running", nextAttemptAt: null };
  const progress = normalizeThumbnailProgress(running);
  assert.notEqual(progress, null);
  assert.match(presentThumbnailProgress(progress), /保存済み30\/300件（残り268件）/u);
  assert.match(presentThumbnailProgress(progress), /繰り返す必要はありません/u);
  for (const patch of [
    { saved: -1 }, { saved: "30" }, { remaining: Number.NaN }, { total: 301 },
    { failed: 1.5 }, { state: "unknown" }, { state: "complete" },
    { nextAttemptAt: "invalid" }, { nextAttemptAt: 1 }
  ]) assert.equal(normalizeThumbnailProgress({ ...running, ...patch }), null);
  assert.equal(normalizeThumbnailProgress(null), null);
  const waiting = normalizeThumbnailProgress({ ...running, state: "waiting", nextAttemptAt: "2026-09-09T00:00:00.000Z" });
  assert.match(presentThumbnailProgress(waiting), /以降に自動再開/u);
  const partial = normalizeThumbnailProgress({ ...running, saved: 298, remaining: 0, state: "partial" });
  assert.match(presentThumbnailProgress(partial), /一部の画像を取得できませんでした/u);
  assert.doesNotMatch(presentThumbnailProgress(partial), /保存が完了/u);
  const complete = normalizeThumbnailProgress({ ...running, saved: 300, remaining: 0, failed: 0, state: "complete" });
  assert.match(presentThumbnailProgress(complete), /画像の保存が完了/u);
});

test("dashboard progress polling stays local, does not overlap and discards obsolete responses", async () => {
  const source = await readFile(new URL("../extension/dashboard.js", import.meta.url), "utf8");
  const start = source.indexOf("async function refreshThumbnailProgress()");
  const end = source.indexOf("\nconst progressTimer", start);
  const functionSource = source.slice(start, end);
  assert.doesNotMatch(functionSource, /loadData\(|renderWorlds\(|START_SYNC/u);
  /** @type {(value: unknown) => void} */
  let resolveStatus = () => {};
  let calls = 0;
  let hydrated = 0;
  const state = { profile: { userId: "user-a" }, status: normalizeStatusResponse({}), worlds: [], thumbnailCount: 0 };
  const notice = { textContent: "", hidden: true };
  const createPoller = new Function(
    "state", "thumbnailCaptureNotice", "sendMessage", "normalizeStatusResponse", "isRecord", "presentThumbnailProgress", "hydrateWorldThumbnails", "readThumbnailCount",
    `let recordMutationInFlight = false, pageClosed = false, restoring = false, purging = false, progressPolling = false, progressEpoch = 0;
     let repository = {}, thumbnailRenderGeneration = 1;
     const document = {hidden: false}, worldList = { querySelectorAll: () => [] }, settingsThumbnailCount = {};
     const refreshObservedStatus = async () => false, renderConnection = () => {}, renderPrimaryFocus = () => {};
     const renderThumbnailProgressNotice = () => { thumbnailCaptureNotice.textContent = presentThumbnailProgress(state.status.thumbnailProgress, {savedCount: state.thumbnailCount}); };
     ${functionSource}
     return { poll: refreshThumbnailProgress, invalidate: () => { progressEpoch += 1; }, close: () => { pageClosed = true; } };`
  );
  const poller = createPoller(state, notice,
    () => { calls += 1; return new Promise((resolve) => { resolveStatus = resolve; }); },
    normalizeStatusResponse, /** @param {unknown} value */ (value) => typeof value === "object" && value !== null,
    presentThumbnailProgress, async () => { hydrated += 1; }, async () => 80
  );
  const response = { activeProfileId: "user-a", thumbnailProgress: { total: 300, saved: 30, remaining: 270, failed: 0, nextAttemptAt: null, state: "running" } };
  const first = poller.poll();
  await poller.poll();
  assert.equal(calls, 1);
  poller.invalidate();
  resolveStatus(response);
  await first;
  assert.equal(hydrated, 0);
  assert.equal(notice.textContent, "");
  const second = poller.poll();
  resolveStatus(response);
  await second;
  assert.equal(hydrated, 1);
  assert.match(notice.textContent, /30\/300/u);
  assert.equal(state.thumbnailCount, 80, "total stored count includes historical images outside this job");
  const third = poller.poll();
  resolveStatus({ ...response, activeProfileId: "user-b" });
  await third;
  assert.equal(hydrated, 1);
  const fourth = poller.poll();
  resolveStatus({activeProfileId: "user-a", thumbnailProgress: null, thumbnailSavedCount: 70});
  await fourth;
  const fifth = poller.poll();
  resolveStatus({activeProfileId: "user-a", thumbnailProgress: null, thumbnailSavedCount: 80});
  await fifth;
  assert.equal(hydrated, 3, "saved count changes refresh images even when both progress values are null");
  assert.match(notice.textContent, /保存済み画像80件/u);
  const failed = poller.poll();
  resolveStatus({ok: false});
  await failed;
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /保存済み画像80件/u);
  assert.match(notice.textContent, /保存状況を読み込めませんでした/u);
  poller.close();
  await poller.poll();
  assert.equal(calls, 6);
});


test("thumbnail count failure leaves main history load usable and count unknown", async () => {
  const failedRepository = { listThumbnailMetadata: async () => { throw new Error("image metadata unavailable"); } };
  assert.equal(await readThumbnailCount(failedRepository, USER_ID), null);
  assert.equal(await readThumbnailCount({ listThumbnailMetadata: async () => [] }, USER_ID), 0);
  const source = await readFile(new URL("../extension/dashboard.js", import.meta.url), "utf8");
  const start = source.indexOf("async function loadData(");
  const end = source.indexOf("\n/**", start);
  const state = { profile: null, status: normalizeStatusResponse({}), settings: {}, worlds: [], events: [], favoriteGroups: [], thumbnailCount: 999 };
  const worlds = [{ worldId: WORLD_A }];
  const events = [{ worldId: WORLD_A, kind: "name_changed" }];
  const database = {
    ...failedRepository,
    getDisplaySnapshot: async () => ({profile: {userId: "user-a", lastSuccessfulSyncAt: null}, worlds, events, favoriteGroups: [], worldDispositions: [], generation: 0, presentationGeneration: 0, unreadSummary: {exact: true, uncertain: false, count: 0}}),
    getSetting: async () => null
  };
  let rendered = 0;
  let warned = false;
  const load = new Function("state", "database", "normalizeStatusResponse", "readThumbnailCount", "renderAll", "renderThumbnailProgressNotice", `
    let progressEpoch = 0, thumbnailRenderGeneration = 0, visibleWorldCount = 0, visibleEventCount = 0;
    const PAGE_SIZE = 200, pageClosed = false;
    const repository = database;
    const requireRepository = () => database;
    const sendMessage = async () => ({activeProfileId: "user-a"});
    const isRecord = value => typeof value === "object" && value !== null;
    const selectProfile = async () => ({userId: "user-a", lastSuccessfulSyncAt: null});
    const readStorageEstimate = async () => ({usage: 0, quota: 0});
    const dateSetting = () => null;
    const summarizeHistory = () => ({attention: 0, missing: 0, unavailable: 0});
    const closeRecordDialogs = () => {}, invalidateRecordDialog = () => {}, hiddenWorldIds = () => new Set();
    ${source.slice(start, end)}
    return loadData;
  `)(state, database, normalizeStatusResponse, readThumbnailCount, () => { rendered += 1; }, () => { warned = state.thumbnailCount === null; });
  await load();
  assert.equal(rendered, 1);
  assert.equal(warned, true);
  assert.equal(state.thumbnailCount, null);
  assert.deepEqual(state.worlds, worlds);
  assert.deepEqual(state.events, events);
});

test("in-flight image saving copy allows closing the extension page", () => {
  const status = normalizeStatusResponse({syncing: true, thumbnailProgress: {total: 300, saved: 30, remaining: 270, failed: 0, nextAttemptAt: null, state: "running"}});
  const presentation = presentStatus(status);
  assert.equal(presentation.title, "画像を保存しています");
  assert.match(presentation.detail, /この画面を閉じても/u);
  assert.doesNotMatch(presentation.detail, /このままお待ち/u);
});


test("dashboard always renders thumbnail counts or an explicit unavailable state", async () => {
  const source = await readFile(new URL("../extension/dashboard.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderThumbnailProgressNotice()");
  const end = source.indexOf("\n// Refresh only", start);
  const state = {profile: /** @type {{userId: string} | null} */ ({userId: USER_ID}), status: normalizeStatusResponse({}), thumbnailCount: /** @type {number | null} */ (30), statusAvailable: false};
  const notice = {textContent: "", hidden: true};
  const render = new Function("state", "thumbnailCaptureNotice", "presentThumbnailProgress", `${source.slice(start, end)}; return renderThumbnailProgressNotice;`)(state, notice, presentThumbnailProgress);
  render();
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /保存済み画像30件/u);
  assert.match(notice.textContent, /残り件数は現在確認できません/u);
  assert.doesNotMatch(notice.textContent, /自動で保存しています/u);
  state.status.thumbnailProgress = {total: 0, saved: 0, remaining: 0, failed: 0, nextAttemptAt: null, state: "complete"};
  render();
  assert.match(notice.textContent, /保存済み画像30件/u);
  assert.match(notice.textContent, /取得対象は0件/u);
  state.status.thumbnailProgress = {total: 300, saved: 30, remaining: 270, failed: 0, nextAttemptAt: null, state: "running"};
  render();
  assert.match(notice.textContent, /保存済み30\/300件（残り270件）/u);
  state.status.thumbnailProgress = null;
  state.thumbnailCount = null;
  render();
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /件数を現在確認できません/u);
  assert.doesNotMatch(notice.textContent, /保存済み画像0件/u);
  state.profile = null;
  state.thumbnailCount = 0;
  render();
  assert.match(notice.textContent, /最初の確認後/u);
});

test("popup passes independent saved count into the progress presentation", async () => {
  const source = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");
  const start = source.indexOf("  thumbnailProgress.textContent =");
  const end = source.indexOf("  const presentation =", start);
  const notice = {textContent: "", hidden: true};
  const render = new Function("status", "thumbnailProgress", "presentThumbnailProgress", source.slice(start, end));
  for (const value of [30, 0, null, -1, "30"]) {
    const status = normalizeStatusResponse({activeProfileId: USER_ID, thumbnailSavedCount: value});
    render(status, notice, presentThumbnailProgress);
    assert.equal(notice.hidden, false);
    if (typeof value === "number" && value >= 0) assert.match(notice.textContent, new RegExp(`保存済み画像${value}件`, "u"));
    else assert.match(notice.textContent, /件数を現在確認できません/u);
  }
});


test("popup status failure keeps known saved count without stale running text", async () => {
  const source = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");
  const start = source.indexOf("function showUnavailableStatus()");
  const end = source.indexOf("\nsyncButton.addEventListener", start);
  const notice = {textContent: "", hidden: true};
  const handler = new Function("thumbnailProgress", "normalizeStatusResponse", "presentThumbnailProgress", `
    let pageClosed = false, lastKnownThumbnailSavedCount = null;
    const statusCard = {}, statusDot = {}, statusTitle = {}, statusDetail = {}, lastSync = {};
    const attentionCard = {classList: {remove: () => {}}};
    const attentionTitle = {}, attentionDetail = {}, dashboardButton = {};
    ${source.slice(start, end)}
    const receive = response => {
      ${source.slice(source.indexOf("  const status = normalizeStatusResponse(response);"), source.indexOf("  const presentation ="))}
    };
    return {fail: showUnavailableStatus, receive};
  `)(notice, normalizeStatusResponse, presentThumbnailProgress);
  handler.fail();
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /画像の保存状況を読み込めませんでした/u);
  assert.doesNotMatch(notice.textContent, /保存済み画像0件/u);
  handler.receive({activeProfileId: USER_ID, thumbnailSavedCount: 30, thumbnailProgress: {total: 300, saved: 30, remaining: 270, failed: 0, nextAttemptAt: null, state: "running"}});
  assert.match(notice.textContent, /自動で保存しています/u);
  handler.fail();
  assert.match(notice.textContent, /保存済み画像30件/u);
  assert.match(notice.textContent, /読み込めませんでした/u);
  assert.doesNotMatch(notice.textContent, /自動で保存しています/u);
  handler.receive({activeProfileId: USER_ID, thumbnailSavedCount: null});
  handler.fail();
  assert.doesNotMatch(notice.textContent, /保存済み画像30件/u);
});


test("focused overview distinguishes baseline, pending, stale, failures and confirmed union", () => {
  const ready = normalizeStatusResponse({activeProfileId: USER_ID, lastSuccessfulSyncAt: new Date().toISOString(), lastResult: "success"});
  for (const status of [normalizeStatusResponse({}), normalizeStatusResponse({activeProfileId: USER_ID})]) {
    assert.match(presentWorldOverview(status).title, /最初の記録/u);
    assert.doesNotMatch(presentWorldOverview(status).title, /ありません/u);
  }
  assert.match(presentWorldOverview(ready).title, /確認できたワールドはありません/u);
  assert.doesNotMatch(presentWorldOverview(ready).detail, /すべて.*アクセス可能/u);
  assert.match(presentWorldOverview(ready, {pendingWorldCount: 3}).detail, /状態を確認中/u);
  assert.match(presentWorldOverview({...ready, pendingProbeCount: 1}).detail, /状態を確認中/u);
  assert.match(presentWorldOverview({...ready, syncing: true}).title, /確認しています/u);
  for (const patch of [{authRequired: true}, {lastResult: "offline"}, {lastResult: "failed"}, {lastSuccessfulSyncAt: "2020-01-01T00:00:00Z"}]) {
    assert.match(presentWorldOverview({...ready, ...patch}).title, /最新の状態はまだ確認できていません/u);
  }
  assert.match(presentWorldOverview(ready, {statusAvailable: false}).title, /最新の状態/u);
  const confirmed = {...ready, attentionWorldCount: 2, unavailableCount: 1, missingCount: 2};
  assert.equal(presentWorldOverview(confirmed).title, "消えた可能性のあるワールド 2件");
  assert.match(presentWorldOverview({...confirmed, authRequired: true}).detail, /最後に保存できた/u);
  assert.match(presentWorldOverview({...confirmed, syncing: true}).detail, /前回の記録/u);
});

test("dashboard navigation supports native links and Back/Forward without fake tabs", async () => {
  const source = await readFile(new URL("../extension/dashboard.js", import.meta.url), "utf8");
  assert.match(source, /window.addEventListener\("hashchange", navigateFromHash\)/u);
  assert.match(source, /aria-current/u);
  assert.doesNotMatch(source, /role", "tablist"|role", "tab"/u);
  assert.match(source, /if \(state.status.syncing \|\| purging \|\| manualSyncInFlight \|\| recordMutationInFlight\) return/u);
});


test("popup primary entry is composed with the focused attention opener", async () => {
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  assert.match(source, /const openDashboard = createAttentionDashboardOpener\(openerDependencies\)/u);
});


test("action popup keeps its intrinsic width independent of the initial viewport", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  const html = await readFile(new URL("../extension/popup.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../extension/styles/popup.css", import.meta.url), "utf8");
  const bodyRule = css.match(/(?:^|\n)body\s*\{([^}]+)\}/u)?.[1] ?? "";

  assert.equal(manifest.action.default_popup, "popup.html");
  assert.match(html, /href="styles\/popup\.css"/u);
  assert.match(bodyRule, /(?:^|[;\n])\s*width:\s*370px\s*;/u);
  // A popup's initial viewport is sized from this rule, so 100vw is circular.
  assert.doesNotMatch(bodyRule, /(?:max-width|min-width|width):[^;]*(?:vw|vi|%)/u);
});

test("dashboard text and button palette stays above WCAG AA contrast", async () => {
  const css = await readFile(new URL("../extension/styles/dashboard.css", import.meta.url), "utf8");
  /** @param {string} hex */
  const luminance = (hex) => {
    const components = [1, 3, 5].map((start) => {
      const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return (components[0] ?? 0) * 0.2126 + (components[1] ?? 0) * 0.7152 + (components[2] ?? 0) * 0.0722;
  };
  for (const [foreground, background] of [
    ["#FFFFFF", "#356447"], ["#252923", "#E7EEE7"], ["#5C635A", "#FFFFFF"],
    ["#5C635A", "#F7F6F2"], ["#8B3028", "#F8ECE9"], ["#725321", "#FAF0D9"],
    ["#252923", "#FFFFFF"], ["#5C635A", "#E9EAE4"]
  ]) {
    assert.ok(foreground && background);
    assert.ok(css.includes(foreground) && css.includes(background), "tested colors must exist in the stylesheet");
    const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
    assert.ok(((values[1] ?? 0) + 0.05) / ((values[0] ?? 0) + 0.05) >= 4.5, `${foreground} on ${background}`);
  }
  assert.match(css, /summary:focus-visible/u);
  assert.match(css, /file-button:focus-within/u);
  assert.match(css, /@media \(forced-colors: active\)/u);
});


test("popup exposes only the needed daily actions without hiding failures or setup", async () => {
  const source = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");
  const start = source.indexOf("  const presentation = presentStatus(status);");
  const end = source.indexOf("\n}\n\nfunction showUnavailableStatus()", start);
  const element = () => ({textContent: "", hidden: false, disabled: false, className: "", classList: {toggle() {}}});
  const attentionCard = element(), attentionTitle = element(), attentionDetail = element(), dashboardButton = element();
  const statusCard = element(), statusDot = element(), statusTitle = element(), statusDetail = element(), lastSync = element();
  const syncButton = element(), loginButton = element();
  const render = new Function(
    "status", "presentStatus", "presentWorldOverview", "formatDateTime", "attentionCard", "attentionTitle", "attentionDetail", "dashboardButton",
    "statusCard", "statusDot", "statusTitle", "statusDetail", "lastSync", "syncButton", "loginButton", "syncInFlight",
    `let lastKnownSyncing = false; const requiredElement = () => ({}), UNREAD_UNCERTAIN_DETAIL = "unknown"; ${source.slice(start, end)}; return lastKnownSyncing;`
  );
  /** @param {Record<string, unknown>} status @param {boolean} [inFlight] */
  const receive = (status, inFlight = false) => render(normalizeStatusResponse(status), presentStatus, presentWorldOverview, formatDateTime,
    attentionCard, attentionTitle, attentionDetail, dashboardButton, statusCard, statusDot, statusTitle, statusDetail, lastSync, syncButton, loginButton, inFlight);
  const ready = {activeProfileId: USER_ID, lastSuccessfulSyncAt: new Date().toISOString(), lastResult: "success"};
  receive({...ready, attentionWorldCount: 2, missingCount: 2, unavailableCount: 1});
  assert.equal(attentionTitle.textContent, "消えた可能性のあるワールド 2件");
  assert.equal(dashboardButton.textContent, "名前と画像を見る");
  assert.equal(loginButton.hidden, true);
  assert.equal(statusCard.hidden, true);
  assert.equal(syncButton.disabled, false);
  receive({});
  assert.match(attentionTitle.textContent, /最初の記録/u);
  assert.equal(loginButton.hidden, false);
  assert.equal(syncButton.className, "button button-primary");
  receive({...ready, authRequired: true});
  assert.equal(loginButton.hidden, false);
  assert.equal(statusCard.hidden, false);
  assert.match(statusTitle.textContent, /ログイン/u);
  receive({...ready, lastResult: "offline"});
  assert.match(attentionTitle.textContent, /最新の状態はまだ/u);
  assert.equal(statusCard.hidden, false);
  receive({...ready, pendingProbeCount: 1});
  assert.equal(statusCard.hidden, false);
  assert.match(statusDetail.textContent, /個別確認待ち/u);
  receive({...ready, syncing: true});
  assert.equal(syncButton.disabled, true);
  assert.equal(statusCard.hidden, false);
  assert.equal(loginButton.hidden, true);
  receive(ready, true);
  assert.equal(syncButton.disabled, true, "a lagging status response cannot re-enable an in-flight manual action");
  receive(ready);
  assert.equal(syncButton.disabled, false);
});

test("popup keeps image progress available behind a native disclosure and matches dashboard colors", async () => {
  const html = await readFile(new URL("../extension/popup.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../extension/styles/popup.css", import.meta.url), "utf8");
  assert.match(html, /<details class="record-status">[\s\S]*id="thumbnail-progress"/u);
  assert.match(html, /id="login-button"[^>]*hidden/u);
  assert.match(css, /\.button-primary\s*\{[^}]*color: #FFFFFF;[^}]*background: #356447;/u);
  assert.match(css, /\.button-secondary\s*\{[^}]*color: #252923;[^}]*background: #E7EEE7;/u);
  assert.match(css, /summary:focus-visible/u);
  assert.doesNotMatch(css, /min-height: 560px|animation: pulse/u);
});


test("dashboard observes external sync completion without restarting sync or resetting the view", async () => {
  const source = await readFile(new URL("../extension/dashboard.js", import.meta.url), "utf8");
  const start = source.indexOf("async function refreshObservedStatus(");
  const end = source.indexOf("\n}\n", start) + 2;
  const oldTime = "2026-01-01T00:00:00Z";
  const state = {profile: {userId: USER_ID}, status: normalizeStatusResponse({activeProfileId: USER_ID, lastSuccessfulSyncAt: oldTime, syncing: true, attentionWorldCount: 2}), statusAvailable: true};
  /** @type {unknown[][]} */
  const loads = [];
  /** @type {string[]} */
  const notices = [];
  let renders = 0;
  let rejectLoad = false;
  let incoming = state.status;
  const refresh = new Function("state", "loadData", "renderConnection", "showNotice", `
    const pageClosed = false, restoring = false, purging = false;
    const closeRecordDialogs = () => {}, invalidateRecordDialog = () => {};
    const renderPrimaryFocus = renderConnection, renderSummary = renderConnection, renderSettings = renderConnection;
    ${source.slice(start, end)}
    return refreshObservedStatus;
  `)(state, /** @param {unknown[]} args */ async (...args) => {
    loads.push(args);
    if (rejectLoad) throw new Error("synthetic storage read failure");
    state.status = {...incoming};
    state.profile = {userId: incoming.activeProfileId ?? USER_ID};
  }, () => { renders += 1; }, /** @param {string} title */ (title) => notices.push(title));
  incoming = normalizeStatusResponse({activeProfileId: USER_ID, lastSuccessfulSyncAt: oldTime, syncing: false, authRequired: true, attentionWorldCount: 99});
  assert.equal(await refresh(incoming), false);
  assert.equal(state.status.syncing, false);
  assert.equal(state.status.authRequired, true);
  assert.equal(state.status.attentionWorldCount, 2, "runtime counters do not replace counts derived from the displayed local records");
  assert.equal(renders, 4);
  assert.equal(loads.length, 0);
  incoming = {...incoming, lastSuccessfulSyncAt: "2026-01-02T00:00:00Z", authRequired: false};
  assert.equal(await refresh(incoming), true);
  assert.deepEqual(loads, [[null, true]], "new saved results retain the current pagination and filters");
  assert.equal(await refresh(incoming), false);
  assert.equal(loads.length, 1, "an unchanged successful observation does not reload cards");
  incoming = {...incoming, generation: 2, presentationGeneration: 3};
  assert.equal(await refresh(incoming), true, "record writes reload without any change to last sync time");
  assert.equal(loads.length, 2);
  incoming = {...incoming, activeProfileId: "usr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"};
  assert.equal(await refresh(incoming), true);
  assert.equal(loads.length, 3);
  incoming = {...incoming, lastSuccessfulSyncAt: "2026-01-03T00:00:00Z"};
  rejectLoad = true;
  assert.equal(await refresh(incoming), true);
  assert.equal(state.statusAvailable, false);
  assert.deepEqual(notices, ["最新の記録を読み込めませんでした"]);
  assert.doesNotMatch(source.slice(start, end), /START_SYNC|worldSearch\.value|groupFilter\.value|activateTab/u);
  assert.match(source, /if \(!preserveView\) \{\s+visibleWorldCount = PAGE_SIZE;/u);
});

test("native dashboard routes handle hash changes, repeated same-link clicks and late history reads", async () => {
  const source = await readFile(new URL("../extension/dashboard.js", import.meta.url), "utf8");
  /** @param {string} name */
  const functionSource = (name) => {
    const start = source.indexOf(`function ${name}(`);
    return source.slice(start, source.indexOf("\n}\n", start) + 2);
  };
  const start = source.indexOf("for (const name of VALID_TABS) requiredElement");
  const end = source.indexOf("worldSearch.addEventListener", start);
  const create = new Function(`
    const VALID_TABS = new Set(["worlds", "events", "settings"]), PAGE_SIZE = 200;
    let visibleWorldCount = 0, worldRenders = 0, historyReads = 0, navigationEpoch = 0, recordInteractionEpoch = 0;
    const closeRecordDialogs = () => {}, recordActionMessage = {};
    const focus = [], handlers = new Map();
    class HTMLAnchorElement {
      constructor(tab, href) { this.dataset = {tab}; this.attrs = new Map([["href", href]]); this.handlers = new Map(); this.classList = {toggle() {}}; }
      getAttribute(key) { return this.attrs.get(key); }
      setAttribute(key, value) { this.attrs.set(key, value); }
      removeAttribute(key) { this.attrs.delete(key); }
      addEventListener(type, action) { this.handlers.set(type, action); }
    }
    const tabButtons = [...VALID_TABS].map(name => new HTMLAnchorElement(name, name === "worlds" ? "#attention" : "#" + name));
    const panels = Object.fromEntries([...VALID_TABS].map(name => [name + "-panel", {hidden: true, focus() {focus.push(name);}}]));
    const requiredElement = id => panels[id];
    const worldFilter = {value: ""}, eventFilter = {value: ""}, worldSearch = {value: ""}, groupFilter = {value: ""};
    const window = {location: {hash: "#all"}, addEventListener(type, action) {handlers.set(type, action);}};
    const document = {querySelectorAll() {return tabButtons;}, addEventListener() {}};
    const renderWorlds = () => {worldRenders += 1;}, renderEvents = () => {};
    let finishRead;
    const markHistoryAsRead = () => {historyReads += 1; return new Promise(resolve => {finishRead = resolve;});};
    ${functionSource("activateTab")}
    ${functionSource("initialTabFromHash")}
    ${functionSource("applyInitialRouteFilters")}
    ${source.slice(start, end)}
    return {panels, worldFilter, worldSearch, groupFilter, tabButtons, focus,
      route(hash) {window.location.hash = hash; handlers.get("hashchange")();},
      sameLink() {tabButtons[0].handlers.get("click")();},
      finishRead() {finishRead?.();}, counts: () => ({worldRenders, historyReads})};
  `);
  const ui = create();
  assert.equal(ui.worldFilter.value, "all");
  ui.route("#attention");
  assert.equal(ui.worldFilter.value, "attention");
  ui.worldSearch.value = "old search";
  ui.groupFilter.value = "worlds2";
  ui.sameLink();
  assert.equal(ui.worldSearch.value, "");
  assert.equal(ui.groupFilter.value, "");
  assert.equal(ui.counts().worldRenders, 2);
  ui.route("#events");
  ui.route("#settings");
  ui.finishRead();
  assert.equal(ui.panels["settings-panel"].hidden, false);
  assert.equal(ui.panels["events-panel"].hidden, true);
  assert.equal(ui.counts().historyReads, 1);
  assert.equal(ui.tabButtons[2].getAttribute("aria-current"), "page");
  ui.route("#events");
  assert.equal(ui.panels["events-panel"].hidden, false, "Back-like hash navigation selects its matching panel");
  ui.route("#unexpected");
  assert.equal(ui.worldFilter.value, "attention");
  assert.equal(ui.panels["worlds-panel"].hidden, false);
  assert.equal(ui.focus.at(-1), "worlds");
});

test("dashboard manual command stays busy through lagging status and clears only its own progress", async () => {
  const source = await readFile(new URL("../extension/dashboard.js", import.meta.url), "utf8");
  const start = source.indexOf("async function performSync()");
  const end = source.indexOf("\nsyncNowButton.addEventListener", start);
  const create = new Function("normalizeCommandResponse", "commandErrorMessage", `
    let recordMutationInFlight = false, manualSyncInFlight = false, restoring = false, purging = false, commands = 0;
    let finish, working = false, notice = "";
    const state = {status: {syncing: false}}, syncNowButton = {};
    const renderConnection = () => {working = state.status.syncing || manualSyncInFlight;};
    const renderPrimaryFocus = renderConnection, renderSettings = () => {};
    const showNotice = title => {notice = title;};
    const loadData = async () => {state.status.syncing = false; renderConnection(); return true;};
    const sendMessage = () => {commands += 1; return new Promise(resolve => {finish = resolve;});};
    ${source.slice(start, end)}
    return {run: performSync, state, syncNowButton, finish: result => finish(result), snapshot: () => ({commands, working, notice})};
  `);
  const controller = create(normalizeCommandResponse, commandErrorMessage);
  const first = controller.run();
  assert.equal(controller.snapshot().working, true);
  controller.state.status.syncing = false;
  await controller.run();
  assert.equal(controller.snapshot().commands, 1, "a late idle observation cannot start another command");
  controller.finish({ok: true});
  await first;
  assert.equal(controller.snapshot().working, false);
  assert.equal(controller.syncNowButton.disabled, false);
  const failed = controller.run();
  controller.finish({ok: false, error: "offline"});
  await failed;
  assert.equal(controller.snapshot().notice, "確認を開始できませんでした");
  assert.equal(controller.snapshot().working, false);
  assert.equal(controller.syncNowButton.disabled, false);
});

test("dashboard publishes only one current snapshot after delayed reads and maintenance", async () => {
  const source = await readFile(new URL("../extension/dashboard.js", import.meta.url), "utf8");
  /** @param {string} declaration */
  const extract = (declaration) => {
    const start = source.indexOf(declaration);
    return source.slice(start, source.indexOf("\n}\n", start) + 2);
  };
  const create = new Function("normalizeStatusResponse", "readThumbnailCount", "phase", `
    let progressEpoch = 0, thumbnailRenderGeneration = 0, visibleWorldCount = 400, visibleEventCount = 400;
    let pageClosed = false, activeId = "a", release, rejectRead, signalReady;
    const ready = new Promise(resolve => {signalReady = resolve;});
    const pause = () => new Promise((resolve, reject) => {release = resolve; rejectRead = reject; signalReady();});
    const times = {a: "2026-01-01T00:00:00Z", b: "2026-02-01T00:00:00Z"};
    const profiles = ["a", "b"].map(userId => ({userId, lastSuccessfulSyncAt: times[userId], firstSeenAt: times[userId]}));
    const database = {
      async listProfiles() {if (activeId === "a" && phase === "profile") await pause(); return profiles;},
      async getDisplaySnapshot(id) {
        if (id === "a" && phase === "worlds") await pause();
        return {profile: profiles.find(profile => profile.userId === id),
          worlds: Array.from({length: id === "a" ? 1 : 2}, (_, i) => ({userId: id, worldId: id + i})),
          events: [{userId: id, worldId: id + "0"}], favoriteGroups: [{userId: id}], worldDispositions: [],
          generation: 1, presentationGeneration: 1, unreadSummary: {exact: true, uncertain: false, count: 0}};
      },
      async listThumbnailMetadata(id) {return [{userId: id}];},
      async getSetting(key) {
        const id = activeId;
        if (id === "a" && key === "autoSyncEnabled" && phase === "settings") await pause();
        if (key === "activeProfileId") return id;
        if (key === "lastBackupAt" || key === "nextSyncAt") return times[id];
        return id === "b";
      }
    };
    let repository = database;
    const requireRepository = () => repository;
    const sendMessage = async () => {
      const id = activeId;
      if (id === "a" && phase === "status") await pause();
      return {activeProfileId: id, lastSuccessfulSyncAt: times[id], lastResult: "success"};
    };
    const isRecord = value => typeof value === "object" && value !== null;
    const readStorageEstimate = async () => ({usage: 10, quota: 100});
    const dateSetting = value => value;
    const summarizeHistory = worlds => ({attention: worlds.length, missing: worlds.length, unavailable: 0});
    const closeRecordDialogs = () => {}, invalidateRecordDialog = () => {}, hiddenWorldIds = () => new Set();
    const state = {profile: null, worlds: [], events: [], favoriteGroups: [], thumbnailCount: 0, status: normalizeStatusResponse({}), statusAvailable: true, settings: {}, storageEstimate: {quota: 100}};
    const renders = [], purgeMessage = {}, PAGE_SIZE = 200;
    const renderAll = () => renders.push({profile: state.profile?.userId, worlds: state.worlds.map(world => world.userId)});
    const renderThumbnailProgressNotice = () => {};
    ${extract("async function selectProfile(")}
    ${extract("async function loadData(")}
    ${extract("function showDeletedState(")}
    return {state, renders, ready,
      load(id) {activeId = id; return loadData(id, true);},
      release() {release();}, reject() {rejectRead(new Error("synthetic delayed read failure"));},
      restoreBegins() {progressEpoch += 1;}, clear() {showDeletedState("cleared");},
      replaceRepository() {repository = {...database};}, close() {pageClosed = true; progressEpoch += 1;},
      pagination: () => [visibleWorldCount, visibleEventCount]};
  `);
  for (const phase of ["status", "profile", "worlds", "settings"]) {
    const ui = create(normalizeStatusResponse, readThumbnailCount, phase);
    const staleA = ui.load("a");
    await ui.ready;
    assert.equal(ui.state.profile, null, `${phase}: pending reads never publish a partial profile`);
    assert.deepEqual(ui.state.worlds, []);
    ui.restoreBegins();
    assert.equal(await ui.load("b"), true);
    ui.release();
    assert.equal(await staleA, false);
    assert.equal(ui.state.profile.userId, "b");
    assert.equal(ui.state.status.activeProfileId, "b");
    assert.equal(ui.state.status.lastSuccessfulSyncAt, "2026-02-01T00:00:00Z");
    assert.deepEqual(ui.state.worlds.map((/** @type {{userId: string}} */ world) => world.userId), ["b", "b"]);
    assert.equal(ui.state.events[0].userId, "b");
    assert.equal(ui.state.favoriteGroups[0].userId, "b");
    assert.equal(ui.state.settings.autoSyncEnabled, true);
    assert.equal(ui.renders.length, 1, `${phase}: stale completion does not rerender`);
    assert.deepEqual(ui.pagination(), [400, 400]);
  }
  for (const boundary of ["restoreBegins", "clear", "replaceRepository", "close"]) {
    const ui = create(normalizeStatusResponse, readThumbnailCount, "worlds");
    const stale = ui.load("a");
    await ui.ready;
    ui[boundary]();
    ui.release();
    assert.equal(await stale, false, boundary);
    assert.equal(ui.state.profile, null);
    assert.deepEqual(ui.state.worlds, []);
    assert.equal(ui.renders.length, boundary === "clear" ? 1 : 0);
  }
  const failed = create(normalizeStatusResponse, readThumbnailCount, "worlds");
  const currentRead = failed.load("a");
  await failed.ready;
  failed.reject();
  await assert.rejects(currentRead, /synthetic delayed read failure/u);
  assert.equal(failed.state.profile, null);
  assert.deepEqual(failed.state.worlds, []);
  const obsolete = create(normalizeStatusResponse, readThumbnailCount, "worlds");
  const obsoleteRead = obsolete.load("a");
  await obsolete.ready;
  await obsolete.load("b");
  obsolete.reject();
  assert.equal(await obsoleteRead, false, "a rejected old read must not turn a newer successful view into an error");
  assert.equal(obsolete.state.profile.userId, "b");
  assert.equal(obsolete.state.statusAvailable, true);
});

test("hidden records are excluded from all ordinary filters but retain name, author, old-name and list search", () => {
  const visible = world({worldId: WORLD_A, membershipState: "not_in_favorites"});
  const hidden = world({worldId: WORLD_B, currentName: "非表示の庭", authorName: "特別な作者", favoriteTags: ["worlds1"], availabilityState: "unavailable"});
  const dispositions = [{worldId: WORLD_B, state: /** @type {const} */ ("hidden")}];
  const events = [historyEvent({eventId: "hidden-old", worldId: WORLD_B, kind: "name_changed", before: "古い庭", after: "非表示の庭"})];
  for (const filter of /** @type {const} */ (["all", "attention", "unavailable", "favorite", "pending", "missing"])) {
    assert.ok(filterWorlds([visible, hidden], events, "", filter, null, [], dispositions).every((record) => record.worldId !== WORLD_B), filter);
  }
  for (const query of ["非表示の庭", "特別な作者", "古い庭", WORLD_B, "大切な場所"]) {
    assert.deepEqual(filterWorlds([visible, hidden], events, query, "hidden", "worlds1", [favoriteGroup()], dispositions), [hidden]);
  }
  assert.deepEqual(summarizeHistory([visible, hidden], events, dispositions), {attention: 1, total: 2, missing: 1, unavailable: 0, renamed: 1});
  assert.deepEqual(filterWorlds([visible, hidden], events, "", "hidden", "worlds2", [], dispositions), []);
});

test("unread summary is authoritative and uncertain legacy totals never become an exact number", () => {
  const exact = normalizeStatusResponse({unreadCount: 99, unreadSummary: {exact: true, uncertain: false, count: 3}, generation: 8, presentationGeneration: 5, hiddenCount: 2});
  assert.equal(exact.unreadCount, 3);
  assert.equal(exact.generation, 8);
  assert.equal(exact.presentationGeneration, 5);
  assert.equal(exact.hiddenCount, 2);
  for (const summary of [{exact: false, uncertain: true, count: null}, {exact: true, uncertain: false, count: -1}, {count: 123}, null]) {
    const status = normalizeStatusResponse({unreadCount: 99, unreadSummary: summary});
    assert.deepEqual(status.unreadSummary, {exact: false, uncertain: true, count: null});
    assert.equal(status.unreadCount, 0);
  }
  const hiddenOnly = normalizeStatusResponse({activeProfileId: USER_ID, worldCount: 2, hiddenCount: 2});
  assert.match(presentWorldOverview(hiddenOnly).detail, /非表示の記録が2件あります/u);
  assert.doesNotMatch(presentWorldOverview(hiddenOnly).title, /最初|記録なし/u);
});

/** @param {string} source @param {string} declaration */
function dashboardFunction(source, declaration) {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, declaration);
  return source.slice(start, source.indexOf("\n}\n", start) + 2);
}

async function createRecordActionHarness() {
  const source = await readFile(new URL("../extension/dashboard.js", import.meta.url), "utf8");
  const extract = /** @param {string} declaration */ (declaration) => dashboardFunction(source, declaration);
  return new Function("worldMatchesFilter", `
    let recordMutationInFlight = false, restoring = false, purging = false, pageClosed = false;
    let recordInteractionEpoch = 0, navigationEpoch = 0, progressEpoch = 0, thumbnailRenderGeneration = 0, recordDialogEpoch = 0, recordDialogAction = null, recordDialogImageUrl = null;
    const calls = [], focus = [], revoked = [], recordActionMessage = {textContent: ""};
    const element = () => ({textContent: "", disabled: false, children: [],
      append(...children) {this.children.push(...children);}, replaceChildren(...children) {this.children = children;},
      querySelector() {return null;}, setAttribute() {}, removeAttribute() {}, isConnected: true, focus() {focus.push("trigger");}});
    const recordDialogs = ["hide", "purge"].map(name => ({name,
      dialog: {open: false, showModal() {this.open = true;}, close() {this.open = false;}},
      target: element(), description: element(), feedback: element(), submit: element(),
      cancel: {...element(), focus() {focus.push(name + "-cancel");}}
    }));
    const state = {profile: {userId: "user-a"}, status: {generation: 2, presentationGeneration: 3, syncing: false}};
    const stored = {profile: {userId: "user-a", displayName: "テスト利用者"},
      worlds: [{worldId: "world-a", currentName: "テストの庭", revision: 4, membershipState: "not_in_favorites", availabilityState: "unavailable"}],
      events: [{worldId: "world-a"}], worldDispositions: [], generation: 2, presentationGeneration: 3};
    let activeProfile = "user-a", readError = false, imageError = false, refreshError = false, reads = 0, pendingRead = null;
    let response = {ok: true, recordSaved: true, thumbnailScheduleWarning: null}, deferred = null, pendingRefresh = null;
    const database = {async getDisplaySnapshot() {reads += 1; if (pendingRead) await new Promise(resolve => {pendingRead.resolve = resolve;}); if (readError) throw Error("read"); return stored;},
      async getSetting() {return activeProfile;}, async getThumbnails() {if (imageError) throw Error("image"); return [{blob: "fixture"}];}};
    let repository = database;
    const requireRepository = () => repository;
    const isRecord = value => typeof value === "object" && value !== null;
    const textElement = (tagName, className, text) => ({tagName, className, textContent: text});
    const document = {handlers: new Map(), createElement() {return {addEventListener() {}, replaceWith() {}};},
      addEventListener(type, run) {this.handlers.set(type, run);}};
    const control = () => ({value: "", handlers: new Map(), addEventListener(type, run) {this.handlers.set(type, run);}});
    const worldSearch = control(), worldFilter = control(), groupFilter = control(), eventFilter = control();
    let visibleWorldCount = 200, visibleEventCount = 200;
    const PAGE_SIZE = 200, renderWorlds = () => {}, renderEvents = () => {};
    ${source.slice(source.indexOf("function observeRecordInteraction("), source.indexOf("async function openVrchat("))}
    const URL = {createObjectURL() {return "blob:synthetic";}, revokeObjectURL(url) {revoked.push(url);}};
    const worldList = {querySelectorAll: () => []};
    const renderConnection = () => {}, renderSettings = () => {};
    const restoreWorldFocus = () => {focus.push("neighbor");};
    const loadData = async () => {if (pendingRefresh) await new Promise(resolve => {pendingRefresh.resolve = resolve; pendingRefresh.started();}); if (refreshError) throw Error("refresh"); return true;};
    const sendMessage = async message => {calls.push(message); if (deferred) return await new Promise(resolve => {deferred.resolve = resolve;}); if (response === "throw") throw Error("lost response"); return response;};
    ${extract("function closeRecordDialogs(")}
    ${extract("function invalidateRecordDialog(")}
    ${extract("async function openRecordDialog(")}
    ${extract("function recordErrorMessage(")}
    ${extract("async function performRecordAction(")}
    const action = type => ({type, userId: "user-a", worldId: "world-a", expectedGeneration: 2, expectedPresentationGeneration: 3, expectedRevision: 4, trigger: element(), position: 0, navigation: 0});
    return {state, stored, calls, focus, revoked, dialogs: recordDialogs, message: recordActionMessage,
      action, open: openRecordDialog, run: performRecordAction, close: closeRecordDialogs, invalidate: invalidateRecordDialog,
      reads: () => reads,
      focusNewControl() {document.handlers.get("focusin")();},
      editSearch(value) {worldSearch.value = value; worldSearch.handlers.get("input")();},
      changeFilter(value) {worldFilter.value = value; worldFilter.handlers.get("change")();},
      changeGroup(value) {groupFilter.value = value; groupFilter.handlers.get("change")();},
      view: () => ({search: worldSearch.value, filter: worldFilter.value, group: groupFilter.value}),
      delayRefresh() {pendingRefresh = {}; pendingRefresh.ready = new Promise(resolve => {pendingRefresh.started = resolve;});},
      whenRefreshing() {return pendingRefresh.ready;}, finishRefresh() {pendingRefresh.resolve(); pendingRefresh = null;},
      delayRead() {pendingRead = {};}, releaseRead() {pendingRead.resolve(); pendingRead = null;}, newLoad() {progressEpoch += 1;}, newRender() {thumbnailRenderGeneration += 1;},
      response(value) {response = value;}, delay() {deferred = {};}, finish(value) {deferred.resolve(value);},
      failRead() {readError = true;}, failImage() {imageError = true;}, failRefresh() {refreshError = true;},
      changeAccount() {activeProfile = "user-b"; state.profile.userId = "user-b"; closeRecordDialogs(false);},
      setActiveAccount(value) {activeProfile = value;}, navigate() {navigationEpoch += 1; closeRecordDialogs(false);},
      closePage() {pageClosed = true; closeRecordDialogs(false);}, replaceRepository() {repository = {...database};}};
  `)(worldMatchesFilter);
}

test("record dialogs show exact target and safety copy, default to cancel and revoke preview on cancel", async () => {
  const ui = await createRecordActionHarness();
  await ui.open(ui.action("HIDE_WORLD"));
  assert.equal(ui.dialogs[0].dialog.open, true);
  assert.deepEqual(ui.focus, ["hide-cancel"]);
  assert.match(ui.dialogs[0].description.textContent, /名前・画像・変更履歴は残り/u);
  assert.match(ui.dialogs[0].description.textContent, /同期と通知は続きます。VRChatのお気に入りは変更しません/u);
  assert.match(JSON.stringify(ui.dialogs[0].target.children), /テスト利用者|world-a|変更履歴: 1件/u);
  ui.close();
  assert.equal(ui.calls.length, 0, "cancel never sends a write");
  assert.equal(ui.dialogs[0].dialog.open, false);
  assert.deepEqual(ui.revoked, ["blob:synthetic"]);
  assert.equal(ui.focus.at(-1), "trigger");
  ui.stored.worldDispositions = [{worldId: "world-a", state: "hidden"}];
  ui.stored.worlds[0].membershipState = "favorited";
  ui.stored.worlds[0].availabilityState = "accessible";
  await ui.open(ui.action("PURGE_HIDDEN_WORLD"));
  assert.equal(ui.dialogs[1].dialog.open, true);
  assert.match(ui.dialogs[1].description.textContent, /この操作は取り消せません/u);
  assert.match(ui.dialogs[1].description.textContent, /削除した画像はJSONから戻せません/u);
  assert.match(ui.dialogs[1].description.textContent, /World IDだけを残します/u);
  assert.match(ui.dialogs[1].description.textContent, /現在は利用可能なため/u);
  assert.equal(ui.focus.at(-1), "purge-cancel");
  ui.invalidate();
  assert.equal(ui.dialogs[1].submit.disabled, true);
  assert.match(ui.dialogs[1].feedback.textContent, /もう一度確認/u);
  ui.close();
  assert.equal(ui.focus.at(-1), "trigger", "stale dialog retains a safe cancel focus target");
});

test("confirmation reads fail closed for missing images, stale revisions and accounts", async () => {
  for (const failure of ["failRead", "failImage"]) {
    const ui = await createRecordActionHarness();
    ui[failure]();
    await ui.open(ui.action("HIDE_WORLD"));
    assert.equal(ui.dialogs.some((/** @type {{dialog: {open: boolean}}} */ controls) => controls.dialog.open), false);
    assert.match(ui.message.textContent, /削除は開始していません/u);
    assert.equal(ui.calls.length, 0);
  }
  for (const change of ["revision", "generation", "presentation", "account", "eligible"]) {
    const ui = await createRecordActionHarness();
    if (change === "revision") ui.stored.worlds[0].revision += 1;
    if (change === "generation") ui.stored.generation += 1;
    if (change === "presentation") ui.stored.presentationGeneration += 1;
    if (change === "account") ui.setActiveAccount("user-b");
    if (change === "eligible") {ui.stored.worlds[0].membershipState = "favorited"; ui.stored.worlds[0].availabilityState = "accessible";}
    await ui.open(ui.action("HIDE_WORLD"));
    assert.equal(ui.dialogs[0].dialog.open, false, change);
    assert.equal(ui.calls.length, 0, change);
    assert.match(ui.message.textContent, /記録が更新されました/u);
  }
});

test("record commands fix expected identities, block double clicks and reconcile lost responses without retry", async () => {
  const ui = await createRecordActionHarness();
  ui.delay();
  const action = ui.action("RESTORE_HIDDEN_WORLD");
  const first = ui.run(action);
  await ui.run(action);
  assert.equal(ui.calls.length, 1);
  assert.deepEqual(ui.calls[0], {type: "RESTORE_HIDDEN_WORLD", userId: "user-a", worldId: "world-a", expectedGeneration: 2, expectedPresentationGeneration: 3, expectedRevision: 4});
  ui.finish({ok: true, recordSaved: true, thumbnailScheduleWarning: null});
  await first;
  assert.equal(ui.message.textContent, "一覧に戻しました");
  assert.equal(ui.focus.at(-1), "neighbor");
  for (const type of ["HIDE_WORLD", "RESTORE_HIDDEN_WORLD", "PURGE_HIDDEN_WORLD"]) {
    const lost = await createRecordActionHarness();
    lost.response("throw");
    if (type === "HIDE_WORLD") lost.stored.worldDispositions = [{worldId: "world-a", state: "hidden"}];
    if (type === "PURGE_HIDDEN_WORLD") {lost.stored.worlds = []; lost.stored.worldDispositions = [{worldId: "world-a", state: "purged"}];}
    await lost.run(lost.action(type));
    assert.equal(lost.calls.length, 1, type);
    assert.equal(lost.reads(), 1, `${type}: durable state is re-read exactly once, no retry`);
    assert.match(lost.message.textContent, /非表示にしました|一覧に戻しました|完全に削除しました/u);
  }
  const uncertain = await createRecordActionHarness();
  uncertain.response({ok: true});
  await uncertain.run(uncertain.action("PURGE_HIDDEN_WORLD"));
  assert.match(uncertain.message.textContent, /操作結果を確認できませんでした/u);
  assert.equal(uncertain.calls.length, 1);
  const unreadable = await createRecordActionHarness();
  unreadable.response("throw"); unreadable.failRead();
  await unreadable.run(unreadable.action("HIDE_WORLD"));
  assert.match(unreadable.message.textContent, /自動では再実行しません/u);
  assert.equal(unreadable.calls.length, 1);
});

test("committed record writes distinguish refresh and schedule failures from failed storage", async () => {
  const refreshed = await createRecordActionHarness();
  refreshed.failRefresh();
  await refreshed.run(refreshed.action("PURGE_HIDDEN_WORLD"));
  assert.equal(refreshed.message.textContent, "削除は完了しました。表示を再読み込みしてください");
  const warning = await createRecordActionHarness();
  warning.response({ok: true, recordSaved: true, thumbnailScheduleWarning: "THUMBNAIL_SCHEDULE_REPAIR_FAILED"});
  await warning.run(warning.action("HIDE_WORLD"));
  assert.match(warning.message.textContent, /非表示にしました.*画像予定の修復は保留/u);
  for (const error of ["RECORD_CHANGED", "SYNC_IN_PROGRESS", "MAINTENANCE_IN_PROGRESS", "NO_ACTIVE_PROFILE", "RECORD_UPDATE_FAILED"]) {
    const rejected = await createRecordActionHarness();
    rejected.response({ok: false, error});
    await rejected.run(rejected.action("HIDE_WORLD"));
    assert.doesNotMatch(rejected.message.textContent, /非表示にしました|一覧に戻しました|削除は完了/u);
    assert.equal(rejected.calls.length, 1);
  }
});

test("late record completions never move focus into another account, route, closed page or repository", async () => {
  for (const boundary of ["changeAccount", "navigate", "closePage", "replaceRepository"]) {
    const ui = await createRecordActionHarness();
    ui.delay();
    const pending = ui.run(ui.action("RESTORE_HIDDEN_WORLD"));
    ui[boundary]();
    ui.finish({ok: true, recordSaved: true, thumbnailScheduleWarning: null});
    await pending;
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.focus.includes("neighbor"), false, boundary);
    assert.doesNotMatch(ui.message.textContent, /一覧に戻しました/u, boundary);
  }
});

test("dialog markup, responsive controls and backup restore disclosures preserve approved safety scope", async () => {
  const [html, script, css, popup] = await Promise.all([
    readFile(new URL("../extension/dashboard.html", import.meta.url), "utf8"),
    readFile(new URL("../extension/dashboard.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/styles/dashboard.css", import.meta.url), "utf8"),
    readFile(new URL("../extension/popup.js", import.meta.url), "utf8")
  ]);
  assert.equal((html.match(/<dialog /gu) ?? []).length, 2);
  for (const name of ["hide", "purge"]) {
    assert.match(html, new RegExp(`<dialog id="${name}-record-dialog"[^>]*aria-labelledby="${name}-record-title"[^>]*aria-describedby="${name}-record-description"`, "u"));
    assert.match(html, new RegExp(`id="${name}-record-cancel"[^>]*autofocus`, "u"));
  }
  assert.ok(html.indexOf('id="hidden-records-link"') < html.indexOf('id="world-filter-panel"'));
  assert.match(script, /controls\.dialog\.showModal\(\)/u);
  assert.match(script, /addEventListener\("cancel"[\s\S]*event\.preventDefault\(\)/u);
  assert.match(script, /event\.key !== "Tab"/u);
  assert.match(script, /表示\/非表示・削除済みIDの扱いもバックアップの状態へ戻ります/u);
  assert.match(script, /preview\.sourceVersion < 3/u);
  assert.match(script, /以前に削除した名前や履歴がファイルに含まれていれば、記録へ戻ります/u);
  assert.match(script, /画像はこのJSONから復元できません。端末に残っている画像は引き続き利用します/u);
  assert.match(css, /color-scheme: light/u);
  assert.doesNotMatch(css, /brightness\(/u);
  assert.match(css, /max-height: calc\(100dvh - 32px\)/u);
  assert.match(css, /@media \(max-width: 420px\)/u);
  assert.match(popup, /status\.unreadSummary\.uncertain/u);
  assert.match(popup, /非表示の記録が/u);
  assert.doesNotMatch(popup, /HIDE_WORLD|PURGE_HIDDEN_WORLD|RESTORE_HIDDEN_WORLD/u);
});

test("record action focus chooses next, previous, then the list heading without stealing unrelated focus", async () => {
  const source = await readFile(new URL("../extension/dashboard.js", import.meta.url), "utf8");
  const create = new Function(`
    const focus = [];
    class HTMLElement {
      constructor(worldId, name, action) {this.dataset = {worldId, recordAction: action}; this.name = name; this.tagName = name === "summary" ? "SUMMARY" : "BUTTON";}
      focus() {focus.push(this.name);}
      querySelectorAll() {return this.children;}
    }
    const cards = ["a", "b"].map(worldId => {
      const card = new HTMLElement(worldId, worldId);
      card.children = [new HTMLElement(undefined, "summary"), new HTMLElement(undefined, worldId + "-restore", "RESTORE_HIDDEN_WORLD")];
      return card;
    });
    const worldList = {querySelectorAll: () => cards};
    const primaryFocusTitle = {focus() {focus.push("heading");}};
    ${dashboardFunction(source, "function restoreWorldFocus(")}
    return {restore: restoreWorldFocus, cards, focus};
  `);
  const ui = create();
  ui.restore({worldId: "removed", position: 0, action: "PURGE_HIDDEN_WORLD"});
  assert.equal(ui.focus.at(-1), "a-restore", "next card's operation is preferred over its details disclosure");
  ui.restore({worldId: "removed", position: 2, action: "PURGE_HIDDEN_WORLD"});
  assert.equal(ui.focus.at(-1), "b-restore", "the previous card is used at the end of the list");
  ui.restore({worldId: "b", position: 1, action: "summary"});
  assert.equal(ui.focus.at(-1), "summary", "passive refresh retains the original disclosure control");
  const focusCount = ui.focus.length;
  ui.restore({worldId: "removed", position: 0, action: "RESTORE_HIDDEN_WORLD"}, false);
  assert.equal(ui.focus.length, focusCount, "pending mutation redraw never falls back from its removed action");
  ui.restore({worldId: "b", position: 1, action: "summary"}, false);
  assert.equal(ui.focus.at(-1), "summary", "newer surviving summaries retain exact focus during mutation redraw");
  ui.cards.length = 0;
  ui.restore({worldId: "removed", position: 0, action: "PURGE_HIDDEN_WORLD"});
  assert.equal(ui.focus.at(-1), "heading");
});

test("late confirmation reads cannot reopen a dismissed dialog or publish an obsolete image", async () => {
  for (const boundary of ["close", "invalidate", "changeAccount", "navigate", "closePage", "replaceRepository", "newLoad", "newRender"]) {
    const ui = await createRecordActionHarness();
    ui.delayRead();
    const pending = ui.open(ui.action("HIDE_WORLD"));
    ui[boundary]();
    ui.releaseRead();
    await pending;
    assert.equal(ui.dialogs.some((/** @type {{dialog: {open: boolean}}} */ controls) => controls.dialog.open), false, boundary);
    assert.equal(ui.calls.length, 0, boundary);
    assert.equal(ui.focus.length, 0, `${boundary}: stale completion cannot steal focus`);
  }
});

test("backup export limits disclose the exact bounded reason without exposing arbitrary error text", async () => {
  const source = await readFile(new URL("../extension/dashboard.js", import.meta.url), "utf8");
  class BackupExportLimitError extends Error {
    /** @param {string} code */
    constructor(code) {super("private diagnostic must not be exposed"); this.code = code;}
  }
  const present = new Function("BackupExportLimitError", `${dashboardFunction(source, "function backupExportErrorMessage(")}; return backupExportErrorMessage;`)(BackupExportLimitError);
  assert.match(present(new BackupExportLimitError("DISPOSITIONS_LIMIT"), false), /非表示・削除済みIDが10,000件の上限を超える/u);
  assert.match(present(new BackupExportLimitError("SIZE_LIMIT"), false), /25MiBの上限を超える/u);
  assert.match(present(new BackupExportLimitError("SIZE_LIMIT"), false), /記録を自動で省略せず/u);
  assert.match(present(new BackupExportLimitError("SIZE_LIMIT"), true), /ファイルの書き出しを開始しました/u);
  assert.doesNotMatch(present(new Error("private diagnostic"), false), /private/u);
  assert.match(source, /backupMessage\.textContent = backupExportErrorMessage\(error, downloadStarted\)/u);
});

test("delayed restore preserves newer search, filter and focus-only interactions", async () => {
  for (const interaction of ["editSearch", "changeFilter", "changeGroup", "focusNewControl"]) {
    const ui = await createRecordActionHarness();
    ui.delay();
    const pending = ui.run(ui.action("RESTORE_HIDDEN_WORLD"));
    ui[interaction]("new choice");
    const view = ui.view();
    ui.finish({ok: true, recordSaved: true, thumbnailScheduleWarning: null});
    await pending;
    assert.equal(ui.message.textContent, "一覧に戻しました", `${interaction}: successful save still refreshes`);
    assert.equal(ui.focus.includes("neighbor"), false, `${interaction}: completion cannot steal focus`);
    assert.deepEqual(ui.view(), view, `${interaction}: new search/filter values survive completion`);
    assert.equal(ui.calls.length, 1);
  }
  const uninterrupted = await createRecordActionHarness();
  uninterrupted.delay();
  const pending = uninterrupted.run(uninterrupted.action("RESTORE_HIDDEN_WORLD"));
  uninterrupted.finish({ok: true, recordSaved: true, thumbnailScheduleWarning: null});
  await pending;
  assert.equal(uninterrupted.focus.at(-1), "neighbor", "normal next/previous focus still works");
});

test("restore refresh cannot steal focus when the user edits during the post-commit database read", async () => {
  const ui = await createRecordActionHarness();
  ui.delayRefresh();
  const pending = ui.run(ui.action("RESTORE_HIDDEN_WORLD"));
  await ui.whenRefreshing();
  ui.focusNewControl();
  ui.editSearch("a newer query");
  ui.finishRefresh();
  await pending;
  assert.equal(ui.message.textContent, "一覧に戻しました");
  assert.equal(ui.view().search, "a newer query");
  assert.equal(ui.focus.includes("neighbor"), false);
  const source = await readFile(new URL("../extension/dashboard.js", import.meta.url), "utf8");
  assert.match(source, /restoreWorldFocus\(focused, !recordMutationInFlight\)/u, "passive card redraw preserves exact surviving controls but leaves fallback to the guarded action owner");
});


test("thumbnail guidance exposes only actionable, plain-language reasons", () => {
  const base = {total: 8, saved: 0, remaining: 0, failed: 8, nextAttemptAt: null, state: "partial"};
  const present = (/** @type {unknown[]} */ failureReasons) => presentThumbnailProgress(normalizeThumbnailProgress({...base, failureReasons}));
  assert.match(present(["storage_full"]), /ブラウザの保存容量の上限/u);
  assert.match(present(["storage_full"]), /端末の空き容量が少ない場合.*「今すぐ確認」/u);
  assert.match(present(["network"]), /ネット接続.*「今すぐ確認」/u);
  assert.match(present(["network", "storage_full"]), /空き容量/u);
  for (const reason of ["access_denied", "not_found", "format", "decode", "resize", "image_limit", "http_error", "rate_limited", "unknown", "private text"]) {
    const message = present([reason]);
    assert.match(message, /次回の確認時に再試行/u);
    assert.doesNotMatch(message, /ログイン|削除され|private text|HTTP|decode/u);
  }
  assert.deepEqual(normalizeThumbnailProgress({...base, failureReasons: ["network", "network", "private text"]})?.failureReasons, ["network"]);
  assert.equal(normalizeThumbnailProgress(base)?.failureReasons, undefined);
});
