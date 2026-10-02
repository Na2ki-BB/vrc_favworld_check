// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { IDBFactory } from "fake-indexeddb";

import {
  MAX_IMAGE_BACKUP_BYTES,
  createImageBackup,
  imageBackupSummary,
  parseImageBackup,
  restoreImageBackup
} from "../extension/lib/backup-archive.js";
import { createBackup, restoreBackup } from "../extension/lib/backup.js";
import { DatabaseRepository } from "../extension/lib/database.js";
import { normalizeSearchText } from "../extension/lib/domain.js";

const USER_A = "usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "usr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORLD_A = "wrld_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORLD_B = "wrld_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORLD_C = "wrld_cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AT_1 = "2026-08-17T00:00:00.000Z";
const AT_2 = "2026-08-18T00:00:00.000Z";
const RESTORED_AT = "2026-08-20T00:00:00.000Z";

/** @param {string} userId @param {string} name */
function profile(userId, name) {
  return {
    userId,
    displayName: name,
    firstSeenAt: AT_1,
    lastSuccessfulSyncAt: AT_2,
    createdBySchemaVersion: 3
  };
}

/** @param {string} userId @param {string} worldId @param {string} name */
function world(userId, worldId, name) {
  return {
    userId,
    worldId,
    currentName: name,
    normalizedName: normalizeSearchText(name),
    authorName: "Fixture Author",
    normalizedAuthorName: normalizeSearchText("Fixture Author"),
    favoriteTags: ["worlds1"],
    firstSeenAt: AT_1,
    lastSeenFavoriteAt: AT_2,
    lastMetadataAt: AT_2,
    membershipState: /** @type {const} */ ("favorited"),
    membershipMissCount: /** @type {const} */ (0),
    availabilityState: /** @type {const} */ ("accessible"),
    unavailableCount: /** @type {const} */ (0),
    probeState: /** @type {const} */ ("none"),
    lastProbeAt: null,
    lastEvidenceStatus: /** @type {const} */ (200),
    revision: 1,
    updatedAt: AT_2
  };
}

/** @param {number} width @param {number} height */
function webp(width = 1, height = 1) {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(bytes.buffer).setUint32(4, 22, true);
  bytes.set(new TextEncoder().encode("WEBPVP8X"), 8);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  bytes[24] = widthMinusOne & 0xff;
  bytes[25] = (widthMinusOne >>> 8) & 0xff;
  bytes[26] = (widthMinusOne >>> 16) & 0xff;
  bytes[27] = heightMinusOne & 0xff;
  bytes[28] = (heightMinusOne >>> 8) & 0xff;
  bytes[29] = (heightMinusOne >>> 16) & 0xff;
  return bytes;
}

/** @param {string} userId @param {string} worldId @param {Uint8Array} bytes */
function thumbnail(userId, worldId, bytes = webp()) {
  const blobBytes = new Uint8Array(bytes.byteLength);
  blobBytes.set(bytes);
  return {
    userId,
    worldId,
    blob: new Blob([blobBytes.buffer], { type: "image/webp" }),
    width: 1,
    height: 1,
    byteLength: bytes.byteLength,
    capturedAt: AT_2,
    sourceUrl: "https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1/256"
  };
}

/** @param {string} name */
async function repository(name) {
  const database = new DatabaseRepository({ factory: new IDBFactory(), name });
  await database.open();
  return database;
}

/**
 * @param {DatabaseRepository} database
 * @param {string} userId
 * @param {string} displayName
 * @param {ReturnType<typeof world>[]} worlds
 */
async function seed(database, userId, displayName, worlds) {
  const generation = await database.replaceProfileData({
    profile: profile(userId, displayName),
    worlds,
    favoriteGroups: [],
    events: [],
    preferences: { autoSyncEnabled: true, notificationsEnabled: false }
  });
  await database.setSetting("activeProfileId", userId);
  return generation;
}

/** @param {Blob} blob */
async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

/** @param {Uint8Array} bytes @param {string} text @param {string} replacement */
function replaceAscii(bytes, text, replacement) {
  assert.equal(text.length, replacement.length);
  const needle = new TextEncoder().encode(text);
  const value = new TextEncoder().encode(replacement);
  let replacements = 0;
  for (let offset = 0; offset <= bytes.length - needle.length; offset += 1) {
    if (needle.every((byte, index) => bytes[offset + index] === byte)) {
      bytes.set(value, offset);
      replacements += 1;
      offset += needle.length - 1;
    }
  }
  assert.ok(replacements >= 1);
}

/** @param {Uint8Array} bytes @param {number} signature */
function findSignature(bytes, signature) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.byteLength - 4; offset += 1) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  throw new Error("ZIP signature not found");
}

