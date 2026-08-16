// @ts-check

export const USER_AGENT_RULE_ID = 61001;
export const API_RULE_URL_FILTER = "|https://api.vrchat.cloud/api/1/";
export const PROJECT_URL = "https://github.com/Na2ki-BB/vrc_favworld_check";

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:\.\d+)?$/u;

/**
 * Build the single narrowly-scoped rule owned by this extension. The caller
 * supplies runtime values so tests never need a real Chrome profile.
 *
 * @param {{ runtimeId: string, version: string }} input
 * @returns {chrome.declarativeNetRequest.Rule}
 */
export function createUserAgentRule(input) {
  if (!EXTENSION_ID_PATTERN.test(input.runtimeId)) {
    throw new TypeError("runtimeId is not a Chrome extension ID");
  }
  if (!VERSION_PATTERN.test(input.version)) {
    throw new TypeError("version is not a manifest version");
  }

  return {
    id: USER_AGENT_RULE_ID,
    priority: 1,
    action: {
      type: /** @type {chrome.declarativeNetRequest.RuleActionType} */ ("modifyHeaders"),
      requestHeaders: [{
        header: "user-agent",
        operation: /** @type {chrome.declarativeNetRequest.HeaderOperation} */ ("set"),
        value: `vrc_favworld_check/${input.version} ${PROJECT_URL}`
      }]
    },
    condition: {
      urlFilter: API_RULE_URL_FILTER,
      requestDomains: ["api.vrchat.cloud"],
      initiatorDomains: [input.runtimeId],
      resourceTypes: [
        /** @type {chrome.declarativeNetRequest.ResourceType} */ ("xmlhttprequest")
      ],
      requestMethods: [
        /** @type {chrome.declarativeNetRequest.RequestMethod} */ ("get")
      ]
    }
  };
}

/**
 * Replace only this product's fixed dynamic rule ID. Dynamic rules belonging
 * to any other extension component are left untouched.
 *
 * @param {{
 *   runtimeId: string,
 *   version: string,
 *   updateDynamicRules(update: chrome.declarativeNetRequest.UpdateRuleOptions): Promise<void>,
 *   getDynamicRules(): Promise<chrome.declarativeNetRequest.Rule[]>
 * }} input
 * @returns {Promise<void>}
 */
export async function installUserAgentRule(input) {
  const rule = createUserAgentRule({
    runtimeId: input.runtimeId,
    version: input.version
  });
  await input.updateDynamicRules({
    removeRuleIds: [USER_AGENT_RULE_ID],
    addRules: [rule]
  });
  const installedRules = await input.getDynamicRules();
  const ownedRules = installedRules.filter((candidate) => candidate.id === USER_AGENT_RULE_ID);
  if (ownedRules.length !== 1 || !sameRule(ownedRules[0], rule)) {
    throw new Error("User-Agent security rule verification failed");
  }
}

/**
 * Compare the complete rule without trusting object insertion order.
 *
 * @param {unknown} left
 * @param {unknown} right
 */
function sameRule(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

/** @param {unknown} value @returns {string} */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  const entries = Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ));
  return `{${entries.join(",")}}`;
}
