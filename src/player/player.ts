/**
 * The player frame: the bar's controls, the settings card, and the audio. It plays what
 * the content script asks for and reports back; the content script decides what's next.
 */
import { encodeWav } from 'phonon-tts';
import { DEBUG, dlog, postLog } from '../shared/debug';
import { Engine, type Clip, type VoiceInfo } from './engine';
import { icons } from './icons';
import { systemVoice } from './system-voice';
import { CONNECT, type Command, type Item, type Platform, type Theme, type ToContent, type ToPlayer } from '../shared/protocol';
import { DEFAULTS, MAX_RATE, MIN_RATE, loadSettings, onSettingsChange, saveSettings, type Settings } from '../shared/settings';

window.addEventListener('error', (e) => dlog('player error', e.message, e.filename, e.lineno));
window.addEventListener('unhandledrejection', (e) => dlog('player rejection', String((e.reason as Error)?.message ?? e.reason)));
dlog('player: script start', location.href.slice(0, 60));

const params = new URLSearchParams(location.hash.slice(1));
const token = params.get('token') ?? '';
const platform: Platform = params.get('platform') === 'touch' ? 'touch' : 'desktop';
const body = document.body;
body.classList.add(platform);
if (matchMedia('(prefers-color-scheme: dark)').matches) body.classList.add('dark');

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const audio = $<HTMLAudioElement>('audio');
const controls = $('controls');
const panel = $('panel');
const playBtn = $<HTMLButtonElement>('play');
const prevBtn = $<HTMLButtonElement>('prev');
const nextBtn = $<HTMLButtonElement>('next');
const moreBtn = $<HTMLButtonElement>('more');
const closeBtn = $<HTMLButtonElement>('close');
const stepBtn = $<HTMLButtonElement>('step');
const glyph = playBtn.querySelector('.glyph') as HTMLElement;

const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const MOD = '⌥';

prevBtn.innerHTML = icons.prev;
nextBtn.innerHTML = icons.next;
moreBtn.innerHTML = icons.settings;
stepBtn.innerHTML = icons.repeatOne;
closeBtn.innerHTML = icons.close;
glyph.innerHTML = icons.play;
if (platform === 'desktop') {
  prevBtn.title = `Previous sentence  ${MOD}↑`;
  nextBtn.title = `Next sentence  ${MOD}↓`;
  moreBtn.title = 'Settings';
  closeBtn.title = 'Close';
  stepBtn.title = 'Pause after each sentence';
}

const engine = new Engine(new URL('model/', location.href).href);

let port: MessagePort | null = null;
let settings: Settings = { ...DEFAULTS };
let current: Item | null = null;
let currentClip: Clip | null = null;
let upcoming: string[] = [];
let mode: 'idle' | 'loading' | 'playing' | 'paused' = 'idle';
let wantPlay = false;
let usingSystem = false;
let previewing = false;
let unlocked = false;
let status = { canPrev: false, canNext: false, atEnd: false };
let open = false;
let maxWidth = 440;
let maxHeight = 640;
let pageTitle = '';
let endTimer = 0;
let saveTimer = 0;
let progressRaf = 0;
let silentUrl = '';
let artworkUrl = '';

// media session artwork must be http(s), data or blob; extension URLs are refused
fetch('icons/icon-256.png')
  .then((r) => r.blob())
  .then((b) => (artworkUrl = URL.createObjectURL(b)))
  .catch(() => {});

function send(m: ToContent) {
  port?.postMessage(m);
}

/* --------------------------------------------------------------- render */

function setTheme(t: Theme) {
  body.classList.toggle('dark', t === 'dark');
}

function formatRate(r: number) {
  return `${+r.toFixed(2)}×`;
}

function render() {
  const showPause = wantPlay && (mode === 'playing' || mode === 'loading');
  glyph.innerHTML = showPause ? icons.pause : icons.play;
  const label = showPause ? 'Pause' : status.atEnd ? 'Play again' : 'Play';
  playBtn.setAttribute('aria-label', label);
  if (platform === 'desktop') playBtn.title = `${label}  ${MOD}K`;
  playBtn.classList.toggle('loading', wantPlay && mode === 'loading');
  prevBtn.disabled = !status.canPrev && !current;
  nextBtn.disabled = !status.canNext;
  stepBtn.setAttribute('aria-pressed', String(settings.stepMode));
  if (wantPlay && mode === 'playing' && !usingSystem) startProgress();
}

