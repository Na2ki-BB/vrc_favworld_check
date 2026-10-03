// @ts-check

import { BackupExportLimitError, MAX_BACKUP_BYTES, backupSummary, createBackup, parseBackup, restoreBackup } from "./lib/backup.js";
import { openDatabase } from "./lib/database.js";
import { createFavoriteGroupOptions } from "./lib/favorite-groups.js";
import {
  commandErrorMessage,
  eventDetail,
  favoriteGroupLabels,
  filterEvents,
  filterWorlds,
  formatDateTime,
  isRecord,
  hiddenWorldIds,
  UNREAD_UNCERTAIN_DETAIL,
  normalizeCommandResponse,
  normalizePurgeResponse,
  normalizeStatusResponse,
  presentEventKind,
  presentStatus,
  presentWorldOverview,
  presentThumbnailProgress,
  readThumbnailCount,
  purgeErrorMessage,
  summarizeHistory,
  takeVisibleItems,
  worldMatchesFilter,
  worldStateTags
} from "./lib/ui.js";

/** @typedef {import("./lib/database.js").DatabaseRepository} DatabaseRepository */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listProfiles"]>>[number]} ProfileRecord */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listWorlds"]>>[number]} WorldRecord */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listEvents"]>>[number]} HistoryEvent */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listFavoriteGroups"]>>[number]} FavoriteGroupRecord */
/** @typedef {import("./lib/ui.js").UiStatus} UiStatus */

const PAGE_SIZE = 200;
const STORAGE_WARNING_BYTES = 250 * 1024 * 1024;
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
const VALID_FILTERS = new Set(["attention", "all", "favorite", "missing", "unavailable", "pending", "hidden"]);
const VALID_EVENT_FILTERS = new Set(["attention", "all", "renamed", "group", "missing", "unavailable", "restored"]);

const connectionBadge = requiredElement("connection-badge");
const noticePanel = requiredElement("notice-panel");
const noticeTitle = requiredElement("notice-title");
const noticeDetail = requiredElement("notice-detail");
const noticeActionButton = /** @type {HTMLButtonElement} */ (requiredElement("notice-action"));
const onboarding = requiredElement("onboarding");
const primaryFocus = requiredElement("primary-focus");
const primaryFocusTitle = requiredElement("primary-focus-title");
const primaryFocusDetail = requiredElement("primary-focus-detail");
const lastSync = requiredElement("last-sync");
const worldFilterSummary = requiredElement("world-filter-summary");
const openVrchatButton = /** @type {HTMLButtonElement} */ (requiredElement("open-vrchat-button"));
const syncNowButton = /** @type {HTMLButtonElement} */ (requiredElement("sync-now-button"));
const worldSearch = /** @type {HTMLInputElement} */ (requiredElement("world-search"));
const worldFilter = /** @type {HTMLSelectElement} */ (requiredElement("world-filter"));
const groupFilter = /** @type {HTMLSelectElement} */ (requiredElement("group-filter"));
const worldResultCount = requiredElement("world-result-count");
const worldList = requiredElement("world-list");
const hiddenRecordsLink = requiredElement("hidden-records-link");
const hiddenRecordsDescription = requiredElement("hidden-records-description");
const recordActionMessage = requiredElement("record-action-message");
const settingsUnreadDetail = requiredElement("settings-unread-detail");
const worldEmpty = requiredElement("world-empty");
const worldEmptyTitle = requiredElement("world-empty-title");
const worldEmptyDetail = requiredElement("world-empty-detail");
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
const settingsThumbnailCount = requiredElement("settings-thumbnail-count");
const thumbnailCaptureNotice = requiredElement("thumbnail-capture-notice");
const settingsStorageUsage = requiredElement("settings-storage-usage");
const settingsLastBackup = requiredElement("settings-last-backup");
const storageWarning = requiredElement("storage-warning");
const exportButton = /** @type {HTMLButtonElement} */ (requiredElement("export-button"));
const importInput = /** @type {HTMLInputElement} */ (requiredElement("import-input"));
const backupMessage = requiredElement("backup-message");
const purgeUninstallButton = /** @type {HTMLButtonElement} */ (requiredElement("purge-uninstall-button"));
const purgeMessage = requiredElement("purge-message");
const historyUnreadBadge = requiredElement("history-unread-badge");
const tabButtons = Array.from(document.querySelectorAll(".tab"));

/** @type {DatabaseRepository | null} */
let repository = null;
let manualSyncInFlight = false;
/** @type {(() => void | Promise<void>) | null} */
let noticeAction = null;
let visibleWorldCount = PAGE_SIZE;
let visibleEventCount = PAGE_SIZE;
let restoring = false;
let markingHistoryRead = false;
let purging = false;
let thumbnailRenderGeneration = 0;
let progressEpoch = 0;
let pageClosed = false;
let progressPolling = false;
let recordMutationInFlight = false;
let recordDialogEpoch = 0;
let navigationEpoch = 0;
let recordInteractionEpoch = 0;
/** @typedef {"HIDE_WORLD" | "RESTORE_HIDDEN_WORLD" | "PURGE_HIDDEN_WORLD"} RecordCommand */
/** @typedef {{type: RecordCommand, userId: string, worldId: string, expectedGeneration: number, expectedPresentationGeneration: number, expectedRevision: number, trigger: HTMLElement, position: number, navigation: number}} RecordAction */
/** @type {RecordAction | null} */
let recordDialogAction = null;
/** @type {string | null} */
let recordDialogImageUrl = null;
const recordDialogs = ["hide", "purge"].map((name) => ({
  name,
  dialog: /** @type {HTMLDialogElement} */ (requiredElement(`${name}-record-dialog`)),
  target: requiredElement(`${name}-record-target`),
  description: requiredElement(`${name}-record-description`),
  feedback: requiredElement(`${name}-record-feedback`),
  cancel: /** @type {HTMLButtonElement} */ (requiredElement(`${name}-record-cancel`)),
  submit: /** @type {HTMLButtonElement} */ (requiredElement(`${name}-record-submit`))
}));
/** @type {Set<string>} */
const activeThumbnailObjectUrls = new Set();

