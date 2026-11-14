/**
 * Marks the sentence being read with the CSS Custom Highlight API, which paints over
 * the page's text without touching its DOM. `::highlight()` rules don't cross shadow
 * boundaries, so the rule is added to each shadow root that holds highlighted text.
 *
 * WebKit (Safari 26) doesn't paint custom highlights on text whose block box also holds
 * anything but inline content: a block-level `::before` or `::after` (the "trim the leading"
 * trick news sites use on headlines), a block or floated child, flex or grid layout. Text
 * there is marked by Lector itself instead: boxes drawn in a layer of its own over the page,
 * blended so the text stays as crisp as under a real highlight.
 */

const NAME = 'lector-sentence';
const STYLE_ATTR = 'data-lector-highlight';
const OVERLAY_TAG = 'lector-mark';
const COLORS = { light: 'rgba(255, 184, 0, 0.32)', dark: 'rgba(255, 196, 51, 0.36)' };
/** The same marks for the overlay: opaque colours that, blended, give what COLORS give on the page. */
const OVERLAY = {
  light: { color: 'rgb(255, 236, 173)', blend: 'multiply' },
  dark: { color: 'rgb(92, 68, 8)', blend: 'screen' },
};
const rule = (theme: 'light' | 'dark') => `::highlight(${NAME}) { background-color: ${COLORS[theme]}; color: inherit; }`;
let theme: 'light' | 'dark' = 'light';
const styles: HTMLStyleElement[] = [];

type HighlightLike = { add(r: Range): void; clear(): void };
type HighlightRegistry = Map<string, HighlightLike>;
type HighlightCtor = new (...ranges: Range[]) => HighlightLike;

const registry: HighlightRegistry | undefined = (globalThis.CSS as unknown as { highlights?: HighlightRegistry })?.highlights;
const HighlightClass: HighlightCtor | undefined = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;

const styled = new WeakSet<Document | ShadowRoot>();
/**
 * One highlight object, changed in place. WebKit doesn't repaint text whose highlight was
 * replaced in the registry, so swapping in a new object leaves the old sentence marked.
 */
let mark: HighlightLike | null = null;

function ensureStyle(root: Document | ShadowRoot) {
  if (styled.has(root)) return;
  styled.add(root);
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTR, '');
  style.textContent = rule(theme);
  styles.push(style);
  if (root instanceof Document) (root.head ?? root.documentElement).append(style);
  else root.append(style);
}

/** Nodes Lector adds to the page itself, which page-change observers should ignore. */
export function isOwnStyle(node: Node): boolean {
  return node instanceof Element && (node.hasAttribute(STYLE_ATTR) || node.localName === OVERLAY_TAG);
}

/** Dark pages get a slightly stronger mark, which otherwise reads muddy. */
export function setHighlightTheme(t: 'light' | 'dark') {
  if (t === theme) return;
  theme = t;
  for (const s of styles) s.textContent = rule(t);
  overlay.styleHost();
}

/* ------------------------------------------------- where WebKit can't paint */

/** Safari and other WebKit browsers; Chrome's UA mentions WebKit too, but paints these fine. */
const WEBKIT = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|OPR/.test(navigator.userAgent);

const INLINE = /^inline(?!-(block|flex|grid|table))|^contents$|^ruby/;

function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** The box a text node's lines are laid out in: its nearest ancestor that isn't inline. */
function blockOf(t: Text): Element | null {
  for (let el = t.parentElement ?? (t.parentNode instanceof ShadowRoot ? t.parentNode.host : null); el; el = parentOf(el)) {
    if (!INLINE.test(getComputedStyle(el).display)) return el;
  }
  return null;
}

/** Whether a block-level box sits among this box's inline content, or the box isn't a plain block. */
function isMixed(block: Element): boolean {
  const cs = getComputedStyle(block);
  if (/flex|grid/.test(cs.display)) return true;
  for (const pseudo of ['::before', '::after']) {
    const ps = getComputedStyle(block, pseudo);
    if (ps.content === 'none' || ps.content === 'normal' || ps.display === 'none') continue;
    if (!INLINE.test(ps.display) && ps.position !== 'absolute' && ps.position !== 'fixed') return true;
  }
  for (const child of block.children) {
    const c = getComputedStyle(child);
    if (c.display === 'none' || c.position === 'absolute' || c.position === 'fixed') continue;
    if (c.float !== 'none' || !INLINE.test(c.display)) return true;
  }
  return false;
}

