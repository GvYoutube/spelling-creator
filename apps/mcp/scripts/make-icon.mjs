// Generates apps/mcp/icon.png — a simple, dependency-free brand mark: a white
// "lesson sheet" on the Spelling Creator teal (#0c8599, the spelling-block
// colour from apps/web/src/lib/spelling.js). Run with: node scripts/make-icon.mjs
//
// Hand-rolls a PNG (8-bit RGBA) so the build needs no image library.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 512;
const S = SIZE / 256; // design grid is 256; scale up for crisp display at 512.
const TEAL = [12, 133, 153];
const TEAL_SOFT = [120, 190, 202];
const WHITE = [255, 255, 255];

const px = new Uint8Array(SIZE * SIZE * 4);

function set(x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = 255;
}

// Coordinates are given on a 256-unit design grid and scaled to SIZE.
function rect(x0, y0, x1, y1, color) {
  for (let y = Math.round(y0 * S); y < Math.round(y1 * S); y++)
    for (let x = Math.round(x0 * S); x < Math.round(x1 * S); x++)
      set(x, y, color);
}

// Teal background.
rect(0, 0, SIZE, SIZE, TEAL);
// White lesson sheet.
rect(56, 40, 200, 216, WHITE);
// Title bar.
rect(72, 64, 184, 88, TEAL);
// Body "text" lines (alternating full / short to read as a worksheet).
const lines = [
  [72, 184],
  [72, 160],
  [72, 184],
  [72, 152],
  [72, 176],
];
lines.forEach(([x0, x1], i) =>
  rect(x0, 112 + i * 22, x1, 112 + i * 22 + 12, TEAL_SOFT),
);

// --- PNG encoding -----------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
// 10..12 = compression/filter/interlace = 0

// Raw scanlines, each prefixed with filter byte 0.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  px.subarray(y * SIZE * 4, (y + 1) * SIZE * 4).forEach((v, i) => {
    raw[y * (SIZE * 4 + 1) + 1 + i] = v;
  });
}

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "icon.png");
writeFileSync(out, png);
console.log(`Wrote ${out} (${png.length} bytes)`);
