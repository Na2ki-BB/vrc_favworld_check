// @ts-check

import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "extension", "icons");
const sourceSize = 768;
const sizes = [16, 32, 48, 128];

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** @param {number} x @param {number} y */
function insideRoundedSquare(x, y) {
  const half = 0.46;
  const radius = 0.16;
  const dx = Math.max(Math.abs(x - 0.5) - (half - radius), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (half - radius), 0);
  return (dx * dx) + (dy * dy) <= radius * radius;
}

/** @param {number} x @param {number} y */
function insideHeart(x, y) {
  const u = (x - 0.72) / 0.145;
  const v = -(y - 0.70) / 0.145;
  const base = (u * u) + (v * v) - 1;
  return (base * base * base) - (u * u * v * v * v) <= 0;
}

/** @param {number} value @param {number} center @param {number} width */
function lineCoverage(value, center, width) {
  return clamp(1 - (Math.abs(value - center) / width), 0, 1);
}

/** @param {Uint8Array} pixels @param {number} index @param {[number, number, number]} color @param {number} alpha */
function blend(pixels, index, color, alpha) {
  const sourceAlpha = clamp(alpha, 0, 1);
  const existingAlpha = (pixels[index + 3] ?? 0) / 255;
  const outputAlpha = sourceAlpha + (existingAlpha * (1 - sourceAlpha));
  if (outputAlpha <= 0) {
    return;
  }
  for (let channel = 0; channel < 3; channel += 1) {
    const existing = (pixels[index + channel] ?? 0) / 255;
    const incoming = (color[channel] ?? 0) / 255;
    const output = ((incoming * sourceAlpha) + (existing * existingAlpha * (1 - sourceAlpha))) / outputAlpha;
    pixels[index + channel] = Math.round(output * 255);
  }
  pixels[index + 3] = Math.round(outputAlpha * 255);
}

function renderSource() {
  const pixels = new Uint8Array(sourceSize * sourceSize * 4);
  const globeX = 0.43;
  const globeY = 0.43;
  const globeRadius = 0.275;

  for (let py = 0; py < sourceSize; py += 1) {
    for (let px = 0; px < sourceSize; px += 1) {
      const x = (px + 0.5) / sourceSize;
      const y = (py + 0.5) / sourceSize;
      if (!insideRoundedSquare(x, y)) {
        continue;
      }
      const index = ((py * sourceSize) + px) * 4;
      const glow = clamp(1 - Math.hypot(x - 0.22, y - 0.15), 0, 1);
      blend(pixels, index, [27 + (22 * glow), 28 + (18 * glow), 67 + (31 * glow)], 1);

      const dx = x - globeX;
      const dy = y - globeY;
      const distance = Math.hypot(dx, dy);
      const outline = lineCoverage(distance, globeRadius, 0.015);
      if (outline > 0) {
        blend(pixels, index, [91, 222, 205], outline);
      }
      if (distance <= globeRadius + 0.01) {
        const horizontal = lineCoverage(y, globeY, 0.011);
        const verticalEllipse = lineCoverage(
          ((dx * dx) / (0.115 * 0.115)) + ((dy * dy) / (globeRadius * globeRadius)),
          1,
          0.085
        );
        const upperLatitude = lineCoverage(
          ((dx * dx) / (globeRadius * globeRadius)) + (((dy + 0.105) * (dy + 0.105)) / (0.075 * 0.075)),
          1,
          0.09
        );
        const lowerLatitude = lineCoverage(
          ((dx * dx) / (globeRadius * globeRadius)) + (((dy - 0.105) * (dy - 0.105)) / (0.075 * 0.075)),
          1,
          0.09
        );
        const grid = Math.max(horizontal, verticalEllipse, upperLatitude, lowerLatitude) * 0.72;
        if (grid > 0) {
          blend(pixels, index, [91, 222, 205], grid);
        }
      }

      if (insideHeart(x, y)) {
        blend(pixels, index, [255, 132, 106], 1);
      }
    }
  }
  return pixels;
}

/** @param {Uint8Array} source @param {number} size */
function downsample(source, size) {
  const factor = sourceSize / size;
  if (!Number.isInteger(factor)) {
    throw new Error(`unsupported icon size: ${size}`);
  }
  const output = new Uint8Array(size * size * 4);
  const samples = factor * factor;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      /** @type {[number, number, number, number]} */
      const totals = [0, 0, 0, 0];
      for (let sy = 0; sy < factor; sy += 1) {
        for (let sx = 0; sx < factor; sx += 1) {
          const sourceX = (x * factor) + sx;
          const sourceY = (y * factor) + sy;
          const sourceIndex = ((sourceY * sourceSize) + sourceX) * 4;
          for (let channel = 0; channel < 4; channel += 1) {
            totals[channel] = (totals[channel] ?? 0) + (source[sourceIndex + channel] ?? 0);
          }
        }
      }
      const outputIndex = ((y * size) + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        output[outputIndex + channel] = Math.round((totals[channel] ?? 0) / samples);
      }
    }
  }
  return output;
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  crcTable[n] = value >>> 0;
}

/** @param {Uint8Array} data */
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    const tableIndex = (crc ^ byte) & 0xff;
    crc = ((crcTable[tableIndex] ?? 0) ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** @param {string} type @param {Uint8Array} data */
function chunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const output = new Uint8Array(12 + data.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.length);
  output.set(typeBytes, 4);
  output.set(data, 8);
  const checksumInput = new Uint8Array(typeBytes.length + data.length);
  checksumInput.set(typeBytes);
  checksumInput.set(data, typeBytes.length);
  view.setUint32(8 + data.length, crc32(checksumInput));
  return output;
}

/** @param {Uint8Array[]} parts */
function concatenate(parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/** @param {number} size @param {Uint8Array} pixels */
function encodePng(size, pixels) {
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, size);
  headerView.setUint32(4, size);
  header[8] = 8;
  header[9] = 6;

  const rows = new Uint8Array((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * (size * 4 + 1);
    rows[rowOffset] = 0;
    rows.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), rowOffset + 1);
  }

  return concatenate([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(rows, { level: 9 }))),
    chunk("IEND", new Uint8Array())
  ]);
}

await mkdir(outputDir, { recursive: true });
const source = renderSource();
for (const size of sizes) {
  const filePath = path.join(outputDir, `icon${size}.png`);
  await writeFile(filePath, encodePng(size, downsample(source, size)));
  console.log(`Generated ${path.relative(root, filePath)}`);
}
