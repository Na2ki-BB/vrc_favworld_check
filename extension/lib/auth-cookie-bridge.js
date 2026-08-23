// @ts-check

export const SOURCE_AUTH_URL = "https://vrchat.com/api/1/auth/user";
export const TARGET_AUTH_URL = "https://api.vrchat.cloud/api/1/auth/user";
export const TARGET_COOKIE_PATH = "/api/1/";
export const BRIDGE_MARKER_NAME = "__vrc_favworld_check_bridge";
export const BRIDGE_MARKER_VALUE = "owned-v1";
export const BRIDGE_MARKER_PATH = "/.well-known/vrc-favworld-check-cookie-bridge/";
export const BRIDGE_MARKER_URL =
  "https://api.vrchat.cloud/.well-known/vrc-favworld-check-cookie-bridge/marker";
export const TEMPORARY_COOKIE_LIFETIME_SECONDS = 15 * 60;
export const MARKER_GRACE_SECONDS = 5 * 60;

const TARGET_HOST = "api.vrchat.cloud";
const AUTH_COOKIE_NAME = "auth";
const TWO_FACTOR_COOKIE_NAME = "twoFactorAuth";
const BRIDGED_COOKIE_NAMES = /** @type {const} */ ([
  AUTH_COOKIE_NAME,
  TWO_FACTOR_COOKIE_NAME
]);

export const AUTH_COOKIE_BRIDGE_ERROR_CODES = /** @type {const} */ ({
  AUTH_REQUIRED: "AUTH_COOKIE_REQUIRED",
  CONFLICT: "AUTH_COOKIE_CONFLICT",
  PARTITIONED: "AUTH_COOKIE_PARTITIONED",
  SETUP_FAILED: "AUTH_COOKIE_SETUP_FAILED",
  CLEANUP_FAILED: "AUTH_COOKIE_CLEANUP_FAILED",
  BUSY: "AUTH_COOKIE_BUSY"
});

/**
 * @typedef {(typeof AUTH_COOKIE_BRIDGE_ERROR_CODES)[keyof typeof AUTH_COOKIE_BRIDGE_ERROR_CODES]} AuthCookieBridgeErrorCode
 * @typedef {() => number} ClockLike
 * @typedef {{
 *   get(details: chrome.cookies.CookieDetails): Promise<chrome.cookies.Cookie | null | undefined>,
 *   getAll(details: chrome.cookies.GetAllDetails): Promise<chrome.cookies.Cookie[] | undefined>,
 *   set(details: chrome.cookies.SetDetails): Promise<chrome.cookies.Cookie | null | undefined>,
 *   remove(details: chrome.cookies.CookieDetails): Promise<chrome.cookies.CookieDetails | null | undefined>
 * }} CookiesApiLike
 * @typedef {{auth: chrome.cookies.Cookie, twoFactorAuth: chrome.cookies.Cookie | null, storeId: string}} SourceCookies
 */

let bridgeOperationActive = false;

export class AuthCookieBridgeError extends Error {
  /** @param {AuthCookieBridgeErrorCode} code */
  constructor(code) {
    super(code);
    this.name = "AuthCookieBridgeError";
    this.code = code;
  }
}

export class AuthCookieRequiredError extends AuthCookieBridgeError {
  constructor() {
    super(AUTH_COOKIE_BRIDGE_ERROR_CODES.AUTH_REQUIRED);
    this.name = "AuthCookieRequiredError";
  }
}

export class AuthCookieConflictError extends AuthCookieBridgeError {
  constructor() {
    super(AUTH_COOKIE_BRIDGE_ERROR_CODES.CONFLICT);
    this.name = "AuthCookieConflictError";
  }
}

export class AuthCookiePartitionedError extends AuthCookieBridgeError {
  constructor() {
    super(AUTH_COOKIE_BRIDGE_ERROR_CODES.PARTITIONED);
    this.name = "AuthCookiePartitionedError";
  }
}

export class AuthCookieSetupError extends AuthCookieBridgeError {
  constructor() {
    super(AUTH_COOKIE_BRIDGE_ERROR_CODES.SETUP_FAILED);
    this.name = "AuthCookieSetupError";
  }
}

export class AuthCookieCleanupError extends AuthCookieBridgeError {
  constructor() {
    super(AUTH_COOKIE_BRIDGE_ERROR_CODES.CLEANUP_FAILED);
    this.name = "AuthCookieCleanupError";
  }
}

export class AuthCookieBusyError extends AuthCookieBridgeError {
  constructor() {
    super(AUTH_COOKIE_BRIDGE_ERROR_CODES.BUSY);
    this.name = "AuthCookieBusyError";
  }
}

