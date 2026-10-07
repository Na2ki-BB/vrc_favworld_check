// @ts-check

import { isAllowedVrchatImageUrl } from "./api.js";
import {
  MAX_BACKUP_BYTES,
  backupSummary,
  restoreValidatedBackup,
  serializeBackupSnapshot,
  validateBackup
} from "./backup.js";
import {
  THUMBNAIL_MAX_BYTE_LENGTH,
  THUMBNAIL_MAX_DIMENSION
} from "./database.js";
import { readWebpDimensions } from "./thumbnail.js";

/** @typedef {import("./database.js").DatabaseRepository} DatabaseRepository */
/** @typedef {NonNullable<Awaited<ReturnType<DatabaseRepository["getThumbnail"]>>>} ThumbnailRecord */
/** @typedef {ReturnType<typeof validateBackup>} ValidatedBackup */

export const IMAGE_BACKUP_FORMAT = "vrc_favworld_check-image-backup";
export const IMAGE_BACKUP_VERSION = 1;
export const MAX_IMAGE_BACKUP_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_BACKUP_THUMBNAILS = 10_000;

export class ImageBackupExportError extends Error {
  /** @param {"ARCHIVE_SIZE_LIMIT" | "THUMBNAIL_COUNT_LIMIT" | "INDEX_SIZE_LIMIT" | "INVALID_THUMBNAIL"} code */
  constructor(code) {
    super("Image backup export could not be completed");
    this.name = "ImageBackupExportError";
    this.code = code;
  }
}

export class ImageBackupValidationError extends TypeError {
  /** @param {string} message */
  constructor(message) {
    super(`Invalid image backup: ${message}`);
    this.name = "ImageBackupValidationError";
  }
}

const BACKUP_ENTRY = "backup.json";
const INDEX_ENTRY = "thumbnails/index.json";
const MAX_INDEX_BYTES = 5 * 1024 * 1024;
const MAX_ZIP_ENTRIES = MAX_IMAGE_BACKUP_THUMBNAILS + 2;
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const USER_ID_PATTERN = /^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORLD_ID_PATTERN = /^wrld_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @type {Uint32Array | null} */
let crcTable = null;

/** @param {string} message @returns {never} */
function invalid(message) {
  throw new ImageBackupValidationError(message);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} value
 * @param {readonly string[]} fields
 * @param {string} path
 */
function requireExactFields(value, fields, path) {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(`${path} has unsupported fields`);
  }
}

/** @param {unknown} value @param {string} path @param {number} maximum @returns {number} */
function boundedInteger(value, path, maximum) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    invalid(`${path} is outside its supported range`);
  }
  return value;
}

/** @param {unknown} value @param {string} path */
function canonicalDate(value, path) {
  if (typeof value !== "string") {
    invalid(`${path} must be a timestamp`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    invalid(`${path} must be a canonical UTC timestamp`);
  }
  return value;
}

/** @param {Uint8Array} bytes */
function crc32(bytes) {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }
  let result = 0xffffffff;
  for (const byte of bytes) {
    result = (/** @type {Uint32Array} */ (crcTable)[(result ^ byte) & 0xff] ?? 0) ^ (result >>> 8);
  }
  return (result ^ 0xffffffff) >>> 0;
}

/** @param {DataView} view @param {number} offset @param {number} value */
function put16(view, offset, value) {
  view.setUint16(offset, value, true);
}

/** @param {DataView} view @param {number} offset @param {number} value */
function put32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

/** @param {string} name @param {number} size */
function storedEntryLength(name, size) {
  return 76 + 2 * new TextEncoder().encode(name).byteLength + size;
}

/**
 * Create a deliberately small ZIP subset: UTF-8 names, stored entries, no
 * extras, comments, descriptors, encryption, or Zip64. Check the exact length
 * before allocating the output, and write each payload once.
 *
 * @param {{name: string, bytes: Uint8Array}[]} entries
 */
