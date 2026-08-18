// @ts-check

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertPublicSourceHasNoSecrets, build } from "../scripts/build.mjs";
import { packageExtension } from "../scripts/package.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("public source scan detects a current GitHub fine-grained token without echoing it", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "vrc-public-source-scan-"));
  context.after(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  const docsDirectory = path.join(fixtureRoot, "docs");
  await mkdir(docsDirectory);
  const syntheticToken = ["github", "pat", "A".repeat(82)].join("_");
  await writeFile(
    path.join(docsDirectory, "fixture.txt"),
    `synthetic fixture only: ${syntheticToken}\n`,
    "utf8"
  );

  await assert.rejects(assertPublicSourceHasNoSecrets(fixtureRoot), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /possible secret in public source: docs\/fixture\.txt/u);
    assert.equal(error.message.includes(syntheticToken), false);
    return true;
  });
});

test("extension ZIP is byte-identical across supported release time zones", async () => {
  await build();
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const archivePath = path.join(
    ROOT,
    "artifacts",
    `vrc_favworld_check-v${String(packageJson.version)}.zip`
  );

  /** @type {string[]} */
  const hashes = [];
  const originalTimeZone = process.env.TZ;
  try {
    for (const timeZone of ["UTC", "Asia/Tokyo", "America/Los_Angeles"]) {
      process.env.TZ = timeZone;
      const result = await packageExtension(ROOT);
      const archive = await readFile(archivePath);
      const hash = createHash("sha256").update(archive).digest("hex");
      hashes.push(hash);
      assert.equal(result.outputPath, archivePath);
      assert.equal(result.digest, hash);
    }
  } finally {
    if (originalTimeZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimeZone;
    }
  }

  assert.equal(new Set(hashes).size, 1, `time-zone dependent hashes: ${hashes.join(", ")}`);
});
