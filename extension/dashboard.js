// @ts-check

import { MAX_BACKUP_BYTES, backupSummary, createBackup, parseBackup, restoreBackup } from "./lib/backup.js";
import { openDatabase } from "./lib/database.js";
import {
  commandErrorMessage,
  eventDetail,
  favoriteGroupLabels,
  filterEvents,
  filterWorlds,
  formatDateTime,
  isRecord,
  normalizeCommandResponse,
  normalizePurgeResponse,
  normalizeStatusResponse,
  presentEventKind,
  presentStatus,
  purgeErrorMessage,
  summarizeHistory,
  takeVisibleItems,
  worldStateTags
} from "./lib/ui.js";

/** @typedef {import("./lib/database.js").DatabaseRepository} DatabaseRepository */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listProfiles"]>>[number]} ProfileRecord */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listWorlds"]>>[number]} WorldRecord */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listEvents"]>>[number]} HistoryEvent */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listFavoriteGroups"]>>[number]} FavoriteGroupRecord */
/** @typedef {import("./lib/ui.js").UiStatus} UiStatus */

const PAGE_SIZE = 200;
const STORAGE_WARNING_BYTES = 20 * 1024 * 1024;
const WORLD_WARNING_COUNT = 8_000;
const EVENT_WARNING_COUNT = 80_000;
const SETTINGS_SCHEDULE_WARNING = "SCHEDULE_REPAIR_FAILED";
const SETTINGS_UPDATE_OUTCOMES = Object.freeze({
  success: "success",
  scheduleRepairFailed: "schedule_repair_failed",
  unknownWarning: "unknown_warning",
  unconfirmed: "unconfirmed"
});
const VALID_TABS = new Set(["worlds", "events", "settings"]);
const VALID_FILTERS = new Set(["all", "favorite", "missing", "unavailable", "pending"]);
const VALID_EVENT_FILTERS = new Set(["all", "renamed", "group", "missing", "unavailable", "restored"]);

const connectionBadge = requiredElement("connection-badge");
const noticePanel = requiredElement("notice-panel");
const noticeTitle = requiredElement("notice-title");
const noticeDetail = requiredElement("notice-detail");
const noticeActionButton = /** @type {HTMLButtonElement} */ (requiredElement("notice-action"));
const onboarding = requiredElement("onboarding");
const openVrchatButton = /** @type {HTMLButtonElement} */ (requiredElement("open-vrchat-button"));
const syncNowButton = /** @type {HTMLButtonElement} */ (requiredElement("sync-now-button"));
const worldSearch = /** @type {HTMLInputElement} */ (requiredElement("world-search"));
const worldFilter = /** @type {HTMLSelectElement} */ (requiredElement("world-filter"));
const groupFilter = /** @type {HTMLSelectElement} */ (requiredElement("group-filter"));
const worldResultCount = requiredElement("world-result-count");
const worldList = requiredElement("world-list");
const worldEmpty = requiredElement("world-empty");
const eventList = requiredElement("event-list");
const eventEmpty = requiredElement("event-empty");
const eventFilter = /** @type {HTMLSelectElement} */ (requiredElement("event-filter"));
const eventResultCount = requiredElement("event-result-count");
const autoSyncToggle = /** @type {HTMLInputElement} */ (requiredElement("auto-sync-toggle"));
const notificationToggle = /** @type {HTMLInputElement} */ (requiredElement("notification-toggle"));
const settingsLastSync = requiredElement("settings-last-sync");
const settingsNextSync = requiredElement("settings-next-sync");
const settingsPendingProbes = requiredElement("settings-pending-probes");
const settingsUnreadEvents = requiredElement("settings-unread-events");
const settingsWorldCount = requiredElement("settings-world-count");
const settingsEventCount = requiredElement("settings-event-count");
const settingsGroupCount = requiredElement("settings-group-count");
const settingsStorageUsage = requiredElement("settings-storage-usage");
const settingsLastBackup = requiredElement("settings-last-backup");
const storageWarning = requiredElement("storage-warning");
const exportButton = /** @type {HTMLButtonElement} */ (requiredElement("export-button"));
const importInput = /** @type {HTMLInputElement} */ (requiredElement("import-input"));
const backupMessage = requiredElement("backup-message");
const purgeUninstallButton = /** @type {HTMLButtonElement} */ (requiredElement("purge-uninstall-button"));
const purgeMessage = requiredElement("purge-message");
const summaryTotal = requiredElement("summary-total");
const summaryUnavailable = requiredElement("summary-unavailable");
const summaryMissing = requiredElement("summary-missing");
const summaryRenamed = requiredElement("summary-renamed");
const historyUnreadBadge = requiredElement("history-unread-badge");
const tabButtons = Array.from(document.querySelectorAll(".tab"));

/** @type {DatabaseRepository | null} */
let repository = null;
/** @type {(() => void | Promise<void>) | null} */
let noticeAction = null;
let visibleWorldCount = PAGE_SIZE;
let visibleEventCount = PAGE_SIZE;
let restoring = false;
let markingHistoryRead = false;
let purging = false;

