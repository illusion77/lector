/**
 * Sentence segmentation and language detection on plain text. No DOM here, so it runs
 * (and is tested) in Node as well.
 */

export type Span = {
  start: number;
  end: number;
  /** Mostly Latin script: something the English voice can read. */
  en: boolean;
  /** BCP 47 guess for text the English voice can't read: 'zh', 'ja', 'ko' or ''. */
  lang: string;
};

/** Longest sentence spoken as one clip; longer ones are cut at a clause boundary. */
export const MAX_SENTENCE = 240;

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff66-\uff9f]/;
const CJK_G = new RegExp(CJK.source, 'g');
const KANA_G = /[\u3040-\u30ff\uff66-\uff9f]/g;
const HANGUL_G = /[\uac00-\ud7af]/g;
const LATIN_G = /[A-Za-z\u00c0-\u024f]/g;
const LETTER_G = /\p{L}/gu;
const LETTER = /\p{L}/u;

/**
 * Titles and initials that end in a period without ending the sentence. The segmenter
 * breaks after them whenever a capital follows ("Mr. Holmes", "J. K. Rowling").
 */
const NO_BREAK_AFTER =
  /(?:^|[\s("'“‘])(?:Mr|Mrs|Ms|Mx|Messrs|Mme|Mlle|Dr|Prof|St|Mt|Ft|Gen|Col|Capt|Cmdr|Lt|Sgt|Rev|Hon|Gov|Sen|Rep|Pres|vs|[A-Z])\.$/;

let segmenter: Intl.Segmenter | null = null;

function count(text: string, re: RegExp): number {
  re.lastIndex = 0;
  return text.match(re)?.length ?? 0;
}

/** Is this text English (Latin script), and if not, which language is it likely in? */
export function classify(text: string): { en: boolean; lang: string } {
  const latin = count(text, LATIN_G);
  const cjk = count(text, CJK_G);
  const other = count(text, LETTER_G) - latin - cjk;
  // one CJK character carries about as much as a short word, so weigh it like three letters
  const en = latin > 0 && latin >= 0.6 * (latin + 3 * cjk + other);
  if (en) return { en, lang: 'en' };
  if (cjk === 0) return { en, lang: '' };
  if (count(text, KANA_G) > 0) return { en, lang: 'ja' };
  if (count(text, HANGUL_G) > cjk / 2) return { en, lang: 'ko' };
  return { en, lang: 'zh' };
}

function rawSentences(text: string): Array<[number, number]> {
  segmenter ??= new Intl.Segmenter('en', { granularity: 'sentence' });
  const out: Array<[number, number]> = [];
  for (const s of segmenter.segment(text)) out.push([s.index, s.index + s.segment.length]);
  return out;
}

function trim(text: string, start: number, end: number): [number, number] {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return [start, end];
}

/**
 * Splits a sentence that mixes a CJK passage and an English passage, as inline
 * translations do ("The rain kept on. 雨一直在下"). Short embedded words ("我用 Python
 * 写代码") stay where they are.
 */
function splitScripts(text: string, start: number, end: number): Array<[number, number]> {
  type Chunk = { start: number; end: number; cjk: boolean };
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  for (let i = start; i < end; i++) {
    const ch = text[i];
    const isCjk = CJK.test(ch);
    const isLatin = !isCjk && /[A-Za-z\u00c0-\u024f]/.test(ch);
    if (!isCjk && !isLatin) {
      if (cur) cur.end = i + 1;
      continue;
    }
    if (!cur) cur = { start, end: i + 1, cjk: isCjk };
    else if (cur.cjk !== isCjk) {
      chunks.push(cur);
      cur = { start: i, end: i + 1, cjk: isCjk };
    } else cur.end = i + 1;
  }
  if (cur) chunks.push(cur);
  if (chunks.length < 2) return [[start, end]];

  const substantial = (c: Chunk) => {
    const t = text.slice(c.start, c.end);
    return c.cjk ? count(t, CJK_G) >= 4 : t.trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length >= 3;
  };
  // fold chunks too small to stand alone into their neighbour
  const merged: Chunk[] = [];
  for (const c of chunks) {
    const prev = merged[merged.length - 1];
    if (prev && (!substantial(c) || prev.cjk === c.cjk)) prev.end = c.end;
    else if (prev && !substantial(prev)) {
      prev.end = c.end;
      prev.cjk = c.cjk;
    } else merged.push({ ...c });
  }
  if (merged.length < 2) return [[start, end]];
  return merged.map((c) => trim(text, c.start, c.end));
}

/** Cuts an overlong sentence at the clause boundary closest to its middle. */
function splitLong(text: string, start: number, end: number, out: Array<[number, number]>) {
  if (end - start <= MAX_SENTENCE) {
    out.push([start, end]);
    return;
  }
  const mid = (start + end) / 2;
  const min = 40;
  let best = -1;
  let bestScore = Infinity;
  const re = /[;:]\s|\s[—–-]{1,2}\s|—|,\s|\)\s/g;
  re.lastIndex = start;
  const slice = text.slice(0, end);
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice))) {
    const cut = m.index + m[0].length;
    if (cut - start < min || end - cut < min) continue;
    // prefer stronger punctuation: semicolons and dashes over commas
    const weight = /[;:—–]/.test(m[0]) ? 0.6 : 1;
    const score = Math.abs(cut - mid) * weight;
    if (score < bestScore) {
      bestScore = score;
      best = cut;
    }
  }
  if (best < 0) {
    // no clause boundary: cut at the space nearest the middle
    const back = text.lastIndexOf(' ', Math.floor(mid));
    best = back > start + min ? back + 1 : text.indexOf(' ', Math.floor(mid)) + 1;
    if (best <= start || best >= end) {
      out.push([start, end]);
      return;
    }
  }
  const [a0, a1] = trim(text, start, best);
  const [b0, b1] = trim(text, best, end);
  splitLong(text, a0, a1, out);
  splitLong(text, b0, b1, out);
}

/** The sentences of a block of text, with offsets into it. */
export function splitSentences(text: string): Span[] {
  const raw = rawSentences(text);

  // re-join breaks after titles and initials
  const joined: Array<[number, number]> = [];
  for (const [s, e] of raw) {
    const prev = joined[joined.length - 1];
    if (prev && NO_BREAK_AFTER.test(text.slice(prev[0], prev[1]).trimEnd())) prev[1] = e;
    else joined.push([s, e]);
  }

  const out: Span[] = [];
  for (const [s0, e0] of joined) {
    const [s, e] = trim(text, s0, e0);
    if (e <= s) continue;
    for (const [a, b] of splitScripts(text, s, e)) {
      const pieces: Array<[number, number]> = [];
      splitLong(text, a, b, pieces);
      for (const [p, q] of pieces) {
        const t = text.slice(p, q);
        if (!LETTER.test(t)) continue;
        out.push({ start: p, end: q, ...classify(t) });
      }
    }
  }
  return out;
}

/** What the voice should say for a sentence: footnote marks and stray symbols removed. */
export function speakable(text: string): string {
  return text
    .replace(/\[(?:\d{1,3}|[a-z]|citation needed|note \d+|edit)\]/gi, '')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
