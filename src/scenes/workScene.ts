/**
 * Section 02 — Selected work.
 *
 * One pinned stage, ~5 viewport-heights of scroll travel, and a single object
 * whose pose is sampled from keyframe stops at fixed scroll positions. Six
 * things move at once, all from the same `p`:
 *
 *   position   pose.x / pose.y  — the object travels up through the frame
 *   scale      pose.scale       — 0.30 → 1.15 → 0.80 → 1.55
 *   rotation   pose.yaw/pitch/roll — 670° of yaw plus a tilting pitch
 *   material   solidity / wire / relief / dissolve — crystal → lattice → liquid
 *   colour     key / rim / bg   — the entire stage hue shifts per project
 *   environment grid / rings / scan plane / bloom
 *
 * Project copy crossfades on the same clock via a CSS custom property, so the
 * headings and the geometry are never out of step. Nothing here holds state
 * beyond the scroll position: every pose is a pure function of `p`.
 */

import { DEG, clamp, lerp, mixRGB, rgba, smootherstep } from '../core/math';
import { samplePose, window01, type Stop } from '../core/timeline';
import { projects } from '../data/content';
import { CoreRenderer, meshForTier, type CorePose } from './coreRenderer';
import type { Scene } from '../core/scroll';
import type { DetailTier, MotionPolicy } from '../core/motion';

/** Scroll position (0..1) where each project is fully composed. */
export const PROJECT_STOPS = [0.24, 0.585, 0.86] as const;

/** Fade windows per project. Adjacent windows overlap so the outgoing panel is
 *  still legible as the incoming one arrives — no dead beat between them. */
const PANEL_WINDOWS = [
  [0.075, 0.175, 0.34, 0.425],
  [0.375, 0.48, 0.655, 0.74],
  [0.7, 0.795, 0.885, 0.945],
] as const;

/**
 * Every channel a pose stop may carry. `samplePose` only emits the keys it is
 * given, so this list must stay in step with `CorePose` — the colour channels
 * in particular, or the renderer receives `undefined`.
 */
export const POSE_KEYS = [
  'yaw',  'pitch',
  'roll',
  'x',
  'y',
  'scale',
  'solidity',
  'wire',
  'relief',
  'flow',
  'dissolve',
  'bloom',
  'ring',
  'debris',
  'grid',
  'scanY',
  'scan',
  'opacity',
  // Colour channels are listed here too — `samplePose` only emits the keys it
  // is given, so omitting them would hand the renderer undefined colours.
  'key',
  'rim',
  'bg',
] as const;

const COLOUR_KEYS = new Set<keyof CorePose>(['key', 'rim', 'bg']);

const [vision, product, tooling] = projects;

/**
 * Each project owns a material as well as a colour:
 *   01 AegisLogix   — lattice  · a detection field laid over the scene
 *   02 Attendly     — crystal  · closed, dependable, works with no network
 *   03 GitRunByKaru — liquid   · a runtime that keeps moving
 */
