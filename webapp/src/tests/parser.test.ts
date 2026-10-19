import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseHtmlExport, parseHtmlExportFiles } from '../parser/htmlExport';
import { parseClassifierJson } from '../parser/classifierJson';
import { extractEntities } from '../parser/entities';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(resolve(__dirname, 'fixtures/sample-export.html'), 'utf8');

describe('parseHtmlExport', () => {
  it('extracts both tweets from a well-formed export', () => {
    const { tweets, errors } = parseHtmlExport(fixture);
    expect(errors).toEqual([]);
    expect(tweets).toHaveLength(2);
    expect(tweets[0]).toMatchObject({
      id: '1000000000000000001',
      handle: 'alice_eth',
      hasVideo: false,
      likeCount: 42,
    });
    expect(tweets[1].hasVideo).toBe(true);
  });

  it('returns an error when no tweetsData block is present', () => {
    const { tweets, errors } = parseHtmlExport('<html><body>no data</body></html>');
    expect(tweets).toEqual([]);
    expect(errors[0].reason).toMatch(/No tweetsData/);
  });

  it('reports per-tweet errors but keeps valid tweets', () => {
    const html = `<script>const tweetsData = [${JSON.stringify({ id: 'ok', timestamp: '2024-01-01T00:00:00Z', text: 't' })}, ${JSON.stringify({ text: 'no id' })}];</script>`;
    const { tweets, errors } = parseHtmlExport(html);
    expect(tweets).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toMatch(/missing id/);
  });

  it('preserves source_file across multiple files', () => {
    const { tweets } = parseHtmlExportFiles([
      { name: 'a.html', html: fixture },
      { name: 'b.html', html: fixture },
    ]);
    expect(tweets).toHaveLength(4);
    expect(tweets[0].source_file).toBe('a.html');
    expect(tweets[2].source_file).toBe('b.html');
  });

  it('tolerates arrays embedded with nested brackets', () => {
    const weird = `<script>const tweetsData = [{"id":"x","text":"[a] [b]","timestamp":"2024-01-01T00:00:00Z"}];</script>`;
    const { tweets, errors } = parseHtmlExport(weird);
    expect(errors).toEqual([]);
    expect(tweets[0].text).toBe('[a] [b]');
  });

  it('leaves isArticle undefined on legacy exports and parses it on v1.1+ exports', () => {
    const legacy = `<script>const tweetsData = [{"id":"1","timestamp":"2024-01-01T00:00:00Z"}];</script>`;
    const { tweets: legacyTweets } = parseHtmlExport(legacy);
    expect(legacyTweets[0].isArticle).toBeUndefined();
    expect(legacyTweets[0].articleTitle).toBeUndefined();

    const modern = `<script>const tweetsData = [
      {"id":"2","timestamp":"2024-01-01T00:00:00Z","isArticle":true,"articleTitle":"The Zenith Playbook"},
      {"id":"3","timestamp":"2024-01-01T00:00:00Z","isArticle":false,"articleTitle":""}
    ];</script>`;
    const { tweets, errors } = parseHtmlExport(modern);
    expect(errors).toEqual([]);
    expect(tweets[0].isArticle).toBe(true);
    expect(tweets[0].articleTitle).toBe('The Zenith Playbook');
    expect(tweets[1].isArticle).toBe(false);
    // empty-string titles normalize to undefined (unknown), not "".
    expect(tweets[1].articleTitle).toBeUndefined();
  });
});

describe('parseClassifierJson', () => {
  it('pulls tweet IDs and category assignments', () => {
    const json = JSON.stringify({
      tweets: [
        { id: '1', categories: ['Crypto > AI', 'Trading > Quantitative'] },
        { id: '2', categories: ['Crypto > AI'] },
      ],
    });
    const { tweets, categories, errors } = parseClassifierJson(json);
    expect(errors).toEqual([]);
    expect(tweets).toHaveLength(2);
    expect(categories.sort()).toEqual(['Crypto > AI', 'Trading > Quantitative']);
  });

  it('errors on invalid JSON', () => {
    const { errors } = parseClassifierJson('not json');
    expect(errors[0].reason).toMatch(/Invalid JSON/);
  });

  it('errors if tweets array is missing', () => {
    const { errors } = parseClassifierJson('{}');
    expect(errors[0].reason).toMatch(/tweets/);
  });

  it('parses article flags, treating JSON null as unknown (undefined)', () => {
    const json = JSON.stringify({
      tweets: [
        { id: '1', categories: [], is_article: true, article_title: 'The Zenith Playbook' },
        { id: '2', categories: [], is_article: false, article_title: null },
        { id: '3', categories: [], is_article: null, article_title: null },
        { id: '4', categories: [] },
      ],
    });
    const { tweets, errors } = parseClassifierJson(json);
    expect(errors).toEqual([]);
    expect(tweets[0].isArticle).toBe(true);
    expect(tweets[0].articleTitle).toBe('The Zenith Playbook');
    expect(tweets[1].isArticle).toBe(false);
    expect(tweets[1].articleTitle).toBeUndefined();
    // Both JSON null and a missing key mean "unknown" for legacy runs.
    expect(tweets[2].isArticle).toBeUndefined();
    expect(tweets[3].isArticle).toBeUndefined();
  });
});

describe('extractEntities', () => {
  it('extracts tickers, hashtags, and mentions', () => {
    const { tickers, hashtags, mentions } = extractEntities(
      'Just bought some $BTC and $ETH. #crypto is wild, @bob agrees! #CRYPTO',
    );
    expect(tickers.sort()).toEqual(['BTC', 'ETH']);
    expect(hashtags).toEqual(['crypto']); // case-insensitive dedup
    expect(mentions).toEqual(['bob']);
  });

  it('filters dollar-amounts from tickers via the 2–6 char rule + ignore list', () => {
    const { tickers } = extractEntities('Cost $5.50 or $USD or $A one letter');
    // $5.50 fails the letter rule; $USD is in the ignore list; $A is only 1 char.
    expect(tickers).toEqual([]);
  });

  it('does not pull mentions out of email addresses', () => {
    const { mentions } = extractEntities('email me at alice@example.com or @bob');
    expect(mentions).toEqual(['bob']);
  });

  it('does not pull hashtags out of HTML entities', () => {
    const { hashtags } = extractEntities('nbsp &#123; and #real');
    expect(hashtags).toEqual(['real']);
  });
});
