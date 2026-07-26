import { lookup as dnsLookup } from 'dns/promises';
import { request as httpsRequest } from 'https';
import { isIP } from 'net';
import { Readable } from 'stream';

export class SafeWebsiteError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'SafeWebsiteError';
  }
}

interface LookupAddress {
  address: string;
  family: number;
}

export interface PinnedWebsiteConnection {
  address: string;
  family: 4 | 6;
  servername: string;
}

export interface SafeWebsiteFetcherOptions {
  fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
    connection?: PinnedWebsiteConnection
  ) => Promise<Response>;
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  maxBytes?: number;
}

const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 1_048_576;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function unsafeIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function unsafeIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    return isIP(mapped) !== 4 || unsafeIpv4(mapped);
  }
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:')
  );
}

function isUnsafeAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return unsafeIpv4(address);
  if (family === 6) return unsafeIpv6(address);
  return true;
}

function parseSafeHttpsUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeWebsiteError('Website URL is invalid.', 'unsafe_website_url');
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
    throw new SafeWebsiteError('Website URL must be a public HTTPS address.', 'unsafe_website_url');
  }
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal) && isUnsafeAddress(literal)) {
    throw new SafeWebsiteError('Website URL points to a private address.', 'unsafe_website_url');
  }
  return url;
}

async function validateResolution(
  url: URL,
  lookup: (hostname: string) => Promise<LookupAddress[]>
): Promise<Omit<PinnedWebsiteConnection, 'servername'>> {
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(literal);
  const addresses: LookupAddress[] = literalFamily
    ? [{ address: literal, family: literalFamily as 4 | 6 }]
    : await lookup(url.hostname);
  if (!addresses.length || addresses.some((entry) => isUnsafeAddress(entry.address))) {
    throw new SafeWebsiteError('Website hostname resolves to a private address.', 'unsafe_website_url');
  }
  const selected = addresses[0];
  return { address: selected.address, family: isIP(selected.address) as 4 | 6 };
}

async function pinnedHttpsFetch(
  input: string | URL | Request,
  init: RequestInit | undefined,
  connection: PinnedWebsiteConnection
): Promise<Response> {
  const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  return new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? 'GET',
        headers,
        signal: init?.signal ?? undefined,
        servername: connection.servername,
        family: connection.family,
        lookup: (_hostname, _options, callback) => {
          callback(null, connection.address, connection.family);
        },
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(name, item);
          } else if (value !== undefined) {
            responseHeaders.set(name, value);
          }
        }
        const status = incoming.statusCode ?? 500;
        const bodyAllowed = status !== 204 && status !== 205 && status !== 304;
        if (!bodyAllowed) incoming.resume();
        resolve(
          new Response(
            bodyAllowed ? (Readable.toWeb(incoming) as unknown as BodyInit) : null,
            {
              status,
              statusText: incoming.statusMessage,
              headers: responseHeaders,
            }
          )
        );
      }
    );
    request.once('error', reject);
    request.end();
  });
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new SafeWebsiteError('Website response is too large.', 'response_too_large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SafeWebsiteError('Website response is too large.', 'response_too_large');
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(joined);
}

export async function safeFetchWebsite(
  rawUrl: string,
  options: SafeWebsiteFetcherOptions = {}
): Promise<{ finalUrl: string; html: string }> {
  const fetchImpl = options.fetchImpl ?? pinnedHttpsFetch;
  const lookup = options.lookup ?? ((hostname) => dnsLookup(hostname, { all: true }));
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let current = parseSafeHttpsUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const pinnedAddress = await validateResolution(current, lookup);
    const response = await fetchImpl(
      current,
      {
        redirect: 'manual',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Leads-GenX-Hiring-Signals/1.0',
        },
        signal: AbortSignal.timeout(8_000),
      },
      {
        ...pinnedAddress,
        servername: current.hostname,
      }
    );

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new SafeWebsiteError('Website redirected too many times.', 'redirect_limit');
      }
      current = parseSafeHttpsUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) {
      throw new SafeWebsiteError(`Website returned HTTP ${response.status}.`, 'website_unavailable');
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('text/html') && !contentType.startsWith('application/xhtml+xml')) {
      throw new SafeWebsiteError('Website did not return HTML.', 'unsupported_content_type');
    }
    return { finalUrl: current.toString(), html: await readBoundedBody(response, maxBytes) };
  }
  throw new SafeWebsiteError('Website redirected too many times.', 'redirect_limit');
}
