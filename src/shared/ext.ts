/** The WebExtension API: `browser` in Safari (and Firefox), `chrome` in Chrome. */
export const ext: typeof chrome =
  (globalThis as unknown as { browser?: typeof chrome }).browser ?? (globalThis as unknown as { chrome: typeof chrome }).chrome;
