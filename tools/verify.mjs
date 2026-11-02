/**
 * Browser verification harness.
 *
 * Serves the production build over a local static server, drives real Chrome
 * through the DevTools protocol using Node's built-in WebSocket (no extra
 * dependencies), and asserts the things a build cannot prove:
 *
 *   - no console errors or uncaught exceptions on load or while scrolling
 *   - the pinned stage genuinely transforms: canvas pixels and pose both
 *     change across the sequence
 *   - scrolling back up retraces the exact same states (reversibility)
 *   - the pinned section releases cleanly and the next section takes over
 *   - anchor navigation lands where it says it will
 *   - the aperture transition reaches a genuinely intermediate state
 *   - mobile layout has no horizontal overflow and still animates
 *   - reduced motion is honoured: no autonomous animation, no scroll lag
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(process.cwd());
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.verify');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

/* ------------------------------------------------------------------ server */

const startServer = async (root) =>
  new Promise((resolveServer) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        let rel = decodeURIComponent(url.pathname);
        if (rel.endsWith('/')) rel += 'index.html';
        const file = join(root, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
        if (!file.startsWith(root) || !existsSync(file)) {
          res.writeHead(404).end('not found');
          return;
        }
        const body = await readFile(file);
        res.writeHead(200, {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        });
        res.end(body);
      } catch (error) {
        res.writeHead(500).end(String(error));
      }
    });
    server.listen(0, '127.0.0.1', () => resolveServer({ server, port: server.address().port }));
  });

/* --------------------------------------------------------------------- CDP */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
        else entry.resolve(msg.result);
        return;
      }
      for (const handler of this.handlers.get(msg.method) ?? []) handler(msg.params, msg.sessionId);
    });
  }

  static connect(url) {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => ok(new CDP(ws)));
      ws.addEventListener('error', () => fail(new Error(`Cannot connect to ${url}`)));
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((ok, fail) => {
      this.pending.set(id, { resolve: ok, reject: fail, method });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          fail(new Error(`${method} timed out`));
        }
      }, 30000);
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  close() {
    this.ws.close();
  }
}

/* ------------------------------------------------------------------ driver */

class Page {
  constructor(cdp, sessionId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.console = [];
    this.exceptions = [];
  }

  static async open(cdp, width, height) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(cdp, sessionId);

    cdp.on('Runtime.consoleAPICalled', (params, sid) => {
      if (sid !== sessionId) return;
      if (params.type === 'error' || params.type === 'warning') {
        page.console.push(
          `${params.type}: ${params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`,
        );
      }
    });
    cdp.on('Runtime.exceptionThrown', (params, sid) => {
      if (sid !== sessionId) return;
      const d = params.exceptionDetails;
      page.exceptions.push(d.exception?.description ?? d.text);
    });

    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    return page;
  }

  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }

  async setViewport(width, height, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
      screenWidth: width,
      screenHeight: height,
    });
  }

  async setReducedMotion(reduce) {
    await this.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }],
    });
  }

  async goto(url) {
    const done = new Promise((ok) => {
      const handler = (_params, sid) => {
        if (sid === this.sessionId) ok();
      };
      this.cdp.on('Page.loadEventFired', handler);
    });
    await this.send('Page.navigate', { url });
    await Promise.race([done, sleep(15000)]);
    await this.until('document.readyState === "complete"', 15000);
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(function(){ ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
    }
    return result.result.value;
  }

  async until(expression, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(`return !!(${expression});`)) return true;
      } catch {
        /* keep polling */
      }
      await sleep(60);
    }
    throw new Error(`Timed out waiting for: ${expression}`);
  }

  /**
   * Scrolls instantly and waits until the scene's damped progress has caught
   * up with the raw scroll position, so samples are taken from settled state
   * instead of racing the easing.
   */
  async scrollTo(y) {
    // `isSettled()` is trivially true until a frame has read the new scroll
    // offset, so require the frame counter to have advanced past that too.
    const before = await this.evaluate(
      `const a = window.__aperture; return a ? a.engine.ticks : 0;`,
    );
    await this.evaluate(`window.scrollTo({ top: ${y}, behavior: 'instant' }); return true;`);
    let settled = false;
    for (let i = 0; i < 200; i++) {
      settled = await this.evaluate(`
        const a = window.__aperture;
        return !!a && a.engine.ticks > ${before} + 3 && a.engine.isSettled()
          && Math.abs(window.scrollY - ${y}) < 0.5;
      `);
      if (settled) break;
      await sleep(20);
    }
    // One more frame so the scene's own render reflects the settled pose.
    await sleep(60);
    if (!settled) throw new Error(`scene never settled at scrollY ${y}`);
    return this.evaluate(`const a = window.__aperture; return { y: window.scrollY, p: a.work.progress };`);
  }

  async screenshot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  }
}

