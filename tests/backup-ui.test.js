// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "./source-text.js";

const source = await readFile(new URL("../extension/dashboard.js", import.meta.url));
const start = source.indexOf('exportButton.addEventListener("click", async () => {');
const end = source.indexOf('\n/**\n * @param {string} message', start);
assert.ok(start >= 0 && end > start);
const handlers = source.slice(start, end);
const USER = "usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** @param {{approve?: boolean, syncing?: boolean, archive?: boolean, failDecode?: boolean, failSettings?: boolean, delayExport?: boolean, oversized?: boolean}} [options] */
function harness(options = {}) {
  const calls = { exports: 0, jsonRestores: 0, imageRestores: 0, confirmations: 0, reads: 0, downloads: 0, revoked: 0 };
  /** @type {(() => Promise<void>) | undefined} */
  let exportHandler;
  /** @type {(() => Promise<void>) | undefined} */
  let importHandler;
  /** @type {((blob: Blob) => void) | undefined} */
  let resolveExport;
  const exportWait = new Promise((resolve) => { resolveExport = resolve; });
  const backupMessage = { textContent: "" };
  const confirmations = /** @type {string[]} */ ([]);
  const bytes = options.archive ? new Uint8Array([80, 75, 3, 4]) : new TextEncoder().encode("{}");
  const file = {
    size: options.oversized ? 70 * 1024 * 1024 : bytes.byteLength,
    slice: () => new Blob([bytes]),
    arrayBuffer: async () => { calls.reads++; return bytes.buffer; },
    text: async () => { calls.reads++; return "{}"; }
  };
  const importInput = {
    files: [file], value: "synthetic-backup",
    /** @param {string} _type @param {() => Promise<void>} handler */
    addEventListener: (_type, handler) => { importHandler = handler; }
  };
  const summary = { userId: USER, displayName: "Synthetic fixture", worldCount: 1, eventCount: 0, sourceVersion: 3, exportedAt: "2026-10-07T00:00:00.000Z" };
  const state = { profile: { userId: USER }, settings: { lastBackupAt: "" }, status: {}, worlds: [], events: [], worldDispositions: [], statusAvailable: false };
  const repo = {
    /** @param {string} key */
    setSetting: async (key) => { if (options.failSettings && key === "activeProfileId") throw new Error("synthetic settings failure"); },
    getSetting: async () => false
  };
  const environment = {
    exportButton: {
      /** @param {string} _type @param {() => Promise<void>} handler */
      addEventListener: (_type, handler) => { exportHandler = handler; }
    },
    importInput, backupMessage, state,
    requireRepository: () => repo,
    renderSettings: () => {}, renderConnection: () => {}, closeRecordDialogs: () => {},
    chrome: { runtime: { getManifest: () => ({ version: "0.1.14" }) } },
    createImageBackup: async () => { calls.exports++; return options.delayExport ? exportWait : new Blob([bytes]); },
    URL: { createObjectURL: () => "blob:synthetic", revokeObjectURL: () => { calls.revoked++; } },
    document: { createElement: () => ({ click: () => { calls.downloads++; }, remove: () => {} }), body: { append: () => {} } },
    backupExportErrorMessage: () => "書き出せませんでした",
    ImageBackupValidationError: TypeError,
    MAX_IMAGE_BACKUP_BYTES: 64 * 1024 * 1024, MAX_BACKUP_BYTES: 25 * 1024 * 1024,
    hasZipSignature: () => options.archive === true,
    parseImageBackup: () => ({ backup: {}, thumbnails: [{}] }), parseBackup: () => ({}),
    sendMessage: async () => ({ ok: true }),
    isRecord: () => true, normalizeStatusResponse: () => ({ syncing: options.syncing === true }),
    summarizeHistory: () => ({ attention: 0, missing: 0, unavailable: 0 }),
    backupSummary: () => summary, formatDateTime: () => "2026-10-07",
    globalThis: { confirm: (/** @type {string} */ text) => { calls.confirmations++; confirmations.push(text); return options.approve !== false; } },
    restoreBackup: async () => { calls.jsonRestores++; return summary; },
    restoreImageBackup: async () => { calls.imageRestores++; if (options.failDecode) throw new Error("synthetic private decode error"); return summary; },
    SETTINGS_UPDATE_OUTCOMES: { unconfirmed: "unconfirmed", success: "success", scheduleRepairFailed: "scheduleRepairFailed" },
    classifySettingsUpdateResponse: () => "success", loadData: async () => true
  };
  const control = new Function(...Object.keys(environment), `
    let exporting = false, restoring = false, purging = false, recordMutationInFlight = false, pageClosed = false;
    let restoreController = null, progressEpoch = 0, thumbnailRenderGeneration = 0;
    ${handlers}
    return { close: () => {pageClosed = true; restoreController?.abort();}, busy: () => ({exporting, restoring}) };
  `)(...Object.values(environment));
  return {
    calls, backupMessage, confirmations, importInput, control,
    export: () => { assert.ok(exportHandler); return exportHandler(); },
    import: () => { assert.ok(importHandler); return importHandler(); },
    finishExport: () => { assert.ok(resolveExport); resolveExport(new Blob([bytes])); }
  };
}

