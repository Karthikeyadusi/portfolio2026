/**
 * Section 03 — About and capabilities.
 *
 * Deliberately unpinned: the copy scrolls natively while a sticky column holds
 * the ghost of the same object from section 02, drawn wireframe-only by the
 * same renderer at low alpha. Reusing the renderer is what keeps the page
 * feeling like one continuous take rather than four stacked templates.
 */

import { clamp, smootherstep } from '../core/math';
import { CoreRenderer, meshForTier, makePose, type CorePose } from './coreRenderer';
import type { Scene } from '../core/scroll';
import type { DetailTier, MotionPolicy } from '../core/motion';

export interface AboutSceneDeps {
  section: HTMLElement;
  column: HTMLElement;
  canvas: HTMLCanvasElement;
  rows: HTMLElement[];
}

export class AboutScene {
  private renderer = new CoreRenderer();
  private ctx: CanvasRenderingContext2D | null = null;
  private pose: CorePose = makePose();
  private width = 0;
  private height = 0;
  private dpr = 1;
  private idle = 0;
  private scene: Scene | null = null;
  private lastRowT = new Map<HTMLElement, number>();

  constructor(
    private deps: AboutSceneDeps,
    private policy: MotionPolicy,
    tier: DetailTier,
  ) {
    this.ctx = deps.canvas.getContext('2d', { alpha: true });
    // A wireframe watermark of the object from the work sequence — no shell,
    // no glow, transparent ground so it composites over the page.
    this.pose.solidity = 0;
    this.pose.bloom = 0;
    this.pose.ring = 0;
    this.pose.scan = 0;
    this.pose.wire = 0.3;
    this.pose.key = { r: 242, g: 160, b: 61 };
    this.pose.rim = { r: 96, g: 118, b: 150 };
    this.pose.bg = { r: 9, g: 10, b: 12 };
    this.resize(tier);
  }

  register(engine: { register: (t: { element: HTMLElement }, u: Scene['update']) => Scene }): Scene {
    const scene = engine.register({ element: this.deps.section }, (p, dt) => {
      this.idle += dt * this.policy.idleScale;
      this.update(p);
    });
    this.scene = scene;
    return scene;
  }

  applyPolicy(policy: MotionPolicy): void {
    this.policy = policy;
    this.idle = 0;
    this.render();
  }

  resize(tier?: DetailTier): void {
    const t = tier ?? 'medium';
    const rect = this.deps.canvas.parentElement?.getBoundingClientRect();
    const w = Math.max(Math.round(rect?.width ?? 0), 1);
    const h = Math.max(Math.round(rect?.height ?? 0), 1);
    this.width = w;
    this.height = h;
    this.dpr = Math.min(window.devicePixelRatio || 1, t === 'low' ? 1.5 : 2);

    const canvas = this.deps.canvas;
    canvas.width = Math.round(w * this.dpr);
    canvas.height = Math.round(h * this.dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    this.ctx?.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.renderer.configure({
      mesh: meshForTier(t, true),
      radius: Math.min(w, h) * 0.34,
      seed: 771103,
      ghost: true,
    });
    this.render();
  }

  private update(p: number): void {
    if (this.scene && !this.scene.visible) return;

    // Slow continuous drift tied to section progress — the ghost keeps turning
    // after the work scene has let go of it.
    this.pose.yaw = p * 2.6 * this.policy.spinScale + this.idle * 0.06;
    this.pose.pitch = (-14 + p * 26) * Math.PI * 0.01 * this.policy.spinScale;
    this.pose.roll = Math.sin(p * Math.PI) * 12 * Math.PI * 0.01 * this.policy.spinScale;
    this.pose.y = lerpSafe(0.16, -0.12, p);
    this.pose.scale = lerpSafe(0.72, 1.06, p);
    this.pose.wire = 0.34 * (1 - smootherstep(0.82, 1, p));
    this.pose.relief = 0.14;
    this.pose.dissolve = 0.22;

    // Section progress cannot go negative, so the ghost would not appear until
    // the section's top had already reached the viewport top — leaving the tail
    // of the work scene with nothing on screen. Derive the arrival from the
    // section's distance to the viewport instead.
    const vh = window.innerHeight || 1;
    const rect = this.deps.section.getBoundingClientRect();
    const distance = rect.top - window.innerHeight * 0.55;
    const arrival = 1 - clamp(distance / (vh * 0.9));
    this.pose.opacity = clamp(arrival) * (1 - smootherstep(0.86, 1, p));

    this.render();
    this.syncRows(p);
  }

  private render(): void {
    if (!this.ctx || this.width === 0) return;
    this.renderer.draw(this.ctx, this.pose, { width: this.width, height: this.height }, this.idle, 0);
  }

  /** Each capability row's rule draws in as the row reaches the middle band. */
  private syncRows(p: number): void {
    for (const row of this.deps.rows) {
      const index = Number(row.dataset.index ?? 0);
      const centre = 0.2 + index * 0.18;
      const t = clamp(1 - Math.abs(p - centre) / 0.24);
      if (Math.abs(t - (this.lastRowT.get(row) ?? -1)) < 0.004) continue;
      this.lastRowT.set(row, t);
      row.style.setProperty('--t', t.toFixed(3));
    }
  }
}

const lerpSafe = (a: number, b: number, t: number): number => a + (b - a) * clamp(t);