function setMode(m: typeof mode) {
  mode = m;
  render();
}

function setProgress(p: number) {
  playBtn.style.setProperty('--p', String(Math.max(0, Math.min(1, p))));
  playBtn.classList.toggle('has-progress', p > 0.001);
}

function startProgress() {
  if (progressRaf) return;
  const tick = () => {
    progressRaf = 0;
    if (audio.duration && !usingSystem && !previewing) setProgress(audio.currentTime / audio.duration);
    if (mode === 'playing') progressRaf = requestAnimationFrame(tick);
  };
  progressRaf = requestAnimationFrame(tick);
}

function nudge(on: boolean) {
  playBtn.classList.toggle('nudge', on);
}

/* ------------------------------------------------------------ playback */

function applyRate() {
  audio.defaultPlaybackRate = settings.rate;
  audio.playbackRate = settings.rate;
  (audio as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
  audio.preservesPitch = true;
}

function wanted() {
  if (engine.status === 'failed') return;
  const list: string[] = [];
  if (current?.en) list.push(current.text);
  list.push(...upcoming);
  engine.want(list, settings.voice);
}

function stopOutput() {
  clearTimeout(endTimer);
  previewing = false;
  if (!audio.paused) audio.pause();
  if (usingSystem) systemVoice.stop();
  usingSystem = false;
}

/** iOS starts audio only from a tap; playing something silent during one unlocks the element. */
function unlock() {
  // only when the system voice may be needed: speaking at all, even silently, starts iOS's
  // speech audio, which may duck the first sentence playing alongside it
  if (!settings.englishOnly || engine.status === 'failed') systemVoice.unlock();
  if (unlocked) return;
  if (!silentUrl) silentUrl = URL.createObjectURL(encodeWav(new Float32Array(1200), 24000));
  if (audio.src && !audio.paused) return;
  audio.src = silentUrl;
  currentClip = null;
  audio.play().then(
    () => {
      unlocked = true;
    },
    () => {},
  );
}

function speakSystem(item: Item) {
  dlog('system voice', item.id, item.lang, JSON.stringify(item.text.slice(0, 30)));
  usingSystem = true;
  setProgress(0);
  systemVoice.speak(item.text, item.en ? 'en' : item.lang, settings.rate, {
    onStart: () => {
      if (current !== item) return;
      setMode('playing');
      send({ type: 'playing', id: item.id });
      mediaSession(item);
    },
    onEnd: () => {
      if (current !== item || !usingSystem) return;
      usingSystem = false;
      finished(item);
    },
    onError: (message) => {
      dlog('system voice failed', item.id, message);
      if (current !== item) return;
      usingSystem = false;
      send({ type: 'failed', id: item.id, message });
    },
  });
}

async function playItem(item: Item, attempt = 0) {
  current = item;
  currentClip = null;
  wantPlay = true;
  stopOutput();
  nudge(false);
  setProgress(0);
  if (!item.en || engine.status === 'failed') {
    setMode('loading');
    speakSystem(item);
    return;
  }
  let clip = engine.ready(item.text, settings.voice);
  dlog('playItem', item.id, clip ? 'ready' : `waiting (engine ${engine.status})`, JSON.stringify(item.text.slice(0, 40)));
  if (!clip) {
    setMode('loading');
    wanted();
    try {
      clip = await engine.clip(item.text, settings.voice);
    } catch (e) {
      if (current !== item || !wantPlay) return;
      if ((engine.status as string) === 'failed') {
        if (!usingSystem) speakSystem(item);
        return;
      }
      if ((e as Error)?.name === 'AbortError' && attempt < 2) {
        // the job was dropped (the voice changed meanwhile, say) but we still want it
        void playItem(item, attempt + 1);
        return;
      }
      wantPlay = false;
      setMode('paused');
      send({ type: 'failed', id: item.id, message: String((e as Error)?.message ?? e) });
      return;
    }
  }
  if (current !== item || !wantPlay) return;
  await startClip(item, clip);
}

async function startClip(item: Item, clip: Clip) {
  dlog('startClip', item.id, clip.duration.toFixed(2));
  currentClip = clip;
  engine.pin(clip.url);
  if (audio.src !== clip.url) audio.src = clip.url;
  else audio.currentTime = 0;
  applyRate();
  try {
    await audio.play();
    unlocked = true;
    if (current !== item) return;
    setMode('playing');
    send({ type: 'playing', id: item.id });
    mediaSession(item);
  } catch (e) {
    if (current !== item) return;
    const name = (e as Error)?.name;
    dlog('play() failed', name, String((e as Error)?.message));
    if (name === 'NotAllowedError') {
      wantPlay = false;
      setMode('paused');
      nudge(true);
      send({ type: 'blocked', id: item.id });
    } else if (name === 'AbortError') {
      // interrupted before it started; don't leave the spinner turning
      if (wantPlay && mode === 'loading') {
        wantPlay = false;
        setMode('paused');
        send({ type: 'paused', id: item.id });
      }
    } else {
      wantPlay = false;
      setMode('paused');
      send({ type: 'failed', id: item.id, message: String((e as Error)?.message ?? e) });
    }
  }
}

function cue(item: Item) {
  current = item;
  currentClip = null;
  wantPlay = false;
  stopOutput();
  setProgress(0);
  setMode('paused');
  // iOS starts sound only from a tap in the player: until there's been one, ask for it
  if (platform === 'touch' && !unlocked) nudge(true);
  wanted();
}

function pause() {
  wantPlay = false;
  clearTimeout(endTimer);
  if (usingSystem) {
    // speech can't be paused reliably everywhere; resuming reads the sentence again
    systemVoice.stop();
    usingSystem = false;
  }
  if (!audio.paused) audio.pause();
  setMode('paused');
  if (current) send({ type: 'paused', id: current.id });
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
}

function resume() {
  if (!current) return;
  if (wantPlay && mode === 'playing') return;
  wantPlay = true;
  nudge(false);
  if (currentClip && audio.src === currentClip.url && !audio.ended && audio.currentTime > 0 && !previewing) {
    applyRate();
    const item = current;
    audio.play().then(
      () => {
        if (current !== item) return;
        setMode('playing');
        send({ type: 'playing', id: item.id });
        mediaSession(item);
      },
      (e) => {
        if (current !== item) return;
        if ((e as Error)?.name === 'NotAllowedError') {
          wantPlay = false;
          setMode('paused');
          nudge(true);
          send({ type: 'blocked', id: item.id });
        }
      },
    );
    render();
    return;
  }
  void playItem(current);
}

function finished(item: Item) {
  setProgress(1);
  send({ type: 'ended', id: item.id });
  // the next sentence normally arrives at once; if nothing does, show that we've stopped
  clearTimeout(endTimer);
  endTimer = window.setTimeout(() => {
    if (current === item) {
      wantPlay = false;
      setMode('paused');
    }
  }, 450);
}

audio.addEventListener('ended', () => {
  if (previewing) {
    previewing = false;
    currentClip = null;
    setMode(wantPlay ? 'playing' : 'paused');
    return;
  }
  if (current && currentClip && audio.src === currentClip.url) finished(current);
});

for (const ev of ['error', 'stalled', 'waiting', 'emptied'] as const) {
  audio.addEventListener(ev, () => dlog('audio', ev, audio.error?.message ?? '', audio.src.slice(0, 40)));
}

audio.addEventListener('pause', () => {
  // paused by the system (another app took audio, headphones unplugged)
  if (wantPlay && !audio.ended && mode === 'playing' && !usingSystem && current && !previewing) {
    wantPlay = false;
    setMode('paused');
    send({ type: 'paused', id: current.id });
  }
});

/* --------------------------------------------------------- media keys */

function mediaSession(item: Item) {
  if (!('mediaSession' in navigator)) return;
  const title = item.text.length > 96 ? `${item.text.slice(0, 94)}…` : item.text;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist: pageTitle || 'Lector',
      album: 'Lector',
      artwork: artworkUrl ? [{ src: artworkUrl, sizes: '256x256', type: 'image/png' }] : [],
    });
    navigator.mediaSession.playbackState = 'playing';
  } catch {
    /* metadata unsupported */
  }
}

