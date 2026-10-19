// @vitest-environment node
//
// Integration tests for the Pages Functions behind /api/* - run against the
// REAL Workers runtime (Miniflare v3 embeds workerd), not mocks.
//
// Why this exists: the 2026-07 cloud outage was a runtime-level encoding bug
// (`encodeBody` defaulting to 'automatic' double-gzipped the pre-compressed R2
// objects) that no unit test could see - `syncFromDisk.test.ts` mocks fetch,
// and the function handlers looked correct when called directly. These tests
// exercise the compiled functions bundle end-to-end: R2 object in, HTTP bytes
// out, decoded exactly the way a browser decodes them (undici's fetch applies
// Content-Encoding just like a browser).

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import { generateKeyPair, SignJWT, exportJWK } from 'jose';
import { MockAgent } from 'undici';

const BUILD_DIR = resolve(__dirname, '../../.wrangler/test-fn-build');
const FIXTURE = { metadata: { newest: '2026-07-13' }, tweets: [{ id: '1', text: 'repro' }] };

function makeMiniflare(bindings: Record<string, string>, fetchMock?: MockAgent): Miniflare {
  return new Miniflare({
    modules: true,
    scriptPath: resolve(BUILD_DIR, 'index.js'),
    compatibilityDate: '2025-01-15',
    compatibilityFlags: ['nodejs_compat'],
    r2Buckets: { DATA_BUCKET: 'trove-data' },
    bindings,
    ...(fetchMock ? { fetchMock } : {}),
  });
}

async function seedGzippedObject(mf: Miniflare, name: string): Promise<void> {
  const bucket = await mf.getR2Bucket('DATA_BUCKET');
  const gz = gzipSync(Buffer.from(JSON.stringify(FIXTURE)), { level: 9 });
  // Mirror exactly what `./trove deploy` stores: gzip bytes + gzip metadata.
  await bucket.put(name, gz, {
    httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
  });
}

let mfDev: Miniflare;

beforeAll(() => {
  // Compile functions/ into a single module worker the same way `wrangler
  // pages deploy` does, so the tests run the deployed artifact, not the source.
  execFileSync('npx', ['wrangler', 'pages', 'functions', 'build', `--outdir=${BUILD_DIR}`], {
    cwd: resolve(__dirname, '../..'),
    stdio: 'pipe',
  });
  mfDev = makeMiniflare({ ALLOW_UNAUTHENTICATED_DEV: 'true' });
}, 120_000);

afterAll(async () => {
  await mfDev?.dispose();
});

