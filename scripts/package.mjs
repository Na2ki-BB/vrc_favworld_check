// @ts-check

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {string} [projectRoot]
 * @returns {Promise<{outputPath: string, digest: string}>}
 */
export async function packageExtension(projectRoot = root) {
  const sourceDir = path.join(projectRoot, "dist", "extension");
  const artifactDir = path.join(projectRoot, "artifacts");
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));

  if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(packageJson.version)) {
    throw new Error("package version must use x.y.z format");
  }

  /** @typedef {Uint8Array | [Uint8Array, { mtime: Date }]} ZipEntry */
  /** @type {Record<string, ZipEntry>} */
  const files = Object.create(null);
  // ZIP stores a DOS *local* timestamp. Constructing this value from a UTC
  // instant makes the encoded date depend on the machine's time zone (and can
  // even move it before ZIP's 1980 minimum). Keep the local date components
  // identical in every environment instead. This must be created inside the
  // operation so a release process with an explicit TZ receives that TZ.
  const fixedTime = new Date(1980, 0, 1, 0, 0, 0, 0);

  /** @param {string} directory @param {string} [prefix] */
  async function collect(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) {
        await collect(fullPath, relativePath);
      } else if (entry.isFile()) {
        files[relativePath] = [new Uint8Array(await readFile(fullPath)), { mtime: fixedTime }];
      } else {
        throw new Error(`unsupported filesystem entry: ${fullPath}`);
      }
    }
  }

  await collect(sourceDir);
  if (!("manifest.json" in files)) {
    throw new Error("built extension has no manifest.json");
  }

  const archive = zipSync(files, { level: 9 });
  const filename = `vrc_favworld_check-v${packageJson.version}.zip`;
  const outputPath = path.join(artifactDir, filename);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(outputPath, archive);

  const digest = createHash("sha256").update(archive).digest("hex");
  return { outputPath, digest };
}

if (
  process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await packageExtension();
  console.log(`Packaged ${path.relative(root, result.outputPath)}`);
  console.log(`SHA-256 ${result.digest}`);
}
