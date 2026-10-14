/**
 * Small numeric + colour primitives shared by every scene.
 * Pure functions only — no DOM, no globals — so they can be unit tested.
 */

export const clamp = (v: number, min = 0, max = 1): number =>
  v < min ? min : v > max ? max : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const invLerp = (a: number, b: number, v: number): number =>
  a === b ? 0 : (v - a) / (b - a);

export const mapRange = (
  v: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number => lerp(outMin, outMax, clamp(invLerp(inMin, inMax, v)));

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp(invLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
};

export const smootherstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp(invLerp(edge0, edge1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeOutQuint = (t: number): number => 1 - Math.pow(1 - t, 5);
export const easeInOutQuart = (t: number): number =>
  t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;

/**
 * Frame-rate independent exponential smoothing.
 * `lambda` is roughly "how many e-foldings per second" — higher = snappier.
 * `dt` is clamped so a long stall (backgrounded tab, slow paint) cannot make
 * the scene jump.
 */
export const damp = (
  current: number,
  target: number,
  lambda: number,
  dt: number,
): number => lerp(current, target, 1 - Math.exp(-lambda * Math.min(dt, 0.1)));

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ colour */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

const toLinear = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

const toSrgb = (c: number): number => {
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return clamp(Math.round(s * 255), 0, 255);
};

/** Parses `#rgb`, `#rrggbb` or `#rrggbbaa` into an RGB triple. */
export const parseHex = (hex: string): RGB => {
  const raw = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(raw)) {
    throw new Error(`Invalid hex colour: ${hex}`);
  }
  let h = raw;
  if (h.length === 3 || h.length === 4) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (h.length !== 6 && h.length !== 8) {
    throw new Error(`Invalid hex colour: ${hex}`);
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
};

/**
 * Blends in linear-light space rather than sRGB, which keeps mid-tone
 * transitions from going muddy. Worth the extra math at these sizes.
 */
export const mixRGB = (a: RGB, b: RGB, t: number): RGB => {
  const k = clamp(t);
  return {
    r: toSrgb(lerp(toLinear(a.r), toLinear(b.r), k)),
    g: toSrgb(lerp(toLinear(a.g), toLinear(b.g), k)),
    b: toSrgb(lerp(toLinear(a.b), toLinear(b.b), k)),
  };
};

export const rgba = (c: RGB, alpha = 1): string =>
  `rgba(${c.r},${c.g},${c.b},${clamp(alpha).toFixed(3)})`;

export const mixRGBString = (a: RGB, b: RGB, t: number, alpha = 1): string =>
  rgba(mixRGB(a, b, t), alpha);

/** Scales brightness, keeping the hue. Used for rim/glow tints. */
export const scaleRGB = (c: RGB, k: number): RGB => ({
  r: clamp(c.r * k, 0, 255),
  g: clamp(c.g * k, 0, 255),
  b: clamp(c.b * k, 0, 255),
});

/* ------------------------------------------------------- deterministic noise */

const hash3 = (x: number, y: number, z: number): number => {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return n - Math.floor(n);
};

/** Value noise in 3D, ~[0,1]. Cheap, stable, good enough for surface relief. */
export const noise3 = (x: number, y: number, z: number): number => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);

  const c000 = hash3(xi, yi, zi);
  const c100 = hash3(xi + 1, yi, zi);
  const c010 = hash3(xi, yi + 1, zi);
  const c110 = hash3(xi + 1, yi + 1, zi);
  const c001 = hash3(xi, yi, zi + 1);
  const c101 = hash3(xi + 1, yi, zi + 1);
  const c011 = hash3(xi, yi + 1, zi + 1);
  const c111 = hash3(xi + 1, yi + 1, zi + 1);

  const x00 = lerp(c000, c100, u);
  const x10 = lerp(c010, c110, u);
  const x01 = lerp(c001, c101, u);
  const x11 = lerp(c011, c111, u);

  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
};

/** Two-octave fBm — enough surface character without the cost of more. */
export const fbm2 = (x: number, y: number, z: number): number =>
  noise3(x, y, z) * 0.65 + noise3(x * 2.13 + 7.3, y * 2.13, z * 2.13) * 0.35;

/** Deterministic pseudo-random generator (mulberry32) for stable layouts. */
export const seededRandom = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
