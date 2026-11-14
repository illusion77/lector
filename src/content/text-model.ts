/**
 * The page as a list of sentences. Text is gathered in rendering order (through open
 * shadow roots and slots), grouped into runs of text that share a block box, and each
 * run is cut into sentences that map back to DOM ranges.
 */
import { splitSentences, speakable } from './segment';
import { siteConfig } from './sites';

export interface Run {
  /** Nearest block-level ancestor. */
  el: Element;
  nodes: Text[];
  /** The run's text with whitespace collapsed. */
  text: string;
  /** For each character of `text`: which node, and the offset in it. */
  mapNode: Uint32Array;
  mapOff: Uint32Array;
  linkChars: number;
  /** 2 inside an article, 1 inside main, 0 elsewhere. */
  region: number;
  /** Inside something a site rule says to read: the general filters leave it alone. */
  kept: boolean;
}

export interface Sentence {
  run: Run;
  start: number;
  end: number;
  /** As shown on the page. */
  text: string;
  /** What the voice says. */
  speech: string;
  en: boolean;
  lang: string;
}

const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'canvas', 'video',
  'audio', 'svg', 'math', 'select', 'option', 'textarea', 'input', 'button', 'pre', 'rt', 'rp',
  'head', 'title', 'link', 'meta', 'img', 'picture', 'map', 'datalist',
]);
const SKIP_ROLES = new Set([
  'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menu', 'menubar',
  'toolbar', 'tablist', 'tab', 'tooltip', 'button', 'switch', 'slider', 'progressbar', 'status', 'note',
  'doc-noteref', 'doc-backlink',
]);
/** Class names that mark page furniture rather than the text itself (matched whole). */
const NOISE_CLASSES = new Set([
  'caption', 'credit', 'credits', 'byline', 'share', 'sharing', 'social-share', 'newsletter',
  'related', 'promo', 'advert', 'advertisement', 'ad', 'ads', 'sponsored', 'visually-hidden',
  'sr-only', 'screen-reader-text', 'skip-link', 'breadcrumb', 'breadcrumbs', 'cookie-banner',
]);

/** A run that only labels an ad: "Advertisement", "Advertisement - Scroll to Continue", "Sponsored". */
const AD_LABEL = /^(advertisement|advertising|sponsored( content)?|ad|paid (post|content)|promoted)( [-–—·] scroll to continue( with content)?)?$/i;
/** A page's copyright line ("Copyright ©2026 Dow Jones & Company, Inc. All Rights Reserved."). */
const COPYRIGHT = /^(copyright\s*(©|\(c\)|\d{4})|©\s*\d{4}|\(c\)\s*\d{4})/i;

/** A line that is only a number, like a vote or view count ("8.3K", "1,204"): never worth saying. */
function isCount(text: string): boolean {
  return /^[+\-−]?[\d.,]+\s*[kmb万千]?\+?$/i.test(text);
}

function isNoise(el: Element): boolean {
  const tag = el.localName;
  if (tag === 'figcaption') return true;
  // a picture with its caption and credit; figures of quotes or code stay
  if (tag === 'figure' && el.querySelector('img, picture, video, svg, canvas, iframe')) return true;
  // a date on its own line ("2 hours ago"), not one inside a sentence
  if (tag === 'time' && el.parentElement?.textContent?.trim() === el.textContent?.trim()) return true;
  const cls = el.classList;
  for (let i = 0; i < cls.length; i++) if (NOISE_CLASSES.has(cls[i].toLowerCase())) return true;
  return false;
}

const SPACE = /[\s\u00a0\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff]/;

/** Chrome lets extensions see closed shadow roots too; elsewhere only open ones. */
const openOrClosed: ((el: Element) => ShadowRoot | null) | undefined = (() => {
  const dom = (globalThis as unknown as { chrome?: { dom?: { openOrClosedShadowRoot?: (el: Element) => ShadowRoot | null } } }).chrome?.dom;
  return dom?.openOrClosedShadowRoot?.bind(dom);
})();

function shadowOf(el: Element): ShadowRoot | null {
  if (el.shadowRoot) return el.shadowRoot;
  try {
    return openOrClosed?.(el) ?? null;
  } catch {
    return null;
  }
}

/** Children in rendering order: a shadow host shows its shadow tree, a slot its assigned nodes. */
function renderedChildren(node: Node, roots: ShadowRoot[]): ArrayLike<Node> {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element;
    const sr = shadowOf(el);
    if (sr) {
      roots.push(sr);
      return sr.childNodes;
    }
    if (el.localName === 'slot') {
      const assigned = (el as HTMLSlotElement).assignedNodes();
      if (assigned.length) return assigned;
    }
  }
  return node.childNodes;
}

