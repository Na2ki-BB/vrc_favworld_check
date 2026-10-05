// @ts-check

import { isAllowedVrchatImageUrl, isAllowedVrchatImageResponseUrl } from "./api.js";
import { parseRetryAfter } from "./schedule.js";

export const THUMBNAIL_MAX_SOURCE_BYTES = 5 * 1024 * 1024;
export const THUMBNAIL_MAX_SOURCE_PIXELS = 16_000_000;
export const THUMBNAIL_MAX_SOURCE_DIMENSION = 8_192;
export const THUMBNAIL_MAX_EDGE = 320;
export const THUMBNAIL_TARGET_BYTES = 24 * 1024;
export const THUMBNAIL_MAX_OUTPUT_BYTES = 48 * 1024;

export const THUMBNAIL_ERROR_CODES = /** @type {const} */ ({
  INVALID_URL: "INVALID_URL",
  FETCH_FAILED: "FETCH_FAILED",
  FETCH_TIMEOUT: "FETCH_TIMEOUT",
  FETCH_ABORTED: "FETCH_ABORTED",
  UNEXPECTED_REDIRECT: "UNEXPECTED_REDIRECT",
  HTTP_STATUS: "HTTP_STATUS",
  INVALID_MEDIA_TYPE: "INVALID_MEDIA_TYPE",
  SOURCE_TOO_LARGE: "SOURCE_TOO_LARGE",
  DECODE_FAILED: "DECODE_FAILED",
  PIXEL_LIMIT: "PIXEL_LIMIT",
  RESIZE_FAILED: "RESIZE_FAILED",
  OUTPUT_TOO_LARGE: "OUTPUT_TOO_LARGE"
});

// Only these fixed values may be persisted. Never retain exception messages,
// response bodies, headers, or redirected image URLs.
export const THUMBNAIL_FAILURE_REASONS = /** @type {const} */ ([
  "network", "access_denied", "not_found", "rate_limited", "http_error",
  "unsafe_url", "format", "decode", "resize", "image_limit",
  "storage_full", "storage_error", "unknown", "aborted",
  "timeout_checkpoint", "timeout_fetch", "timeout_decode", "timeout_resize", "timeout_storage"
]);
/** @typedef {(typeof THUMBNAIL_FAILURE_REASONS)[number]} ThumbnailFailureReason */
/** @param {unknown} value @returns {value is ThumbnailFailureReason} */
export function isThumbnailFailureReason(value) {
  return THUMBNAIL_FAILURE_REASONS.some((reason) => reason === value);
}

/** @param {unknown} error @param {boolean} [saving] @returns {ThumbnailFailureReason} */
export function thumbnailFailureReason(error, saving = false) {
  if (saving) return error instanceof DOMException && error.name === "QuotaExceededError"
    ? "storage_full" : "storage_error";
  if (!(error instanceof ThumbnailError)) return "unknown";
  switch (error.code) {
    case "FETCH_FAILED": return "network";
    case "FETCH_TIMEOUT": return "timeout_fetch";
    case "FETCH_ABORTED": return "aborted";
    case "HTTP_STATUS":
      if (error.status === 401 || error.status === 403) return "access_denied";
      if (error.status === 404 || error.status === 410) return "not_found";
      if (error.status === 429) return "rate_limited";
      return "http_error";
    case "INVALID_URL":
    case "UNEXPECTED_REDIRECT": return "unsafe_url";
    case "INVALID_MEDIA_TYPE": return "format";
    case "DECODE_FAILED": return "decode";
    case "RESIZE_FAILED": return "resize";
    case "SOURCE_TOO_LARGE":
    case "PIXEL_LIMIT":
    case "OUTPUT_TOO_LARGE": return "image_limit";
    default: return "unknown";
  }
}

