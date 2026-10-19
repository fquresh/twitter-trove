// Local wiki server client. Used by the chat agent's wiki tools and by the
// in-app drawer. Always returns {error: 'wiki_unreachable'} on network
// failure rather than throwing - graceful degrade per plan §risk register #12.

export interface WikiClient {
  health(): Promise<{ status: string; page_count: number; last_log_entry?: string } | { error: 'wiki_unreachable' }>;
  list(input: { category?: string; query?: string }): Promise<unknown>;
  read(input: { path: string }): Promise<unknown>;
  search(input: { query: string; max_results?: number }): Promise<unknown>;
}

/**
 * Coerce a model-supplied page reference to the `<category>/<slug>` form the
 * server accepts: strip `[[ ]]`, a leading `wiki/`, a `.md` suffix and stray
 * slashes, then lowercase and hyphenate spaces. The server 404s on `.md` and
 * `wiki/` prefixes and 400s on uppercase, all of which models produce.
 */
export function normalizeWikiPath(raw: string): string {
  let p = raw.trim().replace(/^\[\[|\]\]$/g, '').replace(/\\/g, '/');
  p = p.replace(/^\/+|\/+$/g, '').replace(/^wiki\//i, '').replace(/\.md$/i, '');
  return p.toLowerCase().replace(/\s+/g, '-');
}

function isHttpError(v: unknown, status: number): boolean {
  return !!v && typeof v === 'object' && (v as { error?: unknown }).error === `wiki_http_${status}`;
}

export function makeWikiClient(serverUrl: string): WikiClient {
  const base = serverUrl.replace(/\/$/, '');
  const fetchJson = async (path: string, init?: RequestInit): Promise<unknown> => {
    try {
      const resp = await fetch(`${base}${path}`, init);
      if (!resp.ok) {
        return { error: `wiki_http_${resp.status}` };
      }
      return await resp.json();
    } catch {
      return { error: 'wiki_unreachable' };
    }
  };

  return {
    async health() {
      return fetchJson('/health') as ReturnType<WikiClient['health']>;
    },
    async list({ category, query }) {
      const sp = new URLSearchParams();
      if (category) sp.set('category', category);
      if (query) sp.set('query', query);
      return fetchJson(`/wiki/list${sp.toString() ? `?${sp.toString()}` : ''}`);
    },
    async read({ path }) {
      const normalized = normalizeWikiPath(path);
      const sp = new URLSearchParams({ path: normalized });
      const out = await fetchJson(`/wiki/read?${sp.toString()}`);
      // A missing page is a normal answer, not a failure: the model can list
      // or search and try again, so hand it a hint instead of an error.
      if (isHttpError(out, 404)) {
        return {
          found: false,
          path: normalized,
          message: `No wiki page at "${normalized}". Use list_wiki_pages or search_wiki to find valid paths (<people|concepts|tickers>/<slug>).`,
        };
      }
      return out;
    },
    async search({ query, max_results }) {
      const sp = new URLSearchParams({ q: query });
      if (max_results) sp.set('max', String(max_results));
      return fetchJson(`/wiki/search?${sp.toString()}`);
    },
  };
}
