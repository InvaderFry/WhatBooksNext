import { decodeEntities } from './xml.ts';

/** Visible text of an (X)HTML document: scripts, styles and tags removed, entities decoded. */
export function htmlToText(html: string): string {
  const body = /<body[\s>][\s\S]*$/i.exec(html)?.[0] ?? html;
  return decodeEntities(
    body
      .replace(/<(script|style|head)[\s>][\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Scripts written without spaces between words (CJK, Thai…): counted with Intl.Segmenter. */
const UNSPACED = /[぀-ヿ㐀-鿿가-힯฀-๿]/;
let segmenter: Intl.Segmenter | null = null;

/**
 * Words in a text. Spaced scripts: runs containing a letter or digit. Unspaced scripts use the
 * platform's word segmenter, so a Japanese novel isn't counted as a handful of "words".
 */
export function countWords(text: string): number {
  if (!text) return 0;
  if (UNSPACED.test(text)) {
    segmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
    let n = 0;
    for (const s of segmenter.segment(text)) if (s.isWordLike) n++;
    return n;
  }
  let n = 0;
  for (const w of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(w)) n++;
  return n;
}

/**
 * ISBN candidates in a text: ISBN-13 (978/979) and ISBN-10 with a valid check digit,
 * normalised to ISBN-13. Only candidates (§10): a tech book quotes other books' ISBNs.
 */
export function findIsbns(text: string): string[] {
  const out = new Set<string>();
  const re = /(?:ISBN(?:-1[03])?:?\s*)?((?:97[89][-\s]?)?(?:\d[-\s]?){9}[\dXx])\b/g;
  let m;
  while ((m = re.exec(text))) {
    const digits = m[1]!.replace(/[-\s]/g, '').toUpperCase();
    if (digits.length === 13 && validIsbn13(digits)) out.add(digits);
    else if (digits.length === 10 && validIsbn10(digits)) out.add(isbn10to13(digits));
  }
  return [...out];
}

export function validIsbn13(s: string): boolean {
  if (!/^97[89]\d{10}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 ? 3 : 1);
  return sum % 10 === 0;
}

export function validIsbn10(s: string): boolean {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (s[i] === 'X' ? 10 : Number(s[i])) * (10 - i);
  return sum % 11 === 0;
}

export function isbn10to13(s: string): string {
  const core = '978' + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
  return core + ((10 - (sum % 10)) % 10);
}

/** Natural order for page names: "page 2" before "page 10". */
export const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  .compare;
