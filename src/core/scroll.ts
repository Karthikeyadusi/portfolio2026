/**
 * Scroll engine.
 *
 * Design constraints this satisfies:
 *  - Native scrolling is never intercepted; we only *read* scrollY.
 *  - Layout is measured once per resize (cached document-space rects) so the
 *    frame loop performs zero forced synchronous layout reads.
 *  - Scenes register a normalised 0..1 progress; one shared RAF loop drives
 *    everything and each scene early-returns when it is off screen.
 *  - Under reduced motion the smoothing layer is bypassed, so poses track the
 *    scrollbar exactly, with no easing lag of their own.
 */

import { clamp, damp } from './math';

export interface SceneTarget {
  /** Element whose scroll travel defines the progress. */
  element: HTMLElement;
  /** Travel length in px. Defaults to element height minus viewport height. */
  travel?: number;
}

export interface Scene {
  element: HTMLElement;
  travel: number;
  /** Scroll offset (document space) at which progress is 0. */
  top: number;
  /** Undamped progress, straight from the scroll position. */
  raw: number;
  /** Progress handed to `update` (damped unless reduced motion). */
  value: number;
  /** False when the scene is scrolled well out of view. */
  visible: boolean;
  update: (p: number, dt: number, elapsed: number) => void;
}

interface CacheEntry {
  element: HTMLElement;
  top: number;
  height: number;
  travel: number;
}

export interface ScrollEngineOptions {
  smoothing?: boolean;
  /** Higher = snappier catch-up when scrolling. */
  lambda?: number;
}

export class ScrollEngine {
  private scenes: Scene[] = [];
  private cache = new Map<HTMLElement, CacheEntry>();
  private listeners = new Set<() => void>();
  private raf = 0;
  private running = false;
  private lastTime = 0;
  private tickCount = 0;
  private elapsed = 0;
  private measureQueued = false;
  private smoothing: boolean;
  private readonly lambda: number;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;

  constructor(options: ScrollEngineOptions = {}) {
    this.smoothing = options.smoothing ?? true;
    this.lambda = options.lambda ?? 16;

    if (typeof window === 'undefined') return;

    this.tick = this.tick.bind(this);

    window.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('resize', this.onScheduleMeasure, { passive: true });
    window.addEventListener('orientationchange', this.onScheduleMeasure, {
      passive: true,
    });

    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(this.onScheduleMeasure);
      this.resizeObserver.observe(document.body);
    }
    if (typeof IntersectionObserver === 'function') {
      this.intersectionObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const el = entry.target as HTMLElement;
            const scene = this.scenes.find((s) => s.element === el);
            if (scene) scene.visible = entry.isIntersecting;
          }
          this.notify();
        },
        // Generous margins: a scene must be warm before it reaches the edge.
        { rootMargin: '25% 0px 25% 0px' },
      );
    }

    // Web fonts change text metrics, which changes section heights after the
    // first paint. Without this the cached rects would stay stale and the
    // scroll-to-progress mapping would be subtly wrong.
    document.fonts?.ready.then(() => {
      this.measure();
      this.ensureRunning();
      this.notify();
    });
  }

  /** Cached document-space geometry, for verification and debugging. */
  geometry(): Array<{ top: number; travel: number; raw: number; value: number }> {
    return this.scenes.map((scene) => ({
      top: scene.top,
      travel: scene.travel,
      raw: scene.raw,
      value: scene.value,
    }));
  }

  register(target: SceneTarget, update: Scene['update']): Scene {
    const scene: Scene = {
      element: target.element,
      travel: target.travel ?? 1,
      top: 0,
      raw: 0,
      value: 0,
      visible: true,
      update,
    };
    this.scenes.push(scene);
    this.intersectionObserver?.observe(target.element);
    this.measure();
    this.notify();
    return scene;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * True once every scene's damped progress has caught up to its raw scroll
   * position. Note that this is trivially true *before* the next frame has
   * read the new scroll offset, so callers should also require `ticks` to have
   * advanced. Used by the verification harness so it samples settled state
   * instead of racing the easing.
   */
  isSettled(): boolean {
    return this.scenes.every((scene) => Math.abs(scene.value - scene.raw) < 1e-12);
  }

  /** Monotonic frame counter — lets callers detect "has a frame run yet". */
  get ticks(): number {
    return this.tickCount;
  }

  setSmoothing(enabled: boolean): void {
    this.smoothing = enabled;
    for (const scene of this.scenes) {
      if (!enabled) scene.value = scene.raw;
    }
    this.ensureRunning();
  }

  /** Re-reads layout and pushes one frame. */
  refresh(): void {
    this.measure();
    this.ensureRunning();
    this.tick(performance.now());
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.running = false;
    if (typeof window === 'undefined') return;
    window.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('resize', this.onScheduleMeasure);
    window.removeEventListener('orientationchange', this.onScheduleMeasure);
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.listeners.clear();
  }

  /* --------------------------------------------------------------- internals */

  private onScroll = (): void => {
    this.ensureRunning();
    this.notify();
  };

  private onScheduleMeasure = (): void => {
    if (this.measureQueued) return;
    this.measureQueued = true;
    const run = (): void => {
      this.measureQueued = false;
      this.measure();
      this.ensureRunning();
      this.notify();
    };
    requestAnimationFrame(run);
  };

  /** Caches document-space rects. Called on register + resize only. */
  measure(): void {
    if (typeof window === 'undefined') return;
    const scrollY = window.scrollY;
    const vh = window.innerHeight || 1;
    this.cache.clear();
    for (const scene of this.scenes) {
      const rect = scene.element.getBoundingClientRect();
      const height = rect.height;
      const travel = Math.max(height - vh, 1);
      this.cache.set(scene.element, {
        element: scene.element,
        top: rect.top + scrollY,
        height,
        travel,
      });
      scene.top = rect.top + scrollY;
      scene.travel = travel;
    }
  }

  private computeRaw(scene: Scene): number {
    const entry = this.cache.get(scene.element);
    if (!entry) return 0;
    return clamp((window.scrollY - entry.top) / entry.travel);
  }

  private ensureRunning(): void {
    if (this.scenes.length === 0 || this.running || typeof requestAnimationFrame !== 'function')
      return;
    this.running = true;
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick(now: number): void {
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    this.elapsed += dt;
    this.tickCount++;

    for (const scene of this.scenes) {
      scene.raw = this.computeRaw(scene);
      scene.value = this.smoothing ? damp(scene.value, scene.raw, this.lambda, dt) : scene.raw;
      scene.update(scene.value, dt, this.elapsed);
    }

    this.notify();
    this.raf = requestAnimationFrame(this.tick);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
