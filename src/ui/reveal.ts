/**
 * Reveal-on-enter for static copy. Uses IntersectionObserver only — it adds a
 * class once and never removes it, so it cannot fight the scroll-driven work
 * scene, and content stays visible if the observer never fires.
 */

export class Reveal {
  private observer: IntersectionObserver | null = null;

  constructor(root: ParentNode = document) {
    const targets = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (targets.length === 0) return;

    // No observer support, or reduced motion: show everything immediately.
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (typeof IntersectionObserver !== 'function' || reduced) {
      for (const el of targets) el.dataset.revealed = 'true';
      return;
    }

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset.revealed = 'true';
          this.observer?.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
    );

    for (const el of targets) this.observer.observe(el);
  }

  destroy(): void {
    this.observer?.disconnect();
  }
}
