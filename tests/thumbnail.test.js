// @ts-check

import test from "node:test";
import assert from "node:assert/strict";

import {
  THUMBNAIL_ERROR_CODES,
  THUMBNAIL_MAX_EDGE,
  THUMBNAIL_MAX_OUTPUT_BYTES,
  THUMBNAIL_MAX_SOURCE_BYTES,
  THUMBNAIL_MAX_SOURCE_DIMENSION,
  THUMBNAIL_MAX_SOURCE_PIXELS,
  THUMBNAIL_TARGET_BYTES,
  ThumbnailError,
  ThumbnailFetchError,
  ThumbnailLimitError,
  ThumbnailResizeError,
  fetchAndEncodeThumbnail
} from "../extension/lib/thumbnail.js";

const FILE_ID = "file_00000000-0000-0000-0000-000000000001";
const SOURCE_URL = `https://api.vrchat.cloud/api/1/image/${FILE_ID}/1/256`;

/**
 * These deliberately contain only the bytes needed to describe image
 * dimensions. createImageBitmap is replaced in these unit tests, so encoded
 * pixel data is unnecessary.
 *
 * @param {number} width
 * @param {number} height
 */
function pngHeader(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/**
 * @param {number} width
 * @param {number} height
 */
function jpegHeader(width, height) {
  return new Uint8Array([
    0xff, 0xd8,
    // An APP0 segment verifies that the parser safely skips variable segments.
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    // Baseline SOF: length, precision, height, width, component count.
    0xff, 0xc0, 0x00, 0x08, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x00
  ]);
}

/**
 * @param {"VP8X" | "VP8 " | "VP8L" | "ANIM"} chunkType
 * @param {Uint8Array} payload
 */
function webpChunk(chunkType, payload) {
  const paddedPayloadLength = payload.byteLength + (payload.byteLength % 2);
  const bytes = new Uint8Array(20 + paddedPayloadLength);
  bytes.set([82, 73, 70, 70], 0);
  new DataView(bytes.buffer).setUint32(4, bytes.byteLength - 8, true);
  bytes.set([87, 69, 66, 80], 8);
  bytes.set([...chunkType].map((character) => character.charCodeAt(0)), 12);
  new DataView(bytes.buffer).setUint32(16, payload.byteLength, true);
  bytes.set(payload, 20);
  return bytes;
}

/**
 * @param {number} width
 * @param {number} height
 */
function webpVp8xHeader(width, height) {
  const payload = new Uint8Array(10);
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  payload[4] = widthMinusOne & 0xff;
  payload[5] = (widthMinusOne >>> 8) & 0xff;
  payload[6] = (widthMinusOne >>> 16) & 0xff;
  payload[7] = heightMinusOne & 0xff;
  payload[8] = (heightMinusOne >>> 8) & 0xff;
  payload[9] = (heightMinusOne >>> 16) & 0xff;
  return webpChunk("VP8X", payload);
}

/**
 * @param {number} width
 * @param {number} height
 */
function webpVp8Header(width, height) {
  const payload = new Uint8Array(10);
  payload.set([0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a]);
  payload[6] = width & 0xff;
  payload[7] = (width >>> 8) & 0x3f;
  payload[8] = height & 0xff;
  payload[9] = (height >>> 8) & 0x3f;
  return webpChunk("VP8 ", payload);
}

/**
 * @param {number} width
 * @param {number} height
 */
function webpVp8lHeader(width, height) {
  const dimensions = (
    ((width - 1) & 0x3fff)
    | (((height - 1) & 0x3fff) << 14)
  ) >>> 0;
  const payload = new Uint8Array(5);
  payload[0] = 0x2f;
  new DataView(payload.buffer).setUint32(1, dimensions, true);
  return webpChunk("VP8L", payload);
}

/**
 * @param {string} mediaType
 * @param {number} width
 * @param {number} height
 */
function imageHeader(mediaType, width, height) {
  if (mediaType === "image/jpeg") {
    return jpegHeader(width, height);
  }
  if (mediaType === "image/webp") {
    return webpVp8xHeader(width, height);
  }
  return pngHeader(width, height);
}

/**
 * @param {BodyInit | null} body
 * @param {{
 *   status?: number,
 *   url?: string,
 *   redirected?: boolean,
 *   contentType?: string | null,
 *   contentLength?: string,
 *   retryAfter?: string
 * }} [options]
 */
function imageResponse(body, options = {}) {
  const headers = new Headers();
  if (options.contentType !== null) {
    headers.set("Content-Type", options.contentType ?? "image/png");
  }
  if (options.contentLength !== undefined) {
    headers.set("Content-Length", options.contentLength);
  }
  if (options.retryAfter !== undefined) {
    headers.set("Retry-After", options.retryAfter);
  }
  const response = new Response(body, {
    status: options.status ?? 200,
    headers
  });
  Object.defineProperty(response, "url", {
    configurable: true,
    value: options.url ?? SOURCE_URL
  });
  if (options.redirected !== undefined) {
    Object.defineProperty(response, "redirected", {
      configurable: true,
      value: options.redirected
    });
  }
  return response;
}

/**
 * @param {{
 *   width?: number,
 *   height?: number,
 *   headerWidth?: number,
 *   headerHeight?: number,
 *   sourceMediaType?: "image/jpeg" | "image/png" | "image/webp",
 *   sourceBytes?: Uint8Array,
 *   encodedSize?: (width: number, height: number, quality: number) => number,
 *   contextAvailable?: boolean,
 *   encodeError?: boolean,
 *   outputType?: string
 * }} [options]
 * @returns {{
 *   dependencies: {
 *     fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
 *     createBitmap: (source: Blob) => Promise<{
 *       width: number,
 *       height: number,
 *       close: () => void
 *     }>,
 *     createCanvas: (width: number, height: number) => {
 *       getContext: (contextId: "2d") => {
 *         drawImage: (
 *           source: {width: number, height: number, close?: () => void},
 *           destinationX: number,
 *           destinationY: number,
 *           destinationWidth: number,
 *           destinationHeight: number
 *         ) => void
 *       } | null,
 *       convertToBlob: (options: {
 *         type: "image/webp",
 *         quality: number
 *       }) => Promise<Blob>
 *     }
 *   },
 *   decodedBlobs: Blob[],
 *   draws: {width: number, height: number}[],
 *   encodes: {width: number, height: number, quality: number}[],
 *   isClosed: () => boolean
 * }}
 */
function createImageDependencies(options = {}) {
  const sourceWidth = options.width ?? 640;
  const sourceHeight = options.height ?? 360;
  const sourceMediaType = options.sourceMediaType ?? "image/png";
  const sourceBytes = options.sourceBytes ?? imageHeader(
    sourceMediaType,
    options.headerWidth ?? sourceWidth,
    options.headerHeight ?? sourceHeight
  );
  let closed = false;
  /** @type {{width: number, height: number, quality: number}[]} */
  const encodes = [];
  /** @type {{width: number, height: number}[]} */
  const draws = [];
  /** @type {Blob[]} */
  const decodedBlobs = [];

  return {
    dependencies: {
      fetch: async () => imageResponse(new Uint8Array(sourceBytes), {
        contentType: sourceMediaType
      }),
      createBitmap: async (blob) => {
        decodedBlobs.push(blob);
        return {
          width: sourceWidth,
          height: sourceHeight,
          close: () => {
            closed = true;
          }
        };
      },
      createCanvas: (width, height) => ({
        getContext: () => options.contextAvailable === false ? null : ({
          drawImage: (_source, _x, _y, destinationWidth, destinationHeight) => {
            draws.push({
              width: destinationWidth,
              height: destinationHeight
            });
          }
        }),
        convertToBlob: async ({ quality }) => {
          if (options.encodeError === true) {
            throw new Error("encode failed");
          }
          encodes.push({ width, height, quality });
          const size = options.encodedSize?.(width, height, quality)
            ?? THUMBNAIL_TARGET_BYTES - 1;
          return new Blob([new Uint8Array(size)], {
            type: options.outputType ?? "image/webp"
          });
        }
      })
    },
    decodedBlobs,
    draws,
    encodes,
    isClosed: () => closed
  };
}

test("fetches with isolated options and returns only a bounded WebP derivative", async () => {
  const image = createImageDependencies();
  const sourceBytes = pngHeader(640, 360);
  /** @type {{url: string, init: RequestInit | undefined}[]} */
  const calls = [];
  image.dependencies.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return imageResponse(sourceBytes, {
      contentType: "image/png; charset=binary",
      contentLength: String(sourceBytes.byteLength)
    });
  };

  const result = await fetchAndEncodeThumbnail(SOURCE_URL, image.dependencies);

  assert.equal(result.contentType, "image/webp");
  assert.equal(result.sourceUrl, SOURCE_URL);
  assert.equal(result.width, THUMBNAIL_MAX_EDGE);
  assert.equal(result.height, 180);
  assert.equal(result.bytes.byteLength, THUMBNAIL_TARGET_BYTES - 1);
  assert.deepEqual(result.bytes.slice(0, 4), new Uint8Array([0, 0, 0, 0]));
  assert.notDeepEqual(result.bytes.slice(0, 4), sourceBytes.slice(0, 4));
  assert.equal(image.decodedBlobs[0]?.type, "image/png");
  assert.equal(image.decodedBlobs[0]?.size, sourceBytes.byteLength);
  assert.deepEqual(image.draws, [{ width: 320, height: 180 }]);
  assert.equal(image.isClosed(), true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, SOURCE_URL);
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(calls[0]?.init?.credentials, "omit");
  assert.equal(calls[0]?.init?.cache, "no-store");
  assert.equal(calls[0]?.init?.redirect, "follow");
  assert.equal(calls[0]?.init?.referrerPolicy, "no-referrer");
  assert.ok(calls[0]?.init?.signal instanceof AbortSignal);
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get("Accept"), "image/webp,image/png,image/jpeg");
});