if ('mediaSession' in navigator) {
  const set = (action: MediaSessionAction, fn: () => void) => {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch {
      /* action unsupported */
    }
  };
  set('play', () => {
    if (!wantPlay) send({ type: 'command', command: 'toggle' });
  });
  set('pause', () => {
    if (wantPlay) send({ type: 'command', command: 'toggle' });
  });
  set('previoustrack', () => send({ type: 'command', command: 'prev' }));
  set('nexttrack', () => send({ type: 'command', command: 'next' }));
}

/* ------------------------------------------------------------ commands */

let suppressClick = false;

function command(c: Command) {
  dlog('tap', c, 'mode', mode, 'wantPlay', wantPlay);
  if (c === 'faster' || c === 'slower') {
    setRate(settings.rate + (c === 'faster' ? 0.1 : -0.1));
    return;
  }
  if (c !== 'close') engine.retry();
  unlock();
  send({ type: 'command', command: c });
}

playBtn.addEventListener('click', () => {
  nudge(false);
  dlog('tap play: mode', mode, 'wantPlay', wantPlay, 'clip', Boolean(currentClip), 'atEnd', status.atEnd);
  // resume inside the tap itself, which iOS insists on for audio that was refused before
  if (!wantPlay && current && currentClip && audio.src === currentClip.url && !usingSystem && !previewing && !status.atEnd) {
    wantPlay = true;
    const item = current;
    applyRate();
    audio.play().then(
      () => {
        unlocked = true;
        if (current !== item) return;
        setMode('playing');
        send({ type: 'playing', id: item.id });
        mediaSession(item);
      },
      () => {},
    );
    render();
    send({ type: 'command', command: 'toggle' });
    return;
  }
  command('toggle');
});
prevBtn.addEventListener('click', () => command('prev'));
nextBtn.addEventListener('click', () => command('next'));
closeBtn.addEventListener('click', () => send({ type: 'command', command: 'close' }));
$('turn-off').addEventListener('click', () => send({ type: 'command', command: 'close' }));
moreBtn.addEventListener('click', () => openPanel(!open));
stepBtn.addEventListener('click', () => {
  settings.stepMode = !settings.stepMode;
  render();
  void saveSettings(settings);
  send({ type: 'settings', settings: { ...settings } });
});

