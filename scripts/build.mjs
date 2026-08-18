// @ts-check

import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "extension");
const outputDir = path.join(root, "dist", "extension");

const expectedPermissions = [
  "alarms",
  "declarativeNetRequestWithHostAccess",
  "notifications",
  "unlimitedStorage"
];

const forbiddenPermissions = new Set([
  "activeTab",
  "cookies",
  "debugger",
  "history",
  "scripting",
  "tabs",
  "webRequest"
]);

const secretPatterns = [
  /authcookie_[A-Za-z0-9_-]{8,}/u,
  /github_pat_[A-Za-z0-9_]{20,}/u,
  /gh[pousr]_[A-Za-z0-9]{20,}/u,
  /sk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{20,}/u,
  /npm_[A-Za-z0-9]{30,}/u,
  /xox[baprs]-[A-Za-z0-9-]{20,}/u,
  /AKIA[0-9A-Z]{16}/u,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/u
];

const publicScanExcludedDirectories = new Set([
  ".agents",
  ".codex",
  ".git",
  ".idea",
  ".vscode",
  "artifacts",
  "backups",
  "coverage",
  "dist",
  "local-data",
  "node_modules"
]);
const publicScanExcludedRootFiles = new Set([
  // Project policy requires this local instruction file to remain unpublished.
  "AGENTS.md"
]);
const MAX_PUBLIC_SOURCE_FILE_BYTES = 10 * 1024 * 1024;

/** @param {unknown} value */
function assertObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("manifest must be an object");
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value */
function assertStringArray(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("manifest permission fields must be string arrays");
  }
  return /** @type {string[]} */ (value);
}

/** @param {string[]} actual @param {string[]} expected @param {string} label */
function assertExactSet(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} must be exactly ${right.join(", ")}`);
  }
}

/** @param {string} relativePath */
async function assertSourceFile(relativePath) {
  const fullPath = path.join(sourceDir, relativePath);
  const details = await stat(fullPath);
  if (!details.isFile()) {
    throw new Error(`missing extension file: ${relativePath}`);
  }
}

/** @param {string} directory */
async function validateExtensionDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await validateExtensionDirectory(fullPath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`unsupported filesystem entry: ${fullPath}`);
    }
    const details = await stat(fullPath);
    if (details.size > 1_500_000) {
      throw new Error(`extension file is unexpectedly large: ${fullPath}`);
    }
    if (/\.(?:env|key|pem|sqlite3?|db|log|map)$/iu.test(entry.name)) {
      throw new Error(`forbidden extension file: ${fullPath}`);
    }
    if (/\.(?:html|css|js|json|svg|txt|md)$/iu.test(entry.name)) {
      const text = await readFile(fullPath, "utf8");
      if (/\.html$/iu.test(entry.name) && /<script[^>]+src=["']https?:/iu.test(text)) {
        throw new Error(`remote script is forbidden: ${fullPath}`);
      }
    }
  }
}

/**
 * Scan every source file that could be published from the project tree. Only
 * local/private or generated top-level trees are excluded. Files are decoded
 * byte-for-byte as Latin-1 so ASCII token markers are still found in otherwise
 * binary content. Neither the matching text nor the secret value is reported.
 *
 * @param {string} projectRoot
 */
export async function assertPublicSourceHasNoSecrets(projectRoot) {
  /**
   * @param {string} directory
   * @param {string} relativeDirectory
   */
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (publicScanExcludedDirectories.has(entry.name)) {
          continue;
        }
        await visit(fullPath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`unsupported public source entry: ${relativePath}`);
      }
      if (
        relativeDirectory === ""
        && publicScanExcludedRootFiles.has(entry.name)
      ) {
        continue;
      }

      const details = await stat(fullPath);
      if (details.size > MAX_PUBLIC_SOURCE_FILE_BYTES) {
        throw new Error(`public source file is unexpectedly large: ${relativePath}`);
      }
      const bytes = await readFile(fullPath);
      const text = new TextDecoder("latin1").decode(bytes);
      for (const pattern of secretPatterns) {
        if (pattern.test(text)) {
          throw new Error(`possible secret in public source: ${relativePath}`);
        }
      }
    }
  }

  await visit(path.resolve(projectRoot), "");
}

export async function build() {
  await assertPublicSourceHasNoSecrets(root);

  const packageJson = assertObject(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")));
  const manifest = assertObject(JSON.parse(await readFile(path.join(sourceDir, "manifest.json"), "utf8")));

  if (manifest.manifest_version !== 3) {
    throw new Error("manifest_version must be 3");
  }
  if (manifest.version !== packageJson.version) {
    throw new Error("package.json and manifest.json versions must match");
  }

  const permissions = assertStringArray(manifest.permissions);
  assertExactSet(permissions, expectedPermissions, "permissions");
  for (const permission of permissions) {
    if (forbiddenPermissions.has(permission)) {
      throw new Error(`forbidden permission: ${permission}`);
    }
  }
  assertExactSet(
    assertStringArray(manifest.host_permissions),
    ["https://api.vrchat.cloud/*"],
    "host_permissions"
  );

  for (const key of ["content_scripts", "externally_connectable", "key", "optional_host_permissions"]) {
    if (key in manifest) {
      throw new Error(`manifest key is forbidden: ${key}`);
    }
  }

  const background = assertObject(manifest.background);
  if (background.service_worker !== "background.js" || background.type !== "module") {
    throw new Error("background must use the module service worker background.js");
  }
  const action = assertObject(manifest.action);
  if (typeof action.default_popup !== "string") {
    throw new Error("action.default_popup is required");
  }

  await Promise.all([
    assertSourceFile("background.js"),
    assertSourceFile(action.default_popup),
    assertSourceFile("dashboard.html"),
    assertSourceFile("icons/icon128.png")
  ]);
  await validateExtensionDirectory(sourceDir);

  await rm(outputDir, { force: true, recursive: true });
  await mkdir(path.dirname(outputDir), { recursive: true });
  await cp(sourceDir, outputDir, { recursive: true });

  console.log(`Built ${path.relative(root, outputDir)} (${String(packageJson.version)})`);
}

if (
  process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await build();
}
