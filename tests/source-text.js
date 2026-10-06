// @ts-check

import { readFile as readNodeFile } from "node:fs/promises";

/** @param {string} source */
export function normalizeSourceText(source) {
  return source.replace(/\r\n?/gu, "\n");
}

/**
 * @param {import("node:fs").PathLike | import("node:url").URL} path
 * @param {BufferEncoding} [encoding]
 */
export async function readFile(path, encoding = "utf8") {
  return normalizeSourceText(await readNodeFile(path, encoding));
}