describe('/api/data/[name] (R2 gzip streaming proxy)', () => {
  it('serves a gzip-stored object that decodes to valid JSON (regression: encodeBody)', async () => {
    await seedGzippedObject(mfDev, 'categorized_tweets.json');
    const res = await mfDev.dispatchFetch('http://app/api/data/categorized_tweets.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    // undici decodes Content-Encoding like a browser; with the old
    // encodeBody:'automatic' double-gzip bug this json() call throws.
    const body = (await res.json()) as typeof FIXTURE;
    expect(body.metadata.newest).toBe('2026-07-13');
    expect(body.tweets).toHaveLength(1);
  });

  it('answers a matching If-None-Match with 304, never a 0-byte 200 (regression: onlyIf)', async () => {
    await seedGzippedObject(mfDev, 'categorized_tweets.json');
    const first = await mfDev.dispatchFetch('http://app/api/data/categorized_tweets.json');
    const etag = first.headers.get('ETag');
    expect(etag).toBeTruthy();
    await first.arrayBuffer(); // drain

    // Browser HTTP-cache revalidation. R2's onlyIf returns a metadata-only
    // object (truthy, bodyless) when the etag matches; the old code streamed
    // it as a 0-byte 200, poisoning the browser cache and failing every sync
    // after the first.
    const revalidated = await mfDev.dispatchFetch('http://app/api/data/categorized_tweets.json', {
      headers: { 'If-None-Match': etag! },
    });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe('');

    // A non-matching etag must still return the full body.
    const changed = await mfDev.dispatchFetch('http://app/api/data/categorized_tweets.json', {
      headers: { 'If-None-Match': '"stale-etag"' },
    });
    expect(changed.status).toBe(200);
    const body = (await changed.json()) as typeof FIXTURE;
    expect(body.metadata.newest).toBe('2026-07-13');
  });

  it('rejects non-allowlisted names with 404', async () => {
    const res = await mfDev.dispatchFetch('http://app/api/data/..%2Fwrangler.toml');
    expect(res.status).toBe(404);
  });

  it('returns 404 for an allowlisted name missing from the bucket', async () => {
    const res = await mfDev.dispatchFetch('http://app/api/data/enriched_tweets.json');
    expect(res.status).toBe(404);
  });
});

describe('/api/manifest', () => {
  it('lists R2 objects with etags in the wiki-server manifest shape', async () => {
    await seedGzippedObject(mfDev, 'categorized_tweets.json');
    const res = await mfDev.dispatchFetch('http://app/api/manifest');
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as {
      root_files: Record<string, { mtime: number; size: number; etag: string }>;
      html_files: unknown[];
    };
    expect(manifest.html_files).toEqual([]);
    const entry = manifest.root_files['categorized_tweets.json'];
    expect(entry).toBeDefined();
    expect(entry.etag).toBeTruthy();
    expect(entry.size).toBeGreaterThan(0);
  });
});

describe('auth gate', () => {
  it('fails CLOSED (500) when CF Access is unconfigured and dev bypass is off', async () => {
    const mf = makeMiniflare({});
    try {
      const res = await mf.dispatchFetch('http://app/api/data/categorized_tweets.json');
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('server_misconfigured');
    } finally {
      await mf.dispose();
    }
  });

  it('returns 401 when CF Access is configured and no JWT is presented', async () => {
    const mf = makeMiniflare({
      CF_ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
      CF_ACCESS_AUD: 'test-aud',
    });
    try {
      const res = await mf.dispatchFetch('http://app/api/manifest');
      expect(res.status).toBe(401);
      const body = (await res.json()) as { reason: string };
      expect(body.reason).toBe('missing_jwt');
    } finally {
      await mf.dispose();
    }
  });

  // Helper: generate an RSA key pair, serve JWKS via undici MockAgent, and mint
  // a CF Access-shaped JWT. Exercises the real jose verification path in the
  // compiled Worker bundle - no mocking of jwtVerify.
  async function makeServiceTokenEnv(teamDomain: string) {
    const keyPair = await generateKeyPair('RS256');
    const jwk = await exportJWK(keyPair.publicKey);
    jwk.kid = 'test-kid';
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent
      .get(`https://${teamDomain}`)
      .intercept({ method: 'GET', path: '/cdn-cgi/access/certs' })
      .reply(200, JSON.stringify({ keys: [jwk] }), {
        headers: { 'content-type': 'application/json' },
      });
    return { keyPair, mockAgent };
  }

  it('accepts a service-token JWT (common_name, no email) past the email allowlist', async () => {
    const teamDomain = 'st-accept.cloudflareaccess.com';
    const { keyPair, mockAgent } = await makeServiceTokenEnv(teamDomain);
    const token = await new SignJWT({
      type: 'app',
      common_name: 'deploy-verify-token.access',
      aud: 'test-aud',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer(`https://${teamDomain}`)
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(keyPair.privateKey);

    const mf = makeMiniflare(
      {
        CF_ACCESS_TEAM_DOMAIN: teamDomain,
        CF_ACCESS_AUD: 'test-aud',
        ALLOWED_EMAIL: 'human@example.com',
      },
      mockAgent,
    );
    try {
      const res = await mf.dispatchFetch('http://app/api/manifest', {
        headers: { Cookie: `CF_Authorization=${token}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await mf.dispose();
    }
  });

  it('still rejects a human JWT whose email is not on the allowlist', async () => {
    const teamDomain = 'st-reject.cloudflareaccess.com';
    const { keyPair, mockAgent } = await makeServiceTokenEnv(teamDomain);
    const token = await new SignJWT({
      type: 'app',
      email: 'intruder@example.com',
      aud: 'test-aud',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer(`https://${teamDomain}`)
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(keyPair.privateKey);

    const mf = makeMiniflare(
      {
        CF_ACCESS_TEAM_DOMAIN: teamDomain,
        CF_ACCESS_AUD: 'test-aud',
        ALLOWED_EMAIL: 'human@example.com',
      },
      mockAgent,
    );
    try {
      const res = await mf.dispatchFetch('http://app/api/manifest', {
        headers: { Cookie: `CF_Authorization=${token}` },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { reason: string };
      expect(body.reason).toBe('email_not_allowed');
    } finally {
      await mf.dispose();
    }
  });

  it('fails closed when ALLOWED_EMAIL is unset: a human JWT is rejected', async () => {
    const teamDomain = 'st-unset.cloudflareaccess.com';
    const { keyPair, mockAgent } = await makeServiceTokenEnv(teamDomain);
    const token = await new SignJWT({
      type: 'app',
      email: 'anyone@example.com',
      aud: 'test-aud',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer(`https://${teamDomain}`)
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(keyPair.privateKey);

    const mf = makeMiniflare(
      { CF_ACCESS_TEAM_DOMAIN: teamDomain, CF_ACCESS_AUD: 'test-aud', ALLOWED_EMAIL: '' },
      mockAgent,
    );
    try {
      const res = await mf.dispatchFetch('http://app/api/manifest', {
        headers: { Cookie: `CF_Authorization=${token}` },
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { reason: string };
      expect(body.reason).toContain('ALLOWED_EMAIL unset');
    } finally {
      await mf.dispose();
    }
  });

  it('still accepts a service-token JWT when ALLOWED_EMAIL is unset', async () => {
    const teamDomain = 'st-unset-svc.cloudflareaccess.com';
    const { keyPair, mockAgent } = await makeServiceTokenEnv(teamDomain);
    const token = await new SignJWT({
      type: 'app',
      common_name: 'deploy-verify-token.access',
      aud: 'test-aud',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer(`https://${teamDomain}`)
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(keyPair.privateKey);

    const mf = makeMiniflare(
      { CF_ACCESS_TEAM_DOMAIN: teamDomain, CF_ACCESS_AUD: 'test-aud' },
      mockAgent,
    );
    try {
      const res = await mf.dispatchFetch('http://app/api/manifest', {
        headers: { Cookie: `CF_Authorization=${token}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await mf.dispose();
    }
  });
});
