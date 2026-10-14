/**
 * Section 04 — Contact.
 *
 * The aperture returns, this time opening, and this scene owns it outright.
 * The driver is absolute scroll position rather than the section's own 0..1
 * progress: section progress is 0 the instant a visitor lands on `#contact`,
 * which would show them an empty paper panel. Tying the reveal to the window
 * immediately *before* the section's top means the panel is fully composed
 * whenever it is on screen, from any entry point.
 *
 * The palette flips to a warm paper tone so the page ends on a printed coda,
 * and the hexagonal mark from the opening dial closes the loop.
 */

import { clamp, smootherstep } from '../core/math';
import type { Scene } from '../core/scroll';
import type { Iris } from './iris';

/** How far above the section top the aperture begins opening, in viewports. */
const APPROACH = 0.95;
/** Where the aperture finishes, relative to the section top. */
const ARRIVAL = -0.05;

export interface ContactSceneDeps {
  section: HTMLElement;
  panel: HTMLElement;
  iris: Iris;
  mark: HTMLElement | null;
  horizon: HTMLElement | null;
}

export class ContactScene {
  private top = 0;
  private vh = 1;
  private lastOpen = -1;
  private lastProgress = -1;

  constructor(private deps: ContactSceneDeps) {
    this.measure();
    if (typeof ResizeObserver === 'function' && typeof document !== 'undefined') {
      const observer = new ResizeObserver(() => {
        this.measure();
        this.render(window.scrollY, 0);
      });
      observer.observe(document.body);
      document.fonts?.ready.then(() => {
        this.measure();
        this.render(window.scrollY, 0);
      });
    }
  }

  private measure(): void {
    if (typeof window === 'undefined') return;
    this.vh = window.innerHeight || 1;
    this.top = this.deps.section.getBoundingClientRect().top + window.scrollY;
  }

  register(engine: { register: (t: { element: HTMLElement }, u: Scene['update']) => Scene }): Scene {
    return engine.register({ element: this.deps.section }, (p, dt) => {
      this.lastProgress = p;
      this.render(window.scrollY, dt);
    });
  }

  private render(scrollY: number, dt: number): void {
    const from = this.top - this.vh * APPROACH;
    const to = this.top + this.vh * ARRIVAL;
    const approach = smootherstep(from, to, scrollY);

    // Aperture and copy share one scalar, so they can never disagree.
    if (Math.abs(approach - this.lastOpen) > 0.0004) {
      this.lastOpen = approach;
      const open = approach > 0.9995;
      this.deps.iris.element.style.visibility = open ? 'hidden' : 'visible';
      if (!open) this.deps.iris.setOpen(approach);
    }

    const reveal = smootherstep(0.22, 0.92, approach);
    const panel = this.deps.panel;
    panel.style.setProperty('--t', reveal.toFixed(3));
    panel.style.opacity = reveal.toFixed(3);
    panel.style.transform = `translate3d(0, ${((1 - reveal) * 46).toFixed(2)}px, 0)`;

    // Decorative details keep turning through the held shot.
    const held = clamp(Math.max(approach, this.lastProgress));
    if (this.deps.mark) {
      this.deps.mark.style.setProperty('--spin', `${(held * 54).toFixed(2)}deg`);
    }
    if (this.deps.horizon) {
      this.deps.horizon.style.setProperty('--draw', smootherstep(0.1, 0.7, held).toFixed(3));
    }
    void dt;
  }
}
