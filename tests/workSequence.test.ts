/**
 * These tests encode the acceptance criteria for the work sequence directly:
 * the pinned scene must change position, scale, orientation, material and
 * colour as a function of scroll, and must retrace exactly on the way back.
 */

import { describe, expect, it } from 'vitest';
import { samplePose, window01, type Stop } from '../src/core/timeline';
import { buildPoseStops, MATERIALISE_AT, POSE_KEYS, PROJECT_STOPS } from '../src/scenes/workScene';
import type { CorePose } from '../src/scenes/coreRenderer';

const stops = buildPoseStops();
const KEYS = POSE_KEYS;
const COLOUR_KEYS = new Set<keyof CorePose>(['key', 'rim', 'bg']);

/** Guards against a channel silently dropping out of the key list. */
const ALL_CHANNELS: Array<keyof CorePose> = [
  'yaw', 'pitch', 'roll', 'x', 'y', 'scale', 'solidity', 'wire', 'relief',
  'flow', 'dissolve', 'bloom', 'ring', 'debris', 'grid', 'scanY', 'scan',
  'opacity', 'key', 'rim', 'bg',
];

const poseAt = (p: number): CorePose =>
  samplePose<CorePose>(stops as Array<Stop<Partial<CorePose>>>, p, KEYS, COLOUR_KEYS);

const PANEL_WINDOWS = [
  [0.075, 0.175, 0.34, 0.425],
  [0.375, 0.48, 0.655, 0.74],
  [0.7, 0.795, 0.885, 0.945],
] as const;

const peakOpacity = (p: number): number =>
  Math.max(...PANEL_WINDOWS.map((w) => window01(p, w[0], w[1], w[2], w[3])));

describe('work sequence timeline', () => {
  it('declares stops in ascending order inside 0..1', () => {
    expect(stops.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i].at).toBeGreaterThan(stops[i - 1].at);
    }
    expect(stops[0].at).toBe(0);
    expect(stops[stops.length - 1].at).toBe(1);
    for (const stop of stops) expect(stop.at).toBeGreaterThanOrEqual(0);
  });

  it('places the three project stops in order', () => {
    expect(PROJECT_STOPS).toHaveLength(3);
    expect(PROJECT_STOPS[0]).toBeLessThan(PROJECT_STOPS[1]);
    expect(PROJECT_STOPS[1]).toBeLessThan(PROJECT_STOPS[2]);
    for (const at of PROJECT_STOPS) {
      expect(at).toBeGreaterThan(0.02);
      expect(at).toBeLessThan(0.98);
    }
  });
});