function encodeStoredZip(entries) {
  const encoder = new TextEncoder();
  const length = 22 + entries.reduce((sum, entry) => sum + storedEntryLength(entry.name, entry.bytes.byteLength), 0);
  if (length > MAX_IMAGE_BACKUP_BYTES) throw new ImageBackupExportError("ARCHIVE_SIZE_LIMIT");
  const output = new Uint8Array(length);
  const view = new DataView(output.buffer);
  const centralOffset = entries.reduce((sum, entry) => sum + 30 + encoder.encode(entry.name).byteLength + entry.bytes.byteLength, 0);
  let local = 0;
  let central = centralOffset;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const checksum = crc32(entry.bytes);
    put32(view, local, LOCAL_SIGNATURE);
    put16(view, local + 4, 20);
    put16(view, local + 6, UTF8_FLAG);
    put16(view, local + 8, STORE_METHOD);
    put32(view, local + 14, checksum);
    put32(view, local + 18, entry.bytes.byteLength);
    put32(view, local + 22, entry.bytes.byteLength);
    put16(view, local + 26, name.byteLength);
    output.set(name, local + 30);
    output.set(entry.bytes, local + 30 + name.byteLength);

    put32(view, central, CENTRAL_SIGNATURE);
    put16(view, central + 4, 20);
    put16(view, central + 6, 20);
    put16(view, central + 8, UTF8_FLAG);
    put16(view, central + 10, STORE_METHOD);
    put32(view, central + 16, checksum);
    put32(view, central + 20, entry.bytes.byteLength);
    put32(view, central + 24, entry.bytes.byteLength);
    put16(view, central + 28, name.byteLength);
    put32(view, central + 42, local);
    output.set(name, central + 46);
    local += 30 + name.byteLength + entry.bytes.byteLength;
    central += 46 + name.byteLength;
  }
  put32(view, central, END_SIGNATURE);
  put16(view, central + 8, entries.length);
  put16(view, central + 10, entries.length);
  put32(view, central + 12, central - centralOffset);
  put32(view, central + 16, centralOffset);
  return output;
}

/** @param {Uint8Array} bytes @param {number} offset */
function read16(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.byteLength) invalid("ZIP structure is truncated");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, true);
}

/** @param {Uint8Array} bytes @param {number} offset */
function read32(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.byteLength) invalid("ZIP structure is truncated");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

/** @param {Uint8Array} bytes */
function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid("entry name or JSON is not valid UTF-8");
  }
}

/** @param {string} name */
function requireSafeEntryName(name) {
  if (
    name.length === 0
    || name.length > 200
    || name.includes("\\")
    || name.includes("\0")
    || name.startsWith("/")
    || /^[A-Za-z]:/u.test(name)
    || name.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    invalid("entry path is unsafe");
  }
  const allowed = name === BACKUP_ENTRY
    || name === INDEX_ENTRY
    || /^thumbnails\/wrld_[0-9a-f-]{36}\.webp$/iu.test(name);
  if (!allowed) {
    invalid(`entry path is not supported: ${name}`);
  }
}

/**
 * @param {Uint8Array} bytes
 * @returns {Map<string, Uint8Array>}
 */
