/**
 * Regression tests for the navigation selector collision.
 *
 * `Nav` used to resolve its links with a document-wide
 * `document.querySelector('a[href="#intro"]')`. The skip link is the earliest
 * anchor with that href in the document, so it won the lookup: the Intro nav
 * item kept whatever state the markup gave it and never updated, while the
 * skip link was stamped with `data-active` and `aria-current` that it should
 * never carry.
 *
 * These tests pin the scoping contract of `resolveNavLinks` using a stub
 * navigation subtree. The end-to-end behaviour (exactly one active item, and
 * the skip link never holding aria-current) is asserted against a real DOM by
 * tools/verify.mjs.
 */

import { describe, expect, it } from 'vitest';
import { resolveNavLinks } from '../src/ui/nav';
import { navSections } from '../src/data/content';

interface StubAnchor {
  className: string;
}

/** Minimal ParentNode stand-in that answers exactly the selector used. */
const navStub = (anchors: Record<string, StubAnchor>) =>
  ({
    querySelector: (selector: string): StubAnchor | null => {
      const match = /^a\[href="#(.+)"\]$/.exec(selector);
      return match ? (anchors[match[1]] ?? null) : null;
    },
  }) as unknown as ParentNode;

describe('resolveNavLinks', () => {
  it('resolves each section to an anchor inside the navigation', () => {
    const intro = { className: 'nav__link' };
    const nav = navStub({ intro });
    const links = resolveNavLinks(nav, [{ id: 'intro' }]);
    expect(links.size).toBe(1);
    expect(links.get('intro')).toBe(intro);
  });

  it('never resolves a link the navigation does not contain', () => {
    // A document-scoped lookup would have returned the skip link here. The
    // navigation has no #intro anchor, so the map must come back empty rather
    // than silently reaching outside its own subtree.
    const nav = navStub({});
    expect(resolveNavLinks(nav, [{ id: 'intro' }]).size).toBe(0);
  });

  it('is handed every declared section id, and only those', () => {
    const asked: string[] = [];
    const nav = {
      querySelector: (selector: string): null => {
        asked.push(selector);
        return null;
      },
    } as unknown as ParentNode;

    resolveNavLinks(nav, navSections);
    expect(asked).toEqual(navSections.map((s) => `a[href="#${s.id}"]`));
  });

  it('does not qualify its selectors with the skip link or the header mark', () => {
    const asked: string[] = [];
    const nav = {
      querySelector: (selector: string): null => {
        asked.push(selector);
        return null;
      },
    } as unknown as ParentNode;

    resolveNavLinks(nav, [{ id: 'intro' }]);
    // A document-wide selector would have had to be written to *exclude* the
    // two competing anchors. Scoping to the container needs no such guard.
    expect(asked[0]).toBe('a[href="#intro"]');
    expect(asked[0]).not.toContain('.skip');
    expect(asked[0]).not.toContain('header');
  });

  it('returns an empty map when there is no navigation at all', () => {
    expect(resolveNavLinks(null, navSections).size).toBe(0);
  });
});