// @ts-check

import { AuthRequiredError, RateLimitedError, TwoFactorRequiredError } from "./api.js";
import { AuthCookieRequiredError } from "./auth-cookie-bridge.js";

export const AUTH_STATUS_CACHE_MS = 60_000;
export const AUTH_STATUS_CACHE_KEY = "currentAuthObservation";

/** A shared cooldown, not a second HTTP 429 response. */
export class ActiveRateLimitError extends RateLimitedError {}

/** @typedef {"authenticated" | "auth_required" | "two_factor_required" | "unknown" | "busy" | "rate_limited"} AuthState */
/** @typedef {{state: AuthState, checkedAt: string | null, retryAt: string | null}} AuthStatus */

/** Serialize every bridge use, including startup and purge cleanup. */
export class ApiSessionCoordinator {
  /** @type {Promise<void>} */
  #tail = Promise.resolve();
  #pending = 0;

  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  run(operation) {
    this.#pending += 1;
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result.finally(() => { this.#pending -= 1; });
  }

  /** @template T @param {() => Promise<T>} operation @returns {Promise<T> | null} */
  runIfIdle(operation) {
    return this.#pending === 0 ? this.run(operation) : null;
  }
}

/**
 * A separate, credential-free observation; never writes sync/profile history.
 * @param {{
 *   sessions: ApiSessionCoordinator,
 *   canCheck: () => boolean,
 *   isMaintenancePending: () => Promise<boolean>,
 *   getBackoffUntil: () => Promise<number | null>,
 *   recordRateLimit: (error: RateLimitedError) => Promise<number>,
 *   ensureUserAgentRule: () => Promise<unknown>,
 *   probe: () => Promise<unknown>,
 *   loadCache?: () => Promise<unknown>,
 *   saveCache?: (status: AuthStatus) => Promise<void>,
 *   clock?: () => number
 * }} dependencies
 */
export function createAuthStatusChecker(dependencies) {
  const now = dependencies.clock ?? Date.now;
  /** @type {AuthStatus | null} */
  let cached = null;
  let expiresAt = 0;
  /** @type {Promise<AuthStatus> | null} */
  let inFlight = null;

  /** @param {AuthState} state @param {number | null} [retryAt] @returns {AuthStatus} */
  const result = (state, retryAt = null) => ({
    state,
    checkedAt: state === "busy" ? null : new Date(now()).toISOString(),
    retryAt: retryAt === null ? null : new Date(retryAt).toISOString()
  });

  /** @returns {Promise<AuthStatus>} */
  async function probe() {
    try {
      if (!dependencies.canCheck() || await dependencies.isMaintenancePending()) return result("busy");
      const backoff = await dependencies.getBackoffUntil();
      if (backoff !== null && backoff > now()) return result("rate_limited", backoff);
      const saved = await dependencies.loadCache?.();
      if (isRecentObservation(saved, now())) return {
        state: saved.state,
        checkedAt: new Date(/** @type {string} */ (saved.checkedAt)).toISOString(),
        retryAt: saved.retryAt === null ? null : new Date(saved.retryAt).toISOString()
      };
      await dependencies.ensureUserAgentRule();
      // Recheck after async setup: purge/sync may have reserved its operation.
      if (!dependencies.canCheck() || await dependencies.isMaintenancePending()) return result("busy");
      await dependencies.probe();
      return result("authenticated");
    } catch (error) {
      if (error instanceof TwoFactorRequiredError) return result("two_factor_required");
      if (error instanceof AuthCookieRequiredError
        || (error instanceof AuthRequiredError && error.status === 401)) return result("auth_required");
      if (error instanceof RateLimitedError) {
        try { return result("rate_limited", await dependencies.recordRateLimit(error)); }
        catch { return result("rate_limited", Math.max(now() + AUTH_STATUS_CACHE_MS, error.retryAt ?? 0)); }
      }
      // 403, network, schema, bridge conflicts and cleanup failures are not logout evidence.
      return result("unknown");
    }
  }

  return {
    /** @returns {Promise<AuthStatus>} */
    check() {
      if (inFlight !== null) return inFlight;
      if (!dependencies.canCheck()) return Promise.resolve(result("busy"));
      if (cached !== null && now() < expiresAt) return Promise.resolve(cached);
      const operation = dependencies.sessions.runIfIdle(async () => {
        const status = await probe();
        if (status.state !== "busy") {
          try { await dependencies.saveCache?.(status); }
          catch { /* Cache is optional; keep the observation in worker memory. */ }
        }
        return status;
      });
      if (operation === null) return Promise.resolve(result("busy"));
      const tracked = operation.then((status) => {
        if (status.state !== "busy") {
          cached = status;
          expiresAt = Math.max(Date.parse(status.checkedAt ?? "") + AUTH_STATUS_CACHE_MS,
            status.retryAt === null ? 0 : Date.parse(status.retryAt));
        }
        return status;
      }).finally(() => { if (inFlight === tracked) inFlight = null; });
      inFlight = tracked;
      return tracked;
    }
  };
}

/** @param {unknown} value @param {number} now @returns {value is AuthStatus} */
function isRecentObservation(value, now) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = /** @type {Record<string, unknown>} */ (value);
  if (typeof candidate.state !== "string"
    || !["authenticated", "auth_required", "two_factor_required", "unknown", "rate_limited"].includes(candidate.state)
    || typeof candidate.checkedAt !== "string") return false;
  if (candidate.retryAt !== null && (candidate.state !== "rate_limited"
    || typeof candidate.retryAt !== "string" || !Number.isFinite(Date.parse(candidate.retryAt)))) return false;
  const age = now - Date.parse(candidate.checkedAt);
  return Number.isFinite(age) && age >= 0 && age < AUTH_STATUS_CACHE_MS;
}
