/**
 * The player bar on the page: an extension-page iframe (so audio and the voice model run
 * in the extension's origin, and taps in it count as gestures for playback), plus the
 * small action chips above it, all inside a closed shadow root.
 */
import { DEBUG, dlog, setLogSink } from '../shared/debug';
import { ext } from '../shared/ext';
import { CONNECT, type Platform, type Theme, type ToContent, type ToPlayer } from '../shared/protocol';

export type Chip = { id: string; label: string; icon: 'play' | 'back' };

const MARGIN = 14;
const DISMISS_DISTANCE = 56;

const ICONS = {
  play: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4.5 2.8v10.4c0 .6.6.9 1.1.6l8.2-5.2a.7.7 0 0 0 0-1.2L5.6 2.2c-.5-.3-1.1 0-1.1.6Z" fill="currentColor"/></svg>',
  back: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6.5 3.5 2.5 7.5l4 4M2.8 7.5h6.7a4 4 0 0 1 0 8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 -1.5)"/></svg>',
};

const CSS = `
:host { all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important;
  pointer-events: none !important; display: block !important; }
iframe { position: absolute; border: 0; margin: 0; padding: 0; display: block; pointer-events: auto;
  color-scheme: light; background: transparent; overflow: hidden;
  box-shadow: 0 10px 40px rgba(0,0,0,.22), 0 2px 8px rgba(0,0,0,.10);
  -webkit-backdrop-filter: blur(22px) saturate(180%); backdrop-filter: blur(22px) saturate(180%);
  transition: width .3s cubic-bezier(.3,.9,.3,1), height .3s cubic-bezier(.3,.9,.3,1), border-radius .3s ease,
    transform .32s cubic-bezier(.3,.9,.3,1), opacity .22s ease, left .3s cubic-bezier(.3,.9,.3,1);
  opacity: 0; transform: translateY(16px) scale(.98); }
iframe.shown { opacity: 1; transform: none; }
iframe.dragging { transition: width .3s, height .3s, border-radius .3s, opacity .2s; }
iframe.live { transition: opacity .22s ease; }
.dark iframe { box-shadow: 0 10px 40px rgba(0,0,0,.5), 0 0 0 .5px rgba(255,255,255,.12); }
.chips { position: absolute; display: flex; gap: 8px; justify-content: center; pointer-events: none;
  transition: opacity .18s ease, transform .22s cubic-bezier(.3,.9,.3,1); }
.chips.hidden { opacity: 0; transform: translateY(6px); }
.chip { pointer-events: auto; display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 14px;
  border: 0; border-radius: 17px; cursor: pointer; white-space: nowrap;
  font: 500 13px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif;
  letter-spacing: -.01em; color: #1d1d1f; background: rgba(250,250,252,.88);
  -webkit-backdrop-filter: blur(18px) saturate(180%); backdrop-filter: blur(18px) saturate(180%);
  box-shadow: 0 6px 20px rgba(0,0,0,.16), 0 0 0 .5px rgba(0,0,0,.08);
  -webkit-tap-highlight-color: transparent; transition: transform .12s ease, background .12s ease; }
.chip:hover { background: rgba(255,255,255,.98); }
.chip:active { transform: scale(.96); }
.chip .ic { display: inline-flex; color: #b07800; }
.dark .chip { color: #f5f5f7; background: rgba(44,44,46,.86); box-shadow: 0 6px 20px rgba(0,0,0,.4), 0 0 0 .5px rgba(255,255,255,.12); }
.dark .chip:hover { background: rgba(58,58,60,.95); }
.dark .chip .ic { color: #ffc23d; }
.touch .chip { height: 40px; border-radius: 20px; padding: 0 16px; font-size: 15px; }
`;

export class Bar {
  private host: HTMLElement;
  private root: ShadowRoot;
  private wrap: HTMLDivElement;
  readonly frame: HTMLIFrameElement;
  private chipsEl: HTMLDivElement;
  private port: MessagePort | null = null;
  private queue: ToPlayer[] = [];
  private connected = false;
  private size = { width: 0, height: 0, radius: 0 };
  /** Offset from the default spot, bottom centre; y grows upwards. */
  private offset = { x: 0, y: 0 };
  private dragFrom = { x: 0, y: 0 };
  private chips: Chip[] = [];
  private closed = false;
  expanded = false;
  private posKey = `pos:${location.host}`;

