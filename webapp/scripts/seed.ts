// Generates ~5000 synthetic tweets as a deterministic fixture for dev/demo.
//
// Emits two files in ./public/seed/ (served at /seed/ by Vite):
//   - tweets.html — the extension's HTML export shape (script block with
//                   `const tweetsData = [...]`)
//   - classifier.json — the Python classifier's JSON shape
//
// Usage: `npm run seed`. The app's Import route can then drag-drop the two.
//
// Determinism: we seed a mulberry32 PRNG so repeated runs produce identical
// fixtures, which keeps Playwright output stable.

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public', 'seed');

const SEED = 0xc0ffee;
const TWEET_COUNT = 5000;
// 4 years of history ending a few days before "today" (the seed's reference
// date — not the wall clock, so the fixture is stable).
const REFERENCE_DATE_MS = Date.UTC(2026, 3, 1); // 2026-04-01
const RANGE_SEC = 60 * 60 * 24 * 365 * 4;

function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
const chance = (p: number) => rand() < p;

// A long-tail distribution where most tweets have modest engagement but a few
// go viral. Draws from Math.pow-biased random.
function engagement(base = 0): number {
  const raw = Math.pow(rand(), 4) * 50_000;
  return Math.max(0, Math.floor(raw + base));
}

// Every author is fictional. Handles and names are invented for this demo
// fixture and do not refer to real people or companies.
const AUTHORS = [
  { handle: 'ada_fieldstone', name: 'Ada Fieldstone' },
  { handle: 'jhalvorsen', name: 'Juno Halvorsen' },
  { handle: 'milo_bracken', name: 'Milo Brackenridge' },
  { handle: 'tobias_quill', name: 'Tobias Quill' },
  { handle: 'orrin_vasquez', name: 'Orrin Vasquez' },
  { handle: 'wren_alderbrook', name: 'Wren Alderbrook' },
  { handle: 'cassius_thorne', name: 'Cassius Thorne' },
  { handle: 'imogen_falk', name: 'Imogen Falk' },
  { handle: 'rafe_okonjo', name: 'Rafe Okonjo' },
  { handle: 'selma_drakewood', name: 'Selma Drakewood' },
  { handle: 'bastian_crowe', name: 'Bastian Crowe' },
  { handle: 'nadia_vella', name: 'Nadia Vellacourt' },
  { handle: 'perrin_ashgrove', name: 'Perrin Ashgrove' },
  { handle: 'lio_marchetti', name: 'Lio Marchetti' },
  { handle: 'tamsin_reyes', name: 'Tamsin Reyes' },
  { handle: 'ezra_holloway', name: 'Ezra Holloway' },
  { handle: 'marisol_quaid', name: 'Marisol Quaid' },
  { handle: 'dorian_pell', name: 'Dorian Pell' },
  { handle: 'kasimir_lund', name: 'Kasimir Lund' },
  { handle: 'odette_bright', name: 'Odette Brightwater' },
  { handle: 'fen_harrowgate', name: 'Fen Harrowgate' },
  { handle: 'quillfeatherlab', name: 'Quillfeather Labs' },
  { handle: 'emberline_dev', name: 'Emberline' },
  { handle: 'northwind_stack', name: 'Northwind Stack' },
  { handle: 'ferrous_lang', name: 'Ferrous Lang' },
  { handle: 'gopherglade', name: 'Gopherglade' },
  { handle: 'typeforge_hq', name: 'Typeforge' },
  { handle: 'ines_carraway', name: 'Ines Carraway' },
  { handle: 'hollis_wexford', name: 'Hollis Wexford' },
  { handle: 'priya_stellmark', name: 'Priya Stellmark' },
  { handle: 'august_vane', name: 'August Vane' },
  { handle: 'lorcan_beddoes', name: 'Lorcan Beddoes' },
  { handle: 'mira_castellan', name: 'Mira Castellan' },
  { handle: 'osric_penhallow', name: 'Osric Penhallow' },
  { handle: 'paper_crane_jer', name: 'Jerry' },
  { handle: 'yara_whitlock', name: 'Yara Whitlock' },
  { handle: 'florent_ashby', name: 'Florent Ashby' },
  { handle: 'kestrel_ml', name: 'kestrel' },
  { handle: 'riley_tamber', name: 'Riley Tamberline' },
  { handle: 'esme_rowanberry', name: 'Esme Rowanberry' },
  { handle: 'mikael_sorrow', name: 'Mikael Sorrow' },
  { handle: 'elias_greywater', name: 'Elias Greywater' },
  { handle: 'noor_brightman', name: 'Noor Brightman' },
  { handle: 'jeff_dale_ml', name: 'Jefferson Dale' },
  { handle: 'dmitri_halcyon', name: 'Dmitri Halcyon' },
  { handle: 'lanternmind_ai', name: 'Lanternmind AI' },
  { handle: 'openhollow_ai', name: 'OpenHollow' },
  { handle: 'deepfathom_lab', name: 'DeepFathom' },
  { handle: 'jack_morrow_sf', name: 'Jack Morrow' },
  { handle: 'nabil_quarry', name: 'Nabil Quarry' },
];

