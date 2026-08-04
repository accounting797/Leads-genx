type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function decodeHtml(value: string): string {
  return value.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}

function resultUrl(href: string): string | undefined {
  try {
    const url = new URL(decodeHtml(href), 'https://duckduckgo.com');
    const redirected = url.hostname.endsWith('duckduckgo.com') ? url.searchParams.get('uddg') : undefined;
    const result = redirected ? new URL(redirected) : url;
    if (result.protocol !== 'http:' && result.protocol !== 'https:') return undefined;
    if (result.hostname.endsWith('duckduckgo.com')) return undefined;
    result.hash = '';
    return result.toString();
  } catch {
    return undefined;
  }
}

const DOCUMENT_PATH = /\.(?:pdf|xls|xlsx|csv|tsv|docx|txt)$/i;

export function discoverPublicDocumentLinks(html: string, baseUrl: string, limit = 50): string[] {
  const links: string[] = [];
  for (const match of html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const url = new URL(decodeHtml(match[1]), baseUrl);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !DOCUMENT_PATH.test(url.pathname)) continue;
      url.hash = '';
      const normalized = url.toString();
      if (!links.includes(normalized)) links.push(normalized);
      if (links.length >= Math.min(100, Math.max(1, limit))) break;
    } catch {
      // Ignore malformed document links.
    }
  }
  return links;
}

export class PublicWebSearchClient {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async search(query: string, limit = 20): Promise<string[]> {
    const url = new URL('https://html.duckduckgo.com/html/');
    url.searchParams.set('q', query.slice(0, 1_500));
    const response = await this.fetcher(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Leads-GenX/1.0; public-business-research)' },
    });
    if (!response.ok) throw new Error(`Public web search failed with HTTP ${response.status}.`);
    if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
      throw new Error('Public web search did not return HTML.');
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > 2 * 1024 * 1024) throw new Error('Public web search response exceeded 2 MB.');
    const html = await response.text();
    if (Buffer.byteLength(html, 'utf8') > 2 * 1024 * 1024) throw new Error('Public web search response exceeded 2 MB.');
    const urls: string[] = [];
    for (const match of html.matchAll(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["']/gi)) {
      const result = resultUrl(match[1]);
      if (result && !urls.includes(result)) urls.push(result);
      if (urls.length >= Math.min(50, Math.max(1, limit))) break;
    }
    return urls;
  }
}