document.addEventListener(
  'click',
  (e) => {
    if (suppressClick) {
      e.stopPropagation();
      e.preventDefault();
      suppressClick = false;
    }
  },
  true,
);

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey) return;
  const t = e.target as HTMLElement;
  const onRange = t instanceof HTMLInputElement && t.type === 'range';
  const onButton = t instanceof HTMLButtonElement || t instanceof HTMLInputElement;
  let c: Command | null = null;
  switch (e.code) {
    case 'KeyK':
      c = 'toggle';
      break;
    case 'Space':
      if (!onButton) c = 'toggle';
      break;
    case 'KeyJ':
      c = 'prev';
      break;
    case 'KeyL':
      c = 'next';
      break;
    case 'ArrowUp':
      if (!onRange) c = 'prev';
      break;
    case 'ArrowDown':
      if (!onRange) c = 'next';
      break;
    case 'ArrowLeft':
      if (e.altKey) c = 'slower';
      break;
    case 'ArrowRight':
      if (e.altKey) c = 'faster';
      break;
    case 'Escape':
      if (open) {
        openPanel(false);
        e.preventDefault();
      }
      return;
  }
  if (!c) return;
  e.preventDefault();
  if (c === 'toggle') playBtn.click();
  else command(c);
});

/* ---------------------------------------------------------------- drag */

let drag: { x: number; y: number; id: number; active: boolean; sheet: boolean } | null = null;

controls.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  drag = { x: e.screenX, y: e.screenY, id: e.pointerId, active: false, sheet: false };
});