  constructor(
    private platform: Platform,
    private onMessage: (m: ToContent) => void,
    private onChip: (id: string) => void,
  ) {
    this.host = document.createElement('lector-bar');
    this.root = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.wrap = document.createElement('div');
    this.wrap.className = platform;
    this.frame = document.createElement('iframe');
    this.frame.setAttribute('allow', 'autoplay');
    this.frame.setAttribute('title', 'Lector');
    this.frame.setAttribute('scrolling', 'no');
    this.chipsEl = document.createElement('div');
    this.chipsEl.className = 'chips hidden';
    this.wrap.append(this.chipsEl, this.frame);
    this.root.append(style, this.wrap);
    if (DEBUG) setLogSink((text) => this.send({ type: 'log', text }));
  }

  get element(): HTMLElement {
    return this.host;
  }

  async mount(theme: Theme, onConnected: () => void) {
    this.setTheme(theme);
    try {
      const saved = (await ext.storage.local.get(this.posKey))?.[this.posKey] as { x: number; y: number } | undefined;
      if (saved) this.offset = { x: this.platform === 'touch' ? 0 : saved.x, y: saved.y };
    } catch {
      /* default position */
    }
    const token = crypto.randomUUID();
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (e) => this.handle(e.data as ToContent, onConnected);
    this.frame.addEventListener(
      'load',
      () => {
        dlog('bar: frame loaded');
        this.frame.contentWindow?.postMessage({ type: CONNECT, token }, '*', [channel.port2]);
      },
      { once: true },
    );
    this.frame.addEventListener('error', () => dlog('bar: frame error'));
    const params = new URLSearchParams({ token, platform: this.platform });
    this.frame.src = `${ext.runtime.getURL('player.html')}#${params}`;
    dlog('bar: mount', this.frame.src, this.platform, window.innerWidth, window.innerHeight);
    // a placeholder size until the player reports its own
    this.applySize(this.platform === 'touch' ? { width: Math.min(window.innerWidth - 24, 440), height: 64, radius: 32 } : { width: 318, height: 52, radius: 26 });
    document.documentElement.append(this.host);
    window.addEventListener('resize', this.onResize);
  }

  private handle(m: ToContent, onConnected: () => void) {
    if (m.type === 'ready') {
      dlog('bar: player ready');
      this.connected = true;
      for (const q of this.queue) this.port?.postMessage(q);
      this.queue = [];
      requestAnimationFrame(() => this.frame.classList.add('shown'));
      onConnected();
    } else if (m.type === 'size') {
      this.expanded = m.expanded;
      if (m.expanded) this.setChips([]);
      this.frame.classList.toggle('live', Boolean(m.live));
      this.applySize(m);
    } else if (m.type === 'drag') {
      this.drag(m.phase, m.dx, m.dy);
    }
    this.onMessage(m);
  }

  send(m: ToPlayer) {
    if (this.closed) return;
    if (this.port && this.connected) this.port.postMessage(m);
    else this.queue.push(m);
  }

  setTheme(theme: Theme) {
    this.wrap.classList.toggle('dark', theme === 'dark');
  }

  /** Space the bar takes at the top or bottom of the viewport, for keeping text clear of it. */
  obstruction(): { top: number; bottom: number } {
    const r = this.frame.getBoundingClientRect();
    if (!r.height) return { top: 0, bottom: 0 };
    const h = window.innerHeight;
    if (r.top + r.height / 2 > h / 2) return { top: 0, bottom: Math.max(0, h - r.top) + 10 };
    return { top: Math.max(0, r.bottom) + 10, bottom: 0 };
  }

