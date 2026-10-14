/**
 * Iris overlay — the designed scene transition.
 *
 * The aperture is built from N identical square blades arranged on a circle.
 * Blades are rigidly rotated about the viewport centre; their union covers
 * everything except a regular N-gon whose *inradius* is the blade offset `h`.
 * Driving `h` from `-R` (nothing visible) to `+R` (everything visible) is
 * therefore an exact geometric aperture, not an approximation — the hole is
 * always a clean convex polygon, and rotating the blade set spins that polygon.
 *
 * Because the mapping is a pure function of one scalar, scrolling back up
 * retraces the same close/open in reverse with no separate animation state.
 */

import { clamp, lerp, TAU } from '../core/math';

/**
 * Trace left by the shut shutter.
 *
 * At `t = 0` the twelve blades overlap past the centre and cover the frame
 * completely. With the lit edges and corner brackets both fading to nothing at
 * that point, a fully closed aperture is pixel-identical to a blank page — the
 * geometry of the iris disappears at exactly the moment it is most complete.
 *
 * These constants give the shut state a floor so it still reads as a shutter,
 * and `CLOSED_TRACE_FADE` keeps that floor a property of the closed state only:
 * it is gone well before the aperture is meaningfully open, so it can never
 * linger as stray geometry across the first project.
 */
const CLOSED_EDGE = 0.14;
const CLOSED_BRACKET = 0.16;
const CLOSED_TRACE_FADE = 0.12;

/** 1 while the shutter is shut, falling to 0 as it opens. */
const closedTrace = (t: number): number =>
  t >= CLOSED_TRACE_FADE ? 0 : 1 - t / CLOSED_TRACE_FADE;

export interface IrisOptions {
  /** Blade colour. */
  blade: string;
  /** Bright edge catching the light along each blade's leading edge. */
  edge: string;
  /** Blur/backdrop dim applied behind the blades. */
  bladeCount?: number;
  className?: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export class Iris {
  readonly element: SVGSVGElement;
  private blades: SVGRectElement[] = [];
  private edges: SVGLineElement[] = [];
  private brackets: SVGGElement | null = null;
  private half = 1;
  private width = 0;
  private height = 0;
  private lastOpen = -1;
  private readonly count: number;
  private readonly options: Required<IrisOptions>;

  constructor(options: IrisOptions) {
    this.options = {
      blade: options.blade,
      edge: options.edge,
      bladeCount: options.bladeCount ?? 12,
      className: options.className ?? '',
    };
    this.count = this.options.bladeCount;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `iris ${this.options.className}`.trim());
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('preserveAspectRatio', 'none');

    const defs = document.createElementNS(SVG_NS, 'defs');
    const grad = document.createElementNS(SVG_NS, 'linearGradient');
    grad.setAttribute('id', `iris-grad-${Math.random().toString(36).slice(2, 8)}`);
    grad.setAttribute('x1', '0');
    grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '1');
    grad.setAttribute('y2', '0.35');
    /*
     * The gradient's offset 0 lands on each blade's leading edge (the bbox
     * starts there, not at the rect's local origin), so a wide amber stop
     * would smear 12 overlapping highlights across the whole frame. Keep the
     * body opaque and the highlight to a thin lip just behind the cutting edge.
     */
    for (const [offset, colour, opacity] of [
      ['0', this.options.blade, '1'],
      ['0.016', this.options.edge, '0.5'],
      ['0.05', this.options.blade, '1'],
      ['1', this.options.blade, '1'],
    ] as const) {
      const s = document.createElementNS(SVG_NS, 'stop');
      s.setAttribute('offset', offset);
      s.setAttribute('stop-color', colour);
      s.setAttribute('stop-opacity', opacity);
      grad.appendChild(s);
    }
    const gradId = grad.getAttribute('id') as string;
    defs.appendChild(grad);
    svg.appendChild(defs);

    // All blades first, then all their lit edges. Interleaving them would let
    // a later opaque blade paint over the edge of the one before it.
    for (let i = 0; i < this.count; i++) {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('fill', `url(#${gradId})`);
      this.blades.push(rect);
      svg.appendChild(rect);
    }
    for (let i = 0; i < this.count; i++) {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('stroke', this.options.edge);
      line.setAttribute('stroke-width', '1.4');
      line.setAttribute('vector-effect', 'non-scaling-stroke');
      this.edges.push(line);
      svg.appendChild(line);
    }

    this.brackets = document.createElementNS(SVG_NS, 'g');
    this.brackets.setAttribute('stroke', this.options.edge);
    this.brackets.setAttribute('fill', 'none');
    this.brackets.setAttribute('stroke-width', '1.25');
    this.brackets.setAttribute('opacity', '0');
    for (let c = 0; c < 4; c++) {
      const path = document.createElementNS(SVG_NS, 'path');
      this.brackets.appendChild(path);
    }
    svg.appendChild(this.brackets);

