/**
 * Section 01 — Introduction.
 *
 * Holds a title card, then hands off to the work sequence through the aperture:
 * the blades rotate closed across the last third of the section, so section 02
 * is revealed by the instrument opening rather than by a cross-fade.
 *
 * The dial in the corner is the identity device — a measuring instrument that
 * the rest of the page keeps quoting (the work scene's readout, the contact
 * scene's horizon). It is scroll-driven too, so even the opening card has
 * something in it that answers the scrollbar.
 */

import { smootherstep, TAU } from '../core/math';
import type { Scene } from '../core/scroll';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface IntroSceneDeps {
  section: HTMLElement;
  card: HTMLElement;
  dial: HTMLElement;
  readout: HTMLElement;
  cue: HTMLElement;
  /** The section the card hands off to; its top is where the aperture seals. */
  next: HTMLElement;
}

export class IntroScene {
  private outer: SVGGElement | null = null;
  private inner: SVGGElement | null = null;
  private lastReadout = -1;
  private vh = 1;
  private releaseAt = 0;
  private handOffAt = 0;

  constructor(private deps: IntroSceneDeps) {
    this.buildDial();
    this.measure();
    if (typeof ResizeObserver === 'function' && typeof document !== 'undefined') {
      const observer = new ResizeObserver(() => {
        this.measure();
        this.update(this.lastProgress);
      });
      observer.observe(document.body);
      document.fonts?.ready.then(() => {
        this.measure();
        this.update(this.lastProgress);
      });
    }
  }

  private measure(): void {
    if (typeof window === 'undefined') return;
    this.vh = window.innerHeight || 1;
    const scrollY = window.scrollY;
    const rect = this.deps.section.getBoundingClientRect();
    const top = rect.top + scrollY;
    // The card is sticky: it holds for `height - vh` px, then lifts away.
    this.releaseAt = top + Math.max(rect.height - this.vh, 1);
    this.handOffAt = this.deps.next.getBoundingClientRect().top + scrollY;
  }

  private lastProgress = 0;

  /** Generates the dial: a graduated outer ring, a counter-rotating polygon. */
  private buildDial(): void {
    const host = this.deps.dial;
    if (!host || typeof document === 'undefined') return;
    // Remove only previously generated SVGs — the readout and caption are
    // authored in the document and must survive.
    for (const stale of Array.from(host.querySelectorAll('svg'))) stale.remove();

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '-100 -100 200 200');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const base = document.createElementNS(SVG_NS, 'circle');
    base.setAttribute('r', '86');
    base.setAttribute('class', 'dial__ring');
    svg.appendChild(base);

    const outer = document.createElementNS(SVG_NS, 'g');
    outer.setAttribute('class', 'dial__ticks');
    const majors = 24;
    const minorsPerMajor = 5;
    for (let i = 0; i < majors * minorsPerMajor; i++) {
      const major = i % minorsPerMajor === 0;
      const angle = (i / (majors * minorsPerMajor)) * TAU - Math.PI / 2;
      const len = major ? 13 : 5;
      const r0 = 86;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', (Math.cos(angle) * r0).toFixed(3));
      line.setAttribute('y1', (Math.sin(angle) * r0).toFixed(3));
      line.setAttribute('x2', (Math.cos(angle) * (r0 + len)).toFixed(3));
      line.setAttribute('y2', (Math.sin(angle) * (r0 + len)).toFixed(3));
      line.setAttribute('class', major ? 'dial__tick dial__tick--major' : 'dial__tick');
      outer.appendChild(line);
    }
    svg.appendChild(outer);

    const inner = document.createElementNS(SVG_NS, 'g');
    inner.setAttribute('class', 'dial__poly');
    const sides = 6;
    let d = '';
    for (let i = 0; i <= sides; i++) {
      const angle = (i / sides) * TAU - Math.PI / 2;
      const r = 58;
      d += `${i === 0 ? 'M' : 'L'} ${(Math.cos(angle) * r).toFixed(2)} ${(Math.sin(angle) * r).toFixed(2)} `;
    }
    const poly = document.createElementNS(SVG_NS, 'path');
    poly.setAttribute('d', d.trim());
    inner.appendChild(poly);
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('r', '2.4');
    dot.setAttribute('class', 'dial__dot');
    dot.setAttribute('cx', '58');
    dot.setAttribute('cy', '0');
    inner.appendChild(dot);
    svg.appendChild(inner);

    const index = document.createElementNS(SVG_NS, 'path');
    index.setAttribute('d', 'M -5 -74 L 0 -80 L 5 -74');
    index.setAttribute('class', 'dial__index');
    svg.appendChild(index);

    host.appendChild(svg);
    this.outer = outer;
    this.inner = inner;
  }

  register(engine: { register: (t: { element: HTMLElement }, u: Scene['update']) => Scene }): Scene {
    return engine.register({ element: this.deps.section }, (p) => {
      this.lastProgress = p;
      this.update(p);
    });
  }

  private update(p: number): void {
    const { card, cue, readout } = this.deps;
    this.lastProgress = p;

    // The title card holds while pinned and is lifted away by the sticky
    // release alone. It fades over exactly the window in which the aperture
    // seals behind it, so the two read as one move and the screen is never
    // left showing neither.
    const exit = smootherstep(this.releaseAt, this.handOffAt - 30, window.scrollY);
    card.style.opacity = (1 - exit).toFixed(3);
    card.style.transform = `translate3d(0, ${(-exit * 34).toFixed(2)}px, 0) scale(${(1 - exit * 0.05).toFixed(4)})`;

    cue.style.opacity = (1 - smootherstep(0.02, 0.18, p)).toFixed(3);
    cue.style.transform = `translate3d(0, ${(p * -26).toFixed(2)}px, 0)`;

    if (this.outer) this.outer.setAttribute('transform', `rotate(${(p * 130).toFixed(2)})`);
    if (this.inner) this.inner.setAttribute('transform', `rotate(${(-p * 74).toFixed(2)})`);

    const value = Math.round(p * 100);
    if (value !== this.lastReadout) {
      this.lastReadout = value;
      readout.textContent = `${String(value).padStart(3, '0')}%`;
    }

    // Once the card starts leaving, the blades own the viewport; stop it
    // underneath from taking pointer events.
    card.style.pointerEvents = exit > 0.05 ? 'none' : '';
  }
}
