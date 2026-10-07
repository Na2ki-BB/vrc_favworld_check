// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { IDBFactory, IDBObjectStore } from "fake-indexeddb";

import {
  MAX_IMAGE_BACKUP_BYTES,
  MAX_IMAGE_BACKUP_THUMBNAILS,
  ImageBackupExportError,
  ImageBackupValidationError,
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

// A complete 1 × 1 lossless WebP, decoded successfully with libwebp. Browser
// integration can use this exact fixture rather than a header-only fake.
function webp() {
  return new Uint8Array(Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAdQkTIUp/+BiOh/AAA=", "base64"));
}

/** @param {number} width @param {number} height */
function headerOnlyWebp(width = 1, height = 1) {
  const bytes = new Uint8Array(webp().byteLength);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(bytes.buffer).setUint32(4, bytes.byteLength - 8, true);
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
  bytes.set(new TextEncoder().encode("JUNK"), 30);
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
    hiddenCount: 0,
    purgedCount: 0,
    sourceVersion: 3,
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
    world(USER_A, WORLD_B, "Removed by JSON"),
    world(USER_A, WORLD_C, "Also removed by JSON")
  ]);
  await source.putThumbnail(thumbnail(USER_A, WORLD_A), generation, USER_A);
  await source.putThumbnail(thumbnail(USER_A, WORLD_B), generation, USER_A);
  await source.putThumbnail(thumbnail(USER_A, WORLD_C), generation, USER_A);
  const boundedBeforeRestore = await source.getBackupSnapshot(USER_A, {
    includeThumbnails: true,
    thumbnailLimit: 1
  });
  assert.equal(boundedBeforeRestore.thumbnails?.length, 2);

  await seed(replacement, USER_A, "Alice", [world(USER_A, WORLD_A, "Kept")]);
  const json = await createBackup(replacement, USER_A, { appVersion: "0.1.10", exportedAt: AT_2 });
  await restoreBackup(source, json, { restoredAt: RESTORED_AT });
  assert.ok(await source.getThumbnail(USER_A, WORLD_B));
  assert.ok(await source.getThumbnail(USER_A, WORLD_C));

  const boundedAfterRestore = await source.getBackupSnapshot(USER_A, {
    includeThumbnails: true,
    thumbnailLimit: 1
  });
  assert.equal(boundedAfterRestore.thumbnails?.length, 1);

  const archive = await blobBytes(await createImageBackup(source, USER_A, {
    appVersion: "0.1.10",
    exportedAt: AT_2
  }));
  assert.equal(imageBackupSummary(archive).thumbnailCount, 1);
  assert.equal(parseImageBackup(archive).thumbnails[0]?.worldId, WORLD_A);
  assert.ok(await source.getThumbnail(USER_A, WORLD_B));
  assert.ok(await source.getThumbnail(USER_A, WORLD_C));
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

/** @param {{name:string, bytes:Uint8Array}[]} entries */
function storedArchive(entries) {
  const encoded = entries.map((entry) => ({...entry, nameBytes: new TextEncoder().encode(entry.name)}));
  const localLength = encoded.reduce((sum, entry) => sum + 30 + entry.nameBytes.length + entry.bytes.length, 0);
  const centralLength = encoded.reduce((sum, entry) => sum + 46 + entry.nameBytes.length, 0);
  const bytes = new Uint8Array(localLength + centralLength + 22);
  const view = new DataView(bytes.buffer);
  let local = 0;
  let central = localLength;
  for (const entry of encoded) {
    const crc = crc32(entry.bytes);
    view.setUint32(local, 0x04034b50, true);
    view.setUint16(local + 4, 20, true);
    view.setUint16(local + 6, 0x0800, true);
    view.setUint32(local + 14, crc, true);
    view.setUint32(local + 18, entry.bytes.length, true);
    view.setUint32(local + 22, entry.bytes.length, true);
    view.setUint16(local + 26, entry.nameBytes.length, true);
    bytes.set(entry.nameBytes, local + 30);
    bytes.set(entry.bytes, local + 30 + entry.nameBytes.length);
    view.setUint32(central, 0x02014b50, true);
    view.setUint16(central + 4, 20, true);
    view.setUint16(central + 6, 20, true);
    view.setUint16(central + 8, 0x0800, true);
    view.setUint32(central + 16, crc, true);
    view.setUint32(central + 20, entry.bytes.length, true);
    view.setUint32(central + 24, entry.bytes.length, true);
    view.setUint16(central + 28, entry.nameBytes.length, true);
    view.setUint32(central + 42, local, true);
    bytes.set(entry.nameBytes, central + 46);
    local += 30 + entry.nameBytes.length + entry.bytes.length;
    central += 46 + entry.nameBytes.length;
  }
  view.setUint32(central, 0x06054b50, true);
  view.setUint16(central + 8, entries.length, true);
  view.setUint16(central + 10, entries.length, true);
  view.setUint32(central + 12, centralLength, true);
  view.setUint32(central + 16, localLength, true);
  return bytes;
}

/** @param {Uint8Array} bytes */
function storedEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = [];
  let cursor = 0;
  while (view.getUint32(cursor, true) === 0x04034b50) {
    const size = view.getUint32(cursor + 22, true);
    const nameLength = view.getUint16(cursor + 26, true);
    const dataStart = cursor + 30 + nameLength;
    entries.push({
      name: new TextDecoder().decode(bytes.subarray(cursor + 30, dataStart)),
      bytes: bytes.slice(dataStart, dataStart + size)
    });
    cursor = dataStart + size;
  }
  return entries;
}