const state = {
  /** @type {ProfileRecord | null} */
  profile: null,
  /** @type {WorldRecord[]} */
  worlds: [],
  /** @type {HistoryEvent[]} */
  events: [],
  /** @type {FavoriteGroupRecord[]} */
  favoriteGroups: [],
  /** @type {import("./lib/ui.js").WorldDisposition[]} */
  worldDispositions: [],
  thumbnailCount: /** @type {number | null} */ (0),
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
 * @param {DatabaseRepository} database
 * @returns {Promise<ProfileRecord | null>}
 */
async function selectProfile(preferredUserId, database) {
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
 * Stage one local snapshot and publish it only while this load still owns the
 * view. Restore, purge, page close, a repository change, or any newer load
 * invalidates every pending read before it can replace the displayed account.
 * @param {string | null} [preferredUserId]
 * @param {boolean} [preserveView]
 * @returns {Promise<boolean>} Whether this snapshot was applied.
 */
async function loadData(preferredUserId = null, preserveView = false) {
  const epoch = ++progressEpoch;
  thumbnailRenderGeneration += 1;
  const database = requireRepository();
  const current = () => !pageClosed && epoch === progressEpoch && repository === database;
  try {
    let runtimeStatus = normalizeStatusResponse({});
    let statusAvailable = true;
    try {
      const response = await sendMessage({ type: "GET_STATUS" });
      if (isRecord(response) && response.ok === false) {
        throw new Error("Status request failed");
      }
      runtimeStatus = normalizeStatusResponse(response);
    } catch {
      statusAvailable = false;
    }
    if (!current()) return false;

    let profile = await selectProfile(preferredUserId ?? runtimeStatus.activeProfileId, database);
    if (!current()) return false;
    /** @type {WorldRecord[]} */
    let worlds = [];
    /** @type {HistoryEvent[]} */
    let events = [];
    /** @type {FavoriteGroupRecord[]} */
    let favoriteGroups = [];
    /** @type {number | null} */
    let thumbnailCount = 0;
    /** @type {import("./lib/ui.js").WorldDisposition[]} */
    let worldDispositions = [];
    let generation = 0;
    let presentationGeneration = 0;
    let unreadSummary = normalizeStatusResponse({}).unreadSummary;
    if (profile !== null) {
      const [snapshot, savedThumbnailCount] = await Promise.all([
        database.getDisplaySnapshot(profile.userId),
        readThumbnailCount(database, profile.userId)
      ]);
      ({profile, worlds, events, favoriteGroups, worldDispositions, generation, presentationGeneration, unreadSummary} = snapshot);
      thumbnailCount = savedThumbnailCount;
    }
    if (!current()) return false;

    const [autoSyncEnabled, notificationsEnabled, storedNextSyncAt, lastBackupAt, storageEstimate] = await Promise.all([
      database.getSetting("autoSyncEnabled"),
      database.getSetting("notificationsEnabled"),
      database.getSetting("nextSyncAt"),
      database.getSetting("lastBackupAt"),
      readStorageEstimate()
    ]);
    if (!current()) return false;
    const localSummary = summarizeHistory(worlds, events, worldDispositions);
    if (state.profile?.userId !== profile?.userId) closeRecordDialogs(false);
    else if (state.status.generation !== generation || state.status.presentationGeneration !== presentationGeneration) invalidateRecordDialog();
    Object.assign(state, {
      profile, worlds, events, favoriteGroups, worldDispositions, thumbnailCount, statusAvailable, storageEstimate,
      settings: {
        autoSyncEnabled: autoSyncEnabled !== false,
        notificationsEnabled: notificationsEnabled !== false,
        lastBackupAt: dateSetting(lastBackupAt)
      },
      status: {
        ...runtimeStatus,
        thumbnailProgress: runtimeStatus.activeProfileId === profile?.userId ? runtimeStatus.thumbnailProgress : null,
        activeProfileId: profile?.userId ?? runtimeStatus.activeProfileId,
        lastSuccessfulSyncAt: profile?.lastSuccessfulSyncAt ?? runtimeStatus.lastSuccessfulSyncAt,
        nextSyncAt: runtimeStatus.nextSyncAt ?? dateSetting(storedNextSyncAt),
        generation, presentationGeneration, unreadSummary,
        unreadCount: unreadSummary.count ?? 0,
        hiddenCount: hiddenWorldIds(worldDispositions).size,
        worldCount: worlds.length,
        eventCount: events.length,
        attentionWorldCount: localSummary.attention,
        missingCount: localSummary.missing,
        unavailableCount: localSummary.unavailable
      }
    });
    renderThumbnailProgressNotice();
    if (!preserveView) {
      visibleWorldCount = PAGE_SIZE;
      visibleEventCount = PAGE_SIZE;
    }
    renderAll();
    return true;
  } catch (error) {
    if (!current()) return false;
    throw error;
  }
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
  renderPrimaryFocus();
  renderSummary();
  renderGroupFilter();
  renderWorlds();
  renderEvents();
  renderSettings();
  onboarding.hidden = state.status.authRequired || (state.profile !== null && state.status.lastSuccessfulSyncAt !== null);
}

function renderPrimaryFocus() {
  if (worldFilter.value === "hidden") {
    primaryFocus.classList.remove("is-alert");
    primaryFocusTitle.textContent = "非表示の記録";
    primaryFocusDetail.textContent = "戻すと通常の一覧で再び確認できます。完全に削除する操作は取り消せません。";
    lastSync.textContent = state.status.lastSuccessfulSyncAt === null ? "最終確認: まだありません" : `最終確認: ${formatDateTime(state.status.lastSuccessfulSyncAt)}`;
    return;
  }
  const hidden = hiddenWorldIds(state.worldDispositions);
  const overview = presentWorldOverview({...state.status, syncing: state.status.syncing || manualSyncInFlight}, {
    hasProfile: state.profile !== null,
    statusAvailable: state.statusAvailable,
    pendingWorldCount: state.worlds.filter((world) => !hidden.has(world.worldId) && worldMatchesFilter(world, "pending")).length
  });
  primaryFocus.classList.toggle("is-alert", state.status.attentionWorldCount > 0);
  primaryFocusTitle.textContent = overview.title;
  primaryFocusDetail.textContent = overview.detail;
  lastSync.textContent = state.status.lastSuccessfulSyncAt === null
    ? "最終確認: まだありません"
    : `最終確認: ${formatDateTime(state.status.lastSuccessfulSyncAt)}`;
}

function renderConnection() {
  const presentation = presentStatus({...state.status, syncing: state.status.syncing || manualSyncInFlight});
  connectionBadge.className = "badge";
  if (presentation.tone === "ready" || presentation.tone === "working") {
    connectionBadge.classList.add("is-ready");
  } else if (presentation.tone === "attention") {
    connectionBadge.classList.add("is-attention");
  } else if (presentation.tone === "error") {
    connectionBadge.classList.add("is-error");
  }
  connectionBadge.textContent = state.statusAvailable ? presentation.title : "状態を読み込めませんでした";
  syncNowButton.disabled = state.status.syncing || restoring || purging || manualSyncInFlight || recordMutationInFlight;
  syncNowButton.textContent = purging
    ? "削除しています…"
    : restoring
    ? "復元しています…"
    : state.status.syncing || manualSyncInFlight
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
      null
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
  historyUnreadBadge.setAttribute("aria-label", state.status.unreadSummary.uncertain ? "未読件数は未確定" : `未読の変更${state.status.unreadCount.toLocaleString("ja-JP")}件`);
  historyUnreadBadge.hidden = !state.status.unreadSummary.uncertain && state.status.unreadCount === 0;
  historyUnreadBadge.textContent = state.status.unreadSummary.uncertain ? "?" : state.status.unreadCount > 99
    ? "99+"
    : state.status.unreadCount.toLocaleString("ja-JP");
}

function renderGroupFilter() {
  const selected = groupFilter.value;
  const recordedTags = new Set(state.worlds.flatMap((world) => world.favoriteTags));
  const worldGroups = state.favoriteGroups.filter(
    (group) => group.type === "world" || group.type === "vrcPlusWorld"
  );
  const groups = createFavoriteGroupOptions(worldGroups, [...recordedTags]);
  /** @type {Map<string, number>} */
  const displayNameCounts = new Map();
  for (const group of groups) {
    if (group.displayName !== null) {
      displayNameCounts.set(
        group.displayName,
        (displayNameCounts.get(group.displayName) ?? 0) + 1
      );
    }
  }

  groupFilter.replaceChildren();
  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = "すべてのリスト";
  groupFilter.append(allOption);

  for (const group of groups) {
    const option = document.createElement("option");
    option.value = group.internalName;
    const fallbackLabel = group.listNumber === null
      ? favoriteGroupLabels([group.internalName], [])[0] ?? group.internalName
      : `リスト${group.listNumber}`;
    const displayName = group.displayName ?? fallbackLabel;
    const duplicateSuffix = (displayNameCounts.get(displayName) ?? 0) > 1
      ? `（${group.internalName}）`
      : "";
    const stateSuffix = group.source === "unused-slot"
      ? "（未使用）"
      : group.active === false
        ? "（以前のリスト）"
        : "";
    option.textContent = `${displayName}${duplicateSuffix}${stateSuffix}`;
    groupFilter.append(option);
  }
  groupFilter.value = [...groupFilter.options].some((option) => option.value === selected)
    ? selected
    : "";
}

function renderWorlds() {
  const hidden = hiddenWorldIds(state.worldDispositions);
  const focused = captureWorldFocus();
  const expanded = new Set(Array.from(worldList.querySelectorAll(".world-card")).filter((card) => card.querySelector("details")?.open).map((card) => /** @type {HTMLElement} */ (card).dataset.worldId));
  hiddenRecordsLink.textContent = `非表示の記録（${state.status.hiddenCount.toLocaleString("ja-JP")}件）`;
  hiddenRecordsDescription.hidden = worldFilter.value !== "hidden";
  renderPrimaryFocus();
  clearThumbnailObjectUrls();
  const renderGeneration = ++thumbnailRenderGeneration;
  const requestedFilter = worldFilter.value;
  const filter = VALID_FILTERS.has(requestedFilter)
    ? /** @type {"attention" | "all" | "favorite" | "missing" | "unavailable" | "pending" | "hidden"} */ (requestedFilter)
    : "attention";
  const matching = filterWorlds(
    state.worlds,
    state.events,
    worldSearch.value,
    filter,
    groupFilter.value,
    state.favoriteGroups,
    state.worldDispositions
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
        favoriteGroupLabels(world.favoriteTags, state.favoriteGroups),
        hidden.has(world.worldId)
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
  const hasRefinement = worldSearch.value.trim().length > 0 || groupFilter.value.length > 0;
  const filterLabel = worldFilter.selectedOptions[0]?.textContent ?? "消えた可能性のあるワールド";
  worldResultCount.textContent = `${filterLabel} · ${matching.length.toLocaleString("ja-JP")}件${visible.length < matching.length ? `（${visible.length.toLocaleString("ja-JP")}件を表示）` : ""}`;
  worldFilterSummary.textContent = filter === "attention" && !hasRefinement
    ? "すべての記録・検索"
    : `表示を変更・検索（${filterLabel}${hasRefinement ? "・絞り込み中" : ""}）`;
  worldEmpty.hidden = matching.length !== 0;
  if (filter === "attention" && !hasRefinement) {
    const overview = presentWorldOverview(state.status, {
      hasProfile: state.profile !== null,
      statusAvailable: state.statusAvailable,
      pendingWorldCount: state.worlds.filter((world) => !hidden.has(world.worldId) && worldMatchesFilter(world, "pending")).length
    });
    worldEmptyTitle.textContent = overview.title;
    worldEmptyDetail.textContent = overview.detail;
    // The overview already explains the unfiltered empty state above the list.
    worldEmpty.hidden = true;
  } else {
    worldEmptyTitle.textContent = "この条件に該当するワールドはありません";
    worldEmptyDetail.textContent = "「表示を変更・検索」から検索語や絞り込みを変えてください。";
  }
  for (const card of worldList.querySelectorAll(".world-card")) {
    const details = card.querySelector("details");
    if (details !== null && expanded.has(/** @type {HTMLElement} */ (card).dataset.worldId)) details.open = true;
  }
  if (focused !== null && !recordDialogs.some(({dialog}) => dialog.open)) {
    // Preserve a newer surviving control, but leave missing-card fallback to
    // the action that still owns focus after its asynchronous refresh.
    restoreWorldFocus(focused, !recordMutationInFlight);
  }
  void hydrateWorldThumbnails(visible, renderGeneration);
}

/**
 * @param {WorldRecord} world
 * @param {readonly string[]} recordedPreviousNames
 * @param {readonly string[]} favoriteGroupNames
 * @param {boolean} hidden
 * @returns {HTMLElement}
 */
function createWorldCard(world, recordedPreviousNames, favoriteGroupNames, hidden) {
  const card = textElement("article", "world-card", "");
  card.dataset.worldId = world.worldId;
  card.classList.toggle("is-unavailable", world.availabilityState === "unavailable");
  const thumbnail = textElement(
    "div",
    "world-thumbnail",
    "保存画像を読み込み中…"
  );
  const content = document.createElement("div");
  content.append(
    textElement("h3", "", world.currentName ?? "名前を確認できないワールド"),
    textElement(
      "p",
      "world-meta",
      world.authorName ?? "作者名を確認できません"
    )
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
  const details = /** @type {HTMLDetailsElement} */ (document.createElement("details"));
  details.className = "world-details";
  details.append(
    textElement("summary", "", "詳細"),
    textElement("p", "world-meta", `最終更新: ${formatDateTime(world.updatedAt)}`),
    textElement("p", "world-meta", `初回記録: ${formatDateTime(world.firstSeenAt)}`),
    textElement("p", "world-meta", `最後にお気に入りで確認: ${formatDateTime(world.lastSeenFavoriteAt)}`),
    textElement("p", "world-meta", world.worldId)
  );
  content.append(details);

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
  if (hidden) tags.append(textElement("span", "state-tag is-hidden", "非表示"));
  const actions = textElement("div", "world-actions", "");
  if (hidden) {
    actions.append(createRecordButton("戻す", "RESTORE_HIDDEN_WORLD", world), createRecordButton("完全に削除", "PURGE_HIDDEN_WORLD", world));
  } else if (worldMatchesFilter(world, "attention")) {
    actions.append(createRecordButton("削除", "HIDE_WORLD", world));
  }
  card.append(thumbnail, content, tags);
  if (actions.childElementCount > 0) card.append(actions);
  return card;
}

/** @returns {{worldId: string, action: string, position: number} | null} */
function captureWorldFocus() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !worldList.contains(active)) return null;
  const card = active.closest(".world-card");
  if (!(card instanceof HTMLElement) || card.dataset.worldId === undefined) return null;
  return {worldId: card.dataset.worldId, action: active.dataset.recordAction ?? (active.tagName === "SUMMARY" ? "summary" : ""), position: Array.from(worldList.children).indexOf(card)};
}

/**
 * @param {{worldId: string, action: string, position: number}} previous
 * @param {boolean} [allowFallback]
 */
function restoreWorldFocus(previous, allowFallback = true) {
  const cards = Array.from(worldList.querySelectorAll(".world-card"));
  const same = cards.find((card) => card instanceof HTMLElement && card.dataset.worldId === previous.worldId);
  const target = same ?? (allowFallback ? cards[previous.position] ?? cards[previous.position - 1] : undefined);
  const buttons = target === undefined ? [] : Array.from(target.querySelectorAll("button, summary"));
  const action = buttons.find((button) => button instanceof HTMLElement && (previous.action === "summary" ? button.tagName === "SUMMARY" : button.dataset.recordAction === previous.action))
    ?? (allowFallback ? buttons.find((button) => button instanceof HTMLElement && button.dataset.recordAction !== undefined) ?? buttons[0] : undefined);
  if (action instanceof HTMLElement) action.focus();
  else if (allowFallback) primaryFocusTitle.focus();
}

/** @param {string} label @param {RecordCommand} type @param {WorldRecord} world */
function createRecordButton(label, type, world) {
  const button = /** @type {HTMLButtonElement} */ (textElement("button", `button ${type === "RESTORE_HIDDEN_WORLD" ? "button-secondary" : "button-danger-quiet"}`, label));
  button.type = "button";
  button.dataset.recordAction = type;
  button.disabled = recordMutationInFlight || restoring || purging || state.status.syncing;
  button.addEventListener("click", () => {
    if (recordMutationInFlight || restoring || purging || state.profile === null) return;
    const action = {
      type, userId: state.profile.userId, worldId: world.worldId,
      expectedGeneration: state.status.generation,
      expectedPresentationGeneration: state.status.presentationGeneration,
      expectedRevision: world.revision,
      trigger: button,
      position: Array.from(worldList.children).findIndex((card) => card instanceof HTMLElement && card.dataset.worldId === world.worldId),
      navigation: navigationEpoch
    };
    if (type === "RESTORE_HIDDEN_WORLD") void performRecordAction(action);
    else void openRecordDialog(action);
  });
  return button;
}

/** @param {boolean} [restoreFocus] */
function closeRecordDialogs(restoreFocus = true) {
  recordDialogEpoch += 1;
  const previous = recordDialogAction;
  recordDialogAction = null;
  for (const controls of recordDialogs) {
    if (controls.dialog.open) controls.dialog.close();
    controls.target.replaceChildren();
  }
  if (recordDialogImageUrl !== null) URL.revokeObjectURL(recordDialogImageUrl);
  recordDialogImageUrl = null;
  if (restoreFocus && previous !== null && !pageClosed && previous.navigation === navigationEpoch) {
    if (previous.trigger.isConnected) previous.trigger.focus();
    else restoreWorldFocus({worldId: previous.worldId, action: previous.type, position: previous.position});
  }
}

function invalidateRecordDialog() {
  recordDialogEpoch += 1;
  if (recordDialogImageUrl !== null) URL.revokeObjectURL(recordDialogImageUrl);
  recordDialogImageUrl = null;
  for (const controls of recordDialogs) {
    if (!controls.dialog.open) continue;
    controls.submit.disabled = true;
    controls.target.querySelector("img")?.remove();
    controls.feedback.textContent = "記録が更新されました。もう一度確認してください";
  }
}

/** @param {RecordAction} action */
async function openRecordDialog(action) {
  closeRecordDialogs(false);
  const epoch = recordDialogEpoch;
  const viewEpoch = progressEpoch;
  const renderGeneration = thumbnailRenderGeneration;
  const database = requireRepository();
  const current = () => !pageClosed && repository === database && epoch === recordDialogEpoch
    && viewEpoch === progressEpoch && renderGeneration === thumbnailRenderGeneration
    && action.navigation === navigationEpoch && state.profile?.userId === action.userId;
  action.trigger.setAttribute("aria-busy", "true");
  try {
    // All confirmation content comes from a fresh atomic display snapshot.
    // A separate Blob read is never published after a newer view or account.
    const [snapshot, thumbnails, activeProfileId] = await Promise.all([
      database.getDisplaySnapshot(action.userId),
      database.getThumbnails(action.userId, [action.worldId]),
      database.getSetting("activeProfileId")
    ]);
    if (!current()) return;
    const world = snapshot.worlds.find((candidate) => candidate.worldId === action.worldId);
    const disposition = snapshot.worldDispositions.find((row) => row.worldId === action.worldId);
    if (activeProfileId !== action.userId || snapshot.profile === null || world === undefined
      || snapshot.generation !== action.expectedGeneration || snapshot.presentationGeneration !== action.expectedPresentationGeneration
      || world.revision !== action.expectedRevision
      || (action.type === "HIDE_WORLD" ? disposition !== undefined || !worldMatchesFilter(world, "attention") : disposition?.state !== "hidden")) {
      recordActionMessage.textContent = "記録が更新されました。もう一度確認してください";
      await loadData(null, true);
      return;
    }
    const controls = recordDialogs.find(({name}) => name === (action.type === "HIDE_WORLD" ? "hide" : "purge"));
    if (controls === undefined) return;
    const name = world.currentName ?? "名前を確認できないワールド";
    controls.target.append(
      textElement("p", "world-meta", `アカウント: ${snapshot.profile.displayName}（${action.userId}）`),
      textElement("strong", "", name),
      textElement("p", "world-meta", `World ID: ${action.worldId}`),
      textElement("p", "world-meta", `保存画像: ${thumbnails.length > 0 ? "あり" : "なし"} / 変更履歴: ${snapshot.events.filter((event) => event.worldId === action.worldId).length.toLocaleString("ja-JP")}件`)
    );
    const thumbnail = thumbnails[0];
    if (thumbnail !== undefined) {
      const image = document.createElement("img");
      recordDialogImageUrl = URL.createObjectURL(thumbnail.blob);
      image.src = recordDialogImageUrl;
      image.alt = `「${name}」の保存画像`;
      image.addEventListener("error", () => {
        if (current()) image.replaceWith(textElement("p", "world-meta", "保存画像を表示できませんでした"));
      }, {once: true});
      controls.target.append(image);
    }
    controls.description.textContent = action.type === "HIDE_WORLD"
      ? `『${name}』を通常の一覧から隠します。名前・画像・変更履歴は残り、『非表示の記録』から戻せます。同期と通知は続きます。VRChatのお気に入りは変更しません`
      : `『${name}』の保存名・画像・変更履歴を、このブラウザから完全に削除します。この操作は取り消せません。\n現在のJSONバックアップには画像が含まれないため、削除した画像はJSONから戻せません。\n同じ記録の再表示を防ぐためWorld IDだけを残します。今後、VRChatのお気に入りで利用可能と確認できた場合は、新しい記録として保存します。\nVRChatのお気に入りや、ほかのワールドの記録は変更しません${world.membershipState === "favorited" && world.availabilityState === "accessible" ? "\n現在は利用可能なため、次回の確認で新しい記録として保存される可能性があります" : ""}`;
    controls.feedback.textContent = "";
    controls.cancel.textContent = "キャンセル";
    controls.submit.disabled = false;
    recordDialogAction = action;
    controls.dialog.showModal();
    controls.cancel.focus();
  } catch {
    if (current()) recordActionMessage.textContent = "確認用の記録を読み込めませんでした。削除は開始していません。画面を再読み込みして、もう一度お試しください。";
  } finally {
    action.trigger.removeAttribute("aria-busy");
  }
}

/** @param {string} code */
function recordErrorMessage(code) {
  if (code === "RECORD_CHANGED" || code === "NO_ACTIVE_PROFILE") return "記録が更新されました。もう一度確認してください";
  if (code === "SYNC_IN_PROGRESS" || code === "MAINTENANCE_IN_PROGRESS") return "同期・画像保存・ほかの記録操作が進行中のため開始しませんでした。終了後にもう一度お試しください。";
  return "記録を変更できませんでした。保存状態を確認してから、もう一度お試しください。";
}

/** @param {RecordAction} action */
async function performRecordAction(action) {
  if (recordMutationInFlight || restoring || purging || pageClosed || state.profile?.userId !== action.userId
    || action.navigation !== navigationEpoch) return;
  if (action.expectedGeneration !== state.status.generation || action.expectedPresentationGeneration !== state.status.presentationGeneration) {
    invalidateRecordDialog();
    recordActionMessage.textContent = "記録が更新されました。もう一度確認してください";
    return;
  }
  recordMutationInFlight = true;
  const database = requireRepository();
  const current = () => !pageClosed && repository === database && action.navigation === navigationEpoch && state.profile?.userId === action.userId;
  for (const controls of recordDialogs) {
    controls.submit.disabled = true;
    if (controls.dialog.open) {
      controls.cancel.textContent = "閉じる";
      controls.feedback.textContent = "記録を更新しています。閉じても処理は続きます。結果は保存状態を確認して表示します。";
    }
  }
  for (const button of worldList.querySelectorAll("button")) button.disabled = true;
  renderConnection();
  renderSettings();
  recordActionMessage.textContent = "記録を更新しています…";
  let saved = false;
  let scheduleWarning;
  let failure = "";
  let moveFocus = action.type === "RESTORE_HIDDEN_WORLD";
  let focusEpoch = recordInteractionEpoch;
  try {
    let raw;
    try {
      raw = await sendMessage({type: action.type, userId: action.userId, worldId: action.worldId,
        expectedGeneration: action.expectedGeneration, expectedPresentationGeneration: action.expectedPresentationGeneration,
        expectedRevision: action.expectedRevision});
    } catch {
      raw = null;
    }
    saved = isRecord(raw) && raw.ok === true && raw.recordSaved === true;
    scheduleWarning = saved && isRecord(raw) && raw.thumbnailScheduleWarning !== null;
    if (!saved) {
      if (isRecord(raw) && raw.ok === false && typeof raw.error === "string") {
        failure = recordErrorMessage(raw.error);
      } else {
        // A lost response never authorizes another mutation. Check durable state.
        const snapshot = await database.getDisplaySnapshot(action.userId);
        const disposition = snapshot.worldDispositions.find((row) => row.worldId === action.worldId);
        const exists = snapshot.worlds.some((world) => world.worldId === action.worldId);
        saved = action.type === "HIDE_WORLD" ? exists && disposition?.state === "hidden"
          : action.type === "RESTORE_HIDDEN_WORLD" ? exists && disposition === undefined
          : !exists && disposition?.state === "purged";
        failure = "操作結果を確認できませんでした。端末内の保存内容を読み直しました。内容を確認して、必要ならもう一度お試しください。";
      }
    }
    if (!current()) return;
    moveFocus = (moveFocus || recordDialogAction === action) && focusEpoch === recordInteractionEpoch;
    closeRecordDialogs(false);
    // Closing our own native modal may restore its trigger focus synchronously.
    focusEpoch = recordInteractionEpoch;
    let refreshed = false;
    try { refreshed = await loadData(null, true); } catch { /* A committed write remains committed. */ }
    if (!current()) return;
    if (saved) {
      recordActionMessage.textContent = !refreshed
        ? action.type === "PURGE_HIDDEN_WORLD" ? "削除は完了しました。表示を再読み込みしてください" : "記録の変更は完了しました。表示を再読み込みしてください"
        : action.type === "HIDE_WORLD" ? "一覧から非表示にしました" : action.type === "RESTORE_HIDDEN_WORLD" ? "一覧に戻しました" : "記録を完全に削除しました";
      if (scheduleWarning) recordActionMessage.textContent += "。データ保存は成功しました。画像予定の修復は保留されています。ブラウザを開き直すと修復を試みます。";
    } else recordActionMessage.textContent = failure;
  } catch {
    if (current()) {
      moveFocus = moveFocus && focusEpoch === recordInteractionEpoch;
      closeRecordDialogs(false);
      focusEpoch = recordInteractionEpoch;
      recordActionMessage.textContent = saved ? "記録の変更は完了しました。表示を再読み込みしてください" : "操作結果を確認できませんでした。自動では再実行しません。画面を開き直して保存状態を確認してください。";
    }
  } finally {
    recordMutationInFlight = false;
    if (!pageClosed) {
      renderConnection();
      renderSettings();
      for (const button of worldList.querySelectorAll("button")) button.disabled = state.status.syncing || restoring || purging;
    }
    if (current() && moveFocus && focusEpoch === recordInteractionEpoch) restoreWorldFocus({worldId: action.worldId, action: action.type, position: action.position});
  }
}

for (const controls of recordDialogs) {
  controls.cancel.addEventListener("click", () => closeRecordDialogs());
  controls.dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeRecordDialogs();
  });
  controls.submit.addEventListener("click", () => {
    if (controls.submit.disabled || recordDialogAction === null) return;
    void performRecordAction(recordDialogAction);
  });
  // showModal supplies focus containment and inert background natively. Keep
  // explicit keyboard wrapping for the two action buttons, including stale UI.
  controls.dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const last = controls.submit.disabled ? controls.cancel : controls.submit;
    if (event.shiftKey && document.activeElement === controls.cancel) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); controls.cancel.focus(); }
  });
}

