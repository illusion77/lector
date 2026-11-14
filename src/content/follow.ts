/**
 * Keeping the sentence being read in view. Scrolls the page (or the box that scrolls the
 * text), and in paginated readers, which clip their text to a page, turns the page the
 * way a reader would: with the arrow keys.
 */

import { DEBUG, dlog } from '../shared/debug';

export type Insets = { top: number; bottom: number };

type Box = { left: number; top: number; right: number; bottom: number };

const PAGE_TURN_WAIT = 420;

function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function viewportBox(): Box {
  const vv = window.visualViewport;
  if (vv) return { left: vv.offsetLeft, top: vv.offsetTop, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height };
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}

/** Line boxes of a range, ignoring empty ones. */
export function rangeRects(range: Range): DOMRect[] {
  return Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
}

function union(rects: DOMRect[]): Box | null {
  if (!rects.length) return null;
  const b = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const r of rects) {
    b.left = Math.min(b.left, r.left);
    b.top = Math.min(b.top, r.top);
    b.right = Math.max(b.right, r.right);
    b.bottom = Math.max(b.bottom, r.bottom);
  }
  return b;
}

type Clip = {
  /** Where the element's content can be seen right now: the viewport, less every clipping ancestor. */
  box: Box;
  /** What the scrolling box shows: the viewport, less the scroller and the boxes around it. */
  view: Box;
  /**
   * Clipping boxes between the element and its scroller (text truncated with an ellipsis,
   * a post collapsed behind "Read more"). Scrolling moves them along with the text, so they
   * decide which part of the text can be brought into view, not where the view is.
   */
  inner: Box | null;
  pager: Element | null;
  scroller: Element | null;
};

const intersect = (a: Box, r: Box) => {
  a.left = Math.max(a.left, r.left);
  a.right = Math.min(a.right, r.right);
  a.top = Math.max(a.top, r.top);
  a.bottom = Math.min(a.bottom, r.bottom);
};

/**
 * The part of the viewport where an element's content can be seen, the nearest
 * ancestor that scrolls it vertically, and the paginating box if it sits in one: a large
 * box that hides its overflow and can't be scrolled by the reader.
 */
function clipFor(el: Element): Clip {
  const box = viewportBox();
  const view = viewportBox();
  let inner: Box | null = null;
  let pager: Element | null = null;
  let scroller: Element | null = null;
  // text laid out in CSS columns, as paginated readers do
  let columns = false;
  for (let a: Element | null = el; a && a !== document.documentElement && a !== document.body; a = parentOf(a)) {
    const cs = getComputedStyle(a);
    if (!columns && (cs.columnCount !== 'auto' || cs.columnWidth !== 'auto')) columns = true;
    if (a === el) continue;
    const ox = cs.overflowX;
    const oy = cs.overflowY;
    if (ox === 'visible' && oy === 'visible') continue;
    const r = a.getBoundingClientRect();
    const clip: Box = {
      left: ox !== 'visible' ? r.left : -Infinity,
      right: ox !== 'visible' ? r.right : Infinity,
      top: oy !== 'visible' ? r.top : -Infinity,
      bottom: oy !== 'visible' ? r.bottom : Infinity,
    };
    intersect(box, clip);
    if (!scroller && (oy === 'auto' || oy === 'scroll') && a.scrollHeight > a.clientHeight + 4) scroller = a;
    if (scroller) intersect(view, clip);
    else {
      inner ??= { left: -Infinity, right: Infinity, top: -Infinity, bottom: Infinity };
      intersect(inner, clip);
    }
    // a large box that hides what overflows sideways, holding columns or wider content:
    // the reader turns its pages (WebKit leaves column overflow out of scrollWidth)
    if (
      !pager &&
      (ox === 'hidden' || ox === 'clip') &&
      (columns || a.scrollWidth > a.clientWidth + 8) &&
      r.width > window.innerWidth * 0.4 &&
      r.height > window.innerHeight * 0.4
    ) {
      pager = a;
    }
  }
  return { box, view, inner, pager, scroller };
}

/** A visible box, less what fixed bars and the player cover (they sit at the viewport's edges). */
function band(box: Box, insets: Insets) {
  const vp = viewportBox();
  return { top: Math.max(box.top, vp.top + insets.top), bottom: Math.min(box.bottom, vp.bottom - insets.bottom) };
}

export type Visibility = 'visible' | 'before' | 'after' | 'left' | 'right' | 'unknown';

/** Where a range is relative to what the reader can see. */
export function visibility(range: Range, insets: Insets): Visibility {
  const rects = rangeRects(range);
  const u = union(rects);
  if (!u) return 'unknown';
  const container = range.commonAncestorContainer;
  const el = container instanceof Element ? container : container.parentElement;
  if (!el) return 'unknown';
  const { box } = clipFor(el);
  const { top, bottom } = band(box, insets);
  const first = rects[0];
  if (first.left >= box.right - 1) return 'right';
  if (first.right <= box.left + 1) return 'left';
  if (u.bottom <= top + 2) return 'before';
  if (first.top >= bottom - 2) return 'after';
  return 'visible';
}

/** Whether the start of a range can be seen: somewhere to begin reading from. */
export function startsInView(range: Range, insets: Insets): boolean {
  const first = rangeRects(range)[0];
  if (!first) return false;
  const container = range.commonAncestorContainer;
  const el = container instanceof Element ? container : container.parentElement;
  if (!el) return false;
  const { box } = clipFor(el);
  const { top, bottom } = band(box, insets);
  return (
    first.top >= top - 4 &&
    first.bottom <= bottom + 4 &&
    first.left >= box.left - 2 &&
    first.right <= box.right + 2
  );
}