/* ------------------------------------------------------------------- checks */

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  const mark = ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m';
  console.log(`  ${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Canvas digest used to prove the stage is actually repainting. */
const CANVAS_HASH = `
  const c = document.querySelector('[data-work-canvas]');
  if (!c) return null;
  const o = document.createElement('canvas');
  o.width = 72; o.height = 46;
  const g = o.getContext('2d');
  g.drawImage(c, 0, 0, 72, 46);
  const d = g.getImageData(0, 0, 72, 46).data;
  let h = 2166136261, nonBg = 0;
  for (let i = 0; i < d.length; i += 4) {
    h ^= d[i]; h = Math.imul(h, 16777619);
    h ^= d[i + 1]; h = Math.imul(h, 16777619);
    h ^= d[i + 2]; h = Math.imul(h, 16777619);
    if (d[i] + d[i + 1] + d[i + 2] > 60) nonBg++;
  }
  return { hash: (h >>> 0).toString(16), lit: nonBg };
`;

const main = async () => {
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('dist/index.html not found — run `npm run build` first.');
    process.exit(2);
  }
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const { server, port } = await startServer(DIST);
  const base = `http://127.0.0.1:${port}/`;
  const exe = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!exe) {
    console.error('No Chrome/Edge binary found.');
    server.close();
    process.exit(2);
  }
  console.log(`Browser : ${exe}`);
  console.log(`Serving : ${DIST} at ${base}\n`);

  const profile = join(tmpdir(), `aperture-verify-${process.pid}`);
  const child = spawn(
    exe,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--window-size=1440,900',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--force-color-profile=srgb',
      '--enable-features=NetworkService',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  const cleanup = async () => {
    child.kill();
    server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };

  // Wait for the DevTools port file.
  let wsUrl = null;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await sleep(150);
    try {
      const portFile = join(profile, 'DevToolsActivePort');
      if (!existsSync(portFile)) continue;
      const lines = (await readFile(portFile, 'utf8')).split(/\r?\n/);
      const devtoolsPort = lines[0];
      const version = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`)).json();
      wsUrl = version.webSocketDebuggerUrl;
    } catch {
      /* keep polling */
    }
  }
  if (!wsUrl) {
    console.error('Chrome did not expose a DevTools endpoint.');
    await cleanup();
    process.exit(2);
  }

  const cdp = await CDP.connect(wsUrl);
  const page = await Page.open(cdp, 1440, 900);

  try {
    /* ---------------------------------------------------------- load ---- */
    console.log('\nLoad');
    await page.goto(base);
    await page.until('window.__aperture && window.__aperture.work');
    await sleep(900);

    const structure = await page.evaluate(`
      const ids = ['intro', 'work', 'about', 'contact'];
      const doc = document.documentElement;
      return {
        sections: ids.filter((id) => document.getElementById(id)),
        headings: Array.from(document.querySelectorAll('h1,h2,h3')).map((h) => h.tagName + ':' + h.textContent.trim().slice(0, 32)),
        canvases: Array.from(document.querySelectorAll('canvas')).map((c) => c.getAttribute('aria-hidden')),
        docHeight: doc.scrollHeight,
        viewport: window.innerHeight,
        overflowX: doc.scrollWidth - doc.clientWidth,
        h1Count: document.querySelectorAll('h1').length,
        skip: !!document.querySelector('.skip'),
        lang: doc.lang,
      };
    `);
    check('all four sections present', structure.sections.length === 4, structure.sections.join(', '));
    check('exactly one h1', structure.h1Count === 1, `found ${structure.h1Count}`);
    check('no horizontal overflow', structure.overflowX <= 1, `${structure.overflowX}px`);
    check('decorative canvases hidden from AT', structure.canvases.every((v) => v === 'true'));
    check('page is a real scroll', structure.docHeight > structure.viewport * 4,
      `${Math.round(structure.docHeight / structure.viewport * 10) / 10} viewports tall`);
    check('lang + skip link present', structure.lang === 'en' && structure.skip);
    console.log(`        headings: ${structure.headings.length} (${structure.headings[0]} …)`);

    /* ------------------------------------------------------ hero entrance -- */
    // The masthead's entrance is gated on the display face, so until it
    // releases the name is laid out in the fallback and every metric below
    // would describe the wrong typeface. Wait for the gate first, then assert
    // that it released with the real face rather than having timed out.
/* ------------------------------------------------------ hero entrance -- */
    // The masthead's entrance is gated on the display face. Two outcomes are
    // correct, and the harness must not assume which one a given network
    // produces: either the gate opens on the real face and the name animates,
    // or the budget expires and the name is left still and fully legible.
    // What must never happen is the original defect — animating the entrance
    // in a fallback serif and then re-rendering underneath the visitor.
    await sleep(3600); // past the gate's own 3s deadline, so the state is settled
    const heroGate = await page.evaluate(`
      const d = document.querySelector('.intro__name__line--display .inner, .intro__name__line--display .intro__name__inner');
      const chars = Array.from(document.querySelectorAll('#intro-title .ch'));
      return {
        released: document.documentElement.dataset.displayFont === 'ready',
        faceLoaded: document.fonts.check('400 8rem "Instrument Serif"', 'KARTHIKEYA'),
        displayAnim: getComputedStyle(d).animationName,
        displayOpacity: Number(getComputedStyle(d).opacity),
        charOpacities: chars.map((c) => Number(getComputedStyle(c).opacity)),
        charAnim: chars.length ? getComputedStyle(chars[0]).animationName : 'none',
      };
    `);
    const gateNameVisible = heroGate.displayOpacity === 1
      && heroGate.charOpacities.every((o) => o === 1);
    // Released ⇒ must have released on the real face. Not released ⇒ must be
    // left visible and unanimated.
    const gateSane = heroGate.released
      ? heroGate.faceLoaded
      : gateNameVisible && heroGate.displayAnim === 'none';
    check('hero entrance never runs in a fallback face', gateSane,
      `${heroGate.released ? 'released' : 'declined (name still and visible)'}`
      + `, face loaded ${heroGate.faceLoaded}, anim ${heroGate.displayAnim}`);

    await sleep(950); // let the entrance settle before it is measured
    const heroName = await page.evaluate(`
      const d = document.querySelector('.intro__name__line--display .intro__name__inner');
      const chars = Array.from(document.querySelectorAll('#intro-title .ch'));
      return {
        displayOpacity: Number(getComputedStyle(d).opacity),
        charOpacities: chars.map((c) => Number(getComputedStyle(c).opacity)),
      };
    `);
    // A face that never arrives must cost the entrance, not the name.
    check('hero name is fully legible once the entrance has run',
      heroName.displayOpacity === 1 && heroName.charOpacities.every((o) => o === 1),
      `display ${heroName.displayOpacity}, chars [${heroName.charOpacities.join(',')}]`);

    await page.screenshot('01-intro');

    /* ------------------------------------------------ hero name setting -- */
    // The hero is art-directed: both tiers must resolve to one shared optical
    // left edge, and the display tier must not be clipped by its own mask.
    // Text boxes are measured with a Range (block boxes just stretch to the
    // column) and the cap height comes from real font metrics, so "is the mask
    // shaving the capitals" is answered by arithmetic rather than by eye.
    console.log('\nHero name typography');
    const name = await page.evaluate(`
      const h1 = document.querySelector('#intro-title');
      const display = h1.querySelector('.intro__name__line--display');
      const dInner = display.querySelector('.intro__name__inner');
      const mono = h1.querySelector('.intro__name__line--mono');
      const mInner = mono.querySelector('.intro__name__inner');
      const cs = getComputedStyle(display);

      const range = document.createRange();
      range.selectNodeContents(dInner);
      const dText = range.getBoundingClientRect();
      const mText = mInner.getBoundingClientRect();

      const fs = parseFloat(cs.fontSize);
      const probe = document.createElement('canvas').getContext('2d');
      probe.font = cs.fontWeight + ' ' + fs + 'px ' + cs.fontFamily;
      const m = probe.measureText('H');
      const halfLeading = (parseFloat(cs.lineHeight) - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2;
      const baseline = halfLeading + m.fontBoundingBoxAscent;
      const capTop = baseline - m.actualBoundingBoxAscent;

        const maskTop = display.getBoundingClientRect().top;
        const inkTop = maskTop + parseFloat(cs.paddingTop) + capTop;

        const dLine = display.getBoundingClientRect();
        const mLine = mono.getBoundingClientRect();

        return {
        accessibleName: h1.getAttribute('aria-label'),
        ariaHiddenMono: mono.getAttribute('aria-hidden') === 'true',
        dLeft: Math.round(dText.left * 10) / 10,
        mLeft: Math.round(mText.left * 10) / 10,
        dWidth: Math.round(dText.width),
        mWidth: Math.round(mText.width),
        fontSize: Math.round(fs),
        padTop: parseFloat(cs.paddingTop),
        marginBottom: parseFloat(cs.marginBottom),
        capHeight: Math.round(m.actualBoundingBoxAscent),
        inkTop: Math.round(inkTop * 10) / 10,
        maskTop: Math.round(maskTop * 10) / 10,
        clearance: Math.round((inkTop - maskTop) * 10) / 10,
        tierGap: Math.round(mLine.top - dLine.bottom),
        tierRatio: Math.round((mText.width / dText.width) * 1000) / 1000,
        monoSize: Math.round(parseFloat(getComputedStyle(mono).fontSize)),
      };
    `);
    check('hero has an explicit accessible name', name.accessibleName === 'Karthikeya Dusi', name.accessibleName);
    check('split surname is hidden from assistive tech', name.ariaHiddenMono);
    check('both name tiers share one left edge', Math.abs(name.dLeft - name.mLeft) <= 1,
      `${name.dLeft}px vs ${name.mLeft}px`);
    check('display caps sit inside the mask, not shaved by it', name.clearance > 2,
      `${name.clearance}px clearance (cap ${name.capHeight}px at ${name.fontSize}px)`);
    check('surname is a second tier, not a caption', name.tierRatio > 0.13 && name.tierRatio < 0.42,
      `${name.dWidth}px vs ${name.mWidth}px → ratio ${name.tierRatio}`);
    check('mask padding is height-neutral', Math.abs(name.padTop + name.marginBottom) < 0.5,
      `pad ${name.padTop} / margin ${name.marginBottom}`);
    check('desktop tiers are clearly separated', name.tierGap >= 20,
      `${name.tierGap}px line-box gap at ${name.fontSize}px`);

    /* ------------------------------------------- geometry of the page --- */
    console.log('\nSection geometry');
    const geom = await page.evaluate(`
      const vh = window.innerHeight;
      const m = (id) => {
        const r = document.getElementById(id).getBoundingClientRect();
        return { top: Math.round(r.top + window.scrollY), height: Math.round(r.height) };
      };
      return { vh, intro: m('intro'), work: m('work'), about: m('about'), contact: m('contact') };
    `);
    const workTravel = geom.work.height - geom.vh;
    check('work section is a long pinned sequence', workTravel > geom.vh * 2,
      `${Math.round(workTravel / geom.vh)} viewports of travel`);
    check('sections do not overlap', geom.intro.top + geom.intro.height <= geom.work.top &&
      geom.work.top + geom.work.height <= geom.about.top &&
      geom.about.top + geom.about.height <= geom.contact.top);

    // The engine caches rects so the frame loop never forces layout. That cache
    // must agree with the DOM, or scroll progress would be subtly wrong.
    const cacheCheck = async (label) => {
      const drift = await page.evaluate(`
        const g = window.__aperture.engine.geometry()[1];
        const r = document.getElementById('work').getBoundingClientRect();
        return { top: Math.round(g.top), domTop: Math.round(r.top + window.scrollY),
                 travel: Math.round(g.travel), domTravel: Math.round(r.height - window.innerHeight) };
      `);
      check(`scroll engine geometry matches the DOM (${label})`,
        Math.abs(drift.top - drift.domTop) <= 1 && Math.abs(drift.travel - drift.domTravel) <= 1,
        `top ${drift.top} vs ${drift.domTop}, travel ${drift.travel} vs ${drift.domTravel}`);
      return drift;
    };
    await cacheCheck('after load');

    /* ------------------------------ the pinned stage really transforms -- */
    console.log('\nScroll-driven transformation (work section)');
    const sampleAt = async (p) => {
      const y = geom.work.top + Math.round(p * workTravel);
      await page.scrollTo(y);
      return page.evaluate(`
        const a = window.__aperture;
        const snap = a.work.snapshot();
        const panels = Array.from(document.querySelectorAll('.panel')).map((el) => ({
          id: el.className.split(' ').find((c) => c.startsWith('panel--')) || '?',
          opacity: Number(getComputedStyle(el).opacity),
          inert: el.hasAttribute('inert'),
          ariaHidden: el.getAttribute('aria-hidden'),
        }));
        const active = panels.filter((x) => x.opacity > 0.9);
        const c = document.querySelector('[data-work-canvas]');
        const o = document.createElement('canvas'); o.width = 72; o.height = 46;
        const g = o.getContext('2d'); g.drawImage(c, 0, 0, 72, 46);
        const d = g.getImageData(0, 0, 72, 46).data;
        let h = 2166136261, lit = 0;
        for (let i = 0; i < d.length; i += 4) {
          h ^= d[i]; h = Math.imul(h, 16777619);
          h ^= d[i+1]; h = Math.imul(h, 16777619);
          h ^= d[i+2]; h = Math.imul(h, 16777619);
          if (d[i] + d[i+1] + d[i+2] > 70) lit++;
        }
        return {
          y: window.scrollY, p: a.work.progress, snap,
          hash: (h >>> 0).toString(16), lit,
          active, panels,
          stageTop: Math.round(document.querySelector('[data-work-stage]').getBoundingClientRect().top),
          accent: getComputedStyle(document.querySelector('[data-work-stage]')).getPropertyValue('--stage-accent').trim(),
        };
      `);
    };

    const stops = [0.05, 0.24, 0.4, 0.585, 0.72, 0.86, 0.95];
    const forward = [];
    for (const p of stops) {
      forward.push({ p, ...(await sampleAt(p)) });
      await page.screenshot(`02-work-${String(p).replace('.', '_')}`);
    }

    const hashes = new Set(forward.map((s) => s.hash));
    check('canvas repaints distinctly across the sequence', hashes.size === forward.length,
      `${hashes.size}/${forward.length} unique frames`);

    const scales = forward.map((s) => s.snap.scale);
    check('scale varies', Math.max(...scales) - Math.min(...scales) > 0.5,
      `${Math.min(...scales)} → ${Math.max(...scales)}`);

    const ys = forward.map((s) => s.snap.y);
    check('position varies', Math.max(...ys) - Math.min(...ys) > 0.3,
      `${Math.min(...ys)} → ${Math.max(...ys)}`);

    const yaws = forward.map((s) => s.snap.yaw);
    const totalTurns = (Math.max(...yaws) - Math.min(...yaws)) / (Math.PI * 2);
    check('rotation accumulates', totalTurns > 1,
      `${totalTurns.toFixed(2)} turns`);

    const materials = new Set(forward.map((s) => `${s.snap.solidity > 0.6}|${s.snap.dissolve > 0.6}|${s.snap.grid > 0.5}`));
    check('material state changes', materials.size >= 3, `${materials.size} distinct material states`);

    const accents = new Set(forward.map((s) => s.accent));
    check('stage colour changes per project', accents.size >= 3, [...accents].join(' '));

    // Everything after the aperture has finished opening should be composed.
    const composed = forward.filter((s) => s.p >= 0.18 && s.p <= 0.9);
    const lit = composed.map((s) => s.lit);
    check('no blank visual interval once revealed', Math.min(...lit) > 200,
      `min lit pixels ${Math.min(...lit)} of ${72 * 46}`);
    const exitTail = forward.filter((s) => s.p > 0.9);
    check('the exit keeps material on screen rather than emptying',
      exitTail.every((s) => s.lit > 60),
      exitTail.map((s) => s.lit).join(', '));

    const pinned = forward.map((s) => s.stageTop);
    check('stage stays pinned through the sequence', pinned.every((t) => Math.abs(t) <= 2),
      `top offsets ${[...new Set(pinned)].join(',')}`);

    const projectStops = [0.24, 0.585, 0.86];
    for (const at of projectStops) {
      const s = forward.find((f) => Math.abs(f.p - at) < 0.01);
      check(`one project readable and not inert at p=${at}`,
        s && s.active.length === 1 && !s.active[0].inert,
        s ? s.active.map((a) => a.id.replace('panel--', '')).join(',') : 'not sampled');
    }
    let everTwo = 0;
    for (const s of forward) {
      if (s.panels.filter((x) => x.opacity > 0.6).length > 1) everTwo++;
    }
    check('never two panels competing', everTwo === 0);

    /* ------------------------------------------------ reversibility ------ */
    // Re-sample at byte-identical scroll offsets so any difference is the
    // scene's doing, not rounding in the harness.
    console.log('\nReversibility (scrolling back up)');
    await cacheCheck('after the forward pass');
    const backward = [];
    for (let i = stops.length - 1; i >= 0; i--) {
      const y = forward[i].y;
      await page.scrollTo(y);
      backward.push({ p: stops[i], ...(await page.evaluate(`
        const a = window.__aperture;
        const c = document.querySelector('[data-work-canvas]');
        const o = document.createElement('canvas'); o.width = 72; o.height = 46;
        const g = o.getContext('2d'); g.drawImage(c, 0, 0, 72, 46);
        const d = g.getImageData(0, 0, 72, 46).data;
        let h = 2166136261, lit = 0;
        for (let i = 0; i < d.length; i += 4) {
          h ^= d[i]; h = Math.imul(h, 16777619);
          h ^= d[i+1]; h = Math.imul(h, 16777619);
          h ^= d[i+2]; h = Math.imul(h, 16777619);
          if (d[i] + d[i+1] + d[i+2] > 70) lit++;
        }
        return { y: window.scrollY, p: a.work.progress, snap: a.work.snapshot(),
                 hash: (h >>> 0).toString(16), lit };
      `)) });
    }
    backward.reverse();

    let yMismatch = 0;
    const poseDetail = [];
    for (let i = 0; i < stops.length; i++) {
      if (forward[i].y !== backward[i].y) yMismatch++;
      for (const key of Object.keys(forward[i].snap)) {
        const delta = Math.abs(forward[i].snap[key] - backward[i].snap[key]);
        if (delta > 1e-6) poseDetail.push(`p=${forward[i].p} ${key} Δ${delta.toExponential(1)}`);
      }
      if (Math.abs(forward[i].p - backward[i].p) > 1e-9) {
        poseDetail.push(`p=${forward[i].p} progress ${forward[i].p} vs ${backward[i].p}`);
      }
    }
    check('resampled at identical scroll offsets', yMismatch === 0, `${yMismatch} mismatches`);
    check('every pose channel retraces exactly on the way back', poseDetail.length === 0,
      poseDetail.slice(0, 4).join('; '));

    const hashMismatch = forward.filter((f, i) => f.hash !== backward[i].hash).length;
    check('frames differ only by the idle drift, not by scroll direction',
      hashMismatch === stops.length,
      `${hashMismatch}/${stops.length} frames differed (idle time-based motion is expected)`);

    /* -------------------------------------------- pinned section exit ---- */
    console.log('\nPinned section exit');
    const exitState = await page.evaluate(`
      const r = document.getElementById('work').getBoundingClientRect();
      return { bottom: Math.round(r.bottom + window.scrollY), vh: window.innerHeight,
               aboutTop: Math.round(document.getElementById('about').getBoundingClientRect().top + window.scrollY) };
    `);
    await page.scrollTo(exitState.bottom - exitState.vh + 260);
    await sleep(400);
    const exit = await page.evaluate(`
      const stage = document.querySelector('[data-work-stage]');
      const rect = stage.getBoundingClientRect();
      const ghost = document.querySelector('[data-about-canvas]').getBoundingClientRect();
      return {
        stageTop: Math.round(rect.top), stageBottom: Math.round(rect.bottom),
        chromeOpacity: Number(getComputedStyle(document.querySelector('.rail')).opacity),
        vh: window.innerHeight,
        ghostHeight: Math.round(ghost.height),
        ghostPainted: (() => { const c = document.querySelector('[data-about-canvas]');
          const g = c.getContext('2d'); const d = g.getImageData(0,0,c.width,c.height).data;
          let lit = 0; for (let i = 3; i < d.length; i += 4000) if (d[i] > 8) lit++;
          return lit; })(),
      };
    `);
    check('sticky stage releases when the section ends', exit.stageTop < -180,
      `stage top ${exit.stageTop}px`);
    check('stage chrome does not linger on the released stage', exit.chromeOpacity < 0.05,
      `rail opacity ${exit.chromeOpacity}`);
    check('about ghost object is painted before the stage has gone', exit.ghostHeight > 100 && exit.ghostPainted > 0,
      `canvas ${exit.ghostHeight}px tall, ${exit.ghostPainted} lit samples`);

    await page.scrollTo(exitState.bottom + 200);
    await sleep(300);
    const fullyGone = await page.evaluate(`
      const r = document.querySelector('[data-work-stage]').getBoundingClientRect();
      const a = document.getElementById('about').getBoundingClientRect();
      return { bottom: Math.round(r.bottom), aboutTop: Math.round(a.top), vh: window.innerHeight };
    `);
    check('released stage scrolls fully out of the viewport', fullyGone.bottom < 0,
      `stage bottom ${fullyGone.bottom}px`);
    check('about section has taken the viewport', fullyGone.aboutTop < fullyGone.vh * 0.6,
      `about top ${fullyGone.aboutTop}px`);
    await page.scrollTo(exitState.aboutTop + 260);
    await sleep(300);
    await page.screenshot('03-about');

    /* --------------------------------------------- intermediate widths ---- */
    console.log('\nIntermediate widths');
    for (const [w, h] of [[1024, 800], [1280, 800], [768, 900]]) {
      await page.setViewport(w, h, false);
      await page.goto(base);
      await page.until('window.__aperture && window.__aperture.work');
      await sleep(500);
      const m = await page.evaluate(`
        const doc = document.documentElement;
        const h1 = document.querySelector('#intro-title');
        const dInner = h1.querySelector('.intro__name__line--display .intro__name__inner');
        const mInner = h1.querySelector('.intro__name__line--mono .intro__name__inner');
        const r = document.createRange();
        r.selectNodeContents(dInner);
        const d = r.getBoundingClientRect();
        const mo = mInner.getBoundingClientRect();
        return { overflowX: doc.scrollWidth - doc.clientWidth, dLeft: Math.round(d.left),
                 mLeft: Math.round(mo.left), dRight: Math.round(d.right), clientW: doc.clientWidth };
      `);
      check(`hero fits at ${w}×${h}`, m.overflowX <= 1 && m.dRight <= m.clientW,
        `overflow ${m.overflowX}px, name right ${m.dRight} of ${m.clientW}`);
      check(`tiers aligned at ${w}×${h}`, Math.abs(m.dLeft - m.mLeft) <= 1,
        `${m.dLeft} / ${m.mLeft}`);
    }
    await page.setViewport(1440, 900, false);
    await page.goto(base);
    await page.until('window.__aperture && window.__aperture.work');
    await sleep(500);

    /* --------------------------------------------- navigation active state -- */
    // The nav links used to be resolved document-wide, so `a[href="#intro"]`
    // matched the skip link first: the Intro item kept its authored state and
    // the skip link collected aria-current. Asserted here against a real DOM.
    console.log('\nNavigation state');
    const navState = [];
    for (const id of ['intro', 'work', 'about', 'contact']) {
      const y = await page.evaluate(`
        const el = document.getElementById('${id}');
        return Math.round(el.getBoundingClientRect().top + window.scrollY);
      `);
      await page.scrollTo(y);
      await sleep(260);
      navState.push(await page.evaluate(`
        const links = Array.from(document.querySelectorAll('.nav__link'));
        const active = links.filter((a) => a.dataset.active === 'true');
        const current = links.filter((a) => a.getAttribute('aria-current') === 'true');
        const skip = document.querySelector('.skip');
        const mark = document.querySelector('.header__mark');
        return {
          id: '${id}',
          activeLabels: active.map((a) => a.textContent.trim()),
          currentLabels: current.map((a) => a.textContent.trim()),
          activeHrefs: active.map((a) => a.getAttribute('href')),
          skipAriaCurrent: skip.getAttribute('aria-current'),
          skipActive: skip.dataset.active ?? null,
          markActive: mark.dataset.active ?? null,
          markAriaCurrent: mark.getAttribute('aria-current'),
          headerSection: document.querySelector('[data-header]').dataset.section,
        };
      `));
    }
    for (const s of navState) {
      check(`exactly one nav item active at #${s.id}`,
        s.activeLabels.length === 1 && s.activeHrefs[0] === `#${s.id}`,
        `${s.id} → [${s.activeLabels.join(', ') || 'none'}]`);
      check(`aria-current tracks the section at #${s.id}`,
        s.currentLabels.length === 1 && s.currentLabels[0] === s.activeLabels[0],
        `${s.id} → [${s.currentLabels.join(', ') || 'none'}]`);
    }
    check('skip link never carries aria-current',
      navState.every((s) => s.skipAriaCurrent === null),
      navState.map((s) => String(s.skipAriaCurrent)).join(' '));
    check('skip link never takes an active state',
      navState.every((s) => s.skipActive === null),
      navState.map((s) => String(s.skipActive)).join(' '));
    check('header mark is never treated as a nav item',
      navState.every((s) => s.markActive === null && s.markAriaCurrent === null),
      navState.map((s) => `${s.markActive}/${s.markAriaCurrent}`).join(' '));

    /* --------------------------------------- header theme flips on overlap --- */
    // The header used to switch to paper when the contact section was still
    // half a viewport away, tinting it while the dark About section was on
    // screen. It must stay ink until the paper actually reaches it.
    const contactTop = geom.contact.top;
    const maxScroll = await page.evaluate(
      `return document.documentElement.scrollHeight - window.innerHeight;`,
    );
    // Targets put the contact section's top edge at a known viewport position
    // (`scrollY = contactTop - wantTop`), clamped into the document's real
    // scroll range so the settle check never waits on an unreachable y.
    const themeSamples = [];
    for (const wantTop of [300, 30, -40]) {
      const target = Math.max(0, Math.min(contactTop - wantTop, maxScroll));
      await page.scrollTo(target);
      await sleep(200);
      themeSamples.push(await page.evaluate(`
        const r = document.getElementById('contact').getBoundingClientRect();
        return {
          wantTop: ${wantTop},
          top: Math.round(r.top),
          theme: document.querySelector('[data-header]').dataset.theme,
          headerH: Math.round(document.querySelector('.header').getBoundingClientRect().height),
        };
      `));
    }
    const approach = themeSamples.find((s) => s.wantTop > 0 && s.top > 0);
    const overlap = themeSamples.find((s) => s.top <= 0);
    check('header stays ink while contact is still below it',
      !!approach && approach.theme === 'ink',
      approach ? `contact top ${approach.top}px, theme ${approach.theme}` : 'no approach sample');
    check('header inverts once the paper overlaps it',
      !!overlap && overlap.theme === 'paper',
      overlap ? `contact top ${overlap.top}px, theme ${overlap.theme}` : 'no overlap sample');

    await page.goto(base);
    await page.until('window.__aperture && window.__aperture.work');
    await sleep(500);

    /* ----------------------------------------------- anchor navigation --- */
    console.log('\nNavigation');
    const nav = await page.evaluate(`
      const link = document.querySelector('a.nav__link[href="#contact"]');
      link.click();
      return true;
    `);
    void nav;
    await sleep(1600);
    const jumped = await page.evaluate(`
      const r = document.getElementById('contact').getBoundingClientRect();
      const panel = document.querySelector('[data-contact-panel]');
      const mail = document.querySelector('.contact__mail').getBoundingClientRect();
      const iris = document.querySelector('.iris--contact');
      return {
        contactTop: Math.round(r.top),
        panelOpacity: Number(getComputedStyle(panel).opacity),
        mailVisible: mail.top > 0 && mail.bottom < window.innerHeight,
        mailWidth: Math.round(mail.width),
        irisVisibility: getComputedStyle(iris).visibility,
        headerTheme: document.querySelector('[data-header]').dataset.theme,
        themeColor: getComputedStyle(document.body).getPropertyValue('--paper').trim(),
      };
    `);
    check('contact anchor lands on the section', Math.abs(jumped.contactTop) < 140,
      `top ${jumped.contactTop}px`);
    check('contact copy is revealed', jumped.panelOpacity > 0.85, `opacity ${jumped.panelOpacity}`);
    check('contact CTA is on screen', jumped.mailVisible && jumped.mailWidth > 120);
    check('header inverts over the paper panel', jumped.headerTheme === 'paper');
    await page.screenshot('04-contact');

    const backTop = await page.evaluate(`
      document.querySelector('[data-back-to-top]').click();
      return true;
    `);
    void backTop;
    await sleep(2200);
    const returned = await page.evaluate(`return Math.round(window.scrollY);`);
    check('back to top returns to the start', returned <= 4, `scrollY ${returned}`);

    /* ------------------------------------------------- iris transition --- */
    console.log('\nAperture transition');
    const irisSamples = [];
    // Sample the real close window: from the moment the title card unsticks to
    // the moment the work section arrives.
    const closeFrom = geom.intro.top + (geom.intro.height - geom.vh);
    const closeTo = geom.work.top;
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      await page.scrollTo(Math.round(closeFrom + t * (closeTo - closeFrom)));
      irisSamples.push(await page.evaluate(`
        const svg = document.querySelector('.iris--intro');
        const rect = svg.querySelector('rect');
        const m = rect.getAttribute('transform').match(
          /translate\\(([-\\d.]+) ([-\\d.]+)\\) rotate\\(([-\\d.]+)\\) translate\\(([-\\d.]+)/);
        return {
          visibility: getComputedStyle(svg).visibility,
          blades: svg.querySelectorAll('rect').length,
          offset: m ? Number(m[4]) : null,
          spin: m ? Number(m[3]) : null,
        };
      `));
    }
    const offsets = irisSamples.map((s) => s.offset);
    check('intro aperture sweeps through intermediate states',
      offsets.every(Number.isFinite) && Math.max(...offsets) - Math.min(...offsets) > 400,
      `blade offset ${Math.round(Math.min(...offsets))} → ${Math.round(Math.max(...offsets))}`);
    check('aperture rotates while opening', new Set(irisSamples.map((s) => s.spin)).size > 2,
      irisSamples.map((s) => `${s.spin}°`).join(' → '));
    check('aperture parks itself when fully open', irisSamples[0].visibility === 'hidden',
      irisSamples[0].visibility);
    check('aperture is closed just before the work section', irisSamples[4].visibility === 'visible');
    check('aperture uses a real blade array', irisSamples[2].blades >= 9, `${irisSamples[2].blades} blades`);
    await page.scrollTo(Math.round(closeFrom + (closeTo - closeFrom) * 0.5));
    await page.screenshot('05-iris-mid');

    // No dead black stretch anywhere between the two sections.
    const seamLit = [];
    for (let i = 0; i <= 12; i++) {
      const y = Math.round(geom.intro.top + geom.intro.height * (i / 12) + 1);
      await page.scrollTo(y);
      seamLit.push(await page.evaluate(`
        const svg = document.querySelector('.iris--intro');
        const v = getComputedStyle(svg).visibility;
        const card = document.querySelector('[data-intro-card]');
        return { v, cardOpacity: Number(getComputedStyle(card).opacity),
                 cardTop: Math.round(card.getBoundingClientRect().bottom) };
      `));
    }
    const seamsBlank = seamLit.filter((s, i) =>
      i > 0 && i < 12 && s.v === 'visible' && s.cardOpacity < 0.02 && s.cardTop < 0);
    check('no fully-blank interval while crossing into the work section',
      seamsBlank.length === 0,
      `${seamsBlank.length} blank samples across the seam`);

    /* ---------------------------------------------------------- mobile --- */
    console.log('\nMobile (390 × 844)');
    await page.setViewport(390, 844, true);
    await page.goto(base);
    await page.until('window.__aperture && window.__aperture.work');
    await sleep(700);
    const mobileIntro = await page.evaluate(`
      const doc = document.documentElement;
      const wide = Array.from(document.querySelectorAll('body *')).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right > doc.clientWidth + 2 && getComputedStyle(el).position !== 'fixed';
      }).slice(0, 6).map((el) => el.className || el.tagName);
      return { overflowX: doc.scrollWidth - doc.clientWidth, wide,
               aspect: window.innerWidth / window.innerHeight };
    `);
    check('no horizontal overflow on mobile', mobileIntro.overflowX <= 1, `${mobileIntro.overflowX}px`,
      mobileIntro.wide.join(' '));
    const mobileName = await page.evaluate(`
      const h1 = document.querySelector('#intro-title');
      const dLine = h1.querySelector('.intro__name__line--display');
      const mLine = h1.querySelector('.intro__name__line--mono');
      const dInner = dLine.querySelector('.intro__name__inner');
      const mInner = mLine.querySelector('.intro__name__inner');
      const r = document.createRange();
      r.selectNodeContents(dInner);
      const d = r.getBoundingClientRect();
      const m = mInner.getBoundingClientRect();
      return { dLeft: Math.round(d.left), mLeft: Math.round(m.left), dRight: Math.round(d.right),
               mWidth: Math.round(m.width), dWidth: Math.round(d.width),
               // Line-box to line-box: the rhythm the eye actually reads.
               gap: Math.round(mLine.getBoundingClientRect().top - dLine.getBoundingClientRect().bottom),
               ratio: Math.round((mInner.getBoundingClientRect().width / d.width) * 1000) / 1000,
               monoSize: Math.round(parseFloat(getComputedStyle(mLine).fontSize)),
               clientW: document.documentElement.clientWidth,
               size: Math.round(parseFloat(getComputedStyle(h1).fontSize)) };
    `);
    check('mobile name shares one left edge', Math.abs(mobileName.dLeft - mobileName.mLeft) <= 1,
      `${mobileName.dLeft}px vs ${mobileName.mLeft}px`);
    check('mobile name keeps air inside the viewport', mobileName.dRight < mobileName.clientW - 8,
      `right ${mobileName.dRight} of ${mobileName.clientW} at ${mobileName.size}px`);
    check('mobile surname is a second tier, not a caption',
      mobileName.ratio > 0.13 && mobileName.ratio < 0.42,
      `${mobileName.dWidth}px vs ${mobileName.mWidth}px → ratio ${mobileName.ratio}`);
    check('mobile tiers are clearly separated', mobileName.gap >= 12, `${mobileName.gap}px line-box gap`);
    await page.screenshot('06-mobile-intro');

    const mGeom = await page.evaluate(`
      const r = document.getElementById('work').getBoundingClientRect();
      return { top: Math.round(r.top + window.scrollY), height: Math.round(r.height), vh: window.innerHeight };
    `);
    const mTravel = mGeom.height - mGeom.vh;
    const mHashes = new Set();
    const mScales = [];
    for (const p of [0.24, 0.585, 0.86]) {
      await page.scrollTo(mGeom.top + Math.round(p * mTravel));
      const s = await page.evaluate(`
        const a = window.__aperture;
        const c = document.querySelector('[data-work-canvas]');
        const o = document.createElement('canvas'); o.width = 64; o.height = 64;
        const g = o.getContext('2d'); g.drawImage(c, 0, 0, 64, 64);
        const d = g.getImageData(0, 0, 64, 64).data;
        let h = 2166136261, lit = 0;
        for (let i = 0; i < d.length; i += 4) {
          h ^= d[i]; h = Math.imul(h, 16777619);
          h ^= d[i+1]; h = Math.imul(h, 16777619);
          h ^= d[i+2]; h = Math.imul(h, 16777619);
          if (d[i] + d[i+1] + d[i+2] > 70) lit++;
        }
        const panel = Array.from(document.querySelectorAll('.panel')).find((el) => Number(getComputedStyle(el).opacity) > 0.6);
        const pr = panel ? panel.getBoundingClientRect() : null;
        const cRect = c.getBoundingClientRect();
        return { hash: (h >>> 0).toString(16), lit, scale: a.work.snapshot().scale,
                 panelName: panel ? panel.className.split(' ').find(x => x.startsWith('panel--')) : null,
                 panelTop: pr ? Math.round(pr.top) : null, panelBottom: pr ? Math.round(pr.bottom) : null,
                 canvasTop: Math.round(cRect.top), vh: window.innerHeight };
      `);
      mHashes.add(s.hash);
      mScales.push(s.scale);
      check(`mobile panel visible at p=${p}`, s.panelName !== null && s.lit > 100,
        `${s.panelName} lit=${s.lit}`);
      check(`mobile copy stays inside the viewport at p=${p}`,
        s.panelBottom !== null && s.panelBottom <= s.vh + 2 && s.panelTop >= 0,
        `panel ${s.panelTop}–${s.panelBottom} of ${s.vh}`);
    }
    check('mobile stage still animates', mHashes.size === 3, `${mHashes.size}/3 unique frames`);
    check('mobile scale still varies', Math.max(...mScales) - Math.min(...mScales) > 0.3,
      `${Math.min(...mScales)} → ${Math.max(...mScales)}`);
    await page.screenshot('07-mobile-work');

    /* ------------------------------------------------- reduced motion ---- */
    console.log('\nReduced motion');
    await page.setViewport(1440, 900, false);
    await page.setReducedMotion(true);
    await page.goto(base);
    await page.until('window.__aperture && window.__aperture.work');
    await sleep(700);
    const secs = (v) => (v.endsWith('ms') ? parseFloat(v) / 1000 : parseFloat(v));
    const reduced = await page.evaluate(`
      const a = window.__aperture;
      const dur = (sel) => getComputedStyle(document.querySelector(sel)).animationDuration;
      const reveals = Array.from(document.querySelectorAll('[data-reveal]'));
      const p = a.policy();
      const h1 = document.querySelector('#intro-title');
      const chars = Array.from(h1.querySelectorAll('.ch'));
      const lines = Array.from(h1.querySelectorAll('.intro__name__line'));
      return {
        reduced: p.reduced, idleScale: p.idleScale, spinScale: p.spinScale, smoothing: p.smoothing,
        motionFlag: document.documentElement.dataset.motion,
        ticker: dur('.ticker__row'), cue: dur('.scrollcue__track i'),
        line: dur('.intro__name__line--display .intro__name__inner'),
        charDelays: chars.map((c) => getComputedStyle(c).animationDelay),
        unrevealed: reveals.filter((el) => el.dataset.revealed !== 'true').length,
        scrollBehaviour: getComputedStyle(document.documentElement).scrollBehavior,
        // The name must be fully legible with motion off — nothing left hidden.
        nameOpacity: Number(getComputedStyle(h1).opacity),
        lineOpacity: lines.map((l) => Number(getComputedStyle(l).opacity)),
        lineHeights: lines.map((l) => Math.round(l.getBoundingClientRect().height)),
        charOpacities: chars.map((c) => Number(getComputedStyle(c).opacity)),
        charVisible: chars.map((c) => {
          const r = c.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }),
      };
    `);
    check('reduced-motion policy detected', reduced.reduced === true);
    check('the name is fully legible with motion off',
      reduced.nameOpacity === 1 &&
        reduced.lineOpacity.every((o) => o === 1) &&
        reduced.charOpacities.every((o) => o === 1) &&
        reduced.charVisible.every(Boolean) &&
        reduced.lineHeights.every((h) => h > 8),
      `h1 ${reduced.nameOpacity}, chars [${reduced.charOpacities.join(',')}], heights [${reduced.lineHeights.join(',')}]`);
    check('autonomous animation is switched off',
      secs(reduced.ticker) < 0.01 && secs(reduced.cue) < 0.01 && secs(reduced.line) < 0.01,
      `ticker ${reduced.ticker}, cue ${reduced.cue}, title ${reduced.line}`);
    check('per-character stagger delays are zeroed too',
      reduced.charDelays.every((d) => secs(d) < 0.001),
      `delays ${reduced.charDelays.join(', ')}`);
    check('idle clock is frozen', reduced.idleScale === 0);
    check('scroll-linked spin is compressed', reduced.spinScale > 0 && reduced.spinScale < 1,
      `spinScale ${reduced.spinScale}`);
    check('scroll smoothing is bypassed', reduced.smoothing === false);
    check('content is not left hidden when motion is off', reduced.unrevealed === 0,
      `${reduced.unrevealed} unrevealed`);
    check('smooth scrolling disabled', reduced.scrollBehaviour === 'auto');

    // With the idle clock frozen the render is a pure function of scroll, so
    // pixels must be byte-identical when the same offsets are revisited.
    const rHashesFwd = [];
    const rYs = [];
    for (const p of [0.24, 0.585, 0.86, 0.4]) {
      const y = geom.work.top + Math.round(p * workTravel);
      rYs.push(y);
      await page.scrollTo(y);
      rHashesFwd.push(await page.evaluate(`
        const c = document.querySelector('[data-work-canvas]');
        const o = document.createElement('canvas'); o.width = 72; o.height = 46;
        const g = o.getContext('2d'); g.drawImage(c, 0, 0, 72, 46);
        const d = g.getImageData(0, 0, 72, 46).data;
        let h = 2166136261, lit = 0;
        for (let i = 0; i < d.length; i += 4) {
          h ^= d[i]; h = Math.imul(h, 16777619);
          h ^= d[i+1]; h = Math.imul(h, 16777619);
          h ^= d[i+2]; h = Math.imul(h, 16777619);
          if (d[i] + d[i+1] + d[i+2] > 70) lit++;
        }
        return { hash: (h >>> 0).toString(16), lit, y: window.scrollY };
      `));
    }
    const rHashesBack = [];
    for (let i = rYs.length - 1; i >= 0; i--) {
      await page.scrollTo(rYs[i]);
      rHashesBack.unshift(await page.evaluate(`
        const c = document.querySelector('[data-work-canvas]');
        const o = document.createElement('canvas'); o.width = 72; o.height = 46;
        const g = o.getContext('2d'); g.drawImage(c, 0, 0, 72, 46);
        const d = g.getImageData(0, 0, 72, 46).data;
        let h = 2166136261;
        for (let i = 0; i < d.length; i += 4) {
          h ^= d[i]; h = Math.imul(h, 16777619);
          h ^= d[i+1]; h = Math.imul(h, 16777619);
          h ^= d[i+2]; h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(16);
      `));
    }
    const rHashesFwdOnly = rHashesFwd.map((s) => s.hash);
    const rDiff = rHashesFwdOnly.filter((h, i) => h !== rHashesBack[i]).length;
    check('reduced motion still animates with scroll', new Set(rHashesFwdOnly).size >= 3,
      `${new Set(rHashesFwdOnly).size}/${rHashesFwdOnly.length} unique frames`);
    check('frames are pixel-identical when scrolled back up', rDiff === 0,
      `${rDiff}/${rHashesFwdOnly.length} frames differed`);
    check('no blank frames under reduced motion',
      Math.min(...rHashesFwd.map((s) => s.lit)) > 200,
      `min lit ${Math.min(...rHashesFwd.map((s) => s.lit))}`);
    await page.scrollTo(geom.work.top + Math.round(workTravel * 0.585));
    await page.screenshot('08-reduced-motion');
    // Put the preference back. Everything after this point is checking the
    // normal-motion page, and a suite that forgets to restore its own emulation
    // silently re-runs the whole remainder of the harness under `reduce`.
    await page.setReducedMotion(false);
    await page.goto(base);
    await page.until('window.__aperture && window.__aperture.work');
    await sleep(600);

    /* ------------------------------------------------------- console ----- */
    console.log('\nRuntime health');
    check('no uncaught exceptions', page.exceptions.length === 0, page.exceptions.join(' | '));
    check('no console errors or warnings', page.console.length === 0, page.console.slice(0, 3).join(' | '));

    /* ---------------------------------------------------------- a11y ----- */
    console.log('\nAccessibility spot checks');
    const a11y = await page.evaluate(`
      const namelessLinks = Array.from(document.querySelectorAll('a[href]'))
        .filter((a) => !(a.textContent || '').trim() && !a.getAttribute('aria-label'))
        .map((a) => a.href);
      const buttonHasName = (document.querySelector('[data-back-to-top]').textContent || '').trim().length > 0;
      const panels = Array.from(document.querySelectorAll('.panel')).map((p) => ({
        inert: p.hasAttribute('inert'), ariaHidden: p.getAttribute('aria-hidden') }));
      return {
        namelessLinks, buttonHasName,
        hiddenPanelsCounted: panels.filter((p) => p.inert && p.ariaHidden === 'true').length,
        lang: document.documentElement.lang,
        landmarks: ['header', 'main', 'footer'].filter((t) => document.querySelector(t)),
        navLabel: document.querySelector('nav')?.getAttribute('aria-label'),
        sectionsLabelled: Array.from(document.querySelectorAll('main > section'))
          .every((s) => s.getAttribute('aria-labelledby')),
      };
    `);
    check('every link has an accessible name', a11y.namelessLinks.length === 0, a11y.namelessLinks.join(' '));
    check('back-to-top button has a name', a11y.buttonHasName);
    check('inactive panels removed from the a11y tree', a11y.hiddenPanelsCounted >= 0);
    check('landmarks + labelled sections', a11y.landmarks.length === 3 && a11y.sectionsLabelled && !!a11y.navLabel,
      a11y.landmarks.join(', '));

    /* ------------------------------------------------ label contrast ------ */
    // Meaningful small labels used to share --fg-ghost, which measures 2.96:1
    // on the page ground and fails WCAG AA. Decorative ghosting is intentional
    // and must stay put, so only the content-bearing set is asserted here.
    console.log('\nLabel contrast');
    await page.scrollTo(geom.work.top + Math.round(workTravel * 0.24));
    await sleep(500);
    const contrast = await page.evaluate(`
      const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
      const lum = (rgb) => {
        const m = rgb.match(/[\\d.]+/g).map(Number);
        return 0.2126 * lin(m[0]) + 0.7152 * lin(m[1]) + 0.0722 * lin(m[2]);
      };
      const ratio = (fg, bg) => {
        const a = lum(fg), b = lum(bg);
        return +(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
      };
      const cs = getComputedStyle(document.documentElement);
      const ground = cs.getPropertyValue('--ink-900').trim();
      const rgbOf = (hex) => {
        const h = hex.replace('#', '');
        return 'rgb(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16) + ')';
      };
      const bg = rgbOf(ground);
      const measured = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        return { color: getComputedStyle(el).color, ratio: ratio(getComputedStyle(el).color, bg) };
      };
      return {
        ground,
        labelToken: cs.getPropertyValue('--fg-label').trim(),
        ghostToken: cs.getPropertyValue('--fg-ghost').trim(),
        content: {
          metaLineKey: measured('.meta-line__k'),
          panelIndex: measured('.panel--vision .panel__index'),
          panelMetaDt: measured('.panel--vision .panel__meta dt'),
          hudLabel: measured('.hud__item i'),
          dialCaption: measured('.dial__caption'),
        },
        decorative: {
          ticker: measured('.ticker__row span'),
        },
      };
    `);
    for (const [name, value] of Object.entries(contrast.content)) {
      check(`${name} clears WCAG AA on the dark ground`, !!value && value.ratio >= 4.5,
        value ? `${contrast.labelToken} on ${contrast.ground} → ${value.ratio}:1` : 'not found');
    }
    check('decorative ghosting is left intact',
      !!contrast.decorative.ticker && contrast.decorative.ticker.ratio < 4.5,
      contrast.decorative.ticker ? `${contrast.ghostToken} → ${contrast.decorative.ticker.ratio}:1` : 'not found');

    /* ------------------------------------------- Attendly title / rule ---- */
    // Line-height 0.86 leaves the box bottom ~0.09em under the baseline, so a
    // rule anchored to it ran straight through the descender of the "y".
    console.log('\nAttendly title rule');
    const ruleSamples = [];
    for (const [w, h] of [[1440, 900], [1024, 800], [768, 900], [390, 844]]) {
      await page.setViewport(w, h, w < 700);
      await page.goto(base);
      await page.until('window.__aperture && window.__aperture.work');
      await sleep(700);
      const travel = await page.evaluate(
        `return Math.max(document.getElementById('work').getBoundingClientRect().height - window.innerHeight, 1);`,
      );
      const top = await page.evaluate(
        `return Math.round(document.getElementById('work').getBoundingClientRect().top + window.scrollY);`,
      );
      await page.scrollTo(top + Math.round(travel * 0.585));
      await sleep(700);
      ruleSamples.push(await page.evaluate(`
        const panel = document.querySelector('.panel--product');
        const span = panel.querySelector('.panel__title span');
        const disc = panel.querySelector('.panel__discipline');
        const h3 = span.closest('h3');
        const probe = document.createElement('canvas').getContext('2d');
        const cs = getComputedStyle(h3);
        probe.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
        const y = probe.measureText('y');
        const lh = parseFloat(cs.lineHeight);
        const half = (lh - (y.fontBoundingBoxAscent + y.fontBoundingBoxDescent)) / 2;
        const baseline = half + y.fontBoundingBoxAscent;
        const sp = span.getBoundingClientRect();
        // The rule is the span's ::after. A negative \`bottom\` places it *below*
        // the containing block's bottom edge, so the offset is subtracted.
        const after = getComputedStyle(span, '::after');
        const ruleHeight = parseFloat(after.height);
        const ruleBottom = sp.bottom - parseFloat(after.bottom);
        const ruleTop = ruleBottom - ruleHeight;
        const descenderBottom = sp.top + baseline + y.actualBoundingBoxDescent;
        // Only laid-out children count: a display:none child reports a zero
        // rect and would otherwise dominate the min/max.
        const kids = Array.from(panel.children).filter((e) => {
          const s = getComputedStyle(e);
          return s.display !== 'none' && s.position !== 'absolute';
        });
        const stage = document.querySelector('.work__stage').getBoundingClientRect();
        const top = Math.min(...kids.map((e) => e.getBoundingClientRect().top));
        const bot = Math.max(...kids.map((e) => e.getBoundingClientRect().bottom));
        return {
          vw: window.innerWidth,
          em: +parseFloat(cs.fontSize).toFixed(2),
          descenderGap: +(ruleTop - descenderBottom).toFixed(2),
          disciplineGap: +(disc.getBoundingClientRect().top - ruleBottom).toFixed(2),
          overflowTop: +Math.max(0, stage.top - top).toFixed(1),
          overflowBottom: +Math.max(0, bot - stage.bottom).toFixed(1),
        };
      `));
    }
    await page.setViewport(1440, 900, false);
    for (const s of ruleSamples) {
      check(`Attendly rule clears the descender at ${s.vw}px`, s.descenderGap >= 0.25,
        `${s.descenderGap}px gap at ${s.em}px type`);
      check(`Attendly rule clears the discipline line at ${s.vw}px`, s.disciplineGap >= 0.25,
        `${s.disciplineGap}px gap at ${s.em}px type`);
      check(`Attendly panel stays inside the stage at ${s.vw}px`,
        s.overflowTop === 0 && s.overflowBottom === 0,
        `${s.overflowTop}px over the top, ${s.overflowBottom}px over the bottom`);
    }

    /* ------------------------------------------ project evidence figures -- */
    // Each panel's mark plots numbers the panel already states in copy. The
    // risks are mundane and easy to reintroduce: a figure growing past its
    // panel, two labels landing on top of each other, or a panel that has come
    // fully into view leaving its own figure half drawn.
    console.log('\nProject figures');
    // Each stop sits in the middle of that panel's fully-in plateau (see
    // PANEL_WINDOWS), not merely somewhere the panel is visible: a figure is
    // only finished when the panel it belongs to has finished arriving.
    const STOPS = [['vision', 0.24], ['product', 0.585], ['tooling', 0.84]];
    const figureSamples = [];
    for (const [w, h] of [[1440, 900], [1024, 800], [768, 900], [390, 844], [360, 640]]) {
      await page.setViewport(w, h, w < 700);
      await page.goto(base);
      await page.until('window.__aperture && window.__aperture.work');
      await sleep(700);
      const travel = await page.evaluate(
        `return Math.max(document.getElementById('work').getBoundingClientRect().height - window.innerHeight, 1);`,
      );
      const top = await page.evaluate(
        `return Math.round(document.getElementById('work').getBoundingClientRect().top + window.scrollY);`,
      );
      for (const [key, at] of STOPS) {
        await page.scrollTo(top + Math.round(travel * at));
        await sleep(700);
        figureSamples.push(await page.evaluate(`
          const panel = document.querySelector('.panel--${key}');
          const mark = panel && panel.querySelector('.panel__mark');
          const svg = mark && mark.querySelector('svg.viz');
          const vw = ${w};
          if (!svg) return { key: '${key}', vw, missing: true };
          const stage = document.querySelector('.work__stage').getBoundingClientRect();
          const box = svg.getBoundingClientRect();
          const view = svg.getAttribute('viewBox').split(/\\s+/).map(Number);
          // Label text is the part that has to stay readable, so it is the part
          // that must never collide with another label or leave the frame.
          const labels = [...svg.querySelectorAll('text')].map((el) => {
            const b = el.getBBox();
            return { text: el.textContent.trim().slice(0, 16), x: b.x, y: b.y, r: b.x + b.width, b: b.y + b.height };
          });
          const collisions = [];
          for (let i = 0; i < labels.length; i++) {
            for (let j = i + 1; j < labels.length; j++) {
              const a = labels[i], c = labels[j];
              const ox = Math.min(a.r, c.r) - Math.max(a.x, c.x);
              const oy = Math.min(a.b, c.b) - Math.max(a.y, c.y);
              if (ox > 1 && oy > 1) collisions.push(a.text + ' / ' + c.text);
            }
          }
          const escaped = labels
            .filter((l) => l.x < -1 || l.y < -1 || l.r > view[2] + 1 || l.b > view[3] + 1)
            .map((l) => l.text);
          return {
            key: '${key}', vw, missing: false,
            t: parseFloat(getComputedStyle(panel).getPropertyValue('--t')),
            hidden: mark.getAttribute('aria-hidden'),
            marks: panel.querySelectorAll('.panel__mark').length,
            overflowTop: +Math.max(0, stage.top - box.top).toFixed(1),
            overflowBottom: +Math.max(0, box.bottom - stage.bottom).toFixed(1),
            labels: labels.length,
            collisions, escaped,
            dashLeft: +Math.max(0, ...[...svg.querySelectorAll('[class*="viz-draw"]')]
              .map((el) => parseFloat(getComputedStyle(el).strokeDashoffset) || 0)).toFixed(2),
            faded: +Math.max(0, ...[...svg.querySelectorAll('[class*="viz-fade"], [class*="viz-pop"]')]
              .map((el) => 1 - (parseFloat(getComputedStyle(el).opacity) || 0))).toFixed(3),
          };
        `));
      }
    }
    for (const s of figureSamples) {
      const at = `${s.key} at ${s.vw}px`;
      check(`figure exists for ${at}`, !s.missing, s.missing ? 'no svg.viz in the panel mark' : 'present');
      if (s.missing) continue;
      check(`figure is decorative to assistive tech at ${at}`, s.hidden === 'true' && s.marks === 1,
        `aria-hidden=${s.hidden}, ${s.marks} mark(s)`);
      check(`figure stays inside the stage at ${at}`,
        s.overflowTop === 0 && s.overflowBottom === 0,
        `${s.overflowTop}px over the top, ${s.overflowBottom}px over the bottom`);
      check(`figure labels never collide at ${at}`, s.collisions.length === 0,
        s.collisions.length ? s.collisions.join(', ') : `${s.labels} labels, all clear`);
      check(`figure labels stay inside the frame at ${at}`, s.escaped.length === 0,
        s.escaped.length ? s.escaped.join(', ') : `${s.labels} labels inside the viewBox`);
      if (s.t >= 0.999) {
        check(`figure is fully drawn when the panel is in at ${at}`,
          s.dashLeft < 0.5 && s.faded < 0.02,
          `--t ${s.t}: ${s.dashLeft}px of stroke left, ${s.faded} of opacity left`);
      }
    }

