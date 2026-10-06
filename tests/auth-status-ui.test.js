// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { readFile } from "./source-text.js";
import {
  createAuthStatusController,
  mountAuthStatusPanel,
  normalizeAuthStatusResponse,
  presentAuthStatus
} from "../extension/lib/auth-status-ui.js";
import * as ui from "../extension/lib/ui.js";

/** @typedef {import("../extension/lib/auth-status-ui.js").AuthState} AuthState */
/** @typedef {import("../extension/lib/auth-status-ui.js").AuthPresentation} AuthPresentation */
const CHECKED = "2026-10-04T18:00:00.000Z";
const RETRY = "2026-10-04T18:01:00.000Z";
const NOW = Date.parse(CHECKED);
/** @param {AuthState} state @param {string | null} [retryAt] */
const response = (state, retryAt = null) => ({ok: true, auth: {state, checkedAt: state === "busy" ? null : CHECKED, retryAt}});

class FakeElement {
  textContent = "";
  hidden = false;
  disabled = false;
  className = "";
  dataset = {};
  classList = {toggle() {}, remove() {}, add() {}};
  /** @type {Map<string, (() => unknown)[]>} */
  listeners = new Map();
  /** @param {string} name @param {() => unknown} callback */
  addEventListener(name, callback) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]); }
  /** @param {string} name @param {() => unknown} callback */
  removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== callback)); }
  /** @param {string} name */
  async dispatch(name) { for (const callback of this.listeners.get(name) ?? []) await callback(); }
}