const CATEGORIES = [
  'AI > LLMs > Training',
  'AI > LLMs > Inference',
  'AI > Agents',
  'AI > Research',
  'AI > Safety',
  'AI > Products',
  'Crypto > DeFi',
  'Crypto > Markets',
  'Crypto > L2s',
  'Startups > Fundraising',
  'Startups > Hiring',
  'Startups > Growth',
  'Tech > Frontend',
  'Tech > Backend',
  'Tech > DevTools',
  'Tech > Databases',
  'Finance > Macro',
  'Finance > Equities',
  'Meta > Twitter',
  'Meta > Community',
];

const TICKERS = ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'GOOGL', 'META', 'AMZN', 'COIN', 'PLTR', 'AMD', 'ARM', 'NET', 'SNOW'];
const CRYPTO = ['BTC', 'ETH', 'SOL', 'ARB', 'OP'];
const HASHTAGS = ['#buildinpublic', '#ai', '#llm', '#startup', '#devtools', '#tailwind', '#react', '#rust', '#webdev', '#opensource'];

// Tweet text templates. Placeholders:
//   {{ticker}} — random equity ticker (prefixed $)
//   {{crypto}} — random crypto ticker (prefixed $)
//   {{hashtag}} — random hashtag
//   {{mention}} — random @mention
//   {{num}} — a small number
const TEMPLATES = [
  "the real bottleneck on {{topic}} isn't compute, it's data curation. wrote about this recently",
  "hot take: in 2-3 years every {{tool}} will have an LLM built in by default",
  "spent the weekend shipping a prototype with {{mention}} — {{topic}} is more tractable than I thought",
  "{{ticker}} up {{num}}% today and nobody is talking about it. that's when I get interested",
  "the {{topic}} thesis is basically: {{hashtag}} works for the same reason {{tool}} worked",
  "reminder that {{crypto}} was below $100 not that long ago. the power laws compound",
  "if you're building in {{topic}} and you haven't read the {{mention}} paper, you're flying blind",
  "three things I changed my mind about in 2025:\n1) {{topic}} is a feature, not a product\n2) agents need scaffolding, not scale\n3) {{tool}} was right all along",
  "this is the {{topic}} equivalent of 'the turboencabulator' and I love it {{hashtag}}",
  "just realized {{ticker}} and {{crypto}} are now correlated .8. feels like the 2017 telco/cable moment",
  "I've been using {{tool}} for a month and it's genuinely the best DX I've had since {{mention}}'s work on {{topic}}",
  "unpopular opinion: {{hashtag}} is just a rebrand of what we called 'software' five years ago",
  "{{num}} things nobody tells you about building with LLMs:\n- latency is the hardest part\n- eval is harder than prompting\n- users want determinism",
  "if {{topic}} is so great, why is nobody shipping it? maybe because it's fake",
  "the difference between {{tool}} and its competitors is distribution. the tech is {{num}}%; the channel is everything",
];

const THREAD_TEMPLATES = [
  "ok I want to write out where I actually land on {{topic}}, because I've been flip-flopping",
  "first: the base rate for {{tool}} shipping before the next {{topic}} cycle is low",
  "second: I don't trust anyone's timeline on this, including mine",
  "third: the {{mention}} argument relies on an assumption about {{topic}} that I think is load-bearing",
  "fourth: watch {{ticker}} for the revealed preference. if it breaks out, the thesis works",
  "finally: there's a 30% world where I'm wrong about all of this and {{crypto}} eats the category. hedge accordingly",
];