test("image backup round-trips while retaining unrelated profiles and existing images", async (context) => {
  const source = await repository(`image-backup-source-${context.name}`);
  const target = await repository(`image-backup-target-${context.name}`);
  context.after(() => {
    source.close();
    target.close();
  });

  const sourceGeneration = await seed(source, USER_A, "Alice", [
    world(USER_A, WORLD_A, "Archived A"),
    world(USER_A, WORLD_B, "Archived B")
  ]);
  const privateSentinel = "synthetic-operational-state-must-not-export";
  await source.setSetting("backoffUntil", privateSentinel);
  await source.putThumbnail(thumbnail(USER_A, WORLD_A), sourceGeneration, USER_A);
  const archive = await createImageBackup(source, USER_A, {
    appVersion: "0.1.10",
    exportedAt: AT_2
  });
  assert.ok(archive.size < MAX_IMAGE_BACKUP_BYTES);
  const bytes = await blobBytes(archive);
  assert.equal(new TextDecoder().decode(bytes).includes(privateSentinel), false);
  assert.deepEqual(imageBackupSummary(bytes), {
    userId: USER_A,
    displayName: "Alice",
    worldCount: 2,
    eventCount: 0,
    groupCount: 0,
    exportedAt: AT_2,
    thumbnailCount: 1
  });

  const targetGeneration = await seed(target, USER_A, "Old Alice", [
    world(USER_A, WORLD_A, "Old A"),
    world(USER_A, WORLD_B, "Old B")
  ]);
  await target.putThumbnail(thumbnail(USER_A, WORLD_B), targetGeneration, USER_A);
  await seed(target, USER_B, "Bob", [world(USER_B, WORLD_C, "Bob world")]);

  const restored = await restoreImageBackup(target, bytes, { restoredAt: RESTORED_AT });
  assert.equal(restored.thumbnailCount, 1);
  assert.equal((await target.getProfile(USER_A))?.displayName, "Alice");
  assert.equal((await target.getProfile(USER_B))?.displayName, "Bob");
  assert.ok(await target.getThumbnail(USER_A, WORLD_A));
  assert.ok(await target.getThumbnail(USER_A, WORLD_B));
});

test("legacy JSON restore remains compatible and preserves existing thumbnails", async (context) => {
  const source = await repository(`json-backup-source-${context.name}`);
  const target = await repository(`json-backup-target-${context.name}`);
  context.after(() => {
    source.close();
    target.close();
  });
  await seed(source, USER_A, "Alice", [world(USER_A, WORLD_A, "Archived")]);
  const text = await createBackup(source, USER_A, { appVersion: "0.1.10", exportedAt: AT_2 });
  const generation = await seed(target, USER_A, "Old Alice", [world(USER_A, WORLD_A, "Old")]);
  await target.putThumbnail(thumbnail(USER_A, WORLD_A), generation, USER_A);
  await restoreBackup(target, text, { restoredAt: RESTORED_AT });
  assert.ok(await target.getThumbnail(USER_A, WORLD_A));
  assert.equal((await target.getProfile(USER_A))?.displayName, "Alice");
});

test("image backup rejects unsafe paths, compression, oversized declarations, corruption, and undeclared images", async (context) => {
  const source = await repository(`image-backup-invalid-${context.name}`);
  context.after(() => source.close());
  const generation = await seed(source, USER_A, "Alice", [world(USER_A, WORLD_A, "Archived")]);
  await source.putThumbnail(thumbnail(USER_A, WORLD_A), generation, USER_A);
  const original = await blobBytes(await createImageBackup(source, USER_A, {
    appVersion: "0.1.10",
    exportedAt: AT_2
  }));

  const traversal = original.slice();
  replaceAscii(traversal, "backup.json", "../evil.txt");
  assert.throws(() => parseImageBackup(traversal), /entry path is unsafe/);

  const compressed = original.slice();
  const firstLocal = findSignature(compressed, 0x04034b50);
  const firstCentral = findSignature(compressed, 0x02014b50);
  new DataView(compressed.buffer).setUint16(firstLocal + 8, 8, true);
  new DataView(compressed.buffer).setUint16(firstCentral + 10, 8, true);
  assert.throws(() => parseImageBackup(compressed), /stored UTF-8 files/);

  const oversized = original.slice();
  const oversizedCentral = findSignature(oversized, 0x02014b50);
  new DataView(oversized.buffer).setUint32(oversizedCentral + 24, MAX_IMAGE_BACKUP_BYTES, true);
  assert.throws(
    () => parseImageBackup(oversized),
    /entry is too large|disagrees|stored UTF-8 files/
  );

  const corrupted = original.slice();
  const riff = new TextEncoder().encode("RIFF");
  const imageOffset = corrupted.findIndex((byte, index) =>
    byte === riff[0] && riff.every((candidate, inner) => corrupted[index + inner] === candidate)
  );
  assert.ok(imageOffset >= 0);
  corrupted[imageOffset + 20] = (corrupted[imageOffset + 20] ?? 0) ^ 0xff;
  assert.throws(() => parseImageBackup(corrupted), /checksum does not match/);

  const undeclared = original.slice();
  replaceAscii(undeclared, WORLD_A, WORLD_C);
  assert.throws(
    () => parseImageBackup(undeclared),
    /checksum does not match|missing or has the wrong size|not declared by the thumbnail index/
  );
});
