import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { plateColor, renderRGBA, toPNG } from './icon-art.mjs';

// Launcher icons for the Android app, from the same mark as the desktop one.
//
// An adaptive icon is two layers on a 108dp canvas that the launcher masks to
// whatever shape it likes and parallaxes apart. Only the middle 72dp is guaranteed
// visible, so the face is drawn at 72/108 and the plate fills the whole canvas —
// which is why these are rendered separately rather than sliced out of icon.png.

const RES = join('android', 'app', 'src', 'main', 'res');
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const ADAPTIVE_DP = 108;
const LEGACY_DP = 48;
const SAFE = 72 / 108; // the guaranteed-visible circle of the adaptive canvas

for (const [density, factor] of Object.entries(DENSITIES)) {
  const dir = join(RES, `mipmap-${density}`);
  mkdirSync(dir, { recursive: true });
  const adaptive = Math.round(ADAPTIVE_DP * factor);
  const legacy = Math.round(LEGACY_DP * factor);
  writeFileSync(join(dir, 'ic_launcher_background.png'), toPNG(adaptive, renderRGBA(adaptive, { layers: 'plate', scale: 1.45 })));
  writeFileSync(join(dir, 'ic_launcher_foreground.png'), toPNG(adaptive, renderRGBA(adaptive, { layers: 'face', scale: SAFE })));
  // The legacy square, for launchers and dialogs that never adopted adaptive icons.
  writeFileSync(join(dir, 'ic_launcher.png'), toPNG(legacy, renderRGBA(legacy)));
}

const anydpi = join(RES, 'mipmap-anydpi-v26');
mkdirSync(anydpi, { recursive: true });
const xml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
writeFileSync(join(anydpi, 'ic_launcher.xml'), xml);
writeFileSync(join(anydpi, 'ic_launcher_round.xml'), xml);

// The splash window's background, so the app does not flash white before Compose paints.
const values = join(RES, 'values');
mkdirSync(values, { recursive: true });
writeFileSync(
  join(values, 'ic_launcher_colors.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${plateColor(0.5)}</color>\n</resources>\n`,
);

console.log(`launcher icons written to ${RES}`);