const ALLOWED_SOURCE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp"
]);
const ENCODE_QUALITIES = [0.82, 0.68, 0.54, 0.4, 0.3];
const OUTPUT_SCALE_FACTORS = [1, 0.85, 0.7, 0.55, 0.4, 0.3];
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * @typedef {(typeof THUMBNAIL_ERROR_CODES)[keyof typeof THUMBNAIL_ERROR_CODES]} ThumbnailErrorCode
 * @typedef {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>} ThumbnailFetchLike
 * @typedef {{width: number, height: number, close?: () => void}} ThumbnailBitmap
 * @typedef {{
 *   drawImage: (
 *     source: ThumbnailBitmap,
 *     destinationX: number,
 *     destinationY: number,
 *     destinationWidth: number,
 *     destinationHeight: number
 *   ) => void
 * }} ThumbnailCanvasContext
 * @typedef {{
 *   getContext: (contextId: "2d") => ThumbnailCanvasContext | null,
 *   convertToBlob: (options: {type: "image/webp", quality: number}) => Promise<Blob>
 * }} ThumbnailCanvas
 * @typedef {(source: Blob) => Promise<ThumbnailBitmap>} CreateBitmapLike
 * @typedef {(width: number, height: number) => ThumbnailCanvas} CreateCanvasLike
 * @typedef {{
 *   fetch?: ThumbnailFetchLike,
 *   createBitmap?: CreateBitmapLike,
 *   createCanvas?: CreateCanvasLike,
 *   timeoutMs?: number,
 *   clock?: () => number,
 *   signal?: AbortSignal,
 *   onStage?: (stage: "fetch" | "decode" | "resize") => void
 * }} ThumbnailDependencies
 * @typedef {{
 *   bytes: Uint8Array,
 *   contentType: "image/webp",
 *   width: number,
 *   height: number,
 *   sourceUrl: string
 * }} EncodedThumbnail
 * @typedef {{bytes: Uint8Array, mediaType: string}} FetchedImage
 */

export class ThumbnailError extends Error {
  /**
   * @param {ThumbnailErrorCode} code
   * @param {number | null} [status]
   */
  constructor(code, status = null) {
    super(code);
    this.name = "ThumbnailError";
    this.code = code;
    this.status = status;
  }
}

export class ThumbnailFetchError extends ThumbnailError {
  /**
   * @param {"FETCH_FAILED" | "FETCH_TIMEOUT" | "FETCH_ABORTED" | "UNEXPECTED_REDIRECT" | "HTTP_STATUS"} code
   * @param {number | null} [status]
   * @param {number | null} [retryAt]
   */
  constructor(code, status = null, retryAt = null) {
    super(code, status);
    this.name = "ThumbnailFetchError";
    this.retryAt = retryAt;
  }
}

export class ThumbnailLimitError extends ThumbnailError {
  /** @param {"SOURCE_TOO_LARGE" | "PIXEL_LIMIT" | "OUTPUT_TOO_LARGE"} code */
  constructor(code) {
    super(code);
    this.name = "ThumbnailLimitError";
  }
}

export class ThumbnailResizeError extends ThumbnailError {
  /** @param {"DECODE_FAILED" | "RESIZE_FAILED"} code */
  constructor(code) {
    super(code);
    this.name = "ThumbnailResizeError";
  }
}

/**
 * Download a validated VRChat image and return only a bounded WebP derivative.
 * Callers should catch ThumbnailError so an optional thumbnail failure never
 * changes the result of the main world synchronization.
 *
 * @param {string} sourceUrl
 * @param {ThumbnailDependencies} [dependencies]
 * @returns {Promise<EncodedThumbnail>}
 */
export async function fetchAndEncodeThumbnail(sourceUrl, dependencies = {}) {
  if (!isAllowedVrchatImageUrl(sourceUrl)) {
    throw new ThumbnailError(THUMBNAIL_ERROR_CODES.INVALID_URL);
  }

  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number");
  }
  throwIfThumbnailAborted(dependencies.signal);

  dependencies.onStage?.("fetch");
  const fetched = await fetchBoundedImage(
    sourceUrl,
    dependencies.fetch ?? defaultFetch,
    timeoutMs,
    dependencies.clock ?? Date.now,
    dependencies.signal
  );
  throwIfThumbnailAborted(dependencies.signal);
  dependencies.onStage?.("decode");
  const encodedDimensions = readEncodedDimensions(
    fetched.bytes,
    fetched.mediaType
  );
  validateSourceDimensions(encodedDimensions);
  const createBitmap = dependencies.createBitmap ?? defaultCreateBitmap;
  const createCanvas = dependencies.createCanvas ?? defaultCreateCanvas;
  const sourceBuffer = new ArrayBuffer(fetched.bytes.byteLength);
  new Uint8Array(sourceBuffer).set(fetched.bytes);
  const sourceBlob = new Blob([sourceBuffer], { type: fetched.mediaType });

  /** @type {ThumbnailBitmap} */
  let bitmap;
  try {
    bitmap = await createBitmap(sourceBlob);
  } catch {
    throwIfThumbnailAborted(dependencies.signal);
    throw new ThumbnailResizeError(THUMBNAIL_ERROR_CODES.DECODE_FAILED);
  }

  try {
    throwIfThumbnailAborted(dependencies.signal);
    validateDecodedDimensions(bitmap);
    dependencies.onStage?.("resize");
    const encoded = await encodeBoundedWebp(
      bitmap,
      createCanvas,
      dependencies.signal
    );
    return {
      ...encoded,
      contentType: "image/webp",
      sourceUrl
    };
  } finally {
    bitmap.close?.();
  }
}