export const buildPoseStops = (): Array<Stop<Partial<CorePose>>> => [
  {
    // Empty stage: nothing has formed yet.
    at: 0,
    value: {
      yaw: -34 * DEG,
      pitch: -42 * DEG,
      roll: 7 * DEG,
      x: 0.3,
      y: 0.42,
      scale: 0.3,
      solidity: 0,
      wire: 0,
      relief: 0.02,
      flow: 0,
      dissolve: 1,
      bloom: 0.1,
      ring: 0.05,
      debris: 2.4,
      grid: 0,
      scanY: -1.2,
      scan: 0,
      opacity: 0,
      key: vision.accent,
      rim: { r: 63, g: 142, b: 168 },
      bg: { r: 4, g: 7, b: 9 },
    },
  },
  {
    // Materialised, settling into the first pose.
    at: 0.11,
    value: {
      yaw: 16 * DEG,
      pitch: -22 * DEG,
      roll: -2 * DEG,
      x: 0.17,
      y: 0.2,
      scale: 0.62,
      solidity: 0.1,
      wire: 0.52,
      relief: 0.16,
      flow: 0.02,
      dissolve: 0.52,
      bloom: 0.4,
      ring: 0.4,
      debris: 1.7,
      grid: 0.22,
      scanY: 0.9,
      scan: 0.3,
      opacity: 1,
      key: vision.accent,
      rim: { r: 63, g: 142, b: 168 },
      bg: { r: 5, g: 10, b: 11 },
    },
  },
  {
    // 01 AEGISLOGIX — the shell comes apart into a detection lattice and a
    // floor appears beneath it.
    at: PROJECT_STOPS[0],
    value: {
      yaw: 42 * DEG,
      pitch: 16 * DEG,
      roll: 9 * DEG,
      x: 0.04,
      y: 0.04,
      scale: 1.12,
      solidity: 0.06,
      wire: 0.74,
      relief: 0.3,
      flow: 0.05,
      dissolve: 0.92,
      bloom: 0.42,
      ring: 0.9,
      debris: 1.85,
      grid: 0.8,
      scanY: 0.5,
      scan: 0.45,
      opacity: 1,
      key: vision.accent,
      rim: { r: 58, g: 138, b: 172 },
      bg: { r: 6, g: 11, b: 14 },
    },
  },
  {
    // 02 ATTENDLY — reassembles into a solid, cut, dependable crystal, pushed
    // right so the display-scale title has the left of the frame to itself.
    at: PROJECT_STOPS[1],
    value: {
      yaw: 262 * DEG,
      pitch: -12 * DEG,
      roll: -4 * DEG,
      x: 0.22,
      y: 0.1,
      scale: 0.88,
      solidity: 0.88,
      wire: 0.34,
      relief: 0.12,
      flow: 0,
      dissolve: 0.02,
      bloom: 0.45,
      ring: 0.1,
      debris: 1.12,
      grid: 0,
      scanY: 0.18,
      scan: 0.75,
      opacity: 1,
      key: product.accent,
      rim: { r: 196, g: 82, b: 58 },
      bg: { r: 13, g: 7, b: 5 },
    },
  },
  {
    // 03 GITRUNBYKARU — liquid, lit from inside, lifted to the top right so
    // the italic title keeps the left of the frame.
    at: PROJECT_STOPS[2],
    value: {
      yaw: 524 * DEG,
      pitch: -6 * DEG,
      roll: -10 * DEG,
      x: 0.28,
      y: -0.26,
      scale: 0.72,
      solidity: 0.92,
      wire: 0.24,
      relief: 0.2,
      flow: 0.55,
      dissolve: 0.08,
      bloom: 1,
      ring: 0.3,
      debris: 1.35,
      grid: 0.05,
      scanY: -0.46,
      scan: 0.85,
      opacity: 1,
      key: tooling.accent,
      rim: { r: 78, g: 110, b: 214 },
      bg: { r: 8, g: 7, b: 22 },
    },
  },
  {
    // Exit: the shell loses cohesion in place and spreads across the frame
    // rather than flying out of it, so the stage is never simply empty while
    // the sticky element slides away.
    at: 1,
    value: {
      yaw: 668 * DEG,
      pitch: 33 * DEG,
      roll: -17 * DEG,
      x: -0.1,
      y: -0.14,
      scale: 2.15,
      solidity: 0.03,
      wire: 0.32,
      relief: 0.5,
      flow: 0.25,
      dissolve: 1,
      bloom: 0.52,
      ring: 0.45,
      debris: 2.3,
      grid: 0,
      scanY: -1.4,
      scan: 0.12,
      opacity: 0.55,
      key: tooling.accent,
      rim: { r: 78, g: 110, b: 214 },
      bg: { r: 7, g: 6, b: 18 },
    },
  },
];

export interface WorkSceneDeps {
  section: HTMLElement;
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
  panels: HTMLElement[];
  ticks: HTMLElement[];
  readouts: Record<string, HTMLElement>;
}

