// @ts-check

import { mountAuthStatusPanel } from "./lib/auth-status-ui.js";

import {
  commandErrorMessage,
  formatDateTime,
  isRecord,
  normalizeCommandResponse,
  normalizeStatusResponse,
  UNREAD_UNCERTAIN_DETAIL,
  presentStatus,
  presentWorldOverview,
  presentThumbnailProgress
} from "./lib/ui.js";

const thumbnailProgress = requiredElement("thumbnail-progress");
let pageClosed = false;
let statusRequest = 0;
/** @type {number | null} */
let lastKnownThumbnailSavedCount = null;
let statusPolling = false;
let syncInFlight = false;
let lastKnownSyncing = false;
/** @type {Promise<void> | null} */
let statusInFlight = null;

const statusCard = requiredElement("status-card");
const statusDot = requiredElement("status-dot");
const statusTitle = requiredElement("status-title");
const statusDetail = requiredElement("status-detail");
const lastSync = requiredElement("last-sync");
const attentionCard = requiredElement("attention-card");
const attentionTitle = requiredElement("attention-title");
const attentionDetail = requiredElement("attention-detail");
const actionMessage = requiredElement("action-message");
const syncButton = /** @type {HTMLButtonElement} */ (requiredElement("sync-button"));
const loginButton = /** @type {HTMLButtonElement} */ (requiredElement("login-button"));
const dashboardButton = /** @type {HTMLButtonElement} */ (requiredElement("dashboard-button"));

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
 * @param {Record<string, unknown>} message
 * @returns {Promise<unknown>}
 */
async function sendMessage(message) {
  return /** @type {unknown} */ (await chrome.runtime.sendMessage(message));
}

function refreshStatus() {
  if (statusInFlight !== null) return statusInFlight;
  statusInFlight = readStatus().finally(() => { statusInFlight = null; });
  return statusInFlight;
}

async function readStatus() {
  const request = ++statusRequest;
  const response = await sendMessage({ type: "GET_STATUS" });
  if (pageClosed || request !== statusRequest) return;
  if (isRecord(response) && response.ok === false) {
    throw new Error("Status request failed");
  }
  const status = normalizeStatusResponse(response);
  lastKnownThumbnailSavedCount = status.activeProfileId === null ? null : status.thumbnailSavedCount;
  thumbnailProgress.textContent = presentThumbnailProgress(status.thumbnailProgress, { savedCount: status.thumbnailSavedCount, hasProfile: status.activeProfileId !== null });
  thumbnailProgress.hidden = thumbnailProgress.textContent.length === 0;
  const presentation = presentStatus(status);
  const hasBaseline = status.activeProfileId !== null && status.lastSuccessfulSyncAt !== null;
  const overview = presentWorldOverview(status, {hasProfile: status.activeProfileId !== null});
  const attentionCount = Math.max(status.attentionWorldCount, status.unavailableCount, status.missingCount);
  const hasAttention = attentionCount > 0;
  const unreadSummary = requiredElement("unread-summary");
  unreadSummary.hidden = !status.unreadSummary.uncertain;
  unreadSummary.textContent = status.unreadSummary.uncertain ? `未読件数は未確定。${UNREAD_UNCERTAIN_DETAIL}` : "";
  attentionCard.classList.toggle("is-alert", hasAttention);
  attentionTitle.textContent = overview.title;
  attentionDetail.textContent = hasAttention
    ? "保存済みの名前と画像で確認できます。削除・非公開・手動解除の区別はできません。"
    : !hasBaseline
      ? "上のログイン確認を参考に「今すぐ確認」を押してください。記録前に消えたワールドは復元できません。"
      : status.syncing
        ? "前回の記録を表示しています。この画面を閉じても確認は続きます。"
        : "前回の確認結果です。保存済みの記録は下のボタンから開けます。";
  if (!hasAttention && status.hiddenCount > 0) {
    attentionDetail.textContent = `非表示の記録が${status.hiddenCount.toLocaleString("ja-JP")}件あります。記録画面で確認できます`;
  }
  dashboardButton.textContent = hasAttention ? "名前と画像を見る" : "保存済みの記録を見る";
  dashboardButton.className = `button ${hasBaseline ? "button-primary" : "button-secondary"}`;

  statusCard.hidden = !status.syncing && presentation.tone !== "error" && status.pendingProbeCount === 0 && status.favoriteGroupStatus !== "stale";
  const operationalPresentation = presentation.tone === "attention"
    ? {tone: "ready", title: "前回の確認は完了しています", detail: status.pendingProbeCount > 0 ? `個別確認待ちが${status.pendingProbeCount.toLocaleString("ja-JP")}件あります。` : "保存済みの記録を表示しています。"}
    : presentation;
  statusDot.className = `status-dot is-${operationalPresentation.tone}`;
  statusTitle.textContent = operationalPresentation.title;
  const groupNameWarning = status.favoriteGroupStatus === "stale"
    ? " お気に入りリスト名は、前回確認できた名前を表示しています。"
    : "";
  statusDetail.textContent = `${operationalPresentation.detail}${groupNameWarning}`;
  lastSync.textContent = status.lastSuccessfulSyncAt === null
    ? "前回の同期成功: まだありません"
    : `前回の同期成功: ${formatDateTime(status.lastSuccessfulSyncAt)}`;
  lastKnownSyncing = status.syncing;
  syncButton.disabled = status.syncing || syncInFlight;
  syncButton.textContent = syncButton.disabled ? "確認しています…" : "今すぐ確認";
  syncButton.className = `button ${hasBaseline ? "button-secondary" : "button-primary"}`;
  loginButton.hidden = status.syncing || (hasBaseline && !status.authRequired);

}

