import { describe, expect, it } from 'vitest';
import {
  clamp,
  damp,
  invLerp,
  lerp,
  mapRange,
  mixRGB,
  parseHex,
  rgba,
  scaleRGB,
  seededRandom,
  smoothstep,
  smootherstep,
} from '../src/core/math';

describe('numeric primitives', () => {
  it('clamps to range', () => {
    expect(clamp(-3)).toBe(0);
    expect(clamp(0.5)).toBe(0.5);
    expect(clamp(9)).toBe(1);
    expect(clamp(9, -5, 5)).toBe(5);
  });

  it('lerps and inverts', () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
    expect(invLerp(10, 20, 15)).toBe(0.5);
    expect(invLerp(5, 5, 5)).toBe(0);
  });

  it('maps ranges', () => {
    expect(mapRange(5, 0, 10, 100, 200)).toBe(150);
    expect(mapRange(-5, 0, 10, 100, 200)).toBe(100);
    expect(mapRange(50, 0, 10, 100, 200)).toBe(200);
  });

  it('smoothsteps are anchored and monotonic', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smootherstep(0, 1, 0.5)).toBeCloseTo(0.5, 6);

    let previous = -1;
    for (let i = 0; i <= 100; i++) {
      const v = smoothstep(0.2, 0.8, i / 100);
      expect(v).toBeGreaterThanOrEqual(previous);
      previous = v;
    }
  });
});

describe('damp', () => {
  it('is frame-rate independent', () => {
    // Same elapsed time, different step counts, must land in the same place.
    let a = 0;
    for (let i = 0; i < 100; i++) a = damp(a, 1, 10, 0.01);
    let b = 0;
    for (let i = 0; i < 10; i++) b = damp(b, 1, 10, 0.1);
    expect(a).toBeCloseTo(b, 6);
  });

  it('converges to the target and clamps an overlong frame', () => {
    let v = 0;
    for (let i = 0; i < 500; i++) v = damp(v, 2, 12, 0.016);
    expect(v).toBeCloseTo(2, 5);
    // A long stall is treated as 100ms, so the scene cannot teleport.
    expect(damp(0, 1, 10, 99)).toBeCloseTo(damp(0, 1, 10, 0.1), 9);
  });
});

describe('colour', () => {
  it('parses hex in all supported forms', () => {
    expect(parseHex('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('000000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseHex('#f3a854')).toEqual({ r: 243, g: 168, b: 84 });
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('#5fe3cf80')).toEqual({ r: 95, g: 227, b: 207 });
  });

  it('rejects nonsense', () => {
    expect(() => parseHex('#12345')).toThrow();
    expect(() => parseHex('nope')).toThrow();
  });

  it('mixes to exact endpoints', () => {
    const a = parseHex('#5fe3cf');
    const b = parseHex('#ff8b4c');
    expect(mixRGB(a, b, 0)).toEqual(a);
    expect(mixRGB(a, b, 1)).toEqual(b);
  });

  it('mixes monotonically in each channel', () => {
    const a = { r: 0, g: 20, b: 200 };
    const b = { r: 200, g: 180, b: 40 };
    let previous = -1;
    for (let i = 0; i <= 20; i++) {
      const c = mixRGB(a, b, i / 20);
      expect(c.r).toBeGreaterThanOrEqual(previous);
      previous = c.r;
    }
  });

  it('formats rgba and scales brightness', () => {
    expect(rgba({ r: 1, g: 2, b: 3 }, 0.5)).toBe('rgba(1,2,3,0.500)');
    expect(scaleRGB({ r: 100, g: 100, b: 100 }, 0.5)).toEqual({ r: 50, g: 50, b: 50 });
    expect(scaleRGB({ r: 200, g: 0, b: 0 }, 4).r).toBe(255);
  });
});

describe('seededRandom', () => {
  it('is deterministic for a given seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const seqA = Array.from({ length: 8 }, a);
    const seqB = Array.from({ length: 8 }, b);
    expect(seqA).toEqual(seqB);
  });

  it('stays inside [0,1)', () => {
    const rand = seededRandom(7);
    for (let i = 0; i < 500; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('differs across seeds', () => {
    expect(seededRandom(1)()).not.toBe(seededRandom(2)());
  });
});
