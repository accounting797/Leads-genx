export interface WebSearchResult {
  title: string;
  link: string;
  snippet: string;
  displayUrl?: string;
}

export interface PublicWebSearchOptions {
  query: string;
  maxResults?: number;
  timeoutMs?: number;
  retries?: number;
}

export class PublicWebSearchClient {
  private readonly defaultTimeoutMs = 15000;
  private readonly defaultRetries = 2;
  private readonly userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  ];

  async search(options: PublicWebSearchOptions): Promise<WebSearchResult[]> {
    const {
      query,
      maxResults = 10,
      timeoutMs = this.defaultTimeoutMs,
      retries = this.defaultRetries,
    } = options;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const results = await this.executeSearch(query, maxResults, timeoutMs, attempt);
        if (results.length > 0) {
          return results;
        }
        return [];
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`[PublicWebSearch] Attempt ${attempt + 1}/${retries + 1} failed: ${lastError.message}`);

        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        }
      }
    }

    throw new Error(`Public web search failed after ${retries + 1} attempts: ${lastError?.message}`);
  }

  private async executeSearch(
    query: string, 
    maxResults: number, 
    timeoutMs: number,
    attempt: number
  ): Promise<WebSearchResult[]> {
    const userAgent = this.userAgents[attempt % this.userAgents.length];

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const encodedQuery = encodeURIComponent(query);
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

      const response = await fetch(searchUrl, {
        method: 'GET',
        headers: {
          'User-Agent': userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'DNT': '1',
          'Connection': 'keep-alive',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      return this.parseSearchResults(html, maxResults);
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  private parseSearchResults(html: string, maxResults: number): WebSearchResult[] {
    const results: WebSearchResult[] = [];
    const resultRegex = /<a rel="nofollow" class="result__a" href="([^"]+)">(.*?)<\/a>.*?<a class="result__snippet"[^>]*>(.*?)<\/a>/gs;
    let match;

    while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
      const link = this.extractHref(match[1]);
      const title = this.stripHtml(match[2]);
      const snippet = this.stripHtml(match[3]);

      if (link && title) {
        results.push({
          title: title.trim(),
          link: link.trim(),
          snippet: snippet.trim(),
          displayUrl: new URL(link).hostname.replace('www.', ''),
        });
      }
    }

    return results;
  }

  private extractHref(href: string): string {
    if (href.includes('duckduckgo.com/l/')) {
      const match = href.match(/uddg=([^&]+)/);
      if (match) {
        try {
          return decodeURIComponent(match[1]);
        } catch {
          return href;
        }
      }
    }
    return href;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x27;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