let ownScrollUntil = 0;

/** Scrolls we cause ourselves, which must not count as the reader scrolling away. */
export function isOwnScroll(): boolean {
  return performance.now() < ownScrollUntil;
}

function pressKey(key: 'ArrowRight' | 'ArrowLeft') {
  const init: KeyboardEventInit = { key, code: key, bubbles: true, cancelable: true, composed: true };
  const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Brings a sentence into view. In a scrolling page it is placed about a third of the way
 * down, and only when it has left a comfortable band; in a paginated reader the page is
 * turned until the sentence shows.
 */
export async function reveal(getRange: () => Range | null, insets: Insets, smooth = true): Promise<boolean> {
  let range = getRange();
  if (!range) return false;
  const container = range.commonAncestorContainer;
  const el = container instanceof Element ? container : container.parentElement;
  if (!el) return false;

  // paginated: turn pages towards the sentence
  for (let turns = 0; turns < 40; turns++) {
    const vis = visibility(range, insets);
    if (vis !== 'left' && vis !== 'right') break;
    const { pager } = clipFor(el);
    if (!pager) break;
    const before = rangeRects(range)[0]?.left;
    ownScrollUntil = performance.now() + PAGE_TURN_WAIT + 400;
    pressKey(vis === 'right' ? 'ArrowRight' : 'ArrowLeft');
    await wait(PAGE_TURN_WAIT);
    range = getRange();
    if (!range) return false;
    const after = rangeRects(range)[0]?.left;
    if (after === before) return false; // the page didn't move: not a reader we can drive
  }

  const rects = rangeRects(range);
  const u = union(rects);
  const desc = (e: Element | null) => (e ? `${e.localName}.${(e.className?.toString() ?? '').split(' ')[0].slice(0, 20)}` : 'window');
  if (!u) {
    dlog('reveal: no rects for', desc(el));
    return false;
  }
  const { view, inner, scroller } = clipFor(el);
  // the band the scrolling box shows, less what fixed bars and the player cover
  const vp = viewportBox();
  const top = Math.max(view.top, vp.top + insets.top);
  const bottom = Math.min(view.bottom, vp.bottom - insets.bottom);
  const height = bottom - top;
  // the part of the sentence that can be shown: text hidden in a collapsed box can't be
  // scrolled into view, so the end of that box is shown instead of chasing the text
  let t = { top: u.top, bottom: u.bottom };
  if (inner && inner.bottom > inner.top) {
    const a = Math.max(u.top, inner.top);
    const b = Math.min(u.bottom, inner.bottom);
    if (b > a) t = { top: a, bottom: b };
    else if (u.top >= inner.bottom) t = { top: Math.max(inner.top, inner.bottom - 28), bottom: inner.bottom };
    else t = { top: inner.top, bottom: Math.min(inner.bottom, inner.top + 28) };
  }
  const where = !DEBUG ? '' : `u ${Math.round(u.top)}..${Math.round(u.bottom)} t ${Math.round(t.top)}..${Math.round(t.bottom)} band ${Math.round(top)}..${Math.round(bottom)} scroller ${desc(scroller)} el ${desc(el)}`;
  if (height <= 40) {
    dlog('reveal: band too small', where);
    return false;
  }
  const comfortableTop = top + height * 0.08;
  const comfortableBottom = bottom - height * 0.12;
  if (t.top >= comfortableTop && t.bottom <= comfortableBottom) return true;
  dlog('reveal: scrolling', where);

  // aim for a third of the way down; a sentence taller than the band starts at its top
  const target = t.bottom - t.top > height * 0.6 ? top + height * 0.06 : top + height * 0.3;
  const delta = t.top - target;
  if (Math.abs(delta) < 2) return true;
  ownScrollUntil = performance.now() + (smooth ? 900 : 200);
  const behavior: ScrollBehavior = smooth ? 'smooth' : 'auto';
  if (scroller) scroller.scrollBy({ top: delta, behavior });
  else window.scrollBy({ top: delta, behavior });
  return true;
}

/** Height of a fixed or sticky header covering the top of the viewport, if any. */
export function fixedTopInset(exclude: Element | null): number {
  let inset = 0;
  const xs = [window.innerWidth * 0.25, window.innerWidth * 0.5, window.innerWidth * 0.75];
  for (const x of xs) {
    for (const hit of document.elementsFromPoint(x, 4)) {
      if (exclude && (hit === exclude || exclude.contains(hit))) continue;
      for (let a: Element | null = hit; a && a !== document.body && a !== document.documentElement; a = parentOf(a)) {
        const pos = getComputedStyle(a).position;
        if (pos === 'fixed' || pos === 'sticky') {
          const r = a.getBoundingClientRect();
          if (r.top <= 4 && r.bottom < window.innerHeight * 0.3 && r.width > window.innerWidth * 0.5) inset = Math.max(inset, r.bottom);
          break;
        }
      }
    }
  }
  return inset;
}

/** Whether the range is in a paginated container (so the end of the text means "turn the page"). */
export function inPager(range: Range): boolean {
  const container = range.commonAncestorContainer;
  const el = container instanceof Element ? container : container.parentElement;
  return Boolean(el && clipFor(el).pager);
}

/** Turn the page forward once, for readers that load more text when asked. */
export function turnPageForward() {
  ownScrollUntil = performance.now() + PAGE_TURN_WAIT + 400;
  pressKey('ArrowRight');
}