const state = {
  /** @type {ProfileRecord | null} */
  profile: null,
  /** @type {WorldRecord[]} */
  worlds: [],
  /** @type {HistoryEvent[]} */
  events: [],
  /** @type {FavoriteGroupRecord[]} */
  favoriteGroups: [],
  /** @type {UiStatus} */
  status: normalizeStatusResponse({}),
  statusAvailable: true,
  settings: {
    autoSyncEnabled: true,
    notificationsEnabled: true,
    /** @type {string | null} */
    lastBackupAt: null
  },
  /** @type {{ usage: number | null, quota: number | null }} */
  storageEstimate: { usage: null, quota: null }
};

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function requiredElement(id) {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing required extension element: ${id}`);
  }
  return element;
}

/**
 * @returns {DatabaseRepository}
 */
function requireRepository() {
  if (repository === null) {
    throw new Error("Local history database is unavailable");
  }
  return repository;
}

/**
 * @param {Record<string, unknown>} message
 * @returns {Promise<unknown>}
 */
async function sendMessage(message) {
  return /** @type {unknown} */ (await chrome.runtime.sendMessage(message));
}

/**
 * @param {string} tagName
 * @param {string} className
 * @param {string} text
 * @returns {HTMLElement}
 */
function textElement(tagName, className, text) {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  return element;
}

/**
 * @param {string} title
 * @param {string} detail
 * @param {{ label: string, run: () => void | Promise<void> } | null} [action]
 */
function showNotice(title, detail, action = null) {
  noticeTitle.textContent = title;
  noticeDetail.textContent = detail;
  noticePanel.hidden = false;
  noticeAction = action?.run ?? null;
  noticeActionButton.hidden = action === null;
  noticeActionButton.textContent = action?.label ?? "";
}

function hideNotice() {
  noticePanel.hidden = true;
  noticeActionButton.hidden = true;
  noticeAction = null;
}

noticeActionButton.addEventListener("click", async () => {
  if (noticeAction === null) {
    return;
  }
  noticeActionButton.disabled = true;
  try {
    await noticeAction();
  } catch {
    showNotice(
      "操作を完了できませんでした",
      "少し時間をあけて、もう一度お試しください。保存済みの記録はそのままです。"
    );
  } finally {
    noticeActionButton.disabled = false;
  }
});

/**
 * @param {string | null} preferredUserId
 * @returns {Promise<ProfileRecord | null>}
 */
async function selectProfile(preferredUserId) {
  const database = requireRepository();
  const profiles = await database.listProfiles();
  if (profiles.length === 0) {
    return null;
  }
  const storedUserId = await database.getSetting("activeProfileId");
  const candidates = [preferredUserId, typeof storedUserId === "string" ? storedUserId : null];
  for (const userId of candidates) {
    if (userId === null) {
      continue;
    }
    const matching = profiles.find((profile) => profile.userId === userId);
    if (matching !== undefined) {
      return matching;
    }
  }
  return [...profiles].sort((left, right) => {
    const leftTime = left.lastSuccessfulSyncAt ?? left.firstSeenAt;
    const rightTime = right.lastSuccessfulSyncAt ?? right.firstSeenAt;
    return rightTime.localeCompare(leftTime);
  })[0] ?? null;
}

/**
 * @param {string | null} [preferredUserId]
 */
async function loadData(preferredUserId = null) {
  const database = requireRepository();
  let runtimeStatus = normalizeStatusResponse({});
  state.statusAvailable = true;
  try {
    const response = await sendMessage({ type: "GET_STATUS" });
    if (isRecord(response) && response.ok === false) {
      throw new Error("Status request failed");
    }
    runtimeStatus = normalizeStatusResponse(response);
  } catch {
    state.statusAvailable = false;
  }

  state.profile = await selectProfile(preferredUserId ?? runtimeStatus.activeProfileId);
  if (state.profile === null) {
    state.worlds = [];
    state.events = [];
    state.favoriteGroups = [];
  } else {
    [state.worlds, state.events, state.favoriteGroups] = await Promise.all([
      database.listWorlds(state.profile.userId),
      database.listEvents(state.profile.userId),
      database.listFavoriteGroups(state.profile.userId)
    ]);
  }

  const [autoSyncEnabled, notificationsEnabled, storedNextSyncAt, lastBackupAt, storageEstimate] = await Promise.all([
    database.getSetting("autoSyncEnabled"),
    database.getSetting("notificationsEnabled"),
    database.getSetting("nextSyncAt"),
    database.getSetting("lastBackupAt"),
    readStorageEstimate()
  ]);
  state.settings.autoSyncEnabled = autoSyncEnabled !== false;
  state.settings.notificationsEnabled = notificationsEnabled !== false;
  state.settings.lastBackupAt = dateSetting(lastBackupAt);
  state.storageEstimate = storageEstimate;
  state.status = {
    ...runtimeStatus,
    activeProfileId: state.profile?.userId ?? runtimeStatus.activeProfileId,
    lastSuccessfulSyncAt:
      state.profile?.lastSuccessfulSyncAt ?? runtimeStatus.lastSuccessfulSyncAt,
    nextSyncAt: runtimeStatus.nextSyncAt ?? dateSetting(storedNextSyncAt),
    worldCount: state.worlds.length,
    eventCount: state.events.length
  };
  visibleWorldCount = PAGE_SIZE;
  visibleEventCount = PAGE_SIZE;
  renderAll();
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function dateSetting(value) {
  if (typeof value === "string" && Number.isFinite(new Date(value).getTime())) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(new Date(value).getTime())) {
    return new Date(value).toISOString();
  }
  return null;
}

/**
 * Accept a settings update only when the raw background response explicitly
 * confirms both the command and its durable DB write. Warning values are a
 * closed contract so a future or malformed value cannot be mistaken for full
 * success.
 *
 * @param {unknown} rawResponse
 * @returns {typeof SETTINGS_UPDATE_OUTCOMES[keyof typeof SETTINGS_UPDATE_OUTCOMES]}
 */
function classifySettingsUpdateResponse(rawResponse) {
  if (
    !isRecord(rawResponse)
    || rawResponse.ok !== true
    || rawResponse.settingsSaved !== true
  ) {
    return SETTINGS_UPDATE_OUTCOMES.unconfirmed;
  }
  if (rawResponse.scheduleWarning === null) {
    return SETTINGS_UPDATE_OUTCOMES.success;
  }
  if (rawResponse.scheduleWarning === SETTINGS_SCHEDULE_WARNING) {
    return SETTINGS_UPDATE_OUTCOMES.scheduleRepairFailed;
  }
  return SETTINGS_UPDATE_OUTCOMES.unknownWarning;
}

/**
 * Browser storage estimates are advisory and may be unavailable. Unknown or
 * non-finite fields remain null instead of being presented as zero usage.
 *
 * @returns {Promise<{ usage: number | null, quota: number | null }>}
 */
async function readStorageEstimate() {
  try {
    const estimate = await navigator.storage.estimate();
    return {
      usage: typeof estimate.usage === "number" && Number.isFinite(estimate.usage)
        ? Math.max(0, estimate.usage)
        : null,
      quota: typeof estimate.quota === "number" && Number.isFinite(estimate.quota)
        ? Math.max(0, estimate.quota)
        : null
    };
  } catch {
    return { usage: null, quota: null };
  }
}

/**
 * @param {number | null} bytes
 * @returns {string}
 */
function formatStorageUsage(bytes) {
  if (bytes === null) {
    return "確認できません";
  }
  if (bytes < 1024) {
    return `${Math.round(bytes).toLocaleString("ja-JP")} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toLocaleString("ja-JP", { maximumFractionDigits: 1 })} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toLocaleString("ja-JP", { maximumFractionDigits: 1 })} MiB`;
}

function renderAll() {
  renderConnection();
  renderSummary();
  renderGroupFilter();
  renderWorlds();
  renderEvents();
  renderSettings();
  onboarding.hidden = state.profile !== null && state.status.lastSuccessfulSyncAt !== null;
}

function renderConnection() {
  const presentation = presentStatus(state.status);
  connectionBadge.className = "badge";
  if (presentation.tone === "ready" || presentation.tone === "working") {
    connectionBadge.classList.add("is-ready");
  } else if (presentation.tone === "error") {
    connectionBadge.classList.add("is-error");
  }
  connectionBadge.textContent = presentation.title;
  syncNowButton.disabled = state.status.syncing || restoring || purging;
  syncNowButton.textContent = purging
    ? "削除しています…"
    : restoring
    ? "復元しています…"
    : state.status.syncing
      ? "確認しています…"
      : "今すぐ確認";

  if (!state.statusAvailable) {
    showNotice(
      "同期状態を読み込めませんでした",
      "ローカルの記録は表示できます。拡張を開き直して、もう一度お試しください。"
    );
    return;
  }
  if (state.status.authRequired) {
    showNotice(
      "VRChatへのログインが必要です",
      "公式サイトでいつも通りログインしてから「今すぐ確認」を押してください。パスワードや2FAコードをこの拡張へ入力する必要はありません。",
      { label: "VRChat公式サイト", run: openVrchat }
    );
    return;
  }
  if (presentation.tone === "error") {
    showNotice(
      presentation.title,
      presentation.detail,
      state.status.lastResult === "rate_limited"
        ? null
        : { label: "もう一度確認", run: performSync }
    );
    return;
  }
  if (state.status.favoriteGroupStatus === "stale") {
    showNotice(
      "お気に入りリスト名を今回は更新できませんでした",
      "ワールドの記録は正常に更新済みです。リスト名は前回確認できた名前を表示しています。"
    );
    return;
  }
  hideNotice();
}

function renderSummary() {
  const summary = summarizeHistory(state.worlds, state.events);
  summaryTotal.textContent = summary.total.toLocaleString("ja-JP");
  summaryUnavailable.textContent = summary.unavailable.toLocaleString("ja-JP");
  summaryMissing.textContent = summary.missing.toLocaleString("ja-JP");
  summaryRenamed.textContent = summary.renamed.toLocaleString("ja-JP");
  historyUnreadBadge.hidden = state.status.unreadCount === 0;
  historyUnreadBadge.textContent = state.status.unreadCount > 99
    ? "99+"
    : state.status.unreadCount.toLocaleString("ja-JP");
}

function renderGroupFilter() {
  const selected = groupFilter.value;
  const recordedTags = new Set(state.worlds.flatMap((world) => world.favoriteTags));
  const worldGroups = state.favoriteGroups.filter(
    (group) => group.type === "world" || group.type === "vrcPlusWorld"
  );
  const knownInternalNames = new Set(worldGroups.map((group) => group.internalName));
  const groups = [...knownInternalNames]
    .map((internalName) => ({
      internalName,
      displayName: favoriteGroupLabels([internalName], worldGroups)[0] ?? internalName,
      active: worldGroups.some((group) => group.internalName === internalName && group.active)
    }))
    .sort((left, right) => {
      if (left.active !== right.active) {
        return left.active ? -1 : 1;
      }
      const byName = left.displayName.localeCompare(right.displayName, "ja-JP", {
        sensitivity: "base"
      });
      return byName === 0 ? left.internalName.localeCompare(right.internalName) : byName;
    });
  /** @type {Map<string, number>} */
  const displayNameCounts = new Map();
  for (const group of groups) {
    displayNameCounts.set(group.displayName, (displayNameCounts.get(group.displayName) ?? 0) + 1);
  }

  groupFilter.replaceChildren();
  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = "すべてのリスト";
  groupFilter.append(allOption);

  for (const group of groups) {
    const option = document.createElement("option");
    option.value = group.internalName;
    const duplicateSuffix = (displayNameCounts.get(group.displayName) ?? 0) > 1
      ? `（${group.internalName}）`
      : "";
    const inactiveSuffix = group.active ? "" : "（以前のリスト）";
    option.textContent = `${group.displayName}${duplicateSuffix}${inactiveSuffix}`;
    groupFilter.append(option);
  }
  for (const internalName of [...recordedTags].sort((left, right) => left.localeCompare(right))) {
    if (knownInternalNames.has(internalName)) {
      continue;
    }
    const option = document.createElement("option");
    option.value = internalName;
    option.textContent = favoriteGroupLabels([internalName], [])[0]
      ?? `お気に入りリスト（${internalName}）`;
    groupFilter.append(option);
  }
  groupFilter.value = [...groupFilter.options].some((option) => option.value === selected)
    ? selected
    : "";
}

function renderWorlds() {
  const requestedFilter = worldFilter.value;
  const filter = VALID_FILTERS.has(requestedFilter)
    ? /** @type {"all" | "favorite" | "missing" | "unavailable" | "pending"} */ (requestedFilter)
    : "all";
  const matching = filterWorlds(
    state.worlds,
    state.events,
    worldSearch.value,
    filter,
    groupFilter.value,
    state.favoriteGroups
  );
  const visible = takeVisibleItems(matching, visibleWorldCount);
  /** @type {Map<string, Set<string>>} */
  const previousNamesByWorld = new Map();
  for (const event of state.events) {
    if (event.kind !== "name_changed") {
      continue;
    }
    const names = previousNamesByWorld.get(event.worldId) ?? new Set();
    names.add(event.before);
    previousNamesByWorld.set(event.worldId, names);
  }
  worldList.replaceChildren();
  for (const world of visible) {
    worldList.append(
      createWorldCard(
        world,
        [...(previousNamesByWorld.get(world.worldId) ?? [])],
        favoriteGroupLabels(world.favoriteTags, state.favoriteGroups)
      )
    );
  }
  if (visible.length < matching.length) {
    const moreButton = /** @type {HTMLButtonElement} */ (
      textElement(
        "button",
        "button button-secondary",
        `さらに表示（残り${(matching.length - visible.length).toLocaleString("ja-JP")}件）`
      )
    );
    moreButton.type = "button";
    moreButton.addEventListener("click", () => {
      visibleWorldCount += PAGE_SIZE;
      renderWorlds();
    });
    worldList.append(moreButton);
  }
  worldResultCount.textContent = `${matching.length.toLocaleString("ja-JP")}件中 ${visible.length.toLocaleString("ja-JP")}件を表示`;
  worldEmpty.hidden = matching.length !== 0;
}

/**
 * @param {WorldRecord} world
 * @param {readonly string[]} recordedPreviousNames
 * @param {readonly string[]} favoriteGroupNames
 * @returns {HTMLElement}
 */
function createWorldCard(world, recordedPreviousNames, favoriteGroupNames) {
  const card = textElement("article", "world-card", "");
  const content = document.createElement("div");
  content.append(
    textElement("h3", "", world.currentName ?? "名前を確認できないワールド"),
    textElement(
      "p",
      "world-meta",
      `${world.authorName ?? "作者名を確認できません"} · 最終更新 ${formatDateTime(world.updatedAt)}`
    ),
    textElement("p", "world-meta", world.worldId)
  );
  const previousNames = recordedPreviousNames
    .filter((name, index, names) => name !== world.currentName && names.indexOf(name) === index)
    .slice(0, 3);
  if (previousNames.length > 0) {
    content.append(textElement("p", "world-meta", `以前の名前: ${previousNames.join(" / ")}`));
  }
  if (favoriteGroupNames.length > 0) {
    const prefix = world.membershipState === "favorited"
      ? "お気に入りリスト"
      : "最後に確認したリスト";
    content.append(
      textElement("p", "world-meta world-group-meta", `${prefix}: ${favoriteGroupNames.join(" / ")}`)
    );
  }

  const tags = document.createElement("div");
  tags.className = "state-tags";
  for (const stateTag of worldStateTags(world)) {
    const tag = textElement("span", "state-tag", stateTag.label);
    if (stateTag.tone === "warning") {
      tag.classList.add("is-warning");
    } else if (stateTag.tone === "pending") {
      tag.classList.add("is-pending");
    }
    tags.append(tag);
  }
  card.append(content, tags);
  return card;
}

function renderEvents() {
  const requestedFilter = eventFilter.value;
  const filter = VALID_EVENT_FILTERS.has(requestedFilter)
    ? /** @type {"all" | "renamed" | "group" | "missing" | "unavailable" | "restored"} */ (requestedFilter)
    : "all";
  const matching = filterEvents(state.events, filter);
  const visible = takeVisibleItems(matching, visibleEventCount);
  const worlds = new Map(state.worlds.map((world) => [world.worldId, world]));
  /** @type {Map<string, HistoryEvent[]>} */
  const histories = new Map();
  for (const historyEvent of state.events) {
    const history = histories.get(historyEvent.worldId) ?? [];
    history.push(historyEvent);
    histories.set(historyEvent.worldId, history);
  }
  eventList.replaceChildren();
  for (const event of visible) {
    eventList.append(createEventCard(event, worlds.get(event.worldId), histories.get(event.worldId) ?? []));
  }
  if (visible.length < matching.length) {
    const moreButton = /** @type {HTMLButtonElement} */ (
      textElement(
        "button",
        "button button-secondary",
        `さらに表示（残り${(matching.length - visible.length).toLocaleString("ja-JP")}件）`
      )
    );
    moreButton.type = "button";
    moreButton.addEventListener("click", () => {
      visibleEventCount += PAGE_SIZE;
      renderEvents();
    });
    eventList.append(moreButton);
  }
  eventResultCount.textContent = `${matching.length.toLocaleString("ja-JP")}件中 ${visible.length.toLocaleString("ja-JP")}件を表示`;
  eventEmpty.hidden = matching.length !== 0;
}

/**
 * @param {HistoryEvent} event
 * @param {WorldRecord | undefined} world
 * @param {readonly HistoryEvent[]} history
 * @returns {HTMLElement}
 */
function createEventCard(event, world, history) {
  const presentation = presentEventKind(event.kind);
  const card = textElement("article", "event-card", "");
  const content = document.createElement("div");
  const worldName =
    world?.currentName ?? (event.kind === "name_changed" ? event.after : event.worldId);
  content.append(
    textElement("h3", "", `${presentation.title} · ${worldName}`),
    textElement("p", "event-detail", eventDetail(event, world, state.favoriteGroups)),
    textElement("p", "event-detail", `${formatDateTime(event.observedAt)} · ${event.worldId}`)
  );
  const details = document.createElement("details");
  details.className = "event-detail";
  const summary = document.createElement("summary");
  summary.textContent = "名称・状態履歴と判断根拠";
  details.append(summary);
  details.addEventListener("toggle", () => {
    if (!details.open || details.dataset.loaded === "true") {
      return;
    }
    appendEventEvidence(details, event, history);
    details.dataset.loaded = "true";
  });
  content.append(details);
  const tags = document.createElement("div");
  tags.className = "state-tags";
  const tag = textElement("span", "state-tag", presentation.tag);
  if (
    event.kind === "favorite_missing_confirmed" ||
    event.kind === "access_unavailable_confirmed"
  ) {
    tag.classList.add("is-warning");
  }
  tags.append(tag);
  card.append(content, tags);
  return card;
}

/**
 * @param {HTMLDetailsElement} details
 * @param {HistoryEvent} event
 * @param {readonly HistoryEvent[]} history
 */
function appendEventEvidence(details, event, history) {
  const evidenceHeading = textElement("strong", "", "この変化の判断根拠");
  const evidenceStatus =
    event.evidence.httpStatus === null
      ? "HTTPステータスなし（一括一覧との比較）"
      : event.evidence.httpStatus === 404
        ? "HTTP 404（見つからない）"
        : "HTTP 200（取得成功）";
  details.append(
    evidenceHeading,
    textElement(
      "p",
      "event-detail",
      `${evidenceLabel(event)} / ${evidenceStatus} / 確認時刻 ${formatDateTime(event.observedAt)}`
    )
  );

  const nameChanges = history
    .filter((candidate) => candidate.kind === "name_changed")
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
  details.append(textElement("strong", "", "名称履歴"));
  if (nameChanges.length === 0) {
    details.append(textElement("p", "event-detail", "記録後の名称変更はありません。"));
  } else {
    for (const nameEvent of nameChanges.slice(-50)) {
      details.append(
        textElement(
          "p",
          "event-detail",
          `${formatDateTime(nameEvent.observedAt)}: 「${nameEvent.before}」→「${nameEvent.after}」`
        )
      );
    }
    if (nameChanges.length > 50) {
      details.append(
        textElement(
          "p",
          "event-detail",
          "直近50件の名称変更を表示しています。全履歴はバックアップへ保存されています。"
        )
      );
    }
  }

  details.append(textElement("strong", "", "状態履歴"));
  const orderedHistory = [...history]
    .filter((historyEvent) => historyEvent.kind !== "name_changed")
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
    .slice(0, 50);
  if (orderedHistory.length === 0) {
    details.append(textElement("p", "event-detail", "記録後の状態変更はありません。"));
  } else {
    for (const historyEvent of orderedHistory) {
      details.append(
        textElement(
          "p",
          "event-detail",
          `${formatDateTime(historyEvent.observedAt)}: ${presentEventKind(historyEvent.kind).title}`
        )
      );
    }
  }
  const stateHistoryCount = history.filter(
    (historyEvent) => historyEvent.kind !== "name_changed"
  ).length;
  if (stateHistoryCount > orderedHistory.length) {
    details.append(
      textElement(
        "p",
        "event-detail",
        `直近${orderedHistory.length.toLocaleString("ja-JP")}件を表示しています。全履歴はバックアップへ保存されています。`
      )
    );
  }
}

/**
 * @param {HistoryEvent} event
 * @returns {string}
 */
function evidenceLabel(event) {
  if (event.kind === "favorite_group_changed") {
    return "お気に入りリストの確認結果";
  }
  if (event.evidence.source === "bulk") {
    return "お気に入り一覧の確認結果";
  }
  return event.evidence.httpStatus === 404
    ? "個別確認の結果（見つかりません）"
    : "個別確認の結果";
}

function renderSettings() {
  autoSyncToggle.checked = state.settings.autoSyncEnabled;
  notificationToggle.checked = state.settings.notificationsEnabled;
  settingsLastSync.textContent = formatDateTime(state.status.lastSuccessfulSyncAt);
  settingsNextSync.textContent = state.settings.autoSyncEnabled
    ? formatDateTime(state.status.nextSyncAt)
    : "自動確認はオフです";
  settingsPendingProbes.textContent = `${state.status.pendingProbeCount.toLocaleString("ja-JP")}件`;
  settingsUnreadEvents.textContent = `${state.status.unreadCount.toLocaleString("ja-JP")}件`;
  settingsWorldCount.textContent = `${state.worlds.length.toLocaleString("ja-JP")}件`;
  settingsEventCount.textContent = `${state.events.length.toLocaleString("ja-JP")}件`;
  settingsGroupCount.textContent = `${state.favoriteGroups.length.toLocaleString("ja-JP")}件`;
  settingsStorageUsage.textContent = formatStorageUsage(state.storageEstimate.usage);
  settingsLastBackup.textContent = state.settings.lastBackupAt === null
    ? "まだありません"
    : formatDateTime(state.settings.lastBackupAt);

  const warnings = [];
  if (state.worlds.length >= WORLD_WARNING_COUNT) {
    warnings.push("ワールド記録が8,000件以上あります。");
  }
  if (state.events.length >= EVENT_WARNING_COUNT) {
    warnings.push("変更履歴が80,000件以上あります。");
  }
  if (
    state.storageEstimate.usage !== null
    && state.storageEstimate.usage >= STORAGE_WARNING_BYTES
  ) {
    warnings.push("概算使用量が20MiB以上あります。");
  }
  storageWarning.hidden = warnings.length === 0;
  storageWarning.textContent = warnings.length === 0
    ? ""
    : `${warnings.join(" ")} 大切な記録をバックアップしてください。`;

  const hasProfile = state.profile !== null;
  exportButton.disabled = !hasProfile || restoring || purging;
  importInput.disabled = repository === null || state.status.syncing || restoring || purging;
  autoSyncToggle.disabled = restoring || purging;
  notificationToggle.disabled = restoring || purging;
  purgeUninstallButton.disabled = repository === null || state.status.syncing || restoring || purging;
}

/**
 * @param {string} tabName
 * @param {boolean} [moveFocus]
 */
function activateTab(tabName, moveFocus = false) {
  if (!VALID_TABS.has(tabName)) {
    return;
  }
  for (const candidate of tabButtons) {
    if (!(candidate instanceof HTMLButtonElement)) {
      continue;
    }
    const active = candidate.dataset.tab === tabName;
    candidate.classList.toggle("is-active", active);
    candidate.setAttribute("aria-selected", String(active));
    candidate.tabIndex = active ? 0 : -1;
    if (active && moveFocus) {
      candidate.focus();
    }
  }
  for (const name of VALID_TABS) {
    const panel = requiredElement(`${name}-panel`);
    panel.hidden = name !== tabName;
  }
}

/**
 * Interpret only known local tab routes. Unknown or malformed hashes always
 * fall back to the normal worlds view.
 *
 * @param {string} hash
 * @returns {string}
 */
function initialTabFromHash(hash) {
  const tabName = hash.startsWith("#") ? hash.slice(1) : "";
  return VALID_TABS.has(tabName) ? tabName : "worlds";
}

async function markHistoryAsRead() {
  if (markingHistoryRead || repository === null) {
    return;
  }
  markingHistoryRead = true;
  let markFailed;
  try {
    const response = normalizeCommandResponse(await sendMessage({ type: "MARK_HISTORY_READ" }));
    markFailed = !response.ok;
  } catch {
    markFailed = true;
  }
  try {
    await loadData();
  } catch {
    markFailed = true;
  } finally {
    markingHistoryRead = false;
  }
  if (markFailed) {
    showNotice(
      "未読状態を更新できませんでした",
      "履歴はそのまま確認できます。画面を開き直して、もう一度お試しください。"
    );
  }
}

for (const [index, candidate] of tabButtons.entries()) {
  if (!(candidate instanceof HTMLButtonElement)) {
    continue;
  }
  const tabName = candidate.dataset.tab;
  if (tabName === undefined || !VALID_TABS.has(tabName)) {
    continue;
  }
  candidate.id = `${tabName}-tab`;
  candidate.setAttribute("role", "tab");
  candidate.setAttribute("aria-controls", `${tabName}-panel`);
  candidate.addEventListener("click", () => {
    activateTab(tabName);
    if (tabName === "events") {
      void markHistoryAsRead();
    }
  });
  candidate.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (index + offset + tabButtons.length) % tabButtons.length;
    const nextTab = tabButtons[nextIndex];
    if (nextTab instanceof HTMLButtonElement && nextTab.dataset.tab !== undefined) {
      activateTab(nextTab.dataset.tab, true);
      if (nextTab.dataset.tab === "events") {
        void markHistoryAsRead();
      }
    }
  });
  const panel = requiredElement(`${tabName}-panel`);
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", candidate.id);
}
document.querySelector(".tabs")?.setAttribute("role", "tablist");
const initialTab = initialTabFromHash(window.location.hash);
activateTab(initialTab);

worldSearch.addEventListener("input", () => {
  visibleWorldCount = PAGE_SIZE;
  renderWorlds();
});
worldFilter.addEventListener("change", () => {
  visibleWorldCount = PAGE_SIZE;
  renderWorlds();
});
groupFilter.addEventListener("change", () => {
  visibleWorldCount = PAGE_SIZE;
  renderWorlds();
});
eventFilter.addEventListener("change", () => {
  visibleEventCount = PAGE_SIZE;
  renderEvents();
});

async function openVrchat() {
  const response = normalizeCommandResponse(await sendMessage({ type: "OPEN_VRCHAT" }));
  if (!response.ok) {
    showNotice("VRChat公式サイトを開けませんでした", commandErrorMessage(response.error, response.retryAt));
  }
}

openVrchatButton.addEventListener("click", async () => {
  openVrchatButton.disabled = true;
  try {
    await openVrchat();
  } catch {
    showNotice(
      "VRChat公式サイトを開けませんでした",
      "少し時間をあけて、もう一度お試しください。"
    );
  } finally {
    openVrchatButton.disabled = false;
  }
});

async function performSync() {
  if (restoring) {
    showNotice(
      "バックアップを復元しています",
      "復元が終わってから、もう一度「今すぐ確認」を押してください。"
    );
    return;
  }
  state.status = { ...state.status, syncing: true };
  renderConnection();
  try {
    const response = normalizeCommandResponse(
      await sendMessage({ type: "START_SYNC", trigger: "manual" })
    );
    if (!response.ok) {
      state.status = { ...state.status, syncing: false };
      renderConnection();
      showNotice("確認を開始できませんでした", commandErrorMessage(response.error, response.retryAt));
      return;
    }
    await loadData();
  } catch {
    state.status = { ...state.status, syncing: false };
    renderConnection();
    showNotice(
      "確認を開始できませんでした",
      "拡張を開き直して、もう一度お試しください。保存済みの記録はそのままです。"
    );
  }
}

syncNowButton.addEventListener("click", performSync);

async function updateSettings() {
  autoSyncToggle.disabled = true;
  notificationToggle.disabled = true;
  const nextSettings = {
    autoSyncEnabled: autoSyncToggle.checked,
    notificationsEnabled: notificationToggle.checked
  };
  try {
    const rawResponse = await sendMessage({ type: "UPDATE_SETTINGS", ...nextSettings });
    const updateOutcome = classifySettingsUpdateResponse(rawResponse);
    if (updateOutcome === SETTINGS_UPDATE_OUTCOMES.unconfirmed) {
      throw new Error("Settings update response was not confirmed");
    }
    state.settings = { ...state.settings, ...nextSettings };
    let refreshFailed = false;
    try {
      await loadData();
    } catch {
      // The background explicitly confirmed the durable DB write. A failed
      // status refresh must not make either toggle appear to have rolled back.
      state.settings = { ...state.settings, ...nextSettings };
      refreshFailed = true;
    }
    if (updateOutcome === SETTINGS_UPDATE_OUTCOMES.scheduleRepairFailed) {
      showNotice(
        "設定は保存しました",
        "自動確認の予定を更新できませんでした。ブラウザを開き直すと自動で修復を試みます。"
      );
    } else if (updateOutcome === SETTINGS_UPDATE_OUTCOMES.unknownWarning || refreshFailed) {
      showNotice(
        "設定は保存しました",
        "自動確認の状態を画面へ反映できませんでした。ブラウザを開き直して確認してください。"
      );
    }
  } catch {
    let durableSettingsLoaded = false;
    try {
      const database = requireRepository();
      const [autoSyncEnabled, notificationsEnabled] = await Promise.all([
        database.getSetting("autoSyncEnabled"),
        database.getSetting("notificationsEnabled")
      ]);
      state.settings.autoSyncEnabled = autoSyncEnabled !== false;
      state.settings.notificationsEnabled = notificationsEnabled !== false;
      durableSettingsLoaded = true;
    } catch {
      // Keep the last confirmed state when even the local source of truth is
      // unavailable. No untrusted response value is reflected into the UI.
    }
    showNotice(
      "設定の保存結果を確認できませんでした",
      durableSettingsLoaded
        ? "画面を端末内の保存内容に合わせました。内容を確認して、必要ならもう一度お試しください。"
        : "拡張を開き直して、もう一度お試しください。"
    );
  } finally {
    renderSettings();
  }
}

autoSyncToggle.addEventListener("change", updateSettings);
notificationToggle.addEventListener("change", updateSettings);

exportButton.addEventListener("click", async () => {
  if (state.profile === null) {
    backupMessage.textContent = "先に一度、お気に入りを確認してください。";
    return;
  }
  exportButton.disabled = true;
  backupMessage.textContent = "バックアップを準備しています…";
  /** @type {string | null} */
  let objectUrl = null;
  let downloadStarted = false;
  try {
    const text = await createBackup(requireRepository(), state.profile.userId, {
      appVersion: chrome.runtime.getManifest().version
    });
    const blob = new Blob([text], { type: "application/json" });
    objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `vrc-favorite-worlds-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    downloadStarted = true;
    anchor.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const backedUpAt = Date.now();
    await requireRepository().setSetting("lastBackupAt", backedUpAt);
    state.settings.lastBackupAt = new Date(backedUpAt).toISOString();
    renderSettings();
    backupMessage.textContent = "バックアップを書き出しました。大切な場所へ保管してください。";
  } catch {
    backupMessage.textContent = downloadStarted
      ? "ファイルの書き出しを開始しましたが、最終バックアップ日時を記録できませんでした。ファイルが保存されているか確認してください。"
      : "バックアップを作成できませんでした。少し時間をあけて、もう一度お試しください。";
  } finally {
    if (objectUrl !== null) {
      URL.revokeObjectURL(objectUrl);
    }
    exportButton.disabled = state.profile === null || restoring;
  }
});

