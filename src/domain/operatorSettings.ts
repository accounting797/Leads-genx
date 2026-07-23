import { PrismaClient } from '@prisma/client';

export const OPERATOR_SETTING_KEYS = [
  'defaultGoogleMapsActorId',
  'defaultSalesNavigatorActorId',
  'apifyToken',
  'googleApiKeys',
  'proxyUrls',
] as const;

export type OperatorSettingKey = (typeof OPERATOR_SETTING_KEYS)[number];

const SECRET_KEYS = new Set<OperatorSettingKey>(['apifyToken', 'googleApiKeys', 'proxyUrls']);
const LIST_KEYS = new Set<OperatorSettingKey>(['googleApiKeys', 'proxyUrls']);

export const SECRET_MASK = '••••••';

export interface OperatorSettings {
  defaultGoogleMapsActorId?: string;
  defaultSalesNavigatorActorId?: string;
  apifyToken?: string;
  googleApiKeys: string[];
  proxyUrls: string[];
}

export interface OperatorSettingsWrite {
  defaultGoogleMapsActorId?: string;
  defaultSalesNavigatorActorId?: string;
  apifyToken?: string;
  googleApiKeys?: string[];
  proxyUrls?: string[];
}

export interface SafeOperatorSettings {
  defaultGoogleMapsActorId: string;
  defaultSalesNavigatorActorId: string;
  hasSavedApifyToken: boolean;
  hasSavedGoogleApiKeys: boolean;
  googleApiKeyCount: number;
  proxyCount: number;
  proxies: string[];
}

type AppSettingDelegate = {
  findMany(args?: unknown): Promise<Array<{ key: string; value: string }>>;
  upsert(args: unknown): Promise<unknown>;
  deleteMany(args: unknown): Promise<unknown>;
};

type SettingsPrisma = Pick<PrismaClient, 'appSetting'> | { appSetting: AppSettingDelegate };

/**
 * Accepts the common vendor formats and normalizes them to full URLs:
 *   host:port                 -> http://host:port
 *   host:port:user:pass       -> http://user:pass@host:port
 *   user:pass@host:port       -> http://user:pass@host:port
 * Lines that already include a scheme (http://, https://, socks5://, socks5h://)
 * are returned unchanged.
 */
export function normalizeProxyLine(line: string): string {
  let raw = line.trim();
  if (!raw || raw.includes(SECRET_MASK)) return raw;

  // Forgive common scheme typos like "socks5h//:host" or "http//:host".
  raw = raw.replace(/^([a-z][a-z0-9]*)\s*\/\/\s*:/i, '$1://');

  const schemeMatch = raw.match(/^([a-z][a-z0-9]*):\/\//i);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : 'http';
  const rest = schemeMatch ? raw.slice(schemeMatch[0].length) : raw;

  if (rest.includes('@')) return `${scheme}://${rest}`;

  const parts = rest.split(':');
  if (parts.length >= 4) {
    const [host, port, user, ...pass] = parts;
    return `${scheme}://${user}:${pass.join(':')}@${host}:${port}`;
  }
  if (parts.length === 2 || parts.length === 3) return `${scheme}://${rest}`;
  return raw;
}

export function maskProxyUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (!url.username && !url.password) return rawUrl;
    const auth = `${decodeURIComponent(url.username)}:${SECRET_MASK}@`;
    const port = url.port ? `:${url.port}` : '';
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.protocol}//${auth}${url.hostname}${port}${path}`;
  } catch {
    return SECRET_MASK;
  }
}