function isVisuallyHidden(cs: CSSStyleDeclaration): boolean {
  if (cs.position !== 'absolute' && cs.position !== 'fixed') return false;
  if (cs.overflow !== 'hidden' && cs.clipPath === 'none' && cs.clip === 'auto') return false;
  return parseFloat(cs.width) <= 2 || parseFloat(cs.height) <= 2;
}

/** Footnote and citation markers: a superscript that is (or holds) a link, like [12]. */
function isNoteRef(el: Element): boolean {
  if (el.localName !== 'sup') return false;
  const text = el.textContent ?? '';
  if (text.length > 24) return false;
  return Boolean(el.querySelector('a') || el.closest('a') || /ref|note|cite/i.test(el.className));
}

function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function isBlockDisplay(display: string): boolean {
  return !(display.startsWith('inline') || display === 'contents' || display.startsWith('ruby'));
}

export class TextModel {
  runs: Run[] = [];
  sentences: Sentence[] = [];
  /** Shadow roots the text lives in, for styling highlights and watching for changes. */
  shadowRoots: ShadowRoot[] = [];
  private runOfNode = new Map<Text, Run>();
  private firstSentenceOfRun = new Map<Run, number>();

  static build(root: Element, exclude: Element | null): TextModel {
    const model = new TextModel();
    model.collect(root, exclude);
    model.segment();
    return model;
  }

  private collect(root: Element, exclude: Element | null) {
    const site = siteConfig();
    const siteSkip = site.skip;
    // a site rule naming the article itself: read only that, if the page has it
    const only =
      site.only && [...document.querySelectorAll(site.only)].some((el) => (el.textContent ?? '').trim().length > 40) ? site.only : '';
    let current: Run | null = null;
    let chars: string[] = [];
    let mapNode: number[] = [];
    let mapOff: number[] = [];
    let lastSpace = true;

    const finish = () => {
      if (current) {
        // drop a trailing space
        if (chars.length && chars[chars.length - 1] === ' ') {
          chars.pop();
          mapNode.pop();
          mapOff.pop();
        }
        current.text = chars.join('');
        current.mapNode = Uint32Array.from(mapNode);
        current.mapOff = Uint32Array.from(mapOff);
        if (current.text) this.runs.push(current);
      }
      current = null;
      chars = [];
      mapNode = [];
      mapOff = [];
      lastSpace = true;
    };

    const addText = (node: Text, block: Element, inLink: boolean, region: number, kept: boolean) => {
      const data = node.data;
      if (!current) {
        if (!/\S/.test(data)) return;
        current = { el: block, nodes: [], text: '', mapNode: new Uint32Array(), mapOff: new Uint32Array(), linkChars: 0, region, kept };
      } else if (current.el !== block) {
        finish();
        return addText(node, block, inLink, region, kept);
      }
      const run: Run = current;
      const idx = run.nodes.length;
      run.nodes.push(node);
      this.runOfNode.set(node, run);
      for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        if (INVISIBLE.test(ch)) continue;
        if (SPACE.test(ch)) {
          if (lastSpace) continue;
          chars.push(' ');
          lastSpace = true;
        } else {
          chars.push(ch);
          lastSpace = false;
          if (inLink) run.linkChars++;
        }
        mapNode.push(idx);
        mapOff.push(i);
      }
    };

