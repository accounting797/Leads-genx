import { describe, expect, it, vi } from 'vitest';
import { fetchPublicArtifact } from '../../../src/domain/targeted/artifactFetcher';

describe('fetchPublicArtifact', () => {
  const publicResolver = async () => [{ address: '93.184.216.34', family: 4 as const }];

  it('downloads a bounded public artifact', async () => {
    const fetcher = vi.fn(async () => new Response('contact sales@acme.example', {
      status: 200, headers: { 'content-type': 'text/plain', 'content-length': '26' },
    }));
    const artifact = await fetchPublicArtifact('https://acme.example/contacts.txt', {
      fetcher, resolver: publicResolver, maxBytes: 1024,
    });
    expect(artifact).toMatchObject({ finalUrl: 'https://acme.example/contacts.txt', contentType: 'text/plain', byteCount: 26 });
    expect(artifact.body.toString()).toContain('sales@acme.example');
  });

  it('rejects localhost and private targets before fetching', async () => {
    const fetcher = vi.fn();
    await expect(fetchPublicArtifact('http://localhost/contacts.csv', { fetcher })).rejects.toMatchObject({ code: 'private_address' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('revalidates redirect targets and blocks a redirect to private space', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private.csv' } }));
    await expect(fetchPublicArtifact('https://acme.example/contacts.csv', {
      fetcher, resolver: publicResolver,
    })).rejects.toMatchObject({ code: 'private_address' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects an artifact whose declared size exceeds the limit', async () => {
    const fetcher = vi.fn(async () => new Response('small', {
      status: 200, headers: { 'content-type': 'text/plain', 'content-length': '2000' },
    }));
    await expect(fetchPublicArtifact('https://acme.example/large.txt', {
      fetcher, resolver: publicResolver, maxBytes: 100,
    })).rejects.toMatchObject({ code: 'artifact_too_large' });
  });
});