/**
 * Copies only the two explicitly allowed VRChat authentication cookies into
 * the API host for the duration of one operation. Cookie values never leave
 * this object and are never attached to errors or results.
 */
export class AuthCookieBridge {
  /** @type {CookiesApiLike} */
  #cookies;
  /** @type {ClockLike} */
  #clock;

  /**
   * @param {{cookies: CookiesApiLike, clock?: ClockLike}} dependencies
   */
  constructor(dependencies) {
    this.#cookies = dependencies.cookies;
    this.#clock = dependencies.clock ?? Date.now;
  }

  /**
   * @template T
   * @param {() => T | Promise<T>} operation
   * @returns {Promise<T>}
   */
  async withTemporaryApiCookies(operation) {
    if (bridgeOperationActive) {
      throw new AuthCookieBusyError();
    }
    bridgeOperationActive = true;

    try {
      return await this.#runWithTemporaryApiCookies(operation);
    } finally {
      bridgeOperationActive = false;
    }
  }

  /**
   * Remove a previous bridge residue only when the exact non-secret ownership
   * marker is present. Without that marker, API-host cookies are untouched.
   *
   * @returns {Promise<void>}
   */
  async cleanupStaleCookies() {
    if (bridgeOperationActive) {
      throw new AuthCookieBusyError();
    }
    bridgeOperationActive = true;

    try {
      await this.#cleanupStaleCookiesUnlocked();
    } finally {
      bridgeOperationActive = false;
    }
  }

  /**
   * @template T
   * @param {() => T | Promise<T>} operation
   * @returns {Promise<T>}
   */
  async #runWithTemporaryApiCookies(operation) {
    await this.#cleanupStaleCookiesUnlocked();
    const source = await this.#readSourceCookies();
    const nowSeconds = this.#readNowSeconds();
    const authExpiration = temporaryExpiration(source.auth, nowSeconds);
    const twoFactorExpiration = source.twoFactorAuth === null
      ? null
      : temporaryExpiration(source.twoFactorAuth, nowSeconds);