window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.screenX - drag.x;
  const dy = e.screenY - drag.y;
  if (!drag.active) {
    if (Math.hypot(dx, dy) < 7) return;
    if (platform === 'touch' && Math.abs(dy) < Math.abs(dx)) {
      drag = null;
      return;
    }
    drag.active = true;
    try {
      controls.setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable */
    }
    // with the panel open on touch, the bar pulls the sheet down instead of moving the card
    if (platform === 'touch' && open) {
      drag.sheet = true;
      sheetStart(drag.y);
    } else {
      body.classList.add('dragging');
      send({ type: 'drag', phase: 'start', dx: 0, dy: 0 });
    }
  }
  if (drag.sheet) sheetMove(e.screenY);
  else send({ type: 'drag', phase: 'move', dx, dy });
});

const endDrag = (e: PointerEvent) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (drag.active) {
    if (drag.sheet) sheetEnd(e.type === 'pointercancel');
    else {
      send({ type: 'drag', phase: 'end', dx: e.screenX - drag.x, dy: e.screenY - drag.y });
      body.classList.remove('dragging');
    }
    swallowClick();
  }
  drag = null;
};

function swallowClick() {
  suppressClick = true;
  setTimeout(() => (suppressClick = false), 50);
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

/* --------------------------------------------------------------- panel */

let collapseTimer = 0;

function barSize() {
  if (platform === 'touch') return { width: Math.min(maxWidth, 440), height: 64 };
  return { width: Math.ceil(controls.scrollWidth), height: 52 };
}

function cardSize() {
  const bar = barSize();
  if (!open) return { width: bar.width, height: bar.height, radius: bar.height / 2, expanded: false };
  const width = platform === 'touch' ? bar.width : Math.max(bar.width, 340);
  document.documentElement.style.setProperty('--card-w', `${width}px`);
  const content = panel.querySelector('.pane') as HTMLElement;
  const cs = getComputedStyle(panel);
  const natural = content.offsetHeight + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + 1;
  const height = Math.min(maxHeight, natural + bar.height);
  return { width, height, radius: platform === 'touch' ? 26 : 20, expanded: true };
}

function reportSize() {
  send({ type: 'size', ...cardSize() });
}

/* --------------------------------------------------------------- sheet */

/*
 * On touch the open panel is a sheet: pull it down to put it away. The card's top edge
 * follows the finger (the page resizes the frame with no animation while `live`), and on
 * release it either folds into the bar or springs back. A pull starts on the bar, on the
 * grabber, or anywhere in the panel once its content is scrolled to the top.
 */
type Sample = { y: number; t: number };
let sheet: { from: number; size: ReturnType<typeof cardSize>; dy: number; samples: Sample[] } | null = null;

function sheetStart(y: number) {
  sheet = { from: y, size: cardSize(), dy: 0, samples: [{ y, t: performance.now() }] };
}

function sheetMove(y: number) {
  if (!sheet) return;
  const now = performance.now();
  sheet.samples.push({ y, t: now });
  while (sheet.samples.length > 2 && now - sheet.samples[0].t > 100) sheet.samples.shift();
  sheet.dy = Math.max(0, y - sheet.from);
  const floor = barSize().height;
  send({ type: 'size', ...sheet.size, height: Math.max(floor, sheet.size.height - sheet.dy), live: true });
}

function sheetEnd(cancelled = false) {
  if (!sheet) return;
  const { dy, size, samples } = sheet;
  sheet = null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  // px/ms over the last ~100ms; a finger that stopped before lifting has no speed
  const speed = last.t > first.t && performance.now() - last.t < 80 ? (last.y - first.y) / (last.t - first.t) : 0;
  const travel = size.height - barSize().height;
  // capped, since from the bar there's little room left below the finger
  const close = !cancelled && (dy > Math.min(travel * 0.35, 96) || (speed > 0.4 && dy > 12));
  dlog('sheet: pulled', Math.round(dy), 'of', Math.round(travel), 'speed', speed.toFixed(2), close ? 'close' : 'back');
  if (close) openPanel(false);
  else reportSize();
}

const card = $('card');
let pull: { id: number; x: number; y: number; atTop: boolean; pulling: boolean } | null = null;

/** Whether `el` sits in content that's scrolled down, where a downward swipe should scroll. */
function scrolledDown(el: Element | null) {
  for (; el && el !== card; el = el.parentElement) if (el.scrollTop > 0) return true;
  return false;
}

const touchOf = (e: TouchEvent, id: number) => Array.from(e.changedTouches).find((t) => t.identifier === id);

card.addEventListener(
  'touchstart',
  (e) => {
    pull = null;
    if (platform !== 'touch' || !open || sheet || e.touches.length !== 1) return;
    const target = e.target as Element;
    // the bar has its own drag; sliders need sideways moves to themselves
    if (controls.contains(target) || target.closest('input[type="range"]')) return;
    const t = e.touches[0];
    pull = { id: t.identifier, x: t.screenX, y: t.screenY, atTop: !scrolledDown(target), pulling: false };
  },
  { passive: true },
);

card.addEventListener(
  'touchmove',
  (e) => {
    if (!pull) return;
    const t = touchOf(e, pull.id);
    if (!t) return;
    if (!pull.pulling) {
      const dx = t.screenX - pull.x;
      const dy = t.screenY - pull.y;
      if (!dx && !dy) return;
      // decide on the first move, before iOS commits to scrolling; going up scrolls as usual
      if (!pull.atTop || dy <= 0 || Math.abs(dy) < Math.abs(dx)) {
        pull = null;
        return;
      }
      pull.pulling = true;
      sheetStart(pull.y);
    }
    e.preventDefault();
    sheetMove(t.screenY);
  },
  { passive: false },
);

const endPull = (e: TouchEvent) => {
  if (!pull || !touchOf(e, pull.id)) return;
  const pulling = pull.pulling;
  pull = null;
  if (!pulling) return;
  sheetEnd(e.type === 'touchcancel');
  swallowClick();
};
card.addEventListener('touchend', endPull);
card.addEventListener('touchcancel', endPull);

// On a Mac, clicking the settings button moves the focus into this frame, so a click anywhere
// else takes it away again, in any frame of the page; the page only sees clicks in its own frame.
if (platform === 'desktop') {
  window.addEventListener('blur', () => {
    if (open) openPanel(false);
  });
}

function openPanel(on: boolean) {
  clearTimeout(collapseTimer);
  open = on;
  sheet = null;
  body.classList.toggle('sheet', on);
  moreBtn.setAttribute('aria-expanded', String(on));
  if (on) {
    panel.hidden = false;
    panel.scrollTop = 0;
    // bring the chosen voice into the list's view without scrolling the card itself
    const list = $('voices');
    const sel = list.querySelector('[aria-checked="true"]') as HTMLElement | null;
    if (sel && (sel.offsetTop < list.scrollTop || sel.offsetTop + sel.offsetHeight > list.scrollTop + list.clientHeight)) {
      list.scrollTop = sel.offsetTop - list.clientHeight / 2 + sel.offsetHeight / 2;
    }
    reportSize();
  } else {
    reportSize();
    // keep the panel until the card has folded away
    collapseTimer = window.setTimeout(() => {
      panel.hidden = true;
    }, 320);
  }
}

/* --------------------------------------------------------------- speed */

function setRate(r: number) {
  settings.rate = Math.round(Math.max(MIN_RATE, Math.min(MAX_RATE, r)) * 100) / 100;
  applyRate();
  renderSpeed();
  render();
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveSettings(settings), 250);
}