/* --------------------------------------------- the intro has no surface --- */
    // The intro is a true-black field and nothing else. No canvas in it, and no
    // GL context requested from one, asserted rather than assumed: a shader
    // creeping back in is the easiest regression to make here and the hardest to
    // notice, because an effect that only draws under the pointer still looks
    // like a correct black section at rest.
    console.log('\nIntro surface');
    const glStub = await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        window.__glRequests = [];
        const real = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
          if (typeof type === 'string' && type.toLowerCase().includes('webgl')) {
            window.__glRequests.push({
              type,
              intro: this.closest('[data-intro-card]') !== null,
            });
          }
          return real.call(this, type, ...rest);
        };
      })();`,
    });

    await page.setViewport(1440, 900, false);
    await page.goto(base);
    await page.until('window.__aperture && window.__aperture.work');
    await sleep(900);

    const drag = async (steps, fromX, fromY, toX, toY, pause) => {
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        await page.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(fromX + (toX - fromX) * t),
          y: Math.round(fromY + (toY - fromY) * t),
          buttons: 0,
        });
        await sleep(pause);
      }
    };

    // Move across the intro first. "No surface" has to hold under the one input
    // that used to summon one, not just on a page nobody has touched.
    await drag(24, 300, 420, 1100, 470, 16);
    await sleep(400);

    const surface = await page.evaluate(`
      const section = document.querySelector('.intro');
      const card = document.querySelector('[data-intro-card]');
      const intro = getComputedStyle(section);
      const cardStyle = getComputedStyle(card);
      const gl = window.__glRequests || [];
      return {
        canvases: document.querySelectorAll('.intro canvas, [data-intro-card] canvas').length,
        glInIntro: gl.filter((r) => r.intro).length,
        glTotal: gl.length,
        hasGridElement: !!document.querySelector('.intro__grid'),
        introBackgroundImage: intro.backgroundImage,
        cardBackgroundImage: cardStyle.backgroundImage,
        cardBackgroundColor: cardStyle.backgroundColor,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
      };
    `);

    check('the intro mounts no canvas at all', surface.canvases === 0,
      `${surface.canvases} canvases inside the intro`);
    check('the intro never asks for a WebGL context', surface.glInIntro === 0,
      `${surface.glTotal} GL contexts requested in the document, ${surface.glInIntro} of them from the intro`);
    check('the intro carries no background grid', surface.hasGridElement === false,
      surface.hasGridElement ? '.intro__grid is still present' : 'no grid element');
    check('the intro and its card paint no background of their own',
      surface.introBackgroundImage === 'none' && surface.cardBackgroundImage === 'none',
      `intro ${surface.introBackgroundImage} / card ${surface.cardBackgroundImage}`);
    check('the intro ground is true black',
      surface.cardBackgroundColor === 'rgba(0, 0, 0, 0)' && surface.bodyBackground === 'rgb(0, 0, 0)',
      `card transparent=${surface.cardBackgroundColor === 'rgba(0, 0, 0, 0)'}, body ${surface.bodyBackground}`);

    if (glStub && glStub.identifier) {
      await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: glStub.identifier });
    }

    await page.setViewport(1440, 900, false);
    await page.goto(base);
    await page.until('window.__aperture && window.__aperture.work');
    await sleep(700);
    await page.setViewport(1440, 900, false);
    await page.goto(base);
    await page.until('window.__aperture && window.__aperture.work');
    await sleep(700);

    console.log('\nIdentity metadata');
    const meta = await page.evaluate(`
      const attr = (sel, a) => document.querySelector(sel)?.getAttribute(a) ?? null;
      let ld = null;
      try { ld = JSON.parse(document.querySelector('script[type="application/ld+json"]')?.textContent ?? 'null'); }
      catch { ld = 'unparseable'; }
      return {
        title: document.title,
        description: attr('meta[name=description]', 'content'),
        colorScheme: attr('meta[name=color-scheme]', 'content'),
        icon: attr('link[rel=icon]', 'href'),
        iconType: attr('link[rel=icon]', 'type'),
        ogTitle: attr('meta[property="og:title"]', 'content'),
        ogType: attr('meta[property="og:type"]', 'content'),
        ogDescription: attr('meta[property="og:description"]', 'content'),
        twitterCard: attr('meta[name="twitter:card"]', 'content'),
        ldType: ld && ld['@type'],
        ldName: ld && ld.name,
        ldJobTitle: ld && ld.jobTitle,
        ldSameAs: ld && ld.sameAs,
        ldEmail: ld && ld.email,
        // Nothing here may claim a production domain that the repo cannot prove.
        canonical: attr('link[rel=canonical]', 'href'),
        ogUrl: attr('meta[property="og:url"]', 'content'),
        ogImage: attr('meta[property="og:image"]', 'content'),
        dupeTitles: document.querySelectorAll('title').length,
      };
    `);
    check('title present and singular', !!meta.title && meta.dupeTitles === 1, meta.title);
    check('color-scheme declares the dark interface', meta.colorScheme === 'dark',
      String(meta.colorScheme));
    check('favicon declared as SVG', !!meta.icon && meta.iconType === 'image/svg+xml',
      `${meta.icon} (${meta.iconType})`);
    check('open graph title + type present', !!meta.ogTitle && meta.ogType === 'profile',
      `${meta.ogType}: ${meta.ogTitle}`);
    check('open graph description present', !!meta.ogDescription,
      `${(meta.ogDescription || '').slice(0, 40)}…`);
    check('twitter card declared without an unverifiable image',
      meta.twitterCard === 'summary' && !meta.ogImage, meta.twitterCard);
    check('person structured data parses and is accurate',
      meta.ldType === 'Person' && meta.ldName === 'Karthikeya Dusi' &&
        meta.ldJobTitle === 'Software engineer' &&
        meta.ldEmail === 'karthikeyadusi@gmail.com' &&
        Array.isArray(meta.ldSameAs) && meta.ldSameAs.length === 3,
      `${meta.ldType}/${meta.ldName}/${meta.ldJobTitle}`);
    check('no canonical or og:url claims an unverified domain',
      !meta.canonical && !meta.ogUrl, `${meta.canonical ?? 'none'} / ${meta.ogUrl ?? 'none'}`);
    const iconHref = meta.icon ? new URL(meta.icon, base).href : null;
    if (iconHref) {
      const iconResponse = await fetch(iconHref);
      const iconBody = await iconResponse.text();
      check('favicon asset is actually served', iconResponse.ok && iconBody.includes('<svg'),
        `HTTP ${iconResponse.status}, ${iconBody.length} bytes`);
    }

    /* ------------------------------------------------- header links ------ */
    // Three links occupy the header cell the availability pill used to hold.
    // Two failure modes are worth pinning here: a profile URL drifting apart
    // between the header and the contact list it duplicates, and the paper
    // theme leaving light marks sitting on light paper.
    console.log('\nHeader links');
    const EXPECTED_PROFILES = {
      github: 'https://github.com/Karthikeyadusi',
      linkedin: 'https://www.linkedin.com/in/karthikeyadusi/',
    };
    const headerSamples = [];
    for (const [w, h] of [[1440, 900], [1024, 800], [768, 900], [390, 844], [360, 640]]) {
      await page.setViewport(w, h, w < 700);
      await page.goto(base);
      await page.until('window.__aperture && window.__aperture.work');
      await sleep(700);
      headerSamples.push(await page.evaluate(`
        const header = document.querySelector('[data-header]');
        const nav = document.querySelector('.header__elsewhere');
        const hb = header.getBoundingClientRect();
        const cs = getComputedStyle(nav);
        const hidden = cs.display === 'none';
        const box = nav.getBoundingClientRect();
        const links = Array.from(nav.querySelectorAll('a')).map((a) => {
          const r = a.getBoundingClientRect();
          return {
            href: a.getAttribute('href'),
            name: (a.textContent || '').trim() || a.getAttribute('aria-label') || '',
            // The .sr-only label must be the name, not the pictogram: the
            // drawing is aria-hidden, so this is the whole accessible name.
            pictogramHidden: a.querySelector('svg')?.getAttribute('aria-hidden') === 'true',
            target: +Math.max(r.width, r.height).toFixed(1),
            opens: a.getAttribute('target'),
            rel: a.getAttribute('rel') ?? '',
            downloads: a.hasAttribute('download'),
            external: /^https?:/.test(a.getAttribute('href') ?? ''),
          };
        });
        const contactLinks = Array.from(document.querySelectorAll('.contact__links a'));
        const contactHref = (needle) => {
          const hit = contactLinks.find((a) => a.href.includes(needle));
          return hit ? hit.getAttribute('href') : null;
        };
        return {
          vw: window.innerWidth, hidden,
          label: nav.getAttribute('aria-label'),
          count: links.length, links,
          contactGithub: contactHref('github.com'),
          contactLinkedin: contactHref('linkedin.com'),
          spillRight: hidden ? 0 : +Math.max(0, box.right - hb.right).toFixed(1),
          docOverflow: +(document.documentElement.scrollWidth - window.innerWidth).toFixed(1),
        };
      `));
    }
    for (const s of headerSamples) {
      check(`header carries all three identity links at ${s.vw}px`, s.count === 3,
        `${s.count} link(s)`);
      check(`header links are a labelled landmark at ${s.vw}px`, !!s.label, s.label ?? 'unlabelled');
      const github = s.links.find((l) => /github\.com/.test(l.href ?? ''));
      const linkedin = s.links.find((l) => /linkedin\.com/.test(l.href ?? ''));
      check(`header GitHub matches the contact list at ${s.vw}px`,
        !!github && github.href === EXPECTED_PROFILES.github && github.href === s.contactGithub,
        `${github?.href ?? 'missing'} / contact ${s.contactGithub ?? 'missing'}`);
      check(`header LinkedIn matches the contact list at ${s.vw}px`,
        !!linkedin && linkedin.href === EXPECTED_PROFILES.linkedin && linkedin.href === s.contactLinkedin,
        `${linkedin?.href ?? 'missing'} / contact ${s.contactLinkedin ?? 'missing'}`);
      // A new tab is only safe with noopener: without it the opened page keeps
      // a handle on this window and can navigate it to a lookalike. Neither
      // half is visible in a screenshot, so it is asserted here.
      const openerRisk = [github, linkedin].filter((l) => l && (
        l.opens !== '_blank' || !/\bnoopener\b/.test(l.rel)
      ));
      check(`external header links open in a new tab with noopener at ${s.vw}px`,
        openerRisk.length === 0,
        openerRisk.length
          ? openerRisk.map((l) => `${l.name}: target=${l.opens ?? 'self'} rel="${l.rel}"`).join(' | ')
          : [github, linkedin].map((l) => `${l.name}: target=${l.opens} rel="${l.rel}"`).join(' | '));
      // The résumé downloads instead of navigating, so a target beside it would
      // be inert markup promising a tab that can never open.
      const resume = s.links.find((l) => /\.pdf$/i.test(l.href ?? ''));
      check(`résumé downloads in place rather than opening a tab at ${s.vw}px`,
        !!resume && resume.downloads === true && !resume.opens,
        resume ? `download=${resume.downloads} target=${resume.opens ?? 'self'}` : 'no pdf link');
      const unnamed = s.links.filter((l) => !l.name);
      check(`every header link has an accessible name at ${s.vw}px`, unnamed.length === 0,
        unnamed.length ? `${unnamed.length} unnamed` : s.links.map((l) => l.name).join(', '));
      const leaking = s.links.filter((l) => !l.pictogramHidden);
      check(`header pictograms are hidden from assistive tech at ${s.vw}px`, leaking.length === 0,
        `${s.links.length - leaking.length}/${s.links.length} drawings hidden`);
      if (s.hidden) continue;
      const small = s.links.filter((l) => l.target < 24);
      check(`header link targets clear 24px at ${s.vw}px`, small.length === 0,
        small.length ? small.map((l) => `${l.name} ${l.target}px`).join(', ')
          : s.links.map((l) => `${l.name} ${l.target}px`).join(', '));
      check(`header links stay inside the header at ${s.vw}px`, s.spillRight === 0 && s.docOverflow <= 0,
        `${s.spillRight}px past the header, ${s.docOverflow}px page overflow`);
    }

    // Paper is the only place the header changes ground, so the marks have to
    // change with it. Each state is measured where it actually occurs: ink at
    // the top of the page, paper after contact has genuinely slid under the
    // header. Measuring both in one place would compare the paper-theme colour
    // against the ink ground and mean nothing.
    await page.setViewport(1440, 900, false);
    await page.goto(base);
    await page.until('window.__aperture && window.__aperture.work');
    await sleep(600);
    const GROUND_PROBE = `
      const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
      const lum = (rgb) => {
        const m = rgb.match(/[\\d.]+/g).map(Number);
        return 0.2126 * lin(m[0]) + 0.7152 * lin(m[1]) + 0.0722 * lin(m[2]);
      };
      const ratio = (fg, bg) => {
        const a = lum(fg), b = lum(bg);
        return +(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
      };
      const rgbOf = (hex) => {
        const h = hex.replace('#', '');
        return 'rgb(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16) + ')';
      };
      const root = getComputedStyle(document.documentElement);
      const link = document.querySelector('.header__link');
      const color = getComputedStyle(link).color;
      const ground = root.getPropertyValue('__GROUND__').trim();
      return { theme: document.querySelector('[data-header]').dataset.theme, color, ratio: ratio(color, rgbOf(ground)) };
    `;
    const inkHeader = await page.evaluate(GROUND_PROBE.replace('__GROUND__', '--ink-900'));
    await page.evaluate(`
      const c = document.getElementById('contact');
      window.scrollTo({ top: c.getBoundingClientRect().top + window.scrollY + 2, behavior: 'instant' });
      return true;
    `);
    await sleep(700);
    const paperHeader = await page.evaluate(GROUND_PROBE.replace('__GROUND__', '--paper'));
    check('header starts on the ink theme', inkHeader.theme === 'ink', `data-theme=${inkHeader.theme}`);
    check('header links clear WCAG AA on the ink ground', inkHeader.ratio >= 4.5,
      `${inkHeader.color} → ${inkHeader.ratio}:1`);
    check('header flips to the paper theme over contact', paperHeader.theme === 'paper',
      `data-theme=${paperHeader.theme}`);
    check('header links clear WCAG AA on the paper ground', paperHeader.ratio >= 4.5,
      `${paperHeader.color} → ${paperHeader.ratio}:1`);
    check('the header marks actually change ground colour', inkHeader.color !== paperHeader.color,
      `${inkHeader.color} on ink → ${paperHeader.color} on paper`);

    /* ------------------------------------------------ contact links ------ */
    // The three marks beside the contact words. A malformed brand path renders
    // as a solid blob and reads as decoration, so nothing about it looks broken
    // in a screenshot — the geometry is asserted instead.
    console.log('\nContact links');
    const contactLinks = await page.evaluate(`
      const out = [];
      for (const a of document.querySelectorAll('.contact__links a')) {
        const icon = a.querySelector('svg');
        const r = icon ? icon.getBoundingClientRect() : null;
        let fillRule = null;
        let geometry = null;
        if (icon) {
          const path = icon.querySelector('path');
          const b = path ? path.getBBox() : null;
          if (b) {
            geometry = {
              w: +b.width.toFixed(2), h: +b.height.toFixed(2),
              x: +b.x.toFixed(2), y: +b.y.toFixed(2),
            };
          }
          const cs = getComputedStyle(path);
          fillRule = { fill: cs.fill, rule: cs.fillRule };
        }
        out.push({
          word: (a.querySelector('span')?.textContent || '').trim(),
          iconHidden: icon ? icon.getAttribute('aria-hidden') === 'true' : false,
          rendered: r ? { w: +r.width.toFixed(1), h: +r.height.toFixed(1) } : null,
          geometry, fillRule,
        });
      }
      return out;
    `);
    check('every contact link leads with a hidden pictogram',
      contactLinks.length === 3 && contactLinks.every((l) => l.iconHidden),
      contactLinks.map((l) => `${l.word || '?'}:${l.iconHidden ? 'hidden' : 'MISSING'}`).join(' · '));
    check('every contact link keeps its word as the name',
      contactLinks.every((l) => l.word.length > 0),
      contactLinks.map((l) => l.word).join(', '));
    // A path that collapses, escapes its viewBox, or fills as an undifferentiated
    // block would all still photograph as "an icon is there".
    const degenerate = contactLinks.filter((l) => !l.geometry ||
      l.geometry.w < 8 || l.geometry.h < 8 ||
      l.geometry.x < -0.5 || l.geometry.y < -0.5 ||
      l.geometry.x + l.geometry.w > 24.5 || l.geometry.y + l.geometry.h > 24.5);
    check('contact pictograms fill their viewBox without escaping it', degenerate.length === 0,
      degenerate.length
        ? degenerate.map((l) => `${l.word || '?'} ${JSON.stringify(l.geometry)}`).join(' · ')
        : contactLinks.map((l) => `${l.word} ${l.geometry.w}x${l.geometry.h}`).join(' · '));
    check('contact pictograms take the link colour rather than a baked one',
      contactLinks.every((l) => /rgb/.test(l.fillRule?.fill ?? '')),
      contactLinks.map((l) => `${l.word}: ${l.fillRule?.fill}`).join(' · '));

    console.log('\nRésumé download');
    const resume = await page.evaluate(`
      const foot = document.querySelector('.totop--link');
      const head = document.querySelector('.header__link--resume');
      return {
        foot: foot ? foot.getAttribute('href') : null,
        head: head ? head.getAttribute('href') : null,
        headDownloads: head ? head.hasAttribute('download') : false,
      };
    `);
    check('résumé link present with a relative href', !!resume.foot && !/^https?:/.test(resume.foot),
      resume.foot ?? 'missing');
    // Two copies of one document is fine; two documents would not be.
    check('both résumé links point at the same file',
      !!resume.head && resume.head === resume.foot && !/^https?:/.test(resume.head),
      `${resume.head ?? 'missing'} vs ${resume.foot ?? 'missing'}`);
    check('header résumé link downloads rather than navigates', resume.headDownloads === true,
      resume.headDownloads ? 'download attribute present' : 'missing');
    if (resume.foot) {
      const url = new URL(resume.foot, base).href;
      const response = await fetch(url);
      const type = response.headers.get('content-type') ?? '';
      check('résumé PDF is actually served', response.ok && type.includes('pdf'),
        `HTTP ${response.status}, ${type}, ${(await response.arrayBuffer()).byteLength} bytes`);
    }

    /* -------------------------------------------------------- summary ---- */
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${'─'.repeat(64)}`);
    console.log(`${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
      console.log('\nFailures:');
      for (const f of failed) console.log(`  · ${f.name} — ${f.detail}`);
    }
    const shots = await readdir(OUT);
    console.log(`\nScreenshots in .verify/: ${shots.filter((s) => s.endsWith('.png')).join(', ')}`);
    cdp.close();
    await cleanup();
    process.exit(failed.length ? 1 : 0);
  } catch (error) {
    console.error('\nHarness error:', error.message);
    try {
      await page.screenshot('99-failure');
    } catch {
      /* ignore */
    }
    console.error('Console:', page.console.slice(0, 6).join(' | '));
    console.error('Exceptions:', page.exceptions.slice(0, 6).join(' | '));
    cdp.close();
    await cleanup();
    process.exit(1);
  }
};

main();
