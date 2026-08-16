// @ts-check

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_RATE_LIMIT_COUNT,
  MAX_RETRY_AFTER_MS,
  RATE_LIMIT_MAX_DELAY_MS,
  RECOVERY_JITTER_MS,
  RECOVERY_MIN_DELAY_MS,
  REGULAR_INTERVAL_MS,
  REGULAR_JITTER_MS,
  STARTUP_JITTER_MS,
  STARTUP_MIN_DELAY_MS,
  calculateNextSyncAt,
  calculateRateLimitBackoff,
  parseRetryAfter,
  repairStartupSchedule
} from "../extension/lib/schedule.js";

const NOW = 1_700_000_000_000;

test("parseRetryAfter accepts only bounded delta-seconds", () => {
  assert.equal(parseRetryAfter(null, NOW), null);
  assert.equal(parseRetryAfter("", NOW), null);
  assert.equal(parseRetryAfter("0", NOW), null);
  assert.equal(parseRetryAfter("1", NOW), NOW + 1_000);
  assert.equal(parseRetryAfter("86400", NOW), NOW + MAX_RETRY_AFTER_MS);
  assert.equal(parseRetryAfter("86401", NOW), null);
  assert.equal(parseRetryAfter("1.5", NOW), null);
  assert.equal(parseRetryAfter("+10", NOW), null);
});

test("parseRetryAfter accepts only HTTP dates one second to 24 hours ahead", () => {
  const alignedNow = 1_700_000_000_000;
  const oneSecondLater = new Date(alignedNow + 1_000).toUTCString();
  const oneDayLater = new Date(alignedNow + MAX_RETRY_AFTER_MS).toUTCString();
  const past = new Date(alignedNow).toUTCString();
  const tooFar = new Date(alignedNow + MAX_RETRY_AFTER_MS + 1_000).toUTCString();

  assert.equal(
    parseRetryAfter(oneSecondLater, alignedNow),
    alignedNow + 1_000
  );
  assert.equal(
    parseRetryAfter(oneDayLater, alignedNow),
    alignedNow + MAX_RETRY_AFTER_MS
  );
  assert.equal(parseRetryAfter(past, alignedNow), null);
  assert.equal(parseRetryAfter(tooFar, alignedNow), null);
  assert.equal(parseRetryAfter("not-a-date", alignedNow), null);
});

test("rate-limit backoff uses the slower delay and bounded ten-percent jitter", () => {
  assert.deepEqual(calculateRateLimitBackoff({
    nowMs: NOW,
    previousCount: 0,
    retryAfter: null,
    randomValue: 0
  }), {
    consecutiveRateLimits: 1,
    retryAfterAt: null,
    backoffUntil: NOW + 30_000
  });

  assert.deepEqual(calculateRateLimitBackoff({
    nowMs: NOW,
    previousCount: 1,
    retryAfter: "120",
    randomValue: 0.5
  }), {
    consecutiveRateLimits: 2,
    retryAfterAt: NOW + 120_000,
    backoffUntil: NOW + 126_000
  });
});

test("rate-limit counter and exponential delay saturate", () => {
  const result = calculateRateLimitBackoff({
    nowMs: NOW,
    previousCount: 999,
    retryAfter: null,
    randomValue: 1
  });

  assert.equal(result.consecutiveRateLimits, MAX_RATE_LIMIT_COUNT);
  assert.equal(
    result.backoffUntil,
    NOW + RATE_LIMIT_MAX_DELAY_MS + RATE_LIMIT_MAX_DELAY_MS * 0.1
  );
});