importInput.addEventListener("change", async () => {
  const file = importInput.files?.[0];
  if (file === undefined) {
    return;
  }
  restoring = true;
  renderConnection();
  renderSettings();
  backupMessage.textContent = "バックアップを確認しています…";
  let validationCompleted = false;
  let restoreCompleted = false;
  try {
    if (file.size > MAX_BACKUP_BYTES) {
      backupMessage.textContent = "ファイルが25MBを超えているため復元できません。正しいバックアップを選んでください。";
      return;
    }
    const text = await file.text();
    const validated = parseBackup(text);
    validationCompleted = true;
    let statusResponse;
    try {
      statusResponse = await sendMessage({ type: "GET_STATUS" });
    } catch {
      backupMessage.textContent =
        "同期状態を確認できないため復元を開始しませんでした。この画面を開き直して、もう一度お試しください。";
      return;
    }
    if (!isRecord(statusResponse) || statusResponse.ok !== true) {
      backupMessage.textContent =
        "同期状態を確認できないため復元を開始しませんでした。この画面を開き直して、もう一度お試しください。";
      return;
    }
    const freshStatus = normalizeStatusResponse(statusResponse);
    state.status = {
      ...freshStatus,
      worldCount: state.worlds.length,
      eventCount: state.events.length
    };
    state.statusAvailable = true;
    if (freshStatus.syncing) {
      backupMessage.textContent =
        "お気に入りを確認中のため復元を開始しませんでした。確認が終わってから、もう一度バックアップを選んでください。";
      return;
    }
    const preview = backupSummary(validated);
    const previewName = preview.displayName.replace(/\s+/gu, " ").slice(0, 80);
    const approved = globalThis.confirm(
      `${previewName}（${preview.userId}）の記録を復元します。\nワールド: ${preview.worldCount.toLocaleString("ja-JP")}件 / 履歴: ${preview.eventCount.toLocaleString("ja-JP")}件\n書き出し日時: ${formatDateTime(preview.exportedAt)}\n\n同じユーザーの現在の記録は、このバックアップの内容に置き換わります。続けますか？`
    );
    if (!approved) {
      backupMessage.textContent = "復元を取り消しました。現在の記録は変更していません。";
      return;
    }
    const restored = await restoreBackup(requireRepository(), text);
    restoreCompleted = true;
    /** @type {ReturnType<typeof classifySettingsUpdateResponse>} */
    let settingsOutcome = SETTINGS_UPDATE_OUTCOMES.unconfirmed;
    try {
      await requireRepository().setSetting("activeProfileId", restored.userId);
      const [autoSyncEnabled, notificationsEnabled] = await Promise.all([
        requireRepository().getSetting("autoSyncEnabled"),
        requireRepository().getSetting("notificationsEnabled")
      ]);
      const rawSettingsResponse = await sendMessage({
        type: "UPDATE_SETTINGS",
        autoSyncEnabled: autoSyncEnabled !== false,
        notificationsEnabled: notificationsEnabled !== false
      });
      settingsOutcome = classifySettingsUpdateResponse(rawSettingsResponse);
    } catch {
      settingsOutcome = SETTINGS_UPDATE_OUTCOMES.unconfirmed;
    }
    let restoredDataLoaded = false;
    try {
      await loadData(restored.userId);
      restoredDataLoaded = true;
    } catch {
      restoredDataLoaded = false;
    }
    const restoredSummary = `記録は復元済みです。ワールド${restored.worldCount.toLocaleString("ja-JP")}件、履歴${restored.eventCount.toLocaleString("ja-JP")}件です。`;
    if (settingsOutcome === SETTINGS_UPDATE_OUTCOMES.scheduleRepairFailed) {
      backupMessage.textContent = `${restoredSummary} 自動確認の予定を更新できませんでした。ブラウザを再起動すると自動で修復を試みます。${restoredDataLoaded ? "" : " この画面も開き直してください。"}`;
    } else if (
      settingsOutcome === SETTINGS_UPDATE_OUTCOMES.success
      && restoredDataLoaded
    ) {
      backupMessage.textContent = restoredSummary;
    } else {
      backupMessage.textContent = `${restoredSummary} 画面または自動確認の設定結果を確認できませんでした。ブラウザを再起動して、この画面で設定を確認してください。`;
    }
  } catch {
    backupMessage.textContent = restoreCompleted
      ? "記録は復元済みですが、画面へ反映できませんでした。この画面を開き直してください。"
      : validationCompleted
        ? "バックアップの内容は確認できましたが、このブラウザへ保存できませんでした。ブラウザを再起動して、もう一度お試しください。"
        : "このファイルは復元できません。対応するバックアップJSONか確認してください。別の版で作った場合は、拡張を最新版へ更新してください。";
  } finally {
    importInput.value = "";
    restoring = false;
    renderConnection();
    renderSettings();
  }
});

