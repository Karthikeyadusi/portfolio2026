/**
 * Regression tests for the hero font gate.
 *
 * The masthead's entrance used to start at first paint, while the display face
 * arrived with a stylesheet swapped in asynchronously. The name therefore
 * composed in the fallback serif and re-rendered in Instrument Serif under the
 * visitor — measured at 216px → 723px → 506px.
 *
 * Two earlier versions of this gate were measured in Chrome and did not work.
 * Both traps are pinned shut below so they cannot be reintroduced:
 *
 *   - gating on `document.fonts.check()` alone released the entrance at 395ms,
 *     because check() is vacuously true before the stylesheet is parsed;
 *   - gating on the stylesheet `<link>` released it immediately even with the
 *     font request blocked, because `link.sheet` is non-null from
 *     DOMContentLoaded and neither load nor error fires for a blocked print
 *     stylesheet.
 */

import { describe, expect, it } from 'vitest';
import {
  DISPLAY_FONT_FAMILY,
  DISPLAY_FONT_PROBE,
  DISPLAY_FONT_TEXT,
  DISPLAY_FONT_TIMEOUT_MS,
  displayFontAvailable,
  hasFontFace,
  waitForDisplayFont,
  type DisplayFontDeps,
  type FontProbe,
} from '../src/ui/displayFont';

/** A FontFaceSet stand-in whose load state flips after `loadedAfter` checks. */
const probe = (loadedAfter: number): FontProbe & { checks: number } => {
  let checks = 0;
  return {
    get checks() {
      return checks;
    },
    check: () => {
      checks += 1;
      return checks > loadedAfter;
    },
    load: () => Promise.resolve([]),
  };
};

/** Faces as the document reports them: quoted family, `unloaded` then `loaded`. */
const faces = (families: string[]): Array<{ family: string }> =>
  families.map((family) => ({ family: `"${family}"` }));

const stubClock = () => {
  let time = 0;
  let waits = 0;
  return {
    now: () => time,
    wait: async (ms: number) => {
      waits += 1;
      time += ms;
    },
    get elapsed() {
      return time;
    },
    get waits() {
      return waits;
    },
  };
};

const deps = (over: Partial<DisplayFontDeps>): DisplayFontDeps => ({
  fonts: { check: () => true },
  faces: faces([DISPLAY_FONT_FAMILY]),
  ...over,
});

describe('hasFontFace', () => {
  it('finds a face regardless of quoting and case', () => {
    for (const family of ['Instrument Serif', '"Instrument Serif"', "'Instrument Serif'"]) {
      expect(hasFontFace(faces([family]))).toBe(true);
    }
  });

  it('does not confuse a family with a prefix of it', () => {
    expect(hasFontFace(faces(['Instrument Sans']))).toBe(false);
    expect(hasFontFace(faces(['Instrument']))).toBe(false);
  });

  it('is false before the stylesheet has registered anything', () => {
    expect(hasFontFace([])).toBe(false);
    expect(hasFontFace(faces(['Inter', 'JetBrains Mono']))).toBe(false);
  });

  it('is false when there is no set to enumerate', () => {
    expect(hasFontFace(null)).toBe(false);
    expect(hasFontFace(undefined)).toBe(false);
  });
});

describe('displayFontAvailable', () => {
  it('requires the face to be registered before check() is trusted', () => {
    // The vacuous-truth trap: check() says yes, but no face exists yet.
    expect(displayFontAvailable({ check: () => true }, false)).toBe(false);
    expect(displayFontAvailable({ check: () => true }, true)).toBe(true);
  });

  it('rejects a face that is registered but not loaded', () => {
    expect(displayFontAvailable({ check: () => false }, true)).toBe(false);
  });

  it('rejects a missing FontFaceSet rather than throwing', () => {
    expect(displayFontAvailable(null, true)).toBe(false);
    expect(displayFontAvailable(undefined, true)).toBe(false);
    expect(displayFontAvailable({} as FontProbe, true)).toBe(false);
  });

  it('treats a throwing implementation as unavailable', () => {
    const broken: FontProbe = {
      check: () => {
        throw new Error('unsupported');
      },
    };
    expect(displayFontAvailable(broken, true)).toBe(false);
  });

  it('requires an exact boolean, not a truthy stand-in', () => {
    expect(displayFontAvailable({ check: () => 1 as unknown as boolean }, true)).toBe(false);
  });

  it('probes the hero display tier with the hero text', () => {
    let seen = '';
    displayFontAvailable(
      {
        check: (font, text) => {
          seen = `${font}|${text}`;
          return true;
        },
      },
      true,
    );
    expect(seen).toBe(`${DISPLAY_FONT_PROBE}|${DISPLAY_FONT_TEXT}`);
    expect(DISPLAY_FONT_FAMILY).toBe('Instrument Serif');
  });
});

