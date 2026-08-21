import { BRAND_ICONS } from './brandIcons';

/**
 * A plugin's tile. Brands simple-icons still carries get their real mark on a tinted square;
 * everything else gets a monogram in a colour derived from the name, so the shelves never show
 * a row of identical grey boxes.
 */
export function PluginIcon({ name, icon, size = 40 }: { name: string; icon?: string; size?: number }) {
  const brand = icon ? BRAND_ICONS[icon] : undefined;
  const radius = Math.round(size * 0.22);

  if (brand) {
    const glyph = Math.round(size * 0.55);
    return (
      <span
        className="plugin-icon"
        style={{ width: size, height: size, borderRadius: radius, background: tint(brand.hex) }}
        aria-hidden
      >
        <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill={readable(brand.hex)}>
          <path d={brand.path} />
        </svg>
      </span>
    );
  }

  const hue = hash(name) % 360;
  return (
    <span
      className="plugin-icon"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: `hsl(${hue} 42% 22%)`,
        color: `hsl(${hue} 70% 78%)`,
        fontSize: Math.round(size * 0.4),
      }}
      aria-hidden
    >
      {monogram(name)}
    </span>
  );
}

function monogram(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  const first = words[0]?.[0] ?? '?';
  const second = words.length > 1 ? words[1]![0] ?? '' : '';
  return `${first}${second}`.toUpperCase();
}

/** A brand colour is made for white backgrounds; behind a mark on a dark tile it needs damping. */
function tint(hex: string): string {
  return `color-mix(in srgb, ${hex} 22%, transparent)`;
}

/** Near-black marks (GitHub, Notion, Vercel) disappear on a dark tile, so they are lifted. */
function readable(hex: string): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.35 ? 'var(--text-primary)' : hex;
}

function hash(value: string): number {
  let out = 0;
  for (let i = 0; i < value.length; i++) out = (out * 31 + value.charCodeAt(i)) >>> 0;
  return out;
}
