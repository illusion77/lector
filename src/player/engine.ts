/**
 * The neural voice: Phonon 31m running in a worker, with a small scheduler on top so the
 * sentence about to be heard is always generated first and work nobody needs any more is
 * cancelled. Finished sentences are kept as WAV blob URLs for instant replay.
 *
 * The model can break while a page is open: a WebAssembly trap (out of memory, say) leaves
 * every later call failing, and a worker the system stops never answers again. Either way
 * the engine starts a fresh model and tries the sentence once more, and only gives up for
 * good if that keeps happening.
 */
import { PhononTTS, encodeWav } from 'phonon-tts';
import { dlog } from '../shared/debug';

export type Clip = { url: string; duration: number };

export type VoiceInfo = {
  id: string;
  name: string;
  accent: 'US' | 'UK' | '';
  gender: string | null;
  age: string | null;
  description: string;
  file: string;
};

type Job = {
  key: string;
  text: string;
  voice: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  promise: Promise<Clip>;
  resolve: (c: Clip) => void;
  reject: (e: unknown) => void;
  ctrl: AbortController | null;
  clip: Clip | null;
  /** Attempts that failed with a fresh model to retry on. */
  tries: number;
};

const KEEP = 48;
const SAMPLE_RATE = 24000;
/** No audio from the model for this long means its worker has stopped. */
const STALL_MS = 12000;
const LOAD_TIMEOUT_MS = 60000;
/** Fresh models allowed within RESTART_WINDOW_MS before the voice is declared broken. */
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 120000;

const abortError = () => new DOMException('Cancelled', 'AbortError');

/** Trims the model's silent lead-in and its long tail, leaving a natural pause after the sentence. */
export function trimSilence(pcm: Float32Array, sr = SAMPLE_RATE): Float32Array {
  const win = Math.round(sr * 0.01);
  const threshold = 0.008;
  const loud = (i: number) => {
    let sum = 0;
    const end = Math.min(pcm.length, i + win);
    for (let j = i; j < end; j++) sum += pcm[j] * pcm[j];
    return Math.sqrt(sum / win) >= threshold;
  };
  let a = 0;
  while (a + win < pcm.length && !loud(a)) a += win;
  let b = pcm.length - win;
  while (b > a && !loud(b)) b -= win;
  if (b <= a) return pcm;
  const start = Math.max(0, a - Math.round(sr * 0.03));
  const end = Math.min(pcm.length, b + win + Math.round(sr * 0.24));
  const out = pcm.slice(start, end);
  const fade = Math.min(out.length, Math.round(sr * 0.02));
  for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
  return out;
}