test("rejects unsafe source URLs before making a request", async () => {
  let fetchCalled = false;
  await assert.rejects(
    fetchAndEncodeThumbnail("https://example.com/thumbnail.webp", {
      fetch: async () => {
        fetchCalled = true;
        return imageResponse(new Uint8Array([1]));
      }
    }),
    (error) => {
      assert.ok(error instanceof ThumbnailError);
      assert.equal(error.code, THUMBNAIL_ERROR_CODES.INVALID_URL);
      return true;
    }
  );
  assert.equal(fetchCalled, false);
});

test("rejects unresolved redirects, unsafe final URLs, network errors, and non-200 status", async () => {
  const cases = [
    {
      response: imageResponse(null, { status: 302 }),
      code: THUMBNAIL_ERROR_CODES.UNEXPECTED_REDIRECT,
      status: 302
    },
    {
      response: imageResponse(new Uint8Array([1]), {
        redirected: true,
        url: SOURCE_URL.replace("/1/256", "/2/256")
      }),
      code: THUMBNAIL_ERROR_CODES.UNEXPECTED_REDIRECT,
      status: 200
    },
    {
      response: imageResponse(new Uint8Array([1]), {
        url: "https://cdn.example.com/thumbnail.webp"
      }),
      code: THUMBNAIL_ERROR_CODES.UNEXPECTED_REDIRECT,
      status: 200
    },
    {
      response: imageResponse(null, { status: 404 }),
      code: THUMBNAIL_ERROR_CODES.HTTP_STATUS,
      status: 404
    }
  ];

  for (const item of cases) {
    await assert.rejects(
      fetchAndEncodeThumbnail(SOURCE_URL, {
        fetch: async () => item.response
      }),
      (error) => {
        assert.ok(error instanceof ThumbnailFetchError);
        assert.equal(error.code, item.code);
        assert.equal(error.status, item.status);
        return true;
      }
    );
  }

  await assert.rejects(
    fetchAndEncodeThumbnail(SOURCE_URL, {
      fetch: async () => {
        throw new TypeError("offline");
      }
    }),
    (error) => {
      assert.ok(error instanceof ThumbnailFetchError);
      assert.equal(error.code, THUMBNAIL_ERROR_CODES.FETCH_FAILED);
      return true;
    }
  );
});

