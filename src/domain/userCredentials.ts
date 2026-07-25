import type { PrismaClient } from '@prisma/client';
import { maskProxyUrl, SECRET_MASK } from './operatorSettings';

/**
 * BYOD — "Bring Your Own Details".
 *
 * Optional per-user credentials. When a user saves their own Apify token,
 * Google keys, or proxies, their runs consume THEIR quota instead of the
 * admin's shared pool. Stored as one AppSetting row per user — no schema
 * migration required. Tier gating still applies: BYOD changes whose keys
 * are used, never which output modes a plan allows.
 */

export interface UserCredentials {
  apifyToken?: string;
  brightDataApiKey?: string;
  googleApiKeys: string[];
  proxyUrls: string[];
}

export interface SafeUserCredentials {
  hasCredentials: boolean;
  apifyTokenSet: boolean;
  brightDataKeySet: boolean;
  brightDataKeyPreview?: string;
  googleApiKeyCount: number;
  proxyCount: number;
  apifyTokenPreview?: string;
  proxyPreviews: string[];
}

type SettingsPrisma = Pick<PrismaClient, 'appSetting'>;

export function userCredsKey(userId: number): string {
  return `userCreds:${userId}`;
}

export function emptyUserCredentials(): UserCredentials {
  return { googleApiKeys: [], proxyUrls: [] };
}

export async function loadUserCredentials(prisma: SettingsPrisma | undefined, userId: number): Promise<UserCredentials> {
  if (!prisma?.appSetting) return emptyUserCredentials();
  const row = await prisma.appSetting.findUnique({ where: { key: userCredsKey(userId) } });
  if (!row) return emptyUserCredentials();
  try {
    const parsed = JSON.parse(row.value) as Partial<UserCredentials>;
    return {
      apifyToken: typeof parsed.apifyToken === 'string' && parsed.apifyToken ? parsed.apifyToken : undefined,
      brightDataApiKey:
        typeof parsed.brightDataApiKey === 'string' && parsed.brightDataApiKey ? parsed.brightDataApiKey : undefined,
      googleApiKeys: Array.isArray(parsed.googleApiKeys) ? parsed.googleApiKeys.map(String).filter(Boolean) : [],
      proxyUrls: Array.isArray(parsed.proxyUrls) ? parsed.proxyUrls.map(String).filter(Boolean) : [],
    };
  } catch {
    return emptyUserCredentials();
  }
}

export function hasUserCredentials(creds: UserCredentials): boolean {
  return Boolean(creds.apifyToken || creds.brightDataApiKey || creds.googleApiKeys.length || creds.proxyUrls.length);
}

export interface UserCredentialsWrite {
  apifyToken?: string;
  brightDataApiKey?: string;
  googleApiKeys?: string[];
  proxyUrls?: string[];
}

export async function saveUserCredentials(
  prisma: SettingsPrisma,
  userId: number,
  write: UserCredentialsWrite
): Promise<void> {
  const current = await loadUserCredentials(prisma, userId);
  const unmaskProxy = (incoming: string): string => {
    if (!incoming.includes(SECRET_MASK)) return incoming;
    const match = current.proxyUrls.find((stored) => maskProxyUrl(stored) === incoming);
    return match ?? incoming;
  };
  const next: UserCredentials = {
    apifyToken: write.apifyToken !== undefined ? write.apifyToken.trim() || undefined : current.apifyToken,
    brightDataApiKey:
      write.brightDataApiKey !== undefined ? write.brightDataApiKey.trim() || undefined : current.brightDataApiKey,
    googleApiKeys: write.googleApiKeys !== undefined ? write.googleApiKeys : current.googleApiKeys,
    proxyUrls: write.proxyUrls !== undefined ? write.proxyUrls.map(unmaskProxy) : current.proxyUrls,
  };
  const key = userCredsKey(userId);
  if (!hasUserCredentials(next)) {
    await prisma.appSetting.deleteMany({ where: { key } });
    return;
  }
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(next), secret: true },
    update: { value: JSON.stringify(next), secret: true },
  });
}

export function toSafeUserCredentials(creds: UserCredentials): SafeUserCredentials {
  return {
    hasCredentials: hasUserCredentials(creds),
    apifyTokenSet: Boolean(creds.apifyToken),
    brightDataKeySet: Boolean(creds.brightDataApiKey),
    brightDataKeyPreview: creds.brightDataApiKey ? `••••${creds.brightDataApiKey.slice(-4)}` : undefined,
    googleApiKeyCount: creds.googleApiKeys.length,
    proxyCount: creds.proxyUrls.length,
    apifyTokenPreview: creds.apifyToken ? `••••${creds.apifyToken.slice(-4)}` : undefined,
    proxyPreviews: creds.proxyUrls.map(maskProxyUrl),
  };
}

/** IDs of every user with BYOD credentials saved (for admin badges). */
export async function listByodUserIds(prisma: SettingsPrisma): Promise<Set<number>> {
  if (!prisma?.appSetting) return new Set();
  const rows = await prisma.appSetting.findMany({
    where: { key: { startsWith: 'userCreds:' } },
    select: { key: true },
  });
  const ids = new Set<number>();
  for (const row of rows) {
    const id = Number(row.key.slice('userCreds:'.length));
    if (Number.isFinite(id)) ids.add(id);
  }
  return ids;
}
