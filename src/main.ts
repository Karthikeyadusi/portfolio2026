import './styles/main.css';

import { ScrollEngine } from './core/scroll';
import {
  getDetailTier,
  getMotionPolicy,
  onMotionPreferenceChange,
  type DetailTier,
  type MotionPolicy,
} from './core/motion';
import { Iris } from './scenes/iris';
import { Transitions } from './scenes/transitions';
import { IntroScene } from './scenes/introScene';
import { WorkScene } from './scenes/workScene';
import { AboutScene } from './scenes/aboutScene';
import { ContactScene } from './scenes/contactScene';
import { Nav } from './ui/nav';
import { Reveal } from './ui/reveal';
import { waitForDisplayFont } from './ui/displayFont';

/* ------------------------------------------------------------------- lookup */

function need<T extends Element>(selector: string, scope: ParentNode = document): T {
  const el = scope.querySelector<T>(selector);
  if (!el) throw new Error(`Missing required element: ${selector}`);
  return el;
}

function needAll<T extends Element>(selector: string, scope: ParentNode = document): T[] {
  return Array.from(scope.querySelectorAll<T>(selector));
}

/* --------------------------------------------------------------------- boot */

/**
 * Releases the hero entrance once the display face is usable.
 *
 * The masthead's two animations are suppressed in CSS until this attribute
 * appears on the root, so the name never composes in a fallback serif and then
 * re-renders. `waitForDisplayFont` handles the two unreliable signals itself —
 * see its module note — and simply reports whether the face is genuinely ready.
 *
 * If it is not, the attribute is never set and the CSS leaves the name fully
 * visible and static: a lost entrance rather than a lost name.
 * `ScrollEngine` re-measures on `fonts.ready` independently, so scroll geometry
 * is unaffected either way.
 */
function releaseHeroEntrance(): void {
  void waitForDisplayFont({
    fonts: typeof document.fonts === 'undefined' ? null : document.fonts,
    faces: typeof document.fonts === 'undefined' ? null : document.fonts,
  }).then((ready) => {
    if (ready) document.documentElement.dataset.displayFont = 'ready';
  });
}

function boot(): void {
  let policy: MotionPolicy = getMotionPolicy();
  let tier: DetailTier = getDetailTier();

  const engine = new ScrollEngine({ smoothing: policy.smoothing, lambda: 16 });
  const nav = new Nav();

  /* -- apertures --------------------------------------------------------- */
  const introHost = need<HTMLElement>('[data-overlay="intro"]');
  const contactHost = need<HTMLElement>('[data-overlay="contact"]');

  const introIris = new Iris({
    blade: '#07090c',
    edge: 'rgba(243,168,84,0.9)',
    bladeCount: tier === 'low' ? 9 : 12,
    className: 'iris--intro',
  });
  const contactIris = new Iris({
    blade: '#0b0c0e',
    edge: 'rgba(255,255,255,0.85)',
    bladeCount: tier === 'low' ? 9 : 12,
    className: 'iris--contact',
  });
  introHost.appendChild(introIris.element);
  contactHost.appendChild(contactIris.element);
  contactIris.element.style.visibility = 'hidden';

  const introSection = need<HTMLElement>('#intro');
  const workSection = need<HTMLElement>('#work');
  const contactSection = need<HTMLElement>('#contact');

  const transitions = new Transitions({
    introIris,
    introSection,
    workSection,
  });

  /* -- scenes ------------------------------------------------------------ */
  const intro = new IntroScene({
    section: introSection,
    card: need<HTMLElement>('[data-intro-card]'),
    dial: need<HTMLElement>('[data-dial]'),
    readout: need<HTMLElement>('[data-intro-readout]'),
    cue: need<HTMLElement>('[data-scroll-cue]'),
    next: workSection,
  });
  intro.register(engine);

  const work = new WorkScene(
    {
      section: workSection,
      stage: need<HTMLElement>('[data-work-stage]'),
      canvas: need<HTMLCanvasElement>('[data-work-canvas]'),
      panels: needAll<HTMLElement>('.panel'),
      ticks: needAll<HTMLElement>('.rail__tick'),
      readouts: {
        frame: need<HTMLElement>('[data-readout="frame"]'),
        angle: need<HTMLElement>('[data-readout="angle"]'),
        scale: need<HTMLElement>('[data-readout="scale"]'),
        mat: need<HTMLElement>('[data-readout="mat"]'),
      },
    },
    policy,
    tier,
  );
  work.register(engine);

  const about = new AboutScene(
    {
      section: need<HTMLElement>('#about'),
      column: need<HTMLElement>('[data-about-column]'),
      canvas: need<HTMLCanvasElement>('[data-about-canvas]'),
      rows: needAll<HTMLElement>('.capability'),
    },
    policy,
    tier,
  );
  about.register(engine);

  const contact = new ContactScene({
    section: contactSection,
    panel: need<HTMLElement>('[data-contact-panel]'),
    iris: contactIris,
    mark: need<HTMLElement>('[data-contact-mark]'),
    horizon: need<HTMLElement>('[data-horizon]'),
  });
  contact.register(engine);

  new Reveal();

  releaseHeroEntrance();

  /* -- layout ------------------------------------------------------------ */
  const applySize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const nextTier = getDetailTier();
    if (nextTier !== tier) {
      tier = nextTier;
      work.applyPolicy(policy);
    }
    transitions.resize(w, h);
    work.resize();
    about.resize(tier);
  };

  let resizeTimer = 0;
  window.addEventListener(
    'resize',
    () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(applySize, 120);
    },
    { passive: true },
  );

  applySize();

  /* -- frame plumbing ---------------------------------------------------- */
  let scrollY = window.scrollY;
  engine.onChange(() => {
    scrollY = window.scrollY;
    transitions.update(scrollY);
    nav.update(scrollY);
  });

  onMotionPreferenceChange((reduced) => {
    policy = getMotionPolicy();
    engine.setSmoothing(policy.smoothing);
    work.applyPolicy(policy);
    about.applyPolicy(policy);
    document.documentElement.dataset.motion = reduced ? 'reduced' : 'full';
  });

  document.documentElement.dataset.motion = policy.reduced ? 'reduced' : 'full';

  // Initial paint + deep-link correctness.
  engine.refresh();
  transitions.update(window.scrollY);
  nav.update(window.scrollY);

  /* -- back to top ------------------------------------------------------- */
  const backToTop = need<HTMLButtonElement>('[data-back-to-top]');
  backToTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: policy.reduced ? 'auto' : 'smooth' });
    const first = document.getElementById('intro-title');
    // Move focus so keyboard users are not left at the bottom of the document.
    window.setTimeout(() => first?.focus({ preventScroll: true }), policy.reduced ? 0 : 650);
  });

  // Expose a tiny surface for the browser verification harness.
  (window as unknown as Record<string, unknown>).__aperture = {
    engine,
    work,
    about,
    transitions,
    intro,
    contact,
    policy: () => policy,
    scrollY: () => window.scrollY,
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
