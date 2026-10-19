// Builds the self-contained HTML export.
//
// The output shape is a contract shared with two readers:
//   - webapp/src/parser/htmlExport.ts
//   - parse_and_classify.py
// They read the `const tweetsData = [...]` block and the .tweet-card markup
// (.tweet-author .name/.handle, .tweet-date, .tweet-text, .tweet-images,
// .video-indicator, .article-indicator, .article-title). Keep both stable.
//
// `meta` (optional) records WHICH X timeline produced the file - see source.js.
// It is emitted as a separate `const collectionMeta = {...}` block after
// tweetsData, so the readers above are unaffected: their regex is anchored on
// the literal "const tweetsData = [".

function buildReportHtml(tweets, meta) {
  const source = (meta && meta.source) || { kind: 'likes', label: 'X Posts', slug: 'likes' };
  const heading = source.label || 'X Posts';
  // Likes are ordered by when you liked them; every other timeline is ordered
  // by the page itself. Name the third sort option after whichever it is.
  const orderLabel = source.kind === 'likes'
    ? 'Like order (most recently liked first)'
    : 'Timeline order (as the page listed them)';
  const sortedTweets = [...tweets].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const generatedAt = new Date();
  const withImages = sortedTweets.filter((t) => t.images && t.images.length > 0).length;
  const withVideo = sortedTweets.filter((t) => t.hasVideo).length;
  const articles = sortedTweets.filter((t) => t.isArticle).length;
  const first = sortedTweets[0]?.date || 'N/A';
  const last = sortedTweets[sortedTweets.length - 1]?.date || 'N/A';

  // JSON inside <script> must not be able to close the tag. The readers locate
  // the block with the non-greedy regex /const tweetsData = (\[[\s\S]*?\]);/,
  // so a literal "];" inside tweet text would truncate the parse. Encode the
  // bracket as the JSON escape \u005d (decodes to the same text). The array's own
  // terminator is "}]" so it is unaffected.
  // Three sequences must not survive verbatim inside the <script> block:
  //   "</"    would close the element early           -> "<\/" (a valid JSON escape)
  //   "];"    would truncate the readers' regex       -> "\u005d;"
  //   "<!--"  would flip the HTML tokenizer into the double-escaped script
  //           state, where a later "</script>" no longer closes the block
  //                                                   -> "\u003c!--"
  // Every replacement is a legal JSON escape, so JSON.parse in the three
  // readers still returns the original characters.
  const encodeJson = (value) => JSON.stringify(value)
    .replace(/<\//g, '<\\/')
    .replace(/<!--/g, '\\u003c!--')
    .replace(/\];/g, '\\u005d;');
  const dataJson = encodeJson(sortedTweets);
  const metaJson = encodeJson({
    generator: 'X Collector',
    version: (meta && meta.version) || null,
    collectedAt: (meta && meta.collectedAt) || generatedAt.toISOString(),
    count: sortedTweets.length,
    // How many posts from earlier runs this scan skipped. Non-zero means the
    // file is the delta, not the whole timeline.
    skippedKnown: (meta && meta.skippedKnown) || 0,
    source,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(heading)} - ${generatedAt.toLocaleDateString()}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #15202b; color: #ffffff; padding: 20px; line-height: 1.5;
    }
    .header {
      max-width: 1200px; margin: 0 auto 40px; padding: 30px; background: #192734;
      border-radius: 16px; border: 1px solid #38444d;
    }
    .header h1 { font-size: 32px; margin-bottom: 10px; color: #1da1f2; }
    .header .stats { display: flex; gap: 30px; margin-top: 20px; font-size: 14px; color: #8899a6; flex-wrap: wrap; }
    .header .stats span { font-weight: 600; color: #ffffff; }
    .header .source-link { color: #1da1f2; }
    .controls {
      max-width: 1200px; margin: 0 auto 30px; padding: 20px; background: #192734;
      border-radius: 12px; border: 1px solid #38444d; display: flex; gap: 15px; align-items: center; flex-wrap: wrap;
    }
    .controls input, .controls select {
      padding: 10px 15px; background: #253341; border: 1px solid #38444d; border-radius: 20px;
      color: #ffffff; font-size: 14px;
    }
    .controls input { flex: 1; min-width: 250px; }
    .controls input::placeholder { color: #8899a6; }
    .container {
      max-width: 1200px; margin: 0 auto; display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 20px;
    }
    .tweet-card {
      background: #192734; border: 1px solid #38444d; border-radius: 16px; padding: 20px;
      cursor: pointer; transition: all 0.2s; text-decoration: none; color: inherit; display: block;
    }
    .tweet-card:hover { border-color: #1da1f2; transform: translateY(-2px); box-shadow: 0 4px 12px rgba(29, 161, 242, 0.2); }
    .tweet-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .tweet-author { flex: 1; }
    .tweet-author .name { font-weight: 700; font-size: 15px; color: #ffffff; }
    .tweet-author .handle { color: #8899a6; font-size: 14px; }
    .tweet-date { color: #8899a6; font-size: 13px; }
    .tweet-text { margin-bottom: 12px; font-size: 15px; white-space: pre-wrap; word-wrap: break-word; }
    .tweet-images { display: grid; gap: 8px; margin-top: 12px; border-radius: 12px; overflow: hidden; }
    .tweet-images.single { grid-template-columns: 1fr; }
    .tweet-images.double, .tweet-images.triple, .tweet-images.quad { grid-template-columns: 1fr 1fr; }
    .tweet-images img { width: 100%; height: 100%; object-fit: cover; display: block; max-height: 400px; }
    .tweet-images.double img, .tweet-images.triple img, .tweet-images.quad img { max-height: 200px; }
    .tweet-images.triple img:first-child { grid-column: 1 / -1; }
    .video-indicator, .article-indicator {
      display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; color: white;
      border-radius: 12px; font-size: 13px; font-weight: 600; margin-top: 8px;
    }
    .video-indicator { background: #1da1f2; }
    .article-indicator { background: #7856ff; }
    .article-title { margin-top: 8px; font-size: 16px; font-weight: 700; color: #ffffff; }
    .no-results { grid-column: 1 / -1; text-align: center; padding: 60px 20px; color: #8899a6; font-size: 18px; }
    @media (max-width: 768px) { .container { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(heading)}</h1>
    <p>Collected on ${generatedAt.toLocaleString()}${source.url ? ` from <a class="source-link" href="${safeUrl(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.url)}</a>` : ''}</p>
    <div class="stats">
      <div>Total Posts: <span id="totalCount">${sortedTweets.length}</span></div>
      <div>With Images: <span>${withImages}</span></div>
      <div>With Video: <span>${withVideo}</span></div>
      <div>Articles: <span>${articles}</span></div>
      <div>Date Range: <span>${first} - ${last}</span></div>
    </div>
  </div>

  <div class="controls">
    <input type="text" id="searchInput" placeholder="Search posts...">
    <select id="sortSelect">
      <option value="chrono">Oldest first</option>
      <option value="reverse">Newest first</option>
      <option value="liked">${escapeHtml(orderLabel)}</option>
    </select>
  </div>

  <div class="container" id="tweetsContainer">
    ${sortedTweets.map((tweet) => createTweetCard(tweet)).join('')}
  </div>

  <script>
    const tweetsData = ${dataJson};
    const collectionMeta = ${metaJson};
    let filteredTweets = [...tweetsData];

    const searchInput = document.getElementById('searchInput');
    const sortSelect = document.getElementById('sortSelect');
    const container = document.getElementById('tweetsContainer');
    const totalCount = document.getElementById('totalCount');

    searchInput.addEventListener('input', filterTweets);
    sortSelect.addEventListener('change', filterTweets);

    function filterTweets() {
      const searchTerm = searchInput.value.toLowerCase();
      const sortOrder = sortSelect.value;

      filteredTweets = tweetsData.filter((tweet) => {
        const searchText = (tweet.text + ' ' + tweet.username + ' ' + tweet.handle + ' ' + (tweet.articleTitle || '')).toLowerCase();
        return searchText.includes(searchTerm);
      });

      if (sortOrder === 'reverse') {
        filteredTweets.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      } else if (sortOrder === 'liked') {
        filteredTweets.sort((a, b) => (a.sourceIndex ?? a.likeIndex ?? 0) - (b.sourceIndex ?? b.likeIndex ?? 0));
      } else {
        filteredTweets.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      }

      renderTweets();
    }

    function renderTweets() {
      totalCount.textContent = filteredTweets.length;
      if (filteredTweets.length === 0) {
        container.innerHTML = '<div class="no-results">No posts found matching your search</div>';
        return;
      }
      container.innerHTML = filteredTweets.map((tweet) => createTweetCard(tweet)).join('');
    }

    ${createTweetCard.toString()}

    ${safeUrl.toString()}

    ${escapeHtml.toString()}
  </script>
</body>
</html>`;
}

// Shared between the popup (initial render) and the exported page (re-render on
// search/sort). Serialized into the export with .toString(), so it must stay
// self-contained: no closures, no references to popup globals.
function createTweetCard(tweet) {
  const imageClass = !tweet.images ? '' :
    tweet.images.length === 1 ? 'single' :
    tweet.images.length === 2 ? 'double' :
    tweet.images.length === 3 ? 'triple' : 'quad';

  const imagesHTML = tweet.images && tweet.images.length > 0 ?
    '<div class="tweet-images ' + imageClass + '">' +
      tweet.images.map((img) => '<img src="' + safeUrl(img) + '" alt="Tweet image" loading="lazy">').join('') +
    '</div>' : '';

  const videoHTML = tweet.hasVideo ?
    '<div class="video-indicator">📹 Video - Click to watch</div>' : '';

  const articleHTML = tweet.isArticle ?
    '<div class="article-indicator">📝 Article</div>' +
    (tweet.articleTitle ? '<div class="article-title">' + escapeHtml(tweet.articleTitle) + '</div>' : '') : '';

  return '<a href="' + safeUrl(tweet.link) + '" target="_blank" rel="noopener noreferrer" class="tweet-card">' +
    '<div class="tweet-header">' +
      '<div class="tweet-author">' +
        '<div class="name">' + escapeHtml(tweet.username) + '</div>' +
        '<div class="handle">@' + escapeHtml(tweet.handle) + '</div>' +
      '</div>' +
      '<div class="tweet-date">' + escapeHtml(tweet.date) + '</div>' +
    '</div>' +
    '<div class="tweet-text">' + escapeHtml(tweet.text) + '</div>' +
    articleHTML +
    imagesHTML +
    videoHTML +
  '</a>';
}

// Scheme allowlist for values that land in href/src. escapeHtml alone stops an
// attribute breakout but leaves "javascript:..." intact, which still executes.
// Serialized into the export like createTweetCard, so keep it self-contained.
function safeUrl(url) {
  const s = String(url == null ? '' : url).trim();
  if (!/^(https?:|\/\/|\/)/i.test(s)) return '#';
  return s.replace(/"/g, '%22').replace(/'/g, '%27');
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
