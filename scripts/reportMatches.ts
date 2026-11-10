import { reportDetailChanges } from './detailComparison.ts';
// Match quality report (PLAN.md §11.5): runs the matching over labelled examples and reports
// coverage by confidence band, precision, and — the number that matters — wrong
// high-confidence matches. No network: each case is matched against a recorded response.
//
//   npm run report:matches
//
// Committed cases: fixtures/matches/cases.json (public classics). If
// fixtures/private/match-cases.json exists (gitignored; the owner's real titles, with
// responses saved under fixtures/private/sources/), it is reported too, separately.
import { reportRatingChanges } from './ratingComparison.ts';
import fs from 'node:fs';
import path from 'node:path';
import { decide, type MatchFacts } from '../server/src/identify/match.ts';
import { parseAniList } from '../server/src/sources/anilist.ts';
import { parseHardcover } from '../server/src/sources/hardcover.ts';
import { parseOpenLibrary } from '../server/src/sources/openlibrary.ts';
import type { SourceRecord } from '../server/src/sources/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

interface Case {
  name: string;
  facts: Partial<MatchFacts> & { title: string };
  response: string;
  expect: string | null;
  heldOut?: boolean;
}

function records(file: string): SourceRecord[] {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  const name = path.basename(file);
  if (name.startsWith('anilist')) return parseAniList(payload);
  if (name.startsWith('hardcover')) return parseHardcover(payload);
  return parseOpenLibrary(payload);
}

function report(label: string, casesFile: string, responsesDir: string): boolean {
  const { cases } = JSON.parse(fs.readFileSync(casesFile, 'utf8')) as { cases: Case[] };
  const bands = { accepted: 0, provisional: 0, tie: 0, unidentified: 0 };
  let right = 0;
  let wrong = 0;
  let wrongHigh = 0;
  let missed = 0;
  let heldRight = 0;
  let heldTotal = 0;
  const lines: string[] = [];
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
    bands[d.decision]++;
    const got =
      d.decision === 'accepted' || d.decision === 'provisional' ? d.best!.record.sourceId : null;
    const ok = got === c.expect;
    if (ok) right++;
    else if (got === null) missed++;
    else {
      wrong++;
      if (d.decision === 'accepted') wrongHigh++;
    }
    if (c.heldOut) {
      heldTotal++;
      if (ok) heldRight++;
    }
    lines.push(
      `  ${ok ? '✓' : '✕'} ${c.name}${c.heldOut ? ' (held out)' : ''}: ${d.decision}${d.best ? ` ${d.best.score.toFixed(2)}` : ''} → ${got ?? 'none'}${ok ? '' : ` (expected ${c.expect ?? 'none'})`}`,
    );
  }
  const matched = cases.length - bands.tie - bands.unidentified;
  console.log(`\n${label}: ${cases.length} labelled examples`);
  console.log(lines.join('\n'));
  console.log(
    `\n  Bands: ${bands.accepted} accepted · ${bands.provisional} provisional · ${bands.tie} tied · ${bands.unidentified} unidentified`,
  );
  console.log(
    `  Correct: ${right} of ${cases.length}. Precision of matches made: ${matched ? `${Math.round(((matched - wrong) / matched) * 100)}%` : '–'} (${wrong} wrong).`,
  );
  console.log(`  Wrong HIGH-confidence matches: ${wrongHigh}   ← the number that matters`);
  console.log(`  Held-out examples correct: ${heldRight} of ${heldTotal}.`);
  console.log(`  Missed (left unidentified though a right answer existed): ${missed}.`);
  return wrongHigh === 0;
}

let ok = report(
  'Committed fixture set',
  path.join(ROOT, 'fixtures', 'matches', 'cases.json'),
  path.join(ROOT, 'fixtures', 'sources'),
);
const privateCases = path.join(ROOT, 'fixtures', 'private', 'match-cases.json');
if (fs.existsSync(privateCases)) {
  ok =
    report(
      'Private set (owner’s titles)',
      privateCases,
      path.join(ROOT, 'fixtures', 'private', 'sources'),
    ) && ok;
} else {
  console.log(
    '\n(No private set at fixtures/private/match-cases.json; only the committed set was run.)',
  );
}
reportRatingChanges();
await reportDetailChanges();
process.exitCode = ok ? 0 : 1;