describe('the pinned scene transforms with scroll', () => {
  const first = poseAt(PROJECT_STOPS[0]); // 01 AegisLogix — lattice
  const second = poseAt(PROJECT_STOPS[1]); // 02 Attendly — crystal
  const third = poseAt(PROJECT_STOPS[2]); // 03 GitRunByKaru — liquid
  const all = [first, second, third];

  it('emits every declared channel', () => {
    const pose = poseAt(0.5);
    for (const channel of ALL_CHANNELS) {
      expect(pose[channel], `channel ${channel}`).toBeDefined();
    }
    expect(new Set(KEYS)).toEqual(new Set(ALL_CHANNELS));
  });

  it('changes scale noticeably between projects', () => {
    const scales = all.map((p) => p.scale);
    for (const s of scales) expect(s).toBeGreaterThan(0.3);
    expect(Math.abs(second.scale - first.scale)).toBeGreaterThan(0.15);
    expect(Math.abs(third.scale - second.scale)).toBeGreaterThan(0.1);
  });

  it('changes position noticeably — the object travels through the frame', () => {
    const xs = all.map((p) => p.x);
    const ys = all.map((p) => p.y);
    // 01 near centre → 02 pushed right and low → 03 lifted to the top right:
    // a real vertical travel plus a horizontal one, each composed so the
    // project copy keeps its side of the frame.
    expect(Math.abs(Math.max(...xs) - Math.min(...xs))).toBeGreaterThan(0.2);
    expect(Math.abs(Math.max(...ys) - Math.min(...ys))).toBeGreaterThan(0.3);
    expect(ys[2]).toBeLessThan(ys[1]);
    expect(ys[2]).toBeLessThan(ys[0]);
  });

  it('changes orientation — yaw accumulates several hundred degrees', () => {
    const yaws = all.map((p) => p.yaw);
    expect(yaws[1]).toBeGreaterThan(yaws[0]);
    expect(yaws[2]).toBeGreaterThan(yaws[1]);
    const totalDegrees = ((poseAt(1).yaw - poseAt(0).yaw) * 180) / Math.PI;
    expect(totalDegrees).toBeGreaterThan(400);
    // Pitch and roll also move, so it is not a single-axis spin.
    expect(Math.abs(second.pitch - first.pitch)).toBeGreaterThan(0.1);
    expect(Math.abs(third.roll - first.roll)).toBeGreaterThan(0.05);
  });

  it('changes material — lattice, crystal, liquid', () => {
    // 01 AegisLogix: shredded into a detection lattice with a floor.
    expect(first.dissolve).toBeGreaterThan(0.8);
    expect(first.solidity).toBeLessThan(0.15);
    expect(first.grid).toBeGreaterThan(0.5);
    expect(first.ring).toBeGreaterThan(0.8);

    // 02 Attendly: reassembled, opaque, dependable.
    expect(second.solidity).toBeGreaterThan(0.7);
    expect(second.dissolve).toBeLessThan(0.15);
    expect(second.relief).toBeLessThan(first.relief);
    expect(second.grid).toBeLessThan(0.05);

    // 03 GitRunByKaru: solid, flowing, heavily lit.
    expect(third.solidity).toBeGreaterThan(0.8);
    expect(third.flow).toBeGreaterThan(0.3);
    expect(third.dissolve).toBeLessThan(0.2);
    expect(third.bloom).toBeGreaterThan(first.bloom);
    expect(third.bloom).toBeGreaterThan(second.bloom);
  });

  it('changes colour — key, rim and background all shift per project', () => {
    expect(first.key).not.toEqual(second.key);
    expect(second.key).not.toEqual(third.key);
    expect(first.bg).not.toEqual(second.bg);
    expect(second.bg).not.toEqual(third.bg);
    expect(third.rim).not.toEqual(first.rim);
  });

  it('arrives already underway, and dissolves out in place, with no blank interval', () => {
    /*
     * The aperture seals over the intro at p = 0, so the stage cannot be
     * empty there or the transition has nothing to reveal. It must carry a
     * faint lattice at low strength — present, but nowhere near composed.
     */
    expect(poseAt(0).opacity).toBeGreaterThan(0.25);
    expect(poseAt(0).opacity).toBeLessThan(0.45);
    expect(poseAt(0).wire).toBeGreaterThan(0.15);
    expect(poseAt(0).solidity).toBeLessThan(0.05);

    // Materialisation completes early, so the form is legible as the blades
    // uncover it rather than fading in behind an already-open aperture.
    expect(MATERIALISE_AT).toBeLessThan(PROJECT_STOPS[0]);
    expect(poseAt(MATERIALISE_AT).opacity).toBeGreaterThan(0.9);
    expect(poseAt(0.12).opacity).toBeGreaterThan(0.9);

    // Fully composed for the body of the sequence.
    for (let i = 13; i <= 88; i += 1) {
      expect(poseAt(i / 100).opacity, `p=${i / 100}`).toBeGreaterThan(0.9);
    }
    // Monotone fade in — no flicker on the way up.
    let previous = 0;
    for (let i = 0; i <= 11; i++) {
      const v = poseAt(i / 100).opacity;
      expect(v).toBeGreaterThanOrEqual(previous);
      previous = v;
    }
    // The exit keeps material on screen — it spreads and thins rather than
    // emptying the stage — and lands fully scattered.
    expect(poseAt(1).dissolve).toBeGreaterThan(0.95);
    expect(poseAt(1).scale).toBeGreaterThan(1.8);
    for (let i = 86; i <= 100; i++) {
      expect(poseAt(i / 100).opacity, `p=${i / 100}`).toBeGreaterThan(0.4);
      expect(poseAt(i / 100).opacity).toBeLessThanOrEqual(1);
    }
  });
});