const TOPICS = ['AI agents', 'AI safety', 'Web3', 'devtools', 'serverless', 'edge compute', 'rust', 'golang', 'typescript', 'LLM fine-tuning', 'vector DBs', 'RAG', 'neural search'];
const TOOLS = ['Vite', 'Bun', 'Next.js', 'Deno', 'Cursor', 'Claude Code', 'Cline', 'Linear', 'Vercel', 'Supabase', 'Cloudflare Workers'];

// X long-form article titles. Article posts scrape with EMPTY text (the body
// lives behind the article view); the card contributes only a title + cover.
const ARTICLE_TEMPLATES = [
  'The {{topic}} handbook: {{num}} lessons learned the hard way',
  'My {{topic}} thesis: why {{tool}} changes everything',
  '{{num}} mental models for {{topic}}',
  'What nobody tells you about {{topic}}',
  '{{topic}} in 2026: a field guide',
];

function fill(template: string, authors: typeof AUTHORS): string {
  return template
    .replace(/{{ticker}}/g, () => '$' + pick(TICKERS))
    .replace(/{{crypto}}/g, () => '$' + pick(CRYPTO))
    .replace(/{{hashtag}}/g, () => pick(HASHTAGS))
    .replace(/{{mention}}/g, () => '@' + pick(authors).handle)
    .replace(/{{topic}}/g, () => pick(TOPICS))
    .replace(/{{tool}}/g, () => pick(TOOLS))
    .replace(/{{num}}/g, () => String(Math.floor(rand() * 80) + 5));
}

interface GenTweet {
  id: string;
  username: string;
  handle: string;
  text: string;
  link: string;
  timestamp: string;
  date: string;
  images: string[] | null;
  hasVideo: boolean;
  isArticle: boolean;
  articleTitle?: string;
  likeCount: number;
  retweetCount: number;
  categories: string[];
}

function randomCategories(): string[] {
  // Power-law: most tweets 1 category, some 2, few 0 (classifier skipped).
  const r = rand();
  if (r < 0.08) return [];
  if (r < 0.7) return [pick(CATEGORIES)];
  const a = pick(CATEGORIES);
  let b = pick(CATEGORIES);
  while (b === a) b = pick(CATEGORIES);
  return [a, b];
}

function formatReadableDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function generate(): GenTweet[] {
  const tweets: GenTweet[] = [];
  const endSec = Math.floor(REFERENCE_DATE_MS / 1000);
  const startSec = endSec - RANGE_SEC;

  let i = 0;
  while (tweets.length < TWEET_COUNT) {
    const isThread = chance(0.06);
    const threadLen = isThread ? 2 + Math.floor(rand() * 4) : 1;
    const author = pick(AUTHORS);
    const baseSec = startSec + Math.floor(rand() * (endSec - startSec));

    for (let j = 0; j < threadLen && tweets.length < TWEET_COUNT; j++) {
      const unixSec = baseSec + j * (60 + Math.floor(rand() * 600)); // threads within ~10 min
      const id = `${1800000000000000000n + BigInt(i)}`;
      // ~1.5% of standalone tweets are X long-form articles (never threads).
      const isArticle = !isThread && j === 0 && chance(0.015);
      const template = isThread
        ? THREAD_TEMPLATES[Math.min(j, THREAD_TEMPLATES.length - 1)]!
        : pick(TEMPLATES);
      const text = isArticle ? '' : fill(template, AUTHORS);
      const hasImages = isArticle || chance(0.18); // articles carry a cover image
      const hasVideo = !hasImages && chance(0.05);
      const imageCount = isArticle ? 1 : hasImages ? 1 + Math.floor(rand() * 3) : 0;

      tweets.push({
        id,
        username: author.name,
        handle: author.handle,
        text,
        link: `https://x.com/${author.handle}/status/${id}`,
        timestamp: new Date(unixSec * 1000).toISOString(),
        date: formatReadableDate(unixSec),
        images: hasImages
          ? Array.from({ length: imageCount }, (_, k) => `https://pbs.twimg.com/media/stub${id}_${k}?format=jpg`)
          : null,
        hasVideo,
        isArticle,
        ...(isArticle ? { articleTitle: fill(pick(ARTICLE_TEMPLATES), AUTHORS) } : {}),
        likeCount: engagement(),
        retweetCount: Math.floor(engagement() / 6),
        categories: randomCategories(),
      });
      i++;
    }
  }
  return tweets;
}