function clearThumbnailObjectUrls() {
  for (const objectUrl of activeThumbnailObjectUrls) {
    URL.revokeObjectURL(objectUrl);
  }
  activeThumbnailObjectUrls.clear();
}

/**
 * Load binary images only for cards that are currently visible. Blob URLs are
 * revoked on every rerender so filtering a large history cannot retain image
 * data in page memory.
 *
 * @param {readonly WorldRecord[]} worlds
 * @param {number} renderGeneration
 */
async function hydrateWorldThumbnails(worlds, renderGeneration) {
  if (repository === null || state.profile === null || worlds.length === 0) {
    return;
  }
  const profileId = state.profile.userId;
  const database = repository;
  const worldIds = worlds.map((world) => world.worldId);
  /** @type {string[][]} */
  const batches = [];
  for (let index = 0; index < worldIds.length; index += 50) {
    batches.push(worldIds.slice(index, index + 50));
  }
  const isCurrent = () => renderGeneration === thumbnailRenderGeneration
    && !pageClosed && state.profile?.userId === profileId && repository === database;
  /** @type {Awaited<ReturnType<DatabaseRepository["getThumbnails"]>>} */
  let records;
  try {
    records = (await Promise.all(
      batches.map((batch) => database.getThumbnails(profileId, batch))
    )).flat();
  } catch {
    if (isCurrent()) {
      for (const container of worldList.querySelectorAll(".world-thumbnail")) {
        if (container instanceof HTMLElement) {
          showThumbnailMessage(container, "保存画像を読み出せませんでした", "再読み込み", renderWorlds);
        }
      }
    }
    return;
  }
  if (!isCurrent()) {
    return;
  }
  const recordsById = new Map(records.map((record) => [record.worldId, record]));
  const cards = Array.from(worldList.querySelectorAll(".world-card[data-world-id]"))
    .filter((candidate) => candidate instanceof HTMLElement);
  for (const world of worlds) {
    const card = cards.find((candidate) => candidate.dataset.worldId === world.worldId);
    const container = card?.querySelector(".world-thumbnail");
    if (!(container instanceof HTMLElement)) {
      continue;
    }
    if (container.querySelector("img") !== null) continue;
    const record = recordsById.get(world.worldId);
    if (record === undefined) {
      if (world.availabilityState === "unavailable") {
        showThumbnailMessage(container, "画像は未保存です。現在アクセスできないため取得できません。");
      } else {
        const progress = state.status.thumbnailProgress;
        const pending = progress?.state === "running" || progress?.state === "waiting";
        showThumbnailMessage(container, pending ? "画像の自動取得を待っています" : "画像はまだ保存されていません");
      }
      continue;
    }
    const showImageFailure = () => {
      if (isCurrent()) {
        showThumbnailMessage(container, "保存画像を表示できませんでした", "再読み込み", renderWorlds);
      }
    };
    try {
      const objectUrl = URL.createObjectURL(record.blob);
      activeThumbnailObjectUrls.add(objectUrl);
      const image = document.createElement("img");
      image.addEventListener("error", () => {
        URL.revokeObjectURL(objectUrl);
        activeThumbnailObjectUrls.delete(objectUrl);
        showImageFailure();
      }, { once: true });
      image.alt = `「${world.currentName ?? "名前を確認できないワールド"}」の保存済みサムネイル`;
      image.loading = "lazy";
      image.decoding = "async";
      image.src = objectUrl;
      container.replaceChildren(image);
    } catch {
      showImageFailure();
    }
  }
}

