import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderRGBA, toPNG } from './icon-art.mjs';

// Writes build/icon.ico and build/icon.png from the shared mark in icon-art.mjs.
// PNG-in-ICO, which Windows has supported since Vista — no image library needed.

const SIZES = [16, 24, 32, 48, 64, 128, 256];

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
