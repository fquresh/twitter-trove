// Every handle on the demo List Accounts page must be a fictional seed account.
// A real handle here would leak whom the author follows.
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIST_ACCOUNTS, LIST_NAMES } from '../lib/listAccounts';

const webapp = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// scripts/seed.ts writes the seed files when it runs, so read its AUTHORS
// block as text instead of importing it.
const seedSource = readFileSync(resolve(webapp, 'scripts/seed.ts'), 'utf8');
const authorsBlock = /const AUTHORS = \[([\s\S]*?)\n\];/.exec(seedSource)?.[1] ?? '';
const SEED_HANDLES = new Set([...authorsBlock.matchAll(/handle: '([^']+)'/g)].map((m) => m[1]!));

const seedHtml = readFileSync(resolve(webapp, 'public/seed/tweets.html'), 'utf8');

describe('listAccounts demo data', () => {
  it('reads the seed author pool', () => {
    expect(SEED_HANDLES.size).toBeGreaterThanOrEqual(LIST_ACCOUNTS.length);
  });

  it('uses only handles from the seed pool', () => {
    const outside = LIST_ACCOUNTS.map((a) => a.handle.replace(/^@/, '')).filter((h) => !SEED_HANDLES.has(h));
    expect(outside).toEqual([]);
  });

  it('uses only handles that appear in the generated seed', () => {
    const missing = LIST_ACCOUNTS.map((a) => a.handle.replace(/^@/, '')).filter(
      (h) => !seedHtml.includes(`"handle":"${h}"`),
    );
    expect(missing).toEqual([]);
  });

  it('uses only the declared list names', () => {
    for (const a of LIST_ACCOUNTS) for (const l of a.lists) expect(LIST_NAMES).toContain(l);
  });
});