describe('reversibility', () => {
  it('reproduces identical poses when sampled again (pure function of p)', () => {
    for (let i = 0; i <= 100; i++) {
      const p = i / 100;
      expect(poseAt(p)).toEqual(poseAt(p));
    }
  });

  it('traces the same path forwards and backwards', () => {
    const forward = Array.from({ length: 201 }, (_, i) => poseAt(i / 200));
    const backward = Array.from({ length: 201 }, (_, i) => poseAt(1 - i / 200)).reverse();
    for (let i = 0; i < forward.length; i++) {
      expect(backward[i].scale).toBeCloseTo(forward[i].scale, 9);
      expect(backward[i].yaw).toBeCloseTo(forward[i].yaw, 9);
      expect(backward[i].dissolve).toBeCloseTo(forward[i].dissolve, 9);
      expect(backward[i].key).toEqual(forward[i].key);
    }
  });

  it('keeps every sampled value finite and in range', () => {
    const numericKeys = ALL_CHANNELS.filter((k) => !COLOUR_KEYS.has(k));
    // Channels authored as normalised 0..1 factors.
    const unitKeys = [
      'solidity', 'wire', 'relief', 'dissolve', 'bloom', 'ring', 'grid',
      'scan', 'opacity',
    ] as const;
    // Multipliers that may exceed 1 by design.
    const multiplierKeys = ['debris', 'flow', 'scale'] as const;

    for (let i = 0; i <= 400; i++) {
      const p = i / 400;
      const pose = poseAt(p);
      for (const key of numericKeys) {
        const value = pose[key] as number;
        expect(Number.isFinite(value), `${key} at p=${p}`).toBe(true);
        // Angles run to several turns; positions are fractions of the stage.
        expect(value, `${key} at p=${p}`).toBeGreaterThan(-24);
        expect(value, `${key} at p=${p}`).toBeLessThan(24);
      }
      for (const key of unitKeys) {
        const value = pose[key] as number;
        expect(value, `${key} at p=${p}`).toBeGreaterThanOrEqual(0);
        expect(value, `${key} at p=${p}`).toBeLessThanOrEqual(1.01);
      }
      for (const key of multiplierKeys) {
        const value = pose[key] as number;
        expect(value, `${key} at p=${p}`).toBeGreaterThanOrEqual(0);
        expect(value, `${key} at p=${p}`).toBeLessThan(4);
      }
      for (const key of ['x', 'y'] as const) {
        expect(Math.abs(pose[key]), `${key} at p=${p}`).toBeLessThanOrEqual(1);
      }
      for (const key of ['scanY'] as const) {
        expect(Math.abs(pose[key]), `${key} at p=${p}`).toBeLessThanOrEqual(2);
      }
      for (const c of [pose.key, pose.rim, pose.bg]) {
        for (const channel of [c.r, c.g, c.b]) {
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(255);
        }
      }
    }
  });
});

describe('panel crossfades stay in step with the geometry', () => {
  it('shows exactly one project at full strength at each project stop', () => {
    for (const at of PROJECT_STOPS) {
      const visible = PANEL_WINDOWS.map((w) => window01(at, w[0], w[1], w[2], w[3]));
      expect(visible.filter((v) => v > 0.9)).toHaveLength(1);
      expect(visible.reduce((a, b) => a + b)).toBeLessThan(1.2);
    }
  });

  it('never shows two panels at once', () => {
    for (let i = 0; i <= 1000; i++) {
      const p = i / 1000;
      const strong = PANEL_WINDOWS.filter(
        (w) => window01(p, w[0], w[1], w[2], w[3]) > 0.6,
      ).length;
      expect(strong, `p=${p}`).toBeLessThanOrEqual(1);
    }
  });

  it('has no dead beat between projects — copy is always at least partly legible', () => {
    // From the end of the entrance ramp to the start of the exit ramp.
    for (let i = 18; i <= 93; i++) {
      const p = i / 100;
      expect(peakOpacity(p), `p=${p}`).toBeGreaterThan(0.2);
    }
  });

  it('fades copy out at the head and tail of the pinned sequence', () => {
    expect(peakOpacity(0.02)).toBe(0);
    expect(peakOpacity(0.99)).toBe(0);
  });

  it('crossfades rather than cutting: adjacent panels overlap', () => {
    const at = (w: readonly number[], p: number): number =>
      window01(p, w[0], w[1], w[2], w[3]);
    // Mid-handoff both panels carry real weight.
    const handoff = 0.4;
    expect(at(PANEL_WINDOWS[0], handoff)).toBeGreaterThan(0.2);
    expect(at(PANEL_WINDOWS[1], handoff)).toBeGreaterThan(0.15);
    // And the outgoing one is still decaying as the incoming one arrives.
    expect(at(PANEL_WINDOWS[0], 0.39)).toBeGreaterThan(at(PANEL_WINDOWS[0], 0.4));
  });
});
