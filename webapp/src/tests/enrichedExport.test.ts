import { describe, it, expect } from 'vitest';
import {
  parseEnrichedJson,
  isEnrichedJson,
} from '../parser/enrichedExport';

// Helper: build a 1024-dim int8 vector packed into a base64 string. The bit
// pattern doesn't matter for parser tests - we only care that the parser
// decodes the right number of bytes and that round-tripping survives.
function buildVectorB64(dim: number, fill: number): string {
  const bytes = new Uint8Array(dim);
  const view = new Int8Array(bytes.buffer);
  for (let i = 0; i < dim; i++) view[i] = ((i + fill) % 255) - 127;
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

const validPayload = {
  metadata: {
    embed_model: 'voyage-3-large',
    embed_dim: 1024,
    embed_dtype: 'int8',
    vision_model: 'claude-haiku-4-5',
    generated_at: '2026-04-27T12:00:00Z',
    stats: { embeddings: 1, url_enrichments: 1, image_enrichments: 1 },
  },
  embeddings: [
    {
      tweet_id: '1',
      model: 'voyage-3-large',
      dim: 1024,
      dtype: 'int8',
      scale: 0.001,
      offset: 0,
      vector_b64: buildVectorB64(1024, 0),
    },
  ],
  url_enrichments: [
    {
      tweet_id: '1',
      source_ref: 'https://example.com/article',
      content: 'extracted body',
      metadata: { status: 'ok', fetched_at: 1700000000 },
    },
  ],
  image_enrichments: [
    {
      tweet_id: '1',
      source_ref: 'https://pbs.twimg.com/media/abc',
      content: 'a chart of compute over time',
      model: 'claude-haiku-4-5',
      metadata: { tokens: 220 },
    },
  ],
};

describe('isEnrichedJson', () => {
  it('returns true on the canonical enriched shape', () => {
    expect(isEnrichedJson(JSON.stringify(validPayload))).toBe(true);
  });

  it('returns false on the classifier JSON shape', () => {
    expect(
      isEnrichedJson(JSON.stringify({ tweets: [{ id: '1', categories: [] }] })),
    ).toBe(false);
  });

  it('returns false on invalid JSON', () => {
    expect(isEnrichedJson('not json')).toBe(false);
  });

  it('returns false when metadata is present but missing embed_model', () => {
    expect(isEnrichedJson(JSON.stringify({ metadata: { other: 'x' } }))).toBe(false);
  });
});

describe('parseEnrichedJson', () => {
  it('parses the canonical payload', () => {
    const out = parseEnrichedJson(JSON.stringify(validPayload));
    expect(out.errors).toEqual([]);
    expect(out.metadata.embedModel).toBe('voyage-3-large');
    expect(out.metadata.embedDim).toBe(1024);
    expect(out.metadata.stats.embeddings).toBe(1);
    expect(out.embeddings).toHaveLength(1);
    expect(out.urlEnrichments).toHaveLength(1);
    expect(out.imageEnrichments).toHaveLength(1);
  });

  it('decodes vector_b64 into a Uint8Array of the right length', () => {
    const out = parseEnrichedJson(JSON.stringify(validPayload));
    const e = out.embeddings[0]!;
    expect(e.vector).toBeInstanceOf(Uint8Array);
    expect(e.vector.byteLength).toBe(1024);
  });

  it('round-trips a vector exactly through base64', () => {
    const dim = 32;
    const bytes = new Uint8Array(dim);
    const view = new Int8Array(bytes.buffer);
    for (let i = 0; i < dim; i++) view[i] = i - 16;
    let s = '';
    for (let i = 0; i < dim; i++) s += String.fromCharCode(bytes[i]);
    const b64 = btoa(s);
    const out = parseEnrichedJson(
      JSON.stringify({
        ...validPayload,
        metadata: { ...validPayload.metadata, embed_dim: dim },
        embeddings: [
          {
            ...validPayload.embeddings[0],
            dim,
            vector_b64: b64,
          },
        ],
        url_enrichments: [],
        image_enrichments: [],
      }),
    );
    const recon = new Int8Array(out.embeddings[0]!.vector.buffer);
    for (let i = 0; i < dim; i++) expect(recon[i]).toBe(i - 16);
  });

  it('reports an error and skips embeddings with mismatched byte length', () => {
    const bad = {
      ...validPayload,
      embeddings: [
        {
          ...validPayload.embeddings[0],
          dim: 512, // declared, but vector_b64 still encodes 1024 bytes
        },
      ],
    };
    const out = parseEnrichedJson(JSON.stringify(bad));
    expect(out.embeddings).toHaveLength(0);
    expect(out.errors[0]?.section).toBe('embeddings');
    expect(out.errors[0]?.reason).toMatch(/dim mismatch/);
  });

  it('skips embeddings with missing required fields', () => {
    const bad = {
      ...validPayload,
      embeddings: [
        { tweet_id: '1', model: 'voyage-3-large' /* no dim, no vector */ },
        validPayload.embeddings[0],
      ],
    };
    const out = parseEnrichedJson(JSON.stringify(bad));
    expect(out.embeddings).toHaveLength(1);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]?.section).toBe('embeddings');
  });

  it('errors when metadata is absent', () => {
    const out = parseEnrichedJson(JSON.stringify({ embeddings: [] }));
    expect(out.errors[0]?.section).toBe('metadata');
  });

  it('errors on invalid top-level JSON', () => {
    const out = parseEnrichedJson('garbage');
    expect(out.errors[0]?.reason).toMatch(/Invalid JSON/);
  });

  it('tolerates missing optional metadata fields', () => {
    const out = parseEnrichedJson(
      JSON.stringify({
        metadata: { embed_model: 'm', embed_dim: 4, embed_dtype: 'int8' },
        embeddings: [],
        url_enrichments: [],
        image_enrichments: [],
      }),
    );
    expect(out.errors).toEqual([]);
    expect(out.metadata.visionModel).toBeNull();
    expect(out.metadata.generatedAt).toBeNull();
    expect(out.metadata.stats.embeddings).toBe(0);
  });

  it('skips url/image enrichments missing required fields', () => {
    const out = parseEnrichedJson(
      JSON.stringify({
        ...validPayload,
        url_enrichments: [
          { tweet_id: '1' /* no source_ref */ },
          validPayload.url_enrichments[0],
        ],
        image_enrichments: [
          { tweet_id: '1', source_ref: 'x' /* no content */ },
          validPayload.image_enrichments[0],
        ],
      }),
    );
    expect(out.urlEnrichments).toHaveLength(1);
    expect(out.imageEnrichments).toHaveLength(1);
    expect(out.errors.filter((e) => e.section === 'url_enrichments')).toHaveLength(1);
    expect(out.errors.filter((e) => e.section === 'image_enrichments')).toHaveLength(1);
  });
});
