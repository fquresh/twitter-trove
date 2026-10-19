// fetch credentials mode: 'include' only in cloud/proxy mode. The local wiki
// server does not allow credentialed CORS, so 'include' would break sync there.
import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stubFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ root_files: {}, html_files: [] }),
      } as unknown as Response;
    }),
  );
  return calls;
}

describe('sync fetch credentials', () => {
  it('local mode does not send credentials', async () => {
    vi.stubEnv('VITE_USE_API_PROXY', 'false');
    vi.resetModules();
    const mod = await import('../lib/syncFromDisk');
    const calls = stubFetch();
    await mod.fetchManifest('http://localhost:8765');
    expect(mod.fetchCredentials()).toBe('omit');
    expect(calls[0].url).toBe('http://localhost:8765/api/data/manifest');
    expect(calls[0].init?.credentials).toBe('omit');
  });

  it('proxy mode keeps credentials: include', async () => {
    vi.stubEnv('VITE_USE_API_PROXY', 'true');
    vi.resetModules();
    const mod = await import('../lib/syncFromDisk');
    const calls = stubFetch();
    await mod.fetchManifest();
    expect(mod.fetchCredentials()).toBe('include');
    expect(calls[0].url).toBe('/api/manifest');
    expect(calls[0].init?.credentials).toBe('include');
  });
});
