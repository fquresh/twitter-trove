// Anthropic tool definitions + dispatcher for the chat agent.
//
// Phase 7 ships the five SQL tools. Phase 13 adds the three wiki tools
// alongside (search_wiki, list_wiki_pages, read_wiki_page); we expose them
// here as conditionally-included via `buildToolsetFor` so the wiki-off path
// gracefully omits them rather than emitting tools that always error.

import type { Database } from 'sql.js';
import type { FilterSet } from '../filters/types';
import {
  countTweets,
  topAuthors,
  tweetsInPeriod,
  getTweetWithEnrichments,
  applyAgentFilters,
  type AgentFilterInput,
} from '../db/queries/agentTools';
import type { RetrievalHit } from './retrievalCore';

// ── Tool definitions (Anthropic tool schema) ──────────────────────────────
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const SQL_TOOLS: ToolDefinition[] = [
  {
    name: 'search_tweets',
    description:
      'Hybrid (semantic + keyword) search over the archive, optionally filtered. ' +
      'Returns up to k tweet ids with rank breakdown; the agent then reads the ' +
      'pre-fetched context block (already in the conversation) for full bodies.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' },
        categories: { type: 'array', items: { type: 'string' } },
        authors: { type: 'array', items: { type: 'string' } },
        tickers: { type: 'array', items: { type: 'string' } },
        hashtags: { type: 'array', items: { type: 'string' } },
        mentions: { type: 'array', items: { type: 'string' } },
        from_date: { type: 'string', description: 'ISO date or YYYY / YYYY-Qn' },
        to_date: { type: 'string' },
        k: { type: 'integer', default: 20 },
      },
      required: ['query'],
    },
  },
  {
    name: 'count_tweets',
    description:
      'Count tweets matching a filter set. Returns {count} and optionally a ' +
      'category breakdown when by_category=true.',
    input_schema: {
      type: 'object' as const,
      properties: {
        categories: { type: 'array', items: { type: 'string' } },
        authors: { type: 'array', items: { type: 'string' } },
        tickers: { type: 'array', items: { type: 'string' } },
        hashtags: { type: 'array', items: { type: 'string' } },
        mentions: { type: 'array', items: { type: 'string' } },
        from_date: { type: 'string' },
        to_date: { type: 'string' },
        by_category: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'top_authors',
    description: 'Top authors by tweet count within the filter scope.',
    input_schema: {
      type: 'object' as const,
      properties: {
        categories: { type: 'array', items: { type: 'string' } },
        authors: { type: 'array', items: { type: 'string' } },
        tickers: { type: 'array', items: { type: 'string' } },
        hashtags: { type: 'array', items: { type: 'string' } },
        mentions: { type: 'array', items: { type: 'string' } },
        from_date: { type: 'string' },
        to_date: { type: 'string' },
        limit: { type: 'integer', default: 10 },
      },
    },
  },
  {
    name: 'tweets_in_period',
    description:
      'Tweets in a time window, optionally further filtered. Use for "what was I ' +
      'reading in Q3 2024" type questions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        start: { type: 'string' },
        end: { type: 'string' },
        categories: { type: 'array', items: { type: 'string' } },
        authors: { type: 'array', items: { type: 'string' } },
        tickers: { type: 'array', items: { type: 'string' } },
        hashtags: { type: 'array', items: { type: 'string' } },
        mentions: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', default: 20 },
      },
      required: ['start', 'end'],
    },
  },
  {
    name: 'get_tweet_by_id',
    description: 'Full metadata + URL/image enrichments for a single tweet id.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
    },
  },
];

const WIKI_TOOLS: ToolDefinition[] = [
  {
    name: 'read_wiki_page',
    description:
      'Read a wiki page by `<category>/<slug>` path (no extension; e.g. "people/jhalvorsen" or ' +
      '"concepts/agentic-search"). Returns frontmatter + markdown body.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_wiki_pages',
    description:
      'List wiki pages, optionally restricted to a category and/or substring-matching a query.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          enum: ['people', 'concepts', 'tickers'],
        },
        query: { type: 'string' },
      },
    },
  },
  {
    name: 'search_wiki',
    description: 'Full-text grep over wiki page bodies. Returns matching pages with surrounding context.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' },
        max_results: { type: 'integer', default: 10 },
      },
      required: ['query'],
    },
  },
];

export function buildToolset(opts: { wikiEnabled: boolean }): ToolDefinition[] {
  return opts.wikiEnabled ? [...SQL_TOOLS, ...WIKI_TOOLS] : SQL_TOOLS;
}

// ── Tool dispatch ─────────────────────────────────────────────────────────
export interface ToolEnv {
  db: Database;
  baseFilters: FilterSet;
  // The current chat turn's already-computed retrieval hits (for search_tweets).
  // Same shape as workspace's `hybridSearch` returns.
  searchHandler: (input: AgentFilterInput & { query: string; k?: number }) => Promise<RetrievalHit[]>;
  // Wiki client (Phase 13). When undefined, wiki tool calls return an
  // {error: 'wiki_unreachable'} payload so the agent gracefully degrades.
  wiki?: {
    list: (input: { category?: string; query?: string }) => Promise<unknown>;
    read: (input: { path: string }) => Promise<unknown>;
    search: (input: { query: string; max_results?: number }) => Promise<unknown>;
  };
}

export async function dispatchTool(
  env: ToolEnv,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'search_tweets': {
      const { query, k, ...filterInput } = input as unknown as AgentFilterInput & {
        query: string;
        k?: number;
      };
      const hits = await env.searchHandler({ query, k, ...filterInput });
      return { hits, applied_filters: filterInput };
    }
    case 'count_tweets': {
      const { by_category, ...filters } = input as AgentFilterInput & { by_category?: boolean };
      return countTweets(env.db, env.baseFilters, filters, Boolean(by_category));
    }
    case 'top_authors': {
      const { limit, ...filters } = input as AgentFilterInput & { limit?: number };
      return topAuthors(env.db, env.baseFilters, filters, limit ?? 10);
    }
    case 'tweets_in_period': {
      const { start, end, limit, ...filters } = input as unknown as AgentFilterInput & {
        start: string;
        end: string;
        limit?: number;
      };
      return tweetsInPeriod(env.db, env.baseFilters, start, end, filters, limit ?? 20);
    }
    case 'get_tweet_by_id': {
      const { id } = input as { id: string };
      const t = getTweetWithEnrichments(env.db, id);
      return t ?? { error: 'not_found', id };
    }
    case 'read_wiki_page':
    case 'list_wiki_pages':
    case 'search_wiki': {
      if (!env.wiki) {
        return { error: 'wiki_unreachable' };
      }
      try {
        if (name === 'read_wiki_page') return await env.wiki.read(input as { path: string });
        if (name === 'list_wiki_pages') return await env.wiki.list(input as { category?: string; query?: string });
        return await env.wiki.search(input as { query: string; max_results?: number });
      } catch {
        return { error: 'wiki_unreachable' };
      }
    }
    default:
      return { error: 'unknown_tool', name };
  }
}

// Re-export the agent-side filter helper for tests.
export { applyAgentFilters };