test("retains a 429 Retry-After deadline for thumbnail backoff", async () => {
  const observedAt = Date.UTC(2026, 7, 24, 3, 0, 0);
  await assert.rejects(
    fetchAndEncodeThumbnail(SOURCE_URL, {
      fetch: async () => imageResponse(null, {
        status: 429,
        retryAfter: "120"
      }),
      clock: () => observedAt
    }),
    (error) => {
      assert.ok(error instanceof ThumbnailFetchError);
      assert.equal(error.code, THUMBNAIL_ERROR_CODES.HTTP_STATUS);
      assert.equal(error.status, 429);
      assert.equal(error.retryAt, observedAt + 120_000);
      return true;
    }
  );
});

test("an external deadline signal stops thumbnail work before decoding", async () => {
  const controller = new AbortController();
  let createBitmapCalled = false;
  await assert.rejects(
    fetchAndEncodeThumbnail(SOURCE_URL, {
      fetch: async () => {
        controller.abort();
        return imageResponse(pngHeader(640, 360));
      },
      createBitmap: async () => {
        createBitmapCalled = true;
        return { width: 640, height: 360 };
      },
      signal: controller.signal
    }),
    (error) => {
      assert.ok(error instanceof ThumbnailFetchError);
      assert.equal(error.code, THUMBNAIL_ERROR_CODES.FETCH_FAILED);
      return true;
    }
  );
  assert.equal(createBitmapCalled, false);
});

