import { reportDetailChanges } from './detailComparison.ts';
// Match quality report (PLAN.md §11.5): runs the matching over labelled examples and reports
// coverage by confidence band, precision, and — the number that matters — wrong
// high-confidence matches. No network: each case is matched against a recorded response.
// The counting is in server/src/identify/matchReport.ts, which a test also runs (CI).
//
//   npm run report:matches
//
// Committed cases: fixtures/matches/cases.json (public classics). If
// fixtures/private/match-cases.json exists (gitignored; the owner's real titles, with
// responses saved under fixtures/private/sources/), it is reported too, separately.
import { reportRatingChanges } from './ratingComparison.ts';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateMatchCases } from '../server/src/identify/matchReport.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

function report(label: string, casesFile: string, responsesDir: string): boolean {
  const r = evaluateMatchCases(casesFile, responsesDir);
  const { bands } = r;
  const matched = r.total - bands.tie - bands.unidentified;
  console.log(`\n${label}: ${r.total} labelled examples`);
  console.log(r.lines.join('\n'));
  console.log(
    `\n  Bands: ${bands.accepted} accepted · ${bands.provisional} provisional · ${bands.tie} tied · ${bands.unidentified} unidentified`,
  );
  console.log(
    `  Correct: ${r.right} of ${r.total}. Precision of matches made: ${matched ? `${Math.round(((matched - r.wrong) / matched) * 100)}%` : '–'} (${r.wrong} wrong).`,
  );
  console.log(`  Wrong HIGH-confidence matches: ${r.wrongHigh}   ← the number that matters`);
  console.log(`  Held-out examples correct: ${r.heldRight} of ${r.heldTotal}.`);
  console.log(`  Missed (left unidentified though a right answer existed): ${r.missed}.`);
  return r.wrongHigh === 0;
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
