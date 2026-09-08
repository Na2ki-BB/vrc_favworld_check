// @ts-check

import {
  commandErrorMessage,
  formatDateTime,
  isRecord,
  normalizeCommandResponse,
  normalizeStatusResponse,
  presentStatus,
  presentThumbnailProgress
} from "./lib/ui.js";

const thumbnailProgress = requiredElement("thumbnail-progress");
let pageClosed = false;
let statusRequest = 0;
/** @type {number | null} */
let lastKnownThumbnailSavedCount = null;
let statusPolling = false;
/** @type {Promise<void> | null} */
let statusInFlight = null;

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
  const operationalPresentation = presentation.tone === "attention"
    ? {
        tone: "ready",
        title: "前回の確認は完了しています",
        detail: "保存済みの要確認ワールドは、上のボタンから確認できます。"
      }
    : presentation;
  statusDot.className = `status-dot is-${operationalPresentation.tone}`;
  statusTitle.textContent = operationalPresentation.title;
  const groupNameWarning = status.favoriteGroupStatus === "stale"
    ? " お気に入りリスト名は、前回確認できた名前を表示しています。"
    : "";
  statusDetail.textContent = `${operationalPresentation.detail}${groupNameWarning}`;
  lastSync.textContent =
    status.lastSuccessfulSyncAt === null
      ? "最終確認: まだありません"
      : `最終確認: ${formatDateTime(status.lastSuccessfulSyncAt)}`;
  syncButton.disabled = status.syncing;
  syncButton.textContent = status.syncing ? "確認しています…" : "今すぐ確認";
  const attentionCount = Math.max(
    status.attentionWorldCount,
    status.unavailableCount,
    status.missingCount
  );
  const hasAttention = attentionCount > 0;
  attentionCard.classList.toggle("is-alert", hasAttention);
  if (status.unavailableCount > 0) {
    attentionTitle.textContent = `要確認のワールドが${attentionCount.toLocaleString("ja-JP")}件あります`;
    attentionDetail.textContent = `現在アクセス不可${status.unavailableCount.toLocaleString("ja-JP")}件を最優先で表示します。保存済みの名前と画像を確認できます。`;
    dashboardButton.textContent = "記録とサムネイルを見る";
  } else if (hasAttention) {
    attentionTitle.textContent = `お気に入り一覧から外れたワールドが${attentionCount.toLocaleString("ja-JP")}件あります`;
    attentionDetail.textContent = "手動でお気に入り解除した場合も含まれます。保存済みの情報を確認できます。";
    dashboardButton.textContent = "記録とサムネイルを見る";
  } else {
    attentionTitle.textContent = "現在、消えた可能性のあるワールドはありません";
    attentionDetail.textContent = "ここからいつでも、保存済みの名前・画像・状態を確認できます。";
    dashboardButton.textContent = "記録とサムネイルを見る";
  }
}

function showUnavailableStatus() {
  if (pageClosed) return;
  const saved = lastKnownThumbnailSavedCount === null ? "" : `保存済み画像${lastKnownThumbnailSavedCount.toLocaleString("ja-JP")}件。`;
  thumbnailProgress.textContent = `${saved}画像の保存状況を読み込めませんでした。自動で表示を再確認します。保存済みの記録はそのままです。`;
  thumbnailProgress.hidden = false;
  statusDot.className = "status-dot is-error";
  statusTitle.textContent = "状態を読み込めませんでした";
  statusDetail.textContent = "拡張を開き直して、もう一度お試しください。保存済みの記録はそのままです。";
  lastSync.textContent = "最終確認: 読み込めません";
  attentionCard.classList.remove("is-alert");
  attentionTitle.textContent = "保存済みの消えたワールドを確認";
  attentionDetail.textContent = "通信状態を読めない場合も、端末内に保存済みの記録は開けます。";
  dashboardButton.textContent = "記録とサムネイルを見る";
}

syncButton.addEventListener("click", async () => {
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
    syncButton.disabled = false;
    syncButton.textContent = "今すぐ確認";
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

try {
  await refreshStatus();
} catch {
  showUnavailableStatus();
}
