// Unit tests for the two pure pieces of the extension: the page classifier
// (source.js) and the HTML export emitter (report.js).
//
//   node x-collector/test/units.mjs
//
// Both files are plain browser scripts, so they are loaded into a tiny vm
// sandbox rather than imported. No browser and no network needed; run.mjs
// covers the parts that need a real DOM.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, '..');

const sandbox = { URL, console, JSON, Date, Math, String, Number, Array, Object, RegExp, Set };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(path.join(ext, 'source.js'), 'utf8'), sandbox);
vm.runInContext(readFileSync(path.join(ext, 'report.js'), 'utf8'), sandbox);
vm.runInContext(readFileSync(path.join(ext, 'known.js'), 'utf8'), sandbox);

const {
  describeXSource, xSourceSignature, defaultFolderFor, buildReportHtml,
  xExtractExportIds, xExportSourceSignature, xKnownIdsFor, xMergeKnownIds, xKnownIndexSize, X_KNOWN_KEY,
} = sandbox;

let failures = 0;
let checks = 0;

function check(label, actual, expected) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures += 1;
    console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`);
  }
}

function ok(label, condition) {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.log(`  FAIL ${label}`);
  }
}

// ------------------------------------------------------------ content.js
// content.js is a browser IIFE, so lift extractAuthor and its helpers out of
// the source text and run them against a tiny fake DOM.
console.log('extractAuthor');
{
  const src = readFileSync(path.join(ext, 'content.js'), 'utf8');
  const start = src.indexOf('const HANDLE_RE');
  const end = src.indexOf('// Photos attached to THIS tweet');
  const fn = new Function('textWithEmoji', `${src.slice(start, end)}\nreturn extractAuthor;`);
  const extractAuthor = fn((el) => el.text);
  const link = (href, text, spans = []) => ({
    text,
    textContent: text,
    getAttribute: (n) => (n === 'href' ? href : null),
    querySelectorAll: () => spans.map((s) => ({ textContent: s })),
  });
  const article = (links) => ({
    querySelector: (sel) => (sel.includes('User-Name')
      ? { querySelectorAll: () => links, querySelector: () => links[0] || null }
      : null),
    querySelectorAll: () => links,
  });
  const evil = "@x');window.__p=1;//";
  check('href handle beats hostile display name',
    extractAuthor(article([link('/dummy', evil), link('/dummy', '@dummy')])),
    { username: '', handle: 'dummy' });
  check('hostile @text without a usable href is rejected',
    extractAuthor(article([link('', evil), link('', evil)])).handle, '');
  check('plain @text is accepted and the @ stripped',
    extractAuthor(article([link('', 'Dummy Name'), link('', '@dummy_1')])),
    { username: 'Dummy Name', handle: 'dummy_1' });
  check('16-char handle text is rejected',
    extractAuthor(article([link('', '@abcdefghijklmnop')])).handle, '');
}

// ---------------------------------------------------------------- source.js
console.log('describeXSource');

// [url, kind, slug, timeline]
const TABLE = [
  ['https://x.com/i/history/likes', 'likes', 'likes', true],
  ['https://x.com/i/history/likes/', 'likes', 'likes', true],
  ['https://twitter.com/i/history/likes', 'likes', 'likes', true],
  ['https://x.com/adafieldstone/likes', 'likes', 'likes-adafieldstone', true],
  ['https://x.com/i/bookmarks', 'bookmarks', 'bookmarks', true],
  ['https://x.com/i/bookmarks/1902384', 'bookmarks', 'bookmarks-1902384', true],
  ['https://x.com/home', 'home', 'home', true],
  ['https://x.com/', 'home', 'home', true],
  ['https://x.com/adafieldstone', 'profile', 'adafieldstone', true],
  ['https://x.com/adafieldstone/with_replies', 'profile-replies', 'adafieldstone-replies', true],
  ['https://x.com/adafieldstone/media', 'profile-media', 'adafieldstone-media', true],
  ['https://x.com/adafieldstone/highlights', 'profile-highlights', 'adafieldstone-highlights', true],
  ['https://x.com/adafieldstone/articles', 'profile-articles', 'adafieldstone-articles', true],
  ['https://x.com/search?q=agent%20memory&src=typed_query', 'search', 'search-agent-memory', true],
  ['https://x.com/search?q=%24NVDA+earnings&f=live', 'search', 'search-nvda-earnings', true],
  ['https://x.com/hashtag/AIagents?src=hashtag_click', 'search', 'hashtag-aiagents', true],
  ['https://x.com/i/lists/1493446837214187523', 'list', 'list-1493446837214187523', true],
  ['https://x.com/i/communities/1493446837214187523', 'community', 'community-1493446837214187523', true],
  ['https://x.com/i/topics/898661583827615744', 'topic', 'topic-898661583827615744', true],
  ['https://x.com/adafieldstone/status/1885026286349910084', 'thread', 'thread-adafieldstone-1885026286349910084', true],
  ['https://x.com/adafieldstone/status/1885026286349910084/quotes', 'quotes', 'quotes-1885026286349910084', true],
  ['https://x.com/explore', 'explore', 'explore', true],
  ['https://x.com/explore/tabs/for-you', 'explore', 'explore', true],
  ['https://x.com/notifications', 'notifications', 'notifications', true],
  ['https://x.com/notifications/mentions', 'notifications', 'mentions', true],
  // Pages that exist but list accounts or nothing collectable.
  ['https://x.com/adafieldstone/followers', 'unsupported', 'unsupported', false],
  ['https://x.com/adafieldstone/following', 'unsupported', 'unsupported', false],
  ['https://x.com/adafieldstone/status/188502628/likes', 'unsupported', 'unsupported', false],
  ['https://x.com/adafieldstone/status/188502628/retweets', 'unsupported', 'unsupported', false],
  ['https://x.com/messages/12345', 'unsupported', 'unsupported', false],
  ['https://x.com/settings/account', 'unsupported', 'unsupported', false],
  ['https://x.com/i/premium_sign_up', 'unsupported', 'unsupported', false],
  ['https://x.com/adafieldstone/photo', 'unsupported', 'unsupported', false],
  // Off X entirely.
  ['https://example.com/x.com/adafieldstone', 'not-x', 'unknown', false],
  ['file:///tmp/fake-timeline.html', 'not-x', 'unknown', false],
];

for (const [url, kind, slug, timeline] of TABLE) {
  const s = describeXSource(url);
  check(url, { kind: s.kind, slug: s.slug, timeline: s.timeline }, { kind, slug, timeline });
}

check('handle is extracted', describeXSource('https://x.com/adafieldstone/media').handle, 'adafieldstone');
check('query is extracted', describeXSource('https://x.com/search?q=rag').query, 'rag');
check('post id is extracted', describeXSource('https://x.com/a/status/42').id, '42');
ok('unsupported pages explain themselves', Boolean(describeXSource('https://x.com/adafieldstone/followers').reason));
ok('a bad address never throws', describeXSource('not a url').kind === 'not-x');
ok('subdomains of x.com count as X', describeXSource('https://mobile.x.com/home').kind === 'home');

console.log('xSourceSignature');
const sigA = xSourceSignature(describeXSource('https://x.com/adafieldstone'));
ok('same page, same signature', sigA === xSourceSignature(describeXSource('https://x.com/adafieldstone?foo=1')));
ok('different profile, different signature', sigA !== xSourceSignature(describeXSource('https://x.com/milo_bracken')));
ok('different tab of one profile differs', sigA !== xSourceSignature(describeXSource('https://x.com/adafieldstone/media')));

console.log('defaultFolderFor');
check('likes go to the pipeline folder', defaultFolderFor('likes'), 'trove');
check('profiles go to the same folder', defaultFolderFor('profile'), 'trove');
check('search goes to the same folder', defaultFolderFor('search'), 'trove');

// ---------------------------------------------------------------- report.js
console.log('buildReportHtml');

const tweets = [
  {
    id: '1000000000000000001',
    username: 'Andrej 🔥',
    handle: 'adafieldstone',
    // Both of these would break a naive embedder: "];" ends the JSON array in
    // the readers' regex, and "</script>" ends the block in the browser.
    text: 'memory is files; arr[0]; done ]; and </script> too <!--<script> 📈',
    link: 'https://x.com/adafieldstone/status/1000000000000000001',
    timestamp: '2026-03-31T12:00:00.000Z',
    date: 'Mar 31, 2026',
    images: ['https://pbs.twimg.com/media/abc?format=jpg&name=medium'],
    hasVideo: false,
    isArticle: true,
    articleTitle: 'On agent memory',
    likeCount: 5000,
    retweetCount: 200,
    sourceIndex: 0,
    likeIndex: 0,
  },
  {
    id: '1000000000000000002',
    username: 'Evil',
    handle: 'evil',
    text: '<img src=x onerror=alert(1)>',
    link: 'javascript:alert(document.domain)',
    timestamp: '2025-01-15T12:00:00.000Z',
    date: 'Jan 15, 2025',
    images: null,
    hasVideo: true,
    isArticle: false,
    articleTitle: '',
    likeCount: 1,
    retweetCount: 0,
    sourceIndex: 1,
    likeIndex: 1,
  },
];

const meta = {
  version: '2.0.0',
  collectedAt: '2026-09-15T10:00:00.000Z',
  count: 2,
  source: describeXSource('https://x.com/adafieldstone/with_replies'),
};
const html = buildReportHtml(tweets, meta);

// The contract the v2 parser and parse_and_classify.py both rely on.
const TWEETS_DATA_RE = /const tweetsData = (\[[\s\S]*?\]);/;
const m = html.match(TWEETS_DATA_RE);
ok('tweetsData block is findable', Boolean(m));
let parsed = [];
if (m) {
  parsed = JSON.parse(m[1]);
  check('every post survives the round trip', parsed.length, tweets.length);
  check('text with "];", "</script>" and "<!--" is intact', parsed[1].text, tweets[0].text);
  check('timeline position survives', [parsed[0].sourceIndex, parsed[1].sourceIndex], [1, 0]);
}

// The new meta block must not be mistaken for the tweets block.
const metaMatch = html.match(/const collectionMeta = (\{[\s\S]*?\});/);
ok('collectionMeta block is findable', Boolean(metaMatch));
if (metaMatch) {
  const parsedMeta = JSON.parse(metaMatch[1]);
  check('meta names the source', parsedMeta.source.kind, 'profile-replies');
  check('meta names the generator', parsedMeta.generator, 'X Collector');
  check('meta counts the posts', parsedMeta.count, 2);
}
ok('meta comes after the posts block', html.indexOf('const collectionMeta') > html.indexOf('const tweetsData'));

// Markup contract: the classes parse_and_classify.py reads off each card.
for (const cls of ['tweet-card', 'tweet-author', 'tweet-text', 'tweet-date', 'tweet-images', 'video-indicator', 'article-indicator', 'article-title']) {
  ok(`.${cls} is emitted`, html.includes(`class="${cls}`) || html.includes(`class="${cls} `));
}

// Source labelling.
ok('the heading names the source', html.includes('@adafieldstone · posts and replies'));
ok('the sort option is not "like order" off a profile', html.includes('Timeline order'));
ok('a likes export still says like order', buildReportHtml(tweets, { source: describeXSource('https://x.com/i/history/likes') }).includes('Like order'));
ok('no-meta callers still get a valid page', buildReportHtml(tweets).includes('X Posts'));

// Escaping. Post text reaches the page twice: as HTML inside a card, where it
// must be entity-escaped, and as a JS string inside the <script> block, where
// it must not be able to end the element or the array literal.
const scriptStart = html.indexOf('<script>');
const cardMarkup = html.slice(0, scriptStart);
const scriptBlock = html.slice(scriptStart);

ok('the card escapes raw markup', cardMarkup.includes('&lt;img src=x onerror') && !cardMarkup.includes('<img src=x onerror'));
ok('a javascript: link is neutralised', !html.includes('href="javascript:'));
ok('post text cannot close the script element', !scriptBlock.includes('</script> too'));
ok('post text cannot open the double-escaped script state', !scriptBlock.includes('<!--<script>'));
ok('the escapes are reversible', parsed[1].text.includes('</script> too <!--<script>'));

// ---------------------------------------------------------------- known.js
// The already-collected index: reading ids back out of an old export, working
// out which timeline it came from, and merging ids per source.
console.log('already-collected index');

const likesSig = xSourceSignature({ kind: 'likes' });
const profileSig = xSourceSignature({ kind: 'profile', handle: 'adafieldstone' });

const exportIds = xExtractExportIds(html);
check('every exported id is read back', exportIds.sort(), tweets.map((t) => t.id).sort());
ok('an empty document yields no ids', xExtractExportIds('<html></html>').length === 0);
check(
  'card-only exports fall back to hrefs',
  xExtractExportIds('<a href="https://x.com/a/status/123">x</a><a href="https://x.com/b/status/456?s=20">y</a>').sort(),
  ['123', '456']
);
check('a junk tweetsData block falls back to hrefs', xExtractExportIds('const tweetsData = [oops]; <a href="/a/status/77">x</a>').sort(), ['77']);

check('an export names its own timeline', xExportSourceSignature(html), xSourceSignature(meta.source));
check('a legacy export counts as Likes', xExportSourceSignature('<html>no meta here</html>'), likesSig);
check('a broken meta block still counts as Likes', xExportSourceSignature('const collectionMeta = {oops};'), likesSig);
check('the likes signature is the one the engine builds', likesSig, 'likes|||');

let index = {};
index = xMergeKnownIds(index, likesSig, ['1', '2', '2', '']);
check('merging dedupes', xKnownIdsFor(index, likesSig), ['1', '2']);
index = xMergeKnownIds(index, profileSig, ['2', '3']);
check('another timeline keeps its own ids', xKnownIdsFor(index, likesSig), ['1', '2']);
check('the new timeline has its ids', xKnownIdsFor(index, profileSig), ['2', '3']);
check('index size spans every timeline', xKnownIndexSize(index), 4);
check('an unseen timeline has nothing', xKnownIdsFor(index, 'search|rag||'), []);
check('index key is the documented storage key', X_KNOWN_KEY, 'xlcKnownIds');

const empty = {};
const seeded = xMergeKnownIds(empty, likesSig, ['7']);
xMergeKnownIds(seeded, profileSig, ['8']);
ok('merging returns a new index instead of mutating', Object.keys(empty).length === 0 && Object.keys(seeded).length === 1);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log('FAIL');
  process.exit(1);
}
console.log('PASS');
