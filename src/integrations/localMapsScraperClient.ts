import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

export interface LocalMapsScraperOptions {
  maxPolls?: number;
  pollIntervalMs?: number;
}

export interface ScraperResult {
  title: string;
  address?: string;
  phone?: string;
  website?: string;
  category?: string;
  rating?: number;
  reviewsCount?: number;
  placeId?: string;
}

export class LocalMapsScraperKitClient {
  private maxPolls: number;
  private pollIntervalMs: number;

  constructor(options: LocalMapsScraperOptions = {}) {
    this.maxPolls = options.maxPolls ?? 120;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
  }

  async scrape(options: {
    searchString: string;
    coordinates?: string;
    maxResults?: number;
    proxyUrls?: string[];
  }): Promise<ScraperResult[]> {
    const {
      searchString,
      coordinates,
      maxResults = 100,
      proxyUrls,
    } = options;

    const args: string[] = [
      '--search', searchString,
      '--max-results', String(maxResults),
    ];

    if (coordinates) {
      args.push('--coordinates', coordinates);
    }

    if (proxyUrls && proxyUrls.length > 0) {
      args.push('--proxy', proxyUrls[0]);
    }

    const scraperPaths = [
      path.join(process.cwd(), 'scripts', 'google-maps-scraper'),
      path.join(process.cwd(), 'google-maps-scraper'),
      path.join(__dirname, '..', '..', 'scripts', 'google-maps-scraper'),
    ];

    const scraperPath = scraperPaths.find(p => fs.existsSync(p));

    if (!scraperPath) {
      console.warn('[LocalMapsScraper] Binary not found, returning empty results');
      return [];
    }

    return new Promise((resolve, reject) => {
      const results: ScraperResult[] = [];
      const child = spawn(scraperPath, args, {
        cwd: process.cwd(),
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code !== 0 && code !== null) {
          console.error(`[LocalMapsScraper] Exit code ${code}: ${stderr}`);
          resolve([]);
          return;
        }

        try {
          const parsed = JSON.parse(stdout);
          if (Array.isArray(parsed)) {
            resolve(parsed.map((item: any) => this.normalizeResult(item)));
          } else {
            resolve([]);
          }
        } catch {
          resolve([]);
        }
      });

      child.on('error', (err) => {
        console.error('[LocalMapsScraper] Spawn error:', err.message);
        resolve([]);
      });

      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGTERM');
          resolve([]);
        }
      }, this.maxPolls * this.pollIntervalMs);
    });
  }

  private normalizeResult(item: any): ScraperResult {
    return {
      title: item.title || item.name || 'Unknown Business',
      address: item.address || item.formattedAddress,
      phone: item.phone || item.phoneNumber,
      website: item.website || item.url,
      category: item.category || item.type,
      rating: item.rating ? parseFloat(item.rating) : undefined,
      reviewsCount: item.reviewsCount ? parseInt(item.reviewsCount, 10) : undefined,
      placeId: item.placeId || item.place_id,
    };
  }
}

// Export class directly, no const alias collision
export { LocalMapsScraperKitClient as LocalMapsScraperClient };