function parseStoredZip(bytes) {
  if (bytes.byteLength < 22 || bytes.byteLength > MAX_IMAGE_BACKUP_BYTES) {
    invalid(`archive size must be between 22 and ${MAX_IMAGE_BACKUP_BYTES} bytes`);
  }
  const endOffset = bytes.byteLength - 22;
  if (read32(bytes, endOffset) !== END_SIGNATURE || read16(bytes, endOffset + 20) !== 0) {
    invalid("ZIP end record is missing or has a comment");
  }
  if (read16(bytes, endOffset + 4) !== 0 || read16(bytes, endOffset + 6) !== 0) {
    invalid("multi-disk ZIP files are not supported");
  }
  const diskEntries = read16(bytes, endOffset + 8);
  const totalEntries = read16(bytes, endOffset + 10);
  const centralSize = read32(bytes, endOffset + 12);
  const centralOffset = read32(bytes, endOffset + 16);
  if (
    diskEntries !== totalEntries
    || totalEntries < 2
    || totalEntries > MAX_ZIP_ENTRIES
    || centralOffset + centralSize !== endOffset
  ) {
    invalid("ZIP directory is inconsistent or too large");
  }

  /** @type {{name:string,crc:number,size:number,localOffset:number}[]} */
  const directory = [];
  const names = new Set();
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (read32(bytes, cursor) !== CENTRAL_SIGNATURE) invalid("central directory is malformed");
    const flags = read16(bytes, cursor + 8);
    const method = read16(bytes, cursor + 10);
    const checksum = read32(bytes, cursor + 16);
    const compressedSize = read32(bytes, cursor + 20);
    const size = read32(bytes, cursor + 24);
    const nameLength = read16(bytes, cursor + 28);
    const extraLength = read16(bytes, cursor + 30);
    const commentLength = read16(bytes, cursor + 32);
    const disk = read16(bytes, cursor + 34);
    const localOffset = read32(bytes, cursor + 42);
    if (
      flags !== UTF8_FLAG
      || method !== STORE_METHOD
      || compressedSize !== size
      || nameLength === 0
      || extraLength !== 0
      || commentLength !== 0
      || disk !== 0
    ) {
      invalid("ZIP entries must be stored UTF-8 files without extras, encryption, or descriptors");
    }
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > centralOffset + centralSize) invalid("central directory entry is truncated");
    const name = decodeUtf8(bytes.subarray(nameStart, nameEnd));
    requireSafeEntryName(name);
    if (names.has(name)) invalid("ZIP contains duplicate entry paths");
    names.add(name);
    const maximum = name === BACKUP_ENTRY
      ? MAX_BACKUP_BYTES
      : name === INDEX_ENTRY
        ? MAX_INDEX_BYTES
        : THUMBNAIL_MAX_BYTE_LENGTH;
    if (size > maximum) invalid(`entry is too large: ${name}`);
    directory.push({ name, crc: checksum, size, localOffset });
    cursor = nameEnd;
  }
  if (cursor !== centralOffset + centralSize) invalid("central directory has hidden trailing data");

  /** @type {{entry: (typeof directory)[number], start:number, dataStart:number, end:number}[]} */
  const ranges = [];
  for (const entry of directory) {
    const offset = entry.localOffset;
    if (read32(bytes, offset) !== LOCAL_SIGNATURE) invalid("local ZIP header is missing");
    const flags = read16(bytes, offset + 6);
    const method = read16(bytes, offset + 8);
    const checksum = read32(bytes, offset + 14);
    const compressedSize = read32(bytes, offset + 18);
    const size = read32(bytes, offset + 22);
    const nameLength = read16(bytes, offset + 26);
    const extraLength = read16(bytes, offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;
    const localName = decodeUtf8(bytes.subarray(nameStart, nameEnd));
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + size;
    if (
      flags !== UTF8_FLAG
      || method !== STORE_METHOD
      || checksum !== entry.crc
      || compressedSize !== entry.size
      || size !== entry.size
      || extraLength !== 0
      || localName !== entry.name
      || dataEnd > centralOffset
    ) {
      invalid(`local ZIP entry disagrees with its directory: ${entry.name}`);
    }
    ranges.push({ entry, start: offset, dataStart, end: dataEnd });
  }
  ranges.sort((left, right) => left.start - right.start);
  let expectedOffset = 0;
  for (const range of ranges) {
    if (range.start !== expectedOffset) invalid("ZIP contains overlapping or hidden local data");
    expectedOffset = range.end;
  }
  if (expectedOffset !== centralOffset) invalid("ZIP contains hidden data before its directory");
  // No checksum work or payload copies until every local range is proven to
  // partition the bounded archive. Overlapping entries cannot amplify work.
  /** @type {Map<string, Uint8Array>} */
  const result = new Map();
  for (const range of ranges) {
    const data = bytes.subarray(range.dataStart, range.end);
    if (crc32(data) !== range.entry.crc) invalid(`entry checksum does not match: ${range.entry.name}`);
    result.set(range.entry.name, data);
  }
  return result;
}

