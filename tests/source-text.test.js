// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSourceText } from "./source-text.js";

test("source extraction uses the same delimiters for LF, CRLF, and CR input", () => {
  const expected = "function example() {\n}\nnext";
  assert.equal(normalizeSourceText(expected), expected);
  assert.equal(normalizeSourceText("function example() {\r\n}\r\nnext"), expected);
  assert.equal(normalizeSourceText("function example() {\r}\rnext"), expected);
  assert.ok(normalizeSourceText("function example() {\r\n}\r\nnext").includes("\n}\n"));
});