/**
 * @param {string} sourceUrl
 * @param {ThumbnailFetchLike} fetch
 * @param {number} timeoutMs
 * @param {() => number} clock
 * @param {AbortSignal | undefined} externalSignal
 * @returns {Promise<FetchedImage>}
 */
async function fetchBoundedImage(sourceUrl, fetch, timeoutMs, clock, externalSignal) {
  const controller = new AbortController();
  const abortFromExternalSignal = () => controller.abort();
  if (externalSignal?.aborted === true) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
  }
  let timedOut = false;
  const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  /** @type {Response} */
  let response;
  try {
    response = await fetch(sourceUrl, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      headers: { Accept: "image/webp,image/png,image/jpeg" },
      signal: controller.signal
    });
  } catch {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortFromExternalSignal);
    controller.abort();
    throwIfThumbnailAborted(externalSignal);
    throw new ThumbnailFetchError(timedOut ? THUMBNAIL_ERROR_CODES.FETCH_TIMEOUT : THUMBNAIL_ERROR_CODES.FETCH_FAILED);
  }

  try {
    if (
      response.type === "opaqueredirect"
      || response.status === 0
      || (response.status >= 300 && response.status < 400)
    ) {
      throw new ThumbnailFetchError(
        THUMBNAIL_ERROR_CODES.UNEXPECTED_REDIRECT,
        response.status === 0 ? null : response.status
      );
    }
    if (response.status !== 200) {
      const observedAt = clock();
      const retryAt = response.status === 429 && isTimestamp(observedAt)
        ? parseRetryAfter(response.headers.get("Retry-After"), observedAt)
        : null;
      throw new ThumbnailFetchError(
        THUMBNAIL_ERROR_CODES.HTTP_STATUS,
        response.status,
        retryAt
      );
    }
    if (!isAllowedVrchatImageResponseUrl(sourceUrl, response.url, response.redirected)) {
      throw new ThumbnailFetchError(
        THUMBNAIL_ERROR_CODES.UNEXPECTED_REDIRECT,
        response.status
      );
    }

    const mediaType = response.headers.get("Content-Type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType === undefined || !ALLOWED_SOURCE_MEDIA_TYPES.has(mediaType)) {
      throw new ThumbnailError(THUMBNAIL_ERROR_CODES.INVALID_MEDIA_TYPE);
    }

    validateDeclaredLength(response.headers.get("Content-Length"));
    return {
      bytes: await readBoundedBytes(response),
      mediaType
    };
  } catch (error) {
    throwIfThumbnailAborted(externalSignal);
    if (timedOut) throw new ThumbnailFetchError(THUMBNAIL_ERROR_CODES.FETCH_TIMEOUT);
    throw error;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortFromExternalSignal);
    controller.abort();
  }
}

/** @param {AbortSignal | undefined} signal */
function throwIfThumbnailAborted(signal) {
  if (signal?.aborted === true) {
    throw new ThumbnailFetchError(THUMBNAIL_ERROR_CODES.FETCH_ABORTED);
  }
}