const presets = $('presets');
for (const r of SPEED_PRESETS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'preset';
  b.setAttribute('role', 'radio');
  b.dataset.rate = String(r);
  b.textContent = formatRate(r);
  b.addEventListener('click', () => setRate(r));
  presets.append(b);
}

const sliders = [$<HTMLInputElement>('speed-slider')];
for (const s of sliders) s.addEventListener('input', () => setRate(parseFloat(s.value)));

// the same 0.1× steps as ⌥← and ⌥→
const slowerBtn = $<HTMLButtonElement>('slower');
const fasterBtn = $<HTMLButtonElement>('faster');
slowerBtn.innerHTML = icons.minus;
fasterBtn.innerHTML = icons.plus;
slowerBtn.addEventListener('click', () => setRate(settings.rate - 0.1));
fasterBtn.addEventListener('click', () => setRate(settings.rate + 0.1));

function renderSpeed() {
  const r = settings.rate;
  for (const b of presets.children) (b as HTMLElement).setAttribute('aria-checked', String(Math.abs(parseFloat((b as HTMLElement).dataset.rate!) - r) < 0.001));
  for (const s of sliders) {
    s.value = String(r);
    s.style.setProperty('--fill', `${((r - MIN_RATE) / (MAX_RATE - MIN_RATE)) * 100}%`);
  }
  $('speed-value').textContent = formatRate(r);
  slowerBtn.disabled = r <= MIN_RATE;
  fasterBtn.disabled = r >= MAX_RATE;
}