test("accepts only JPEG, PNG, and WebP response media types", async () => {
  for (const mediaType of ["image/jpeg", "image/png", "image/webp"]) {
    const image = createImageDependencies();
    image.dependencies.fetch = async () => imageResponse(
      imageHeader(mediaType, 640, 360),
      { contentType: mediaType }
    );
    const result = await fetchAndEncodeThumbnail(SOURCE_URL, image.dependencies);
    assert.equal(result.contentType, "image/webp");
  }

  for (const mediaType of ["image/gif", "image/svg+xml", "text/html"]) {
    await assert.rejects(
      fetchAndEncodeThumbnail(SOURCE_URL, {
        fetch: async () => imageResponse(
          new Uint8Array([1]),
          { contentType: mediaType }
        )
      }),
      (error) => {
        assert.ok(error instanceof ThumbnailError);
        assert.equal(error.code, THUMBNAIL_ERROR_CODES.INVALID_MEDIA_TYPE);
        return true;
      }
    );
  }
});

test("enforces both declared and streamed source byte limits", async () => {
  await assert.rejects(
    fetchAndEncodeThumbnail(SOURCE_URL, {
      fetch: async () => imageResponse(new Uint8Array([1]), {
        contentLength: String(THUMBNAIL_MAX_SOURCE_BYTES + 1)
      })
    }),
    (error) => {
      assert.ok(error instanceof ThumbnailLimitError);
      assert.equal(error.code, THUMBNAIL_ERROR_CODES.SOURCE_TOO_LARGE);
      return true;
    }
  );

  const oversizedBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(THUMBNAIL_MAX_SOURCE_BYTES));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    }
  });
  await assert.rejects(
    fetchAndEncodeThumbnail(SOURCE_URL, {
      fetch: async () => imageResponse(oversizedBody)
    }),
    (error) => {
      assert.ok(error instanceof ThumbnailLimitError);
      assert.equal(error.code, THUMBNAIL_ERROR_CODES.SOURCE_TOO_LARGE);
      return true;
    }
  );
});

test("rejects oversized PNG, JPEG, and every WebP header before decoding", async () => {
  const oversizedDimension = THUMBNAIL_MAX_SOURCE_DIMENSION + 1;
  const cases = [
    { mediaType: "image/png", bytes: pngHeader(oversizedDimension, 1) },
    { mediaType: "image/png", bytes: pngHeader(5_000, 5_000) },
    { mediaType: "image/jpeg", bytes: jpegHeader(oversizedDimension, 1) },
    { mediaType: "image/webp", bytes: webpVp8xHeader(oversizedDimension, 1) },
    { mediaType: "image/webp", bytes: webpVp8Header(oversizedDimension, 1) },
    { mediaType: "image/webp", bytes: webpVp8lHeader(oversizedDimension, 1) }
  ];

  for (const item of cases) {
    let createBitmapCalled = false;
    await assert.rejects(
      fetchAndEncodeThumbnail(SOURCE_URL, {
        fetch: async () => imageResponse(item.bytes, {
          contentType: item.mediaType
        }),
        createBitmap: async () => {
          createBitmapCalled = true;
          return { width: 1, height: 1 };
        }
      }),
      (error) => {
        assert.ok(error instanceof ThumbnailLimitError);
        assert.equal(error.code, THUMBNAIL_ERROR_CODES.PIXEL_LIMIT);
        return true;
      }
    );
    assert.equal(createBitmapCalled, false, item.mediaType);
  }
});

