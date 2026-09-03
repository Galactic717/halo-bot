import { deflateSync } from 'node:zlib';

// The Halo mark, as signed distance fields in normalised units (0..1 across the
// icon), so one set of numbers renders every size on every platform. Sampled 3x3
// per pixel: antialiasing without a rasteriser dependency.
//
// Shared by scripts/make-icon.mjs (Windows .ico/.png) and
// scripts/make-android-icons.mjs (adaptive launcher icons).

export const CORNER = 0.225; // rounded-square radius
const PLATE_TOP = [54, 54, 54];
const PLATE_BOTTOM = [27, 27, 27];
const FACE_DIM = [159, 159, 159]; // bottom-left of the blob
const FACE_LIT = [240, 240, 240]; // top-right of the blob
const INK = [32, 32, 34]; // the eyes

// Blob = two circles fused with a smooth minimum, so the join reads as one
// organic body rather than a snowman.
const BLOB = [
  { x: 0.415, y: 0.455, r: 0.295 },
  { x: 0.515, y: 0.735, r: 0.475 },
];
const BLOB_FUSE = 0.18;

// Both eyes lean the same way; the left one is shorter and fatter.
const EYE_ANGLE = (55 * Math.PI) / 180;
const EYES = [
  { x: 0.483, y: 0.555, len: 0.080, r: 0.071 },
  { x: 0.750, y: 0.431, len: 0.096, r: 0.050 },
];

const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerpColor = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

/** Rounded square centred on (0.5, 0.5), half-extent 0.5. */
function sdRoundedSquare(x, y, radius) {
  const dx = Math.abs(x - 0.5) - (0.5 - radius);
  const dy = Math.abs(y - 0.5) - (0.5 - radius);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Polynomial smooth minimum — fuses two fields over a band of width k. */
function smoothMin(a, b, k) {
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return mix(b, a, h) - k * h * (1 - h);
}

function sdBlob(x, y) {
  const d = BLOB.map((c) => Math.hypot(x - c.x, y - c.y) - c.r);
  return d.reduce((acc, v) => smoothMin(acc, v, BLOB_FUSE));
}

/** Capsule: distance to a segment through (x, y) at EYE_ANGLE, minus radius. */
function sdEye(x, y, eye) {
  const ux = Math.cos(EYE_ANGLE);
  const uy = Math.sin(EYE_ANGLE);
  const px = x - eye.x;
  const py = y - eye.y;
  const t = Math.max(-eye.len, Math.min(eye.len, px * ux + py * uy));
  return Math.hypot(px - ux * t, py - uy * t) - eye.r;
}

/** The plate's vertical gradient at v, as a CSS-ish hex string. */
export function plateColor(v = 0.5) {
  const [r, g, b] = lerpColor(PLATE_TOP, PLATE_BOTTOM, v);
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * One frame of the mark as raw RGBA.
 *
 * `layers` picks what is drawn: 'all' is the full icon, 'plate' is the background
 * without the face, 'face' is the blob and eyes on transparency. Android's adaptive
 * icon wants the last two separately, because the system animates them apart.
 * `scale` shrinks the art inside the canvas, which is how the face lands inside the
 * 66% safe zone of a 108dp foreground.
 */
export function renderRGBA(size, { layers = 'all', scale = 1 } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const step = 1 / size;
  const SS = 3; // 3x3 supersampling
  const offsets = [];
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) offsets.push([(sx + 0.5) / SS, (sy + 0.5) / SS]);
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [ox, oy] of offsets) {
        // Art space: the canvas, re-centred and shrunk by `scale`.
        const u = ((x + ox) * step - 0.5) / scale + 0.5;
        const v = ((y + oy) * step - 0.5) / scale + 0.5;
        const onPlate = sdRoundedSquare(u, v, CORNER) <= 0;
        const onFace = sdBlob(u, v) <= 0;

        let color = null;
        if (layers === 'face') {
          if (onFace) color = faceColor(u, v);
        } else if (onPlate) {
          color = layers === 'plate' || !onFace ? lerpColor(PLATE_TOP, PLATE_BOTTOM, v) : faceColor(u, v);
        }
        if (!color) continue;
        a += 1;
        r += color[0];
        g += color[1];
        b += color[2];
      }
      if (a === 0) continue;
      const i = (y * size + x) * 4;
      px[i] = Math.round(r / a);
      px[i + 1] = Math.round(g / a);
      px[i + 2] = Math.round(b / a);
      px[i + 3] = Math.round((255 * a) / offsets.length);
    }
  }
  return px;
}

/** Light falls from the top right, so the blob dims toward bottom left. */
function faceColor(u, v) {
  if (EYES.some((eye) => sdEye(u, v, eye) <= 0)) return INK;
  const t = clamp01(0.5 + 0.62 * (u - 0.5) - 0.55 * (v - 0.5));
  return lerpColor(FACE_DIM, FACE_LIT, t);
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

export function toPNG(size, rgba) {
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
