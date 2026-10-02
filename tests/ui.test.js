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

test("popup opens all records while notifications retain their attention or history routes", async () => {
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

test("dashboard keeps native select options readable and shows all records by default", async () => {
  const [html, css, popupHtml, popupScript, popupCss] = await Promise.all([
    readFile(new URL("../extension/dashboard.html", import.meta.url), "utf8"),
    readFile(new URL("../extension/styles/dashboard.css", import.meta.url), "utf8"),
    readFile(new URL("../extension/popup.html", import.meta.url), "utf8"),
    readFile(new URL("../extension/popup.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/styles/popup.css", import.meta.url), "utf8")
  ]);

  assert.match(html, /<option value="all" selected>すべての記録<\/option>/u);
  assert.match(html, /<button class="summary-card[^>]+data-world-filter="attention">/u);
  assert.match(html, /id="primary-focus"/u);
  assert.match(html, /保存済みの名前と画像を見る/u);
  assert.match(css, /select\s*\{\s*color-scheme:\s*light;/u);
  assert.match(
    css,
    /select option\s*\{[^}]*color:\s*#15142a;[^}]*background-color:\s*#fff;/iu
  );
  assert.match(
    css,
    /\.select-field select\s*\{[^}]*color:\s*#15142a;[^}]*background:\s*#fff;/iu
  );
  assert.ok(html.indexOf('id="primary-focus"') < html.indexOf('id="notice-panel"'));
  assert.ok(popupHtml.indexOf('id="attention-card"') < popupHtml.indexOf('class="status-card"'));
  assert.ok(popupHtml.indexOf('id="dashboard-button"') < popupHtml.indexOf('id="sync-button"'));
  assert.match(popupScript, /attentionCard\.classList\.toggle\("is-alert", hasAttention\)/u);
  assert.match(popupScript, /presentation\.tone === "attention"/u);
  assert.match(popupCss, /\.attention-card\.is-alert/u);
});

test("dashboard keeps JSON backup compatibility and adds one image ZIP action", async () => {
  const [html, source] = await Promise.all([
    readFile(new URL("../extension/dashboard.html", import.meta.url), "utf8"),
    readFile(new URL("../extension/dashboard.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="export-button"/u);
  assert.match(html, /id="export-images-button"/u);
  assert.match(html, /accept="application\/json,application\/zip,\.json,\.zip"/u);
  assert.match(source, /createBackup\(/u);
  assert.match(source, /createImageBackup\(/u);
  assert.match(source, /restoreBackup\(/u);
  assert.match(source, /restoreImageBackup\(/u);
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
  const importHandler = dashboard.indexOf('importInput.addEventListener("change"');
  const confirmRestore = dashboard.indexOf("globalThis.confirm", importHandler);
  assert.ok(dashboard.indexOf("file.size > MAX_BACKUP_BYTES", importHandler) < dashboard.indexOf("await file.text()", importHandler));
  assert.ok(dashboard.indexOf("file.size > MAX_IMAGE_BACKUP_BYTES", importHandler) < dashboard.indexOf("await file.arrayBuffer()", importHandler));
  assert.ok(dashboard.indexOf("parseBackup(jsonText)", importHandler) < confirmRestore);
  assert.ok(dashboard.indexOf("parseImageBackup(imageArchiveBytes)", importHandler) < confirmRestore);
  const restoreStatusCheck = dashboard.indexOf('type: "GET_STATUS"', importHandler);
  assert.ok(dashboard.indexOf("parseBackup(jsonText)", importHandler) < restoreStatusCheck);
  assert.ok(restoreStatusCheck < dashboard.indexOf("globalThis.confirm"));
  assert.ok(confirmRestore < dashboard.indexOf("await restoreBackup", importHandler));
  assert.ok(confirmRestore < dashboard.indexOf("await restoreImageBackup", importHandler));
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
    /importInput\.disabled = repository === null \|\| state\.status\.syncing \|\| exporting \|\| restoring/u
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
    `${functionSource}; return hydrateWorldThumbnails;`
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

test("dashboard routes show all records by default and preserve explicit attention links", async () => {
  const source = await readFile(new URL("../extension/dashboard.js", import.meta.url), "utf8");
  const start = source.indexOf("function applyInitialRouteFilters(");
  const end = source.indexOf("\n}\n", start) + 2;
  const worldFilter = { value: "" };
  const eventFilter = { value: "" };
  const applyRoute = new Function("worldFilter", "eventFilter", `${source.slice(start, end)}; return applyInitialRouteFilters;`)(worldFilter, eventFilter);
  for (const hash of ["", "#all", "#worlds", "#unexpected"]) {
    applyRoute(hash);
    assert.equal(worldFilter.value, "all");
  }
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
    `let pageClosed = false, restoring = false, purging = false, progressPolling = false, progressEpoch = 0;
     let repository = {}, thumbnailRenderGeneration = 1;
     const document = {hidden: false}, worldList = { querySelectorAll: () => [] }, settingsThumbnailCount = {};
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
    listWorlds: async () => worlds,
    listEvents: async () => events,
    listFavoriteGroups: async () => [],
    getSetting: async () => null
  };
  let rendered = 0;
  let warned = false;
  const load = new Function("state", "database", "normalizeStatusResponse", "readThumbnailCount", "renderAll", "renderThumbnailProgressNotice", `
    let progressEpoch = 0, thumbnailRenderGeneration = 0, visibleWorldCount = 0, visibleEventCount = 0;
    const PAGE_SIZE = 200;
    const requireRepository = () => database;
    const sendMessage = async () => ({activeProfileId: "user-a"});
    const isRecord = value => typeof value === "object" && value !== null;
    const selectProfile = async () => ({userId: "user-a", lastSuccessfulSyncAt: null});
    const readStorageEstimate = async () => ({usage: 0, quota: 0});
    const dateSetting = () => null;
    const summarizeHistory = () => ({attention: 0, missing: 0, unavailable: 0});
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
    const statusDot = {}, statusTitle = {}, statusDetail = {}, lastSync = {};
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
