// @ts-check

import { parseRetryAfter } from "./schedule.js";

export const VRCHAT_API_BASE_URL = "https://api.vrchat.cloud/api/1";
export const API_REQUEST_INTERVAL_MS = 2_000;
export const API_PAGE_SIZE = 100;
export const API_MAX_ITEMS = 10_000;
export const API_MAX_PAGE_REQUESTS = 101;
export const API_MAX_RETRIES = 2;
export const API_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const API_MAX_TEXT_CODE_POINTS = 4_096;
export const API_MAX_TAGS = 100;

export const API_ERROR_CODES = /** @type {const} */ ({
  AUTH_REQUIRED: "AUTH_REQUIRED",
  FORBIDDEN: "FORBIDDEN",
  RATE_LIMITED: "RATE_LIMITED",
  SERVER_ERROR: "SERVER_ERROR",
  NETWORK_ERROR: "NETWORK_ERROR",
  API_INCOMPATIBLE: "API_INCOMPATIBLE",
  PAGINATION_INVALID: "PAGINATION_INVALID",
  UNEXPECTED_REDIRECT: "UNEXPECTED_REDIRECT"
});

const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_JITTER_RATIO = 0.25;
const CURRENT_USER_MAX_DEPTH = 8;
const CURRENT_USER_MAX_OBJECTS = 10_000;
const WORLD_ID_PATTERN = /^wrld_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_ID_PATTERN = /^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENSITIVE_FIELD_PATTERN = /(credential|password|passwd|token|cookie|session|authorization|secret|apikey)/;
const SENSITIVE_FIELD_NAMES = new Set([
  "auth",
  "otp",
  "totp",
  "2facode",
  "twofactorcode"
]);
const SAFE_CURRENT_USER_KEY_FIELDS = new Set([
  // Documented VRChat CurrentUser compatibility field. It is never projected
  // into local storage, but its presence must not make every login fail.
  "friendkey"
]);
const RELEASE_STATUSES = new Set(["public", "private", "hidden"]);

/**
 * @typedef {(typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES]} ApiErrorCode
 * @typedef {"auth" | "forbidden" | "rate_limit" | "server" | "offline" | "schema" | "pagination" | "redirect"} ApiErrorCategory
 * @typedef {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>} FetchLike
 * @typedef {(delayMs: number) => Promise<void>} SleepLike
 * @typedef {() => number} ClockLike
 * @typedef {() => number} RandomLike
 *
 * @typedef {{id: string, displayName: string}} AuthenticatedUser
 * @typedef {{favoriteId: string, tags: string[], type: "world"}} FavoriteRelation
 * @typedef {{
 *   id: string,
 *   name: string,
 *   authorName: string,
 *   favoriteGroup: string,
 *   releaseStatus: "public" | "private" | "hidden"
 * }} FavoriteWorldMetadata
 * @typedef {{
 *   id: string,
 *   name: string,
 *   authorName: string,
 *   releaseStatus: "public" | "private" | "hidden"
 * }} WorldMetadata
 * @typedef {{status: 200, world: WorldMetadata} | {status: 404, world: null}} WorldProbe
 * @typedef {{status: 200, body: unknown} | {status: 404, body: null}} ApiResponse
 */

export class VrchatApiError extends Error {
  /**
   * @param {ApiErrorCode} code
   * @param {ApiErrorCategory} category
   * @param {number | null} status
   * @param {boolean} retryable
   */
  constructor(code, category, status, retryable) {
    super(code);
    this.name = "VrchatApiError";
    this.code = code;
    this.category = category;
    this.status = status;
    this.retryable = retryable;
  }
}

export class AuthRequiredError extends VrchatApiError {
  /** @param {number} status */
  constructor(status = 401) {
    super(API_ERROR_CODES.AUTH_REQUIRED, "auth", status, false);
    this.name = "AuthRequiredError";
  }
}

export class ForbiddenError extends VrchatApiError {
  constructor() {
    super(API_ERROR_CODES.FORBIDDEN, "forbidden", 403, false);
    this.name = "ForbiddenError";
  }
}

export class RateLimitedError extends VrchatApiError {
  /**
   * @param {number | null} retryAt
   * @param {number} observedAt
   */
  constructor(retryAt, observedAt) {
    super(API_ERROR_CODES.RATE_LIMITED, "rate_limit", 429, false);
    this.name = "RateLimitedError";
    this.retryAt = retryAt;
    this.retryAfterMs = retryAt === null
      ? null
      : Math.max(0, retryAt - observedAt);
  }
}

