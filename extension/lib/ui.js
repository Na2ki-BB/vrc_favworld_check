// @ts-check

import { normalizeSearchText } from "./domain.js";
import {
  createFavoriteGroupLabelMap,
  getFavoriteGroupLabel
} from "./favorite-groups.js";

/** @typedef {import("./database.js").DatabaseRepository} DatabaseRepository */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listWorlds"]>>[number]} WorldRecord */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listEvents"]>>[number]} HistoryEvent */
/** @typedef {Awaited<ReturnType<DatabaseRepository["listFavoriteGroups"]>>[number]} FavoriteGroupRecord */

/**
 * @typedef {object} UiStatus
 * @property {boolean} syncing
 * @property {boolean} authRequired
 * @property {string | null} lastSuccessfulSyncAt
 * @property {string | null} nextSyncAt
 * @property {string | null} activeProfileId
 * @property {number} worldCount
 * @property {number} eventCount
 * @property {number} pendingProbeCount
 * @property {number} unreadCount
 * @property {"success" | "stale" | null} favoriteGroupStatus
 * @property {string | null} lastResult
 */

/**
 * @typedef {object} StatusPresentation
 * @property {"idle" | "ready" | "working" | "error"} tone
 * @property {string} title
 * @property {string} detail
 */

const RESULT_CODES = Object.freeze({
  success: "success",
  authRequired: "auth_required",
  rateLimited: "rate_limited",
  offline: "offline",
  incompatible: "api_incompatible",
  failed: "failed"
});

const EVENT_PRESENTATIONS = Object.freeze({
  name_changed: {
    title: "ワールド名が変わりました",
    tag: "名前変更"
  },
  favorite_missing_confirmed: {
    title: "お気に入り一覧にないことを確認しました",
    tag: "一覧にない"
  },
  favorite_restored: {
    title: "お気に入り一覧へ戻りました",
    tag: "お気に入り復帰"
  },
  access_unavailable_confirmed: {
    title: "現在アクセスできないことを確認しました",
    tag: "アクセス不可"
  },
  access_restored: {
    title: "アクセスできる状態へ戻りました",
    tag: "アクセス復帰"
  },
  favorite_group_changed: {
    title: "お気に入りリストが変わりました",
    tag: "リスト変更"
  }
});

export const SYNC_STALE_AFTER_MS = 36 * 60 * 60 * 1_000;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Convert a loosely typed service-worker response into the small status model
 * used by extension pages. Unknown fields never become user-visible text.
 *
 * @param {unknown} response
 * @returns {UiStatus}
 */