test("next one-shot time covers success, auth, schema, other, offline and 5xx", () => {
  for (const result of /** @type {const} */ ([
    "success",
    "auth",
    "schema",
    "other"
  ])) {
    assert.equal(calculateNextSyncAt({
      result,
      nowMs: NOW,
      randomValue: 0,
      backoffUntil: null
    }), NOW + REGULAR_INTERVAL_MS);
    assert.equal(calculateNextSyncAt({
      result,
      nowMs: NOW,
      randomValue: 1,
      backoffUntil: null
    }), NOW + REGULAR_INTERVAL_MS + REGULAR_JITTER_MS);
  }

  for (const result of /** @type {const} */ (["offline", "5xx"])) {
    assert.equal(calculateNextSyncAt({
      result,
      nowMs: NOW,
      randomValue: 0,
      backoffUntil: null
    }), NOW + RECOVERY_MIN_DELAY_MS);
    assert.equal(calculateNextSyncAt({
      result,
      nowMs: NOW,
      randomValue: 1,
      backoffUntil: null
    }), NOW + RECOVERY_MIN_DELAY_MS + RECOVERY_JITTER_MS);
  }
});

test("429 next time uses persisted backoff exactly and rejects expired values", () => {
  assert.equal(calculateNextSyncAt({
    result: "429",
    nowMs: NOW,
    backoffUntil: NOW + 45_000
  }), NOW + 45_000);

  assert.throws(() => calculateNextSyncAt({
    result: "429",
    nowMs: NOW,
    backoffUntil: NOW
  }), RangeError);
  assert.throws(() => calculateNextSyncAt({
    result: "429",
    nowMs: NOW
  }), RangeError);
});

test("startup repair clears disabled schedules and preserves a future alarm", () => {
  assert.deepEqual(repairStartupSchedule({
    automaticSyncEnabled: false,
    storedNextSyncAt: NOW + 10_000,
    existingAlarmWhen: NOW + 20_000,
    nowMs: NOW
  }), { action: "clear", when: null, nextSyncAt: null });

  assert.deepEqual(repairStartupSchedule({
    automaticSyncEnabled: true,
    storedNextSyncAt: NOW + 10_000,
    existingAlarmWhen: NOW + 20_000,
    nowMs: NOW
  }), {
    action: "keep",
    when: NOW + 20_000,
    nextSyncAt: NOW + 20_000
  });
});

test("startup repair restores a future persisted time when the alarm is missing", () => {
  assert.deepEqual(repairStartupSchedule({
    automaticSyncEnabled: true,
    storedNextSyncAt: NOW + 50_000,
    existingAlarmWhen: null,
    nowMs: NOW
  }), {
    action: "create",
    when: NOW + 50_000,
    nextSyncAt: NOW + 50_000
  });
});

test("startup repair moves missing or expired schedules one to ten minutes out", () => {
  assert.deepEqual(repairStartupSchedule({
    automaticSyncEnabled: true,
    storedNextSyncAt: NOW,
    existingAlarmWhen: NOW,
    nowMs: NOW,
    randomValue: 0
  }), {
    action: "create",
    when: NOW + STARTUP_MIN_DELAY_MS,
    nextSyncAt: NOW + STARTUP_MIN_DELAY_MS
  });

  assert.deepEqual(repairStartupSchedule({
    automaticSyncEnabled: true,
    storedNextSyncAt: null,
    existingAlarmWhen: null,
    nowMs: NOW,
    randomValue: 1
  }), {
    action: "create",
    when: NOW + STARTUP_MIN_DELAY_MS + STARTUP_JITTER_MS,
    nextSyncAt: NOW + STARTUP_MIN_DELAY_MS + STARTUP_JITTER_MS
  });
});

test("pure schedule inputs reject invalid boundaries", () => {
  assert.throws(() => calculateRateLimitBackoff({
    nowMs: NOW,
    previousCount: -1,
    retryAfter: null,
    randomValue: 0
  }), RangeError);
  assert.throws(() => calculateRateLimitBackoff({
    nowMs: NOW,
    previousCount: 0,
    retryAfter: null,
    randomValue: 1.01
  }), RangeError);
  assert.throws(() => calculateNextSyncAt({
    result: "success",
    nowMs: NOW,
    randomValue: -0.01
  }), RangeError);
});