/** @param {Uint8Array | ArrayBuffer} input */
function inputBytes(input) {
  if (!(input instanceof Uint8Array) && !(input instanceof ArrayBuffer)) invalid("input must be ZIP bytes");
  if (input.byteLength < 22 || input.byteLength > MAX_IMAGE_BACKUP_BYTES) {
    invalid(`archive size must be between 22 and ${MAX_IMAGE_BACKUP_BYTES} bytes`);
  }
  // Take one bounded snapshot so caller mutations cannot change validation.
  if (input instanceof Uint8Array) return new Uint8Array(input);
  return new Uint8Array(input.slice(0));
}

/** @param {Uint8Array} bytes @param {number} offset */
function readFourCc(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.byteLength) return null;
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0
  );
}

/**
 * The dimension reader is intentionally suitable for early source limiting,
 * so a VP8X canvas header alone is enough for it. Restores need a stronger
 * boundary: require one complete static image chunk and an exact RIFF body so
 * metadata-only WebP containers cannot replace a previously usable image.
 *
 * @param {Uint8Array} bytes
 * @returns {{width:number,height:number} | null}
 */
function readCompleteStaticWebpDimensions(bytes) {
  const canvas = readWebpDimensions(bytes);
  if (canvas === null || bytes.byteLength < 20 || read32(bytes, 4) + 8 !== bytes.byteLength) {
    return null;
  }

  /** @type {{width:number,height:number} | null} */
  let image = null;
  let cursor = 12;
  while (cursor < bytes.byteLength) {
    if (cursor + 8 > bytes.byteLength) return null;
    const chunkType = readFourCc(bytes, cursor);
    const chunkSize = read32(bytes, cursor + 4);
    const payload = cursor + 8;
    const payloadEnd = payload + chunkSize;
    const paddedEnd = payloadEnd + (chunkSize % 2);
    if (payloadEnd < payload || paddedEnd > bytes.byteLength) return null;

    if (chunkType === "VP8 ") {
      if (
        image !== null
        || chunkSize <= 10
        || ((bytes[payload] ?? 0) & 1) !== 0
        || bytes[payload + 3] !== 0x9d
        || bytes[payload + 4] !== 0x01
        || bytes[payload + 5] !== 0x2a
      ) {
        return null;
      }
      image = {
        width: read16(bytes, payload + 6) & 0x3fff,
        height: read16(bytes, payload + 8) & 0x3fff
      };
    } else if (chunkType === "VP8L") {
      if (image !== null || chunkSize <= 5 || bytes[payload] !== 0x2f) return null;
      const packed = read32(bytes, payload + 1);
      if ((packed >>> 29) !== 0) return null;
      image = {
        width: (packed & 0x3fff) + 1,
        height: ((packed >>> 14) & 0x3fff) + 1
      };
    } else if (chunkType === "ANIM" || chunkType === "ANMF") {
      return null;
    }
    cursor = paddedEnd;
  }
  if (
    cursor !== bytes.byteLength
    || image === null
    || image.width <= 0
    || image.height <= 0
    || image.width !== canvas.width
    || image.height !== canvas.height
  ) {
    return null;
  }
  return canvas;
}

/** @param {ThumbnailRecord} thumbnail @param {Uint8Array} bytes */
function requireThumbnailBytes(thumbnail, bytes) {
  if (
    thumbnail.byteLength !== bytes.byteLength
    || bytes.byteLength < 1
    || bytes.byteLength > THUMBNAIL_MAX_BYTE_LENGTH
  ) {
    invalid("thumbnail byte length is invalid");
  }
  let dimensions;
  try {
    dimensions = readCompleteStaticWebpDimensions(bytes);
  } catch {
    invalid("thumbnail is not a structurally valid WebP image");
  }
  if (dimensions === null) {
    invalid("thumbnail is not a structurally valid WebP image");
  }
  if (
    dimensions.width !== thumbnail.width
    || dimensions.height !== thumbnail.height
    || dimensions.width > THUMBNAIL_MAX_DIMENSION
    || dimensions.height > THUMBNAIL_MAX_DIMENSION
  ) {
    invalid("thumbnail dimensions do not match its metadata");
  }
}

/**
 * @param {DatabaseRepository} repository
 * @param {string} userId
 * @param {{ appVersion?: string, exportedAt?: string }} [options]
 * @returns {Promise<Blob>}
 */