    await this.#prepareEmptyTarget(source.storeId);
    await this.#installMarker(
      source.storeId,
      nowSeconds + TEMPORARY_COOKIE_LIFETIME_SECONDS + MARKER_GRACE_SECONDS
    );

    // Close the small inspect/set race without treating a newly-created cookie
    // as ours merely because our marker now exists.
    try {
      await this.#assertTargetEmpty(source.storeId);
    } catch (error) {
      try {
        await this.#removeMarkerOnly(source.storeId);
      } catch {
        throw new AuthCookieCleanupError();
      }
      throw sanitizeSetupError(error);
    }

    /** @type {Map<string, chrome.cookies.Cookie>} */
    const installedCookies = new Map();
    try {
      installedCookies.set(AUTH_COOKIE_NAME, await this.#installTemporaryCookie(
        source.auth,
        source.storeId,
        authExpiration
      ));
      if (source.twoFactorAuth !== null && twoFactorExpiration !== null) {
        installedCookies.set(
          TWO_FACTOR_COOKIE_NAME,
          await this.#installTemporaryCookie(
            source.twoFactorAuth,
            source.storeId,
            twoFactorExpiration
          )
        );
      }
    } catch (error) {
      try {
        await this.#cleanupCurrentCookies(source.storeId, installedCookies);
      } catch {
        throw new AuthCookieCleanupError();
      }
      throw sanitizeSetupError(error);
    }

    try {
      return await operation();
    } finally {
      await this.#cleanupCurrentCookies(source.storeId, installedCookies);
    }
  }

  /** @returns {Promise<void>} */
  async #cleanupStaleCookiesUnlocked() {
    const marker = await this.#readMarker(undefined, "cleanup");
    if (marker !== null) {
      await this.#cleanupStaleCookiesForStore(marker.storeId);
    }
  }

  /** @returns {Promise<SourceCookies>} */
  async #readSourceCookies() {
    /** @type {chrome.cookies.Cookie | null | undefined} */
    let auth;
    try {
      auth = await this.#cookies.get({
        url: SOURCE_AUTH_URL,
        name: AUTH_COOKIE_NAME
      });
    } catch {
      throw new AuthCookieSetupError();
    }
    if (auth === null || auth === undefined || auth.value.length === 0) {
      throw new AuthCookieRequiredError();
    }
    assertUnpartitioned(auth);
    assertUsableSourceCookie(auth, AUTH_COOKIE_NAME);

    /** @type {chrome.cookies.Cookie | null | undefined} */
    let twoFactorAuth;
    try {
      twoFactorAuth = await this.#cookies.get({
        url: SOURCE_AUTH_URL,
        name: TWO_FACTOR_COOKIE_NAME,
        storeId: auth.storeId
      });
    } catch {
      throw new AuthCookieSetupError();
    }
    if (twoFactorAuth === null || twoFactorAuth === undefined) {
      twoFactorAuth = null;
    } else {
      assertUnpartitioned(twoFactorAuth);
      assertUsableSourceCookie(twoFactorAuth, TWO_FACTOR_COOKIE_NAME);
      if (twoFactorAuth.storeId !== auth.storeId) {
        throw new AuthCookieSetupError();
      }
    }

    return {
      auth,
      twoFactorAuth,
      storeId: auth.storeId
    };
  }

  /** @returns {number} */
  #readNowSeconds() {
    const nowMilliseconds = this.#clock();
    if (!Number.isFinite(nowMilliseconds) || nowMilliseconds < 0) {
      throw new AuthCookieSetupError();
    }
    return Math.floor(nowMilliseconds / 1_000);
  }

  /** @param {string} storeId */
  async #prepareEmptyTarget(storeId) {
    const marker = await this.#readMarker(storeId, "setup");
    if (marker !== null) {
      try {
        await this.#cleanupStaleCookiesForStore(storeId);
      } catch (error) {
        if (error instanceof AuthCookieCleanupError) {
          throw error;
        }
        throw new AuthCookieCleanupError();
      }
    }
    await this.#assertTargetEmpty(storeId);
  }

  /** @param {string} storeId */
  async #assertTargetEmpty(storeId) {
    for (const name of BRIDGED_COOKIE_NAMES) {
      const cookies = await this.#readTargetCookies(name, storeId, "setup");
      if (cookies.length !== 0) {
        throw new AuthCookieConflictError();
      }
    }
  }

  /**
   * @param {string} storeId
   * @param {number} expirationDate
   */
  async #installMarker(storeId, expirationDate) {
    /** @type {chrome.cookies.Cookie | null | undefined} */
    let installed;
    try {
      installed = await this.#cookies.set({
        url: BRIDGE_MARKER_URL,
        name: BRIDGE_MARKER_NAME,
        value: BRIDGE_MARKER_VALUE,
        path: BRIDGE_MARKER_PATH,
        secure: true,
        httpOnly: true,
        sameSite: "strict",
        expirationDate,
        storeId
      });
    } catch {
      try {
        await this.#cleanupStaleCookiesForStore(storeId);
      } catch {
        throw new AuthCookieCleanupError();
      }
      throw new AuthCookieSetupError();
    }
    if (installed === null || installed === undefined ||
        !isExactMarker(installed, storeId, expirationDate)) {
      try {
        await this.#cleanupStaleCookiesForStore(storeId);
      } catch {
        throw new AuthCookieCleanupError();
      }
      throw new AuthCookieSetupError();
    }
  }

  /**
   * @param {chrome.cookies.Cookie} source
   * @param {string} storeId
   * @param {number} expirationDate
   * @returns {Promise<chrome.cookies.Cookie>}
   */
  async #installTemporaryCookie(source, storeId, expirationDate) {
    /** @type {chrome.cookies.Cookie | null | undefined} */
    let installed;
    try {
      installed = await this.#cookies.set({
        url: TARGET_AUTH_URL,
        name: source.name,
        value: source.value,
        path: TARGET_COOKIE_PATH,
        secure: true,
        httpOnly: true,
        sameSite: "strict",
        expirationDate,
        storeId
      });
    } catch {
      throw new AuthCookieSetupError();
    }
    if (installed === null || installed === undefined ||
        !isExactTemporaryCookie(installed, source.name, source.value, storeId, expirationDate)) {
      throw new AuthCookieSetupError();
    }
    return installed;
  }

  /**
   * @param {string | undefined} storeId
   * @param {"setup" | "cleanup"} phase
   * @returns {Promise<chrome.cookies.Cookie | null>}
   */
  async #readMarker(storeId, phase) {
    const markers = await this.#readTargetCookies(
      BRIDGE_MARKER_NAME,
      storeId,
      phase
    );
    if (markers.length === 0) {
      return null;
    }
    if (markers.length !== 1) {
      throw phase === "cleanup"
        ? new AuthCookieCleanupError()
        : new AuthCookieConflictError();
    }
    const marker = markers[0];
    if (marker === undefined) {
      throw phaseError(phase);
    }
    assertUnpartitioned(marker);
    if (!isExactMarkerIdentity(marker, marker.storeId) ||
        (storeId !== undefined && marker.storeId !== storeId)) {
      throw phase === "cleanup"
        ? new AuthCookieCleanupError()
        : new AuthCookieConflictError();
    }
    return marker;
  }

  /**
   * @param {string} name
   * @param {string | undefined} storeId
   * @param {"setup" | "cleanup"} phase
   * @returns {Promise<chrome.cookies.Cookie[]>}
   */
  async #readTargetCookies(name, storeId, phase) {
    /** @type {chrome.cookies.Cookie[] | undefined} */
    let cookies;
    try {
      const details = storeId === undefined ? { name } : { name, storeId };
      cookies = await this.#cookies.getAll(details);
    } catch {
      throw phaseError(phase);
    }
    if (!Array.isArray(cookies)) {
      throw phaseError(phase);
    }
    for (const cookie of cookies) {
      if (cookie.name !== name ||
          (storeId !== undefined && cookie.storeId !== storeId)) {
        throw phaseError(phase);
      }
    }
    const targetCookies = cookies.filter(cookieTargetsApiHost);
    for (const cookie of targetCookies) {
      assertUnpartitioned(cookie);
    }
    return targetCookies;
  }

  /**
   * After a Service Worker restart, the copied values are no longer available
   * to prove ownership. Authentication cookies therefore expire naturally;
   * only an orphaned marker is removed after they are gone.
   *
   * @param {string} storeId
   */
  async #cleanupStaleCookiesForStore(storeId) {
    try {
      const marker = await this.#readMarker(storeId, "cleanup");
      if (marker === null) {
        return;
      }
      for (const name of BRIDGED_COOKIE_NAMES) {
        if ((await this.#readTargetCookies(name, storeId, "cleanup")).length !== 0) {
          throw new AuthCookieCleanupError();
        }
      }
      await this.#removeMarkerOnly(storeId);
    } catch (error) {
      if (error instanceof AuthCookieCleanupError) {
        throw error;
      }
      throw new AuthCookieCleanupError();
    }
  }

  /**
   * @param {string} storeId
   * @param {Map<string, chrome.cookies.Cookie>} installedCookies
   */
  async #cleanupCurrentCookies(storeId, installedCookies) {
    try {
      const marker = await this.#readMarker(storeId, "cleanup");
      if (marker === null) {
        throw new AuthCookieCleanupError();
      }

      /** @type {Map<string, chrome.cookies.Cookie[]>} */
      const currentCookies = new Map();
      for (const name of BRIDGED_COOKIE_NAMES) {
        const cookies = await this.#readTargetCookies(name, storeId, "cleanup");
        const expected = installedCookies.get(name);
        if (cookies.length > 1 ||
            (cookies.length === 1 &&
             (expected === undefined || !sameInstalledCookie(cookies[0], expected)))) {
          throw new AuthCookieCleanupError();
        }
        currentCookies.set(name, cookies);
      }

      for (const name of BRIDGED_COOKIE_NAMES) {
        if ((currentCookies.get(name) ?? []).length === 1) {
          const expected = installedCookies.get(name);
          const latest = await this.#readTargetCookies(name, storeId, "cleanup");
          if (latest.length !== 1 || expected === undefined ||
              !sameInstalledCookie(latest[0], expected)) {
            throw new AuthCookieCleanupError();
          }
          const removed = await this.#cookies.remove({
            url: TARGET_AUTH_URL,
            name,
            storeId
          });
          if (removed === null || removed === undefined ||
              removed.name !== name || removed.storeId !== storeId) {
            throw new AuthCookieCleanupError();
          }
        }
      }

      for (const name of BRIDGED_COOKIE_NAMES) {
        if ((await this.#readTargetCookies(name, storeId, "cleanup")).length !== 0) {
          throw new AuthCookieCleanupError();
        }
      }
      await this.#removeMarkerOnly(storeId);
    } catch (error) {
      if (error instanceof AuthCookieCleanupError) {
        throw error;
      }
      throw new AuthCookieCleanupError();
    }
  }

  /** @param {string} storeId */
  async #removeMarkerOnly(storeId) {
    const marker = await this.#readMarker(storeId, "cleanup");
    if (marker === null) {
      throw new AuthCookieCleanupError();
    }
    const removed = await this.#cookies.remove({
      url: BRIDGE_MARKER_URL,
      name: BRIDGE_MARKER_NAME,
      storeId
    });
    if (removed === null || removed === undefined ||
        removed.name !== BRIDGE_MARKER_NAME || removed.storeId !== storeId) {
      throw new AuthCookieCleanupError();
    }
    const remaining = await this.#readMarker(storeId, "cleanup");
    if (remaining !== null) {
      throw new AuthCookieCleanupError();
    }
  }
}

