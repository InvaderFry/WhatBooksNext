import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../testing/helpers.ts';
import { evaluateMatchCases } from './matchReport.ts';

/**
 * `npm run report:matches` must keep 0 wrong high-confidence matches (CLAUDE.md). This runs the
 * same report over the committed fixtures, so CI enforces it.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CASES = path.join(ROOT, 'fixtures', 'matches', 'cases.json');
const SOURCES = path.join(ROOT, 'fixtures', 'sources');

describe('the match report', () => {
  it('finds no wrong high-confidence match in the committed examples', () => {
    const r = evaluateMatchCases(CASES, SOURCES);
    expect(r.total).toBeGreaterThan(0);
    expect(r.wrongHigh, r.lines.join('\n')).toBe(0);
  });

  it('counts a confident match to the wrong record as a wrong high-confidence match', () => {
    const { cases } = JSON.parse(fs.readFileSync(CASES, 'utf8')) as {
      cases: { expect: string | null }[];
    };
    const r0 = evaluateMatchCases(CASES, SOURCES);
    const accepted = r0.results.findIndex((x) => x.decision === 'accepted');
    expect(accepted).toBeGreaterThanOrEqual(0);
    // Label the right answer as something else: the same confident match is now wrong.
    cases[accepted]!.expect = 'not-the-right-record';
    const dir = tempDir('wbn-match-cases-');
    try {
      const file = path.join(dir, 'cases.json');
      fs.writeFileSync(file, JSON.stringify({ cases }));
      const r = evaluateMatchCases(file, SOURCES);
      expect(r.wrongHigh).toBe(1);
      expect(r.wrong).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