/**
 * @param {string} message
 */
async function reopenAfterPurgeFailure(message) {
  try {
    repository = await openDatabase();
    purging = false;
    await loadData();
    purgeMessage.textContent = message;
  } catch {
    purging = false;
    renderConnection();
    renderSettings();
    purgeMessage.textContent = `${message} 記録画面も再読み込みしてください。`;
  }
}

/**
 * Clear sensitive in-memory render state after the background explicitly
 * confirms that every user record was cleared. This also covers test browsers
 * where the extension page remains visible briefly after uninstallSelf resolves.
 *
 * @param {string} message
 */
function showDeletedState(message) {
  state.profile = null;
  state.worlds = [];
  state.events = [];
  state.favoriteGroups = [];
  state.status = normalizeStatusResponse({});
  state.settings.lastBackupAt = null;
  state.storageEstimate = { usage: 0, quota: state.storageEstimate.quota };
  renderAll();
  purgeMessage.textContent = message;
}

purgeUninstallButton.addEventListener("click", async () => {
  if (repository === null || purging) {
    return;
  }
  const approved = globalThis.confirm(
    `このブラウザ内の記録をすべて削除します。\n\nワールド: ${state.worlds.length.toLocaleString("ja-JP")}件\n変更履歴: ${state.events.length.toLocaleString("ja-JP")}件\nお気に入りリスト: ${state.favoriteGroups.length.toLocaleString("ja-JP")}件\n\nこの操作は元に戻せません。必要な記録は先にバックアップしてください。書き出したJSONバックアップ、ダウンロードしたZIP、展開フォルダは自動では削除されません。\n\n続けて拡張を削除しますか？`
  );
  if (!approved) {
    purgeMessage.textContent = "削除を取り消しました。記録は変更していません。";
    return;
  }

  purging = true;
  renderConnection();
  renderSettings();
  purgeMessage.textContent = "次に表示されるブラウザの確認ダイアログで「削除」を押すと完了します。";
  repository.close();
  repository = null;

  let response;
  try {
    response = await sendMessage({ type: "PURGE_AND_UNINSTALL" });
  } catch {
    purgeMessage.textContent = "削除処理を開始しました。確認ダイアログで削除したあと、この画面が閉じれば完了です。画面が残る場合は拡張機能管理画面で状態を確認してください。";
    return;
  }

  const result = normalizePurgeResponse(response);
  if (result.ok) {
    showDeletedState("ブラウザ内の記録と拡張を削除しました。この画面が残っている場合は閉じてください。");
    return;
  }
  const message = purgeErrorMessage(result.error, result.dataDeleted);
  if (result.dataDeleted) {
    showDeletedState(message);
    return;
  }
  await reopenAfterPurgeFailure(message);
});

window.addEventListener(
  "pagehide",
  () => {
    repository?.close();
  },
  { once: true }
);

try {
  repository = await openDatabase();
  await loadData();
  if (initialTab === "events") {
    await markHistoryAsRead();
  }
} catch {
  connectionBadge.className = "badge is-error";
  connectionBadge.textContent = "記録を読み込めません";
  syncNowButton.disabled = true;
  exportButton.disabled = true;
  importInput.disabled = true;
  purgeUninstallButton.disabled = true;
  showNotice(
    "ローカルの記録を読み込めませんでした",
    "ブラウザを再起動してから、この画面をもう一度開いてください。"
  );
}
