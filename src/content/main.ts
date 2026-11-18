/**
 * Content script entry. Stays tiny until Lector is opened on the page: then it builds
 * the text model and mounts the player bar.
 */
import { Controller, type Start } from './controller';
import { clearHighlight } from './highlight';
import { TextModel } from './text-model';
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

/** What the toolbar button (toggle), ⌥K (playpause) or a reload prompt (open) asks for. */
type Action = 'toggle' | 'playpause' | 'open';

/** Between the copies of this script in a page's frames. */
type FrameMessage =
  | { lector: 'route'; id: string; action: Action }
  | { lector: 'routed'; id: string; handled: boolean }
  | { lector: 'opened'; session: string }
  | { lector: 'close-others'; session: string };

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
  const isTop = window === window.top;
  /** This frame's reading session, so that opening one closes those in the page's other frames. */
  let session = '';

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
    session = Math.random().toString(36).slice(2);
    window.top?.postMessage({ lector: 'opened', session } satisfies FrameMessage, '*');
    void c.open(start, true);
  };

  /* ------------------------------------------------------------ frames */

  // Some sites show the article in an iframe: chapters in the top page, the chapter beside them.
  // Lector runs in every frame, and a reading session lives entirely in the frame that holds the
  // text. The top frame takes the toolbar button and hands it to the frame the reader is looking
  // at. Frames talk with postMessage, which works across origins.

  /** An iframe that fills most of the viewport at its centre. */
  const mainFrame = (): Window | null => {
    const x = window.innerWidth / 2, y = window.innerHeight / 2;
    let el = document.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (!(el instanceof HTMLIFrameElement || el instanceof HTMLFrameElement)) return null;
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    return w > 0 && h > 0 && w * h >= 0.4 * window.innerWidth * window.innerHeight ? el.contentWindow : null;
  };

  /** Something to read aloud: a video player or a widget in a frame has only scraps. */
  const hasText = () => {
    if (!document.body) return false;
    const model = TextModel.build(document.body, null);
    return model.sentences.reduce((n, s) => n + s.speech.length, 0) >= 60;
  };

  /** Hands an action to Lector in `frame`. False if it has nothing to read there, or no Lector answers. */
  const ask = (frame: Window, action: Action) =>
    new Promise<boolean>((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const done = (handled: boolean) => {
        window.removeEventListener('message', onReply);
        clearTimeout(timer);
        resolve(handled);
      };
      const onReply = (e: MessageEvent) => {
        const m = e.data as FrameMessage | null;
        if (e.source === frame && m?.lector === 'routed' && m.id === id) done(m.handled);
      };
      window.addEventListener('message', onReply);
      const timer = setTimeout(() => done(false), 800);
      frame.postMessage({ lector: 'route', id, action } satisfies FrameMessage, '*');
    });

  /**
   * The toolbar button or ⌥K: acts on the session here, or hands the action to the frame the reader
   * is looking at, or opens Lector here. A frame that was handed it (`asked`) declines when it has
   * nothing to read, and the frame that asked opens Lector itself.
   */
  const route = async (action: Action, asked = false): Promise<boolean> => {
    const c = controller?.isOpen ? controller : null;
    if (c) {
      if (action === 'toggle') c.close();
      else if (action === 'playpause') c.toggle();
      return true;
    }
    if (hasSelection()) {
      open({ kind: 'selection' });
      return true;
    }
    const frame = mainFrame();
    if (frame && (await ask(frame, action))) return true;
    if (asked && !hasText()) return false;
    open({ kind: 'visible' });
    return true;
  };

  window.addEventListener('message', (e) => {
    const m = e.data as FrameMessage | null;
    if (!m || typeof m !== 'object' || typeof m.lector !== 'string') return;
    if (m.lector === 'route' && !isTop && e.source === window.parent) {
      const from = e.source;
      void route(m.action, true).then((handled) => from.postMessage({ lector: 'routed', id: m.id, handled } satisfies FrameMessage, '*'));
    } else if ((m.lector === 'opened' && isTop) || (m.lector === 'close-others' && !isTop && e.source === window.parent)) {
      // one session per page: the top frame passes the news down to every frame
      if (controller?.isOpen && session !== m.session) controller.close();
      for (let i = 0; i < window.frames.length; i++) {
        window.frames[i].postMessage({ lector: 'close-others', session: m.session } satisfies FrameMessage, '*');
      }
    }
  });

  ext.runtime.onMessage.addListener((msg: Message, _sender: unknown, reply: (r: { ok: true }) => void) => {
    dlog('content: message', JSON.stringify(msg), 'open', Boolean(controller?.isOpen), 'top', isTop);
    // the toolbar button reaches every frame; the top one decides where it goes
    if (msg?.type === 'toggle' && !isTop) return false;
    // the background takes a missing reply to mean this page needs the script again
    reply({ ok: true });
    if (msg?.type === 'toggle') {
      void route('toggle');
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
          void route('playpause');
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
  // (asked in the top frame; frames on the same origin share its session storage)
  let reopen = false;
  if (isTop) {
    try {
      reopen = sessionStorage.getItem(OPEN_AFTER_RELOAD) === '1';
      sessionStorage.removeItem(OPEN_AFTER_RELOAD);
    } catch {
      /* storage blocked */
    }
  }
  if (reopen) setTimeout(() => void route('open'), 400);

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
