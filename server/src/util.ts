import { randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();

export const nowIso = (): string => new Date().toISOString();

/** Today's date as YYYY-MM-DD in local time — the owner's calendar day, not UTC's. */
export function todayLocal(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Decodes the HTML character references some catalogue entries carry as plain text
 * ("Mrzyg&#322;ód" → "Mrzygłód"). Text only: nothing is ever rendered as HTML (§6.3).
 */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return named[code.toLowerCase()] ?? m;
  });
}
