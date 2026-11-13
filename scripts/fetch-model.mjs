// Downloads the Phonon 31m checkpoint and the English voices into vendor/model/.
// Everything is pinned to a commit, so a build is reproducible and the files never
// change under the extension. LFS files are checked against the Hub's sha256.
//
//   npm run fetch-model

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'vendor', 'model');

const MODEL_REPO = 'gradium/phonon-31m-en';
const MODEL_REV = '92741c5b07d085ff840e26fea8ce43110b87852f';
const VOICES_REPO = 'gradium/phonon-voices';
const VOICES_REV = '0ee17205f254b5abc43b266c8a0f215565c352f7';

const MODEL_FILES = ['config.json', 'tokenizer.json', 'model.q8.gguf', 'default-voice.safetensors'];

const hub = (repo, rev, file) => `https://huggingface.co/${repo}/resolve/${rev}/${file}`;

async function tree(repo, rev, dir = '') {
  const res = await fetch(`https://huggingface.co/api/models/${repo}/tree/${rev}/${dir}`);
  if (!res.ok) throw new Error(`${repo}: listing failed (${res.status})`);
  const files = await res.json();
  return new Map(files.map((f) => [f.path, f.lfs?.oid ?? null]));
}

async function download(url, dest, sha256) {
  if (existsSync(dest) && sha256) {
    const have = createHash('sha256').update(await readFile(dest)).digest('hex');
    if (have === sha256) return false;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (sha256) {
    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== sha256) throw new Error(`${url}: sha256 mismatch`);
  }
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, bytes);
  return true;
}

async function main() {
  await mkdir(path.join(OUT, 'voices'), { recursive: true });

  const modelTree = await tree(MODEL_REPO, MODEL_REV);
  for (const file of MODEL_FILES) {
    const fresh = await download(hub(MODEL_REPO, MODEL_REV, file), path.join(OUT, file), modelTree.get(file));
    console.log(`${fresh ? 'fetched' : 'cached '}  ${file}`);
  }

  // The catalog lists every voice; keep the plain English ones (US and UK), not the
  // character voices, which are made for games and stories.
  const catalog = await (await fetch(hub(VOICES_REPO, VOICES_REV, 'voices.jsonl'))).text();
  const voices = catalog
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((v) => v.language === 'en' && (v.locale === 'en-us' || v.locale === 'en-gb'));
  const voiceTree = await tree(VOICES_REPO, VOICES_REV, 'voices');

  const index = [];
  for (const v of voices) {
    const file = `voices/${v.voice_id}.safetensors`;
    await download(hub(VOICES_REPO, VOICES_REV, v.filename), path.join(OUT, file), voiceTree.get(v.filename));
    index.push({
      id: v.voice_id,
      name: v.name,
      accent: v.locale === 'en-gb' ? 'UK' : 'US',
      gender: v.gender,
      age: v.age,
      description: v.description,
      file,
    });
  }
  await writeFile(path.join(OUT, 'voices.json'), JSON.stringify(index, null, 2) + '\n');
  console.log(`voices    ${index.length} English voices`);
  console.log(`\nModel files are in ${path.relative(ROOT, OUT)}/`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
