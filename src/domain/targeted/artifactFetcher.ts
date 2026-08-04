import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface FetchedArtifact {
  finalUrl: string;
  contentType: string;
  byteCount: number;
  body: Buffer;
}

export class ArtifactFetchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ArtifactFetchError';
  }
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface ArtifactFetchOptions {
  fetcher?: Fetcher;
  resolver?: Resolver;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

function privateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0 && c === 113);
}

function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  const version = isIP(normalized);
  if (version === 4) return privateIpv4(normalized);
  if (version !== 6) return true;
  if (normalized.startsWith('::ffff:')) return privateIpv4(normalized.slice(7));
  return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized) || normalized.startsWith('2001:db8');
}

async function defaultResolver(hostname: string): Promise<Array<{ address: string; family: number }>> {
  return lookup(hostname, { all: true, verbatim: true });
}

async function validatePublicUrl(url: URL, resolver: Resolver): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ArtifactFetchError('unsupported_protocol', 'Only HTTP(S) public artifacts are supported.');
  if (url.username || url.password) throw new ArtifactFetchError('credentialed_url', 'Artifact URLs cannot contain credentials.');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new ArtifactFetchError('private_address', 'Private and localhost artifact targets are not allowed.');
  }
  const directIp = isIP(hostname);
  const addresses = directIp ? [{ address: hostname, family: directIp }] : await resolver(hostname);
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) {
    throw new ArtifactFetchError('private_address', 'Private and reserved artifact targets are not allowed.');
  }
}

async function boundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ArtifactFetchError('artifact_too_large', `Artifact exceeded the ${maxBytes}-byte limit.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

export async function fetchPublicArtifact(urlValue: string, options: ArtifactFetchOptions = {}): Promise<FetchedArtifact> {
  const fetcher = options.fetcher ?? fetch;
  const resolver = options.resolver ?? defaultResolver;
  const maxBytes = options.maxBytes ?? 15 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 5;
  let current: URL;
  try { current = new URL(urlValue); } catch { throw new ArtifactFetchError('invalid_url', 'Artifact URL is invalid.'); }

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    await validatePublicUrl(current, resolver);
    const response = await fetcher(current, {
      redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      headers: { 'user-agent': 'Leads-GenX/1.0 public-document-research' },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new ArtifactFetchError('redirect_without_location', 'Artifact redirect had no location.');
      if (redirect === maxRedirects) throw new ArtifactFetchError('too_many_redirects', 'Artifact exceeded the redirect limit.');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new ArtifactFetchError('http_error', `Artifact request failed with HTTP ${response.status}.`);
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > maxBytes) throw new ArtifactFetchError('artifact_too_large', `Artifact exceeded the ${maxBytes}-byte limit.`);
    const body = await boundedBody(response, maxBytes);
    return {
      finalUrl: current.toString(), contentType: (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].toLowerCase(),
      byteCount: body.length, body,
    };
  }
  throw new ArtifactFetchError('too_many_redirects', 'Artifact exceeded the redirect limit.');
}
