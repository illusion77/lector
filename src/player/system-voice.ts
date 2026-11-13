/**
 * The browser's own speech synthesis, for text the neural voice can't read (Chinese,
 * Japanese, Korean) and as a fallback if the neural voice fails to load.
 */

let unlocked = false;

function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices();
  if (!lang) return null;
  const matches = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(lang.toLowerCase()));
  if (!matches.length) return null;
  // prefer the better-sounding variants the OS offers
  const rank = (v: SpeechSynthesisVoice) =>
    (/premium/i.test(v.name) ? 0 : /enhanced/i.test(v.name) ? 1 : v.localService ? 2 : 3) +
    (lang === 'zh' && !/zh[-_]CN/i.test(v.lang) ? 0.5 : 0);
  return matches.sort((a, b) => rank(a) - rank(b))[0];
}

export const systemVoice = {
  available(): boolean {
    return typeof speechSynthesis !== 'undefined';
  },

  /** iOS only lets speech start from a tap; an empty utterance during one unlocks it. */
  unlock() {
    if (unlocked || !this.available()) return;
    unlocked = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch {
      /* ignore */
    }
  },

  speak(text: string, lang: string, rate: number, handlers: { onStart: () => void; onEnd: () => void; onError: (e: string) => void }) {
    if (!this.available()) {
      handlers.onError('Speech synthesis is not available');
      return;
    }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(lang || 'en');
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? (lang === 'zh' ? 'zh-CN' : lang || 'en-US');
    u.rate = Math.max(0.5, Math.min(2, rate));
    let done = false;
    let started = false;
    // some setups never start speaking (no voices installed, or no user gesture yet): move on
    const watchdog = setTimeout(() => {
      if (started || done) return;
      done = true;
      speechSynthesis.cancel();
      handlers.onError('Speech did not start');
    }, 3000);
    u.onstart = () => {
      started = true;
      clearTimeout(watchdog);
      handlers.onStart();
    };
    u.onend = () => {
      clearTimeout(watchdog);
      if (done) return;
      done = true;
      handlers.onEnd();
    };
    u.onerror = (e) => {
      clearTimeout(watchdog);
      if (done) return;
      done = true;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      handlers.onError(e.error);
    };
    speechSynthesis.speak(u);
  },

  stop() {
    if (this.available()) speechSynthesis.cancel();
  },
};
