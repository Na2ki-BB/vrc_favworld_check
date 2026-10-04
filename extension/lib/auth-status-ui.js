// @ts-check

import { commandErrorMessage, isRecord, normalizeCommandResponse } from "./ui.js";

/** @typedef {"authenticated" | "auth_required" | "two_factor_required" | "unknown" | "busy" | "rate_limited"} AuthState */
/** @typedef {{state: AuthState, checkedAt: string | null, retryAt: string | null}} AuthStatus */
/** @typedef {{tone: string, title: string, detail: string, checked: string, retry: string, disabled: boolean, showLogin: boolean}} AuthPresentation */

const AUTH_STATES = new Set(["authenticated", "auth_required", "two_factor_required", "unknown", "busy", "rate_limited"]);

/** @param {unknown} value @returns {string | null} */
function normalizedTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

/** Only allowlisted state and timestamps may reach the login-status UI.
 * @param {unknown} response @returns {AuthStatus}
 */
export function normalizeAuthStatusResponse(response) {
  const fallback = /** @type {AuthStatus} */ ({state: "unknown", checkedAt: null, retryAt: null});
  if (!isRecord(response) || response.ok !== true || !isRecord(response.auth)) return fallback;
  const auth = response.auth;
  if (typeof auth.state !== "string" || !AUTH_STATES.has(auth.state)) return fallback;
  const checkedAt = normalizedTime(auth.checkedAt);
  if (["authenticated", "auth_required", "two_factor_required"].includes(auth.state) && checkedAt === null) return fallback;
  return {state: /** @type {AuthState} */ (auth.state), checkedAt, retryAt: normalizedTime(auth.retryAt)};
}

/** @param {string} value @returns {string} */
function formatAuthTime(value) {
  return new Intl.DateTimeFormat("ja-JP", {dateStyle: "short", timeStyle: "medium"}).format(new Date(value));
}

/** @param {AuthStatus} auth @param {boolean} [loading] @param {number} [now] @returns {AuthPresentation} */
export function presentAuthStatus(auth, loading = false, now = Date.now()) {
  const waiting = auth.retryAt !== null && Date.parse(auth.retryAt) > now;
  const common = {
    checked: auth.checkedAt === null ? "確認時刻: 未確認" : `確認時刻: ${formatAuthTime(auth.checkedAt)}`,
    retry: waiting && auth.retryAt !== null ? `${formatAuthTime(auth.retryAt)}以降に再確認できます。` : "",
    disabled: loading || waiting,
    showLogin: !loading && (auth.state === "auth_required" || auth.state === "two_factor_required")
  };
  if (loading) return {...common, tone: "working", title: "ログイン状態を確認しています…", detail: "お気に入りの同期とは別に確認しています。"};
  switch (auth.state) {
    case "authenticated":
      return {...common, tone: "ready", title: "ログイン済み", detail: "表示の確認時刻にログインを確認できました。"};
    case "auth_required":
      return {...common, tone: "attention", title: "この拡張でログインを確認できません", detail: "VRChat公式サイトでログイン状態を確認してから再確認してください。"};
    case "two_factor_required":
      return {...common, tone: "attention", title: "二段階認証が必要です", detail: "VRChat公式サイトで二段階認証を完了してから再確認してください。"};
    case "busy":
      return {...common, tone: "pending", title: "ほかの処理中のため未確認です", detail: "同期などの処理が終わってから再確認してください。"};
    case "rate_limited":
      return {...common, tone: "pending", title: "時間をあけて再確認してください", detail: "確認の回数制限により、現在のログイン状態は未確認です。"};
    default:
      return {...common, tone: "pending", title: "ログイン状態を確認できませんでした", detail: "通信状況などにより確認できない場合があります。時間をあけて再確認してください。"};
  }
}

/**
 * Auth is checked only at page load and on an explicit recheck. The retry timer
 * only updates the button; it never sends a message or bypasses the shared cache.
 * @param {{sendMessage: (message: Record<string, unknown>) => Promise<unknown>, render: (presentation: AuthPresentation) => void,
 *   now?: () => number, schedule?: (callback: () => void, delay: number) => unknown, cancel?: (timer: unknown) => void}} dependencies
 */
