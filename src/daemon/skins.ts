import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { ResolvedSkin, Skin, SkinPalette } from '../shared/protocol.js';
import { paths } from './paths.js';

const TOKENS: (keyof SkinPalette)[] = [
  'bg', 'bgAlt', 'surface', 'border', 'fg', 'fgMuted',
  'accent', 'accentAlt', 'positive', 'warning', 'danger', 'info',
];

// AESTHETIC.md §2.4: contrast is computed, not assumed. Text tokens are
// lifted toward readability against the skin's own canvas before any
// client paints them. Floors: fg 4.5:1 (WCAG AA), fgMuted/accent 3:1.
const FLOORS: Partial<Record<keyof SkinPalette, number>> = { fg: 4.5, fgMuted: 3, accent: 3, accentAlt: 3 };

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map(c => Math.round(c).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function luminance(hex: string): number {
  const lin = hexToRgb(hex).map(c => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

function mix(hex: string, toward: [number, number, number], amount: number): string {
  const c = hexToRgb(hex);
  return rgbToHex([0, 1, 2].map(i => c[i] + (toward[i] - c[i]) * amount) as [number, number, number]);
}

function lift(color: string, bg: string, floor: number): string {
  const toward: [number, number, number] = luminance(bg) < 0.5 ? [255, 255, 255] : [0, 0, 0];
  let out = color;
  for (let i = 0; i < 12 && contrast(out, bg) < floor; i++) out = mix(out, toward, 0.12);
  return out;
}

function resolve(skin: Skin): ResolvedSkin {
  const palette = { ...skin.palette };
  const lifted: string[] = [];
  for (const [token, floor] of Object.entries(FLOORS) as [keyof SkinPalette, number][]) {
    const adjusted = lift(palette[token], palette.bg, floor);
    if (adjusted !== palette[token]) {
      palette[token] = adjusted;
      lifted.push(token);
    }
  }
  const fgOnAccent = contrast('#000000', palette.accent) >= contrast('#FFFFFF', palette.accent)
    ? '#000000' : '#FFFFFF';
  return { ...skin, palette, resolved: { fgOnAccent, contrastLifted: lifted } };
}

function parseSkin(file: string, raw: string): Skin {
  const doc = parse(raw) as Record<string, unknown>;
  const palette = doc.palette as Record<string, string> | undefined;
  for (const t of TOKENS) {
    if (!palette?.[t] || !/^#[0-9A-Fa-f]{6}$/.test(palette[t])) {
      throw new Error(`skin ${file}: missing or malformed token "${t}"`);
    }
  }
  if (doc.polarity !== 'dark' && doc.polarity !== 'light') {
    throw new Error(`skin ${file}: polarity must be dark|light`);
  }
  return {
    name: String(doc.name ?? file.replace(/\.yaml$/, '')),
    label: String(doc.label ?? doc.name),
    polarity: doc.polarity,
    palette: palette as unknown as SkinPalette,
    verbs: Array.isArray(doc.verbs) ? doc.verbs.map(String) : undefined,
  };
}

/** Built-in skins/ → user ~/.hephaestus/skins/ (same name overrides). */
export function loadSkins(): Map<string, ResolvedSkin> {
  const builtin = fileURLToPath(new URL('../../skins', import.meta.url));
  const skins = new Map<string, ResolvedSkin>();
  for (const dir of [builtin, paths.skins]) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter(f => f.endsWith('.yaml'))) {
      try {
        const skin = parseSkin(file, readFileSync(join(dir, file), 'utf8'));
        skins.set(skin.name, resolve(skin));
      } catch (err) {
        console.error(`[skins] skipping ${file}: ${(err as Error).message}`);
      }
    }
  }
  return skins;
}