  setChips(chips: Chip[]) {
    const same = chips.length === this.chips.length && chips.every((c, i) => c.id === this.chips[i].id && c.label === this.chips[i].label);
    if (same) return;
    this.chips = chips;
    if (!chips.length) {
      this.chipsEl.classList.add('hidden');
      return;
    }
    this.chipsEl.replaceChildren(
      ...chips.map((c) => {
        const b = document.createElement('button');
        b.className = 'chip';
        b.type = 'button';
        b.innerHTML = `<span class="ic">${ICONS[c.icon]}</span>`;
        b.append(c.label);
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.onChip(c.id);
        });
        // keep a page selection alive while the chip is pressed
        b.addEventListener('mousedown', (e) => e.preventDefault());
        return b;
      }),
    );
    this.layout();
    requestAnimationFrame(() => this.chipsEl.classList.remove('hidden'));
  }

  private base() {
    const bottom = this.platform === 'touch' ? 10 : MARGIN + 4;
    return { cx: window.innerWidth / 2, bottom };
  }

  private clampOffset() {
    const { cx, bottom } = this.base();
    const half = this.size.width / 2;
    const minX = half + 8 - cx;
    const maxX = window.innerWidth - half - 8 - cx;
    this.offset.x = Math.max(minX, Math.min(maxX, this.offset.x));
    const maxY = window.innerHeight - this.size.height - bottom - 8;
    this.offset.y = Math.min(maxY, Math.max(this.platform === 'touch' ? -DISMISS_DISTANCE * 2 : 0, this.offset.y));
  }

  private layout() {
    const { cx, bottom } = this.base();
    const f = this.frame.style;
    const left = cx + this.offset.x - this.size.width / 2;
    f.left = `${Math.round(left)}px`;
    f.bottom = `calc(env(safe-area-inset-bottom, 0px) + ${Math.round(bottom + this.offset.y)}px)`;
    f.width = `${this.size.width}px`;
    f.height = `${this.size.height}px`;
    f.borderRadius = `${this.size.radius}px`;
    const c = this.chipsEl.style;
    const chipsWidth = Math.min(420, window.innerWidth - 16);
    c.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - chipsWidth - 8, cx + this.offset.x - chipsWidth / 2)))}px`;
    c.width = `${chipsWidth}px`;
    const below = bottom + this.offset.y + this.size.height > window.innerHeight * 0.6;
    if (below) {
      c.bottom = '';
      c.top = `${Math.round(window.innerHeight - (bottom + this.offset.y) + 10)}px`;
    } else {
      c.top = '';
      c.bottom = `calc(env(safe-area-inset-bottom, 0px) + ${Math.round(bottom + this.offset.y + this.size.height + 10)}px)`;
    }
  }

  private applySize(s: { width: number; height: number; radius: number }) {
    this.size = { width: s.width, height: s.height, radius: s.radius };
    this.clampOffset();
    this.layout();
  }

  private drag(phase: 'start' | 'move' | 'end', dx: number, dy: number) {
    if (phase === 'start') {
      this.dragFrom = { ...this.offset };
      this.frame.classList.add('dragging');
      return;
    }
    const x = this.platform === 'touch' ? 0 : this.dragFrom.x + dx;
    const y = this.dragFrom.y - dy;
    if (phase === 'move') {
      this.offset = { x, y };
      this.clampOffset();
      this.layout();
      this.frame.style.opacity = this.offset.y < -8 ? String(Math.max(0.3, 1 + this.offset.y / (DISMISS_DISTANCE * 2))) : '';
      return;
    }
    this.frame.classList.remove('dragging');
    this.frame.style.opacity = '';
    if (this.platform === 'touch' && this.offset.y < -DISMISS_DISTANCE) {
      this.onMessage({ type: 'command', command: 'close' });
      return;
    }
    if (this.offset.y < 0) this.offset.y = 0;
    // snap back near the default spot
    if (Math.abs(this.offset.x) < 24) this.offset.x = 0;
    if (Math.abs(this.offset.y) < 16) this.offset.y = 0;
    this.layout();
    try {
      void ext.storage.local.set({ [this.posKey]: this.offset });
    } catch {
      /* not saved */
    }
  }

  private onResize = () => {
    this.send({ type: 'layout', maxWidth: window.innerWidth - 24, maxHeight: window.innerHeight - 40 });
    this.clampOffset();
    this.layout();
  };

  destroy() {
    if (this.closed) return;
    this.closed = true;
    if (DEBUG) setLogSink(null);
    window.removeEventListener('resize', this.onResize);
    this.frame.classList.remove('shown');
    this.chipsEl.classList.add('hidden');
    this.port?.postMessage({ type: 'close' } satisfies ToPlayer);
    setTimeout(() => {
      this.port?.close();
      this.host.remove();
    }, 260);
  }
}
