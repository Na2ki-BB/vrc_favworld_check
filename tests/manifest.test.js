// @ts-check

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = path.join(ROOT, "extension");

/**
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function listFiles(directory) {
  /** @type {string[]} */
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

test("manifest grants only the reviewed minimum permissions", async () => {
  const manifest = JSON.parse(await readFile(path.join(EXTENSION, "manifest.json"), "utf8"));

  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(
    [...manifest.permissions].sort(),
    [
      "alarms",
      "cookies",
      "declarativeNetRequestWithHostAccess",
      "notifications",
      "unlimitedStorage"
    ]
  );
  assert.deepEqual(
    [...manifest.host_permissions].sort(),
    ["https://api.vrchat.cloud/*", "https://vrchat.cloud/*", "https://vrchat.com/*"]
  );
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.key, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.background.type, "module");
  assert.equal(
    manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'none'; base-uri 'none'"
  );
});

test("credential access is isolated to the reviewed background bridge", async () => {
  const sourceFiles = (await listFiles(EXTENSION)).filter((filename) =>
    /\.(?:html|js|json)$/u.test(filename)
  );
  const entries = await Promise.all(sourceFiles.map(async (filename) => ({
    filename,
    source: await readFile(filename, "utf8")
  })));
  const source = entries.map((entry) => entry.source).join("\n");

  for (const forbidden of [
    "document.cookie",
    "localStorage",
    "sessionStorage",
    "innerHTML",
    "eval(",
    "new Function",
    "Authorization"
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden primitive: ${forbidden}`);
  }
  const cookieApiFiles = entries
    .filter((entry) => entry.source.includes("chrome.cookies"))
    .map((entry) => path.relative(EXTENSION, entry.filename).replaceAll(path.sep, "/"));
  assert.deepEqual(cookieApiFiles, ["background.js", "lib/auth-cookie-bridge.js"]);
  assert.doesNotMatch(source, /<input[^>]+type=["']password["']/iu);
  assert.doesNotMatch(source, /<script[^>]*>\s*[^<\s]/iu);
  assert.doesNotMatch(source, /<script[^>]+src=["']https?:\/\//iu);
});

test("background wires bridge cleanup into startup, sync, and purge boundaries", async () => {
  const background = await readFile(path.join(EXTENSION, "background.js"), "utf8");

  assert.match(background, /new AuthCookieBridge\(\{ cookies: chrome\.cookies \}\)/u);
  assert.match(
    background,
    /withApiSession: \(operation\) => authCookieBridge\.withTemporaryApiCookies\(operation\)/u
  );
  assert.match(
    background,
    /const cookieCleanup = authCookieBridge\.cleanupStaleCookies\(\)\.catch/u
  );
  assert.match(
    background,
    /cleanupAuthCookies: \(\) => authCookieBridge\.cleanupStaleCookies\(\)/u
  );
  assert.match(background, /chrome\.runtime\.onInstalled[\s\S]*void initialize\(\)/u);
  assert.match(background, /chrome\.runtime\.onStartup[\s\S]*void initialize\(\)/u);
});

test("every hard-coded remote URL belongs to the reviewed allowlist", async () => {
  const sourceFiles = (await listFiles(EXTENSION)).filter((filename) =>
    /\.(?:html|js|json)$/u.test(filename)
  );
  const urls = new Set();
  for (const filename of sourceFiles) {
    const source = await readFile(filename, "utf8");
    for (const match of source.matchAll(/https:\/\/[^\s"'`<>\\]+/gu)) {
      const url = match[0].replace(/[),.;]+$/u, "");
      urls.add(url);
    }
  }

  for (const url of urls) {
    assert.equal(
      url.startsWith("https://api.vrchat.cloud/api/")
        || url.startsWith("https://api.vrchat.cloud/.well-known/")
        || url.startsWith("https://vrchat.com/api/")
        || url.startsWith("https://vrchat.com/home/")
        || url === "https://api.vrchat.cloud/*"
        || url === "https://vrchat.cloud/*"
        || url === "https://vrchat.com/*"
        || url === "https://github.com/Na2ki-BB/vrc_favworld_check",
      true,
      `unreviewed remote URL: ${url}`
    );
  }
});
