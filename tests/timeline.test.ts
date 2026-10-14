import { describe, expect, it } from 'vitest';
import { findSegment, sampleColour, samplePose, sampleTrack, window01 } from '../src/core/timeline';
import { parseHex, type RGB } from '../src/core/math';

const track = [
  { at: 0, value: 0 },
  { at: 0.5, value: 10 },
  { at: 1, value: 20 },
];

describe('findSegment', () => {
  it('pins to the ends', () => {
    expect(findSegment(track, -1)).toEqual({ index: 0, t: 0 });
    expect(findSegment(track, 2)).toEqual({ index: 1, t: 1 });
  });

  it('returns the bracketing pair with eased local progress', () => {
    const seg = findSegment(track, 0.25);
    expect(seg.index).toBe(0);
    expect(seg.t).toBeGreaterThan(0.25); // easeInOutCubic leads linear
    expect(seg.t).toBeLessThan(0.75);
  });

  it('handles degenerate lists', () => {
    expect(findSegment([{ at: 0, value: 1 }], 0.5)).toEqual({ index: 0, t: 0 });
    expect(() => findSegment([], 0.5)).toThrow();
  });

  it('survives duplicate stop positions', () => {
    const dup = [
      { at: 0, value: 0 },
      { at: 0.5, value: 5 },
      { at: 0.5, value: 5 },
      { at: 1, value: 9 },
    ];
    expect(Number.isFinite(sampleTrack(dup, 0.5))).toBe(true);
    expect(sampleTrack(dup, 0.5)).toBe(5);
  });
});

describe('sampleTrack', () => {
  it('hits every stop exactly', () => {
    for (const stop of track) {
      expect(sampleTrack(track, stop.at)).toBeCloseTo(stop.value, 6);
    }
  });

  it('is a pure function of p, so reverse scrolling retraces it', () => {
    const forward = Array.from({ length: 101 }, (_, i) => sampleTrack(track, i / 100));
    const backward = Array.from({ length: 101 }, (_, i) => sampleTrack(track, 1 - i / 100)).reverse();
    for (let i = 0; i < forward.length; i++) {
      expect(backward[i]).toBeCloseTo(forward[i], 9);
    }
  });

  it('eases into each stop rather than moving linearly', () => {
    // easeInOutCubic leads the line early and trails it late, so the object
    // accelerates out of one pose and settles into the next.
    const eased = sampleTrack(track, 0.125);
    const linear = sampleTrack(track, 0.125, (t) => t);
    expect(linear).toBeCloseTo(2.5, 6);
    expect(eased).toBeLessThan(linear);
    expect(eased).toBeGreaterThan(0);
    // Symmetric easing puts the midpoint of a segment exactly on the midpoint.
    expect(sampleTrack(track, 0.25)).toBeCloseTo(5, 6);
  });
});

describe('sampleColour', () => {
  const colours: Array<{ at: number; value: RGB }> = [
    { at: 0, value: parseHex('#000000') },
    { at: 1, value: parseHex('#ffffff') },
  ];
  it('blends across the timeline', () => {
    const mid = sampleColour(colours, 0.5);
    expect(mid.r).toBeGreaterThan(0);
    expect(mid.r).toBeLessThan(255);
    expect(sampleColour(colours, 0)).toEqual(colours[0].value);
    expect(sampleColour(colours, 1)).toEqual(colours[1].value);
  });
});

describe('samplePose', () => {
  type Pose = { a: number; b: number; tint: RGB };
  const stops = [
    { at: 0, value: { a: 0, b: 4, tint: parseHex('#101010') } },
    { at: 1, value: { a: 10, b: -4, tint: parseHex('#f0f0f0') } },
  ];
  const keys = ['a', 'b', 'tint'] as const;
  const colours = new Set<keyof Pose>(['tint']);

  it('blends scalars and colours independently', () => {
    const mid = samplePose<Pose>(stops, 0.5, keys, colours);
    expect(mid.a).toBeCloseTo(5, 6);
    expect(mid.b).toBeCloseTo(0, 6);
    expect(mid.tint.r).toBeGreaterThan(16);
    expect(mid.tint.r).toBeLessThan(240);
  });

  it('returns an empty object for an empty stop list', () => {
    expect(samplePose<Pose>([], 0.5, keys, colours)).toEqual({});
  });

  it('falls back to whichever stop defines an optional key', () => {
    const partial = [
      { at: 0, value: { a: 1 } },
      { at: 1, value: { a: 2, b: 9 } },
    ];
    const out = samplePose<Pose>(partial, 0.5, ['a', 'b'] as const, colours);
    expect(out.a).toBeCloseTo(1.5, 6);
    expect(out.b).toBe(9);
  });
});

describe('window01', () => {
  const w = [0.2, 0.35, 0.65, 0.8] as const;

  it('is zero outside the window', () => {
    expect(window01(0, ...w)).toBe(0);
    expect(window01(1, ...w)).toBe(0);
  });

  it('holds at one across the plateau', () => {
    expect(window01(0.35, ...w)).toBe(1);
    expect(window01(0.65, ...w)).toBe(1);
  });

  it('ramps up and down monotonically', () => {
    expect(window01(0.275, ...w)).toBeCloseTo(0.5, 6);
    expect(window01(0.725, ...w)).toBeCloseTo(0.5, 6);
    expect(window01(0.35, ...w)).toBeGreaterThan(window01(0.25, ...w));
    expect(window01(0.65, ...w)).toBeGreaterThan(window01(0.75, ...w));
  });

  it('never leaves 0..1', () => {
    for (let i = 0; i <= 100; i++) {
      const v = window01(i / 100, ...w);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