test("reads dimensions from PNG, JPEG, VP8X, VP8, and VP8L headers", async () => {
  const cases = [
    { mediaType: "image/png", bytes: pngHeader(640, 360) },
    { mediaType: "image/jpeg", bytes: jpegHeader(640, 360) },
    { mediaType: "image/webp", bytes: webpVp8xHeader(640, 360) },
    { mediaType: "image/webp", bytes: webpVp8Header(640, 360) },
    { mediaType: "image/webp", bytes: webpVp8lHeader(640, 360) }
  ];

  for (const item of cases) {
    const image = createImageDependencies({
      sourceBytes: item.bytes,
      sourceMediaType: /** @type {"image/jpeg" | "image/png" | "image/webp"} */ (
        item.mediaType
      )
    });
    const result = await fetchAndEncodeThumbnail(SOURCE_URL, image.dependencies);
    assert.equal(result.width, 320, item.mediaType);
    assert.equal(result.height, 180, item.mediaType);
  }
});

test("rejects malformed or dimensionless image headers before decoding", async () => {
  const cases = [
    { mediaType: "image/png", bytes: pngHeader(0, 360).slice(0, 20) },
    { mediaType: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
    {
      mediaType: "image/webp",
      bytes: webpChunk("ANIM", new Uint8Array(6))
    },
    {
      mediaType: "image/webp",
      bytes: webpVp8Header(640, 360).slice(0, 25)
    }
  ];

  for (const item of cases) {
    let createBitmapCalled = false;
    await assert.rejects(
      fetchAndEncodeThumbnail(SOURCE_URL, {
        fetch: async () => imageResponse(item.bytes, {
          contentType: item.mediaType
        }),
        createBitmap: async () => {
          createBitmapCalled = true;
          return { width: 1, height: 1 };
        }
      }),
      (error) => {
        assert.ok(error instanceof ThumbnailResizeError);
        assert.equal(error.code, THUMBNAIL_ERROR_CODES.DECODE_FAILED);
        return true;
      }
    );
    assert.equal(createBitmapCalled, false, item.mediaType);
  }
});

test("rechecks decoded pixel limits and closes rejected bitmaps", async () => {
  const image = createImageDependencies({
    width: THUMBNAIL_MAX_SOURCE_PIXELS,
    height: 2,
    headerWidth: 640,
    headerHeight: 360
  });
  await assert.rejects(
    fetchAndEncodeThumbnail(SOURCE_URL, image.dependencies),
    (error) => {
      assert.ok(error instanceof ThumbnailLimitError);
      assert.equal(error.code, THUMBNAIL_ERROR_CODES.PIXEL_LIMIT);
      return true;
    }
  );
  assert.equal(image.isClosed(), true);
  assert.equal(image.encodes.length, 0);
});

test("reports decode and resize failures as non-domain thumbnail errors", async () => {
  await assert.rejects(
    fetchAndEncodeThumbnail(SOURCE_URL, {
      fetch: async () => imageResponse(pngHeader(1, 1)),
      createBitmap: async () => {
        throw new Error("invalid image");
      }
    }),
    (error) => {
      assert.ok(error instanceof ThumbnailResizeError);
      assert.equal(error.code, THUMBNAIL_ERROR_CODES.DECODE_FAILED);
      return true;
    }
  );

  const image = createImageDependencies({ contextAvailable: false });
  await assert.rejects(
    fetchAndEncodeThumbnail(SOURCE_URL, image.dependencies),
    (error) => {
      assert.ok(error instanceof ThumbnailResizeError);
      assert.equal(error.code, THUMBNAIL_ERROR_CODES.RESIZE_FAILED);
      return true;
    }
  );
  assert.equal(image.isClosed(), true);
});

test("reduces dimensions and quality toward 24 KiB with a 48 KiB hard cap", async () => {
  const image = createImageDependencies({
    width: 1_600,
    height: 900,
    encodedSize: (width, _height, quality) => {
      if (width === THUMBNAIL_MAX_EDGE) {
        return THUMBNAIL_MAX_OUTPUT_BYTES + 1;
      }
      return quality <= 0.68
        ? THUMBNAIL_TARGET_BYTES
        : THUMBNAIL_TARGET_BYTES + 2_000;
    }
  });

  const result = await fetchAndEncodeThumbnail(SOURCE_URL, image.dependencies);

  assert.equal(result.width, 272);
  assert.equal(result.height, 153);
  assert.equal(result.bytes.byteLength, THUMBNAIL_TARGET_BYTES);
  assert.ok(result.bytes.byteLength <= THUMBNAIL_MAX_OUTPUT_BYTES);
  assert.ok(image.encodes.some((entry) => entry.width === THUMBNAIL_MAX_EDGE));
  assert.ok(image.encodes.some((entry) => entry.width === 272));
});

test("returns the smallest under-cap candidate or a typed output limit error", async () => {
  const bounded = createImageDependencies({
    encodedSize: () => THUMBNAIL_TARGET_BYTES + 1_000
  });
  const result = await fetchAndEncodeThumbnail(SOURCE_URL, bounded.dependencies);
  assert.equal(result.bytes.byteLength, THUMBNAIL_TARGET_BYTES + 1_000);
  assert.ok(result.bytes.byteLength <= THUMBNAIL_MAX_OUTPUT_BYTES);

  const oversized = createImageDependencies({
    encodedSize: () => THUMBNAIL_MAX_OUTPUT_BYTES + 1
  });
  await assert.rejects(
    fetchAndEncodeThumbnail(SOURCE_URL, oversized.dependencies),
    (error) => {
      assert.ok(error instanceof ThumbnailLimitError);
      assert.equal(error.code, THUMBNAIL_ERROR_CODES.OUTPUT_TOO_LARGE);
      return true;
    }
  );
  assert.equal(oversized.isClosed(), true);
});

test("follows matching VRChat CDN images without persisting signed response URLs", async () => {
  for (const [source, path] of [
    [SOURCE_URL, `/thumbnails/${FILE_ID}.${"a".repeat(64)}.1.thumbnail-256.png`],
    [`https://api.vrchat.cloud/api/1/file/${FILE_ID}/1/file`, `/World-Image.${FILE_ID}.1.png`]
  ]) {
    assert.ok(source);
    const image = createImageDependencies();
    const finalUrl = `https://files.vrchat.cloud${path}?Expires=123&Key-Pair-Id=example&Signature=example`;
    image.dependencies.fetch = async () => imageResponse(pngHeader(640, 360), {
      url: finalUrl,
      redirected: true
    });
    const result = await fetchAndEncodeThumbnail(source, image.dependencies);
    assert.equal(result.sourceUrl, source);
    assert.doesNotMatch(result.sourceUrl, /Signature|Expires|Key-Pair-Id/u);
    assert.equal(image.decodedBlobs.length, 1);
  }
});

test("rejects unsafe or mismatched image targets before reading their bodies", async () => {
  const safePath = `/thumbnails/${FILE_ID}.${"a".repeat(64)}.1.thumbnail-256.png`;
  const safeUrl = `https://files.vrchat.cloud${safePath}`;
  for (const finalUrl of [
    safeUrl.replace("https:", "http:"),
    safeUrl.replace("files.vrchat.cloud", "files.vrchat.cloud.evil.example"),
    safeUrl.replace("files.vrchat.cloud", "user@files.vrchat.cloud"),
    safeUrl.replace("files.vrchat.cloud", "files.vrchat.cloud:8443"),
    `${safeUrl}#fragment`,
    `${safeUrl}#`,
    safeUrl.replace("/thumbnails/", "/arbitrary/"),
    safeUrl.replace(FILE_ID, "file_00000000-0000-0000-0000-000000000002"),
    safeUrl.replace(".1.thumbnail", ".2.thumbnail"),
    safeUrl.replace("thumbnail-256", "thumbnail-512"),
    SOURCE_URL.replace("/1/256", "/2/256")
  ]) {
    const response = imageResponse(pngHeader(640, 360), { url: finalUrl, redirected: true });
    let bodyAccessed = false;
    Object.defineProperty(response, "body", { get() { bodyAccessed = true; throw new Error("must not read body"); } });
    await assert.rejects(fetchAndEncodeThumbnail(SOURCE_URL, { fetch: async () => response }), (error) => {
      assert.ok(error instanceof ThumbnailFetchError);
      assert.equal(error.code, THUMBNAIL_ERROR_CODES.UNEXPECTED_REDIRECT);
      return true;
    });
    assert.equal(bodyAccessed, false, finalUrl);
  }
});
