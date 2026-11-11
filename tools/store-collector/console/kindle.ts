// whatBooksNext Kindle collector (console script). Paste it into the browser's console on
// https://read.amazon.com/kindle-library while signed in. Read-only and slow; see
// docs/plans/get-store-purchase-imports.md. Built by `npm run build:collector`.
import { kindle } from '../adapters/kindle.ts';
import { runInPage } from './run.ts';

void runInPage(kindle);