export class ServerError extends VrchatApiError {
  /** @param {number} status */
  constructor(status) {
    super(API_ERROR_CODES.SERVER_ERROR, "server", status, true);
    this.name = "ServerError";
  }
}

export class NetworkError extends VrchatApiError {
  constructor() {
    super(API_ERROR_CODES.NETWORK_ERROR, "offline", null, true);
    this.name = "NetworkError";
  }
}

export class ApiSchemaError extends VrchatApiError {
  /** @param {number | null} status */
  constructor(status = 200) {
    super(API_ERROR_CODES.API_INCOMPATIBLE, "schema", status, false);
    this.name = "ApiSchemaError";
  }
}

export class PaginationError extends VrchatApiError {
  constructor() {
    super(API_ERROR_CODES.PAGINATION_INVALID, "pagination", 200, false);
    this.name = "PaginationError";
  }
}

export class UnexpectedRedirectError extends VrchatApiError {
  /** @param {number | null} status */
  constructor(status) {
    super(API_ERROR_CODES.UNEXPECTED_REDIRECT, "redirect", status, false);
    this.name = "UnexpectedRedirectError";
  }
}

export class VrchatApi {
  /** @type {FetchLike} */
  #fetch;
  /** @type {SleepLike} */
  #sleep;
  /** @type {ClockLike} */
  #clock;
  /** @type {RandomLike} */
  #random;
  /** @type {number} */
  #timeoutMs;
  /** @type {number | null} */
  #lastRequestStartedAt = null;
  /** @type {Promise<void>} */
  #requestTail = Promise.resolve();