function renderEvents() {
  const hidden = hiddenWorldIds(state.worldDispositions);
  const expanded = new Set(Array.from(eventList.querySelectorAll(".event-card")).filter((card) => card.querySelector("details")?.open).map((card) => /** @type {HTMLElement} */ (card).dataset.eventId));
  const active = document.activeElement;
  const focusedEvent = active instanceof HTMLElement && eventList.contains(active) ? active.closest(".event-card") : null;
  const focusedId = focusedEvent instanceof HTMLElement ? focusedEvent.dataset.eventId : null;
  const requestedFilter = eventFilter.value;
  const filter = VALID_EVENT_FILTERS.has(requestedFilter)
    ? /** @type {"attention" | "all" | "renamed" | "group" | "missing" | "unavailable" | "restored"} */ (requestedFilter)
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
    eventList.append(createEventCard(event, worlds.get(event.worldId), histories.get(event.worldId) ?? [], hidden.has(event.worldId)));
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
  for (const card of eventList.querySelectorAll(".event-card")) {
    const details = card.querySelector("details");
    const id = /** @type {HTMLElement} */ (card).dataset.eventId;
    if (details !== null && expanded.has(id)) details.open = true;
    if (id === focusedId && !recordDialogs.some(({dialog}) => dialog.open)) card.querySelector("summary")?.focus();
  }
}