export class WorkScene {
  private renderer = new CoreRenderer();
  private ctx: CanvasRenderingContext2D | null = null;
  private pose: CorePose;
  private stops = buildPoseStops();
  private dpr = 1;
  private tier: DetailTier = 'medium';
  private policy: MotionPolicy;
  private idle = 0;
  private width = 0;
  private height = 0;
  private activeIndex = -1;
  private lastFrameLabel = -1;
  private scene: Scene | null = null;
  private lastPanelT: number[] = [-1, -1, -1];
  private lastProgress = -1;

  constructor(
    private deps: WorkSceneDeps,
    policy: MotionPolicy,
    tier: DetailTier,
  ) {
    this.policy = policy;
    this.tier = tier;
    this.pose = samplePose(this.stops, 0, POSE_KEYS, COLOUR_KEYS) as CorePose;
    this.ctx = deps.canvas.getContext('2d', { alpha: false });
    this.resize();
  }

  register(engine: { register: (t: { element: HTMLElement }, u: Scene['update']) => Scene }): Scene {
    const scene = engine.register({ element: this.deps.section }, (p, dt) => {
      this.update(p, dt);
    });
    this.scene = scene;
    return scene;
  }

  applyPolicy(policy: MotionPolicy): void {
    this.policy = policy;
    this.idle = 0;
    this.render(0);
  }

