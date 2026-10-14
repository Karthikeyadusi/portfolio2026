/**
 * Fixed chrome: the header, the page progress hairline, and active-section
 * tracking. The header inverts over the contact section, which is the only
 * place the page changes ground colour.
 */

import { clamp } from '../core/math';
import { navSections } from '../data/content';

/**
 * Resolves nav links by section id.
 *
 * The lookup is scoped to the navigation element on purpose. A document-wide
 * `document.querySelector('a[href="#intro"]')` matches the *skip link* first —
 * it is the earliest anchor with that href in the document — so the Intro item
 * was never touched at runtime and kept whatever state the markup gave it,
 * while the skip link accumulated `data-active` and `aria-current` that it has
 * no business carrying.
 *
 * Extracted as a pure function of the navigation subtree so the scoping is
 * testable without a DOM.
 */
export const resolveNavLinks = (
  nav: ParentNode | null,
  sections: readonly { id: string }[],
): Map<string, HTMLAnchorElement> => {
  const links = new Map<string, HTMLAnchorElement>();
  if (!nav) return links;
  for (const section of sections) {
    const link = nav.querySelector<HTMLAnchorElement>(`a[href="#${section.id}"]`);
    if (link) links.set(section.id, link);
  }
  return links;
};

export class Nav {
  private links = new Map<string, HTMLAnchorElement>();
  private bar: HTMLElement | null = null;
  private header: HTMLElement | null = null;
  private lastActive = '';

  constructor() {
    this.bar = document.querySelector('[data-page-bar]');
    this.header = document.querySelector('[data-header]');
    this.links = resolveNavLinks(document.querySelector('.nav'), navSections);
  }

  update(scrollY: number): void {
    const doc = document.documentElement;
    const max = Math.max(doc.scrollHeight - window.innerHeight, 1);
    const progress = clamp(scrollY / max);

    if (this.bar) this.bar.style.transform = `scaleX(${progress.toFixed(4)})`;
    const header = this.header;
    if (header) header.style.setProperty('--page-progress', progress.toFixed(4));

    let active: string = navSections[0].id;
    for (const section of navSections) {
      const el = document.getElementById(section.id);
      if (!el) continue;
      if (el.getBoundingClientRect().top <= window.innerHeight * 0.42) active = section.id;
    }

    /*
     * The contact panel is paper-coloured; the header has to follow it.
     *
     * Triggered on actual overlap — the section's top edge reaching the top of
     * the viewport, which is the moment the paper is genuinely underneath the
     * header — rather than on an approach threshold, which tinted the header
     * while several hundred pixels of the dark About section were still on
     * screen. The existing ink-to-paper CSS transition does the blending.
     *
     * This sits outside the `active === lastActive` early return on purpose:
     * the paper edge crossing the header does not coincide with the
     * active-section change, so gating it there would leave the header stuck.
     */
    const contact = document.getElementById('contact');
    if (contact && header) {
      const over = contact.getBoundingClientRect().top <= 0;
      header.dataset.theme = over ? 'paper' : 'ink';
    }

    if (active === this.lastActive) return;
    this.lastActive = active;

    for (const [id, link] of this.links) {
      const on = id === active;
      link.dataset.active = on ? 'true' : 'false';
      if (on) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
    if (header) header.dataset.section = active;
  }
}