export function createAuthStatusController({sendMessage, render, now = Date.now,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (timer) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (timer))}) {
  let closed = false;
  /** @type {Promise<void> | null} */
  let inFlight = null;
  /** @type {unknown} */
  let retryTimer = null;
  /** @type {AuthStatus} */
  let auth = {state: "unknown", checkedAt: null, retryAt: null};

  function stopTimer() {
    if (retryTimer !== null) cancel(retryTimer);
    retryTimer = null;
  }

  function renderResult() {
    if (closed) return;
    stopTimer();
    render(presentAuthStatus(auth, false, now()));
    const delay = auth.retryAt === null ? 0 : Date.parse(auth.retryAt) - now();
    if (delay > 0) retryTimer = schedule(renderResult, Math.min(delay, 2_147_483_647));
  }

  function check() {
    if (closed) return Promise.resolve();
    if (inFlight !== null) return inFlight;
    if (auth.retryAt !== null && Date.parse(auth.retryAt) > now()) return Promise.resolve();
    stopTimer();
    render(presentAuthStatus(auth, true, now()));
    inFlight = Promise.resolve().then(() => closed ? undefined : sendMessage({type: "CHECK_AUTH_STATUS"})).then((response) => {
      auth = normalizeAuthStatusResponse(response);
    }, () => {
      auth = {state: "unknown", checkedAt: null, retryAt: null};
    }).finally(() => {
      inFlight = null;
      renderResult();
    });
    return inFlight;
  }

  return {check, dispose() { closed = true; stopTimer(); }};
}

/**
 * @param {{document: Document, window: Window, sendMessage: (message: Record<string, unknown>) => Promise<unknown>}} dependencies
 */
export function mountAuthStatusPanel({document, window, sendMessage}) {
  /** @param {string} id @returns {HTMLElement} */
  const required = (id) => {
    const element = document.getElementById(id);
    if (element === null) throw new Error(`Missing required auth-status element: ${id}`);
    return element;
  };
  const panel = required("auth-status-panel");
  const title = required("auth-status-title");
  const detail = required("auth-status-detail");
  const checked = required("auth-checked-at");
  const retry = required("auth-retry-at");
  const actionMessage = required("auth-action-message");
  const recheck = /** @type {HTMLButtonElement} */ (required("auth-recheck-button"));
  const login = /** @type {HTMLButtonElement} */ (required("auth-open-vrchat-button"));
  let closed = false;
  let opening = false;
  const controller = createAuthStatusController({sendMessage, render(presentation) {
    panel.dataset.state = presentation.tone;
    title.textContent = presentation.title;
    detail.textContent = presentation.detail;
    checked.textContent = presentation.checked;
    retry.textContent = presentation.retry;
    retry.hidden = presentation.retry.length === 0;
    recheck.disabled = presentation.disabled;
    login.hidden = !presentation.showLogin;
  }});
  const onRecheck = () => {
    actionMessage.textContent = "";
    void controller.check();
  };
  const onLogin = async () => {
    if (closed || opening) return;
    opening = true;
    login.disabled = true;
    actionMessage.textContent = "";
    try {
      const response = normalizeCommandResponse(await sendMessage({type: "OPEN_VRCHAT"}));
      if (!closed && !response.ok) actionMessage.textContent = commandErrorMessage(response.error, response.retryAt);
    } catch {
      if (!closed) actionMessage.textContent = "VRChat公式サイトを開けませんでした。もう一度お試しください。";
    } finally {
      opening = false;
      if (!closed) login.disabled = false;
    }
  };
  recheck.addEventListener("click", onRecheck);
  login.addEventListener("click", onLogin);
  window.addEventListener("pagehide", () => {
    closed = true;
    controller.dispose();
    recheck.removeEventListener("click", onRecheck);
    login.removeEventListener("click", onLogin);
  }, {once: true});
  void controller.check();
  return controller;
}
