/**
 * Background: the toolbar button toggles Lector on the page, and (where browsers have
 * context menus) "Read aloud from here" starts at the text that was right-clicked.
 */
import { ext } from './shared/ext';

const MENU_ID = 'lector-read-here';

async function message(tabId: number, msg: object) {
  try {
    await ext.tabs.sendMessage(tabId, msg);
  } catch {
    // the tab was open before Lector was installed: add the content script, then retry
    try {
      await ext.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await ext.tabs.sendMessage(tabId, msg);
    } catch {
      /* a page extensions can't touch, like the browser's own pages */
    }
  }
}

ext.action.onClicked.addListener((tab) => {
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