/** @param {Awaited<ReturnType<DatabaseRepository["getBackupSnapshot"]>>} snapshot */
function snapshotRepository(snapshot) {
  return /** @type {DatabaseRepository} */ (/** @type {unknown} */ ({getBackupSnapshot: async () => snapshot}));
}

/** @param {number} index */
function numberedWorldId(index) {
  return `wrld_${index.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
}

test("image archive rejects an oversized input before copying it", () => {
  const buffer = new ArrayBuffer(MAX_IMAGE_BACKUP_BYTES + 1);
  for (const input of [buffer, new Uint8Array(buffer)]) {
    Object.defineProperty(input, "slice", {value: () => { throw new Error("Must not copy oversized input"); }});
    assert.throws(() => parseImageBackup(input), /archive size must be between/);
  }
});

test("ZIP local ranges are rejected before checksumming overlapping payloads", () => {
  const bytes = storedArchive([
    {name: "backup.json", bytes: new Uint8Array(128)},
    {name: "thumbnails/index.json", bytes: new TextEncoder().encode("{}")}
  ]);
  const view = new DataView(bytes.buffer);
  const firstHeaderLength = 30 + "backup.json".length;
  const secondOffset = firstHeaderLength + 128;
  const secondLength = 30 + "thumbnails/index.json".length + 2;
  const centralOffset = secondOffset + secondLength;
  // Embed the second local entry inside the first payload. This also corrupts
  // the first CRC; the structural rejection must win before reading any data.
  bytes.set(bytes.slice(secondOffset, centralOffset), firstHeaderLength + 1);
  const secondCentral = centralOffset + 46 + "backup.json".length;
  view.setUint32(secondCentral + 42, firstHeaderLength + 1, true);
  assert.throws(() => parseImageBackup(bytes), /overlapping or hidden local data/);
});

test("export rejects the exact archive byte budget before reading any image blobs", async (context) => {
  const source = await repository(context.name);
  context.after(() => source.close());
  await seed(source, USER_A, "Alice", []);
  const snapshot = await source.getBackupSnapshot(USER_A);
  const blob = new Blob([new Uint8Array(48 * 1024)], {type: "image/webp"});
  let reads = 0;
  Object.defineProperty(blob, "arrayBuffer", {value: () => { reads += 1; throw new Error("Should not read over-budget image blobs"); }});
  snapshot.worlds = Array.from({length: 1_350}, (_, index) => world(USER_A, numberedWorldId(index), `World ${index}`));
  snapshot.thumbnails = snapshot.worlds.map((entry) => ({...thumbnail(USER_A, entry.worldId), blob, byteLength: blob.size}));
  assert.ok(snapshot.thumbnails.length * blob.size < MAX_IMAGE_BACKUP_BYTES);
  await assert.rejects(createImageBackup(snapshotRepository(snapshot), USER_A), (error) =>
    error instanceof ImageBackupExportError && error.code === "ARCHIVE_SIZE_LIMIT");
  assert.equal(reads, 0);
});

test("export reports count, invalid metadata, and unreadable stored image errors without omitting records", async (context) => {
  const source = await repository(context.name);
  context.after(() => source.close());
  await seed(source, USER_A, "Alice", [world(USER_A, WORLD_A, "Archived")]);
  const snapshot = await source.getBackupSnapshot(USER_A);
  snapshot.thumbnails = Array.from({length: MAX_IMAGE_BACKUP_THUMBNAILS + 1}, () => thumbnail(USER_A, WORLD_A));
  await assert.rejects(createImageBackup(snapshotRepository(snapshot), USER_A), (error) =>
    error instanceof ImageBackupExportError && error.code === "THUMBNAIL_COUNT_LIMIT");
  const unreadable = thumbnail(USER_A, WORLD_A);
  Object.defineProperty(unreadable.blob, "arrayBuffer", {value: async () => { throw new Error("Synthetic Blob read failure"); }});
  for (const record of [
    unreadable,
    {...thumbnail(USER_A, WORLD_A), capturedAt: "not a timestamp"},
    {...thumbnail(USER_A, WORLD_A), byteLength: 1},
    thumbnail(USER_B, WORLD_A),
    thumbnail(USER_A, WORLD_A, headerOnlyWebp())
  ]) {
    snapshot.thumbnails = [record];
    await assert.rejects(createImageBackup(snapshotRepository(snapshot), USER_A), (error) =>
      error instanceof ImageBackupExportError && error.code === "INVALID_THUMBNAIL");
  }
});

test("image archives preserve hidden worlds and purged tombstones with atomic thumbnail cleanup", async (context) => {
  const source = await repository(`${context.name}-source`);
  const target = await repository(`${context.name}-target`);
  context.after(() => { source.close(); target.close(); });
  const generation = await source.replaceProfileData({
    profile: profile(USER_A, "Alice"), worlds: [world(USER_A, WORLD_A, "Hidden")], events: [], favoriteGroups: [],
    worldDispositions: [
      {userId: USER_A, worldId: WORLD_A, state: "hidden"},
      {userId: USER_A, worldId: WORLD_B, state: "purged"}
    ]
  });
  await source.setSetting("activeProfileId", USER_A);
  await source.putThumbnail(thumbnail(USER_A, WORLD_A), generation, USER_A);
  const archive = await blobBytes(await createImageBackup(source, USER_A));
  const parsed = parseImageBackup(archive);
  assert.deepEqual(parsed.thumbnails.map((entry) => entry.worldId), [WORLD_A]);
  assert.equal(imageBackupSummary(archive).hiddenCount, 1);
  assert.equal(imageBackupSummary(archive).purgedCount, 1);
  const oldGeneration = await seed(target, USER_A, "Old Alice", [world(USER_A, WORLD_A, "Old A"), world(USER_A, WORLD_B, "Old B")]);
  await target.putThumbnail(thumbnail(USER_A, WORLD_B), oldGeneration, USER_A);
  await restoreImageBackup(target, archive, {decodeImage: decodeFixtureImage});
  assert.deepEqual(await target.listWorldDispositions(USER_A), parsed.backup.worldDispositions.map((row) => ({...row})));
  assert.ok(await target.getThumbnail(USER_A, WORLD_A));
  assert.equal(await target.getThumbnail(USER_A, WORLD_B), null);
  assert.equal(await target.getDataGeneration(USER_A), oldGeneration + 1);
  const entries = storedEntries(archive);
  const index = entries.find((entry) => entry.name === "thumbnails/index.json");
  assert.ok(index);
  const raw = JSON.parse(new TextDecoder().decode(index.bytes));
  raw.thumbnails[0].worldId = WORLD_B;
  raw.thumbnails[0].path = `thumbnails/${WORLD_B}.webp`;
  index.bytes = new TextEncoder().encode(JSON.stringify(raw));
  const image = entries.find((entry) => entry.name === `thumbnails/${WORLD_A}.webp`);
  assert.ok(image);
  image.name = `thumbnails/${WORLD_B}.webp`;
  assert.throws(() => parseImageBackup(storedArchive(entries)), /worldId is invalid or duplicated/);
});

test("archive image and record writes roll back together on a thumbnail storage failure", async (context) => {
  const source = await repository(`${context.name}-source`);
  const target = await repository(`${context.name}-target`);
  context.after(() => { source.close(); target.close(); });
  const generation = await seed(source, USER_A, "Alice", [world(USER_A, WORLD_A, "Archived")]);
  await source.putThumbnail(thumbnail(USER_A, WORLD_A), generation, USER_A);
  const archive = await blobBytes(await createImageBackup(source, USER_A));
  const oldGeneration = await seed(target, USER_A, "Old Alice", [world(USER_A, WORLD_A, "Old")]);
  await target.putThumbnail(thumbnail(USER_A, WORLD_A), oldGeneration, USER_A);
  const before = await target.getBackupSnapshot(USER_A, {includeThumbnails: true});
  const presentation = await target.getPresentationGeneration(USER_A);
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value, key) {
    if (this.name === "thumbnails") throw new DOMException("Synthetic quota failure", "QuotaExceededError");
    return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
  };
  try {
    await assert.rejects(restoreImageBackup(target, archive, {decodeImage: decodeFixtureImage}), /IndexedDB transaction aborted|Synthetic quota failure/);
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
  assert.deepEqual(await target.getBackupSnapshot(USER_A, {includeThumbnails: true}), before);
  assert.equal(await target.getDataGeneration(USER_A), oldGeneration);
  assert.equal(await target.getPresentationGeneration(USER_A), presentation);
});

test("missing, duplicate, and undeclared images and metadata are rejected independently of CRC", async (context) => {
  const source = await repository(context.name);
  context.after(() => source.close());
  const generation = await seed(source, USER_A, "Alice", [world(USER_A, WORLD_A, "Archived")]);
  await source.putThumbnail(thumbnail(USER_A, WORLD_A), generation, USER_A);
  const archive = await blobBytes(await createImageBackup(source, USER_A));
  const entries = storedEntries(archive);
  const index = entries.find((entry) => entry.name === "thumbnails/index.json");
  const image = entries.find((entry) => entry.name === `thumbnails/${WORLD_A}.webp`);
  assert.ok(index && image);
  assert.throws(() => parseImageBackup(storedArchive(entries.filter((entry) => entry !== image))), /missing or has the wrong size/);
  assert.throws(() => parseImageBackup(storedArchive([...entries, image])), /duplicate entry paths/);
  const raw = JSON.parse(new TextDecoder().decode(index.bytes));
  raw.thumbnails.push(raw.thumbnails[0]);
  const duplicated = entries.map((entry) => entry === index ? {...entry, bytes: new TextEncoder().encode(JSON.stringify(raw))} : entry);
  assert.throws(() => parseImageBackup(storedArchive(duplicated)), /worldId is invalid or duplicated/);
  raw.thumbnails = [];
  const undeclared = entries.map((entry) => entry === index ? {...entry, bytes: new TextEncoder().encode(JSON.stringify(raw))} : entry);
  assert.throws(() => parseImageBackup(storedArchive(undeclared)), /not declared by the thumbnail index/);
});

test("canceling pending image decode prevents restore and closes the late bitmap", async (context) => {
  const source = await repository(`${context.name}-source`);
  const target = await repository(`${context.name}-target`);
  context.after(() => { source.close(); target.close(); });
  const generation = await seed(source, USER_A, "Alice", [world(USER_A, WORLD_A, "Archived")]);
  await source.putThumbnail(thumbnail(USER_A, WORLD_A), generation, USER_A);
  const archive = await blobBytes(await createImageBackup(source, USER_A));
  await seed(target, USER_A, "Old Alice", [world(USER_A, WORLD_A, "Old")]);
  const controller = new AbortController();
  const deferred = deferredBitmap();
  let closed = 0;
  const restore = restoreImageBackup(target, archive, {
    signal: controller.signal,
    decodeImage: () => deferred.promise
  });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(restore, {name: "AbortError"});
  deferred.resolve({width: 1, height: 1, close: () => { closed += 1; }});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 1);
  assert.equal((await target.getProfile(USER_A))?.displayName, "Old Alice");
  assert.equal(await target.getThumbnail(USER_A, WORLD_A), null);
  await assert.rejects(restoreImageBackup(target, new Uint8Array(), {signal: controller.signal}), {name: "AbortError"});
});

test("decode timeout and decoded-dimension failures leave records unchanged and release bitmaps", async (context) => {
  const source = await repository(`${context.name}-source`);
  const target = await repository(`${context.name}-target`);
  context.after(() => { source.close(); target.close(); });
  const generation = await seed(source, USER_A, "Alice", [world(USER_A, WORLD_A, "Archived")]);
  await source.putThumbnail(thumbnail(USER_A, WORLD_A), generation, USER_A);
  const archive = await blobBytes(await createImageBackup(source, USER_A));
  await seed(target, USER_A, "Old Alice", [world(USER_A, WORLD_A, "Old")]);
  let closed = 0;
  await assert.rejects(restoreImageBackup(target, archive, {
    decodeImage: async () => ({width: 2, height: 1, close: () => { closed += 1; }})
  }), (error) => error instanceof ImageBackupValidationError && /dimensions/.test(error.message));
  assert.equal(closed, 1);
  context.mock.timers.enable({apis: ["setTimeout"]});
  const deferred = deferredBitmap();
  const restore = restoreImageBackup(target, archive, {decodeImage: () => deferred.promise});
  await Promise.resolve();
  const rejected = assert.rejects(restore, /decoding timed out/);
  context.mock.timers.tick(10_000);
  await rejected;
  context.mock.timers.reset();
  deferred.resolve({width: 1, height: 1, close: () => { closed += 1; }});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 2);
  assert.equal((await target.getProfile(USER_A))?.displayName, "Old Alice");
});

test("an archive without cached images restores without invoking a decoder", async (context) => {
  const source = await repository(`${context.name}-source`);
  const target = await repository(`${context.name}-target`);
  context.after(() => { source.close(); target.close(); });
  await seed(source, USER_A, "Alice", [world(USER_A, WORLD_A, "No image")]);
  const archive = await blobBytes(await createImageBackup(source, USER_A));
  const result = await restoreImageBackup(target, archive, {decodeImage: async () => { throw new Error("No image to decode"); }});
  assert.equal(result.thumbnailCount, 0);
  assert.equal((await target.getProfile(USER_A))?.displayName, "Alice");
});

/** @typedef {{width:number,height:number,close:()=>void}} FixtureBitmap */
function deferredBitmap() {
  /** @type {(bitmap:FixtureBitmap) => void} */
  let resolve = () => {};
  /** @type {Promise<FixtureBitmap>} */
  const promise = new Promise((complete) => { resolve = complete; });
  return {promise, resolve};
}


test("export rejects the index byte budget before reading image blobs", async (context) => {
  const source = await repository(context.name);
  context.after(() => source.close());
  await seed(source, USER_A, "Alice", []);
  const snapshot = await source.getBackupSnapshot(USER_A);
  const blob = new Blob([webp()], {type: "image/webp"});
  let reads = 0;
  Object.defineProperty(blob, "arrayBuffer", {value: () => { reads += 1; throw new Error("Should not read images with oversized index"); }});
  snapshot.worlds = Array.from({length: 1_300}, (_, index) => world(USER_A, numberedWorldId(index), `World ${index}`));
  snapshot.thumbnails = snapshot.worlds.map((entry) => ({
    ...thumbnail(USER_A, entry.worldId), blob,
    sourceUrl: `https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${"1".repeat(3_900)}/256`
  }));
  await assert.rejects(createImageBackup(snapshotRepository(snapshot), USER_A), (error) =>
    error instanceof ImageBackupExportError && error.code === "INDEX_SIZE_LIMIT");
  assert.equal(reads, 0);
});

test("cancellation between decoded images stops later decodes and the atomic replacement", async (context) => {
  const source = await repository(`${context.name}-source`);
  const target = await repository(`${context.name}-target`);
  context.after(() => { source.close(); target.close(); });
  const generation = await seed(source, USER_A, "Alice", [world(USER_A, WORLD_A, "A"), world(USER_A, WORLD_B, "B")]);
  await source.putThumbnail(thumbnail(USER_A, WORLD_A), generation, USER_A);
  await source.putThumbnail(thumbnail(USER_A, WORLD_B), generation, USER_A);
  const archive = await blobBytes(await createImageBackup(source, USER_A));
  await seed(target, USER_A, "Old Alice", [world(USER_A, WORLD_A, "Old")]);
  const controller = new AbortController();
  let decodes = 0;
  let closes = 0;
  await assert.rejects(restoreImageBackup(target, archive, {
    signal: controller.signal,
    decodeImage: async () => {
      decodes += 1;
      return {width: 1, height: 1, close: () => { closes += 1; controller.abort(); }};
    }
  }), {name: "AbortError"});
  assert.equal(decodes, 1);
  assert.equal(closes, 1);
  assert.equal((await target.getProfile(USER_A))?.displayName, "Old Alice");
});