function showUnavailableStatus() {
  if (pageClosed) return;
  const saved = lastKnownThumbnailSavedCount === null ? "" : `保存済み画像${lastKnownThumbnailSavedCount.toLocaleString("ja-JP")}件。`;
  thumbnailProgress.textContent = `${saved}画像の保存状況を読み込めませんでした。自動で表示を再確認します。保存済みの記録はそのままです。`;
  thumbnailProgress.hidden = false;
  statusCard.hidden = false;
  statusDot.className = "status-dot is-error";
  statusTitle.textContent = "状態を読み込めませんでした";
  statusDetail.textContent = "拡張を開き直して、もう一度お試しください。保存済みの記録はそのままです。";
  lastSync.textContent = "前回の同期成功: 読み込めません";
  attentionCard.classList.remove("is-alert");
  attentionTitle.textContent = "最新の状態はまだ確認できていません";
  attentionDetail.textContent = "通信状態を読めない場合も、端末内に保存済みの記録は開けます。";
  dashboardButton.textContent = "保存済みの記録を見る";
}

syncButton.addEventListener("click", async () => {
  if (syncInFlight || lastKnownSyncing) return;
  syncInFlight = true;
  syncButton.disabled = true;
  syncButton.textContent = "確認しています…";
  actionMessage.textContent = "VRChatのお気に入りを確認しています。";
  try {
    const response = normalizeCommandResponse(
      await sendMessage({ type: "START_SYNC", trigger: "manual" })
    );
    if (!response.ok) {
      actionMessage.textContent = commandErrorMessage(response.error, response.retryAt);
      await refreshStatus();
      return;
    }
    actionMessage.textContent = "確認が終わりました。記録を更新しました。";
    await refreshStatus();
  } catch {
    actionMessage.textContent = "確認を開始できませんでした。拡張を開き直して、もう一度お試しください。";
    showUnavailableStatus();
  } finally {
    syncInFlight = false;
    syncButton.disabled = lastKnownSyncing;
    syncButton.textContent = lastKnownSyncing ? "確認しています…" : "今すぐ確認";
  }
});

loginButton.addEventListener("click", async () => {
  loginButton.disabled = true;
  actionMessage.textContent = "";
  try {
    const response = normalizeCommandResponse(await sendMessage({ type: "OPEN_VRCHAT" }));
    if (!response.ok) {
      actionMessage.textContent = commandErrorMessage(response.error, response.retryAt);
    }
  } catch {
    actionMessage.textContent = "VRChat公式サイトを開けませんでした。少し時間をあけて、もう一度お試しください。";
  } finally {
    loginButton.disabled = false;
  }
});

dashboardButton.addEventListener("click", async () => {
  dashboardButton.disabled = true;
  actionMessage.textContent = "";
  try {
    const response = normalizeCommandResponse(await sendMessage({ type: "OPEN_DASHBOARD" }));
    if (!response.ok) {
      actionMessage.textContent = commandErrorMessage(response.error, response.retryAt);
    }
  } catch {
    actionMessage.textContent = "記録画面を開けませんでした。拡張を開き直して、もう一度お試しください。";
  } finally {
    dashboardButton.disabled = false;
  }
});

const progressTimer = setInterval(async () => {
  if (pageClosed || document.hidden || statusPolling) return;
  statusPolling = true;
  try {
    await refreshStatus();
  } catch {
    showUnavailableStatus();
  } finally {
    statusPolling = false;
  }
}, 3_000);
window.addEventListener("pagehide", () => {
  pageClosed = true;
  statusRequest += 1;
  clearInterval(progressTimer);
}, { once: true });

mountAuthStatusPanel({document, window, sendMessage});

try {
  await refreshStatus();
} catch {
  showUnavailableStatus();
}