/**
 * @param {HTMLElement} container
 * @param {string} message
 * @param {string} [actionLabel]
 * @param {() => void} [action]
 */
function showThumbnailMessage(container, message, actionLabel, action) {
  const content = textElement("div", "thumbnail-message", "");
  content.append(textElement("span", "", message));
  if (actionLabel !== undefined && action !== undefined) {
    const button = /** @type {HTMLButtonElement} */ (textElement("button", "thumbnail-retry", actionLabel));
    button.type = "button";
    button.addEventListener("click", action);
    content.append(button);
  }
  container.replaceChildren(content);
}

/**
 * @param {HistoryEvent} event
 * @param {WorldRecord | undefined} world
 * @param {readonly HistoryEvent[]} history
 * @param {boolean} hidden
 * @returns {HTMLElement}
 */
function createEventCard(event, world, history, hidden) {
  const presentation = presentEventKind(event.kind);
  const card = textElement("article", "event-card", "");
  card.dataset.eventId = event.eventId;
  const content = document.createElement("div");
  const worldName =
    world?.currentName ?? (event.kind === "name_changed" ? event.after : event.worldId);
  content.append(
    textElement("h3", "", `${presentation.title} · ${worldName}`),
    textElement("p", "event-detail", eventDetail(event, world, state.favoriteGroups)),
    textElement("p", "event-detail", `${formatDateTime(event.observedAt)} · ${event.worldId}`)
  );
  if (hidden) {
    content.querySelector("h3")?.append(textElement("span", "state-tag is-hidden history-hidden-label", "非表示"));
  }
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
  settingsUnreadEvents.textContent = state.status.unreadSummary.uncertain ? "未読件数は未確定" : `${state.status.unreadCount.toLocaleString("ja-JP")}件`;
  settingsUnreadDetail.hidden = !state.status.unreadSummary.uncertain;
  settingsUnreadDetail.textContent = state.status.unreadSummary.uncertain ? UNREAD_UNCERTAIN_DETAIL : "";
  settingsWorldCount.textContent = `${state.worlds.length.toLocaleString("ja-JP")}件（非表示${state.status.hiddenCount.toLocaleString("ja-JP")}件）`;
  settingsEventCount.textContent = `${state.events.length.toLocaleString("ja-JP")}件`;
  settingsGroupCount.textContent = `${state.favoriteGroups.length.toLocaleString("ja-JP")}件`;
  settingsThumbnailCount.textContent = state.thumbnailCount === null ? "確認できません" : `${state.thumbnailCount.toLocaleString("ja-JP")}件`;
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
    warnings.push("概算使用量が250MiB以上あります。");
  }
  storageWarning.hidden = warnings.length === 0;
  storageWarning.textContent = warnings.length === 0
    ? ""
    : `${warnings.join(" ")} 大切な記録をバックアップしてください。`;

  const hasProfile = state.profile !== null;
  exportButton.disabled = !hasProfile || restoring || purging || recordMutationInFlight;
  importInput.disabled = repository === null || state.status.syncing || restoring || purging || manualSyncInFlight || recordMutationInFlight;
  autoSyncToggle.disabled = restoring || purging;
  notificationToggle.disabled = restoring || purging;
  purgeUninstallButton.disabled = repository === null || state.status.syncing || restoring || purging || manualSyncInFlight || recordMutationInFlight;
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
    if (!(candidate instanceof HTMLAnchorElement)) continue;
    const active = candidate.dataset.tab === tabName;
    candidate.classList.toggle("is-active", active);
    if (active) candidate.setAttribute("aria-current", "page");
    else candidate.removeAttribute("aria-current");
  }
  for (const name of VALID_TABS) {
    const panel = requiredElement(`${name}-panel`);
    panel.hidden = name !== tabName;
    if (name === tabName && moveFocus) panel.focus();
  }
}

