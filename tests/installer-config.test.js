// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER_PATH = path.join(ROOT, "installer", "vrc_favworld_check.iss");

/** @param {string} source @param {string} sectionName */
function section(source, sectionName) {
  const escapedName = sectionName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `^\\[${escapedName}\\]\\s*$([\\s\\S]*?)(?=^\\[[^\\]]+\\]\\s*$|(?![\\s\\S]))`,
    "imu"
  ).exec(source);
  if (match === null || match[1] === undefined) {
    assert.fail(`missing [${sectionName}] section`);
  }
  return match[1];
}

test("installer is fixed to a non-elevated per-user Chrome installation", async () => {
  const source = await readFile(INSTALLER_PATH, "utf8");
  const setup = section(source, "Setup");

  assert.match(source, /#define AppRoot "\{localappdata\}\\Programs\\VRCFavoriteWorldHistory"/u);
  assert.match(setup, /^DefaultDirName=\{#AppRoot\}$/mu);
  assert.match(setup, /^DisableDirPage=yes$/mu);
  assert.match(setup, /^UsePreviousAppDir=no$/mu);
  assert.match(setup, /^PrivilegesRequired=lowest$/mu);
  assert.match(setup, /^SetupMutex=Na2kiBB\.VRCFavoriteWorldHistory\.Chrome\.Setup$/mu);
  assert.match(setup, /^CreateUninstallRegKey=yes$/mu);
  assert.match(setup, /^CloseApplications=no$/mu);
  assert.match(setup, /^RestartApplications=no$/mu);
  assert.match(setup, /^ChangesAssociations=no$/mu);
  assert.match(setup, /^ChangesEnvironment=no$/mu);
  assert.doesNotMatch(source, /^\[Registry\]$/imu);
  assert.doesNotMatch(source, /\bRegWrite(?:BinaryValue|DWordValue|ExpandStringValue|MultiStringValue|StringValue)\b/u);
  assert.doesNotMatch(setup, /^PrivilegesRequiredOverridesAllowed=(?:commandline|dialog)/mu);
  assert.doesNotMatch(source, /^\[(?:Tasks|Icons)\]$/imu);
  assert.doesNotMatch(source, /\b(?:service|scheduled task|startup|telemetry)\b/iu);
  assert.doesNotMatch(source, /\b(?:SignTool|SignedUninstaller)\s*=/iu);
});

test("installer stages one verified extension generation and restores only on swap failure", async () => {
  const source = await readFile(INSTALLER_PATH, "utf8");
  const files = section(source, "Files");
  const installDelete = section(source, "InstallDelete");

  assert.match(files, /Source: "\.\.\\dist\\extension\\\*"/u);
  assert.match(files, /DestDir: "\{app\}\\extension\.new"/u);
  assert.match(files, /Flags: ignoreversion recursesubdirs createallsubdirs/u);
  assert.match(installDelete, /Name: "\{app\}\\extension\.new"/u);
  assert.match(source, /CompareSemVersions\(InstalledVersion, '\{#AppVersion\}', ComparisonValid\) > 0/u);
  assert.match(source, /RenameFile\(CurrentExtensionDirectory, OldExtensionDirectory\)/u);
  assert.match(source, /RenameFile\(StagedExtensionDirectory, CurrentExtensionDirectory\)/u);
  assert.match(source, /function RestoreOldExtension: Boolean;/u);
  assert.match(source, /if OldExtensionCreated and \(not SwapCompleted\) then/u);
  assert.doesNotMatch(source, /CurInstallProgressChanged/u);
});

test("installer guides install and update while confining uninstall deletion to its app root", async () => {
  const source = await readFile(INSTALLER_PATH, "utf8");
  const run = section(source, "Run");
  const uninstallDelete = section(source, "UninstallDelete");

  assert.match(run, /chrome:\/\/extensions\//u);
  assert.match(run, /Check: ShouldOpenChromeExtensions/u);
  assert.match(run, /Filename: "\{app\}\\extension"/u);
  assert.match(source, /function ShouldOpenChromeExtensions: Boolean;/u);
  assert.match(source, /Result := SwapCompleted;/u);
  assert.match(source, /デベロッパー モード/u);
  assert.match(source, /パッケージ化されていない拡張機能を読み込む/u);
  assert.match(source, /Downloads内のこのインストーラーは削除できます/u);
  assert.match(source, /Cookie利用や接続権限/u);
  assert.match(source, /vrchat\.com \/ vrchat\.cloud \/ api\.vrchat\.cloud/u);
  assert.match(source, /拡張の「再読み込み」を1回押します/u);
  assert.match(source, /別のフォルダーから読み込み直したりしないでください/u);
  assert.match(source, /インストーラーはChromeを強制終了しません/u);
  assert.match(source, /記録をすべて削除してアンインストール/u);

  const deleteEntries = uninstallDelete
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.deepEqual(deleteEntries, [
    "Type: filesandordirs; Name: \"{app}\\extension\"",
    "Type: filesandordirs; Name: \"{app}\\extension.new\"",
    "Type: filesandordirs; Name: \"{app}\\extension.old\"",
    "Type: dirifempty; Name: \"{app}\""
  ]);
  assert.doesNotMatch(uninstallDelete, /\{app\}\\\*/u);
  assert.doesNotMatch(source, /\\User Data\\|--user-data-dir|\\IndexedDB\\/iu);
});

test("release scripts build the installer only from matching dist output", async () => {
  const [packageSource, buildSource, manifestSource] = await Promise.all([
    readFile(path.join(ROOT, "package.json"), "utf8"),
    readFile(path.join(ROOT, "scripts", "build-installer.mjs"), "utf8"),
    readFile(path.join(ROOT, "extension", "manifest.json"), "utf8")
  ]);
  const packageJson = JSON.parse(packageSource);
  const manifest = JSON.parse(manifestSource);

  assert.equal(
    packageJson.scripts["build:installer"],
    "npm run build && node scripts/build-installer.mjs"
  );
  assert.equal(
    packageJson.scripts.package,
    "npm run build && node scripts/package.mjs && node scripts/build-installer.mjs"
  );
  assert.match(buildSource, /verifyInstallerInputs/u);
  assert.match(buildSource, /path\.join\(projectRoot, "dist", "extension"\)/u);
  assert.match(buildSource, /assertMatchingTrees/u);
  assert.match(buildSource, /`\/DAppVersion=\$\{version\}`/u);
  assert.equal(manifest.key, undefined);
});
