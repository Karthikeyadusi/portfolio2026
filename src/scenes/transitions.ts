/**
 * Scene transitions.
 *
 * The two aperture wipes are driven by absolute scroll position rather than by
 * a section's own progress. That matters: if a visitor jumps straight to
 * `#work`, a section-relative driver would leave the intro blades closed over
 * the work stage. Defining the whole wipe as one continuous function of
 * scrollY means every entry point — scrolling, anchor jump, reload at a deep
 * link — lands on the state that position actually implies.
 */

import { clamp, smootherstep } from '../core/math';
import type { Iris } from './iris';

export interface TransitionDeps {
  introIris: Iris;
  introSection: HTMLElement;
  workSection: HTMLElement;
}

/**
 * The title card is `position: sticky` inside the intro section, so it holds
 * for `introTravel` px and then lifts out of frame for the remaining
 * `height - viewportHeight - introTravel` px. The blades stay fully open for
 * the hold and seal only as the card leaves, so the two read as one move and
 * there is no dead black stretch between the sections.
 */
const OPEN_END = 0.14;

export class Transitions {
  private vh = 1;
  private introTop = 0;
  private introTravel = 1;
  private workTop = 0;
  private workTravel = 1;
  private observer: ResizeObserver | null = null;
  private lastIntro = -1;

  constructor(private deps: TransitionDeps) {
    this.measure();
    if (typeof ResizeObserver === 'function' && typeof document !== 'undefined') {
      this.observer = new ResizeObserver(() => {
        this.measure();
        this.update(window.scrollY);
      });
      this.observer.observe(document.body);
    }
    document.fonts?.ready.then(() => {
      this.measure();
      this.update(window.scrollY);
    });
  }

  measure(): void {
    if (typeof window === 'undefined') return;
    this.vh = window.innerHeight || 1;
    const scrollY = window.scrollY;

    const introRect = this.deps.introSection.getBoundingClientRect();
    this.introTop = introRect.top + scrollY;
    this.introTravel = Math.max(introRect.height - this.vh, 1);

    const workRect = this.deps.workSection.getBoundingClientRect();
    this.workTop = workRect.top + scrollY;
    this.workTravel = Math.max(workRect.height - this.vh, 1);
  }

  resize(width: number, height: number): void {
    this.deps.introIris.resize(width, height);
    this.measure();
  }

  update(scrollY: number): void {
    const y = scrollY;
    // Blades begin sealing the instant the title card stops being pinned.
    const closeStart = this.introTop + this.introTravel;
    const closeEnd = this.workTop - 2;
    const openEnd = this.workTop + OPEN_END * this.workTravel;

    let introOpen: number;
    if (y <= closeStart) introOpen = 1;
    else if (y <= closeEnd) introOpen = 1 - smootherstep(closeStart, closeEnd, y);
    else introOpen = 0;

    // Hard hand-off at the work boundary: both branches are 0 there, so the
    // piecewise function stays continuous while remaining correct when the
    // visitor arrives from above (e.g. jumping straight to #work).
    if (y > closeEnd) {
      introOpen = y <= openEnd ? smootherstep(this.workTop, openEnd, y) : 1;
    }

    if (Math.abs(introOpen - this.lastIntro) > 0.0004) {
      this.lastIntro = introOpen;
      const done = introOpen > 0.9995;
      this.deps.introIris.element.style.visibility = done ? 'hidden' : 'visible';
      if (!done) this.deps.introIris.setOpen(introOpen);
    }
  }

  destroy(): void {
    this.observer?.disconnect();
  }
}

export const clampProgress = clamp;