/** @param {unknown} value */
function isTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** @param {string | null} contentLength */
function validateDeclaredLength(contentLength) {
  if (contentLength === null) {
    return;
  }
  if (!/^\d+$/u.test(contentLength)) {
    throw new ThumbnailError(THUMBNAIL_ERROR_CODES.INVALID_MEDIA_TYPE);
  }
  const declaredBytes = Number(contentLength);
  if (
    !Number.isSafeInteger(declaredBytes)
    || declaredBytes <= 0
    || declaredBytes > THUMBNAIL_MAX_SOURCE_BYTES
  ) {
    throw new ThumbnailLimitError(THUMBNAIL_ERROR_CODES.SOURCE_TOO_LARGE);
  }
}

/**
 * @param {Response} response
 * @returns {Promise<Uint8Array>}
 */
async function readBoundedBytes(response) {
  if (response.body === null) {
    throw new ThumbnailError(THUMBNAIL_ERROR_CODES.INVALID_MEDIA_TYPE);
  }

  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    /** @type {ReadableStreamReadResult<Uint8Array>} */
    let result;
    try {
      result = await reader.read();
    } catch {
      throw new ThumbnailFetchError(THUMBNAIL_ERROR_CODES.FETCH_FAILED);
    }
    if (result.done) {
      break;
    }
    totalBytes += result.value.byteLength;
    if (totalBytes > THUMBNAIL_MAX_SOURCE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        throw new ThumbnailLimitError(THUMBNAIL_ERROR_CODES.SOURCE_TOO_LARGE);
      }
      throw new ThumbnailLimitError(THUMBNAIL_ERROR_CODES.SOURCE_TOO_LARGE);
    }
    chunks.push(result.value);
  }
  if (totalBytes === 0) {
    throw new ThumbnailError(THUMBNAIL_ERROR_CODES.INVALID_MEDIA_TYPE);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Read dimensions without invoking an image decoder. This ensures a small
 * compressed file cannot ask createImageBitmap to allocate an unbounded pixel
 * buffer before the source limits have been checked.
 *
 * @param {Uint8Array} bytes
 * @param {string} mediaType
 * @returns {{width: number, height: number}}
 */
function readEncodedDimensions(bytes, mediaType) {
  let dimensions = null;
  if (mediaType === "image/png") {
    dimensions = readPngDimensions(bytes);
  } else if (mediaType === "image/jpeg") {
    dimensions = readJpegDimensions(bytes);
  } else if (mediaType === "image/webp") {
    dimensions = readWebpDimensions(bytes);
  }

  if (
    dimensions === null
    || !Number.isSafeInteger(dimensions.width)
    || !Number.isSafeInteger(dimensions.height)
    || dimensions.width <= 0
    || dimensions.height <= 0
  ) {
    throw new ThumbnailResizeError(THUMBNAIL_ERROR_CODES.DECODE_FAILED);
  }
  return dimensions;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{width: number, height: number} | null}
 */
function readPngDimensions(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.byteLength < 24
    || !signature.every((value, index) => bytes[index] === value)
    || readUint32BigEndian(bytes, 8) !== 13
    || readAscii(bytes, 12, 4) !== "IHDR"
  ) {
    return null;
  }
  return {
    width: readUint32BigEndian(bytes, 16),
    height: readUint32BigEndian(bytes, 20)
  };
}

/**
 * @param {Uint8Array} bytes
 * @returns {{width: number, height: number} | null}
 */
function readJpegDimensions(bytes) {
  if (
    bytes.byteLength < 4
    || bytes[0] !== 0xff
    || bytes[1] !== 0xd8
  ) {
    return null;
  }

  let cursor = 2;
  while (cursor < bytes.byteLength) {
    if (bytes[cursor] !== 0xff) {
      return null;
    }
    while (cursor < bytes.byteLength && bytes[cursor] === 0xff) {
      cursor += 1;
    }
    if (cursor >= bytes.byteLength) {
      return null;
    }

    const marker = readByte(bytes, cursor);
    cursor += 1;
    if (marker === 0x00 || marker === 0xd8) {
      return null;
    }
    if (marker === 0xd9 || marker === 0xda) {
      return null;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (cursor + 2 > bytes.byteLength) {
      return null;
    }

    const segmentLength = readUint16BigEndian(bytes, cursor);
    if (segmentLength < 2 || cursor + segmentLength > bytes.byteLength) {
      return null;
    }
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 8) {
        return null;
      }
      return {
        height: readUint16BigEndian(bytes, cursor + 3),
        width: readUint16BigEndian(bytes, cursor + 5)
      };
    }
    cursor += segmentLength;
  }
  return null;
}

