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
  bytes.set(new TextEncoder().encode("WEBPVP8L"), 8);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  bytes[20] = 0x2f;
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  const packedDimensions = (
    (widthMinusOne & 0x3fff)
    | ((heightMinusOne & 0x3fff) << 14)
  ) >>> 0;
  new DataView(bytes.buffer).setUint32(21, packedDimensions, true);
  bytes.set([1, 2, 3, 4, 5], 25);
  return bytes;
}

/** @param {number} width @param {number} height */
function headerOnlyWebp(width = 1, height = 1) {
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

/** @param {Uint8Array} bytes */
function crc32(bytes) {
  let result = 0xffffffff;
  for (const byte of bytes) {
    result ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      result = (result & 1) === 1 ? 0xedb88320 ^ (result >>> 1) : result >>> 1;
    }
  }
  return (result ^ 0xffffffff) >>> 0;
}

/** @param {Uint8Array} input @param {string} name @param {Uint8Array} replacement */
function replaceStoredEntry(input, name, replacement) {
  const bytes = input.slice();
  const view = new DataView(bytes.buffer);
  const decoder = new TextDecoder();
  const checksum = crc32(replacement);
  let cursor = 0;
  let localFound = false;
  while (view.getUint32(cursor, true) === 0x04034b50) {
    const size = view.getUint32(cursor + 22, true);
    const nameLength = view.getUint16(cursor + 26, true);
    const extraLength = view.getUint16(cursor + 28, true);
    const entryName = decoder.decode(bytes.subarray(cursor + 30, cursor + 30 + nameLength));
    const dataStart = cursor + 30 + nameLength + extraLength;
    if (entryName === name) {
      assert.equal(replacement.byteLength, size);
      bytes.set(replacement, dataStart);
      view.setUint32(cursor + 14, checksum, true);
      localFound = true;
    }
    cursor = dataStart + size;
  }
  assert.equal(localFound, true);
  let centralFound = false;
  while (view.getUint32(cursor, true) === 0x02014b50) {
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const entryName = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (entryName === name) {
      view.setUint32(cursor + 16, checksum, true);
      centralFound = true;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(centralFound, true);
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

/** @param {Blob} blob */
async function decodeFixtureImage(blob) {
  assert.equal(blob.type, "image/webp");
  return { width: 1, height: 1, close() {} };
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

  const restored = await restoreImageBackup(target, bytes, {
    restoredAt: RESTORED_AT,
    decodeImage: decodeFixtureImage
  });
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

test("metadata-only WebP archives are rejected before replacing an existing image", async (context) => {
  const source = await repository(`image-backup-header-only-source-${context.name}`);
  const target = await repository(`image-backup-header-only-target-${context.name}`);
  context.after(() => {
    source.close();
    target.close();
  });
  const sourceGeneration = await seed(source, USER_A, "Alice", [world(USER_A, WORLD_A, "Archived")]);
  await source.putThumbnail(thumbnail(USER_A, WORLD_A), sourceGeneration, USER_A);
  const archive = await blobBytes(await createImageBackup(source, USER_A, {
    appVersion: "0.1.10",
    exportedAt: AT_2
  }));
  const malformed = replaceStoredEntry(
    archive,
    `thumbnails/${WORLD_A}.webp`,
    headerOnlyWebp()
  );

  const existingBytes = webp();
  existingBytes[29] = 9;
  const targetGeneration = await seed(target, USER_A, "Old Alice", [world(USER_A, WORLD_A, "Old")]);
  await target.putThumbnail(thumbnail(USER_A, WORLD_A, existingBytes), targetGeneration, USER_A);
  await assert.rejects(
    restoreImageBackup(target, malformed, {
      restoredAt: RESTORED_AT,
      decodeImage: decodeFixtureImage
    }),
    /structurally valid WebP/
  );
  assert.deepEqual(
    await blobBytes((/** @type {NonNullable<Awaited<ReturnType<DatabaseRepository["getThumbnail"]>>>} */ (
      await target.getThumbnail(USER_A, WORLD_A)
    )).blob),
    existingBytes
  );
  assert.equal((await target.getProfile(USER_A))?.displayName, "Old Alice");

  await assert.rejects(
    restoreImageBackup(target, archive, {
      restoredAt: RESTORED_AT,
      decodeImage: async () => {
        throw new Error("synthetic decoder failure");
      }
    }),
    /cannot be decoded/
  );
  assert.deepEqual(
    await blobBytes((/** @type {NonNullable<Awaited<ReturnType<DatabaseRepository["getThumbnail"]>>>} */ (
      await target.getThumbnail(USER_A, WORLD_A)
    )).blob),
    existingBytes
  );
  assert.equal((await target.getProfile(USER_A))?.displayName, "Old Alice");
});

test("image export skips retained orphan thumbnails without deleting them", async (context) => {
  const source = await repository(`image-backup-orphan-source-${context.name}`);
  const replacement = await repository(`image-backup-orphan-replacement-${context.name}`);
  context.after(() => {
    source.close();
    replacement.close();
  });
  const generation = await seed(source, USER_A, "Alice", [
    world(USER_A, WORLD_A, "Kept"),
    world(USER_A, WORLD_B, "Removed by JSON")
  ]);
  await source.putThumbnail(thumbnail(USER_A, WORLD_A), generation, USER_A);
  await source.putThumbnail(thumbnail(USER_A, WORLD_B), generation, USER_A);

  await seed(replacement, USER_A, "Alice", [world(USER_A, WORLD_A, "Kept")]);
  const json = await createBackup(replacement, USER_A, { appVersion: "0.1.10", exportedAt: AT_2 });
  await restoreBackup(source, json, { restoredAt: RESTORED_AT });
  assert.ok(await source.getThumbnail(USER_A, WORLD_B));

  const archive = await blobBytes(await createImageBackup(source, USER_A, {
    appVersion: "0.1.10",
    exportedAt: AT_2
  }));
  assert.equal(imageBackupSummary(archive).thumbnailCount, 1);
  assert.equal(parseImageBackup(archive).thumbnails[0]?.worldId, WORLD_A);
  assert.ok(await source.getThumbnail(USER_A, WORLD_B));
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
