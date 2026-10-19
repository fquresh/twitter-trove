import type { RetrievalHit } from '../../chat/retrievalCore';

interface Props {
  hits: RetrievalHit[];
  elapsedMs?: number;
}

// Dev panel showing FTS / vector / fused ranks + enrichment flags. Surfaced
// underneath the user's question in the conversation pane so the user can
// audit what the agent saw before answering.
export function RetrievalInspector({ hits, elapsedMs }: Props) {
  if (hits.length === 0) {
    return (
      <div className="text-xs text-ink-400">
        Retrieval: 0 hits {elapsedMs != null ? `(${elapsedMs.toFixed(0)} ms)` : ''}
      </div>
    );
  }
  return (
    <details className="rounded-md border border-canvas-200 bg-canvas-50/60 px-3 py-2 text-xs text-ink-600 dark:border-white/5 dark:bg-black/20 dark:text-ink-300">
      <summary className="cursor-pointer">
        Retrieval: top {hits.length}
        {elapsedMs != null ? ` (${elapsedMs.toFixed(0)} ms)` : ''}
      </summary>
      <table className="mt-2 w-full text-left font-mono">
        <thead className="text-ink-400">
          <tr>
            <th className="px-1 py-1">#</th>
            <th className="px-1 py-1">tweet_id</th>
            <th className="px-1 py-1">fts</th>
            <th className="px-1 py-1">vec</th>
            <th className="px-1 py-1">fused</th>
            <th className="px-1 py-1">enr</th>
          </tr>
        </thead>
        <tbody>
          {hits.map((h, i) => (
            <tr key={h.tweetId} className="hover:bg-canvas-100 dark:hover:bg-white/5">
              <td className="px-1 py-0.5">{i + 1}</td>
              <td className="px-1 py-0.5">{h.tweetId.slice(-10)}</td>
              <td className="px-1 py-0.5">{h.ftsRank ?? '-'}</td>
              <td className="px-1 py-0.5">{h.vecRank ?? '-'}</td>
              <td className="px-1 py-0.5">{h.fusedScore.toFixed(4)}</td>
              <td className="px-1 py-0.5">
                {h.hasUrlEnrich ? 'U' : ''}
                {h.hasImgEnrich ? 'I' : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