/** @param {number} marker */
function isJpegStartOfFrame(marker) {
  return (
    marker >= 0xc0
    && marker <= 0xcf
    && marker !== 0xc4
    && marker !== 0xc8
    && marker !== 0xcc
  );
}

/**
 * @param {Uint8Array} bytes
 * @returns {{width: number, height: number} | null}
 */
function readWebpDimensions(bytes) {
  if (
    bytes.byteLength < 20
    || readAscii(bytes, 0, 4) !== "RIFF"
    || readAscii(bytes, 8, 4) !== "WEBP"
  ) {
    return null;
  }

  const declaredFileSize = readUint32LittleEndian(bytes, 4) + 8;
  const chunkSize = readUint32LittleEndian(bytes, 16);
  const paddedChunkSize = chunkSize + (chunkSize % 2);
  if (
    declaredFileSize > bytes.byteLength
    || declaredFileSize < 20
    || chunkSize > bytes.byteLength - 20
    || paddedChunkSize > declaredFileSize - 20
  ) {
    return null;
  }

  const chunkType = readAscii(bytes, 12, 4);
  if (chunkType === "VP8X") {
    if (chunkSize !== 10) {
      return null;
    }
    return {
      width: readUint24LittleEndian(bytes, 24) + 1,
      height: readUint24LittleEndian(bytes, 27) + 1
    };
  }
  if (chunkType === "VP8 ") {
    if (
      chunkSize < 10
      || (readByte(bytes, 20) & 1) !== 0
      || bytes[23] !== 0x9d
      || bytes[24] !== 0x01
      || bytes[25] !== 0x2a
    ) {
      return null;
    }
    return {
      width: readUint16LittleEndian(bytes, 26) & 0x3fff,
      height: readUint16LittleEndian(bytes, 28) & 0x3fff
    };
  }
  if (chunkType === "VP8L") {
    if (chunkSize < 5 || bytes[20] !== 0x2f) {
      return null;
    }
    const packedDimensions = readUint32LittleEndian(bytes, 21);
    if ((packedDimensions >>> 29) !== 0) {
      return null;
    }
    return {
      width: (packedDimensions & 0x3fff) + 1,
      height: ((packedDimensions >>> 14) & 0x3fff) + 1
    };
  }
  return null;
}

