// X Collector - the "already collected" index.
//
// Re-scanning a timeline to pick up posts an earlier run missed used to
// re-collect everything it already had. This file is the shared, dependency-free
// half of the fix: the popup imports previously downloaded exports (x-*.html)
// with it, and the content script uses the same helpers to read the index at
// Start and fold the ids it just collected back in.
//
// The index lives in chrome.storage.local under KNOWN_KEY, keyed by the source
// signature from source.js, so posts already collected from one timeline never
// suppress a different one:
//
//   { "likes|||": ["1234", "5678"], "profile|adafieldstone||": ["9012"] }
//
// Loaded by the popup (script tag) and injected alongside source.js before
// content.js. Keep it free of chrome.* and DOM access.

(() => {
  if (typeof window.xExtractExportIds === 'function') return;

  const KNOWN_KEY = 'xlcKnownIds';

  // The id list out of one exported HTML file. Prefers the `tweetsData` block
  // (the contract every reader uses), falling back to scanning /status/<id>
  // hrefs so a hand-edited or truncated export still contributes its ids.
  window.xExtractExportIds = function xExtractExportIds(html) {
    const text = String(html == null ? '' : html);
    const ids = new Set();

    const block = /const tweetsData = (\[[\s\S]*?\]);/.exec(text);
    if (block) {
      try {
        const parsed = JSON.parse(block[1]);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const id = item && item.id;
            if (id != null && /^\d+$/.test(String(id))) ids.add(String(id));
          }
        }
      } catch {
        // Not the JSON we expected; the href scan below still gets the ids.
      }
    }

    if (ids.size === 0) {
      const re = /\/(?:status|statuses)\/(\d+)/g;
      let m;
      while ((m = re.exec(text)) !== null) ids.add(m[1]);
    }

    return [...ids];
  };

  // Which timeline an export came from, as the same signature the content
  // script records. Files from before the v2.0 `collectionMeta` block are all
  // Likes exports - that was the only timeline the old collector could reach.
  window.xExportSourceSignature = function xExportSourceSignature(html) {
    const m = /const collectionMeta = (\{[\s\S]*?\});/.exec(String(html == null ? '' : html));
    if (m) {
      try {
        const meta = JSON.parse(m[1]);
        if (meta && meta.source && typeof window.xSourceSignature === 'function') {
          return window.xSourceSignature(meta.source);
        }
      } catch {
        // fall through to the legacy default
      }
    }
    return typeof window.xSourceSignature === 'function'
      ? window.xSourceSignature({ kind: 'likes' })
      : 'likes|||';
  };

  window.xKnownIdsFor = function xKnownIdsFor(index, signature) {
    const list = index && signature ? index[signature] : null;
    return Array.isArray(list) ? list : [];
  };

  // Union of what the index already holds for `signature` and the ids passed
  // in, leaving every other source's entry untouched. Returns a new object.
  window.xMergeKnownIds = function xMergeKnownIds(index, signature, ids) {
    const out = {};
    for (const key of Object.keys(index || {})) {
      const list = index[key];
      if (Array.isArray(list) && list.length) out[key] = list.slice();
    }
    const merged = new Set(out[signature] || []);
    for (const id of ids || []) {
      const text = id == null ? '' : String(id);
      if (text) merged.add(text);
    }
    if (merged.size) out[signature] = [...merged];
    else delete out[signature];
    return out;
  };

  window.xKnownIndexSize = function xKnownIndexSize(index) {
    let total = 0;
    for (const key of Object.keys(index || {})) {
      const list = index[key];
      if (Array.isArray(list)) total += list.length;
    }
    return total;
  };

  window.X_KNOWN_KEY = KNOWN_KEY;
})();
