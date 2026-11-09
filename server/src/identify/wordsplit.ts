import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Splits run-together lowercase text into words ("boatofamillionyears" -> "boat of a million
 * years"), the wordninja approach: words are costed by their rank in an English frequency
 * list (Zipf's law) and dynamic programming picks the cheapest split. The list is wordninja's
 * (MIT, see THIRD_PARTY_NOTICES.md).
 *
 * This is a fallback guess, never authority: it fails on names and non-English titles (§11.1).
 */

const WORDS_FILE = path.join(import.meta.dirname, 'data', 'wordninja_words.txt.gz');

let costs: Map<string, number> | null = null;
let ranks: Map<string, number> | null = null;
let maxWordLength = 0;

function load(): Map<string, number> {
  if (costs) return costs;
  const words = zlib.gunzipSync(fs.readFileSync(WORDS_FILE)).toString('utf8').split('\n');
  const list = words.map((w) => w.trim()).filter(Boolean);
  const logN = Math.log(list.length);
  costs = new Map();
  ranks = new Map();
  list.forEach((w, i) => {
    if (!ranks!.has(w)) ranks!.set(w, i + 1);
    if (!costs!.has(w)) costs!.set(w, Math.log((i + 1) * logN));
    maxWordLength = Math.max(maxWordLength, w.length);
  });
  return costs;
}

/** Cost of a chunk not in the dictionary: high, growing with length, so known words win. */
const UNKNOWN_COST = 1e6;

function splitRun(s: string): string[] {
  const dict = load();
  const n = s.length;
  const best: number[] = [0];
  const back: number[] = [0];
  for (let i = 1; i <= n; i++) {
    let bestCost = Infinity;
    let bestLen = 1;
    for (let k = 1; k <= Math.min(i, maxWordLength); k++) {
      const word = s.slice(i - k, i);
      const c = best[i - k]! + (dict.get(word) ?? UNKNOWN_COST * k);
      if (c < bestCost) {
        bestCost = c;
        bestLen = k;
      }
    }
    best[i] = bestCost;
    back[i] = bestLen;
  }
  const out: string[] = [];
  for (let i = n; i > 0; i -= back[i]!) out.unshift(s.slice(i - back[i]!, i));
  // Keep runs of digits together ("1965" not "19 65"), and glue apostrophe-less leftovers.
  const merged: string[] = [];
  for (const w of out) {
    const prev = merged.at(-1);
    if (prev !== undefined && /^\d+$/.test(prev) && /^\d+$/.test(w))
      merged[merged.length - 1] = prev + w;
    else merged.push(w);
  }
  return merged;
}

/** Splits lowercase text; anything that isn't a-z or 0-9 is treated as a separator. */
export function splitWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .flatMap((chunk) => splitRun(chunk));
}

export function isKnownWord(word: string): boolean {
  return load().has(word.toLowerCase());
}

/** 1-based frequency rank of a word in English (1 = most common), or null if unknown. */
export function wordRank(word: string): number | null {
  load();
  return ranks!.get(word.toLowerCase()) ?? null;
}
