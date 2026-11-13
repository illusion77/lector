/**
 * Development logging that reaches the Mac from an iPhone or simulator, where there's no
 * console to read: built only with LECTOR_DEBUG=http://host:port/, posting to a local log
 * server. Content scripts hand their lines to the background, since a page's own rules
 * (mixed content, CSP) can block the request from there.
 */
import { ext } from './ext';

declare const __LECTOR_DEBUG__: string;

const t0 = Date.now();

export const DEBUG = __LECTOR_DEBUG__ !== '';

/** Where the caller was called from, for logs. */
export function caller(): string {
  if (!DEBUG) return '';
  return (new Error().stack ?? '').split('\n').slice(3, 5).map((l) => l.trim().replace(/^at /, '').split(/[ @]/)[0]).join(' < ');
}

let sink: ((text: string) => void) | null = null;

/** Content scripts: send log lines through the player once it's there. */
export function setLogSink(fn: ((text: string) => void) | null) {
  sink = fn;
}

export function dlog(...args: unknown[]) {
  if (!__LECTOR_DEBUG__) return;
  const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const inPage = typeof location !== 'undefined' && /^https?:$/.test(location.protocol) && typeof window !== 'undefined' && window.top === window;
  try {
    if (!inPage) postLog(text);
    else if (sink) sink(`[page +${Date.now() - t0}] ${text}`);
    else if (location.protocol === 'http:') postLog(`[page +${Date.now() - t0}] ${text}`);
    else void ext.runtime.sendMessage({ type: 'lector-log', text: `[page +${Date.now() - t0}] ${text}` }).catch(() => {});
  } catch {
    /* ignore */
  }
}

export function postLog(text: string) {
  if (!__LECTOR_DEBUG__) return;
  void fetch(__LECTOR_DEBUG__, { method: 'POST', body: text, mode: 'cors' }).catch(() => {});
}
