import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ProxyRotatorConfig {
  zone?: string;
  customerZoneId?: string;
  maxConsecutiveFailures?: number;
  cooldownMs?: number;
  rotateOnFailure?: boolean;
}

export interface ProxyRotator {
  getNextProxy(): Promise<string | null>;
  reportFailure(proxy: string, error?: string): void;
  reportSuccess(proxy: string): void;
  getStats(): { total: number; healthy: number; failed: number };
}

interface ProxyEntry {
  url: string;
  consecutiveFailures: number;
  cooldownUntil: number;
}

function buildProxyUrl(zone: string, customerZoneId: string, index: number): string {
  const suffix = customerZoneId ? `-${customerZoneId}` : '';
  return `http://brd.superproxy.io:33335`;
}

function buildProxyUrlWithSession(zone: string, customerZoneId: string, sessionId: number): string {
  const user = customerZoneId ? `brd-customer-${customerZoneId}` : `brd-z-${zone}`;
  const pass = 'brd-customer-' + (customerZoneId || zone);
  return `http://${user}-zone-${zone}-session-${sessionId}:brd-customer-${customerZoneId || zone}@brd.superproxy.io:33335`;
}

export function createProxyRotator(config: ProxyRotatorConfig = {}): ProxyRotator {
  const zone = config.zone ?? process.env.BRIGHTDATA_ZONE ?? 'datacenter';
  const customerZoneId = config.customerZoneId ?? process.env.BRIGHTDATA_CUSTOMER_ZONE_ID ?? '';
  const maxConsecutiveFailures = config.maxConsecutiveFailures ?? 3;
  const cooldownMs = config.cooldownMs ?? 30_000;
  const rotateOnFailure = config.rotateOnFailure ?? true;

  const proxies: ProxyEntry[] = [];
  let currentIndex = 0;
  let sessionCounter = 0;
  let initialized = false;

  async function discoverProxies(): Promise<void> {
    if (initialized) return;
    initialized = true;

    try {
      const { stdout } = await execFileAsync('brightdata', ['zones'], {
        timeout: 15_000,
        encoding: 'utf-8',
      });

      const lines = stdout.split('\n').filter(Boolean);
      const zoneLine = lines.find(
        (line) =>
          line.toLowerCase().includes(zone.toLowerCase()) ||
          line.toLowerCase().includes('datacenter') ||
          line.toLowerCase().includes('residential')
      );

      if (zoneLine) {
        const parts = zoneLine.split(/\s+/);
        const zoneId = parts[0]?.trim();
        if (zoneId) {
          proxies.push(
            ...Array.from({ length: 5 }, (_, i) => ({
              url: `http://brd-customer-${customerZoneId || zoneId}-zone-${zoneId}-session-${i + 1}@brd.superproxy.io:33335`,
              consecutiveFailures: 0,
              cooldownUntil: 0,
            }))
          );
          return;
        }
      }
    } catch {
      // Bright Data CLI not available; fall back to env-configured proxies
    }

    if (!proxies.length) {
      const envProxies = process.env.BRIGHTDATA_PROXY_URLS;
      if (envProxies) {
        const urls = envProxies
          .split(/[\s,]+/)
          .map((u) => u.trim())
          .filter(Boolean);
        for (const url of urls) {
          proxies.push({ url, consecutiveFailures: 0, cooldownUntil: 0 });
        }
      }
    }

    if (!proxies.length) {
      const baseUser = customerZoneId ? `brd-customer-${customerZoneId}` : 'brd-z-datacenter';
      const basePass = customerZoneId ? `brd-customer-${customerZoneId}` : 'brd-customer-datacenter';
      for (let i = 1; i <= 5; i++) {
        proxies.push({
          url: `http://${baseUser}-zone-datacenter-session-${i}:${basePass}@brd.superproxy.io:33335`,
          consecutiveFailures: 0,
          cooldownUntil: 0,
        });
      }
    }
  }

  function isHealthy(entry: ProxyEntry): boolean {
    if (entry.consecutiveFailures >= maxConsecutiveFailures) {
      if (Date.now() < entry.cooldownUntil) return false;
      entry.consecutiveFailures = 0;
      entry.cooldownUntil = 0;
    }
    return true;
  }

  return {
    async getNextProxy(): Promise<string | null> {
      await discoverProxies();

      if (!proxies.length) return null;

      const start = currentIndex;
      for (let i = 0; i < proxies.length; i++) {
        const idx = (start + i) % proxies.length;
        const entry = proxies[idx];
        if (isHealthy(entry)) {
          currentIndex = (idx + 1) % proxies.length;
          return entry.url;
        }
      }

      const leastFailed = proxies.reduce((best, entry) =>
        entry.consecutiveFailures < best.consecutiveFailures ? entry : best
      );
      leastFailed.consecutiveFailures = 0;
      leastFailed.cooldownUntil = 0;
      return leastFailed.url;
    },

    reportFailure(proxy: string, error?: string): void {
      const entry = proxies.find((p) => p.url === proxy);
      if (!entry) return;

      entry.consecutiveFailures += 1;
      if (entry.consecutiveFailures >= maxConsecutiveFailures) {
        entry.cooldownUntil = Date.now() + cooldownMs;
      }
    },

    reportSuccess(proxy: string): void {
      const entry = proxies.find((p) => p.url === proxy);
      if (entry) {
        entry.consecutiveFailures = 0;
        entry.cooldownUntil = 0;
      }
    },

    getStats() {
      const total = proxies.length;
      const healthy = proxies.filter(isHealthy).length;
      const failed = total - healthy;
      return { total, healthy, failed };
    },
  };
}
