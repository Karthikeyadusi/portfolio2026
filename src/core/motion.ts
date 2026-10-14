/**
 * Motion policy.
 *
 * Everything time-based (idle drift, breathing, marquees) is gated behind
 * `prefersReducedMotion`. Scroll-linked *poses* are kept under reduced motion,
 * because they are direct manipulation of the page rather than autonomous
 * animation — but their amplitude is compressed and smoothing is disabled so
 * nothing eases or drifts on its own.
 */

export interface MotionPolicy {
  reduced: boolean;
  /** Multiplier applied to time-based (idle) motion. 0 when reduced. */
  idleScale: number;
  /** Multiplier applied to scroll-linked rotation amplitude. */
  spinScale: number;
  /** Whether the smoothing layer should be engaged. */
  smoothing: boolean;
  /** Whether the render loop should keep running while the scene is at rest. */
  continuous: boolean;
}

const mq =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

export const isReducedMotion = (): boolean => Boolean(mq?.matches);

export const getMotionPolicy = (): MotionPolicy => {
  const reduced = isReducedMotion();
  return {
    reduced,
    idleScale: reduced ? 0 : 1,
    spinScale: reduced ? 0.12 : 1,
    smoothing: !reduced,
    continuous: !reduced,
  };
};

export const onMotionPreferenceChange = (handler: (reduced: boolean) => void): void => {
  if (!mq) return;
  const listener = (e: MediaQueryListEvent) => handler(e.matches);
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', listener);
  } else if (typeof (mq as unknown as { addListener?: unknown }).addListener === 'function') {
    (mq as unknown as { addListener: (l: (e: MediaQueryListEvent) => void) => void }).addListener(
      listener,
    );
  }
};

/** Viewport-derived quality tier. Drives mesh density and particle counts. */
export type DetailTier = 'high' | 'medium' | 'low';

export const getDetailTier = (): DetailTier => {
  if (typeof window === 'undefined') return 'medium';
  const w = window.innerWidth;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const cores = navigator.hardwareConcurrency ?? 4;
  if (w < 760 || coarse || cores <= 4) return 'low';
  if (w < 1200 || cores <= 8) return 'medium';
  return 'high';
};

export const getMaxDpr = (tier: DetailTier): number => {
  if (tier === 'low') return Math.min(window.devicePixelRatio || 1, 1.75);
  return Math.min(window.devicePixelRatio || 1, 2);
};
