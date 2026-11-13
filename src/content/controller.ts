/**
 * Reading session on one page: which sentence is current, what happens when it ends,
 * and keeping the page (highlight, scroll position, chips) in step with the player.
 */
import { Bar, type Chip } from './bar';
import { caller, dlog } from '../shared/debug';
import { fixedTopInset, inPager, isOwnScroll, reveal, startsInView, turnPageForward, visibility, rangeRects } from './follow';
import { clearHighlight, highlight, isOwnStyle, setHighlightTheme } from './highlight';
import { TextModel, type Sentence } from './text-model';
import type { Item, Platform, Theme, ToContent } from '../shared/protocol';
import { DEFAULTS, loadSettings, onSettingsChange, type Settings } from '../shared/settings';

export type Start =
  | { kind: 'visible' }
  | { kind: 'selection' }
  | { kind: 'point'; x: number; y: number };

const PREFETCH = 3;
const END_WAIT = 2600;

function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** The deepest element at a point, looking inside open shadow roots. */
function deepElementFromPoint(x: number, y: number): Element | null {
  let el = document.elementFromPoint(x, y);
  while (el?.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

/** Light or dark, from the colour behind the text in the middle of the screen. */
function pageTheme(exclude: Element): Theme {
  let el = deepElementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  if (el && exclude.contains(el)) el = document.body;
  for (let a: Element | null = el; a; a = parentOf(a)) {
    const m = getComputedStyle(a).backgroundColor.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/);
    if (!m) continue;
    const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (alpha < 0.5) continue;
    const [r, g, b] = [m[1], m[2], m[3]].map((v) => parseFloat(v) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45 ? 'dark' : 'light';
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

type SelectionWithComposed = Selection & {
  getComposedRanges?: (...args: unknown[]) => StaticRange[];
};

export class Controller {
  private bar: Bar;
  private model: TextModel | null = null;
  private dirty = true;
  private observers: MutationObserver[] = [];
  private observed = new WeakSet<Node>();
  private settings: Settings = { ...DEFAULTS };
  /** Indices into model.sentences that can be read (English only, or all). */
  private nav: number[] = [];
  private pos = -1;
  private current: Sentence | null = null;
  private intent: 'playing' | 'paused' = 'paused';
  private playId = 0;
  private seq = 0;
  private wantAutoplay = false;
  private followSuspended = false;
  private atEnd = false;
  private theme: Theme = 'light';
  private themeTimer = 0;
  private chipTimer = 0;
  private advancing = false;
  private closed = false;
  /** Sentences in a row the player couldn't say. */
  private failures = 0;

  constructor(
    private platform: Platform,
    private onClosed: () => void,
  ) {
    this.bar = new Bar(platform, (m) => this.onPlayer(m), (id) => this.onChip(id));
  }

  get isOpen() {
    return !this.closed;
  }

  get element(): Element {
    return this.bar.element;
  }

  async open(start: Start, autoplay: boolean) {
    this.settings = await loadSettings();
    onSettingsChange((s) => this.applySettings(s));
    this.theme = pageTheme(this.bar.element);
    setHighlightTheme(this.theme);
    this.wantAutoplay = autoplay;
    await this.bar.mount(this.theme, () => this.onConnected());
    this.bar.send({ type: 'hello', theme: this.theme, maxWidth: window.innerWidth - 24, maxHeight: window.innerHeight - 40, title: document.title });
    this.ensureModel();
    this.startAt(start, false);
    this.listen();
  }

  /* ------------------------------------------------------------- model */

  private ensureModel(): TextModel {
    if (this.model && !this.dirty) return this.model;
    const prev = this.current;
    const t0 = performance.now();
    this.model = TextModel.build(document.body, this.bar.element);
    this.dirty = false;
    if (document.documentElement.hasAttribute('data-lector-debug')) {
      console.debug(`[lector] ${this.model.runs.length} runs, ${this.model.sentences.length} sentences in ${Math.round(performance.now() - t0)} ms`);
    }
    this.observe(document.documentElement);
    for (const sr of this.model.shadowRoots) this.observe(sr);
    this.rebuildNav();
    dlog('model built', this.model.sentences.length, 'sentences,', this.nav.length, 'readable,', Math.round(performance.now() - t0), 'ms');
    if (prev) {
      const i = this.find(prev);
      dlog('model rebuilt: current', i >= 0 ? `found at ${i}` : 'lost', JSON.stringify(prev.text.slice(0, 30)));
      this.current = i >= 0 ? this.model.sentences[i] : null;
      this.pos = i >= 0 ? this.navPosFor(i) : -1;
      if (this.current) this.paint();
    }
    return this.model;
  }

  private observe(node: Node) {
    if (this.observed.has(node)) return;
    this.observed.add(node);
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (this.bar.element.contains(r.target)) continue;
        if (r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every((n) => isOwnStyle(n))) continue;
        this.dirty = true;
        return;
      }
    });
    mo.observe(node, { childList: true, subtree: true, characterData: true });
    this.observers.push(mo);
  }

  /** The same sentence in a rebuilt model: same block and text, else the nearest same text. */
  private find(s: Sentence): number {
    const list = this.model!.sentences;
    let fallback = -1;
    for (let i = 0; i < list.length; i++) {
      if (list[i].text !== s.text) continue;
      if (list[i].run.el === s.run.el) return i;
      if (fallback < 0) fallback = i;
    }
    return fallback;
  }

  private rebuildNav() {
    const list = this.model!.sentences;
    this.nav = [];
    for (let i = 0; i < list.length; i++) if (list[i].en || !this.settings.englishOnly) this.nav.push(i);
  }

  /** Position in `nav` of a sentence index, or of the first readable one after it. */
  private navPosFor(index: number): number {
    let lo = 0;
    let hi = this.nav.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.nav[mid] < index) lo = mid + 1;
      else hi = mid;
    }
    return lo < this.nav.length ? lo : -1;
  }

  private sentenceAt(pos: number): Sentence | null {
    const i = this.nav[pos];
    return i === undefined ? null : this.model!.sentences[i];
  }

  /* ------------------------------------------------------------ finding */

  private insets() {
    const ob = this.bar.obstruction();
    return { top: Math.max(ob.top, fixedTopInset(this.bar.element)), bottom: ob.bottom };
  }

  /**
   * The first sentence on screen. Text in the page's article (or main region) wins over
   * whatever sits around it, such as a site header or an ad label.
   */
  private firstVisible(): number {
    const model = this.ensureModel();
    const insets = this.insets();
    const h = window.innerHeight;
    let lastRun = null as Sentence['run'] | null;
    let runVisible = false;
    const best: number[] = [-1, -1, -1];
    for (let p = 0; p < this.nav.length; p++) {
      const s = model.sentences[this.nav[p]];
      if (best[s.run.region] >= 0) continue;
      if (s.run !== lastRun) {
        lastRun = s.run;
        const r = s.run.el.getBoundingClientRect();
        runVisible = r.bottom > insets.top && r.top < h - insets.bottom && r.width > 0;
      }
      if (!runVisible) continue;
      const range = model.range(s);
      if (range && startsInView(range, insets)) {
        best[s.run.region] = p;
        if (s.run.region === 2) break;
      }
    }
    return best[2] >= 0 ? best[2] : best[1] >= 0 ? best[1] : best[0];
  }

  private selectionStart(): { node: Node; offset: number; text: string } | null {
    const sel = document.getSelection() as SelectionWithComposed | null;
    if (!sel || !sel.rangeCount) return null;
    const text = sel.toString().trim();
    const roots = this.model?.shadowRoots ?? [];
    if (sel.getComposedRanges) {
      for (const args of [[{ shadowRoots: roots }], roots]) {
        try {
          const r = sel.getComposedRanges(...(args as unknown[]))[0];
          if (r && !r.collapsed) return { node: r.startContainer, offset: r.startOffset, text };
        } catch {
          /* older signature */
        }
      }
    }
    for (const sr of roots) {
      const s = (sr as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.();
      if (s && s.rangeCount && !s.isCollapsed) {
        const r = s.getRangeAt(0);
        return { node: r.startContainer, offset: r.startOffset, text: s.toString().trim() || text };
      }
    }
    const r = sel.getRangeAt(0);
    if (!r.collapsed) return { node: r.startContainer, offset: r.startOffset, text };
    return text ? { node: r.startContainer, offset: r.startOffset, text } : null;
  }

  private selectionPos(): number {
    const start = this.selectionStart();
    if (!start) return -1;
    const model = this.ensureModel();
    let i = model.indexAt(start.node, start.offset);
    if (i < 0 && start.text) {
      // selection we can't map (e.g. inside a shadow root the browser hides): match its text
      const needle = start.text.replace(/\s+/g, ' ').slice(0, 40);
      i = model.sentences.findIndex((s) => s.run.text.includes(needle) && s.run.text.indexOf(needle) < s.end);
    }
    return i < 0 ? -1 : this.navPosFor(i);
  }

  private pointPos(x: number, y: number): number {
    const model = this.ensureModel();
    let lastRun = null as Sentence['run'] | null;
    let inRun = false;
    for (let p = 0; p < this.nav.length; p++) {
      const s = model.sentences[this.nav[p]];
      if (s.run !== lastRun) {
        lastRun = s.run;
        const r = s.run.el.getBoundingClientRect();
        inRun = x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4;
      }
      if (!inRun) continue;
      const range = model.range(s);
      if (!range) continue;
      for (const r of rangeRects(range)) {
        if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) return p;
      }
    }
    return -1;
  }

  private startPos(start: Start): number {
    let p = -1;
    if (start.kind === 'selection') p = this.selectionPos();
    else if (start.kind === 'point') p = this.pointPos(start.x, start.y);
    if (p < 0) p = this.firstVisible();
    if (p < 0) p = this.nav.length ? 0 : -1;
    return p;
  }

  /* ------------------------------------------------------------ playing */

  private item(s: Sentence): Item {
    return { id: ++this.seq, text: s.speech, en: s.en, lang: s.lang };
  }

  private paint() {
    if (!this.current || !this.model) return;
    highlight(this.model.range(this.current));
  }

  private async show(smooth: boolean) {
    if (!this.current || !this.model || !this.settings.follow || this.followSuspended) return;
    const s = this.current;
    await reveal(() => (this.current === s ? this.model?.range(s) ?? null : null), this.insets(), smooth);
    this.scheduleChips();
  }

  /** Make `pos` current; play it, or just cue it up. */
  private go(pos: number, play: boolean, opts: { reveal?: boolean } = {}) {
    if (!this.model) return;
    const s = this.sentenceAt(pos);
    if (!s) return;
    dlog('go', pos, '/', this.nav.length, play ? 'play' : 'cue', JSON.stringify(s.text.slice(0, 40)), caller());
    this.pos = pos;
    this.current = s;
    this.atEnd = false;
    this.paint();
    if (opts.reveal !== false) void this.show(true);
    const item = this.item(s);
    this.playId = item.id;
    if (play) {
      this.intent = 'playing';
      this.bar.send({ type: 'play', item });
    } else {
      this.intent = 'paused';
      this.bar.send({ type: 'cue', item });
    }
    this.prefetch();
    this.sendStatus();
    this.scheduleChips();
  }

  private prefetch() {
    const items: Item[] = [];
    for (let p = this.pos + 1; p < this.nav.length && items.length < PREFETCH; p++) {
      const s = this.sentenceAt(p);
      if (s?.en) items.push({ id: 0, text: s.speech, en: true, lang: 'en' });
    }
    // the one before, so stepping back is instant too
    const prev = this.sentenceAt(this.pos - 1);
    if (prev?.en) items.push({ id: 0, text: prev.speech, en: true, lang: 'en' });
    this.bar.send({ type: 'prefetch', items });
  }

  private sendStatus() {
    this.bar.send({ type: 'status', canPrev: this.pos > 0, canNext: this.pos < this.nav.length - 1 || !this.atEnd, atEnd: this.atEnd });
  }

  private startAt(start: Start, play: boolean) {
    const p = this.startPos(start);
    if (p < 0) {
      this.bar.send({ type: 'status', canPrev: false, canNext: false, atEnd: true });
      return;
    }
    this.followSuspended = false;
    this.go(p, play);
  }

  toggle() {
    dlog('toggle: intent', this.intent, 'atEnd', this.atEnd, 'current', Boolean(this.current));
    this.failures = 0;
    if (!this.current) {
      this.startAt({ kind: 'visible' }, true);
      return;
    }
    if (this.intent === 'playing') {
      this.intent = 'paused';
      this.bar.send({ type: 'pause' });
    } else {
      this.intent = 'playing';
      this.followSuspended = false;
      if (this.atEnd) this.go(this.pos, true);
      else this.bar.send({ type: 'resume' });
      void this.show(true);
    }
  }

  next() {
    this.ensureModel();
    this.followSuspended = false;
    this.failures = 0;
    if (this.pos < this.nav.length - 1) this.go(this.pos + 1, true);
    else void this.pastEnd(true);
  }

  prev() {
    this.ensureModel();
    this.followSuspended = false;
    this.failures = 0;
    if (this.pos > 0) this.go(this.pos - 1, true);
    else if (this.pos === 0) this.go(0, true);
  }

  adjust(command: 'faster' | 'slower') {
    this.bar.send({ type: 'adjust', command });
  }

  pageClicked() {
    if (this.bar.expanded) this.bar.send({ type: 'collapse' });
  }

  startFrom(start: Start) {
    this.followSuspended = false;
    this.failures = 0;
    const p = this.startPos(start);
    if (p >= 0) this.go(p, true);
  }

  private onEnded(id: number) {
    dlog('ended', id, id === this.playId ? '' : `(stale, playing ${this.playId})`);
    if (id !== this.playId) return;
    if (this.settings.stepMode) {
      this.intent = 'paused';
      this.atEnd = true; // pressing play reads this sentence again
      this.sendStatus();
      return;
    }
    this.ensureModel();
    if (this.pos >= 0 && this.pos < this.nav.length - 1) {
      // follow along unless the reader scrolled away and the next sentence is still out of view
      const next = this.sentenceAt(this.pos + 1)!;
      const range = this.model!.range(next);
      if (this.followSuspended && range && visibility(range, this.insets()) === 'visible') this.followSuspended = false;
      this.go(this.pos + 1, true);
    } else {
      void this.pastEnd(false);
    }
  }

  /**
   * Out of text: ask the page for more (turn the page in a paginated reader, scroll for
   * pages that load as you go), and carry on if new text appears.
   */
  private async pastEnd(userAsked: boolean) {
    if (this.advancing) return;
    this.advancing = true;
    dlog('pastEnd', userAsked ? 'asked' : 'auto');
    try {
      const before = this.current;
      const range = before && this.model ? this.model.range(before) : null;
      if (range && inPager(range)) turnPageForward();
      else window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' });
      const t0 = performance.now();
      while (performance.now() - t0 < END_WAIT && !this.closed) {
        await new Promise((r) => setTimeout(r, 250));
        if (!this.dirty) continue;
        this.ensureModel();
        if (this.current && this.pos >= 0 && this.pos < this.nav.length - 1) {
          this.go(this.pos + 1, this.intent === 'playing' || userAsked);
          return;
        }
        if (!this.current) {
          // the page was replaced (next chapter): start at the top of what's showing
          await new Promise((r) => setTimeout(r, 300));
          const p = this.firstVisible();
          if (p >= 0) {
            this.go(p, this.intent === 'playing' || userAsked);
            return;
          }
        }
      }
      this.intent = 'paused';
      this.atEnd = true;
      this.sendStatus();
    } finally {
      this.advancing = false;
    }
  }

  /* ------------------------------------------------------------ player */

  private onConnected() {
    if (this.current) {
      const item = this.item(this.current);
      this.playId = item.id;
      // iOS won't start sound until the reader taps the player, so there it waits for that tap
      if (this.wantAutoplay && this.platform !== 'touch') {
        this.intent = 'playing';
        this.bar.send({ type: 'play', item });
      } else this.bar.send({ type: 'cue', item });
      this.prefetch();
      this.sendStatus();
    }
    this.wantAutoplay = false;
  }

  private onPlayer(m: ToContent) {
    switch (m.type) {
      case 'command':
        if (m.command === 'toggle') this.toggle();
        else if (m.command === 'next') this.next();
        else if (m.command === 'prev') this.prev();
        else if (m.command === 'close') this.close();
        break;
      case 'playing':
        if (m.id === this.playId) {
          this.intent = 'playing';
          this.failures = 0;
        }
        break;
      case 'paused':
      case 'blocked':
        dlog('player', m.type, m.id);
        if (m.id === this.playId) this.intent = 'paused';
        break;
      case 'ended':
        this.onEnded(m.id);
        break;
      case 'failed':
        dlog('player failed', m.id, m.message);
        if (m.id !== this.playId) break;
        // one sentence the voice can't say is skipped; more than that and something is
        // wrong with the voice, so stop here rather than race through the book in silence
        if (this.intent === 'playing' && ++this.failures < 2 && !this.settings.stepMode) this.onEnded(m.id);
        else {
          this.intent = 'paused';
          this.sendStatus();
        }
        break;
      case 'settings':
        this.applySettings(m.settings);
        break;
      case 'size':
        if (!m.expanded) this.scheduleChips();
        break;
    }
  }

  private applySettings(s: Settings) {
    const englishChanged = s.englishOnly !== this.settings.englishOnly;
    this.settings = s;
    if (englishChanged && this.model) {
      this.rebuildNav();
      if (this.current) {
        const i = this.model.sentences.indexOf(this.current);
        const p = i >= 0 ? this.navPosFor(i) : -1;
        if (p >= 0 && this.nav[p] === i) {
          this.pos = p;
          this.prefetch();
        } else if (p >= 0) {
          // the current sentence is no longer read: move to the next one that is
          this.go(p, this.intent === 'playing');
        }
      }
      this.sendStatus();
    }
  }

  /* -------------------------------------------------------------- chips */

  private scheduleChips() {
    clearTimeout(this.chipTimer);
    this.chipTimer = window.setTimeout(() => this.updateChips(), 120);
  }

  private updateChips() {
    if (this.closed) return;
    const chips: Chip[] = [];
    if (this.bar.expanded) {
      // the open card covers the page; chips would only get in its way
      this.bar.setChips(chips);
      return;
    }
    const sel = this.selectionStart();
    if (sel && sel.text) {
      const p = this.selectionPos();
      if (p >= 0 && p !== this.pos) chips.push({ id: 'selection', label: 'Read from selection', icon: 'play' });
    }
    if (!chips.length && this.current && this.model) {
      const range = this.model.range(this.current);
      const vis = range ? visibility(range, this.insets()) : 'unknown';
      if (vis !== 'visible' && vis !== 'unknown') {
        chips.push({ id: 'back', label: 'Back to sentence', icon: 'back' });
        chips.push({ id: 'here', label: 'Read from here', icon: 'play' });
      }
    }
    this.bar.setChips(chips);
  }

  private onChip(id: string) {
    if (id === 'selection') {
      this.startFrom({ kind: 'selection' });
      document.getSelection()?.removeAllRanges();
    } else if (id === 'here') {
      this.startFrom({ kind: 'visible' });
    } else if (id === 'back') {
      this.followSuspended = false;
      void this.show(true);
    }
    this.scheduleChips();
  }

  /* ----------------------------------------------------------- listeners */

  private onUserScrollIntent = (e: Event) => {
    if (e instanceof KeyboardEvent) {
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      if (!['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', ' ', 'Home', 'End'].includes(e.key)) return;
      if (!e.isTrusted) return; // our own page turns
    }
    if (this.intent === 'playing') this.followSuspended = true;
    this.scheduleChips();
  };

  private onScroll = () => {
    if (isOwnScroll()) return;
    this.scheduleChips();
  };

  private onSelection = () => this.scheduleChips();

  private onHidden = () => {
    // a page left in the background keeps reading; nothing to do but keep the theme fresh
    if (!document.hidden) this.checkTheme();
  };

  private checkTheme() {
    const t = pageTheme(this.bar.element);
    if (t !== this.theme) {
      this.theme = t;
      setHighlightTheme(t);
      this.bar.setTheme(t);
      this.bar.send({ type: 'theme', theme: t });
    }
  }

  private listen() {
    window.addEventListener('wheel', this.onUserScrollIntent, { passive: true, capture: true });
    window.addEventListener('touchmove', this.onUserScrollIntent, { passive: true, capture: true });
    window.addEventListener('keydown', this.onUserScrollIntent, { capture: true });
    window.addEventListener('scroll', this.onScroll, { passive: true, capture: true });
    document.addEventListener('selectionchange', this.onSelection);
    document.addEventListener('visibilitychange', this.onHidden);
    this.themeTimer = window.setInterval(() => this.checkTheme(), 2500);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener('wheel', this.onUserScrollIntent, { capture: true });
    window.removeEventListener('touchmove', this.onUserScrollIntent, { capture: true });
    window.removeEventListener('keydown', this.onUserScrollIntent, { capture: true });
    window.removeEventListener('scroll', this.onScroll, { capture: true });
    document.removeEventListener('selectionchange', this.onSelection);
    document.removeEventListener('visibilitychange', this.onHidden);
    clearInterval(this.themeTimer);
    clearTimeout(this.chipTimer);
    for (const mo of this.observers) mo.disconnect();
    clearHighlight();
    this.bar.destroy();
    this.onClosed();
  }
}
