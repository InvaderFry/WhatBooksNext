// Match quality report (PLAN.md §11.5): runs the matching over labelled examples and counts
// coverage by confidence band, precision, and — the number that matters — wrong
// high-confidence matches. No network: each case is matched against a recorded response.
// Used by `npm run report:matches` (scripts/reportMatches.ts) and by a test, so CI enforces it.
import fs from 'node:fs';
import path from 'node:path';
import { parseAniList } from '../sources/anilist.ts';
import { parseHardcover } from '../sources/hardcover.ts';
import { parseOpenLibrary } from '../sources/openlibrary.ts';
import type { SourceRecord } from '../sources/types.ts';
import { decide, type MatchFacts } from './match.ts';

export interface MatchCase {
  name: string;
  facts: Partial<MatchFacts> & { title: string };
  response: string;
  expect: string | null;
  heldOut?: boolean;
}

export interface MatchCaseResult {
  name: string;
  heldOut: boolean;
  decision: 'accepted' | 'provisional' | 'tie' | 'unidentified';
  score: number | null;
  got: string | null;
  expected: string | null;
  ok: boolean;
}

export interface MatchReport {
  total: number;
  bands: Record<MatchCaseResult['decision'], number>;
  right: number;
  wrong: number;
  /** Accepted (high-confidence) matches to the wrong record: must stay 0. */
  wrongHigh: number;
  /** Left unidentified though a right answer existed. */
  missed: number;
  heldRight: number;
  heldTotal: number;
  results: MatchCaseResult[];
  /** One line per case, for printing. */
  lines: string[];
}

function records(file: string): SourceRecord[] {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  const name = path.basename(file);
  if (name.startsWith('anilist')) return parseAniList(payload);
  if (name.startsWith('hardcover')) return parseHardcover(payload);
  return parseOpenLibrary(payload);
}

export function evaluateMatchCases(casesFile: string, responsesDir: string): MatchReport {
  const { cases } = JSON.parse(fs.readFileSync(casesFile, 'utf8')) as { cases: MatchCase[] };
  const r: MatchReport = {
    total: cases.length,
    bands: { accepted: 0, provisional: 0, tie: 0, unidentified: 0 },
    right: 0,
    wrong: 0,
    wrongHigh: 0,
    missed: 0,
    heldRight: 0,
    heldTotal: 0,
    results: [],
    lines: [],
  };
  for (const c of cases) {
    const facts: MatchFacts = {
      titleSource: 'embedded',
      authors: [],
      isbns: [],
      isbnCandidates: [],
      kind: null,
      ...c.facts,
    };
    const d = decide(facts, records(path.join(responsesDir, c.response)));
    r.bands[d.decision]++;
    const got =
      d.decision === 'accepted' || d.decision === 'provisional' ? d.best!.record.sourceId : null;
    const ok = got === c.expect;
    if (ok) r.right++;
    else if (got === null) r.missed++;
    else {
      r.wrong++;
      if (d.decision === 'accepted') r.wrongHigh++;
    }
    if (c.heldOut) {
      r.heldTotal++;
      if (ok) r.heldRight++;
    }
    r.results.push({
      name: c.name,
      heldOut: Boolean(c.heldOut),
      decision: d.decision,
      score: d.best ? d.best.score : null,
      got,
      expected: c.expect,
      ok,
    });
    r.lines.push(
      `  ${ok ? '✓' : '✕'} ${c.name}${c.heldOut ? ' (held out)' : ''}: ${d.decision}${d.best ? ` ${d.best.score.toFixed(2)}` : ''} → ${got ?? 'none'}${ok ? '' : ` (expected ${c.expect ?? 'none'})`}`,
    );
  }
  return r;
}
