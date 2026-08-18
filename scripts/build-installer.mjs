// @ts-check

import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installerScriptName = "vrc_favworld_check.iss";
const versionPattern = /^\d+\.\d+\.\d+$/u;

/** @param {unknown} value @param {string} label */
function assertObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {string} directory
 * @param {string} [prefix]
 * @returns {Promise<Map<string, string>>}
 */
async function collectFileHashes(directory, prefix = "") {
  /** @type {Map<string, string>} */
  const files = new Map();
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    const relativePath = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFileHashes(fullPath, relativePath);
      for (const [filename, digest] of nested) {
        files.set(filename, digest);
      }
    } else if (entry.isFile()) {
      const digest = createHash("sha256").update(await readFile(fullPath)).digest("hex");
      files.set(relativePath, digest);
    } else {
      throw new Error(`unsupported installer input entry: ${relativePath}`);
    }
  }
  return files;
}

/** @param {Map<string, string>} source @param {Map<string, string>} built */
function assertMatchingTrees(source, built) {
  const sourcePaths = [...source.keys()];
  const builtPaths = [...built.keys()];
  if (JSON.stringify(sourcePaths) !== JSON.stringify(builtPaths)) {
    throw new Error("dist/extension file list does not match extension source");
  }
  for (const filename of sourcePaths) {
    if (source.get(filename) !== built.get(filename)) {
      throw new Error(`dist/extension differs from extension source: ${filename}`);
    }
  }
}

/**
 * Verify that the installer consumes the output of the reviewed extension
 * build rather than a stale or independently assembled directory.
 *
 * @param {string} [projectRoot]
 * @returns {Promise<{version: string, installerScript: string}>}
 */
export async function verifyInstallerInputs(projectRoot = root) {
  const packageJson = assertObject(
    JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")),
    "package.json"
  );
  if (typeof packageJson.version !== "string" || !versionPattern.test(packageJson.version)) {
    throw new Error("package version must use x.y.z format");
  }

  const sourceDirectory = path.join(projectRoot, "extension");
  const builtDirectory = path.join(projectRoot, "dist", "extension");
  const sourceManifest = assertObject(
    JSON.parse(await readFile(path.join(sourceDirectory, "manifest.json"), "utf8")),
    "extension manifest"
  );
  const builtManifest = assertObject(
    JSON.parse(await readFile(path.join(builtDirectory, "manifest.json"), "utf8")),
    "built extension manifest"
  );
  if (sourceManifest.version !== packageJson.version || builtManifest.version !== packageJson.version) {
    throw new Error("package and source/built manifest versions must match");
  }
  if ("key" in sourceManifest || "key" in builtManifest) {
    throw new Error("manifest key is forbidden");
  }

  assertMatchingTrees(
    await collectFileHashes(sourceDirectory),
    await collectFileHashes(builtDirectory)
  );

  const installerScript = path.join(projectRoot, "installer", installerScriptName);
  const scriptDetails = await stat(installerScript);
  if (!scriptDetails.isFile()) {
    throw new Error(`missing installer script: ${installerScriptName}`);
  }
  return { version: packageJson.version, installerScript };
}

/** @param {string} filename */
async function isFile(filename) {
  try {
    return (await stat(filename)).isFile();
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && ["EACCES", "ENOENT", "ENOTDIR"].includes(String(error.code))
    ) {
      return false;
    }
    throw error;
  }
}

/** @param {string} windowsPath */
async function windowsPathToWsl(windowsPath) {
  const result = await execFileAsync("wslpath", ["-u", windowsPath], { encoding: "utf8" });
  return result.stdout.trim();
}

/** @param {string} linuxPath */
async function linuxPathToWindows(linuxPath) {
  const result = await execFileAsync("wslpath", ["-w", linuxPath], { encoding: "utf8" });
  return result.stdout.trim();
}

/**
 * @param {{compilerPath?: string, environment?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<string>}
 */
