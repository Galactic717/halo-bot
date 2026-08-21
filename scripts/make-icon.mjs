import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Draws the Halo mark (accent disc + two eyes) and writes build/icon.ico.
// PNG-in-ICO, which Windows has supported since Vista — no image library needed.

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const ACCENT = [16, 132, 254];
const INK = [13, 13, 13];

function renderRGBA(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size / 2;
  const eyeR = size * 0.075;
  const eyeH = size * 0.105;
  const eyeY = c - size * 0.06;
  const eyeDX = size * 0.125;

  const blend = (i, color, alpha) => {
    px[i] = Math.round(px[i] * (1 - alpha) + color[0] * alpha);
    px[i + 1] = Math.round(px[i + 1] * (1 - alpha) + color[1] * alpha);
    px[i + 2] = Math.round(px[i + 2] * (1 - alpha) + color[2] * alpha);
    px[i + 3] = Math.max(px[i + 3], Math.round(255 * alpha));
  };

  const coverage = (d, edge) => Math.max(0, Math.min(1, edge - d + 0.5));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const disc = coverage(Math.hypot(x - c, y - c), r - 0.5);
      if (disc > 0) blend(i, ACCENT, disc);
      for (const dx of [-eyeDX, eyeDX]) {
        const ex = (x - (c + dx)) / eyeR;
        const ey = (y - eyeY) / eyeH;
        const eye = coverage(Math.hypot(ex, ey) * eyeR, eyeR - 0.5);
        if (eye > 0) blend(i, INK, eye);
      }
    }
  }
  return px;
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function toPNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const pngs = SIZES.map((size) => ({ size, data: toPNG(size, renderRGBA(size)) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(pngs.length, 4);

let offset = 6 + pngs.length * 16;
const entries = [];
for (const { size, data } of pngs) {
  const e = Buffer.alloc(16);
  e[0] = size >= 256 ? 0 : size;
  e[1] = size >= 256 ? 0 : size;
  e[4] = 1; // color planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += data.length;
}

mkdirSync('build', { recursive: true });
writeFileSync(join('build', 'icon.ico'), Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]));
writeFileSync(join('build', 'icon.png'), pngs.at(-1).data);
console.log(`build/icon.ico (${SIZES.join(', ')}px) and build/icon.png written`);
