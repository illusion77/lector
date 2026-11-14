/**
 * Content script entry. Stays tiny until Lector is opened on the page: then it builds
 * the text model and mounts the player bar.
 */
import { Controller, type Start } from './controller';
import { clearHighlight } from './highlight';
import { DEBUG, dlog } from '../shared/debug';
import { ext } from '../shared/ext';
import type { Platform } from '../shared/protocol';

declare global {
  interface Window {
    /** The extension URL of the copy of this script running on the page. */
    __lector?: string;
  }
}

type Message = { type: 'toggle' } | { type: 'read-here'; selection: boolean };

/**
 * After Lector is updated or reinstalled, pages that were already open keep the old copy of
 * this script, which can no longer reach the extension; its player bar stays on screen, dead.
 * When a new copy starts on such a page, it clears away what the old one left behind.
 */
function clearStale() {
  for (const el of document.querySelectorAll('lector-bar, lector-reload')) el.remove();
  clearHighlight();
}

/** Set by the background's "reload the page" prompt (see background.ts). */
const OPEN_AFTER_RELOAD = 'lector:open-after-reload';

const self = ext.runtime.getURL('');
dlog('content: loaded', location.href.slice(0, 160), 'already', window.__lector === self ? 'this' : window.__lector ? 'stale' : 'none');
if (window.__lector !== self) {
  window.__lector = self;
  clearStale();

  const platform: Platform =
    /iPhone|iPad|iPod|Android/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))
      ? 'touch'
      : 'desktop';

  let controller: Controller | null = null;
  let contextPoint: { x: number; y: number } | null = null;

  const hasSelection = () => Boolean(document.getSelection()?.toString().trim());

  const open = (start: Start) => {
    if (controller?.isOpen) {
      controller.startFrom(start);
      return;
    }
    const c = new Controller(platform, () => {
      if (controller === c) controller = null;
    });
    controller = c;
    void c.open(start, true);
  };

  ext.runtime.onMessage.addListener((msg: Message, _sender: unknown, reply: (r: { ok: true }) => void) => {
    dlog('content: message', JSON.stringify(msg), 'open', Boolean(controller?.isOpen));
    // the background takes a missing reply to mean this page needs the script again
    reply({ ok: true });
    if (msg?.type === 'toggle') {
      if (controller?.isOpen) controller.close();
      else open(hasSelection() ? { kind: 'selection' } : { kind: 'visible' });
    } else if (msg?.type === 'read-here') {
      if (msg.selection && hasSelection()) open({ kind: 'selection' });
      else if (contextPoint) open({ kind: 'point', ...contextPoint });
      else open({ kind: 'visible' });
    }
    return false;
  });

  // remember where a context menu was opened, for "Read aloud from here"
  document.addEventListener('contextmenu', (e) => (contextPoint = { x: e.clientX, y: e.clientY }), true);

  const editable = (t: EventTarget | null) => {
    const el = t as HTMLElement | null;
    return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
  };

  // Option-key shortcuts (layout independent, so ⌥K works whatever character it types)
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || editable(e.composedPath()[0] ?? e.target)) return;
      const c = controller?.isOpen ? controller : null;
      switch (e.code) {
        case 'KeyK':
          if (c) c.toggle();
          else open(hasSelection() ? { kind: 'selection' } : { kind: 'visible' });
          break;
        case 'KeyJ':
        case 'ArrowUp':
          if (!c) return;
          c.prev();
          break;
        case 'KeyL':
        case 'ArrowDown':
          if (!c) return;
          c.next();
          break;
        case 'ArrowLeft':
        case 'ArrowRight':
          if (!c) return;
          c.adjust(e.code === 'ArrowRight' ? 'faster' : 'slower');
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );

  // ⌥-click a sentence to read from it (and keep Chrome from downloading a clicked link)
  window.addEventListener(
    'click',
    (e) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || !controller?.isOpen) return;
      if (controller.element.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      controller.startFrom({ kind: 'point', x: e.clientX, y: e.clientY });
    },
    true,
  );

  // the reader asked to reload the page to get Lector working again: open it now
  let reopen = false;
  try {
    reopen = sessionStorage.getItem(OPEN_AFTER_RELOAD) === '1';
    sessionStorage.removeItem(OPEN_AFTER_RELOAD);
  } catch {
    /* storage blocked */
  }
  if (reopen) setTimeout(() => open({ kind: 'visible' }), 400);

  // debug builds: #lector-probe=Some text|Other text logs the elements around those texts,
  // with their attributes, for writing site rules (src/content/sites.ts)
  const probe = DEBUG ? decodeURIComponent(location.hash).match(/lector-probe=([^#&]+)/)?.[1] : undefined;
  if (probe) {
    setTimeout(() => {
      const describe = (el: Element) => {
        const attrs = [...el.attributes]
          .filter((a) => a.name !== 'style' && !a.name.startsWith('on'))
          .map((a) => `${a.name}=${a.value.slice(0, 50)}`)
          .join(' ');
        return `${el.localName}[${attrs}] (${el.childElementCount})`;
      };
      const visit = (root: Document | ShadowRoot, needle: string, found: Text[]) => {
        const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        for (let n: Node | null = tw.currentNode; n; n = tw.nextNode()) {
          if (n instanceof Element && n.shadowRoot) visit(n.shadowRoot, needle, found);
          if (n.nodeType === Node.TEXT_NODE && (n as Text).data.includes(needle) && !n.parentElement?.closest('script, style, noscript, template')) found.push(n as Text);
        }
      };
      for (const needle of probe.split('|')) {
        const found: Text[] = [];
        visit(document, needle, found);
        dlog('probe', JSON.stringify(needle), found.length, 'found');
        for (const t of found.slice(0, 2)) {
          const chain: string[] = [];
          for (let a: Element | null = t.parentElement; a && a !== document.body; ) {
            chain.push(describe(a));
            a = a.parentElement ?? ((a.getRootNode() as ShadowRoot).host || null);
          }
          dlog('probe chain', chain.join('\n   < '));
          dlog('probe html', (t.parentElement?.parentElement?.outerHTML ?? '').replace(/ class="[^"]*"/g, '').slice(0, 700));
        }
      }
    }, 7000);
  }

  // debug builds: a page opened with #lector-autotest opens Lector by itself, for remote testing
  if (DEBUG && location.hash.includes('lector-autotest')) setTimeout(() => open({ kind: 'visible' }), 800);

  // a click on the page folds the settings card away
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (controller?.isOpen && !controller.element.contains(e.target as Node)) controller.pageClicked();
    },
    true,
  );
}