/** @param {{width: number, height: number}} dimensions */
function validateSourceDimensions(dimensions) {
  if (
    dimensions.width > THUMBNAIL_MAX_SOURCE_DIMENSION
    || dimensions.height > THUMBNAIL_MAX_SOURCE_DIMENSION
    || dimensions.width * dimensions.height > THUMBNAIL_MAX_SOURCE_PIXELS
  ) {
    throw new ThumbnailLimitError(THUMBNAIL_ERROR_CODES.PIXEL_LIMIT);
  }
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 */
function readUint16BigEndian(bytes, offset) {
  return (readByte(bytes, offset) * 0x100) + readByte(bytes, offset + 1);
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 */
function readUint16LittleEndian(bytes, offset) {
  return readByte(bytes, offset) + (readByte(bytes, offset + 1) * 0x100);
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 */
function readUint24LittleEndian(bytes, offset) {
  return (
    readByte(bytes, offset)
    + (readByte(bytes, offset + 1) * 0x100)
    + (readByte(bytes, offset + 2) * 0x10_000)
  );
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 */
function readByte(bytes, offset) {
  return bytes[offset] ?? -1;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 */
function readUint32BigEndian(bytes, offset) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    4
  ).getUint32(0);
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 */
function readUint32LittleEndian(bytes, offset) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    4
  ).getUint32(0, true);
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {number} length
 */
function readAscii(bytes, offset, length) {
  let result = "";
  for (let index = offset; index < offset + length; index += 1) {
    result += String.fromCharCode(readByte(bytes, index));
  }
  return result;
}

/** @param {ThumbnailBitmap} bitmap */
function validateDecodedDimensions(bitmap) {
  const { width, height } = bitmap;
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
    || width > THUMBNAIL_MAX_SOURCE_DIMENSION
    || height > THUMBNAIL_MAX_SOURCE_DIMENSION
    || width * height > THUMBNAIL_MAX_SOURCE_PIXELS
  ) {
    throw new ThumbnailLimitError(THUMBNAIL_ERROR_CODES.PIXEL_LIMIT);
  }
}

/**
 * @param {ThumbnailBitmap} bitmap
 * @param {CreateCanvasLike} createCanvas
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{bytes: Uint8Array, width: number, height: number}>}
 */
async function encodeBoundedWebp(bitmap, createCanvas, signal) {
  const initialScale = Math.min(
    1,
    THUMBNAIL_MAX_EDGE / Math.max(bitmap.width, bitmap.height)
  );
  const initialWidth = Math.max(1, Math.round(bitmap.width * initialScale));
  const initialHeight = Math.max(1, Math.round(bitmap.height * initialScale));
  /** @type {{bytes: Uint8Array, width: number, height: number} | null} */
  let boundedCandidate = null;

  for (const scaleFactor of OUTPUT_SCALE_FACTORS) {
    throwIfThumbnailAborted(signal);
    const width = Math.max(1, Math.round(initialWidth * scaleFactor));
    const height = Math.max(1, Math.round(initialHeight * scaleFactor));
    /** @type {ThumbnailCanvas} */
    let canvas;
    try {
      canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      if (context === null) {
        throw new Error("2d context unavailable");
      }
      context.drawImage(bitmap, 0, 0, width, height);
    } catch {
      throw new ThumbnailResizeError(THUMBNAIL_ERROR_CODES.RESIZE_FAILED);
    }

    for (const quality of ENCODE_QUALITIES) {
      throwIfThumbnailAborted(signal);
      /** @type {Blob} */
      let encodedBlob;
      try {
        encodedBlob = await canvas.convertToBlob({
          type: "image/webp",
          quality
        });
      } catch {
        throw new ThumbnailResizeError(THUMBNAIL_ERROR_CODES.RESIZE_FAILED);
      }
      throwIfThumbnailAborted(signal);
      if (encodedBlob.type.toLowerCase() !== "image/webp") {
        throw new ThumbnailResizeError(THUMBNAIL_ERROR_CODES.RESIZE_FAILED);
      }
      if (encodedBlob.size > THUMBNAIL_MAX_OUTPUT_BYTES) {
        continue;
      }

      /** @type {Uint8Array} */
      let bytes;
      try {
        bytes = new Uint8Array(await encodedBlob.arrayBuffer());
      } catch {
        throw new ThumbnailResizeError(THUMBNAIL_ERROR_CODES.RESIZE_FAILED);
      }
      if (bytes.byteLength === 0) {
        throw new ThumbnailResizeError(THUMBNAIL_ERROR_CODES.RESIZE_FAILED);
      }
      if (bytes.byteLength > THUMBNAIL_MAX_OUTPUT_BYTES) {
        continue;
      }
      const candidate = { bytes, width, height };
      if (bytes.byteLength <= THUMBNAIL_TARGET_BYTES) {
        return candidate;
      }
      if (
        boundedCandidate === null
        || bytes.byteLength < boundedCandidate.bytes.byteLength
      ) {
        boundedCandidate = candidate;
      }
    }
  }

  if (boundedCandidate !== null) {
    return boundedCandidate;
  }
  throw new ThumbnailLimitError(THUMBNAIL_ERROR_CODES.OUTPUT_TOO_LARGE);
}

/** @type {ThumbnailFetchLike} */
const defaultFetch = (input, init) => globalThis.fetch(input, init);

/** @type {CreateBitmapLike} */
const defaultCreateBitmap = async (source) => globalThis.createImageBitmap(source);

/** @type {CreateCanvasLike} */
const defaultCreateCanvas = (width, height) => {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  return {
    getContext: () => context === null ? null : {
      drawImage: (source, x, y, destinationWidth, destinationHeight) => {
        context.drawImage(
          /** @type {CanvasImageSource} */ (/** @type {unknown} */ (source)),
          x,
          y,
          destinationWidth,
          destinationHeight
        );
      }
    },
    convertToBlob: (options) => canvas.convertToBlob(options)
  };
};
