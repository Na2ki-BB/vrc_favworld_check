// @ts-check

import {
  commandErrorMessage,
  formatDateTime,
  isRecord,
  normalizeCommandResponse,
  normalizeStatusResponse,
  presentStatus
} from "./lib/ui.js";

const statusDot = requiredElement("status-dot");
const statusTitle = requiredElement("status-title");
const statusDetail = requiredElement("status-detail");
const lastSync = requiredElement("last-sync");
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

async function refreshStatus() {
  const response = await sendMessage({ type: "GET_STATUS" });
  if (isRecord(response) && response.ok === false) {
    throw new Error("Status request failed");
  }
  const status = normalizeStatusResponse(response);
  const presentation = presentStatus(status);
  statusDot.className = `status-dot is-${presentation.tone}`;
  statusTitle.textContent = presentation.title;
  const groupNameWarning = status.favoriteGroupStatus === "stale"
    ? " お気に入りリスト名は、前回確認できた名前を表示しています。"
    : "";
  statusDetail.textContent = `${presentation.detail}${groupNameWarning}`;
  lastSync.textContent =
    status.lastSuccessfulSyncAt === null
      ? "最終確認: まだありません"
      : `最終確認: ${formatDateTime(status.lastSuccessfulSyncAt)}`;
  syncButton.disabled = status.syncing;
  syncButton.textContent = status.syncing ? "確認しています…" : "今すぐお気に入りを確認";
  dashboardButton.textContent = status.unreadCount === 0
    ? "記録と設定を詳しく見る →"
    : `記録と設定を詳しく見る（未読${status.unreadCount.toLocaleString("ja-JP")}件） →`;
}

function showUnavailableStatus() {
  statusDot.className = "status-dot is-error";
  statusTitle.textContent = "状態を読み込めませんでした";
  statusDetail.textContent = "拡張を開き直して、もう一度お試しください。保存済みの記録はそのままです。";
  lastSync.textContent = "最終確認: 読み込めません";
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
    syncButton.textContent = "今すぐお気に入りを確認";
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

try {
  await refreshStatus();
} catch {
  showUnavailableStatus();
}
