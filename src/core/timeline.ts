/**
 * Keyframe sampling for scroll-driven scenes.
 *
 * A scene declares a list of "stops" along its 0..1 scroll progress. Sampling
 * eases between neighbouring stops so motion decelerates into each pose —
 * that pause-at-the-pose is what makes the sequence read as choreographed
 * rather than as a linear lerp.
 *
 * Sampling is a pure function of `p`, which is what guarantees that scrolling
 * up retraces exactly the same states in reverse.
 */

import { clamp, easeInOutCubic, type RGB, mixRGB } from './math';

export interface Stop<T> {
  /** Scroll progress, 0..1, at which this pose is held. */
  at: number;
  value: T;
}

export type Mixer<T> = (a: T, b: T, t: number) => T;

export interface Segment {
  index: number;
  /** Eased 0..1 progress between the two stops. */
  t: number;
}

/** Locates the bracketing stops for `p` and returns the eased local progress. */
export const findSegment = <T>(
  stops: readonly Stop<T>[],
  p: number,
  ease: (t: number) => number = easeInOutCubic,
): Segment => {
  const n = stops.length;
  if (n === 0) throw new Error('findSegment: empty stop list');
  if (n === 1) return { index: 0, t: 0 };

  const x = clamp(p);
  const first = stops[0];
  const last = stops[n - 1];

  if (x <= first.at) return { index: 0, t: 0 };
  if (x >= last.at) return { index: n - 2, t: 1 };

  for (let i = 0; i < n - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (x >= a.at && x <= b.at) {
      const span = b.at - a.at;
      const local = span <= 0 ? 1 : (x - a.at) / span;
      return { index: i, t: ease(clamp(local)) };
    }
  }
  return { index: n - 2, t: 1 };
};

/** Samples a single track of scalar stops. */
export const sampleTrack = (
  stops: readonly Stop<number>[],
  p: number,
  ease?: (t: number) => number,
): number => {
  if (stops.length === 0) return 0;
  const { index, t } = findSegment(stops, p, ease);
  const a = stops[index].value;
  const b = stops[Math.min(index + 1, stops.length - 1)].value;
  return a + (b - a) * t;
};

/** Samples a track of colour stops. */
export const sampleColour = (
  stops: readonly Stop<RGB>[],
  p: number,
  ease?: (t: number) => number,
): RGB => {
  if (stops.length === 0) return { r: 0, g: 0, b: 0 };
  const { index, t } = findSegment(stops, p, ease);
  const a = stops[index].value;
  const b = stops[Math.min(index + 1, stops.length - 1)].value;
  return mixRGB(a, b, t);
};

/**
 * Samples a whole object pose. Every stop must expose the same keys; only the
 * listed keys are blended so callers can leave out optional fields.
 */
export const samplePose = <T extends Record<string, number | RGB>>(
  stops: readonly Stop<Partial<T>>[],
  p: number,
  keys: readonly (keyof T)[],
  colourKeys: ReadonlySet<keyof T>,
  ease?: (t: number) => number,
): T => {
  const out = {} as T;
  if (stops.length === 0) return out;

  const { index, t } = findSegment(stops, p, ease);
  const a = stops[index].value;
  const b = stops[Math.min(index + 1, stops.length - 1)].value;

  for (const key of keys) {
    const av = a[key];
    const bv = b[key];
    if (typeof av === 'number' && typeof bv === 'number') {
      (out as Record<string, number | RGB>)[key as string] = av + (bv - av) * t;
    } else if (colourKeys.has(key) && av && bv) {
      (out as Record<string, number | RGB>)[key as string] = mixRGB(
        av as RGB,
        bv as RGB,
        t,
      );
    } else {
      const fallback = av ?? bv;
      if (fallback !== undefined) {
        (out as Record<string, number | RGB>)[key as string] = fallback;
      }
    }
  }
  return out;
};

/**
 * A 0..1 ramp that rises over [from, to] and falls over [outFrom, outTo].
 * Used for crossfading overlapping content inside a single pinned scene.
 */
export const window01 = (
  p: number,
  from: number,
  to: number,
  outFrom: number,
  outTo: number,
): number => {
  if (p <= from || p >= outTo) return 0;
  if (p < to) {
    const span = Math.max(to - from, 1e-6);
    return clamp((p - from) / span);
  }
  if (p <= outFrom) return 1;
  const span = Math.max(outTo - outFrom, 1e-6);
  return clamp(1 - (p - outFrom) / span);
};
