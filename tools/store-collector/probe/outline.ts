import { describeString, maskUrl } from './mask.ts';
import { render, shapeOf } from './skeleton.ts';

/**
 * One book card's structure, element by element (store purchases plan, Stage 2): tags, class
 * names, attribute names, and what attribute values and texts are (JSON shapes, label words, or
 * just their length). Never a title, ID or name. The page side turns elements into these nodes.
 */
export interface OutlineNode {
  tag: string;
  classes: string[];
  attrs: { name: string; value: string }[];
  /** The element's own text (not its children's). */
  text: string;
  children: OutlineNode[];
}

const SHOWN_ATTRS = /^(data-[a-z0-9-]{1,40}|aria-label|title|href|src|alt|role|type|name)$/;

/** `base`: the page's address, so relative links show their real host. */
export function outline(n: OutlineNode, own: string[], maxLines = 80, base?: string): string {
  const lines: string[] = [];
  const walk = (x: OutlineNode, d: number) => {
    if (lines.length >= maxLines) return;
    const pad = '  '.repeat(d);
    const cls = x.classes
      .map((c) => (/\d{3,}/.test(c) ? null : c.replace(/\d+/g, '#')))
      .filter(Boolean)
      .slice(0, 6);
    const parts = [`${pad}${x.tag}${cls.length ? '.' + cls.join('.') : ''}`];
    const nested: string[] = [];
    for (const a of x.attrs) {
      if (!SHOWN_ATTRS.test(a.name)) continue;
      const v = a.value.trim();
      if (a.name === 'href' || a.name === 'src') {
        parts.push(`${a.name}=${maskUrl(v, own, base)}`);
        continue;
      }
      if (v.startsWith('{') || v.startsWith('[')) {
        try {
          nested.push(`${pad}  ${a.name} (JSON):`, render(shapeOf(JSON.parse(v), own), d + 2, 40));
          continue;
        } catch {
          /* not JSON */
        }
      }
      parts.push(`${a.name}=${v ? describeString(v, own) : '(empty)'}`);
    }
    if (x.text.trim()) parts.push(`text: ${describeString(x.text, own)}`);
    lines.push(parts.join(' '), ...nested);
    for (const c of x.children.slice(0, 12)) walk(c, d + 1);
    if (x.children.length > 12) lines.push(`${pad}  … ${x.children.length - 12} more children`);
  };
  walk(n, 0);
  if (lines.length >= maxLines) lines.push(`… (cut at ${maxLines} lines)`);
  return lines.join('\n');
}