/** @param {string} html */
function fakePage(html) {
  const elements = new Map([...html.matchAll(/id="([^"]+)"/gu)].map((match) => [match[1], new FakeElement()]));
  /** @param {string} id */
  const get = (id) => {
    const element = elements.get(id);
    assert.ok(element, id);
    return element;
  };
  const document = {hidden: false, getElementById: get};
  const window = new FakeElement();
  return {get, document, window};
}

/** @returns {Promise<void>} */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("current-auth normalization allowlists only state and valid timestamps", () => {
  const safe = normalizeAuthStatusResponse({...response("authenticated"), auth: {...response("authenticated").auth, displayName: "private-name", cookie: "private-value"}});
  assert.deepEqual(safe, {state: "authenticated", checkedAt: CHECKED, retryAt: null});
  for (const value of [null, {}, {ok: false, ...{auth: response("authenticated").auth}}, {ok: true, auth: {state: "<script>"}}, {ok: true, auth: {state: "authenticated", checkedAt: "invalid"}}]) {
    assert.deepEqual(normalizeAuthStatusResponse(value), {state: "unknown", checkedAt: null, retryAt: null});
  }
  assert.equal(normalizeAuthStatusResponse(response("busy")).checkedAt, null);
  assert.equal(normalizeAuthStatusResponse({ok: true, auth: {state: "unknown", checkedAt: CHECKED, retryAt: "private-value"}}).retryAt, null);
});

test("current-auth presentation separates all outcomes without treating failure as logout", () => {
  /** @type {[AuthState, RegExp, boolean][]} */
  const cases = [
    ["authenticated", /ログイン済み/u, false],
    ["auth_required", /この拡張でログインを確認できません/u, true],
    ["two_factor_required", /二段階認証/u, true],
    ["unknown", /確認できませんでした/u, false],
    ["busy", /ほかの処理中/u, false],
    ["rate_limited", /時間をあけて/u, false]
  ];
  for (const [state, title, showLogin] of cases) {
    const presentation = presentAuthStatus(normalizeAuthStatusResponse(response(state)), false, NOW);
    assert.match(presentation.title, title);
    assert.equal(presentation.showLogin, showLogin);
    assert.equal(presentation.disabled, false);
    assert.match(presentation.checked, state === "busy" ? /未確認/u : /:00:00/u);
    assert.doesNotMatch(presentation.title + presentation.detail, /ログアウト|前回の同期/u);
  }
  const historical = ui.presentStatus(ui.normalizeStatusResponse({authRequired: true}));
  assert.match(historical.title, /前回の同期/u);
  assert.match(historical.detail, /現在のログイン確認/u);
  assert.doesNotMatch(historical.title, /ログインが必要です/u);
});

test("explicit auth checks deduplicate in flight and use exactly the same cache-respecting command", async () => {
  /** @type {Record<string, unknown>[]} */
  const messages = [];
  /** @type {AuthPresentation[]} */
  const renders = [];
  /** @type {(value: unknown) => void} */
  let finish = () => {};
  const controller = createAuthStatusController({now: () => NOW, render: (value) => renders.push(value), sendMessage: async (message) => {
    messages.push(message);
    return new Promise((resolve) => { finish = resolve; });
  }});
  const first = controller.check();
  assert.equal(controller.check(), first);
  assert.equal(renders[0]?.disabled, true);
  await settle();
  assert.deepEqual(messages, [{type: "CHECK_AUTH_STATUS"}]);
  finish(response("authenticated"));
  await first;
  assert.equal(renders.at(-1)?.disabled, false);
  const recheck = controller.check();
  await settle();
  assert.deepEqual(messages, [{type: "CHECK_AUTH_STATUS"}, {type: "CHECK_AUTH_STATUS"}]);
  finish(response("two_factor_required"));
  await recheck;
  assert.equal(renders.at(-1)?.showLogin, true);
  controller.dispose();
});

test("backoff only enables a recheck at retryAt and never makes an automatic auth request", async () => {
  let now = NOW;
  let calls = 0;
  /** @type {AuthPresentation[]} */
  const renders = [];
  /** @type {(() => void) | null} */
  let timer = null;
  let delay = 0;
  const controller = createAuthStatusController({
    now: () => now,
    render: (value) => renders.push(value),
    sendMessage: async () => { calls += 1; return response("rate_limited", RETRY); },
    schedule: (callback, duration) => { timer = callback; delay = duration; return 1; },
    cancel: () => { timer = null; }
  });
  await controller.check();
  assert.equal(renders.at(-1)?.disabled, true);
  assert.match(renders.at(-1)?.retry ?? "", /:01:00.*以降/u);
  assert.equal(delay, 60_000);
  await controller.check();
  assert.equal(calls, 1);
  now = Date.parse(RETRY);
  assert.ok(timer);
  /** @type {() => void} */ (timer)();
  assert.equal(renders.at(-1)?.disabled, false);
  assert.equal(renders.at(-1)?.retry, "");
  assert.equal(calls, 1, "retry timer must not perform auth/network work");
  await controller.check();
  assert.equal(calls, 2);
  controller.dispose();
});

test("transport failure becomes unknown and disposal suppresses late renders and clears timers", async () => {
  /** @type {AuthPresentation[]} */
  const renders = [];
  const failed = createAuthStatusController({render: (value) => renders.push(value), sendMessage: async () => { throw new Error("private-error"); }});
  await failed.check();
  assert.match(renders.at(-1)?.title ?? "", /確認できませんでした/u);
  assert.doesNotMatch(JSON.stringify(renders), /private-error|ログアウト/u);
  failed.dispose();

  /** @type {(value: unknown) => void} */
  let finish = () => {};
  const pending = createAuthStatusController({render: (value) => renders.push(value), sendMessage: async () => new Promise((resolve) => { finish = resolve; })});
  const checked = pending.check();
  await settle();
  pending.dispose();
  const before = renders.length;
  finish(response("authenticated"));
  await checked;
  await pending.check();
  assert.equal(renders.length, before);

  let canceled = 0;
  const waiting = createAuthStatusController({now: () => NOW, render() {}, sendMessage: async () => response("rate_limited", RETRY), schedule: () => 123, cancel: (timer) => { assert.equal(timer, 123); canceled += 1; }});
  await waiting.check();
  waiting.dispose();
  assert.equal(canceled, 1);
});

test("shared panel mounts once, renders state, rechecks explicitly and stops after pagehide", async () => {
  const html = await readFile(new URL("../extension/popup.html", import.meta.url), "utf8");
  const page = fakePage(html);
  /** @type {Record<string, unknown>[]} */
  const messages = [];
  const controller = mountAuthStatusPanel({document: /** @type {Document} */ (/** @type {unknown} */ (page.document)), window: /** @type {Window} */ (/** @type {unknown} */ (page.window)), sendMessage: async (message) => {
    messages.push(message);
    if (message.type === "OPEN_VRCHAT") return {ok: true};
    return response(messages.length === 1 ? "auth_required" : "authenticated");
  }});
  await settle();
  assert.equal(messages.length, 1);
  assert.equal(page.get("auth-open-vrchat-button").hidden, false);
  await page.get("auth-open-vrchat-button").dispatch("click");
  assert.equal(messages.at(-1)?.type, "OPEN_VRCHAT");
  await page.get("auth-recheck-button").dispatch("click");
  await settle();
  assert.equal(page.get("auth-status-title").textContent, "ログイン済み");
  assert.equal(page.get("auth-open-vrchat-button").hidden, true);
  await page.window.dispatch("pagehide");
  const before = messages.length;
  await page.get("auth-recheck-button").dispatch("click");
  await controller.check();
  assert.equal(messages.length, before);
});

test("popup status polling cannot refresh or overwrite current auth", async () => {
  const html = await readFile(new URL("../extension/popup.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");
  const page = fakePage(html);
  /** @type {Record<string, unknown>[]} */
  const messages = [];
  /** @type {(() => Promise<void>)[]} */
  const timers = [];
  const run = new Function("ui", "mountAuthStatusPanel", "document", "window", "chrome", "setInterval", "clearInterval", `
    return (async () => { const {${Object.keys(ui).join(",")}} = ui;
      ${source.replace(/^import[\s\S]*?from "[^"]+";\n/gmu, "")}
    })();
  `);
  await run(ui, mountAuthStatusPanel, page.document, page.window, {runtime: {sendMessage: async (/** @type {Record<string, unknown>} */ message) => {
    messages.push(message);
    if (message.type === "CHECK_AUTH_STATUS") return response("authenticated");
    return {ok: true, status: {activeProfileId: "stored-profile", lastSuccessfulSyncAt: CHECKED, authRequired: true}};
  }}}, (/** @type {() => Promise<void>} */ callback) => { timers.push(callback); return 1; }, () => {});
  await settle();
  assert.equal(page.get("auth-status-title").textContent, "ログイン済み");
  assert.match(page.get("status-title").textContent, /前回の同期/u);
  for (let i = 0; i < 3; i += 1) await timers[0]?.();
  assert.equal(messages.filter((message) => message.type === "CHECK_AUTH_STATUS").length, 1);
  assert.equal(messages.filter((message) => message.type === "GET_STATUS").length, 4);
  assert.equal(page.get("auth-status-title").textContent, "ログイン済み");
  await page.window.dispatch("pagehide");
  await timers[0]?.();
  assert.equal(messages.length, 5);
});

test("both pages load auth once outside their status-polling paths and retain explicit history labels", async () => {
  for (const name of ["popup", "dashboard"]) {
    const source = await readFile(new URL(`../extension/${name}.js`, import.meta.url), "utf8");
    const html = await readFile(new URL(`../extension/${name}.html`, import.meta.url), "utf8");
    assert.equal(source.match(/mountAuthStatusPanel\(\{document, window, sendMessage\}\)/gu)?.length, 1);
    assert.match(html, /現在のログイン確認/u);
    assert.match(html, /前回の同期結果/u);
    assert.match(html, /前回の同期成功/u);
    assert.match(html, /再確認でも60秒以内は同じ結果を表示します/u);
    assert.match(html, /id="auth-recheck-button"/u);
    assert.doesNotMatch(source, /CHECK_AUTH_STATUS/u, "only the isolated shared controller requests auth");
  }
  const source = await readFile(new URL("../extension/lib/auth-status-ui.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /setInterval|chrome\.cookies|fetch\(|innerHTML|START_SYNC/u);
});

test("popup primary actions stay before the variable-height auth panel", async () => {
  const html = await readFile(new URL("../extension/popup.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../extension/styles/popup.css", import.meta.url), "utf8");
  for (const id of ["dashboard-button", "sync-button", "last-sync", "action-message"]) {
    assert.ok(html.indexOf(`id="${id}"`) < html.indexOf('id="auth-status-panel"'));
  }
  assert.match(css, /width: 370px/u);
  assert.doesNotMatch(css, /overflow(?:-y)?:\s*(?:hidden|clip)/u);
});

test("dashboard status polling remains independent of the one-time auth request", async () => {
  const source = await readFile(new URL("../extension/dashboard.js", import.meta.url), "utf8");
  const start = source.indexOf("async function refreshThumbnailProgress()");
  const end = source.indexOf("\nconst progressTimer", start);
  /** @type {Record<string, unknown>[]} */
  const messages = [];
  /** @type {AuthPresentation[]} */
  const renders = [];
  /** @param {Record<string, unknown>} message */
  const sendMessage = async (message) => {
    messages.push(message);
    return message.type === "CHECK_AUTH_STATUS"
      ? response("authenticated")
      : {ok: true, status: {activeProfileId: "stored-profile", authRequired: true}};
  };
  const auth = createAuthStatusController({sendMessage, render: (value) => renders.push(value)});
  await auth.check();
  const state = {profile: {userId: "stored-profile"}, status: ui.normalizeStatusResponse({activeProfileId: "stored-profile"}), worlds: [], thumbnailCount: 0};
  const poll = new Function("ui", "sendMessage", "state", `
    const {isRecord, normalizeStatusResponse, presentThumbnailProgress} = ui;
    let pageClosed = false, restoring = false, purging = false, progressPolling = false, recordMutationInFlight = false;
    const repository = {}, document = {hidden: false}, progressEpoch = 0, thumbnailRenderGeneration = 0;
    const worldList = {querySelectorAll: () => []}, settingsThumbnailCount = {}, thumbnailCaptureNotice = {};
    const refreshObservedStatus = async status => { state.status.authRequired = status.authRequired; return false; };
    const renderThumbnailProgressNotice = () => {}, hydrateWorldThumbnails = async () => {}, readThumbnailCount = async () => 0;
    const renderConnection = () => {}, renderPrimaryFocus = () => {};
    ${source.slice(start, end)}
    return refreshThumbnailProgress;
  `)(ui, sendMessage, state);
  for (let i = 0; i < 3; i += 1) await poll();
  assert.deepEqual(messages.map((message) => message.type), ["CHECK_AUTH_STATUS", "GET_STATUS", "GET_STATUS", "GET_STATUS"]);
  assert.equal(state.status.authRequired, true);
  assert.equal(renders.at(-1)?.title, "ログイン済み");
  assert.equal(renders.length, 2, "sync history does not render current-auth state");
  auth.dispose();
});


test("closing before the initial auth request starts suppresses the request", async () => {
  let calls = 0;
  const controller = createAuthStatusController({render() {}, sendMessage: async () => { calls += 1; return response("authenticated"); }});
  const pending = controller.check();
  controller.dispose();
  await pending;
  assert.equal(calls, 0);
});