  /**
   * @param {{
   *   fetch?: FetchLike,
   *   sleep?: SleepLike,
   *   clock?: ClockLike,
   *   random?: RandomLike,
   *   timeoutMs?: number
   * }} [dependencies]
   */
  constructor(dependencies = {}) {
    this.#fetch = dependencies.fetch ?? defaultFetch;
    this.#sleep = dependencies.sleep ?? defaultSleep;
    this.#clock = dependencies.clock ?? Date.now;
    this.#random = dependencies.random ?? Math.random;
    this.#timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive finite number");
    }
  }

  /** @returns {Promise<AuthenticatedUser>} */
  async getCurrentUser() {
    const response = await this.#requestJson("/auth/user", false, true);
    if (response.status !== 200) {
      throw new ApiSchemaError();
    }

    assertCurrentUserHasNoSensitiveFields(response.body);
    if (!isRecord(response.body)) {
      throw new ApiSchemaError();
    }

    const id = response.body.id;
    const displayName = response.body.displayName;
    if (!isUserId(id) || !isNonEmptyString(displayName)) {
      throw new ApiSchemaError();
    }

    return { id, displayName };
  }

  /** @returns {Promise<FavoriteRelation[]>} */
  async listAllFavoriteRelations() {
    return this.#listAll(
      (offset) => `/favorites?type=world&n=${API_PAGE_SIZE}&offset=${offset}`,
      projectFavoriteRelation,
      (relation) => relation.favoriteId
    );
  }

  /** @returns {Promise<FavoriteWorldMetadata[]>} */
  async listAllFavoriteWorlds() {
    return this.#listAll(
      (offset) => `/worlds/favorites?n=${API_PAGE_SIZE}&offset=${offset}&releaseStatus=all`,
      projectFavoriteWorld,
      (world) => world.id
    );
  }

  /**
   * @param {string} worldId
   * @returns {Promise<WorldProbe>}
   */
  async getWorld(worldId) {
    if (!isWorldId(worldId)) {
      throw new ApiSchemaError(null);
    }

    const response = await this.#requestJson(
      `/worlds/${encodeURIComponent(worldId)}`,
      true,
      false
    );
    if (response.status === 404) {
      return { status: 404, world: null };
    }
    return { status: 200, world: projectWorld(response.body) };
  }

  /**
   * @template T
   * @param {(offset: number) => string} pathForOffset
   * @param {(value: unknown) => T} projectItem
   * @param {(value: T) => string} itemIdentity
   * @returns {Promise<T[]>}
   */
  async #listAll(pathForOffset, projectItem, itemIdentity) {
    /** @type {T[]} */
    const items = [];
    const pageFingerprints = new Set();
    const seenItemIds = new Set();
    let offset = 0;
    let requestCount = 0;
    let nonEmptyRequestCount = 0;

    while (requestCount < API_MAX_PAGE_REQUESTS) {
      requestCount += 1;
      const response = await this.#requestJson(
        pathForOffset(offset),
        false,
        false
      );
      if (response.status !== 200 || !Array.isArray(response.body)) {
        throw new ApiSchemaError();
      }
      if (response.body.length > API_PAGE_SIZE) {
        throw new ApiSchemaError();
      }

      const page = response.body.map(projectItem);
      if (page.length === 0) {
        return items;
      }

      nonEmptyRequestCount += 1;
      if (nonEmptyRequestCount > API_MAX_PAGE_REQUESTS - 1) {
        throw new PaginationError();
      }
      if (items.length + page.length > API_MAX_ITEMS) {
        throw new PaginationError();
      }

      const pageIds = page.map(itemIdentity);
      const fingerprint = JSON.stringify([...pageIds].sort());
      if (pageFingerprints.has(fingerprint)) {
        throw new PaginationError();
      }
      pageFingerprints.add(fingerprint);

      for (const itemId of pageIds) {
        if (seenItemIds.has(itemId)) {
          throw new PaginationError();
        }
        seenItemIds.add(itemId);
      }

      const nextOffset = offset + page.length;
      if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) {
        throw new PaginationError();
      }

      items.push(...page);
      offset = nextOffset;
    }

    throw new PaginationError();
  }

  /**
   * @param {string} path
   * @param {boolean} allowNotFound
   * @param {boolean} authEndpoint
   * @returns {Promise<ApiResponse>}
   */
  async #requestJson(path, allowNotFound, authEndpoint) {
    for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt += 1) {
      try {
        return await this.#withThrottle(
          () => this.#fetchJson(path, allowNotFound, authEndpoint)
        );
      } catch (error) {
        const canRetry = error instanceof NetworkError
          || error instanceof ServerError;
        if (!canRetry || attempt === API_MAX_RETRIES) {
          throw error;
        }
        await this.#sleep(this.#retryDelayMs(attempt));
      }
    }

    throw new NetworkError();
  }

  /**
   * @param {string} path
   * @param {boolean} allowNotFound
   * @param {boolean} authEndpoint
   * @returns {Promise<ApiResponse>}
   */
  async #fetchJson(path, allowNotFound, authEndpoint) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.#timeoutMs);
    /** @type {Response} */
    let response;

    try {
      response = await this.#fetch(`${VRCHAT_API_BASE_URL}${path}`, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "manual",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
    } catch {
      clearTimeout(timeoutId);
      throw new NetworkError();
    }

    try {
      if (
        response.redirected
        || response.type === "opaqueredirect"
        || response.status === 0
        || (response.status >= 300 && response.status < 400)
      ) {
        throw new UnexpectedRedirectError(
          response.status === 0 ? null : response.status
        );
      }

      if (response.status === 401) {
        throw new AuthRequiredError(401);
      }
      if (response.status === 403) {
        if (authEndpoint) {
          throw new AuthRequiredError(403);
        }
        throw new ForbiddenError();
      }
      if (response.status === 429) {
        const observedAt = this.#now();
        const retryAt = parseRetryAfter(
          response.headers.get("Retry-After"),
          observedAt
        );
        throw new RateLimitedError(retryAt, observedAt);
      }
      if (response.status >= 500 && response.status <= 599) {
        throw new ServerError(response.status);
      }
      if (response.status === 404 && allowNotFound) {
        return { status: 404, body: null };
      }
      if (response.status !== 200) {
        throw new ApiSchemaError(response.status);
      }

      return { status: 200, body: await readBoundedJson(response) };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  async #withThrottle(operation) {
    const previous = this.#requestTail;
    /** @type {() => void} */
    let release = () => {};
    this.#requestTail = new Promise((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      const now = this.#now();
      if (this.#lastRequestStartedAt !== null) {
        const waitMs = this.#lastRequestStartedAt
          + API_REQUEST_INTERVAL_MS
          - now;
        if (waitMs > 0) {
          await this.#sleep(waitMs);
        }
      }
      this.#lastRequestStartedAt = Math.max(
        this.#now(),
        this.#lastRequestStartedAt === null
          ? 0
          : this.#lastRequestStartedAt + API_REQUEST_INTERVAL_MS
      );
      return await operation();
    } finally {
      release();
    }
  }

  /** @param {number} attempt */
  #retryDelayMs(attempt) {
    return Math.floor(
      RETRY_BASE_DELAY_MS
      * 2 ** attempt
      * (1 + RETRY_JITTER_RATIO * this.#randomValue())
    );
  }

  #now() {
    const value = this.#clock();
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError("clock must return a non-negative finite timestamp");
    }
    return value;
  }

  #randomValue() {
    const value = this.#random();
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError("random must return a value between 0 and 1");
    }
    return value;
  }
}

/**
 * @param {unknown} value
 * @returns {FavoriteRelation}
 */