export function normalizeStatusResponse(response) {
  const envelope = isRecord(response) ? response : {};
  const candidate = isRecord(envelope.status) ? envelope.status : envelope;
  const lastResult = typeof candidate.lastResult === "string" ? candidate.lastResult : null;
  return {
    syncing: candidate.syncing === true,
    authRequired: candidate.authRequired === true || lastResult === RESULT_CODES.authRequired,
    lastSuccessfulSyncAt:
      typeof candidate.lastSuccessfulSyncAt === "string"
        ? candidate.lastSuccessfulSyncAt
        : null,
    nextSyncAt: typeof candidate.nextSyncAt === "string" ? candidate.nextSyncAt : null,
    activeProfileId:
      typeof candidate.activeProfileId === "string" ? candidate.activeProfileId : null,
    worldCount: safeCount(candidate.worldCount),
    eventCount: safeCount(candidate.eventCount),
    pendingProbeCount: safeCount(candidate.pendingProbeCount),
    unreadCount: safeCount(candidate.unreadCount),
    favoriteGroupStatus:
      candidate.favoriteGroupStatus === "success" || candidate.favoriteGroupStatus === "stale"
        ? candidate.favoriteGroupStatus
        : null,
    lastResult
  };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function safeCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * @param {string | null | undefined} value
 * @returns {string}
 */
export function formatDateTime(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "—";
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

/**
 * @param {UiStatus} status
 * @param {number} [now]
 * @returns {StatusPresentation}
 */
export function presentStatus(status, now = Date.now()) {
  if (status.syncing) {
    return {
      tone: "working",
      title: "お気に入りを確認しています",
      detail: "完了するまでこのままお待ちください。"
    };
  }
  if (status.authRequired) {
    return {
      tone: "error",
      title: "VRChatへのログインが必要です",
      detail: "VRChat公式サイトでいつも通りログインしてから、もう一度確認してください。"
    };
  }
  if (status.lastResult === RESULT_CODES.rateLimited) {
    const retry = status.nextSyncAt === null ? "" : ` 次回は${formatDateTime(status.nextSyncAt)}以降に確認します。`;
    return {
      tone: "error",
      title: "少し時間をあけています",
      detail: `VRChatの混雑を避けるため待機中です。${retry}`.trim()
    };
  }
  if (status.lastResult === RESULT_CODES.offline) {
    return {
      tone: "error",
      title: "インターネットへ接続できません",
      detail: "接続を確認してから、もう一度お試しください。保存済みの記録はそのままです。"
    };
  }
  if (status.lastResult === RESULT_CODES.incompatible) {
    return {
      tone: "error",
      title: "VRChatの応答を確認できません",
      detail: "保存済みの記録は変更していません。拡張の新しい版がないか確認してください。"
    };
  }
  if (status.lastResult === RESULT_CODES.failed) {
    return {
      tone: "error",
      title: "今回は確認できませんでした",
      detail: "保存済みの記録は変更していません。時間をあけてもう一度お試しください。"
    };
  }
  if (status.lastSuccessfulSyncAt === null) {
    return {
      tone: "idle",
      title: "最初の記録を始めましょう",
      detail: "先にVRChat公式サイトへログインし、「今すぐ確認」を押してください。"
    };
  }
  const lastSuccessfulTime = new Date(status.lastSuccessfulSyncAt).getTime();
  if (
    Number.isFinite(lastSuccessfulTime)
    && Number.isFinite(now)
    && now - lastSuccessfulTime > SYNC_STALE_AFTER_MS
  ) {
    return {
      tone: "error",
      title: "36時間以上確認できていません",
      detail: "ブラウザを起動した状態で「今すぐ確認」を押してください。保存済みの記録はそのままです。"
    };
  }
  const pendingDetail = status.pendingProbeCount === 0
    ? ""
    : ` 個別確認待ちが${status.pendingProbeCount.toLocaleString("ja-JP")}件あります。`;
  return {
    tone: "ready",
    title: "お気に入りを記録しています",
    detail: `${status.worldCount.toLocaleString("ja-JP")}件のワールドをこのブラウザ内に保存しています。${pendingDetail}`
  };
}

/**
 * @param {unknown} response
 * @returns {{ ok: true } | { ok: false, error: string, retryAt: string | null }}
 */
export function normalizeCommandResponse(response) {
  if (!isRecord(response) || response.ok !== true) {
    const rawCode = isRecord(response)
      ? typeof response.code === "string"
        ? response.code
        : typeof response.error === "string"
          ? response.error
          : "unavailable"
      : "unavailable";
    return {
      ok: false,
      error: rawCode.toLocaleLowerCase("en-US"),
      retryAt:
        isRecord(response) && typeof response.retryAt === "string" ? response.retryAt : null
    };
  }
  return { ok: true };
}

/**
 * @param {string} code
 * @param {string | null} [retryAt]
 * @returns {string}
 */
export function commandErrorMessage(code, retryAt = null) {
  switch (code) {
    case "auth_required":
      return "VRChat公式サイトでログインしてから、もう一度押してください。";
    case "rate_limited":
    case "cooldown":
    case "manual_cooldown":
      return retryAt === null
        ? "連続確認を避けるため、少し時間をあけてからお試しください。"
        : `${formatDateTime(retryAt)}以降にもう一度お試しください。`;
    case "offline":
      return "インターネット接続を確認してから、もう一度お試しください。";
    case "api_incompatible":
      return "VRChatの応答を確認できません。拡張の新しい版がないか確認してください。";
    case "vrchat_unavailable":
      return "現在VRChat側へ接続しにくい状態です。保存済みの記録はそのままです。時間をあけてお試しください。";
    case "storage_unavailable":
      return "このブラウザ内へ記録を保存できません。ブラウザを再起動してから、もう一度お試しください。";
    case "sync_failed":
      return "今回は確認できませんでした。保存済みの記録はそのままです。時間をあけてお試しください。";
    case "sync_in_progress":
      return "すでに確認中です。完了するまでお待ちください。";
    case "permission_denied":
      return "この操作に必要なブラウザ権限を利用できません。拡張を入れ直してください。";
    case "security_rule_unavailable":
      return "安全な通信設定を確認できませんでした。保存済みの記録は変更していません。拡張を入れ直してからお試しください。";
    case "sync_conflict":
      return "別の保存操作と重なったため、古い結果は反映しませんでした。少し時間をあけて、もう一度お試しください。";
    default:
      return "操作を完了できませんでした。少し時間をあけて、もう一度お試しください。";
  }
}

/**
 * Uninstall may invalidate the extension context before a success envelope can
 * return. Only an explicit dataDeleted=true result may be described as erased.
 *
 * @param {unknown} response
 * @returns {{ ok: true, dataDeleted: true } | { ok: false, error: string, dataDeleted: boolean }}
 */
export function normalizePurgeResponse(response) {
  if (isRecord(response) && response.ok === true && response.dataDeleted === true) {
    return { ok: true, dataDeleted: true };
  }
  const rawError = isRecord(response) && typeof response.error === "string"
    ? response.error
    : "unavailable";
  return {
    ok: false,
    error: rawError.toLocaleLowerCase("en-US"),
    dataDeleted: isRecord(response) && response.dataDeleted === true
  };
}

/**
 * @param {string} code
 * @param {boolean} dataDeleted
 * @returns {string}
 */
export function purgeErrorMessage(code, dataDeleted) {
  if (dataDeleted) {
    return "ブラウザ内の記録は削除済みですが、拡張を自動削除できませんでした。ブラウザの拡張機能管理画面から、この拡張を手動で削除してください。";
  }
  switch (code) {
    case "sync_in_progress":
      return "お気に入りを確認中のため削除を開始しませんでした。確認が終わってから、もう一度お試しください。";
    case "delete_blocked":
      return "別の拡張画面が記録を使用しているため削除できませんでした。ほかのポップアップや記録画面を閉じてから、もう一度お試しください。";
    case "delete_failed":
      return "削除処理を完了できず、ブラウザ内の記録の状態を確認できませんでした。ブラウザを再起動してから、もう一度お試しください。";
    case "uninstall_failed":
      return "削除処理の結果を確認できませんでした。拡張機能管理画面から、記録画面と拡張の状態を確認してください。";
    default:
      return "削除結果を確認できませんでした。この画面を閉じ、ブラウザの拡張機能管理画面で拡張が残っているか確認してください。";
  }
}

/**
 * @param {WorldRecord} world
 * @param {"all" | "favorite" | "missing" | "unavailable" | "pending"} filter
 * @returns {boolean}
 */
export function worldMatchesFilter(world, filter) {
  switch (filter) {
    case "favorite":
      return world.membershipState === "favorited";
    case "missing":
      return world.membershipState === "not_in_favorites";
    case "unavailable":
      return world.availabilityState === "unavailable";
    case "pending":
      return (
        world.membershipState === "missing_once" ||
        world.availabilityState === "unknown" ||
        world.availabilityState === "unavailable_once" ||
        world.probeState === "pending"
      );
    default:
      return true;
  }
}

/**
 * Search the current name, historical names, author, immutable world ID, and
 * favorite-list display names. The optional fifth argument preserves the
 * original four-argument call contract.
 *
 * @param {readonly WorldRecord[]} worlds
 * @param {readonly HistoryEvent[]} events
 * @param {string} query
 * @param {"all" | "favorite" | "missing" | "unavailable" | "pending"} filter
 * @param {string | null} [groupTag]
 * @param {readonly FavoriteGroupRecord[]} [favoriteGroups]
 * @returns {WorldRecord[]}
 */
export function filterWorlds(
  worlds,
  events,
  query,
  filter,
  groupTag = null,
  favoriteGroups = []
) {
  const normalizedQuery = normalizeSearchText(query);
  /** @type {Map<string, string[]>} */
  const historicalNames = new Map();
  /** @type {Map<string, Set<string>>} */
  const historicalGroupTags = new Map();
  for (const event of events) {
    if (event.kind === "name_changed") {
      const names = historicalNames.get(event.worldId) ?? [];
      names.push(event.before, event.after);
      historicalNames.set(event.worldId, names);
    } else if (event.kind === "favorite_group_changed") {
      const tags = historicalGroupTags.get(event.worldId) ?? new Set();
      for (const tag of [...parseFavoriteGroupTags(event.before), ...parseFavoriteGroupTags(event.after)]) {
        tags.add(tag);
      }
      historicalGroupTags.set(event.worldId, tags);
    }
  }

  return worlds
    .filter((world) => worldMatchesFilter(world, filter))
    .filter((world) => groupTag === null || groupTag.length === 0 || world.favoriteTags.includes(groupTag))
    .filter((world) => {
      if (normalizedQuery.length === 0) {
        return true;
      }
      const recordedGroupTags = new Set([
        ...world.favoriteTags,
        ...(historicalGroupTags.get(world.worldId) ?? [])
      ]);
      const searchable = [
        world.currentName ?? "",
        world.normalizedName ?? "",
        world.authorName ?? "",
        world.normalizedAuthorName ?? "",
        world.worldId,
        ...(historicalNames.get(world.worldId) ?? []),
        ...favoriteGroupSearchValues([...recordedGroupTags], favoriteGroups)
      ];
      return searchable.some((value) => normalizeSearchText(value).includes(normalizedQuery));
    })
    .sort(compareWorlds);
}

/**
 * @param {readonly HistoryEvent[]} events
 * @param {"all" | "renamed" | "group" | "missing" | "unavailable" | "restored"} filter
 * @returns {HistoryEvent[]}
 */
export function filterEvents(events, filter) {
  return events
    .filter((event) => {
      switch (filter) {
        case "renamed":
          return event.kind === "name_changed";
        case "group":
          return event.kind === "favorite_group_changed";
        case "missing":
          return event.kind === "favorite_missing_confirmed";
        case "unavailable":
          return event.kind === "access_unavailable_confirmed";
        case "restored":
          return event.kind === "favorite_restored" || event.kind === "access_restored";
        default:
          return true;
      }
    })
    .sort((left, right) => {
      const byTime = right.observedAt.localeCompare(left.observedAt);
      return byTime === 0 ? left.eventId.localeCompare(right.eventId) : byTime;
    });
}

/**
 * @param {WorldRecord} left
 * @param {WorldRecord} right
 * @returns {number}
 */
function compareWorlds(left, right) {
  const severityDifference = worldSeverity(right) - worldSeverity(left);
  if (severityDifference !== 0) {
    return severityDifference;
  }
  const leftName = left.currentName ?? left.worldId;
  const rightName = right.currentName ?? right.worldId;
  const byName = leftName.localeCompare(rightName, "ja-JP", { sensitivity: "base" });
  return byName === 0 ? left.worldId.localeCompare(right.worldId) : byName;
}

/**
 * @param {WorldRecord} world
 * @returns {number}
 */
function worldSeverity(world) {
  if (world.availabilityState === "unavailable") {
    return 5;
  }
  if (world.membershipState === "not_in_favorites") {
    return 4;
  }
  if (
    world.availabilityState === "unavailable_once" ||
    world.membershipState === "missing_once" ||
    world.probeState === "pending"
  ) {
    return 3;
  }
  if (world.availabilityState === "unknown") {
    return 2;
  }
  return 1;
}

/**
 * @param {WorldRecord} world
 * @returns {{ label: string, tone: "normal" | "warning" | "pending" }[]}
 */
export function worldStateTags(world) {
  /** @type {{ label: string, tone: "normal" | "warning" | "pending" }[]} */
  const tags = [];
  if (world.membershipState === "favorited") {
    tags.push({ label: "お気に入り中", tone: "normal" });
  } else if (world.membershipState === "not_in_favorites") {
    tags.push({ label: "お気に入り一覧にない", tone: "warning" });
  } else {
    tags.push({ label: "一覧を再確認中", tone: "pending" });
  }

  if (world.availabilityState === "unavailable") {
    tags.push({ label: "現在アクセス不可", tone: "warning" });
  } else if (world.availabilityState === "unavailable_once") {
    tags.push({ label: "アクセス状態を再確認中", tone: "pending" });
  } else if (world.availabilityState === "unknown") {
    tags.push({ label: "アクセス状態未確認", tone: "pending" });
  }
  if (world.probeState === "pending") {
    tags.push({ label: "個別確認待ち", tone: "pending" });
  }
  return tags;
}

/**
 * Map persisted internal favorite tags to user-facing list names. Unknown tags
 * remain visible instead of silently hiding a world's recorded classification.
 *
 * @param {readonly string[]} internalNames
 * @param {readonly FavoriteGroupRecord[]} favoriteGroups
 * @returns {string[]}
 */
export function favoriteGroupLabels(internalNames, favoriteGroups) {
  const labels = createFavoriteGroupLabelMap(favoriteGroups);
  return [...new Set(internalNames)].map((internalName) => (
    getFavoriteGroupLabel(internalName, labels)
  ));
}

/**
 * @param {readonly string[]} internalNames
 * @param {readonly FavoriteGroupRecord[]} favoriteGroups
 * @returns {string[]}
 */
function favoriteGroupSearchValues(internalNames, favoriteGroups) {
  const wanted = new Set(internalNames);
  const values = [...wanted];
  for (const group of favoriteGroups) {
    if (!wanted.has(group.internalName)) {
      continue;
    }
    values.push(group.displayName, group.normalizedDisplayName);
    for (const previous of group.displayNameHistory) {
      values.push(previous.displayName);
    }
  }
  return values;
}

/**
 * Parse the allowlisted JSON array format used by favorite_group_changed.
 * Corrupt legacy data produces an empty list and never reaches the DOM.
 *
 * @param {string} value
 * @returns {string[]}
 */
export function parseFavoriteGroupTags(value) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== "string")) {
      return [];
    }
    return [...new Set(parsed)];
  } catch {
    return [];
  }
}