function concat(chunks: Float32Array[]): Float32Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export class Engine {
  voices: VoiceInfo[] = [];
  status: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  error = '';
  private tts: Promise<PhononTTS> | null = null;
  private jobs = new Map<string, Job>();
  /** Keys in the order they're wanted. */
  private order: string[] = [];
  private running: Job | null = null;
  private done: string[] = [];
  /** URLs that must survive eviction, such as the one playing. */
  private pinned = new Set<string>();
  /** When fresh models were started after the old one broke. */
  private restarts: number[] = [];
  private disposed = false;
  onStatus: (() => void) | null = null;

  constructor(private base: string) {}

  async loadVoices(): Promise<VoiceInfo[]> {
    try {
      const list = (await (await fetch(`${this.base}voices.json`)).json()) as VoiceInfo[];
      this.voices = list;
    } catch {
      this.voices = [];
    }
    return this.voices;
  }

  load(): Promise<PhononTTS> {
    if (this.tts) return this.tts;
    if (this.disposed) return Promise.reject(new Error('The voice was closed'));
    this.status = 'loading';
    this.onStatus?.();
    const t0 = performance.now();
    const voices: Record<string, string> = { default: `${this.base}default-voice.safetensors` };
    for (const v of this.voices) voices[v.id] = `${this.base}${v.file}`;
    const loading = PhononTTS.load({
      lang: 'en',
      quant: 'q8',
      cache: false,
      device: 'cpu',
      threads: 1,
      model: {
        weights: { q8: `${this.base}model.q8.gguf` },
        tokenizer: `${this.base}tokenizer.json`,
        config: `${this.base}config.json`,
        voices,
        defaultVoice: 'default',
      },
    });
    let timer = 0;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => {
        // whatever arrives this late is no use any more
        loading.then((t) => t.dispose(), () => {});
        reject(new Error('The voice took too long to load'));
      }, LOAD_TIMEOUT_MS);
    });
    const tts: Promise<PhononTTS> = Promise.race([loading, timeout]).then(
      (t) => {
        clearTimeout(timer);
        if (this.tts !== tts) {
          t.dispose();
          throw abortError();
        }
        dlog('engine: loaded in', Math.round(performance.now() - t0), 'ms');
        this.status = 'ready';
        this.onStatus?.();
        return t;
      },
      (e) => {
        clearTimeout(timer);
        if (this.tts !== tts) throw e;
        dlog('engine: load failed', String((e as Error)?.message ?? e));
        this.fail(e);
        throw e;
      },
    );
    this.tts = tts;
    return tts;
  }

  /** The voice can't be used: everything waiting on it fails, and the player falls back. */
  private fail(e: unknown) {
    this.status = 'failed';
    this.error = e instanceof Error ? e.message : String(e);
    const old = this.tts;
    this.tts = null;
    old?.then((t) => t.dispose(), () => {});
    for (const [key, job] of this.jobs) {
      if (job.state === 'done') continue;
      job.ctrl?.abort();
      this.jobs.delete(key);
      job.reject(e);
    }
    this.onStatus?.();
  }

  /** Try the neural voice again after it failed (the reader asked to play). */
  retry() {
    if (this.status !== 'failed' || this.disposed) return;
    dlog('engine: retrying after', this.error);
    this.status = 'idle';
    this.error = '';
    this.restarts = [];
    this.onStatus?.();
  }

  /** Drop the broken model; the next sentence loads a fresh one. Gives up if this keeps happening. */
  private restart(e: unknown) {
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    this.restarts.push(now);
    dlog('engine: model broke:', String((e as Error)?.message ?? e), `(restart ${this.restarts.length})`);
    if (this.restarts.length > MAX_RESTARTS) {
      this.fail(new Error('The voice keeps failing'));
      return;
    }
    const old = this.tts;
    this.tts = null;
    old?.then((t) => t.dispose(), () => {});
    this.status = 'idle';
  }

  private key(text: string, voice: string) {
    return `${voice}\u0000${text}`;
  }

  private job(text: string, voice: string): Job {
    const key = this.key(text, voice);
    let job = this.jobs.get(key);
    if (!job) {
      let resolve!: (c: Clip) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<Clip>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      promise.catch(() => {});
      job = { key, text, voice, state: 'queued', promise, resolve, reject, ctrl: null, clip: null, tries: 0 };
      this.jobs.set(key, job);
    }
    return job;
  }

  /** Sets what's wanted, most urgent first. Anything else in progress is cancelled. */
  want(texts: string[], voice: string) {
    if (this.status === 'failed' || this.disposed) return;
    const keys: string[] = [];
    for (const t of texts) {
      if (!t) continue;
      const job = this.job(t, voice);
      if (!keys.includes(job.key)) keys.push(job.key);
    }
    this.order = keys;
    // forget queued work nobody wants
    for (const [key, job] of this.jobs) {
      if (job.state === 'queued' && !keys.includes(key)) {
        this.jobs.delete(key);
        job.reject(new DOMException('No longer needed', 'AbortError'));
      }
    }
    this.pump();
  }

  /** The clip for a sentence, generated next if it isn't ready. */
  clip(text: string, voice: string): Promise<Clip> {
    if (this.status === 'failed') return Promise.reject(new Error(this.error || 'The voice is unavailable'));
    const job = this.job(text, voice);
    this.order = [job.key, ...this.order.filter((k) => k !== job.key)];
    this.pump();
    return job.promise;
  }

  /** A clip that's already made, without waiting. */
  ready(text: string, voice: string): Clip | null {
    return this.jobs.get(this.key(text, voice))?.clip ?? null;
  }

  pin(url: string | null) {
    this.pinned.clear();
    if (url) this.pinned.add(url);
  }

  private pump() {
    if (this.disposed) return;
    if (this.running) {
      if (!this.order.includes(this.running.key)) this.running.ctrl?.abort();
      return;
    }
    const next = this.order.map((k) => this.jobs.get(k)).find((j) => j && j.state === 'queued');
    if (next) void this.run(next);
  }

  /**
   * One sentence's audio. Settles at once when cancelled (the worker catches up on its
   * own) and fails if the model goes quiet, which is how a stopped worker shows itself.
   */
  private generate(tts: PhononTTS, text: string, voice: string, signal: AbortSignal): Promise<Float32Array> {
    return new Promise((resolve, reject) => {
      const chunks: Float32Array[] = [];
      let timer = 0;
      let settled = false;
      const finish = (err: unknown, pcm?: Float32Array) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(pcm!);
      };
      const arm = () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => finish(new Error('The voice stopped responding')), STALL_MS);
      };
      const onAbort = () => finish(abortError());
      if (signal.aborted) return finish(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      arm();
      const it = tts.stream(text, { voice, signal })[Symbol.asyncIterator]();
      (async () => {
        try {
          for (;;) {
            const r = await it.next();
            if (settled) return;
            if (r.done) break;
            chunks.push(r.value);
            arm();
          }
          finish(null, concat(chunks));
        } catch (e) {
          finish(e);
        }
      })();
    });
  }

  private async run(job: Job) {
    this.running = job;
    job.state = 'running';
    job.ctrl = new AbortController();
    const { signal } = job.ctrl;
    try {
      const tts = await this.load();
      if (signal.aborted) throw abortError();
      const t0 = performance.now();
      const pcm = await this.generate(tts, job.text, job.voice, signal);
      if (signal.aborted) throw abortError();
      const trimmed = trimSilence(pcm, tts.sampleRate);
      if (!trimmed.length) throw new Error('The voice made no sound');
      const ms = performance.now() - t0;
      const sec = trimmed.length / tts.sampleRate;
      dlog('engine: synth', Math.round(ms), 'ms for', sec.toFixed(2), 's audio, rtf', (ms / 1000 / sec).toFixed(2), JSON.stringify(job.text.slice(0, 40)));
      const url = URL.createObjectURL(encodeWav(trimmed, tts.sampleRate));
      job.clip = { url, duration: sec };
      job.state = 'done';
      job.resolve(job.clip);
      this.restarts = [];
      this.remember(job.key);
    } catch (e) {
      if (this.jobs.get(job.key) !== job) {
        // dropped while it ran (the voice failed for good); already settled
      } else if (signal.aborted || (e as Error)?.name === 'AbortError') {
        // still wanted later? then it goes back in line; otherwise it's dropped
        if (this.order.includes(job.key) && !this.disposed) job.state = 'queued';
        else {
          this.jobs.delete(job.key);
          job.reject(e);
        }
      } else if (this.status === 'failed') {
        this.jobs.delete(job.key);
        job.reject(e);
      } else {
        dlog('engine: synth failed', String((e as Error)?.message ?? e), JSON.stringify(job.text.slice(0, 40)));
        // a broken model fails everything after it: start a fresh one and try once more
        this.restart(e);
        if (this.jobs.get(job.key) !== job) {
          // restart gave up and failed every job
        } else if (job.tries++ < 1) {
          job.state = 'queued';
        } else {
          job.state = 'failed';
          this.jobs.delete(job.key);
          job.reject(e);
        }
      }
    } finally {
      job.ctrl = null;
      this.running = null;
      this.pump();
    }
  }

  private remember(key: string) {
    this.done = this.done.filter((k) => k !== key);
    this.done.push(key);
    while (this.done.length > KEEP) {
      const idx = this.done.findIndex((k) => {
        const clip = this.jobs.get(k)?.clip;
        return !clip || !this.pinned.has(clip.url);
      });
      if (idx < 0) break;
      const [old] = this.done.splice(idx, 1);
      const clip = this.jobs.get(old)?.clip;
      if (clip) URL.revokeObjectURL(clip.url);
      this.jobs.delete(old);
    }
  }

  /** Stop the worker and free the model (the player is closing). */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.running?.ctrl?.abort();
    const old = this.tts;
    this.tts = null;
    old?.then((t) => t.dispose(), () => {});
  }
}