/** @param {chrome.cookies.Cookie} cookie */
function assertUnpartitioned(cookie) {
  if (cookie.partitionKey !== undefined) {
    throw new AuthCookiePartitionedError();
  }
}

/**
 * @param {chrome.cookies.Cookie} cookie
 * @param {string} expectedName
 */
function assertUsableSourceCookie(cookie, expectedName) {
  if (cookie.name !== expectedName || cookie.value.length === 0 ||
      cookie.storeId.length === 0 ||
      (cookie.expirationDate !== undefined &&
       (!Number.isFinite(cookie.expirationDate) || cookie.expirationDate <= 0))) {
    throw new AuthCookieSetupError();
  }
}

/**
 * @param {chrome.cookies.Cookie} cookie
 * @param {number} nowSeconds
 */
function temporaryExpiration(cookie, nowSeconds) {
  const maximum = nowSeconds + TEMPORARY_COOKIE_LIFETIME_SECONDS;
  const candidate = cookie.expirationDate === undefined
    ? maximum
    : Math.min(cookie.expirationDate, maximum);
  const expiration = Math.floor(candidate);
  if (!Number.isFinite(expiration) || expiration <= nowSeconds) {
    throw new AuthCookieSetupError();
  }
  return expiration;
}

/**
 * @param {chrome.cookies.Cookie} cookie
 * @param {string} storeId
 * @param {number} expirationDate
 */