function writeHtml(tweets: GenTweet[]): string {
  // Mirror the shape the extension emits: arbitrary wrapper, but a <script>
  // block carrying `const tweetsData = [...]`. We strip categories from the
  // HTML payload (categories belong in the classifier JSON — the extension
  // doesn't know about them).
  const stripped = tweets.map(({ categories: _c, ...rest }) => rest);
  const json = JSON.stringify(stripped);
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Trove seed fixture - ${tweets.length} tweets</title></head>
  <body>
    <script>
    const tweetsData = ${json};
    </script>
  </body>
</html>
`;
}

// ── Enriched-export seed (Phase 5 fixture) ─────────────────────────────────
//
// Mirrors the production packing in enrich.py:
//   - 1024-dim float32, L2-normalized, int8-quantized (per-vector scale,
//     offset=0). The web worker's dequant code reads `f = b * scale` and
//     expects to recover the original direction with cosine ≥ 0.998.
//   - Per-category mean-shift means tweets sharing categories cluster, so
//     hybrid retrieval tests in Phase 6 can assert RRF actually surfaces
//     same-category neighbors.
//   - Tweet ids in enriched.json match those emitted into tweets.html; the
//     v2 importer joins on id when upserting.

const SEED_EMBED_MODEL = 'voyage-3-large';
const SEED_EMBED_DIM = 1024;
const SEED_VISION_MODEL = 'claude-haiku-4-5';
const SEED_NOISE_LEVEL = 0.4;

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h * 31 + s.charCodeAt(i)) | 0) >>> 0;
  return h >>> 0;
}

const categoryCenters = new Map<string, Float32Array>();
function categoryCenter(cat: string): Float32Array {
  const cached = categoryCenters.get(cat);
  if (cached) return cached;
  const r = mulberry32(hashStr('center:' + cat) ^ 0xdeadbeef);
  const v = new Float32Array(SEED_EMBED_DIM);
  for (let i = 0; i < SEED_EMBED_DIM; i++) v[i] = r() * 2 - 1;
  let n = 0;
  for (let i = 0; i < SEED_EMBED_DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < SEED_EMBED_DIM; i++) v[i] /= n;
  categoryCenters.set(cat, v);
  return v;
}

function tweetVector(tweetId: string, categories: string[]): Float32Array {
  const v = new Float32Array(SEED_EMBED_DIM);
  if (categories.length > 0) {
    for (const c of categories) {
      const cv = categoryCenter(c);
      for (let i = 0; i < SEED_EMBED_DIM; i++) v[i] += cv[i] / categories.length;
    }
  }
  // Tweet-specific noise so two tweets in the same category aren't identical.
  const r = mulberry32(hashStr('vec:' + tweetId));
  for (let i = 0; i < SEED_EMBED_DIM; i++) {
    const u1 = Math.max(r(), 1e-12);
    const u2 = r();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    v[i] += g * SEED_NOISE_LEVEL;
  }
  return v;
}

function quantizeInt8(v: Float32Array): { bytes: Uint8Array; scale: number; offset: number } {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  let absMax = 0;
  for (let i = 0; i < v.length; i++) {
    const a = Math.abs(v[i]);
    if (a > absMax) absMax = a;
  }
  if (absMax === 0) {
    return { bytes: new Uint8Array(v.length), scale: 0, offset: 0 };
  }
  const scale = absMax / 127;
  const bytes = new Uint8Array(v.length);
  const view = new Int8Array(bytes.buffer);
  for (let i = 0; i < v.length; i++) {
    const rounded = Math.round(v[i] / scale);
    view[i] = Math.max(-127, Math.min(127, rounded));
  }
  return { bytes, scale, offset: 0 };
}

function writeEnriched(tweets: GenTweet[]): string {
  const generatedAt = new Date(REFERENCE_DATE_MS).toISOString();

  const embeddings = tweets.map((t) => {
    const f = tweetVector(t.id, t.categories);
    const q = quantizeInt8(f);
    return {
      tweet_id: t.id,
      model: SEED_EMBED_MODEL,
      dim: SEED_EMBED_DIM,
      dtype: 'int8',
      scale: q.scale,
      offset: q.offset,
      vector_b64: Buffer.from(q.bytes).toString('base64'),
    };
  });

  // Image descriptions for every image-bearing tweet — keeps the seed honest
  // about typical coverage (~18% of seed tweets have images per `chance(0.18)`
  // in `generate()`).
  const imageEnrichments: Array<{
    tweet_id: string;
    source_ref: string;
    content: string;
    model: string;
    metadata: Record<string, unknown>;
  }> = [];
  for (const t of tweets) {
    if (!t.images) continue;
    for (let i = 0; i < t.images.length; i++) {
      imageEnrichments.push({
        tweet_id: t.id,
        source_ref: t.images[i]!,
        content: `A synthetic image for tweet ${t.id} by @${t.handle} (image ${i + 1} of ${t.images.length}). ` +
                 `Categories: ${t.categories.join(', ') || 'none'}. ` +
                 `Image is a deterministic seed-time placeholder.`,
        model: SEED_VISION_MODEL,
        metadata: { tokens: 220, input_tokens: 700, output_tokens: 120 },
      });
    }
  }

  // URL extractions for ~5% of tweets — the seed templates don't emit URLs
  // in tweet text, so attach synthetic ones here purely for import-path coverage.
  const urlEnrichments: Array<{
    tweet_id: string;
    source_ref: string;
    content: string;
    metadata: Record<string, unknown>;
  }> = [];
  const r = mulberry32(SEED ^ 0xa5a5);
  for (const t of tweets) {
    if (r() < 0.05) {
      const slug = t.id.slice(-8);
      urlEnrichments.push({
        tweet_id: t.id,
        source_ref: `https://example.com/seed/${slug}`,
        content: `Synthetic article tied to tweet ${t.id}. Topics: ${t.categories.join('; ') || 'general'}.`,
        metadata: { status: 'ok', fetched_at: Math.floor(REFERENCE_DATE_MS / 1000) },
      });
    }
  }

  const payload = {
    metadata: {
      embed_model: SEED_EMBED_MODEL,
      embed_dim: SEED_EMBED_DIM,
      embed_dtype: 'int8',
      vision_model: SEED_VISION_MODEL,
      generated_at: generatedAt,
      stats: {
        embeddings: embeddings.length,
        url_enrichments: urlEnrichments.length,
        image_enrichments: imageEnrichments.length,
      },
    },
    embeddings,
    url_enrichments: urlEnrichments,
    image_enrichments: imageEnrichments,
  };
  return JSON.stringify(payload);
}

