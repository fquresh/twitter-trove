// Renders an assistant message as proper markdown (headers, lists, blockquotes,
// rules, bold/italic, code, tables) while keeping the chat's custom inline
// citations working:
//   [^1234567890]  -> <CitationChip>  (numbered footnote, scrolls to its
//                     card in the SourcesList rendered by MessageBubble)
//   [[concepts/x]] -> <WikiLinkBadge>
//
// The underlying message text stays raw markdown (so Copy → Obsidian is clean);
// only the on-screen rendering is formatted.

import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CitationChip } from './CitationChip';
import { WikiLinkBadge } from './WikiLinkBadge';

const TWEET_PREFIX = 'trove-tweet:';
const WIKI_PREFIX = 'trove-wiki:';

const TWEET_RE = /\[\^(\d{6,25})\]/g;
const WIKI_RE = /\[\[([^\]]+?)\]\]/g;

// Minimal mdast shape we touch - avoids pulling the full mdast type surface.
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

// Split a text node's value on the two citation patterns, returning a mix of
// text + link nodes (custom URL scheme), or null if there's nothing to split.
function splitCitations(value: string): MdNode[] | null {
  type M = { start: number; end: number; url: string; label: string };
  const ms: M[] = [];
  let m: RegExpExecArray | null;
  TWEET_RE.lastIndex = 0;
  while ((m = TWEET_RE.exec(value))) {
    ms.push({ start: m.index, end: m.index + m[0].length, url: TWEET_PREFIX + m[1], label: m[0] });
  }
  WIKI_RE.lastIndex = 0;
  while ((m = WIKI_RE.exec(value))) {
    ms.push({
      start: m.index,
      end: m.index + m[0].length,
      url: WIKI_PREFIX + encodeURIComponent(m[1]!.trim()),
      label: m[1]!.trim(),
    });
  }
  if (ms.length === 0) return null;
  ms.sort((a, b) => a.start - b.start);

  const out: MdNode[] = [];
  let cursor = 0;
  for (const mt of ms) {
    if (mt.start < cursor) continue; // overlapping; first wins
    if (mt.start > cursor) out.push({ type: 'text', value: value.slice(cursor, mt.start) });
    out.push({ type: 'link', url: mt.url, children: [{ type: 'text', value: mt.label }] });
    cursor = mt.end;
  }
  if (cursor < value.length) out.push({ type: 'text', value: value.slice(cursor) });
  return out;
}

// remark plugin. Walks `text` nodes only, so citations inside inline code or
// fenced code blocks (which are `inlineCode`/`code` leaf nodes) are untouched.
function remarkCitations() {
  const walk = (node: MdNode): void => {
    if (!node.children) return;
    const next: MdNode[] = [];
    for (const child of node.children) {
      if (child.type === 'text' && typeof child.value === 'string') {
        const split = splitCitations(child.value);
        if (split) next.push(...split);
        else next.push(child);
      } else {
        walk(child);
        next.push(child);
      }
    }
    node.children = next;
  };
  return (tree: MdNode): void => walk(tree);
}

// Allow our custom citation schemes through react-markdown's URL sanitizer;
// everything else goes through the safe default.
const urlTransform = (url: string): string =>
  url.startsWith(TWEET_PREFIX) || url.startsWith(WIKI_PREFIX) ? url : defaultUrlTransform(url);

const components: Components = {
  a({ href, children }) {
    if (href?.startsWith(TWEET_PREFIX)) {
      return <CitationChip tweetId={href.slice(TWEET_PREFIX.length)} />;
    }
    if (href?.startsWith(WIKI_PREFIX)) {
      return <WikiLinkBadge path={decodeURIComponent(href.slice(WIKI_PREFIX.length))} />;
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-accent-600 underline decoration-accent-400/40 underline-offset-2 hover:decoration-accent-400 dark:text-accent-300"
      >
        {children}
      </a>
    );
  },
  h1: ({ children }) => (
    <h1 className="mb-1.5 mt-4 text-base font-semibold text-ink-900 first:mt-0 dark:text-ink-50">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1.5 mt-4 text-[15px] font-semibold text-ink-900 first:mt-0 dark:text-ink-50">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-3 text-sm font-semibold text-ink-900 first:mt-0 dark:text-ink-50">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1 mt-2.5 text-sm font-semibold text-ink-700 first:mt-0 dark:text-ink-200">{children}</h4>
  ),
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed marker:text-ink-400">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-accent-400/50 pl-3 italic text-ink-600 dark:text-ink-300">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-canvas-200 dark:border-white/10" />,
  strong: ({ children }) => (
    <strong className="font-semibold text-ink-900 dark:text-ink-50">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ className, children }) => {
    const isBlock = /language-/.test(className ?? '');
    if (isBlock) return <code className={className}>{children}</code>;
    return (
      <code className="rounded bg-canvas-100 px-1 py-0.5 font-mono text-[0.85em] text-ink-800 dark:bg-white/10 dark:text-ink-100">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg bg-canvas-100 p-3 font-mono text-xs leading-relaxed dark:bg-black/40">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-canvas-200 px-2 py-1 text-left font-semibold dark:border-white/10">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-canvas-200 px-2 py-1 dark:border-white/10">{children}</td>
  ),
};

export function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="text-sm leading-relaxed [overflow-wrap:anywhere]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCitations as unknown as typeof remarkGfm]}
        urlTransform={urlTransform}
        components={components}
        // Model output is untrusted (prompt injection via collected posts).
        // Never mount <img>: a remote src is a zero-click request to any host.
        disallowedElements={['img']}
        unwrapDisallowed
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
