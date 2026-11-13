/**
 * The neural voice: Phonon 31m running in a worker, with a small scheduler on top so the
 * sentence about to be heard is always generated first and work nobody needs any more is
 * cancelled. Finished sentences are kept as WAV blob URLs for instant replay.
 */
import { PhononTTS, encodeWav } from 'phonon-tts';

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
};

const KEEP = 48;
const SAMPLE_RATE = 24000;

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
    this.status = 'loading';
    this.onStatus?.();
    const voices: Record<string, string> = { default: `${this.base}default-voice.safetensors` };
    for (const v of this.voices) voices[v.id] = `${this.base}${v.file}`;
    this.tts = PhononTTS.load({
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
    }).then(
      (tts) => {
        this.status = 'ready';
        this.onStatus?.();
        return tts;
      },
      (e) => {
        this.status = 'failed';
        this.error = e instanceof Error ? e.message : String(e);
        this.tts = null;
        this.onStatus?.();
        for (const job of this.jobs.values()) if (job.state !== 'done') job.reject(e);
        this.jobs.clear();
        throw e;
      },
    );
    return this.tts;
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
      job = { key, text, voice, state: 'queued', promise, resolve, reject, ctrl: null, clip: null };
      this.jobs.set(key, job);
    }
    return job;
  }

  /** Sets what's wanted, most urgent first. Anything else in progress is cancelled. */
  want(texts: string[], voice: string) {
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
    if (this.running) {
      if (!this.order.includes(this.running.key)) this.running.ctrl?.abort();
      return;
    }
    const next = this.order.map((k) => this.jobs.get(k)).find((j) => j && j.state === 'queued');
    if (next) void this.run(next);
  }

  private async run(job: Job) {
    this.running = job;
    job.state = 'running';
    job.ctrl = new AbortController();
    const { signal } = job.ctrl;
    try {
      const tts = await this.load();
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const pcm = await tts.synth(job.text, { voice: job.voice, signal });
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const trimmed = trimSilence(pcm, tts.sampleRate);
      const url = URL.createObjectURL(encodeWav(trimmed, tts.sampleRate));
      job.clip = { url, duration: trimmed.length / tts.sampleRate };
      job.state = 'done';
      job.resolve(job.clip);
      this.remember(job.key);
    } catch (e) {
      if (signal.aborted) {
        // still wanted later? then it goes back in line; otherwise it's dropped
        if (this.order.includes(job.key)) job.state = 'queued';
        else {
          this.jobs.delete(job.key);
          job.reject(e);
        }
      } else {
        job.state = 'failed';
        this.jobs.delete(job.key);
        job.reject(e);
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

  /** Say something once, outside the reading queue (voice previews). */
  async preview(text: string, voice: string): Promise<Clip> {
    return this.clip(text, voice);
  }
}
