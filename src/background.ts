/**
 * Background: the toolbar button toggles Lector on the page, and (where browsers have
 * context menus) "Read aloud from here" starts at the text that was right-clicked.
 */
import { dlog, markBackground, postLog } from './shared/debug';
import { ext } from './shared/ext';

declare const __LECTOR_DEBUG__: string;

markBackground();
dlog('bg: started');

const MENU_ID = 'lector-read-here';

/** Key in the page's session storage asking the content script to open Lector after a reload. */
const OPEN_AFTER_RELOAD = 'lector:open-after-reload';

/**
 * Shown on a page that still runs the copy of Lector from before an update. Safari keeps
 * that copy in the page, injects any new one into the same dead context, and only a reload
 * gives the page a working one. Runs in the page, so it must be self-contained.
 */
function askToReload(key: string) {
  // a prompt from an earlier tap may linger (its timer stops while the page sits in the
  // back-forward cache): start over with a fresh one
  for (const old of document.querySelectorAll('lector-reload')) old.remove();
  const host = document.createElement('lector-reload');
  const root = host.attachShadow({ mode: 'closed' });
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  root.innerHTML = `<style>
    :host { all: initial; position: fixed; z-index: 2147483647; left: 0; right: 0;
      bottom: calc(env(safe-area-inset-bottom, 0px) + 16px); display: flex; justify-content: center; pointer-events: none; }
    .box { pointer-events: auto; display: flex; align-items: center; gap: 12px; max-width: calc(100vw - 32px);
      padding: 10px 10px 10px 18px; border-radius: 22px; font: 500 15px/1.3 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      color: ${dark ? '#f5f5f7' : '#1d1d1f'}; background: ${dark ? 'rgba(44,44,46,.94)' : 'rgba(250,250,252,.94)'};
      -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); box-shadow: 0 8px 28px rgba(0,0,0,.22); }
    button { all: unset; cursor: pointer; padding: 8px 14px; border-radius: 15px; font-weight: 600;
      color: #1d1d1f; background: #f0a500; -webkit-tap-highlight-color: transparent; }
    button.x { padding: 8px 10px; color: inherit; background: transparent; font-weight: 400; opacity: .6; }
  </style><div class="box"><span>Lector was updated. Reload the page to use it.</span>
  <button class="go" type="button">Reload</button><button class="x" type="button" aria-label="Dismiss">✕</button></div>`;
  root.querySelector('.go')!.addEventListener('click', () => {
    try {
      sessionStorage.setItem(key, '1');
    } catch {
      /* opens on the next tap instead */
    }
    location.reload();
  });
  const dismiss = () => host.remove();
  root.querySelector('.x')!.addEventListener('click', dismiss);
  setTimeout(dismiss, 20000);
  document.documentElement.append(host);
}

/**
 * Sends a message to the page's content script, which confirms each one with a reply.
 * No reply: the tab was open before Lector was installed (no script yet, so add it) or
 * before it was updated (a dead copy; Chrome reports the failed send as an error, Safari
 * says it was delivered). If adding the script doesn't help, the page needs a reload.
 */
async function message(tabId: number, msg: object) {
  const send = async () => {
    try {
      return Boolean(((await ext.tabs.sendMessage(tabId, msg)) as { ok?: boolean } | undefined)?.ok);
    } catch {
      return false;
    }
  };
  if (await send()) return;
  dlog('bg: no reply from tab', tabId, '- injecting');
  try {
    await ext.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    if (await send()) return;
    dlog('bg: still no reply - asking for a reload');
    await ext.scripting.executeScript({ target: { tabId }, func: askToReload, args: [OPEN_AFTER_RELOAD] });
  } catch (e) {
    /* a page extensions can't touch, like the browser's own pages */
    dlog('bg: inject failed', String((e as Error)?.message ?? e));
  }
}

if (__LECTOR_DEBUG__) {
  ext.runtime.onMessage.addListener((msg: { type?: string; text?: string }) => {
    if (msg?.type === 'lector-log' && msg.text) postLog(msg.text);
    return false;
  });
}

ext.action.onClicked.addListener((tab) => {
  dlog('bg: action clicked, tab', tab.id, tab.url?.slice(0, 40));
  if (tab.id !== undefined) void message(tab.id, { type: 'toggle' });
});

if (ext.contextMenus) {
  ext.runtime.onInstalled.addListener(() => {
    ext.contextMenus.removeAll(() => {
      ext.contextMenus.create({ id: MENU_ID, title: 'Read aloud from here', contexts: ['page', 'selection', 'link'] });
    });
  });
  ext.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_ID && tab?.id !== undefined) {
      void message(tab.id, { type: 'read-here', selection: Boolean(info.selectionText) });
    }
  });
}