/** The sentence's text, piece by piece, split by whether WebKit will paint a highlight on it. */
function split(range: Range): { native: Range[]; own: Range[] } {
  const native: Range[] = [];
  const own: Range[] = [];
  const container = range.commonAncestorContainer;
  const texts: Text[] = [];
  if (container.nodeType === Node.TEXT_NODE) texts.push(container as Text);
  else {
    const tw = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) if (range.intersectsNode(n)) texts.push(n as Text);
  }
  const mixed = new Map<Element, boolean>();
  for (const t of texts) {
    if (!/\S/.test(t.data)) continue;
    const r = document.createRange();
    r.setStart(t, t === range.startContainer ? range.startOffset : 0);
    r.setEnd(t, t === range.endContainer ? range.endOffset : t.length);
    if (r.collapsed) continue;
    const block = WEBKIT ? blockOf(t) : null;
    let m = block ? mixed.get(block) : false;
    if (m === undefined && block) {
      m = isMixed(block);
      mixed.set(block, m);
    }
    (m ? own : native).push(r);
  }
  return { native, own };
}

/* ------------------------------------------------------------- the overlay */

const overlay = {
  host: null as HTMLElement | null,
  root: null as ShadowRoot | null,
  style: null as HTMLStyleElement | null,
  ranges: [] as Range[],
  frame: 0,
  last: '',

  styleHost() {
    if (!this.host) return;
    const o = OVERLAY[theme];
    this.host.style.cssText =
      'all: initial !important; position: fixed !important; inset: 0 !important; display: block !important; ' +
      'pointer-events: none !important; z-index: 2147483646 !important; overflow: hidden !important; ' +
      `mix-blend-mode: ${o.blend} !important; --lector-mark: ${o.color};`;
  },

  set(ranges: Range[]) {
    this.ranges = ranges;
    if (!ranges.length) {
      this.stop();
      return;
    }
    if (!this.host) {
      this.host = document.createElement(OVERLAY_TAG);
      this.root = this.host.attachShadow({ mode: 'closed' });
      this.style = document.createElement('style');
      this.style.textContent = '.b { position: absolute; background: var(--lector-mark); }';
      this.root.append(this.style);
      this.styleHost();
    }
    if (!this.host.isConnected) document.documentElement.append(this.host);
    this.last = '';
    if (!this.frame) this.tick();
  },

  /** Follows the text every frame while marked: scrolling, reflow, pages turning. */
  tick() {
    this.frame = requestAnimationFrame(() => this.tick());
    this.draw();
  },

  draw() {
    const rects: DOMRect[] = [];
    for (const r of this.ranges) {
      const node = r.startContainer;
      if (!node.isConnected) continue;
      const el = node.parentElement;
      for (const rect of r.getClientRects()) {
        if (rect.width < 0.5 || rect.height < 0.5) continue;
        if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue;
        if (el && covered(el, rect)) continue;
        rects.push(rect);
      }
    }
    // whole pixels, and fresh boxes each time: moving a box on iOS can leave a hairline behind
    const boxes = rects.map((r) => {
      const left = Math.floor(r.left);
      const top = Math.floor(r.top);
      return [left, top, Math.ceil(r.right) - left, Math.ceil(r.bottom) - top];
    });
    const key = boxes.join(';');
    if (key === this.last) return;
    this.last = key;
    const layer = document.createElement('div');
    for (const [left, top, width, height] of boxes) {
      const b = document.createElement('div');
      b.className = 'b';
      b.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
      layer.append(b);
    }
    this.root!.replaceChildren(this.style!, layer);
  },

  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.ranges = [];
    this.last = '';
    if (this.root && this.style) this.root.replaceChildren(this.style);
  },

  remove() {
    this.stop();
    this.host?.remove();
  },
};

/** Whether something else (a sticky header, a menu) sits over this part of the text. */
function covered(el: Element, rect: DOMRect): boolean {
  const hit = document.elementFromPoint(rect.left + Math.min(4, rect.width / 2), rect.top + rect.height / 2);
  if (!hit) return false;
  for (let a: Element | null = el; a; a = parentOf(a)) if (a === hit) return false;
  return !el.contains(hit);
}

/* --------------------------------------------------------------- marking */

export function highlight(range: Range | null) {
  if (!registry || !HighlightClass) return;
  if (!mark) mark = new HighlightClass();
  mark.clear();
  if (!range) {
    overlay.stop();
    return;
  }
  const { native, own } = split(range);
  if (native.length) {
    ensureStyle(document);
    const root = range.startContainer.getRootNode();
    if (root instanceof ShadowRoot) ensureStyle(root);
    for (const r of native) mark.add(r);
    if (registry.get(NAME) !== mark) registry.set(NAME, mark);
  }
  overlay.set(own);
}

export function clearHighlight() {
  // a mark left by an earlier copy of the script is cleared too (WebKit repaints on clear)
  (mark ?? registry?.get(NAME))?.clear();
  registry?.delete(NAME);
  mark = null;
  overlay.remove();
  for (const old of document.querySelectorAll(OVERLAY_TAG)) old.remove();
}
