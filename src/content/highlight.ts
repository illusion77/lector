/**
 * Marks the sentence being read with the CSS Custom Highlight API, which paints over
 * the page's text without touching its DOM. `::highlight()` rules don't cross shadow
 * boundaries, so the rule is added to each shadow root that holds highlighted text.
 */

const NAME = 'lector-sentence';
const STYLE_ATTR = 'data-lector-highlight';
const COLORS = { light: 'rgba(255, 184, 0, 0.32)', dark: 'rgba(255, 196, 51, 0.36)' };
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

export function isOwnStyle(node: Node): boolean {
  return node instanceof Element && node.hasAttribute(STYLE_ATTR);
}

/** Dark pages get a slightly stronger mark, which otherwise reads muddy. */
export function setHighlightTheme(t: 'light' | 'dark') {
  if (t === theme) return;
  theme = t;
  for (const s of styles) s.textContent = rule(t);
}

export function highlight(range: Range | null) {
  if (!registry || !HighlightClass) return;
  if (!mark) mark = new HighlightClass();
  mark.clear();
  if (!range) return;
  ensureStyle(document);
  const root = range.startContainer.getRootNode();
  if (root instanceof ShadowRoot) ensureStyle(root);
  mark.add(range);
  if (registry.get(NAME) !== mark) registry.set(NAME, mark);
}

export function clearHighlight() {
  mark?.clear();
  registry?.delete(NAME);
  mark = null;
}