/* -------------------------------------------------------------- voices */

function voiceName(id: string) {
  if (id === 'default') return 'Default';
  return engine.voices.find((v) => v.id === id)?.name ?? 'Default';
}

function renderVoices() {
  const list = $('voices');
  list.replaceChildren();
  const row = (id: string, name: string, meta: string, title: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'voice';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(settings.voice === id));
    b.dataset.voice = id;
    if (title && platform === 'desktop') b.title = title;
    b.innerHTML = `<span class="check">${icons.check}</span><span class="name"></span><span class="meta"></span>`;
    (b.querySelector('.name') as HTMLElement).textContent = name;
    (b.querySelector('.meta') as HTMLElement).textContent = meta;
    b.addEventListener('click', () => chooseVoice(id));
    return b;
  };
  const group = (title: string) => {
    const g = document.createElement('div');
    g.className = 'vgroup';
    g.textContent = title;
    return g;
  };
  list.append(row('default', 'Default', 'Phonon', 'The model’s own voice'));
  const describe = (v: VoiceInfo) => [v.gender ? v.gender[0].toUpperCase() + v.gender.slice(1) : '', v.age ?? ''].filter(Boolean).join(' · ');
  for (const [accent, title] of [
    ['US', 'American'],
    ['UK', 'British'],
  ] as const) {
    const voices = engine.voices.filter((v) => v.accent === accent);
    if (!voices.length) continue;
    list.append(group(title));
    for (const v of voices) list.append(row(v.id, v.name, describe(v), v.description));
  }
  renderVoiceNote();
}

function renderVoiceNote() {
  const note = $('voice-note');
  if (engine.status === 'failed') note.textContent = 'System voice';
  else if (engine.status === 'loading') note.textContent = 'Loading…';
  else note.textContent = voiceName(settings.voice);
}

function chooseVoice(id: string) {
  if (engine.status === 'failed') return;
  unlock();
  settings.voice = id;
  void saveSettings(settings);
  for (const b of $('voices').querySelectorAll<HTMLElement>('.voice')) b.setAttribute('aria-checked', String(b.dataset.voice === id));
  renderVoiceNote();
  if (wantPlay && current?.en) {
    void playItem(current);
    return;
  }
  // paused: say a line in the new voice
  stopOutput();
  currentClip = null;
  wanted();
  previewing = true;
  const name = voiceName(id);
  const line = id === 'default' ? 'This is the default voice.' : `Hi, I'm ${name}.`;
  engine.clip(line, id).then(
    (clip) => {
      if (!previewing || settings.voice !== id) return;
      audio.src = clip.url;
      applyRate();
      audio.play().catch(() => {
        previewing = false;
      });
    },
    () => {
      previewing = false;
    },
  );
}

/* ------------------------------------------------------------ settings */

const toggles: Array<[string, keyof Settings]> = [
  ['opt-english', 'englishOnly'],
  ['opt-follow', 'follow'],
];

for (const [id, key] of toggles) {
  const input = $<HTMLInputElement>(id);
  input.addEventListener('change', () => {
    dlog('toggle change', id, input.checked);
    (settings[key] as boolean) = input.checked;
    // other languages go to the system voice, which iOS starts only after a tap like this one
    if (key === 'englishOnly' && !input.checked) systemVoice.unlock();
    void saveSettings(settings);
    send({ type: 'settings', settings: { ...settings } });
  });
}

