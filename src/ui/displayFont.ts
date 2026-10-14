/**
 * Hero entrance gate.
 *
 * The masthead animates on first paint, but the display face arrives with a
 * stylesheet that is swapped in asynchronously (`media="print"` → `all`). Run
 * the entrance before that resolves and the name composes in the fallback
 * serif, then re-renders in Instrument Serif under the visitor — measured at
 * 216px → 723px → 506px.
 *
 * Two things are unreliable as a "is the face ready?" signal, and both were
 * measured in Chrome before settling on the pair used here:
 *
 *   - `FontFaceSet.check()` is *vacuously* true until the stylesheet has been
 *     parsed, because the document then holds no `@font-face` rule for the
 *     family at all. Gating on it alone released the entrance at 395ms — and
 *     released it immediately even when the font request was blocked outright.
 *   - The stylesheet `<link>` cannot report its own outcome: `link.sheet` is
 *     non-null from DOMContentLoaded even when the request is blocked, and
 *     neither `load` nor `error` fires for a blocked print stylesheet.
 *
 * So the gate asks two questions in order. First, has a `FontFace` for the
 * display family actually been registered — which can only happen once the
 * stylesheet has been parsed, at which point `check()` starts telling the
 * truth. Then, is it loaded.
 *
 * This module answers only that question. The CSS holds the name in its
 * natural, fully visible state until `data-display-font="ready"` appears on
 * the root, so a face that never arrives costs the entrance animation, never
 * the name itself.
 *
 * Kept free of real DOM access so both outcomes — ready, and timed out — are
 * unit-testable without a browser.
 */

/** The subset of `FontFaceSet` this gate depends on. */
export interface FontProbe {
  check: (font: string, text?: string) => boolean;
  load?: (font: string, text?: string) => Promise<unknown>;
}

/** Family of the hero's display tier. */
export const DISPLAY_FONT_FAMILY = 'Instrument Serif';

/** Matches the hero's display tier: 8rem of Instrument Serif. */
export const DISPLAY_FONT_PROBE = `400 8rem "${DISPLAY_FONT_FAMILY}"`;

/**
 * The text the name is set in. Passing it forces the latin subset to be
 * considered rather than any face whose unicode-range happens to match.
 */
export const DISPLAY_FONT_TEXT = 'KARTHIKEYA';

/**
 * Total budget for both phases. The stylesheet and the font file are both
 * external; this bounds the worst case so a blocked or offline visitor gets a
 * still, fully legible name rather than an indefinite wait.
 */
export const DISPLAY_FONT_TIMEOUT_MS = 3000;

/** How often each phase is re-checked while waiting. */
const POLL_MS = 40;

/** Normalises a CSS family name for comparison: `Instrument Serif` → `instrument serif`. */
const normaliseFamily = (family: string): string =>
  String(family).replace(/["']/g, '').trim().toLowerCase();

/**
 * True when the document has actually registered a face for `family`.
 *
 * This is the only trustworthy readiness signal: a face cannot exist before
 * the stylesheet carrying its `@font-face` rule has been parsed, which is
 * exactly the window in which `check()` lies.
 */
export const hasFontFace = (
  faces: Iterable<{ family: string }> | null | undefined,
  family: string = DISPLAY_FONT_FAMILY,
): boolean => {
  if (!faces) return false;
  const wanted = normaliseFamily(family);
  for (const face of faces) {
    if (normaliseFamily(face.family) === wanted) return true;
  }
  return false;
};

/**
 * True only when the display face is registered *and* loaded. Only meaningful
 * once `hasFontFace` has returned true — see the module note.
 *
 * A missing `FontFaceSet`, a missing `check`, or a throwing implementation all
 * answer false, so the caller falls back to the non-animated state.
 */
export const displayFontAvailable = (
  fonts: FontProbe | null | undefined,
  faceRegistered: boolean,
): boolean => {
  if (!faceRegistered) return false;
  if (!fonts || typeof fonts.check !== 'function') return false;
  try {
    return fonts.check(DISPLAY_FONT_PROBE, DISPLAY_FONT_TEXT) === true;
  } catch {
    return false;
  }
};

export interface DisplayFontDeps {
  /** The document's `FontFaceSet`, or null when unsupported. */
  fonts: FontProbe | null | undefined;
  /** The same set, for enumerating registered faces. */
  faces?: Iterable<{ family: string }> | null;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/**
 * Resolves `true` when the display face is genuinely usable, `false` if it did
 * not arrive within the deadline or the Font Loading API is unavailable.
 *
 * Resolving `false` is always safe: the caller leaves `data-display-font`
 * unset and the name stays visible and still.
 */
export const waitForDisplayFont = async (
  deps: DisplayFontDeps,
): Promise<boolean> => {
  const now = deps.now ?? ((): number => performance.now());
  const wait =
    deps.wait ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? DISPLAY_FONT_TIMEOUT_MS;
  const fonts = deps.fonts;

  // No Font Loading API: there is nothing to observe, so run the entrance as
  // authored rather than dropping it.
  if (!fonts) return true;

  const started = now();
  const expired = (): boolean => now() - started >= timeoutMs;

  // Phase 1 — wait for the @font-face rule to be registered. Until this
  // succeeds, `check()` cannot distinguish "not here yet" from "not available".
  let registered = hasFontFace(deps.faces);
  while (!registered) {
    if (expired()) return false;
    await wait(POLL_MS);
    registered = hasFontFace(deps.faces);
  }

  // Phase 2 — the face exists, so `check()` now reports "unloaded" honestly.
  // Nudge the fetch; `load()` can settle before the file is ready, so it is
  // only a hint and `check()` remains the authority.
  if (typeof fonts.load === 'function') {
    try {
      void Promise.resolve(fonts.load(DISPLAY_FONT_PROBE, DISPLAY_FONT_TEXT)).catch(
        () => undefined,
      );
    } catch {
      /* availability is still polled below */
    }
  }

  for (;;) {
    if (displayFontAvailable(fonts, true)) return true;
    if (expired()) return false;
    await wait(POLL_MS);
  }
};