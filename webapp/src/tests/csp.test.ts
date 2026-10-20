// The local-mode CSP (meta tag in index.html) must stay in step with the
// Cloudflare Pages CSP (public/_headers). Only connect-src may differ: local
// mode also talks to the local server and to the two model APIs.
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const webapp = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const indexHtml = readFileSync(resolve(webapp, 'index.html'), 'utf8');
const headers = readFileSync(resolve(webapp, 'public/_headers'), 'utf8');

function parse(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name, values);
  }
  return out;
}

const meta = parse(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(indexHtml)![1]!);
const pages = parse(/Content-Security-Policy:\s*(.+)/.exec(headers)![1]!);

describe('content security policy', () => {
  it('matches public/_headers in every directive except connect-src', () => {
    for (const [name, values] of pages) {
      // frame-ancestors has no effect in a meta tag, so only the header sets it.
      if (name === 'connect-src' || name === 'frame-ancestors') continue;
      expect(meta.get(name), name).toEqual(values);
    }
    expect(meta.has('frame-ancestors')).toBe(false);
  });

  it('allows only the local server and the model APIs beyond self', () => {
    expect(meta.get('connect-src')).toEqual([
      "'self'",
      'http://localhost:8765',
      'http://127.0.0.1:8765',
      'https://api.deepseek.com',
      'https://api.voyageai.com',
    ]);
  });

  it('loads no third-party fonts or stylesheets', () => {
    expect(indexHtml).not.toMatch(/rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com/);
    expect(headers).not.toMatch(/rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com/);
    expect(pages.get('font-src')).toEqual(["'self'"]);
  });
});
