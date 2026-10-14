/**
 * `CoreRenderer` — the object that persists through the work sequence.
 *
 * A parametric surface on a UV-sphere lattice, written straight to a Canvas 2D
 * context with no 3D library. Everything that makes the scene feel authored —
 * faceting, relief, dissolve, ring tilt, scan plane, bloom — is a pose
 * parameter sampled from the scroll timeline, so scrolling *is* the animation
 * and scrolling back retraces it exactly.
 *
 * Buffers are allocated once per configure/resize; the frame loop does not
 * allocate per-face objects.
 */

import { TAU, clamp, fbm2, mixRGB, rgba, scaleRGB, seededRandom, type RGB } from '../core/math';

/**
 * Declared as a type alias rather than an interface so it satisfies
 * `Record<string, number | RGB>` and can flow through `samplePose`.
 */
export type CorePose = {
  /** Orientation in radians. */
  yaw: number;
  pitch: number;
  roll: number;
  /** Placement as a fraction of the stage box (1 = full width / height). */
  x: number;
  y: number;
  /** Multiplier on the stage's base radius. */
  scale: number;
  /* material */
  solidity: number; // 0 = pure wireframe, 1 = opaque faceted shell
  wire: number; // wireframe opacity
  relief: number; // surface displacement amplitude
  flow: number; // animated displacement speed (0 = frozen)
  dissolve: number; // 0 = intact shell, 1 = fully scattered
  bloom: number; // glow + additive particle intensity
  ring: number; // orbital ring opacity
  debris: number; // radius multiplier for the orbiting debris field
  grid: number; // perspective floor grid opacity
  scanY: number; // scan plane height, -1..1 of object radius
  scan: number; // scan plane opacity
  opacity: number;
  key: RGB; // key / accent colour
  rim: RGB; // cool secondary light
  bg: RGB; // stage background
};

export const makePose = (): CorePose => ({
  yaw: 0,
  pitch: 0,
  roll: 0,
  x: 0,
  y: 0,
  scale: 1,
  solidity: 0.4,
  wire: 0.6,
  relief: 0.08,
  flow: 0,
  dissolve: 0,
  bloom: 0.5,
  ring: 0.3,
  debris: 1,
  grid: 0,
  scanY: 0,
  scan: 0.5,
  opacity: 1,
  key: { r: 255, g: 255, b: 255 },
  rim: { r: 120, g: 140, b: 190 },
  bg: { r: 7, g: 9, b: 12 },
});

export interface MeshPreset {
  cols: number;
  rows: number;
  satellites: number;
}

export const meshForTier = (tier: 'high' | 'medium' | 'low', ghost = false): MeshPreset => {
  if (ghost) return { cols: 15, rows: 10, satellites: 0 };
  if (tier === 'high') return { cols: 24, rows: 16, satellites: 120 };
  if (tier === 'medium') return { cols: 20, rows: 13, satellites: 80 };
  return { cols: 14, rows: 10, satellites: 44 };
};

/**
 * Camera distance as a multiple of the object radius. Kept as a ratio rather
 * than a constant: with a fixed near-plane distance the divide blows up as soon
 * as the surface crosses it, which shreds the mesh into spikes.
 */
const CAMERA_DISTANCE = 5.5;

export interface CoreOptions {
  mesh: MeshPreset;
  radius: number;
  seed: number;
  ghost: boolean;
}

export class CoreRenderer {
  private cols = 24;
  private rows = 16;
  private radius = 200;
  private satelliteCount = 120;
  private seed = 1;
  private ghost = false;
  private signature = '';

  /* lattice */
  private unit = new Float32Array(0);
  private px = new Float32Array(0);
  private py = new Float32Array(0);
  private pz = new Float32Array(0);
  private sx = new Float32Array(0);
  private sy = new Float32Array(0);
  private sz = new Float32Array(0);

  /* faces */
  private faceIndices = new Int32Array(0);
  private faceDepth = new Float32Array(0);
  private faceOrder: number[] = [];

  /* wireframe */
  private wireIndices = new Int32Array(0);

  /* debris */
  private satOrbit = new Float32Array(0);
  private satAngle = new Float32Array(0);
  private satSize = new Float32Array(0);