    this.element = svg;
  }

  get svg(): SVGSVGElement {
    return this.element;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.half = Math.hypot(width, height) / 2;
    this.element.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.element.setAttribute('width', String(width));
    this.element.setAttribute('height', String(height));
    this.lastOpen = -1;
  }

  /**
   * `open` runs 0 (fully closed) to 1 (fully open). The hole is a polygon of
   * inradius `h`; `h <= 0` means the blades overlap and cover the viewport.
   */
  setOpen(open: number): void {
    if (this.width === 0) return;
    const t = clamp(open);
    if (Math.abs(t - this.lastOpen) < 0.0004) return;
    this.lastOpen = t;

    const R = this.half;
    // Slight over-travel at both ends so the closed/open extremes are absolute.
    const h = lerp(-R * 0.14, R * 1.04, t);
    const bladeSize = R * 1.9;
    const offset = h + bladeSize;
    const spin = (1 - t) * 0.42 + t * -0.1;
    const cx = this.width / 2;
    const cy = this.height / 2;
    // The lit edge only needs to span one blade's chord across the aperture,
    // with a little overlap — not the full blade depth, which would draw long
    // chords right across the frame.
    const halfChord = Math.abs(h) * Math.tan(Math.PI / this.count) * 1.7 + 10;

    for (let i = 0; i < this.count; i++) {
      const angle = (i / this.count) * TAU + spin;
      const deg = (angle * 180) / Math.PI;
      const tf = `translate(${cx.toFixed(2)} ${cy.toFixed(2)}) rotate(${deg.toFixed(3)}) translate(${offset.toFixed(2)} 0)`;
      const rect = this.blades[i];
      rect.setAttribute('x', String(-bladeSize));
      rect.setAttribute('y', String(-bladeSize));
      rect.setAttribute('width', String(bladeSize * 2));
      rect.setAttribute('height', String(bladeSize * 2));
      rect.setAttribute('transform', tf);

      /*
       * Both the rect and its lit edge live in the blade's own user space,
       * which the `translate(offset 0)` below then shifts outward. The rect is
       * drawn at x = -bladeSize, so that is where its leading edge sits before
       * the shift; the edge line has to use the same coordinate to land on it.
       */
      const edge = this.edges[i];
      edge.setAttribute('x1', String(-bladeSize));
      edge.setAttribute('x2', String(-bladeSize));
      edge.setAttribute('y1', String(-halfChord));
      edge.setAttribute('y2', String(halfChord));
      edge.setAttribute('transform', tf);
      // Slightly uneven catches of light so the blades read as separate
      // leaves rather than one flat mass. The shut-state floor keeps the
      // aperture's geometry legible at the moment it is fully closed.
      const catch_ = 0.45 + 0.55 * (((i * 7) % 5) / 4);
      const lit = Math.max(clamp(t * 2.2) * 0.85, closedTrace(t) * CLOSED_EDGE);
      edge.setAttribute('opacity', (lit * catch_).toFixed(3));
    }

    this.updateBrackets(h, cx, cy, t);
  }

  /** Four corner brackets that tighten around the aperture as it closes. */
  private updateBrackets(h: number, cx: number, cy: number, t: number): void {
    const g = this.brackets;
    if (!g) return;
    // Shown whenever the iris is, so the closed state keeps its marks; the
    // opacity function alone decides how strongly they read.
    const visible = t < 0.985;
    const opacity = Math.max(Math.sin(t * Math.PI) * 0.55, closedTrace(t) * CLOSED_BRACKET);
    g.setAttribute('opacity', visible ? opacity.toFixed(3) : '0');
    if (!visible) return;

    // Sit the marks just outside the polygon's circumradius so they read as
    // focus brackets around the aperture rather than floating inside it.
    const circumradius = Math.abs(h) / Math.cos(Math.PI / this.count);
    const pad = Math.max(R_MIN, circumradius * 1.16 + this.half * 0.05);
    const x0 = cx - pad;
    const x1 = cx + pad;
    const y0 = cy - pad;
    const y1 = cy + pad;
    const arm = Math.min(this.half * 0.09, pad * 0.34) + 6;
    const paths = g.childNodes;
    const corners: Array<[number, number, number, number]> = [
      [x0, y0, 1, 1],
      [x1, y0, -1, 1],
      [x0, y1, 1, -1],
      [x1, y1, -1, -1],
    ];
    corners.forEach(([x, y, dx, dy], i) => {
      const node = paths[i] as SVGPathElement | undefined;
      if (!node) return;
      node.setAttribute('d', `M ${x + dx * arm} ${y} L ${x} ${y} L ${x} ${y + dy * arm}`);
    });
  }
}

const R_MIN = 26;
