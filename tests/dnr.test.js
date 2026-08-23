// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  API_RULE_URL_FILTER,
  PROJECT_URL,
  USER_AGENT_RULE_ID,
  createUserAgentRule,
  installUserAgentRule
} from "../extension/lib/dnr.js";

const RUNTIME_ID = "abcdefghijklmnopabcdefghijklmnop";

test("User-Agent rule is limited to extension-originated VRChat API GET XHR", () => {
  assert.equal(API_RULE_URL_FILTER, "|https://api.vrchat.cloud/api/1/");
  const rule = createUserAgentRule({ runtimeId: RUNTIME_ID, version: "1.2.3" });

  assert.equal(rule.id, USER_AGENT_RULE_ID);
  assert.deepEqual(rule.action, {
    type: "modifyHeaders",
    requestHeaders: [{
      header: "user-agent",
      operation: "set",
      value: `vrc_favworld_check/1.2.3 ${PROJECT_URL}`
    }]
  });
  assert.deepEqual(rule.condition, {
    urlFilter: API_RULE_URL_FILTER,
    requestDomains: ["api.vrchat.cloud"],
    initiatorDomains: [RUNTIME_ID],
    resourceTypes: ["xmlhttprequest"],
    requestMethods: ["get"]
  });
});

test("rule installation replaces only its owned fixed rule ID", async () => {
  /** @type {chrome.declarativeNetRequest.UpdateRuleOptions[]} */
  const observed = [];
  /** @type {chrome.declarativeNetRequest.Rule[]} */
  let installed = [];
  await installUserAgentRule({
    runtimeId: RUNTIME_ID,
    version: "0.1.7",
    updateDynamicRules: async (update) => {
      observed.push(update);
      installed = update.addRules ?? [];
    },
    getDynamicRules: async () => installed
  });

  const update = observed[0];
  assert.ok(update);
  assert.deepEqual(update.removeRuleIds, [USER_AGENT_RULE_ID]);
  assert.equal(update.addRules?.length, 1);
  assert.equal(update.addRules?.[0]?.id, USER_AGENT_RULE_ID);
});

test("rule installation fails closed when Chrome does not retain the exact rule", async () => {
  await assert.rejects(
    installUserAgentRule({
      runtimeId: RUNTIME_ID,
      version: "0.1.7",
      updateDynamicRules: async () => {},
      getDynamicRules: async () => []
    }),
    /verification/u
  );
});

test("rule verification rejects a broadened retained condition", async () => {
  /** @type {chrome.declarativeNetRequest.Rule[]} */
  let installed = [];
  await assert.rejects(
    installUserAgentRule({
      runtimeId: RUNTIME_ID,
      version: "0.1.7",
      updateDynamicRules: async (update) => {
        const intended = update.addRules?.[0];
        assert.ok(intended);
        installed = [{
          ...intended,
          condition: { ...intended.condition, requestMethods: undefined }
        }];
      },
      getDynamicRules: async () => installed
    }),
    /verification/u
  );
});

test("rule builder rejects values that could broaden or corrupt the rule", () => {
  assert.throws(
    () => createUserAgentRule({ runtimeId: "not-an-extension", version: "1.0.0" }),
    /runtimeId/u
  );
  assert.throws(
    () => createUserAgentRule({ runtimeId: RUNTIME_ID, version: "1.0.0 bad" }),
    /version/u
  );
});