function isExactMarker(cookie, storeId, expirationDate) {
  return isExactMarkerIdentity(cookie, storeId) &&
    cookie.expirationDate === expirationDate;
}

/**
 * @param {chrome.cookies.Cookie} cookie
 * @param {string} storeId
 */
function isExactMarkerIdentity(cookie, storeId) {
  return cookie.name === BRIDGE_MARKER_NAME &&
    cookie.value === BRIDGE_MARKER_VALUE &&
    cookie.domain === TARGET_HOST &&
    cookie.hostOnly === true &&
    cookie.path === BRIDGE_MARKER_PATH &&
    cookie.secure === true &&
    cookie.httpOnly === true &&
    cookie.sameSite === "strict" &&
    cookie.storeId === storeId &&
    cookie.partitionKey === undefined;
}

/**
 * @param {chrome.cookies.Cookie} cookie
 * @param {string} name
 * @param {string} value
 * @param {string} storeId
 * @param {number} expirationDate
 */
function isExactTemporaryCookie(cookie, name, value, storeId, expirationDate) {
  return isOwnedTemporaryCookie(cookie, name, storeId) &&
    cookie.value === value &&
    cookie.expirationDate === expirationDate;
}

/**
 * @param {chrome.cookies.Cookie | undefined} current
 * @param {chrome.cookies.Cookie} expected
 */
function sameInstalledCookie(current, expected) {
  return current !== undefined &&
    expected.expirationDate !== undefined &&
    isExactTemporaryCookie(
      current,
      expected.name,
      expected.value,
      expected.storeId,
      expected.expirationDate
    );
}

/**
 * @param {chrome.cookies.Cookie} cookie
 * @param {string} name
 * @param {string} storeId
 */
function isOwnedTemporaryCookie(cookie, name, storeId) {
  return cookie.name === name &&
    cookie.domain === TARGET_HOST &&
    cookie.hostOnly === true &&
    cookie.path === TARGET_COOKIE_PATH &&
    cookie.secure === true &&
    cookie.httpOnly === true &&
    cookie.sameSite === "strict" &&
    cookie.storeId === storeId &&
    cookie.partitionKey === undefined;
}

/** @param {chrome.cookies.Cookie} cookie */
function cookieTargetsApiHost(cookie) {
  const domain = cookie.domain.replace(/^\./u, "").toLowerCase();
  if (cookie.hostOnly) {
    return domain === TARGET_HOST;
  }
  return domain === TARGET_HOST || TARGET_HOST.endsWith(`.${domain}`);
}

/** @param {"setup" | "cleanup"} phase */
function phaseError(phase) {
  return phase === "cleanup"
    ? new AuthCookieCleanupError()
    : new AuthCookieSetupError();
}

/** @param {unknown} error */
function sanitizeSetupError(error) {
  if (error instanceof AuthCookieConflictError ||
      error instanceof AuthCookiePartitionedError ||
      error instanceof AuthCookieCleanupError) {
    return error;
  }
  return new AuthCookieSetupError();
}
