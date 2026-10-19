// Article-flag semantics across both import paths (HTML export and classifier
// JSON). The tri-state contract: NULL = unknown (legacy data), 0 = known
// non-article, 1 = known article. An unknown incoming value must never
// overwrite a known flag, and a known incoming value always wins over unknown.
// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../db/sqlite';
import { importHtmlTweets, importClassifierTweets, listTweetsPage } from '../db/queries/tweets';
import { emptyFilterSet } from '../filters/types';
import type { RawTweet } from '../parser/htmlExport';
import type { ClassifierTweet } from '../parser/classifierJson';

const __dirname = dirname(fileURLToPath(import.meta.url));
let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: () =>
      resolve(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
  });
});

function freshDb(): Database {
  const db = new SQL.Database();
  applyMigrations(db);
  return db;
}

function htmlTweet(over: Partial<RawTweet> & { id: string }): RawTweet & { source_file: string } {
  return {
    username: 'Alice',
    handle: 'alice',
    text: 'hello',
    link: `https://x.com/alice/status/${over.id}`,
    timestamp: '2024-01-01T00:00:00.000Z',
    date: 'Jan 1, 2024',
    images: null,
    hasVideo: false,
    likeCount: 1,
    retweetCount: 0,
    ...over,
    source_file: 'test.html',
  };
}

function clfTweet(over: Partial<ClassifierTweet> & { id: string }): ClassifierTweet {
  return {
    categories: [],
    author: 'Alice',
    handle: '@alice',
    text: 'hello',
    timestamp: 'Jan 1, 2024',
    images: [],
    hasVideo: false,
    likeCount: 1,
    retweetCount: 0,
    ...over,
  };
}

function flagRow(db: Database, id: string): { is_article: number | null; article_title: string | null } {
  const r = db.exec('SELECT is_article, article_title FROM tweets WHERE id = ?', [id]);
  const v = r[0]?.values[0] as [number | null, string | null] | undefined;
  if (!v) throw new Error(`no row for ${id}`);
  return { is_article: v[0], article_title: v[1] };
}

describe('importHtmlTweets article flags', () => {
  it('stores is_article=1 and the title for article tweets', () => {
    const db = freshDb();
    importHtmlTweets(db, [
      htmlTweet({ id: '1', text: '', isArticle: true, articleTitle: 'The Zenith Playbook' }),
    ]);
    expect(flagRow(db, '1')).toEqual({ is_article: 1, article_title: 'The Zenith Playbook' });
    db.close();
  });

  it('inserts NULL (unknown) for legacy exports lacking the field', () => {
    const db = freshDb();
    importHtmlTweets(db, [htmlTweet({ id: '1' })]);
    expect(flagRow(db, '1')).toEqual({ is_article: null, article_title: null });
    db.close();
  });

  it('preserves a known flag when a legacy (unknown) export is re-imported', () => {
    const db = freshDb();
    importHtmlTweets(db, [
      htmlTweet({ id: '1', text: '', isArticle: true, articleTitle: 'The Zenith Playbook' }),
    ]);
    // A stale export from extension v1.0 re-imported later must not clear it.
    importHtmlTweets(db, [htmlTweet({ id: '1', text: '', likeCount: 99 })]);
    expect(flagRow(db, '1')).toEqual({ is_article: 1, article_title: 'The Zenith Playbook' });
    db.close();
  });

  it('lets a known non-article (0) from a newer export override an older flag', () => {
    const db = freshDb();
    importHtmlTweets(db, [
      htmlTweet({ id: '1', text: '', isArticle: true, articleTitle: 'The Zenith Playbook' }),
    ]);
    importHtmlTweets(db, [htmlTweet({ id: '1', text: '', isArticle: false })]);
    expect(flagRow(db, '1').is_article).toBe(0);
    db.close();
  });
});

describe('importClassifierTweets article flags', () => {
  it('inserts article fields from article-aware classifier JSON', () => {
    const db = freshDb();
    importClassifierTweets(db, [
      clfTweet({ id: '1', text: '', isArticle: true, articleTitle: 'The Zenith Playbook' }),
    ]);
    expect(flagRow(db, '1')).toEqual({ is_article: 1, article_title: 'The Zenith Playbook' });
    db.close();
  });

  it('refresh sets a known flag on an existing unknown row', () => {
    const db = freshDb();
    importClassifierTweets(db, [clfTweet({ id: '1' })]); // legacy JSON: NULL
    expect(flagRow(db, '1').is_article).toBe(null);
    importClassifierTweets(db, [
      clfTweet({ id: '1', text: '', isArticle: true, articleTitle: 'The Zenith Playbook' }),
    ]);
    expect(flagRow(db, '1')).toEqual({ is_article: 1, article_title: 'The Zenith Playbook' });
    db.close();
  });

  it('refresh never clears a known flag when the JSON is legacy (unknown)', () => {
    const db = freshDb();
    importClassifierTweets(db, [
      clfTweet({ id: '1', text: '', isArticle: true, articleTitle: 'The Zenith Playbook' }),
    ]);
    importClassifierTweets(db, [clfTweet({ id: '1' })]);
    expect(flagRow(db, '1')).toEqual({ is_article: 1, article_title: 'The Zenith Playbook' });
    db.close();
  });
});

describe('listTweetsPage article filter', () => {
  it('returns only is_article = 1 rows, excluding both 0 and NULL', () => {
    const db = freshDb();
    importHtmlTweets(db, [
      htmlTweet({ id: '1', text: '', isArticle: true, articleTitle: 'The Zenith Playbook' }),
      htmlTweet({ id: '2', isArticle: false }),
      htmlTweet({ id: '3' }), // legacy unknown
    ]);
    const f = emptyFilterSet();
    f.article = true;
    const page = listTweetsPage(db, f, 1, 25, 'liked_desc');
    expect(page.total).toBe(1);
    expect(page.rows.map((r) => r.id)).toEqual(['1']);
    db.close();
  });
});