describe('waitForDisplayFont — the two traps that were measured in Chrome', () => {
  it('does not trust check() before a face is registered', async () => {
    // Fonts "available" per check(), but nothing registered yet.
    const clock = stubClock();
    const resolved = await waitForDisplayFont(
      deps({ fonts: { check: () => true }, faces: [], now: clock.now, wait: clock.wait }),
    );
    // Timed out rather than releasing early.
    expect(resolved).toBe(false);
    expect(clock.elapsed).toBeGreaterThanOrEqual(DISPLAY_FONT_TIMEOUT_MS);
  });

  it('does not release when the font request is blocked outright', async () => {
    // No face is ever registered and check() still says true.
    const clock = stubClock();
    const resolved = await waitForDisplayFont(
      deps({
        fonts: { check: () => true },
        faces: [],
        now: clock.now,
        wait: clock.wait,
      }),
    );
    expect(resolved).toBe(false);
    expect(clock.elapsed).toBeGreaterThanOrEqual(DISPLAY_FONT_TIMEOUT_MS);
  });

  it('never consults check() before the face is registered', async () => {
    const order: string[] = [];
    let call = 0;
    const clock = stubClock();
    await waitForDisplayFont({
      fonts: {
        check: () => {
          order.push('check');
          return true;
        },
      },
      faces: {
        [Symbol.iterator]() {
          call += 1;
          const empty = call === 1;
          order.push(empty ? 'no-face' : 'face');
          const list = empty ? [] : [{ family: `"${DISPLAY_FONT_FAMILY}"` }];
          return list[Symbol.iterator]();
        },
      },
      now: clock.now,
      wait: clock.wait,
    });
    // Registration is observed before the availability check is ever made.
    expect(order).toEqual(['no-face', 'face', 'check']);
  });
});

describe('waitForDisplayFont', () => {
  it('resolves true immediately when registered and loaded', async () => {
    const fonts = probe(0);
    await expect(waitForDisplayFont(deps({ fonts }))).resolves.toBe(true);
  });

  it('resolves true once the face finishes loading', async () => {
    const fonts = probe(3);
    const clock = stubClock();
    await expect(
      waitForDisplayFont(deps({ fonts, now: clock.now, wait: clock.wait })),
    ).resolves.toBe(true);
    expect(clock.elapsed).toBeGreaterThan(0);
  });

  it('resolves false when the face registers but never loads', async () => {
    const fonts = probe(Number.POSITIVE_INFINITY);
    const clock = stubClock();
    await expect(
      waitForDisplayFont(deps({ fonts, now: clock.now, wait: clock.wait })),
    ).resolves.toBe(false);
    expect(clock.elapsed).toBeGreaterThanOrEqual(DISPLAY_FONT_TIMEOUT_MS);
  });

  it('shares one deadline across both phases', async () => {
    // Half the budget burns waiting for registration; the rest is not enough
    // to also load. The total must still be bounded.
    const clock = stubClock();
    await expect(
      waitForDisplayFont(
        deps({
          fonts: { check: () => false },
          faces: faces([DISPLAY_FONT_FAMILY]),
          now: clock.now,
          wait: clock.wait,
          timeoutMs: 200,
        }),
      ),
    ).resolves.toBe(false);
    expect(clock.elapsed).toBe(200);
  });

  it('stops polling once the deadline passes', async () => {
    const clock = stubClock();
    await expect(
      waitForDisplayFont(
        deps({
          fonts: { check: () => false },
          now: clock.now,
          wait: clock.wait,
          timeoutMs: 200,
        }),
      ),
    ).resolves.toBe(false);
    // 200ms polled every 40ms: five waits and the final check.
    expect(clock.waits).toBe(5);
  });

  it('runs the entrance un-gated when the Font Loading API is absent', async () => {
    // Nothing to observe, so dropping the animation would be the regression.
    await expect(waitForDisplayFont(deps({ fonts: null }))).resolves.toBe(true);
    await expect(waitForDisplayFont(deps({ fonts: undefined }))).resolves.toBe(true);
  });

  it('survives a FontFaceSet whose load() rejects', async () => {
    const fonts: FontProbe = {
      check: () => true,
      load: () => Promise.reject(new Error('network')),
    };
    await expect(waitForDisplayFont(deps({ fonts }))).resolves.toBe(true);
  });

  it('survives a FontFaceSet whose load() throws synchronously', async () => {
    const fonts: FontProbe = {
      check: () => true,
      load: () => {
        throw new Error('boom');
      },
    };
    await expect(waitForDisplayFont(deps({ fonts }))).resolves.toBe(true);
  });

  it('uses a bounded default deadline', () => {
    expect(DISPLAY_FONT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DISPLAY_FONT_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});