export async function createImageBackup(repository, userId, options = {}) {
  const snapshot = await repository.getBackupSnapshot(userId, {
    includeThumbnails: true,
    thumbnailLimit: MAX_IMAGE_BACKUP_THUMBNAILS
  });
  if (snapshot.profile === null) throw new Error(`Profile not found: ${userId}`);
  const thumbnails = snapshot.thumbnails ?? [];
  if (thumbnails.length > MAX_IMAGE_BACKUP_THUMBNAILS) throw new ImageBackupExportError("THUMBNAIL_COUNT_LIMIT");
  const backupBytes = new TextEncoder().encode(serializeBackupSnapshot(snapshot, options));
  const worldIds = new Set(snapshot.worlds.map((world) => world.worldId));
  const seen = new Set();
  /** @type {ThumbnailRecord[]} */
  const included = [];
  const indexRows = [];
  let archiveLength = 22 + storedEntryLength(BACKUP_ENTRY, backupBytes.byteLength);
  for (const thumbnail of thumbnails) {
    if (thumbnail.userId !== userId) throw new ImageBackupExportError("INVALID_THUMBNAIL");
    // JSON restores may retain orphan images. Do not export those images or
    // silently discard an image belonging to an exported world.
    if (!worldIds.has(thumbnail.worldId)) continue;
    try {
      if (
        !WORLD_ID_PATTERN.test(thumbnail.worldId)
        || seen.has(thumbnail.worldId)
        || !isAllowedVrchatImageUrl(thumbnail.sourceUrl)
        || !(thumbnail.blob instanceof Blob)
        || thumbnail.blob.type !== "image/webp"
        || thumbnail.blob.size !== thumbnail.byteLength
      ) invalid("stored thumbnail metadata is inconsistent");
      boundedInteger(thumbnail.width, "thumbnail.width", THUMBNAIL_MAX_DIMENSION);
      boundedInteger(thumbnail.height, "thumbnail.height", THUMBNAIL_MAX_DIMENSION);
      boundedInteger(thumbnail.byteLength, "thumbnail.byteLength", THUMBNAIL_MAX_BYTE_LENGTH);
      canonicalDate(thumbnail.capturedAt, "thumbnail.capturedAt");
    } catch {
      throw new ImageBackupExportError("INVALID_THUMBNAIL");
    }
    seen.add(thumbnail.worldId);
    const path = `thumbnails/${thumbnail.worldId}.webp`;
    archiveLength += storedEntryLength(path, thumbnail.byteLength);
    if (archiveLength > MAX_IMAGE_BACKUP_BYTES) throw new ImageBackupExportError("ARCHIVE_SIZE_LIMIT");
    included.push(thumbnail);
    indexRows.push({
      worldId: thumbnail.worldId,
      path,
      width: thumbnail.width,
      height: thumbnail.height,
      byteLength: thumbnail.byteLength,
      capturedAt: thumbnail.capturedAt,
      sourceUrl: thumbnail.sourceUrl
    });
  }
  const indexBytes = new TextEncoder().encode(`${JSON.stringify({
    format: IMAGE_BACKUP_FORMAT,
    version: IMAGE_BACKUP_VERSION,
    userId,
    thumbnails: indexRows
  }, null, 2)}\n`);
  if (indexBytes.byteLength > MAX_INDEX_BYTES) throw new ImageBackupExportError("INDEX_SIZE_LIMIT");
  archiveLength += storedEntryLength(INDEX_ENTRY, indexBytes.byteLength);
  if (archiveLength > MAX_IMAGE_BACKUP_BYTES) throw new ImageBackupExportError("ARCHIVE_SIZE_LIMIT");
  // All metadata and the exact final size have passed before reading any Blob.
  /** @type {{name:string,bytes:Uint8Array}[]} */
  const imageEntries = [];
  for (const thumbnail of included) {
    try {
      const bytes = new Uint8Array(await thumbnail.blob.arrayBuffer());
      requireThumbnailBytes(thumbnail, bytes);
      imageEntries.push({ name: `thumbnails/${thumbnail.worldId}.webp`, bytes });
    } catch {
      throw new ImageBackupExportError("INVALID_THUMBNAIL");
    }
  }
  const bytes = encodeStoredZip([
    { name: BACKUP_ENTRY, bytes: backupBytes },
    { name: INDEX_ENTRY, bytes: indexBytes },
    ...imageEntries
  ]);
  return new Blob([bytes], { type: "application/zip" });
}