function projectFavoriteRelation(value) {
  if (!isRecord(value)) {
    throw new ApiSchemaError();
  }
  const favoriteId = value.favoriteId;
  const tags = value.tags;
  if (
    !isWorldId(favoriteId)
    || value.type !== "world"
    || !Array.isArray(tags)
    || tags.length > API_MAX_TAGS
    || !tags.every(isNonEmptyString)
  ) {
    throw new ApiSchemaError();
  }
  return { favoriteId, tags: [...tags], type: "world" };
}

/**
 * @param {unknown} value
 * @returns {FavoriteWorldMetadata}
 */
function projectFavoriteWorld(value) {
  if (!isRecord(value)) {
    throw new ApiSchemaError();
  }
  const world = projectWorld(value);
  const favoriteGroup = value.favoriteGroup;
  if (!isNonEmptyString(favoriteGroup)) {
    throw new ApiSchemaError();
  }
  return { ...world, favoriteGroup };
}

/**
 * @param {unknown} value
 * @returns {WorldMetadata}
 */
function projectWorld(value) {
  if (!isRecord(value)) {
    throw new ApiSchemaError();
  }

  const id = value.id;
  const name = value.name;
  const authorName = value.authorName;
  const releaseStatus = value.releaseStatus;
  if (
    !isWorldId(id)
    || !isNonEmptyString(name)
    || !isNonEmptyString(authorName)
    || !isReleaseStatus(releaseStatus)
  ) {
    throw new ApiSchemaError();
  }

  return { id, name, authorName, releaseStatus };
}

/** @param {unknown} value */
function assertCurrentUserHasNoSensitiveFields(value) {
  const visited = new WeakSet();
  let objectCount = 0;

  /**
   * @param {unknown} current
   * @param {number} depth
   */
  function visit(current, depth) {
    if (current === null || typeof current !== "object") {
      return;
    }
    if (depth > CURRENT_USER_MAX_DEPTH || visited.has(current)) {
      throw new ApiSchemaError();
    }

    objectCount += 1;
    if (objectCount > CURRENT_USER_MAX_OBJECTS) {
      throw new ApiSchemaError();
    }
    visited.add(current);

    for (const [key, nestedValue] of Object.entries(current)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (
        SENSITIVE_FIELD_PATTERN.test(normalizedKey)
        || SENSITIVE_FIELD_NAMES.has(normalizedKey)
        || (
          normalizedKey.endsWith("key")
          && !(depth === 0 && SAFE_CURRENT_USER_KEY_FIELDS.has(normalizedKey))
        )
      ) {
        throw new ApiSchemaError();
      }
      visit(nestedValue, depth + 1);
    }
  }

  visit(value, 0);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }
  let codePointCount = 0;
  for (const character of value) {
    codePointCount += 1;
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePointCount > API_MAX_TEXT_CODE_POINTS
      || codePoint <= 31
      || (codePoint >= 127 && codePoint <= 159)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isWorldId(value) {
  return typeof value === "string" && WORLD_ID_PATTERN.test(value);
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isUserId(value) {
  return typeof value === "string" && USER_ID_PATTERN.test(value);
}

/**
 * @param {unknown} value
 * @returns {value is "public" | "private" | "hidden"}
 */
function isReleaseStatus(value) {
  return typeof value === "string" && RELEASE_STATUSES.has(value);
}

/** @type {FetchLike} */
const defaultFetch = (input, init) => globalThis.fetch(input, init);

/** @type {SleepLike} */
const defaultSleep = (delayMs) => new Promise((resolve) => {
  setTimeout(resolve, delayMs);
});

/**
 * Read a successful JSON response without trusting Content-Length or allowing
 * an unexpectedly large body to be materialized. Stream read failures are
 * network errors; media type, UTF-8, size, and JSON failures are schema errors.
 *
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function readBoundedJson(response) {
  const mediaType = response.headers.get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    mediaType === undefined
    || (mediaType !== "application/json" && !mediaType.endsWith("+json"))
  ) {
    throw new ApiSchemaError();
  }

  const contentLength = response.headers.get("Content-Length");
  if (/^\d+$/u.test(contentLength ?? "")) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > API_MAX_RESPONSE_BYTES) {
      throw new ApiSchemaError();
    }
  }

  if (response.body === null) {
    throw new ApiSchemaError();
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
      throw new NetworkError();
    }
    if (result.done) {
      break;
    }
    totalBytes += result.value.byteLength;
    if (totalBytes > API_MAX_RESPONSE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        throw new ApiSchemaError();
      }
      throw new ApiSchemaError();
    }
    chunks.push(result.value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return /** @type {unknown} */ (JSON.parse(text));
  } catch {
    throw new ApiSchemaError();
  }
}