/**
 * @param {HistoryEvent["kind"]} kind
 * @returns {{ title: string, tag: string }}
 */
export function presentEventKind(kind) {
  return EVENT_PRESENTATIONS[kind] ?? { title: "記録された変更", tag: "変更" };
}

/**
 * @param {HistoryEvent} event
 * @param {WorldRecord | undefined} world
 * @param {readonly FavoriteGroupRecord[]} [favoriteGroups]
 * @returns {string}
 */
export function eventDetail(event, world, favoriteGroups = []) {
  if (event.kind === "name_changed") {
    return `「${event.before}」から「${event.after}」へ変更されました。`;
  }
  if (event.kind === "favorite_missing_confirmed") {
    return "2回続けてお気に入り一覧に見つかりませんでした。手動解除などの理由は断定しません。";
  }
  if (event.kind === "access_unavailable_confirmed") {
    return "個別確認でも2回続けて見つかりませんでした。削除・非公開のどちらかは断定しません。";
  }
  if (event.kind === "favorite_restored") {
    return "お気に入り一覧で再び確認できました。";
  }
  if (event.kind === "access_restored") {
    return "VRChat APIからワールド情報を再び確認できました。";
  }
  if (event.kind === "favorite_group_changed") {
    const before = favoriteGroupLabels(parseFavoriteGroupTags(event.before), favoriteGroups);
    const after = favoriteGroupLabels(parseFavoriteGroupTags(event.after), favoriteGroups);
    if (before.length === 0 && after.length === 0) {
      return "所属するお気に入りリストの記録が変わりました。";
    }
    const beforeLabel = before.length === 0 ? "リストなし" : before.join(" / ");
    const afterLabel = after.length === 0 ? "リストなし" : after.join(" / ");
    return `「${beforeLabel}」から「${afterLabel}」へ変わりました。`;
  }
  return world?.currentName ?? event.worldId;
}

/**
 * Shared progressive-render helper. It copies only the currently visible
 * prefix so callers cannot accidentally mutate the complete result set.
 *
 * @template T
 * @param {readonly T[]} items
 * @param {number} visibleCount
 * @returns {T[]}
 */
export function takeVisibleItems(items, visibleCount) {
  if (!Number.isSafeInteger(visibleCount) || visibleCount <= 0) {
    return [];
  }
  return items.slice(0, visibleCount);
}

/**
 * @param {readonly WorldRecord[]} worlds
 * @param {readonly HistoryEvent[]} events
 * @returns {{ total: number, unavailable: number, missing: number, renamed: number }}
 */
export function summarizeHistory(worlds, events) {
  return {
    total: worlds.length,
    unavailable: worlds.filter((world) => world.availabilityState === "unavailable").length,
    missing: worlds.filter((world) => world.membershipState === "not_in_favorites").length,
    renamed: events.filter((event) => event.kind === "name_changed").length
  };
}