/**
 * @param {Uint8Array | ArrayBuffer} input
 * @returns {{backup: ValidatedBackup, thumbnails: ThumbnailRecord[]}}
 */
export function parseImageBackup(input) {
  const entries = parseStoredZip(inputBytes(input));
  const backupBytes = entries.get(BACKUP_ENTRY);
  const indexBytes = entries.get(INDEX_ENTRY);
  if (backupBytes === undefined || indexBytes === undefined) invalid("required entries are missing");
  const backup = validateBackup(decodeUtf8(backupBytes));
  /** @type {unknown} */
  let rawIndex;
  try {
    rawIndex = JSON.parse(decodeUtf8(indexBytes));
  } catch {
    invalid("thumbnail index is not valid JSON");
  }
  if (!isRecord(rawIndex)) invalid("thumbnail index must be an object");
  requireExactFields(rawIndex, ["format", "version", "userId", "thumbnails"], "index");
  if (
    rawIndex.format !== IMAGE_BACKUP_FORMAT
    || rawIndex.version !== IMAGE_BACKUP_VERSION
    || rawIndex.userId !== backup.profile.userId
    || !USER_ID_PATTERN.test(backup.profile.userId)
    || !Array.isArray(rawIndex.thumbnails)
    || rawIndex.thumbnails.length > MAX_IMAGE_BACKUP_THUMBNAILS
  ) {
    invalid("thumbnail index header is inconsistent");
  }
  const worldIds = new Set(backup.worlds.map((world) => world.worldId));
  const requiredEntries = new Set([BACKUP_ENTRY, INDEX_ENTRY]);
  const seen = new Set();
  /** @type {ThumbnailRecord[]} */
  const thumbnails = [];
  for (let index = 0; index < rawIndex.thumbnails.length; index += 1) {
    const raw = rawIndex.thumbnails[index];
    if (!isRecord(raw)) invalid(`index.thumbnails[${index}] must be an object`);
    requireExactFields(
      raw,
      ["worldId", "path", "width", "height", "byteLength", "capturedAt", "sourceUrl"],
      `index.thumbnails[${index}]`
    );
    if (
      typeof raw.worldId !== "string"
      || !WORLD_ID_PATTERN.test(raw.worldId)
      || !worldIds.has(raw.worldId)
      || seen.has(raw.worldId)
    ) {
      invalid(`index.thumbnails[${index}].worldId is invalid or duplicated`);
    }
    const expectedPath = `thumbnails/${raw.worldId}.webp`;
    if (raw.path !== expectedPath || requiredEntries.has(expectedPath)) {
      invalid(`index.thumbnails[${index}].path is invalid or duplicated`);
    }
    const width = boundedInteger(raw.width, `index.thumbnails[${index}].width`, THUMBNAIL_MAX_DIMENSION);
    const height = boundedInteger(raw.height, `index.thumbnails[${index}].height`, THUMBNAIL_MAX_DIMENSION);
    const byteLength = boundedInteger(
      raw.byteLength,
      `index.thumbnails[${index}].byteLength`,
      THUMBNAIL_MAX_BYTE_LENGTH
    );
    const capturedAt = canonicalDate(raw.capturedAt, `index.thumbnails[${index}].capturedAt`);
    if (typeof raw.sourceUrl !== "string" || !isAllowedVrchatImageUrl(raw.sourceUrl)) {
      invalid(`index.thumbnails[${index}].sourceUrl is invalid`);
    }
    const bytes = entries.get(expectedPath);
    if (bytes === undefined || bytes.byteLength !== byteLength) {
      invalid(`thumbnail entry is missing or has the wrong size: ${expectedPath}`);
    }
    const blobBytes = new Uint8Array(bytes.byteLength);
    blobBytes.set(bytes);
    const thumbnail = {
      userId: backup.profile.userId,
      worldId: raw.worldId,
      blob: new Blob([blobBytes.buffer], { type: "image/webp" }),
      width,
      height,
      byteLength,
      capturedAt,
      sourceUrl: raw.sourceUrl
    };
    requireThumbnailBytes(thumbnail, bytes);
    thumbnails.push(thumbnail);
    seen.add(raw.worldId);
    requiredEntries.add(expectedPath);
  }
  if (entries.size !== requiredEntries.size || [...entries.keys()].some((name) => !requiredEntries.has(name))) {
    invalid("ZIP contains files that are not declared by the thumbnail index");
  }
  return { backup, thumbnails };
}

