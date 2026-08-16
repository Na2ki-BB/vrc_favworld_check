// @ts-check

export const REGULAR_INTERVAL_MS = 12 * 60 * 60 * 1_000;
export const REGULAR_JITTER_MS = 60 * 60 * 1_000;
export const RECOVERY_MIN_DELAY_MS = 30 * 60 * 1_000;
export const RECOVERY_JITTER_MS = 30 * 60 * 1_000;
export const STARTUP_MIN_DELAY_MS = 60 * 1_000;
export const STARTUP_JITTER_MS = 9 * 60 * 1_000;
export const RATE_LIMIT_BASE_DELAY_MS = 30 * 1_000;
export const RATE_LIMIT_MAX_DELAY_MS = 30 * 60 * 1_000;
export const MAX_RATE_LIMIT_COUNT = 7;
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

/**
 * @typedef {"success" | "429" | "offline" | "5xx" | "auth" | "schema" | "other"} SyncResult
 */

/**
 * @typedef {{
 *   action: "clear" | "keep" | "create",
 *   when: number | null,
 *   nextSyncAt: number | null
 * }} StartupScheduleRepair
 */

/**
 * Parse a Retry-After header without accepting unbounded server-provided waits.
 * A valid value is either 1..86400 delta-seconds or an HTTP date 1 second to
 * 24 hours in the future.
 *
 * @param {string | null} value
 * @param {number} nowMs
 * @returns {number | null} absolute epoch milliseconds
 */
export function parseRetryAfter(value, nowMs) {
  assertTimestamp(nowMs, "nowMs");

  if (value === null) {
    return null;
  }

  const normalized = value.trim();
  if (normalized === "") {
    return null;
  }

  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized);
    if (Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 86_400) {
      return nowMs + seconds * 1_000;
    }
    return null;
  }

  const parsedAt = Date.parse(normalized);
  if (!Number.isFinite(parsedAt)) {
    return null;
  }

  const delayMs = parsedAt - nowMs;
  if (delayMs < 1_000 || delayMs > MAX_RETRY_AFTER_MS) {
    return null;
  }
  return parsedAt;
}

/**
 * Calculate the persisted counter and one-shot resume time after a 429.
 * Jitter is 0..10% of the slower of the saturated exponential delay and a
 * valid Retry-After value.
 *
 * @param {{
 *   nowMs: number,
 *   previousCount: number,
 *   retryAfter: string | null,
 *   randomValue: number
 * }} options
 * @returns {{
 *   consecutiveRateLimits: number,
 *   retryAfterAt: number | null,
 *   backoffUntil: number
 * }}
 */
export function calculateRateLimitBackoff(options) {
  assertTimestamp(options.nowMs, "nowMs");
  if (!Number.isSafeInteger(options.previousCount) || options.previousCount < 0) {
    throw new RangeError("previousCount must be a non-negative safe integer");
  }
  assertRandomValue(options.randomValue);

  const consecutiveRateLimits = Math.min(
    options.previousCount + 1,
    MAX_RATE_LIMIT_COUNT
  );
  const exponentialDelayMs = Math.min(
    RATE_LIMIT_BASE_DELAY_MS * 2 ** (consecutiveRateLimits - 1),
    RATE_LIMIT_MAX_DELAY_MS
  );
  const retryAfterAt = parseRetryAfter(options.retryAfter, options.nowMs);
  const retryAfterDelayMs = retryAfterAt === null
    ? 0
    : retryAfterAt - options.nowMs;
  const baseDelayMs = Math.max(exponentialDelayMs, retryAfterDelayMs);
  const jitterMs = Math.floor(baseDelayMs * 0.1 * options.randomValue);

  return {
    consecutiveRateLimits,
    retryAfterAt,
    backoffUntil: options.nowMs + baseDelayMs + jitterMs
  };
}

/**
 * Calculate the next named one-shot alarm for every controlled sync outcome.
 * A rate-limited result uses the already persisted backoff time exactly.
 *
 * @param {{
 *   result: SyncResult,
 *   nowMs: number,
 *   randomValue?: number,
 *   backoffUntil?: number | null
 * }} options
 * @returns {number}
 */
export function calculateNextSyncAt(options) {
  assertTimestamp(options.nowMs, "nowMs");

  if (options.result === "429") {
    if (
      typeof options.backoffUntil !== "number"
      || !Number.isFinite(options.backoffUntil)
      || options.backoffUntil <= options.nowMs
    ) {
      throw new RangeError("429 requires a future backoffUntil");
    }
    return options.backoffUntil;
  }

  const randomValue = options.randomValue;
  if (typeof randomValue !== "number") {
    throw new RangeError("randomValue is required for this sync result");
  }
  assertRandomValue(randomValue);

  if (options.result === "offline" || options.result === "5xx") {
    return options.nowMs
      + RECOVERY_MIN_DELAY_MS
      + Math.floor(RECOVERY_JITTER_MS * randomValue);
  }

  if (
    options.result === "success"
    || options.result === "auth"
    || options.result === "schema"
    || options.result === "other"
  ) {
    return options.nowMs
      + REGULAR_INTERVAL_MS
      + Math.floor(REGULAR_JITTER_MS * randomValue);
  }

  return assertNever(options.result);
}

/**
 * Decide how startup/install should repair the single named alarm.
 * Existing future alarms are preserved. If it is missing, a future persisted
 * time is restored; otherwise a new time 1..10 minutes out is selected.
 *
 * @param {{
 *   automaticSyncEnabled: boolean,
 *   storedNextSyncAt: number | null,
 *   existingAlarmWhen: number | null,
 *   nowMs: number,
 *   randomValue?: number
 * }} options
 * @returns {StartupScheduleRepair}
 */
export function repairStartupSchedule(options) {
  assertTimestamp(options.nowMs, "nowMs");

  if (!options.automaticSyncEnabled) {
    return { action: "clear", when: null, nextSyncAt: null };
  }

  if (isFutureTimestamp(options.existingAlarmWhen, options.nowMs)) {
    return {
      action: "keep",
      when: options.existingAlarmWhen,
      nextSyncAt: options.existingAlarmWhen
    };
  }

  if (isFutureTimestamp(options.storedNextSyncAt, options.nowMs)) {
    return {
      action: "create",
      when: options.storedNextSyncAt,
      nextSyncAt: options.storedNextSyncAt
    };
  }

  const randomValue = options.randomValue;
  if (typeof randomValue !== "number") {
    throw new RangeError("randomValue is required to repair an expired schedule");
  }
  assertRandomValue(randomValue);
  const repairedAt = options.nowMs
    + STARTUP_MIN_DELAY_MS
    + Math.floor(STARTUP_JITTER_MS * randomValue);
  return { action: "create", when: repairedAt, nextSyncAt: repairedAt };
}

/**
 * @param {number | null} value
 * @param {number} nowMs
 * @returns {value is number}
 */
function isFutureTimestamp(value, nowMs) {
  return value !== null && Number.isFinite(value) && value > nowMs;
}

/**
 * @param {number} value
 * @param {string} name
 */
function assertTimestamp(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite timestamp`);
  }
}

/** @param {number} value */
function assertRandomValue(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError("randomValue must be between 0 and 1");
  }
}

/**
 * @param {never} value
 * @returns {never}
 */
function assertNever(value) {
  throw new TypeError(`Unsupported sync result: ${String(value)}`);
}
