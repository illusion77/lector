/**
 * Development logging that reaches the Mac from an iPhone or simulator, where there's no
 * console to read: built only with LECTOR_DEBUG=1, posting to a local log server.
 */
declare const __LECTOR_DEBUG__: string;

export function dlog(...args: unknown[]) {
  if (!__LECTOR_DEBUG__) return;
  const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try {
    void fetch(__LECTOR_DEBUG__, { method: 'POST', body: text, mode: 'cors' }).catch(() => {});
  } catch {
    /* ignore */
  }
}