test("ZIP is the only default export and repeated clicks share one operation", async () => {
  const ui = harness({ delayExport: true });
  const pending = ui.export();
  assert.equal(ui.control.busy().exporting, true);
  await ui.export();
  await ui.import();
  assert.equal(ui.calls.exports, 1);
  assert.equal(ui.calls.confirmations, 0);
  ui.finishExport();
  await pending;
  assert.equal(ui.calls.downloads, 1);
  assert.equal(ui.calls.revoked, 1);
  assert.equal(ui.control.busy().exporting, false);
  assert.match(ui.backupMessage.textContent, /記録と保存済み画像のZIP/u);
});

test("closing the page while preparing a backup prevents a later download", async () => {
  const ui = harness({ delayExport: true });
  const pending = ui.export();
  ui.control.close();
  ui.finishExport();
  await pending;
  assert.equal(ui.calls.downloads, 0);
});

test("restore cancellation writes nothing and permits choosing the same file again", async () => {
  for (const archive of [false, true]) {
    const ui = harness({ archive, approve: false });
    await ui.import();
    await ui.import();
    assert.equal(ui.calls.confirmations, 2);
    assert.equal(ui.calls.imageRestores + ui.calls.jsonRestores, 0);
    assert.equal(ui.importInput.value, "");
    assert.equal(ui.control.busy().restoring, false);
    assert.match(ui.backupMessage.textContent, /現在の記録は変更していません/u);
  }
});

test("restore routes ZIP and JSON to their validators and includes image counts in confirmation", async () => {
  for (const archive of [false, true]) {
    const ui = harness({ archive });
    await ui.import();
    assert.equal(ui.calls.imageRestores, archive ? 1 : 0);
    assert.equal(ui.calls.jsonRestores, archive ? 0 : 1);
    assert.match(ui.confirmations[0] ?? "", archive ? /保存済み画像: 1件/u : /画像はこのJSONから復元できません/u);
    assert.match(ui.backupMessage.textContent, /記録は復元済み/u);
    if (archive) assert.match(ui.backupMessage.textContent, /画像1件も復元/u);
  }
});

test("oversized files and active sync are rejected without restoring", async () => {
  for (const archive of [false, true]) {
    const oversized = harness({ archive, oversized: true });
    await oversized.import();
    assert.equal(oversized.calls.reads, 0);
    assert.equal(oversized.calls.confirmations, 0);
    assert.match(oversized.backupMessage.textContent, archive ? /64MiB/u : /25MiB/u);
    const syncing = harness({ archive, syncing: true });
    await syncing.import();
    assert.equal(syncing.calls.confirmations, 0);
    assert.equal(syncing.calls.imageRestores + syncing.calls.jsonRestores, 0);
    assert.match(syncing.backupMessage.textContent, /お気に入りを確認中/u);
  }
});

test("decode or disk failure stays distinct from a settings failure after successful restore", async () => {
  const failed = harness({ archive: true, failDecode: true });
  await failed.import();
  assert.match(failed.backupMessage.textContent, /現在の記録や画像は変更していません/u);
  assert.doesNotMatch(failed.backupMessage.textContent, /private/u);
  const settings = harness({ archive: true, failSettings: true });
  await settings.import();
  assert.match(settings.backupMessage.textContent, /記録は復元済み/u);
  assert.doesNotMatch(settings.backupMessage.textContent, /変更していません/u);
});