function writeClassifier(tweets: GenTweet[]): string {
  const taxonomy: Record<string, { count: number; percentage: number }> = {};
  for (const t of tweets) {
    for (const c of t.categories) {
      taxonomy[c] ??= { count: 0, percentage: 0 };
      taxonomy[c].count++;
    }
  }
  const total = tweets.length;
  for (const k of Object.keys(taxonomy)) {
    taxonomy[k]!.percentage = Math.round((taxonomy[k]!.count / total) * 10000) / 100;
  }

  const payload = {
    metadata: {
      total_tweets: total,
      files_processed: 1,
      date_range: {
        earliest: tweets[tweets.length - 1]?.timestamp ?? null,
        latest: tweets[0]?.timestamp ?? null,
      },
      categories_discovered: Object.keys(taxonomy).length,
    },
    taxonomy,
    tweets: tweets
      .filter((t) => t.categories.length > 0)
      .map((t) => ({
        id: t.id,
        author: t.username,
        handle: '@' + t.handle,
        text: t.text,
        timestamp: t.date,
        source_file: 'seed.html',
        is_article: t.isArticle,
        article_title: t.articleTitle ?? null,
        categories: t.categories,
      })),
  };
  return JSON.stringify(payload, null, 2);
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Generating ${TWEET_COUNT} tweets…`);
  const tweets = generate();
  // Shuffle so liked_at (import time) isn't monotonic with created_at.
  // The extension's HTML has tweets in liked-order; created_at is each tweet's
  // timestamp. Sort descending by created_at for a realistic feel.
  tweets.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  const html = writeHtml(tweets);
  const json = writeClassifier(tweets);
  const enriched = writeEnriched(tweets);

  writeFileSync(resolve(OUT_DIR, 'tweets.html'), html);
  writeFileSync(resolve(OUT_DIR, 'classifier.json'), json);
  writeFileSync(resolve(OUT_DIR, 'enriched.json'), enriched);

  const withCats = tweets.filter((t) => t.categories.length > 0).length;
  console.log(`✓ Wrote ${resolve(OUT_DIR, 'tweets.html')} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`✓ Wrote ${resolve(OUT_DIR, 'classifier.json')} — ${withCats} categorized tweets`);
  console.log(`✓ Wrote ${resolve(OUT_DIR, 'enriched.json')} (${(enriched.length / 1024 / 1024).toFixed(2)} MB)`);
}

main();
