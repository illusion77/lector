/** Messages between the content script (which knows the page) and the player frame (which speaks). */
import type { Settings } from './settings';

export type Platform = 'desktop' | 'touch';
export type Theme = 'light' | 'dark';

export type Item = { id: number; text: string; en: boolean; lang: string };

export type ToPlayer =
  | { type: 'hello'; theme: Theme; maxWidth: number; maxHeight: number; title: string }
  | { type: 'theme'; theme: Theme }
  | { type: 'layout'; maxWidth: number; maxHeight: number }
  /** Fold the settings card back into the bar (the reader clicked the page). */
  | { type: 'collapse' }
  /** Speed shortcuts pressed on the page. */
  | { type: 'adjust'; command: 'faster' | 'slower' }
  /** Play this sentence from its start. */
  | { type: 'play'; item: Item }
  /** Show this sentence as current without playing it; get its audio ready. */
  | { type: 'cue'; item: Item }
  | { type: 'pause' }
  | { type: 'resume' }
  /** Sentences likely to be read next, in order. */
  | { type: 'prefetch'; items: Item[] }
  | { type: 'status'; canPrev: boolean; canNext: boolean; atEnd: boolean }
  | { type: 'close' };

export type Command = 'toggle' | 'prev' | 'next' | 'close' | 'faster' | 'slower';

export type ToContent =
  | { type: 'ready' }
  | { type: 'size'; width: number; height: number; radius: number; expanded: boolean }
  | { type: 'command'; command: Command }
  /** Audio for this sentence started (or resumed). */
  | { type: 'playing'; id: number }
  | { type: 'paused'; id: number }
  | { type: 'ended'; id: number }
  /** The browser refused to start audio without a tap in the player. */
  | { type: 'blocked'; id: number }
  | { type: 'failed'; id: number; message: string }
  | { type: 'settings'; settings: Settings }
  | { type: 'drag'; phase: 'start' | 'move' | 'end'; dx: number; dy: number };

export const CONNECT = 'lector:connect';