export async function findInnoSetupCompiler(options = {}) {
  const environment = options.environment ?? process.env;
  let explicitPath = options.compilerPath ?? environment.INNO_SETUP_COMPILER;
  if (
    explicitPath !== undefined
    && process.platform !== "win32"
    && /^[A-Za-z]:\\/u.test(explicitPath)
  ) {
    explicitPath = await windowsPathToWsl(explicitPath);
  }
  if (explicitPath !== undefined) {
    if (!await isFile(explicitPath)) {
      throw new Error(`Inno Setup compiler was not found: ${explicitPath}`);
    }
    return explicitPath;
  }

  /** @type {string[]} */
  const candidates = [];
  for (const directory of (environment.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(directory, "ISCC.exe"), path.join(directory, "iscc"));
  }

  if (process.platform === "win32") {
    for (const variableName of ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"]) {
      const baseDirectory = environment[variableName];
      if (baseDirectory !== undefined) {
        candidates.push(path.join(baseDirectory, "Programs", "Inno Setup 6", "ISCC.exe"));
        candidates.push(path.join(baseDirectory, "Inno Setup 6", "ISCC.exe"));
      }
    }
  } else {
    candidates.push(
      "/mnt/c/Program Files (x86)/Inno Setup 6/ISCC.exe",
      "/mnt/c/Program Files/Inno Setup 6/ISCC.exe"
    );
    try {
      const userDirectories = await readdir("/mnt/c/Users", { withFileTypes: true });
      for (const entry of userDirectories) {
        if (entry.isDirectory()) {
          candidates.push(path.join(
            "/mnt/c/Users",
            entry.name,
            "AppData/Local/Programs/Inno Setup 6/ISCC.exe"
          ));
        }
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }

  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "Inno Setup 6 compiler (ISCC.exe) was not found. Install Inno Setup 6 or set INNO_SETUP_COMPILER."
  );
}

/**
 * @param {string} compiler
 * @param {string[]} argumentsList
 * @param {string} workingDirectory
 */
async function runCompiler(compiler, argumentsList, workingDirectory) {
  await new Promise((resolve, reject) => {
    const child = spawn(compiler, argumentsList, {
      cwd: workingDirectory,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(
          signal === null
            ? `ISCC failed with exit code ${String(code)}`
            : `ISCC was terminated by signal ${signal}`
        ));
      }
    });
  });
}

/**
 * @param {{projectRoot?: string, compilerPath?: string}} [options]
 * @returns {Promise<{outputPath: string, digest: string}>}
 */
export async function buildInstaller(options = {}) {
  const projectRoot = options.projectRoot ?? root;
  const { installerScript, version } = await verifyInstallerInputs(projectRoot);
  const compiler = await findInnoSetupCompiler(
    options.compilerPath === undefined ? {} : { compilerPath: options.compilerPath }
  );
  const usesWindowsCompiler = process.platform !== "win32" && /\.exe$/iu.test(compiler);
  const compilerScriptPath = usesWindowsCompiler
    ? await linuxPathToWindows(installerScript)
    : installerScript;

  const artifactDirectory = path.join(projectRoot, "artifacts");
  await mkdir(artifactDirectory, { recursive: true });
  await access(installerScript);
  await runCompiler(
    compiler,
    [`/DAppVersion=${version}`, compilerScriptPath],
    projectRoot
  );

  const outputPath = path.join(
    artifactDirectory,
    `vrc_favworld_check-installer-v${version}.exe`
  );
  const outputDetails = await stat(outputPath);
  if (!outputDetails.isFile() || outputDetails.size === 0) {
    throw new Error("ISCC did not produce the expected installer executable");
  }
  const digest = createHash("sha256").update(await readFile(outputPath)).digest("hex");
  return { outputPath, digest };
}

if (
  process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await buildInstaller();
  console.log(`Packaged ${path.relative(root, result.outputPath)}`);
  console.log(`SHA-256 ${result.digest}`);
}
