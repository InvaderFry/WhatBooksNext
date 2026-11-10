import { compareRatings } from '../server/src/lib/ratingComparison.ts';
import { ratingCases } from '../server/src/testing/ratingCases.ts';
import { situation } from '../server/src/testing/rank.ts';

export function reportRatingChanges() {
  const result = compareRatings(ratingCases(), situation());
  console.log(
    '\nStage 1 before/after — invented rating fixtures only (title-free). For your own library,' +
      ' use Diagnostics → Compare with the old rating order.',
  );
  console.log(JSON.stringify(result, null, 2));
}