  /* atmosphere */
  private grainPattern: CanvasPattern | null = null;
  private centreX = 0;
  private centreY = 0;
  private width = 0;
  private height = 0;
  /** Camera distance in px; refreshed every frame from the current radius. */
  private camDist = 1;
  private radiusNow = 1;

  configure(options: CoreOptions): void {
    this.radius = options.radius;
    const next = `${options.mesh.cols}:${options.mesh.rows}:${options.mesh.satellites}:${options.seed}:${options.ghost}`;
    this.seed = options.seed;
    this.ghost = options.ghost;
    if (next === this.signature) return;
    this.signature = next;
    this.cols = options.mesh.cols;
    this.rows = options.mesh.rows;
    this.satelliteCount = options.mesh.satellites;
    this.build();
  }

  setRadius(radius: number): void {
    this.radius = radius;
  }

  getRadius(): number {
    return this.radius;
  }

  /* --------------------------------------------------------------- building */

  private build(): void {
    const { cols, rows } = this;
    const vCount = (cols + 1) * (rows + 1);
    this.unit = new Float32Array(vCount * 3);
    this.px = new Float32Array(vCount);
    this.py = new Float32Array(vCount);
    this.pz = new Float32Array(vCount);
    this.sx = new Float32Array(vCount);
    this.sy = new Float32Array(vCount);
    this.sz = new Float32Array(vCount);

    let v = 0;
    for (let j = 0; j <= rows; j++) {
      const phi = (j / rows) * Math.PI;
      const sp = Math.sin(phi);
      const cp = Math.cos(phi);
      for (let i = 0; i <= cols; i++) {
        const theta = (i / cols) * TAU;
        this.unit[v * 3] = sp * Math.cos(theta);
        this.unit[v * 3 + 1] = cp;
        this.unit[v * 3 + 2] = sp * Math.sin(theta);
        v++;
      }
    }

    const faceCount = cols * rows * 2;
    this.faceIndices = new Int32Array(faceCount * 3);
    this.faceDepth = new Float32Array(faceCount);
    let f = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const a = j * (cols + 1) + i;
        const b = a + 1;
        const c = a + cols + 1;
        const d = c + 1;
        // Counter-clockwise seen from outside, so face normals point at the
        // camera and the backface cull keeps the visible half. Alternating the
        // quad diagonal stops a seam pattern ringing the object.
        if ((i + j) % 2 === 0) {
          this.faceIndices.set([a, b, c], f * 3);
          f++;
          this.faceIndices.set([b, d, c], f * 3);
          f++;
        } else {
          this.faceIndices.set([a, b, d], f * 3);
          f++;
          this.faceIndices.set([a, d, c], f * 3);
          f++;
        }
      }
    }
    this.faceOrder = Array.from({ length: faceCount }, (_, i) => i);

    const wire: number[] = [];
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i < cols; i++) {
        const a = j * (cols + 1) + i;
        wire.push(a, a + 1);
      }
    }
    for (let i = 0; i <= cols; i++) {
      for (let j = 0; j < rows; j++) {
        const a = j * (cols + 1) + i;
        wire.push(a, a + cols + 1);
      }
    }
    this.wireIndices = new Int32Array(wire);

    this.buildSatellites();
  }

  private buildSatellites(): void {
    const n = this.satelliteCount;
    this.satOrbit = new Float32Array(n * 3);
    this.satAngle = new Float32Array(n);
    this.satSize = new Float32Array(n);
    const rand = seededRandom(Math.imul(this.seed, 2654435761) >>> 0);
    for (let i = 0; i < n; i++) {
      const tilt = (rand() - 0.5) * Math.PI * 1.15;
      const dir = rand() * TAU;
      // Unitless multiples of the object radius: 1.05–1.9 keeps the debris
      // reading as a close shell rather than a distant field.
      const r = 1.05 + rand() * 0.85;
      this.satOrbit[i * 3] = Math.cos(tilt) * Math.cos(dir) * r;
      this.satOrbit[i * 3 + 1] = Math.sin(tilt) * r * 0.7;
      this.satOrbit[i * 3 + 2] = Math.cos(tilt) * Math.sin(dir) * r;
      this.satAngle[i] = rand() * TAU;
      this.satSize[i] = 0.5 + rand() * 1.5;
    }
  }

  private ensureGrain(ctx: CanvasRenderingContext2D): CanvasPattern | null {
    if (this.grainPattern) return this.grainPattern;
    if (typeof document === 'undefined') return null;
    const size = 128;
    const tile = document.createElement('canvas');
    tile.width = size;
    tile.height = size;
    const tctx = tile.getContext('2d');
    if (!tctx) return null;
    const image = tctx.createImageData(size, size);
    const rand = seededRandom(90210);
    for (let i = 0; i < image.data.length; i += 4) {
      const v = 128 + (rand() - 0.5) * 110;
      image.data[i] = v;
      image.data[i + 1] = v;
      image.data[i + 2] = v;
      image.data[i + 3] = 255;
    }
    tctx.putImageData(image, 0, 0);
    this.grainPattern = ctx.createPattern(tile, 'repeat');
    return this.grainPattern;
  }

  /* -------------------------------------------------------------- projection */

  /** Recomputes the camera for the current pose. Called once per frame. */
  private updateCamera(pose: CorePose): void {
    this.radiusNow = this.radius * pose.scale;
    this.camDist = Math.max(this.radiusNow * CAMERA_DISTANCE, 1);
  }

  /** Weak perspective divide; always finite because camDist >> |z|. */
  private persp(z: number): number {
    return this.camDist / (this.camDist + z);
  }

  private project(pose: CorePose, idle: number): void {
    const { unit, px, py, pz, sx, sy, sz } = this;
    const vCount = (this.cols + 1) * (this.rows + 1);

    const cy = Math.cos(pose.yaw);
    const syw = Math.sin(pose.yaw);
    const cp = Math.cos(pose.pitch);
    const sp = Math.sin(pose.pitch);
    const cr = Math.cos(pose.roll);
    const sr = Math.sin(pose.roll);

    const R = this.radiusNow;
    // Placement is authored as a fraction of the stage box, not in pixels.
    const ox = this.centreX + pose.x * this.width;
    const oy = this.centreY + pose.y * this.height;

    const relief = pose.relief;
    const flow = pose.flow * idle;
    const disperse = pose.dissolve;

    for (let v = 0; v < vCount; v++) {
      const ux = unit[v * 3];
      const uy = unit[v * 3 + 1];
      const uz = unit[v * 3 + 2];

      // Radial relief: low-frequency fBm plus a travelling wave that only
      // exists while `flow` is non-zero (the liquid material).
      let swell = 1;
      if (relief > 0.0005) {
        const n =
          fbm2(ux * 1.55 + flow * 0.35, uy * 1.55 + flow * 0.5, uz * 1.55) - 0.5;
        const wave = Math.sin(uy * 3.1 + flow * 1.7 + (ux + uz) * 1.6);
        swell += relief * (n * 1.45 + wave * 0.42);
      }

      let lx = ux * R * swell;
      let ly = uy * R * swell;
      let lz = uz * R * swell;

      if (disperse > 0.0005) {
        // Push outward along the radial direction and add a tangential swirl,
        // so the shell shreds into debris rather than inflating like a balloon.
        const push = disperse * R * 0.9;
        const swirl = disperse * R * 0.42;
        lx = lx * (1 + disperse * 0.35) + push * ux - swirl * uz;
        ly = ly * (1 + disperse * 0.35) + push * uy + swirl * 0.3 * Math.sin(ux * 5.1 + flow);
        lz = lz * (1 + disperse * 0.35) + push * uz + swirl * ux;
      }

      const x1 = lx * cy + lz * syw; // yaw
      const z1 = -lx * syw + lz * cy;
      const y2 = ly * cp - z1 * sp; // pitch
      const z2 = ly * sp + z1 * cp;
      const x3 = x1 * cr - y2 * sr; // roll
      const y3 = x1 * sr + y2 * cr;

      px[v] = x3;
      py[v] = y3;
      pz[v] = z2;

      const k = this.persp(z2);
      sx[v] = ox + x3 * k;
      sy[v] = oy + y3 * k;
      sz[v] = z2;
    }
  }

  private sortFaces(): void {
    const { faceIndices, pz, faceDepth, faceOrder } = this;
    const count = faceDepth.length;
    for (let f = 0; f < count; f++) {
      const a = faceIndices[f * 3];
      const b = faceIndices[f * 3 + 1];
      const c = faceIndices[f * 3 + 2];
      faceDepth[f] = (pz[a] + pz[b] + pz[c]) / 3;
    }
    // Painter's algorithm — farthest (largest z) first.
    faceOrder.sort((a, b) => faceDepth[b] - faceDepth[a]);
  }

  /* ------------------------------------------------------------ draw passes */

  private drawAtmosphere(
    ctx: CanvasRenderingContext2D,
    pose: CorePose,
    width: number,
    height: number,
    grainOffset: number,
  ): void {
    const cx = this.centreX + pose.x * this.width;
    const cy = this.centreY + pose.y * this.height;
    const R = this.radiusNow;

    if (this.ghost) {
      // A ghost composites over the page, so it must not paint an opaque
      // ground or a vignette — only the lattice itself.
      ctx.clearRect(0, 0, width, height);
      return;
    }

    ctx.fillStyle = rgba(pose.bg, 1);
    ctx.fillRect(0, 0, width, height);

    if (pose.bloom > 0.02) {
      const tint = mixRGB(pose.bg, pose.key, 0.55);
      const g = ctx.createRadialGradient(cx, cy, R * 0.08, cx, cy, R * 4.4);
      g.addColorStop(0, rgba(tint, 0.3 * pose.bloom * pose.opacity));
      g.addColorStop(0.42, rgba(tint, 0.075 * pose.bloom * pose.opacity));
      g.addColorStop(1, rgba(pose.bg, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
    }

    if (!this.ghost && pose.opacity > 0.06) {
      const pattern = this.ensureGrain(ctx);
      if (pattern) {
        ctx.save();
        ctx.globalAlpha = 0.04 * pose.opacity;
        ctx.globalCompositeOperation = 'overlay';
        const ox = ((grainOffset % 128) + 128) % 128;
        const oy = ((grainOffset * 0.61 % 128) + 128) % 128;
        ctx.translate(ox, oy);
        ctx.fillStyle = pattern;
        ctx.fillRect(-128, -128, width + 256, height + 256);
        ctx.restore();
      }
    }

    const vignette = ctx.createRadialGradient(
      width / 2,
      height / 2,
      Math.min(width, height) * 0.3,
      width / 2,
      height / 2,
      Math.max(width, height) * 0.8,
    );
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.7)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);
  }

  private drawFaces(ctx: CanvasRenderingContext2D, pose: CorePose): void {
    if (this.ghost) return;
    const alpha = pose.solidity * pose.opacity;
    if (alpha <= 0.004) return;

    const { faceIndices, faceOrder, sx, sy, px, py, pz } = this;
    const R = this.radiusNow;
    const key = pose.key;
    const rim = pose.rim;

    // Key light from upper-left-front; cool rim light from behind-right.
    const kx = -0.55;
    const ky = -0.62;
    const kz = 0.56;
    const bx = 0.74;
    const by = 0.28;
    const bz = -0.61;

    const shadow = scaleRGB(pose.bg, 1.3);

    for (let n = 0; n < faceOrder.length; n++) {
      const f = faceOrder[n];
      const i0 = faceIndices[f * 3];
      const i1 = faceIndices[f * 3 + 1];
      const i2 = faceIndices[f * 3 + 2];

      const ax = px[i0];
      const ay = py[i0];
      const az = pz[i0];
      const ux = px[i1] - ax;
      const uy = py[i1] - ay;
      const uz = pz[i1] - az;
      const wx = px[i2] - ax;
      const wy = py[i2] - ay;
      const wz = pz[i2] - az;

      let nx = uy * wz - uz * wy;
      let ny = uz * wx - ux * wz;
      let nz = ux * wy - uy * wx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;

      if (nz < 0.04) continue; // soft backface cull

      const lambert = clamp(nx * kx + ny * ky + nz * kz) * 0.9 + 0.1;
      const back = clamp(nx * bx + ny * by + nz * bz);
      const fres = Math.pow(1 - clamp(nz), 3.2);

      // Ambient floor keeps face-on facets from going black; the fresnel term
      // is what makes raked edges catch the light and read as a bevel.
      const lit = mixRGB(
        mixRGB(shadow, key, clamp(0.17 + lambert * 0.8 + fres * 0.52)),
        rim,
        back * 0.42 * (0.35 + fres),
      );

      // Depth haze so the far side recedes instead of reading flat.
      const depth = (az + pz[i1] + pz[i2]) / 3;
      const fog = clamp(1 - (depth + R) / (R * 3.4));
      const final = mixRGB(pose.bg, lit, 0.3 + fog * 0.7);

      ctx.fillStyle = rgba(final, alpha);
      ctx.beginPath();
      ctx.moveTo(sx[i0], sy[i0]);
      ctx.lineTo(sx[i1], sy[i1]);
      ctx.lineTo(sx[i2], sy[i2]);
      ctx.closePath();
      ctx.fill();

      // A lit edge on strongly raked facets reads as a machined bevel.
      if (fres > 0.4 && alpha > 0.3) {
        ctx.strokeStyle = rgba(mixRGB(key, rim, 0.35), alpha * fres * 0.55);
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }
    }
  }

  private drawWire(ctx: CanvasRenderingContext2D, pose: CorePose): void {
    const alpha = pose.wire * pose.opacity;
    if (alpha <= 0.004) return;
    const { wireIndices, sx, sy, sz } = this;
    const R = this.radiusNow;
    const buckets = this.ghost ? 3 : 5;
    const paths: Path2D[] = [];
    for (let b = 0; b < buckets; b++) paths.push(new Path2D());

    const minZ = -R * 1.7;
    const span = R * 3.4;

    for (let s = 0; s < wireIndices.length; s += 2) {
      const i = wireIndices[s];
      const j = wireIndices[s + 1];
      const z = (sz[i] + sz[j]) / 2;
      const b = clamp(Math.floor(((z - minZ) / span) * buckets), 0, buckets - 1);
      const path = paths[b];
      path.moveTo(sx[i], sy[i]);
      path.lineTo(sx[j], sy[j]);
    }

    ctx.lineWidth = this.ghost ? 0.6 : 0.75;
    for (let b = buckets - 1; b >= 0; b--) {
      const t = (b + 0.5) / buckets;
      ctx.strokeStyle = rgba(mixRGB(pose.bg, pose.key, 0.3 + t * 0.7), alpha * (0.2 + t * 0.8));
      ctx.stroke(paths[b]);
    }
  }

  private drawPoints(ctx: CanvasRenderingContext2D, pose: CorePose): void {
    if (this.ghost) return;
    const alpha = Math.max(pose.dissolve, pose.solidity * 0.2) * pose.opacity;
    if (alpha <= 0.01) return;

    const { sx, sy, sz } = this;
    const vCount = (this.cols + 1) * (this.rows + 1);
    const R = this.radiusNow;
    const hot = mixRGB(pose.key, { r: 255, g: 255, b: 255 }, 0.5);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const size = 0.7 + pose.dissolve * 2.1;
    for (let v = 0; v < vCount; v++) {
      const t = clamp(0.5 + sz[v] / (R * 3.2));
      const s = size * (0.5 + t * 0.9);
      ctx.fillStyle = rgba(mixRGB(pose.bg, hot, 0.28 + t * 0.72), alpha * (0.2 + t * 0.8));
      ctx.fillRect(sx[v] - s / 2, sy[v] - s / 2, s, s);
    }
    ctx.restore();
  }

  /**
   * Perspective floor grid — the "surrounding geometry" that arrives with the
   * Orbital sequence and withdraws afterwards.
   */
  private drawGrid(ctx: CanvasRenderingContext2D, pose: CorePose): void {
    const alpha = pose.grid * pose.opacity;
    if (alpha <= 0.01 || this.ghost) return;

    const R = this.radiusNow;
    const horizon = this.centreY + R * 0.55;
    const vpx = this.centreX + pose.x * this.width * 0.4;
    const drop = Math.max(this.height - horizon, 40);
    const rows = 16;
    const cols = 22;
    const tint = mixRGB(pose.bg, pose.key, 0.75);

    ctx.save();
    ctx.lineWidth = 0.7;

    // Receding horizontals.
    for (let i = 1; i <= rows; i++) {
      const d = 1 + Math.pow(i / rows, 2.4) * 46;
      const y = horizon + drop / d;
      const fade = clamp(1 - (y - horizon) / drop) ** 1.4;
      ctx.strokeStyle = rgba(tint, alpha * 0.34 * fade);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
      ctx.stroke();
    }

    // Converging verticals.
    for (let c = -cols; c <= cols; c++) {
      const xBottom = vpx + (c / cols) * this.width * 0.9;
      const grad = ctx.createLinearGradient(vpx, horizon, xBottom, this.height);
      grad.addColorStop(0, rgba(tint, 0));
      grad.addColorStop(1, rgba(tint, alpha * 0.26));
      ctx.strokeStyle = grad;
      ctx.beginPath();
      ctx.moveTo(vpx, horizon);
      ctx.lineTo(xBottom, this.height);
      ctx.stroke();
    }

    // Horizon line.
    ctx.strokeStyle = rgba(tint, alpha * 0.5);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    ctx.lineTo(this.width, horizon);
    ctx.stroke();
    ctx.restore();
  }

  private drawSatellites(ctx: CanvasRenderingContext2D, pose: CorePose, idle: number): void {
    if (this.ghost || this.satelliteCount === 0) return;
    const strength = (0.22 + pose.bloom * 0.85) * pose.opacity;
    if (strength <= 0.01) return;

    // Orbit vectors are stored as unitless multiples of the object radius.
    const R = this.radiusNow * pose.debris;
    // Placement is authored as a fraction of the stage box, not in pixels.
    const ox = this.centreX + pose.x * this.width;
    const oy = this.centreY + pose.y * this.height;
    const cy = Math.cos(pose.yaw);
    const syw = Math.sin(pose.yaw);
    const cp = Math.cos(pose.pitch);
    const sp = Math.sin(pose.pitch);
    const cr = Math.cos(pose.roll);
    const sr = Math.sin(pose.roll);
    const spin = idle * 0.22;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.satelliteCount; i++) {
      const a = this.satAngle[i] + spin * (0.4 + (i % 7) * 0.14);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const lx = (this.satOrbit[i * 3] * ca - this.satOrbit[i * 3 + 2] * sa) * R;
      const ly = this.satOrbit[i * 3 + 1] * R;
      const lz = (this.satOrbit[i * 3] * sa + this.satOrbit[i * 3 + 2] * ca) * R;

      const x1 = lx * cy + lz * syw;
      const z1 = -lx * syw + lz * cy;
      const y2 = ly * cp - z1 * sp;
      const z2 = ly * sp + z1 * cp;
      const x3 = x1 * cr - y2 * sr;
      const y3 = x1 * sr + y2 * cr;

      const k = this.persp(z2);
      const t = clamp(0.5 + z2 / (R * 3.2));
      const s = this.satSize[i] * (0.6 + t);
      ctx.fillStyle = rgba(
        mixRGB(pose.bg, pose.key, 0.32 + t * 0.68),
        strength * (0.18 + t * 0.72),
      );
      ctx.fillRect(ox + x3 * k - s / 2, oy + y3 * k - s / 2, s, s);
    }
    ctx.restore();
  }

  private drawRings(ctx: CanvasRenderingContext2D, pose: CorePose, idle: number): void {
    const alpha = pose.ring * pose.opacity;
    if (alpha <= 0.01 || this.ghost) return;
    const R = this.radiusNow;
    // Placement is authored as a fraction of the stage box, not in pixels.
    const ox = this.centreX + pose.x * this.width;
    const oy = this.centreY + pose.y * this.height;
    const cy = Math.cos(pose.yaw);
    const syw = Math.sin(pose.yaw);
    const cp = Math.cos(pose.pitch);
    const sp = Math.sin(pose.pitch);
    const cr = Math.cos(pose.roll);
    const sr = Math.sin(pose.roll);

    ctx.save();
    ctx.lineWidth = 0.8;
    for (let r = 0; r < 3; r++) {
      const radius = R * (1.45 + r * 0.36);
      const incline = 0.5 + r * 0.42;
      const spin = idle * (0.1 + r * 0.05) + pose.yaw * (r % 2 === 0 ? 1 : -1);
      const path = new Path2D();
      const steps = 54;
      for (let s = 0; s <= steps; s++) {
        const a = (s / steps) * TAU + spin;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const lx = ca * radius;
        const ly = sa * radius * Math.cos(incline) * 0.4;
        const lz = sa * radius * Math.sin(incline);

        const x1 = lx * cy + lz * syw;
        const z1 = -lx * syw + lz * cy;
        const y2 = ly * cp - z1 * sp;
        const z2 = ly * sp + z1 * cp;
        const x3 = x1 * cr - y2 * sr;
        const y3 = x1 * sr + y2 * cr;
        const k = this.persp(z2);
        const sxp = ox + x3 * k;
        const syp = oy + y3 * k;
        if (s === 0) path.moveTo(sxp, syp);
        else path.lineTo(sxp, syp);
      }
      ctx.strokeStyle = rgba(
        mixRGB(pose.bg, pose.rim, 0.5 + r * 0.14),
        alpha * (0.52 - r * 0.12),
      );
      ctx.stroke(path);
    }
    ctx.restore();
  }

  private drawScanPlane(ctx: CanvasRenderingContext2D, pose: CorePose, idle: number): void {
    const alpha = pose.scan * pose.opacity;
    if (alpha <= 0.01 || this.ghost) return;
    const R = this.radiusNow;
    // Placement is authored as a fraction of the stage box, not in pixels.
    const ox = this.centreX + pose.x * this.width;
    const oy = this.centreY + pose.y * this.height;
    const cy = Math.cos(pose.yaw);
    const syw = Math.sin(pose.yaw);
    const cp = Math.cos(pose.pitch);
    const sp = Math.sin(pose.pitch);
    const cr = Math.cos(pose.roll);
    const sr = Math.sin(pose.roll);
    const planeY = pose.scanY * R * 1.55;
    const sweep = idle * 0.4;

    const path = (radius: number, phase: number): Path2D => {
      const p = new Path2D();
      const steps = 46;
      for (let s = 0; s <= steps; s++) {
        const ang = (s / steps) * TAU + phase;
        const lx = Math.cos(ang) * radius;
        const lz = Math.sin(ang) * radius;
        const x1 = lx * cy + lz * syw;
        const z1 = -lx * syw + lz * cy;
        const y2 = planeY * cp - z1 * sp;
        const z2 = planeY * sp + z1 * cp;
        const x3 = x1 * cr - y2 * sr;
        const y3 = x1 * sr + y2 * cr;
        const k = this.persp(z2);
        const sxp = ox + x3 * k;
        const syp = oy + y3 * k;
        if (s === 0) p.moveTo(sxp, syp);
        else p.lineTo(sxp, syp);
      }
      return p;
    };

    ctx.save();
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = rgba(mixRGB(pose.key, { r: 255, g: 255, b: 255 }, 0.3), alpha * 0.5);
    ctx.stroke(path(R * 1.45, sweep));
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = rgba(pose.key, alpha * 0.28);
    ctx.stroke(path(R * 1.05, sweep * 1.3));
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = rgba({ r: 255, g: 255, b: 255 }, alpha * 0.2);
    ctx.stroke(path(R * 1.24, sweep * 2.1));
    ctx.restore();
  }

  /* ------------------------------------------------------------------ frame */

  draw(
    ctx: CanvasRenderingContext2D,
    pose: CorePose,
    size: { width: number; height: number },
    idle: number,
    grainOffset = 0,
  ): void {
    const { width, height } = size;
    this.width = width;
    this.height = height;
    this.centreX = width / 2;
    this.centreY = height / 2;
    this.updateCamera(pose);

    this.drawAtmosphere(ctx, pose, width, height, grainOffset);
    if (pose.opacity <= 0.004) return;

    ctx.save();
    ctx.globalAlpha = clamp(pose.opacity);
    this.project(pose, idle);
    this.sortFaces();
    this.drawGrid(ctx, pose);
    this.drawSatellites(ctx, pose, idle);
    this.drawRings(ctx, pose, idle);
    this.drawScanPlane(ctx, pose, idle);
    this.drawFaces(ctx, pose);
    this.drawWire(ctx, pose);
    this.drawPoints(ctx, pose);
    ctx.restore();
  }
}