/** @param {Uint8Array | ArrayBuffer} input */
export function imageBackupSummary(input) {
  const parsed = parseImageBackup(input);
  return { ...backupSummary(parsed.backup), thumbnailCount: parsed.thumbnails.length };
}

/**
 * Bound a browser decode without leaking a bitmap that resolves after timeout
 * or page closure. Decode all images before opening a write transaction.
 *
 * @param {Blob} blob
 * @param {(blob:Blob) => Promise<{width:number,height:number,close?:()=>void}>} decodeImage
 * @param {AbortSignal | undefined} signal
 */
function decodeThumbnail(blob, decodeImage, signal) {
  signal?.throwIfAborted();
  /** @type {Promise<{width:number,height:number,close?:()=>void}>} */
  const result = new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    /** @param {unknown} error */
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => fail(signal?.reason ?? new DOMException("Image restore was canceled", "AbortError"));
    const timer = setTimeout(() => fail(new ImageBackupValidationError("thumbnail image decoding timed out")), 10_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return decodeImage(blob);
    }).then((decoded) => {
      if (settled) {
        decoded.close?.();
        return;
      }
      settled = true;
      cleanup();
      resolve(decoded);
    }, () => fail(new ImageBackupValidationError("thumbnail image data cannot be decoded")));
  });
  return result;
}

/**
 * @param {readonly ThumbnailRecord[]} thumbnails
 * @param {(blob:Blob) => Promise<{width:number,height:number,close?:()=>void}>} decodeImage
 * @param {AbortSignal | undefined} signal
 */
async function requireDecodableThumbnails(thumbnails, decodeImage, signal) {
  for (const thumbnail of thumbnails) {
    signal?.throwIfAborted();
    const decoded = await decodeThumbnail(thumbnail.blob, decodeImage, signal);
    try {
      signal?.throwIfAborted();
      if (
        !Number.isSafeInteger(decoded.width)
        || !Number.isSafeInteger(decoded.height)
        || decoded.width !== thumbnail.width
        || decoded.height !== thumbnail.height
      ) {
        invalid("decoded thumbnail dimensions do not match its metadata");
      }
    } finally {
      decoded.close?.();
    }
  }
}

/**
 * @param {DatabaseRepository} repository
 * @param {Uint8Array | ArrayBuffer} input
 * @param {{
 *   restoredAt?: string,
 *   signal?: AbortSignal,
 *   decodeImage?: (blob:Blob) => Promise<{width:number,height:number,close?:()=>void}>
 * }} [options]
 */
export async function restoreImageBackup(repository, input, options = {}) {
  options.signal?.throwIfAborted();
  const parsed = parseImageBackup(input);
  const decodeImage = options.decodeImage ?? (async (blob) => globalThis.createImageBitmap(blob));
  await requireDecodableThumbnails(parsed.thumbnails, decodeImage, options.signal);
  options.signal?.throwIfAborted();
  const summary = await restoreValidatedBackup(repository, parsed.backup, {
    ...(options.restoredAt === undefined ? {} : { restoredAt: options.restoredAt }),
    thumbnails: parsed.thumbnails
  });
  return { ...summary, thumbnailCount: parsed.thumbnails.length };
}

/** @param {Uint8Array | ArrayBuffer} input */
export function hasZipSignature(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return bytes.byteLength >= 4 && read32(bytes, 0) === LOCAL_SIGNATURE;
}