    const keepSel = site.keep;
    const walk = (node: Node, block: Element, region: number, inLink: boolean, inside = !only, kept = false) => {
      const kids = renderedChildren(node, this.shadowRoots);
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (child.nodeType === Node.TEXT_NODE) {
          if (inside) addText(child as Text, block, inLink, region, kept);
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const el = child as Element;
        if (el === exclude) continue;
        const tag = el.localName;
        if (tag === 'br') {
          finish();
          continue;
        }
        if (SKIP_TAGS.has(tag)) continue;
        const keep = kept || (keepSel !== '' && el.matches(keepSel));
        const role = el.getAttribute('role');
        const own = tag === 'article' || role === 'article' ? 2 : tag === 'main' || role === 'main' ? 1 : 0;
        const main = Math.max(region, own);
        if (!keep) {
          if (tag === 'nav' || tag === 'aside') continue;
          if (el.getAttribute('aria-hidden') === 'true') continue;
          if (role && SKIP_ROLES.has(role)) continue;
          if ((tag === 'header' || tag === 'footer') && !main) continue;
          if (isNoteRef(el) || isNoise(el)) continue;
        }
        if (siteSkip && el.matches(siteSkip)) continue;
        const within = inside || (only !== '' && el.matches(only));
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') continue;
        if (cs.contentVisibility === 'hidden' || isVisuallyHidden(cs)) continue;
        // fixed bars and overlays (site headers, running heads, cookie notices, faded-out
        // toolbars) are chrome, not content; a fixed box filling the screen is an app's page
        if (cs.position === 'fixed' || (cs.opacity === '0' && cs.position === 'absolute')) {
          const r = el.getBoundingClientRect();
          if (cs.opacity === '0' || r.width * r.height < 0.4 * window.innerWidth * window.innerHeight) continue;
        }
        // floated boxes beside the text: infoboxes, sidebars, pull quotes (not drop caps)
        if (cs.float !== 'none' && (el.textContent?.length ?? 0) > 40) {
          const parent = parentOf(el);
          if (parent && el.getBoundingClientRect().width < parent.getBoundingClientRect().width * 0.6) continue;
        }
        if (isBlockDisplay(cs.display)) {
          finish();
          walk(el, el, main, inLink, within, keep);
          finish();
        } else {
          walk(el, block, main, inLink || tag === 'a', within, keep);
        }
      }
    };

    walk(root, root, 0, false);
    finish();

    // navigation-like runs: short and almost all link text; ad labels; copyright lines
    this.runs = this.runs.filter(
      (r) =>
        (r.kept || !(r.text.length < 160 && r.linkChars > 0.75 * r.text.replace(/\s/g, '').length)) &&
        !AD_LABEL.test(r.text) &&
        !COPYRIGHT.test(r.text) &&
        !site.skipText.some((re) => re.test(r.text)),
    );
  }

  private segment() {
    for (const run of this.runs) {
      this.firstSentenceOfRun.set(run, this.sentences.length);
      for (const span of splitSentences(run.text)) {
        const text = run.text.slice(span.start, span.end);
        const speech = speakable(text);
        if (!speech || isCount(speech)) continue;
        this.sentences.push({ run, start: span.start, end: span.end, text, speech, en: span.en, lang: span.lang });
      }
    }
  }

  /** A live DOM range for the sentence, or null when the page has changed under it. */
  range(s: Sentence): Range | null {
    const r = s.run;
    const a = r.nodes[r.mapNode[s.start]];
    const b = r.nodes[r.mapNode[s.end - 1]];
    const ao = r.mapOff[s.start];
    const bo = r.mapOff[s.end - 1] + 1;
    if (!a?.isConnected || !b?.isConnected || ao > a.data.length || bo > b.data.length) return null;
    try {
      const range = document.createRange();
      range.setStart(a, ao);
      range.setEnd(b, bo);
      return range;
    } catch {
      return null;
    }
  }

  /** Index of the sentence at (or the first one after) a DOM position. */
  indexAt(node: Node, offset: number): number {
    let text: Text | null = null;
    let off = offset;
    if (node.nodeType === Node.TEXT_NODE) text = node as Text;
    else {
      // an element position: take the first text node at or after it
      const start = node.childNodes[offset] ?? node;
      const walker = document.createTreeWalker(start, NodeFilter.SHOW_TEXT);
      text = (start.nodeType === Node.TEXT_NODE ? start : walker.nextNode()) as Text | null;
      off = 0;
    }
    const run = text ? this.runOfNode.get(text) : undefined;
    if (!run || !text) return -1;
    const nodeIdx = run.nodes.indexOf(text);
    // first character at or after (node, offset)
    let pos = run.text.length;
    for (let i = 0; i < run.mapNode.length; i++) {
      if (run.mapNode[i] > nodeIdx || (run.mapNode[i] === nodeIdx && run.mapOff[i] >= off)) {
        pos = i;
        break;
      }
    }
    const first = this.firstSentenceOfRun.get(run) ?? -1;
    if (first < 0) return -1;
    for (let i = first; i < this.sentences.length && this.sentences[i].run === run; i++) {
      if (this.sentences[i].end > pos) return i;
    }
    // past the run's last sentence: the next one
    let i = first;
    while (i < this.sentences.length && this.sentences[i].run === run) i++;
    return i < this.sentences.length ? i : -1;
  }

  runOf(node: Text): Run | undefined {
    return this.runOfNode.get(node);
  }
}
