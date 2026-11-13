import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_SENTENCE, classify, speakable, splitSentences } from '../src/content/segment.ts';

const pieces = (text: string) => splitSentences(text).map((s) => text.slice(s.start, s.end));

test('splits plain English into sentences', () => {
  assert.deepEqual(pieces('He said, "Stop!" Then he left. Did she? Yes.'), ['He said, "Stop!"', 'Then he left.', 'Did she?', 'Yes.']);
});

test('keeps titles and initials inside the sentence', () => {
  assert.deepEqual(pieces('Mr. Holmes was seated at the table. I stood upon the rug.'), [
    'Mr. Holmes was seated at the table.',
    'I stood upon the rug.',
  ]);
  assert.deepEqual(pieces('J. K. Rowling wrote it. Dr. Watson agreed with St. John.'), [
    'J. K. Rowling wrote it.',
    'Dr. Watson agreed with St. John.',
  ]);
});

test('separates an English sentence from the translation after it', () => {
  const spans = splitSentences('The rain kept on. 雨一直在下。It never stopped.');
  assert.deepEqual(
    spans.map((s) => [s.en, s.lang]),
    [
      [true, 'en'],
      [false, 'zh'],
      [true, 'en'],
    ],
  );
});

test('splits an inline translation that has no punctuation between', () => {
  const text = 'This is great 这真是太好了，我很喜欢这个东西';
  assert.deepEqual(pieces(text), ['This is great', '这真是太好了，我很喜欢这个东西']);
});

test('leaves English words inside a Chinese sentence alone', () => {
  const spans = splitSentences('我用 Python 写代码，很开心。');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].en, false);
});

test('cuts overlong sentences at a clause boundary', () => {
  const text =
    'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, it was the epoch of belief, it was the epoch of incredulity, it was the season of Light, it was the season of Darkness, it was the spring of hope, it was the winter of despair.';
  const parts = pieces(text);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= MAX_SENTENCE, p);
  assert.ok(parts[0].endsWith(','));
});

test('classifies scripts', () => {
  assert.deepEqual(classify('Hello there'), { en: true, lang: 'en' });
  assert.deepEqual(classify('你好，世界'), { en: false, lang: 'zh' });
  assert.deepEqual(classify('こんにちは世界'), { en: false, lang: 'ja' });
  assert.deepEqual(classify('안녕하세요'), { en: false, lang: 'ko' });
  assert.equal(classify('The city of 北京 is large').en, true);
});

test('skips text without letters', () => {
  assert.deepEqual(pieces('— 1990 —'), []);
});

test('drops footnote marks from speech', () => {
  assert.equal(speakable('A fine thing.[12] Really[citation needed]'), 'A fine thing. Really');
});
