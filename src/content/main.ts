/**
 * Content script entry. Stays tiny until Lector is opened on the page: then it builds
 * the text model and mounts the player bar.
 */
import { Controller, type Start } from './controller';
import { ext } from '../shared/ext';
import type { Platform } from '../shared/protocol';

declare global {
  interface Window {
    __lector?: boolean;
  }
}

type Message = { type: 'toggle' } | { type: 'read-here'; selection: boolean };

if (!window.__lector) {
  window.__lector = true;

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

  ext.runtime.onMessage.addListener((msg: Message) => {
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
        case 'ArrowLeft':
          if (!c) return;
          c.prev();
          break;
        case 'KeyL':
        case 'ArrowRight':
          if (!c) return;
          c.next();
          break;
        case 'ArrowUp':
        case 'ArrowDown':
          if (!c) return;
          c.adjust(e.code === 'ArrowUp' ? 'faster' : 'slower');
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

  // a click on the page folds the settings card away
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (controller?.isOpen && !controller.element.contains(e.target as Node)) controller.pageClicked();
    },
    true,
  );
}
