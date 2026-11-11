// whatBooksNext GlobalComix collector (console script). Paste it into the browser's console on
// https://globalcomix.com/my-shelf/purchases while signed in. It asks for the same purchases list
// that page loads, a page at a time, and changes nothing. See
// docs/plans/get-store-purchase-imports.md.
import { globalcomix } from '../adapters/globalcomix.ts';
import { runRequestScan } from './run.ts';

void runRequestScan(globalcomix);
