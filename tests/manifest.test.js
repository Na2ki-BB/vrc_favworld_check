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
      "declarativeNetRequestWithHostAccess",
      "notifications",
      "unlimitedStorage"
    ]
  );
  assert.deepEqual(manifest.host_permissions, ["https://api.vrchat.cloud/*"]);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.background.type, "module");
  assert.equal(
    manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'none'; base-uri 'none'"
  );
});

test("extension source has no credential-reading or dynamic-code primitives", async () => {
  const sourceFiles = (await listFiles(EXTENSION)).filter((filename) =>
    /\.(?:html|js|json)$/u.test(filename)
  );
  const source = (await Promise.all(sourceFiles.map((filename) => readFile(filename, "utf8"))))
    .join("\n");

  for (const forbidden of [
    "chrome.cookies",
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
  assert.doesNotMatch(source, /<input[^>]+type=["']password["']/iu);
  assert.doesNotMatch(source, /<script[^>]*>\s*[^<\s]/iu);
  assert.doesNotMatch(source, /<script[^>]+src=["']https?:\/\//iu);
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
      url.startsWith("https://api.vrchat.cloud/")
        || url.startsWith("https://vrchat.com/home/")
        || url === "https://github.com/Na2ki-BB/vrc_favworld_check",
      true,
      `unreviewed remote URL: ${url}`
    );
  }
});
