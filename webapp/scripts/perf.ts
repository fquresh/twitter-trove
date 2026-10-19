// Quick perf measurement against the seed fixture. Runs the same query
// builders the app uses, so the numbers reflect real shape (param binding,
// JOINs, EXISTS subqueries, FTS MATCH).
//
// Usage: `npx tsx scripts/perf.ts`. Run `npm run seed` first.

import initSqlJs from 'sql.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INITIAL_SCHEMA } from '../src/db/schema';
import { parseHtmlExport } from '../src/parser/htmlExport';
import { parseClassifierJson } from '../src/parser/classifierJson';
import { importHtmlTweets } from '../src/db/queries/tweets';
import { replaceClassifierAssignments } from '../src/db/queries/categories';
import { listTweetsPage } from '../src/db/queries/tweets';
import {
  timeSeries,
  categoryBreakdown,
  topAccounts,
  entityTrends,
} from '../src/db/queries/analytics';
import { emptyFilterSet } from '../src/filters/types';

const __dirname = dirname(fileURLToPath(import.meta.url));

function ms(t0: number): string {
  const d = performance.now() - t0;
  return `${d.toFixed(1)} ms`;
}

async function main() {
  console.log('Loading sql.js…');
  const SQL = await initSqlJs({
    locateFile: () =>
      resolve(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
  });

  const initT0 = performance.now();
  const db = new SQL.Database();
  for (const stmt of INITIAL_SCHEMA) db.exec(stmt);
  console.log(`Init + schema migrate: ${ms(initT0)}`);

  console.log('Reading seed…');
  const html = readFileSync(resolve(__dirname, '..', 'public', 'seed', 'tweets.html'), 'utf-8');
  const json = readFileSync(resolve(__dirname, '..', 'public', 'seed', 'classifier.json'), 'utf-8');

  const parseT0 = performance.now();
  const parsed = parseHtmlExport(html);
  console.log(`Parse HTML (${parsed.tweets.length} tweets): ${ms(parseT0)}`);

  const importT0 = performance.now();
  const summary = importHtmlTweets(
    db,
    parsed.tweets.map((t) => ({ ...t, source_file: 'seed.html' })),
  );
  console.log(`Import (insert + FTS sync): ${ms(importT0)} - inserted ${summary.inserted}`);

  const cT0 = performance.now();
  const classifier = parseClassifierJson(json);
  replaceClassifierAssignments(
    db,
    classifier.tweets.map((t) => ({ tweetId: t.id, categories: t.categories })),
  );
  console.log(`Classifier link (${classifier.tweets.length}): ${ms(cT0)}`);

  const filters = emptyFilterSet();

  // Empty-filter list page.
  let t0 = performance.now();
  listTweetsPage(db, filters, 1, 50, 'liked_desc');
  console.log(`listTweetsPage (empty, 50 rows): ${ms(t0)}`);

  // FTS query.
  filters.q = 'compute';
  t0 = performance.now();
  listTweetsPage(db, filters, 1, 50, 'liked_desc');
  console.log(`listTweetsPage (q="compute"): ${ms(t0)}`);
  filters.q = null;

  // Dashboard panels.
  t0 = performance.now();
  const ts = timeSeries(db, filters);
  console.log(`timeSeries (month, ${ts.length} buckets): ${ms(t0)}`);

  t0 = performance.now();
  categoryBreakdown(db, filters, 20);
  console.log(`categoryBreakdown: ${ms(t0)}`);

  t0 = performance.now();
  topAccounts(db, filters, 15);
  console.log(`topAccounts: ${ms(t0)}`);

  t0 = performance.now();
  entityTrends(db, filters, 'ticker', 8);
  console.log(`entityTrends (ticker, top 8): ${ms(t0)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
