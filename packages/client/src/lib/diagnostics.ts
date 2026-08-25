/**
 * One switch for the tagged `[QD][…]` / `[QuickDrop][…]` traces.
 *
 * These traces exist for one job: pinning a real-device multi-customer failure to an
 * exact stage from a phone's remote console, instead of guessing. That makes them
 * valuable while debugging and noise otherwise — a single customer connecting emits a
 * dozen lines, so three phones on a shop dashboard would flood a real user's console.
 *
 * Enabled when EITHER holds:
 *   • it's a dev build (`import.meta.env.DEV`), or
 *   • the page opts in at runtime with `?qdlog=1` or `localStorage.quickdrop_debug=1`.
 *
 * The runtime opt-in is what makes real-device debugging practical: a phone loading the
 * PRODUCTION bundle over a tunnel can be told to trace by appending a query parameter,
 * with no rebuild and no logging left on for anyone else.
 *
 * Both the shop-side queue tracer and the customer-side connection tracer read this, so
 * one call flips everything and nothing can be left half-enabled.
 */

/** True in a `vite dev` build. Not stubbable — hence it's a parameter below, not a read. */
function isDevBuild(): boolean {
  try {
    return Boolean((import.meta as any).env?.DEV);
  } catch {
    // Plain Node (SSR, scripts): no import.meta.env.
    return false;
  }
}

/**
 * The decision itself, with the one untestable input passed in. `import.meta.env.DEV` is a
 * reserved Vite key that `vi.stubEnv` cannot override, so taking it as an argument is what
 * lets the production-build behaviour — the case that actually ships — be tested.
 *
 * @param devBuild whether this is a development build.
 */
export function detectDiagnosticsEnabled(devBuild: boolean): boolean {
  if (devBuild) return true;
  try {
    if (new URLSearchParams(window.location.search).get('qdlog') === '1') return true;
  } catch {
    // No DOM.
  }
  try {
    if (localStorage.getItem('quickdrop_debug') === '1') return true;
  } catch {
    // Storage blocked by privacy settings. Not a reason to fail.
  }
  return false;
}

let DIAGNOSTICS_ENABLED: boolean | null = null;

/** Silence or enable the tagged trace logs. Overrides the detected default. */
export function setDiagnosticsEnabled(enabled: boolean) {
  DIAGNOSTICS_ENABLED = enabled;
}

export function isDiagnosticsEnabled(): boolean {
  // Detected once and memoised: this is called on hot paths (per chunk, per progress
  // tick), and neither the build mode nor the URL changes mid-session.
  if (DIAGNOSTICS_ENABLED === null) DIAGNOSTICS_ENABLED = detectDiagnosticsEnabled(isDevBuild());
  return DIAGNOSTICS_ENABLED;
}