function unmaskProxyUrl(incoming: string, stored: string[]): string {
  if (!incoming.includes(SECRET_MASK)) return incoming;
  const match = stored.find((candidate) => maskProxyUrl(candidate) === incoming);
  return match ?? incoming;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function loadOperatorSettings(prisma?: SettingsPrisma): Promise<OperatorSettings> {
  const empty: OperatorSettings = { googleApiKeys: [], proxyUrls: [] };
  if (!prisma) return empty;
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: [...OPERATOR_SETTING_KEYS] } },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  return {
    defaultGoogleMapsActorId: byKey.get('defaultGoogleMapsActorId') || undefined,
    defaultSalesNavigatorActorId: byKey.get('defaultSalesNavigatorActorId') || undefined,
    apifyToken: byKey.get('apifyToken') || undefined,
    googleApiKeys: parseList(byKey.get('googleApiKeys')),
    proxyUrls: parseList(byKey.get('proxyUrls')),
  };
}

export async function saveOperatorSettings(
  prisma: SettingsPrisma,
  write: OperatorSettingsWrite
): Promise<void> {
  const stored = await loadOperatorSettings(prisma);
  const entries: Array<{ key: OperatorSettingKey; value: string | undefined }> = [];

  if (write.defaultGoogleMapsActorId !== undefined) {
    entries.push({ key: 'defaultGoogleMapsActorId', value: write.defaultGoogleMapsActorId.trim() || undefined });
  }
  if (write.defaultSalesNavigatorActorId !== undefined) {
    entries.push({ key: 'defaultSalesNavigatorActorId', value: write.defaultSalesNavigatorActorId.trim() || undefined });
  }
  if (write.apifyToken !== undefined) {
    entries.push({ key: 'apifyToken', value: write.apifyToken.trim() || undefined });
  }
  if (write.googleApiKeys !== undefined) {
    entries.push({
      key: 'googleApiKeys',
      value: write.googleApiKeys.length ? JSON.stringify(write.googleApiKeys) : undefined,
    });
  }
  if (write.proxyUrls !== undefined) {
    const merged = write.proxyUrls.map((proxy) => unmaskProxyUrl(proxy, stored.proxyUrls));
    entries.push({ key: 'proxyUrls', value: merged.length ? JSON.stringify(merged) : undefined });
  }

  for (const entry of entries) {
    if (entry.value === undefined) {
      await prisma.appSetting.deleteMany({ where: { key: entry.key } });
    } else {
      await prisma.appSetting.upsert({
        where: { key: entry.key },
        create: { key: entry.key, value: entry.value, secret: SECRET_KEYS.has(entry.key) },
        update: { value: entry.value, secret: SECRET_KEYS.has(entry.key) },
      });
    }
  }
}

export function toSafeOperatorSettings(
  settings: OperatorSettings,
  defaults: { googleMapsActorId: string; salesNavigatorActorId: string }
): SafeOperatorSettings {
  return {
    defaultGoogleMapsActorId: settings.defaultGoogleMapsActorId || defaults.googleMapsActorId,
    defaultSalesNavigatorActorId: settings.defaultSalesNavigatorActorId || defaults.salesNavigatorActorId,
    hasSavedApifyToken: Boolean(settings.apifyToken),
    hasSavedGoogleApiKeys: settings.googleApiKeys.length > 0,
    googleApiKeyCount: settings.googleApiKeys.length,
    proxyCount: settings.proxyUrls.length,
    proxies: settings.proxyUrls.map(maskProxyUrl),
  };
}

export interface CredentialCarrier {
  googleApiKey?: string;
  googleApiKeys?: string[];
  apifyToken?: string;
  apifyTokens?: string[];
  proxyUrls?: string[];
  routeMode?: string;
}

export function withSavedCredentials<T extends CredentialCarrier>(input: T, settings: OperatorSettings): T {
  const merged = { ...input };
  if (!merged.googleApiKey && settings.googleApiKeys.length) {
    merged.googleApiKey = settings.googleApiKeys[0];
    merged.googleApiKeys = settings.googleApiKeys;
  }
  if (!merged.apifyToken && settings.apifyToken) {
    merged.apifyToken = settings.apifyToken;
    merged.apifyTokens = [settings.apifyToken];
  }
  if (merged.routeMode === 'proxy' && !merged.proxyUrls?.length && settings.proxyUrls.length) {
    merged.proxyUrls = settings.proxyUrls;
  }
  return merged;
}
