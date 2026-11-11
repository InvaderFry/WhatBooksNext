import { describeString, safeKey } from './mask.ts';

/**
 * The shape of a store's answer, never its values (store purchases plan, Stage 2): keys, types,
 * list sizes and label words. Lists of similar things are merged into one shape; short lists
 * (like Google's positional arrays) keep each position, because an adapter reads by position.
 */

export type Shape =
  | { t: 'null' }
  | { t: 'bool' }
  | { t: 'num' }
  | { t: 'str'; seen: string[] }
  | { t: 'obj'; keys: Record<string, Shape>; idKeys?: Shape }
  | { t: 'list'; n: number[]; of: Shape | null }
  | { t: 'tuple'; items: Shape[] }
  | { t: 'mixed'; of: Shape[] };

const MAX_DEPTH = 14;
const MAX_LABELS = 6;

export function shapeOf(v: unknown, own: string[], depth = 0): Shape {
  if (v === null || v === undefined) return { t: 'null' };
  if (typeof v === 'boolean') return { t: 'bool' };
  if (typeof v === 'number') return { t: 'num' };
  if (typeof v === 'string') {
    // Google and others put JSON inside strings: look inside.
    const s = v.trim();
    if (depth < MAX_DEPTH && s.length > 1 && (s[0] === '[' || s[0] === '{')) {
      try {
        return {
          t: 'mixed',
          of: [{ t: 'str', seen: ['json text:'] }, shapeOf(JSON.parse(s), own, depth + 1)],
        };
      } catch {
        /* not JSON */
      }
    }
    return { t: 'str', seen: [describeString(v, own)] };
  }
  if (depth >= MAX_DEPTH) return { t: 'str', seen: ['(deeper levels left out)'] };
  if (Array.isArray(v)) {
    const items = v.map((x) => shapeOf(x, own, depth + 1));
    // Several things of one kind are records: merge them. Mixed kinds are positional (Google's
    // arrays put a different field at each position), so each position is kept.
    if (items.length === 0) return { t: 'list', n: [0], of: null };
    const same = items.every((x) => x.t === items[0]!.t);
    if (items.length >= 2 && same)
      return {
        t: 'list',
        n: [items.length],
        of: items.reduce<Shape | null>((a, b) => (a ? merge(a, b) : b), null),
      };
    return { t: 'tuple', items };
  }
  const keys: Record<string, Shape> = {};
  let idKeys: Shape | undefined;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const s = shapeOf(x, own, depth + 1);
    if (safeKey(k)) keys[k] = keys[k] ? merge(keys[k]!, s) : s;
    else idKeys = idKeys ? merge(idKeys, s) : s;
  }
  return idKeys ? { t: 'obj', keys, idKeys } : { t: 'obj', keys };
}

export function merge(a: Shape, b: Shape): Shape {
  if (a.t === 'null') return b;
  if (b.t === 'null') return a;
  if (a.t !== b.t) {
    const of = a.t === 'mixed' ? [...a.of] : [a];
    for (const x of b.t === 'mixed' ? b.of : [b]) {
      const i = of.findIndex((y) => y.t === x.t);
      if (i >= 0) of[i] = merge(of[i]!, x);
      else of.push(x);
    }
    return { t: 'mixed', of };
  }
  switch (a.t) {
    case 'str': {
      const seen = [...a.seen];
      for (const s of (b as typeof a).seen)
        if (!seen.includes(s) && seen.length < MAX_LABELS) seen.push(s);
      return { t: 'str', seen };
    }
    case 'obj': {
      const bb = b as typeof a;
      const keys = { ...a.keys };
      for (const [k, s] of Object.entries(bb.keys)) keys[k] = keys[k] ? merge(keys[k]!, s) : s;
      const idKeys = a.idKeys && bb.idKeys ? merge(a.idKeys, bb.idKeys) : (a.idKeys ?? bb.idKeys);
      return idKeys ? { t: 'obj', keys, idKeys } : { t: 'obj', keys };
    }
    case 'list': {
      const bb = b as typeof a;
      return {
        t: 'list',
        n: [...a.n, ...bb.n].slice(0, 8),
        of: a.of && bb.of ? merge(a.of, bb.of) : (a.of ?? bb.of),
      };
    }
    case 'tuple': {
      const bb = b as typeof a;
      const len = Math.max(a.items.length, bb.items.length);
      return {
        t: 'tuple',
        items: Array.from({ length: len }, (_, i) =>
          a.items[i] && bb.items[i]
            ? merge(a.items[i]!, bb.items[i]!)
            : (a.items[i] ?? bb.items[i]!),
        ),
      };
    }
    case 'mixed':
      return merge({ t: 'null' }, { t: 'mixed', of: [...a.of, ...(b as typeof a).of] });
    default:
      return a;
  }
}

/** Shapes as indented text for the report. */
export function render(s: Shape | null, indent = 0, maxLines = 400): string {
  const lines: string[] = [];
  const pad = (n: number) => '  '.repeat(n);
  const walk = (x: Shape | null, d: number, label: string) => {
    if (lines.length >= maxLines) return;
    const head = `${pad(d)}${label}`;
    if (!x) return void lines.push(`${head}(empty)`);
    switch (x.t) {
      case 'null':
        return void lines.push(`${head}null`);
      case 'bool':
        return void lines.push(`${head}true/false`);
      case 'num':
        return void lines.push(`${head}number`);
      case 'str':
        return void lines.push(`${head}${x.seen.join(' | ')}`);
      case 'obj':
        lines.push(`${head}{`);
        for (const [k, v] of Object.entries(x.keys)) walk(v, d + 1, `${k}: `);
        if (x.idKeys) walk(x.idKeys, d + 1, '<id-like keys>: ');
        return void lines.push(`${pad(d)}}`);
      case 'list':
        lines.push(`${head}list of ${x.n.join('/')}:`);
        return walk(x.of, d + 1, '');
      case 'tuple':
        lines.push(`${head}[`);
        x.items.forEach((v, i) => walk(v, d + 1, `[${i}] `));
        return void lines.push(`${pad(d)}]`);
      case 'mixed':
        lines.push(`${head}one of:`);
        x.of.forEach((v) => walk(v, d + 1, '- '));
        return;
    }
  };
  walk(s, indent, '');
  if (lines.length >= maxLines) lines.push(`${pad(indent)}… (cut at ${maxLines} lines)`);
  return lines.join('\n');
}

/**
 * Reads an answer body as data: JSON, Google's ")]}'"-prefixed batch answers (each line that is
 * JSON), or nothing. Never returns the text itself.
 */
export function parseBody(text: string): unknown[] {
  const t = text.trim();
  if (!t) return [];
  try {
    return [JSON.parse(t)];
  } catch {
    /* fall through */
  }
  const out: unknown[] = [];
  for (const line of t.replace(/^\)\]\}'/, '').split('\n')) {
    const l = line.trim();
    if (!l || (l[0] !== '[' && l[0] !== '{')) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* skip */
    }
  }
  return out;
}