function renderSettings() {
  for (const [id, key] of toggles) $<HTMLInputElement>(id).checked = Boolean(settings[key]);
  renderSpeed();
  renderVoices();
  render();
}

onSettingsChange((s) => {
  dlog('settings changed in storage', JSON.stringify({ en: s.englishOnly, step: s.stepMode, follow: s.follow, rate: s.rate }));
  const voiceChanged = s.voice !== settings.voice;
  settings = s;
  applyRate();
  for (const [id, key] of toggles) $<HTMLInputElement>(id).checked = Boolean(settings[key]);
  renderSpeed();
  if (voiceChanged) {
    for (const b of $('voices').querySelectorAll<HTMLElement>('.voice')) b.setAttribute('aria-checked', String(b.dataset.voice === s.voice));
    renderVoiceNote();
    wanted();
  }
  render();
});

/* ------------------------------------------------------------ messages */

function onMessage(m: ToPlayer) {
  switch (m.type) {
    case 'hello':
      setTheme(m.theme);
      maxWidth = m.maxWidth;
      maxHeight = m.maxHeight;
      pageTitle = m.title;
      reportSize();
      break;
    case 'theme':
      setTheme(m.theme);
      break;
    case 'layout':
      maxWidth = m.maxWidth;
      maxHeight = m.maxHeight;
      reportSize();
      break;
    case 'play':
      clearTimeout(endTimer);
      void playItem(m.item);
      break;
    case 'cue':
      clearTimeout(endTimer);
      cue(m.item);
      break;
    case 'pause':
      pause();
      break;
    case 'resume':
      resume();
      break;
    case 'prefetch':
      upcoming = m.items.map((i) => i.text);
      wanted();
      break;
    case 'status':
      status = { canPrev: m.canPrev, canNext: m.canNext, atEnd: m.atEnd };
      if (m.atEnd && !wantPlay) setMode('paused');
      render();
      break;
    case 'collapse':
      if (open) openPanel(false);
      break;
    case 'adjust':
      setRate(settings.rate + (m.command === 'faster' ? 0.1 : -0.1));
      break;
    case 'log':
      postLog(m.text);
      break;
    case 'close':
      stopOutput();
      engine.dispose();
      if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
      break;
  }
}

window.addEventListener('message', (e) => {
  if (port || e.source !== window.parent) return;
  const data = e.data as { type?: string; token?: string } | null;
  if (data?.type !== CONNECT || data.token !== token || !e.ports[0]) return;
  port = e.ports[0];
  dlog('player: connected');
  port.onmessage = (ev) => {
    const m = ev.data as ToPlayer;
    if (m.type !== 'prefetch' && m.type !== 'status' && m.type !== 'log') dlog('player <-', m.type);
    onMessage(m);
  };
  send({ type: 'ready' });
  reportSize();
});

/* --------------------------------------------------------------- start */

if (DEBUG) {
  let last = '';
  setInterval(() => {
    const s = `state: mode ${mode} want ${wantPlay} engine ${engine.status} audio ${audio.paused ? 'paused' : 'playing'} ${audio.currentTime.toFixed(1)}/${(audio.duration || 0).toFixed(1)} rs${audio.readyState} item ${current?.id ?? '-'} clip ${currentClip ? 'y' : 'n'} unlocked ${unlocked} vis ${document.visibilityState}`;
    if (s.replace(/ [\d.]+\/[\d.]+/, '') !== last.replace(/ [\d.]+\/[\d.]+/, '')) dlog(s);
    last = s;
  }, 1000);
}

engine.onStatus = () => {
  dlog('engine', engine.status, engine.error);
  renderVoiceNote();
  $('voices').classList.toggle('disabled', engine.status === 'failed');
  // whatever was waiting on the neural voice goes to the system voice now
  if (engine.status === 'failed' && wantPlay && current && mode === 'loading' && !usingSystem) speakSystem(current);
};

(async () => {
  settings = await loadSettings();
  applyRate();
  renderSettings();
  await engine.loadVoices();
  renderVoices();
  engine.load().catch(() => {});
})();
