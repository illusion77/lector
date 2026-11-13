import { ext } from './ext';

export type Settings = {
  /** Voice id from voices.json, or 'default' for the model's own voice. */
  voice: string;
  /** Playback speed, 0.5 to 2.5. */
  rate: number;
  /** Skip text the English voice can't read, such as translations shown under the original. */
  englishOnly: boolean;
  /** Stop after each sentence instead of reading on. */
  stepMode: boolean;
  /** Keep the sentence being read in view. */
  follow: boolean;
};

export const DEFAULTS: Settings = {
  voice: 'default',
  rate: 1,
  englishOnly: true,
  stepMode: false,
  follow: true,
};

export const RATES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
export const MIN_RATE = 0.5;
export const MAX_RATE = 2.5;

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  try {
    const got = await ext.storage.local.get(KEY);
    return { ...DEFAULTS, ...((got?.[KEY] as Partial<Settings>) ?? {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(settings: Settings) {
  try {
    await ext.storage.local.set({ [KEY]: settings });
  } catch {
    /* storage unavailable: settings last for this page only */
  }
}

export function onSettingsChange(cb: (s: Settings) => void) {
  try {
    ext.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) cb({ ...DEFAULTS, ...(changes[KEY].newValue as Partial<Settings>) });
    });
  } catch {
    /* no storage events */
  }
}