  resize(): void {
    const rect = this.deps.stage.getBoundingClientRect();
    const w = Math.max(Math.round(rect.width), 1);
    const h = Math.max(Math.round(rect.height), 1);
    this.width = w;
    this.height = h;

    const coarse = window.matchMedia('(pointer: coarse)').matches;
    this.dpr = Math.min(window.devicePixelRatio || 1, this.tier === 'low' ? 1.75 : 2);

    const canvas = this.deps.canvas;
    canvas.width = Math.round(w * this.dpr);
    canvas.height = Math.round(h * this.dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    this.ctx?.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const desktop = w >= 900 && !coarse;
    this.renderer.configure({
      mesh: meshForTier(this.tier),
      radius: Math.min(w, h) * (desktop ? 0.195 : 0.3),
      seed: 20260913,
      ghost: false,
    });
    void this.dpr;
    this.render(0);
  }

  /** Which of the three poses the frame is currently nearest to. */
  private activeProjectAt(p: number): number {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < PROJECT_STOPS.length; i++) {
      const d = Math.abs(p - PROJECT_STOPS[i]);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  private update(p: number, dt: number): void {
    const scene = this.scene;
    if (scene && !scene.visible) return;

    this.lastProgress = p;
    this.idle += dt * this.policy.idleScale;

    const pose = samplePose(this.stops, p, POSE_KEYS, COLOUR_KEYS) as CorePose;
    this.pose = pose;
    this.render(p);
    this.syncPanels(p);
    this.syncTicks(p);
    this.syncReadouts(p);
    this.syncChrome(p, pose);
  }

  private render(p: number): void {
    const ctx = this.ctx;
    if (!ctx || this.width === 0) return;

    const w = this.width;
    const h = this.height;
    const desktop = w >= 900;
    const spin = this.policy.spinScale;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const mobile = !desktop || coarse;

    const pose = this.pose;
    const draw: CorePose = {
      ...pose,
      yaw: pose.yaw * spin,
      pitch: pose.pitch * spin,
      roll: pose.roll * spin,
      flow: pose.flow * this.policy.idleScale,
      // On narrow screens the object is centred and travels less, so it stays
      // clear of the copy that sits beneath it.
      x: pose.x * (mobile ? 0.14 : 1),
      y: pose.y * (mobile ? 0.4 : 1) + (mobile ? -0.16 : 0),
      scale: pose.scale * (mobile ? 0.86 : 1),
    };

    this.renderer.draw(
      ctx,
      draw,
      { width: w, height: h },
      this.idle,
      // Grain drifts with scroll, so the environment is part of the sequence.
      p * 900,
    );
  }

  private syncPanels(p: number): void {
    for (let i = 0; i < this.deps.panels.length; i++) {
      const [a, b, c, d] = PANEL_WINDOWS[i] ?? [0, 0, 0, 0];
      const t = window01(p, a, b, c, d);
      if (Math.abs(t - this.lastPanelT[i]) < 0.003) continue;
      this.lastPanelT[i] = t;
      const panel = this.deps.panels[i];
      panel.style.setProperty('--t', t.toFixed(3));
      // Ease the drift so the copy settles rather than sliding linearly.
      const eased = t * t * (3 - 2 * t);
      panel.style.opacity = t.toFixed(3);
      panel.style.transform = `translate3d(0, ${lerp(34, 0, eased).toFixed(2)}px, 0)`;
      panel.style.visibility = t <= 0.002 ? 'hidden' : 'visible';
    }

    const active = this.activeProjectAt(p);
    if (active !== this.activeIndex) {
      this.activeIndex = active;
      this.deps.panels.forEach((panel, i) => {
        const on = i === active;
        panel.toggleAttribute('inert', !on);
        panel.setAttribute('aria-hidden', on ? 'false' : 'true');
        panel.dataset.active = on ? 'true' : 'false';
      });
    }
  }

  private syncTicks(p: number): void {
    const active = this.activeProjectAt(p);
    for (let i = 0; i < this.deps.ticks.length; i++) {
      const on = i === active;
      const d = Math.abs(p - PROJECT_STOPS[i]);
      const proximity = clamp(1 - d * 2.4);
      this.deps.ticks[i].dataset.active = on ? 'true' : 'false';
      this.deps.ticks[i].style.setProperty('--near', proximity.toFixed(3));
    }
  }

  private syncReadouts(p: number): void {
    const r = this.deps.readouts;
    const yaw = ((this.pose.yaw % (Math.PI * 2)) / DEG + 360) % 360;
    const frame = Math.round(p * 420);
    if (frame !== this.lastFrameLabel) {
      this.lastFrameLabel = frame;
      if (r.frame) r.frame.textContent = `f ${String(frame).padStart(3, '0')}`;
    }
    if (r.angle) r.angle.textContent = `${yaw.toFixed(0).padStart(3, '0')}°`;
    if (r.scale) r.scale.textContent = `${this.pose.scale.toFixed(2)}×`;
    if (r.mat) {
      const mat =
        this.pose.dissolve > 0.55
          ? 'lattice'
          : this.pose.flow > 0.25
            ? 'liquid'
            : 'crystal';
      if (r.mat.textContent !== mat) r.mat.textContent = mat;
    }
  }

  /**
   * Corner registration marks, the readout and the rail all track the object's
   * screen position and colour. The chrome fades out over the last stretch so
   * it does not hang around on an empty stage while the sticky element
   * releases.
   */
  private syncChrome(p: number, pose: CorePose): void {
    const stage = this.deps.stage;
    stage.style.setProperty('--stage-accent', rgba(pose.key, 0.95));
    stage.style.setProperty('--stage-edge', rgba(mixRGB(pose.bg, pose.key, 0.8), 0.55 * pose.opacity));
    stage.style.setProperty('--stage-bg', rgba(pose.bg, 1));
    stage.style.setProperty('--scrim-far', rgba(pose.bg, 0));
    stage.style.setProperty('--scrim-near', rgba(pose.bg, 0.86));
    stage.style.setProperty('--scrim-edge', rgba(pose.bg, 0.34));
    stage.style.setProperty('--stage-out', (1 - smootherstep(0.86, 0.99, p)).toFixed(3));
  }

  get progress(): number {
    return this.lastProgress;
  }

  /**
   * Rounded pose snapshot. Exposed for the browser verification harness so
   * scroll-driven behaviour can be asserted against real rendered state
   * instead of inferred from pixels.
   */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of POSE_KEYS) {
      const value = this.pose[key];
      if (typeof value === 'number') out[key] = Math.round(value * 1e4) / 1e4;
    }
    for (const key of ['key', 'rim', 'bg'] as const) {
      const c = this.pose[key];
      out[`${key}R`] = c.r;
      out[`${key}G`] = c.g;
      out[`${key}B`] = c.b;
    }
    return out;
  }
}