/**
 * Interpret only known local tab routes. Unknown or malformed hashes always
 * fall back to the attention worlds view.
 *
 * @param {string} hash
 * @returns {string}
 */
function initialTabFromHash(hash) {
  const routeName = hash.startsWith("#") ? hash.slice(1) : "";
  if (routeName === "attention") {
    return "worlds";
  }
  if (routeName === "attention-events") {
    return "events";
  }
  const tabName = routeName;
  return VALID_TABS.has(tabName) ? tabName : "worlds";
}

/**
 * Only an explicit #all route opens every record. Unknown routes fail back to
 * the focused attention view; no hash is used as an unchecked filter value.
 *
 * @param {string} hash
 */
function applyInitialRouteFilters(hash) {
  worldFilter.value = hash === "#hidden" ? "hidden" : hash === "#all" ? "all" : "attention";
  eventFilter.value = hash === "#attention-events" ? "attention" : "all";
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
    await loadData(null, true);
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

for (const name of VALID_TABS) requiredElement(`${name}-panel`).tabIndex = -1;
applyInitialRouteFilters(window.location.hash);
const initialTab = initialTabFromHash(window.location.hash);
activateTab(initialTab);

function navigateFromHash() {
  navigationEpoch += 1;
  closeRecordDialogs(false);
  recordActionMessage.textContent = "";
  const tab = initialTabFromHash(window.location.hash);
  if (tab === "worlds") {
    applyInitialRouteFilters(window.location.hash);
    worldSearch.value = "";
    groupFilter.value = "";
    visibleWorldCount = PAGE_SIZE;
    renderWorlds();
  } else if (tab === "events") {
    eventFilter.value = window.location.hash === "#attention-events" ? "attention" : "all";
    renderEvents();
    void markHistoryAsRead();
  }
  activateTab(tab, true);
}
window.addEventListener("hashchange", navigateFromHash);
for (const link of document.querySelectorAll("a[href^=\"#\"]")) {
  link.addEventListener("click", () => {
    if (link.getAttribute("href") === window.location.hash) navigateFromHash();
  });
}

// A command may finish after the user has moved on to another control. Observe
// focus-only moves as well as edits, without making the pending write stale.
function observeRecordInteraction() {
  recordInteractionEpoch += 1;
}
for (const eventName of ["focusin", "pointerdown", "keydown"]) {
  document.addEventListener(eventName, observeRecordInteraction, true);
}

worldSearch.addEventListener("input", () => {
  observeRecordInteraction();
  visibleWorldCount = PAGE_SIZE;
  renderWorlds();
});
worldFilter.addEventListener("change", () => {
  observeRecordInteraction();
  closeRecordDialogs(false);
  visibleWorldCount = PAGE_SIZE;
  renderWorlds();
});
groupFilter.addEventListener("change", () => {
  observeRecordInteraction();
  visibleWorldCount = PAGE_SIZE;
  renderWorlds();
});
eventFilter.addEventListener("change", () => {
  observeRecordInteraction();
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
  if (state.status.syncing || purging || manualSyncInFlight || recordMutationInFlight) return;
  if (restoring) {
    showNotice(
      "バックアップを復元しています",
      "復元が終わってから、もう一度「今すぐ確認」を押してください。"
    );
    return;
  }
  let resultsReloaded = false;
  manualSyncInFlight = true;
  state.status = { ...state.status, syncing: true };
  renderConnection();
  renderSettings();
  renderPrimaryFocus();
  try {
    const response = normalizeCommandResponse(
      await sendMessage({ type: "START_SYNC", trigger: "manual" })
    );
    if (!response.ok) {
      state.status = { ...state.status, syncing: false };
      renderConnection();
      renderPrimaryFocus();
      showNotice("確認を開始できませんでした", commandErrorMessage(response.error, response.retryAt));
      return;
    }
    resultsReloaded = await loadData();
  } catch {
    state.status = { ...state.status, syncing: false };
    renderConnection();
    renderPrimaryFocus();
    showNotice(
      "確認を開始できませんでした",
      "拡張を開き直して、もう一度お試しください。保存済みの記録はそのままです。"
    );
  } finally {
    manualSyncInFlight = false;
    if (resultsReloaded) renderConnection();
    renderPrimaryFocus();
    syncNowButton.disabled = state.status.syncing || restoring || purging;
    syncNowButton.textContent = state.status.syncing ? "確認しています…" : "今すぐ確認";
    renderSettings();
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

/** @param {unknown} error @param {boolean} downloadStarted */
function backupExportErrorMessage(error, downloadStarted) {
  if (downloadStarted) return "ファイルの書き出しを開始しましたが、最終バックアップ日時を記録できませんでした。ファイルが保存されているか確認してください。";
  if (error instanceof BackupExportLimitError) {
    if (error.code === "DISPOSITIONS_LIMIT") return "非表示・削除済みIDが10,000件の上限を超えるため、バックアップを書き出せません。記録を自動で省略せず処理を停止しました";
    if (error.code === "SIZE_LIMIT") return "バックアップが25MiBの上限を超えるため、バックアップを書き出せません。記録を自動で省略せず処理を停止しました";
  }
  return "バックアップを作成できませんでした。少し時間をあけて、もう一度お試しください。";
}

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
  } catch (error) {
    backupMessage.textContent = backupExportErrorMessage(error, downloadStarted);
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
  if (recordMutationInFlight || purging || restoring) return;
  closeRecordDialogs(false);
  restoring = true;
  progressEpoch += 1;
  thumbnailRenderGeneration += 1;
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
    const localSummary = summarizeHistory(state.worlds, state.events, state.worldDispositions);
    state.status = {
      ...freshStatus,
      worldCount: state.worlds.length,
      eventCount: state.events.length,
      attentionWorldCount: localSummary.attention,
      missingCount: localSummary.missing,
      unavailableCount: localSummary.unavailable
    };
    state.statusAvailable = true;
    if (freshStatus.syncing) {
      backupMessage.textContent =
        "お気に入りを確認中のため復元を開始しませんでした。確認が終わってから、もう一度バックアップを選んでください。";
      return;
    }
    const preview = backupSummary(validated);
    const previewName = preview.displayName.replace(/\s+/gu, " ").slice(0, 80);
    const legacyWarning = preview.sourceVersion < 3 ? "\nこの旧形式には非表示・削除済みIDがありません。以前に削除した名前や履歴がファイルに含まれていれば、記録へ戻ります" : "";
    const approved = globalThis.confirm(
      `${previewName}（${preview.userId}）の記録を復元します。\nワールド: ${preview.worldCount.toLocaleString("ja-JP")}件 / 履歴: ${preview.eventCount.toLocaleString("ja-JP")}件\n書き出し日時: ${formatDateTime(preview.exportedAt)}\n\n同じユーザーの現在の記録は、このバックアップの内容に置き換わります。\n表示/非表示・削除済みIDの扱いもバックアップの状態へ戻ります${legacyWarning}\n画像はこのJSONから復元できません。端末に残っている画像は引き続き利用します\n\n続けますか？`
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
      restoredDataLoaded = await loadData(restored.userId);
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
  progressEpoch += 1;
  thumbnailRenderGeneration += 1;
  state.profile = null;
  state.worlds = [];
  state.events = [];
  state.favoriteGroups = [];
  state.worldDispositions = [];
  closeRecordDialogs(false);
  state.thumbnailCount = 0;
  state.status = normalizeStatusResponse({});
  state.settings.lastBackupAt = null;
  state.storageEstimate = { usage: 0, quota: state.storageEstimate.quota };
  renderAll();
  purgeMessage.textContent = message;
}

purgeUninstallButton.addEventListener("click", async () => {
  if (repository === null || purging || recordMutationInFlight) {
    return;
  }
  const approved = globalThis.confirm(
    `このブラウザ内の記録をすべて削除します。\n\nワールド: ${state.worlds.length.toLocaleString("ja-JP")}件\n変更履歴: ${state.events.length.toLocaleString("ja-JP")}件\nお気に入りリスト: ${state.favoriteGroups.length.toLocaleString("ja-JP")}件\n\nこの操作は元に戻せません。必要な記録は先にバックアップしてください。書き出したJSONバックアップ、ダウンロードしたZIP、展開フォルダは自動では削除されません。\n\n続けて拡張を削除しますか？`
  );
  if (!approved) {
    purgeMessage.textContent = "削除を取り消しました。記録は変更していません。";
    return;
  }

  closeRecordDialogs(false);
  purging = true;
  progressEpoch += 1;
  thumbnailRenderGeneration += 1;
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

function renderThumbnailProgressNotice() {
  const progress = presentThumbnailProgress(state.status.thumbnailProgress, { savedCount: state.thumbnailCount, hasProfile: state.profile !== null });
  const warning = state.thumbnailCount === null
    ? "保存画像の件数を読み込めませんでした。ワールドと履歴は表示しています。画像の状態は自動で再確認します。"
    : "";
  thumbnailCaptureNotice.textContent = [progress, warning].filter(Boolean).join(" ");
  thumbnailCaptureNotice.hidden = thumbnailCaptureNotice.textContent.length === 0;
}

// Refresh only local observations and visible images; never start a sync here.
/** @param {UiStatus} status @returns {Promise<boolean>} Whether the saved results were reloaded. */
async function refreshObservedStatus(status) {
  const profileChanged = status.activeProfileId !== null && status.activeProfileId !== state.profile?.userId;
  const savedResultsChanged = status.lastSuccessfulSyncAt !== null
    && status.lastSuccessfulSyncAt !== state.status.lastSuccessfulSyncAt;
  const generationChanged = status.generation !== state.status.generation
    || status.presentationGeneration !== state.status.presentationGeneration;
  if (status.activeProfileId !== (state.profile?.userId ?? null)) closeRecordDialogs(false);
  else if (generationChanged) invalidateRecordDialog();
  if (profileChanged || savedResultsChanged || generationChanged) {
    try {
      await loadData(null, true);
    } catch {
      if (!pageClosed && !restoring && !purging) {
        state.statusAvailable = false;
        renderConnection();
        renderPrimaryFocus();
        showNotice("最新の記録を読み込めませんでした", "保存済みの記録を変更せず、次の表示更新で再確認します。");
      }
    }
    return true;
  }
  const fields = /** @type {const} */ (["syncing", "authRequired", "nextSyncAt", "lastResult", "pendingProbeCount", "unreadCount", "unreadSummary", "favoriteGroupStatus"]);
  const changed = !state.statusAvailable || fields.some((field) => JSON.stringify(state.status[field]) !== JSON.stringify(status[field]));
  state.statusAvailable = true;
  state.status = {...state.status, ...Object.fromEntries(fields.map((field) => [field, status[field]]))};
  if (changed) {
    renderConnection();
    renderPrimaryFocus();
    renderSummary();
    renderSettings();
  }
  return false;
}

async function refreshThumbnailProgress() {
  if (pageClosed || document.hidden || restoring || purging || progressPolling || recordMutationInFlight || repository === null) return;
  progressPolling = true;
  const epoch = progressEpoch;
  const profileId = state.profile?.userId;
  const database = repository;
  const current = () => !pageClosed && !restoring && !purging && epoch === progressEpoch
    && repository === database && state.profile?.userId === profileId;
  try {
    const response = await sendMessage({ type: "GET_STATUS" });
    if (!current()) return;
    if (isRecord(response) && response.ok === false) throw new Error("Status request failed");
    const status = normalizeStatusResponse(response);
    if (await refreshObservedStatus(status)) return;
    if (!current() || status.activeProfileId !== profileId) return;
    const previousProgress = state.status.thumbnailProgress;
    const previousSavedCount = state.status.thumbnailSavedCount;
    state.status.thumbnailSavedCount = status.thumbnailSavedCount;
    state.status.thumbnailProgress = status.thumbnailProgress;
    renderThumbnailProgressNotice();
    const progress = status.thumbnailProgress;
    const imageStatusChanged = JSON.stringify(previousProgress) !== JSON.stringify(progress)
      || previousSavedCount !== status.thumbnailSavedCount;
    if (imageStatusChanged || progress?.state === "running" || progress?.state === "waiting") {
      const ids = new Set(Array.from(worldList.querySelectorAll(".world-card[data-world-id]"))
        .filter((card) => card instanceof HTMLElement)
        .filter((card) => card.querySelector(".world-thumbnail img") === null)
        .map((card) => card.dataset.worldId));
      await hydrateWorldThumbnails(state.worlds.filter((world) => ids.has(world.worldId)), thumbnailRenderGeneration);
    }
    if (!current()) return;
    if ((imageStatusChanged || state.thumbnailCount === null) && profileId !== undefined) {
      const count = await readThumbnailCount(database, profileId);
      if (!current()) return;
      state.thumbnailCount = count;
      settingsThumbnailCount.textContent = count === null ? "確認できません" : `${count.toLocaleString("ja-JP")}件`;
      renderThumbnailProgressNotice();
    }
  } catch {
    if (current()) {
      state.statusAvailable = false;
      renderConnection();
      renderPrimaryFocus();
      thumbnailCaptureNotice.textContent = `${presentThumbnailProgress(null, { savedCount: state.thumbnailCount, hasProfile: state.profile !== null })} 画像の保存状況を読み込めませんでした。自動で表示を再確認します。保存済みの記録はそのままです。`;
      thumbnailCaptureNotice.hidden = false;
    }
  } finally {
    progressPolling = false;
  }
}
const progressTimer = setInterval(() => { void refreshThumbnailProgress(); }, 3_000);
document.addEventListener("visibilitychange", () => { void refreshThumbnailProgress(); });

window.addEventListener(
  "pagehide",
  () => {
    pageClosed = true;
    closeRecordDialogs(false);
    progressEpoch += 1;
    thumbnailRenderGeneration += 1;
    clearInterval(progressTimer);
    clearThumbnailObjectUrls();
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
  primaryFocusTitle.textContent = "記録を読み込めませんでした";
  primaryFocusDetail.textContent = "保存済みのワールドをまだ確認できていません。ブラウザを再起動して開き直してください。";
  syncNowButton.disabled = true;
  exportButton.disabled = true;
  importInput.disabled = true;
  purgeUninstallButton.disabled = true;
  showNotice(
    "ローカルの記録を読み込めませんでした",
    "ブラウザを再起動してから、この画面をもう一度開いてください。"
  );
}
