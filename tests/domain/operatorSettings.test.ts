import { describe, expect, it } from 'vitest';
import {
  loadOperatorSettings,
  maskProxyUrl,
  normalizeProxyLine,
  saveOperatorSettings,
  toSafeOperatorSettings,
  withSavedCredentials,
} from '../../src/domain/operatorSettings';

function fakeSettingsStore(seed: Record<string, string> = {}) {
  const rows = new Map(Object.entries(seed));
  const appSetting = {
    async findMany() {
      return Array.from(rows.entries()).map(([key, value]) => ({ key, value }));
    },
    async upsert(args: { where: { key: string }; create: { value: string } }) {
      rows.set(args.where.key, args.create.value);
    },
    async deleteMany(args: { where: { key: string } }) {
      rows.delete(args.where.key);
    },
  };
  return { appSetting, rows };
}

describe('normalizeProxyLine', () => {
  it('converts common vendor formats to full URLs', () => {
    expect(normalizeProxyLine('45.95.32.10:8080')).toBe('http://45.95.32.10:8080');
    expect(normalizeProxyLine('45.95.32.10:8080:user123:pass456')).toBe(
      'http://user123:pass456@45.95.32.10:8080'
    );
    expect(normalizeProxyLine('user123:pass456@45.95.32.10:8080')).toBe(
      'http://user123:pass456@45.95.32.10:8080'
    );
  });

  it('rearranges scheme-prefixed vendor lines', () => {
    expect(normalizeProxyLine('https://23.142.16.175:4000:john:h3d7n5r1p8s')).toBe(
      'https://john:h3d7n5r1p8s@23.142.16.175:4000'
    );
    expect(normalizeProxyLine('socks5h://23.142.16.175:4000:john:p4ss')).toBe(
      'socks5h://john:p4ss@23.142.16.175:4000'
    );
  });

  it('forgives mistyped scheme separators', () => {
    expect(normalizeProxyLine('socks5h//:23.142.16.175:4000:john:p4ss')).toBe(
      'socks5h://john:p4ss@23.142.16.175:4000'
    );
  });

  it('leaves full URLs and masked entries untouched', () => {
    expect(normalizeProxyLine('socks5h://u:p@127.0.0.1:60001')).toBe('socks5h://u:p@127.0.0.1:60001');
    expect(normalizeProxyLine('http://u:••••••@127.0.0.1:60001')).toBe('http://u:••••••@127.0.0.1:60001');
    expect(normalizeProxyLine('')).toBe('');
  });
});

describe('maskProxyUrl', () => {
  it('masks credentials but keeps scheme, host, and port visible', () => {
    expect(maskProxyUrl('socks5h://operator:supersecret@127.0.0.1:60001')).toBe(
      'socks5h://operator:••••••@127.0.0.1:60001'
    );
    expect(maskProxyUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(maskProxyUrl('not a url')).toBe('••••••');
  });
});

describe('saveOperatorSettings / loadOperatorSettings', () => {
  it('persists lists and secrets, and clears them on empty input', async () => {
    const store = fakeSettingsStore();

    await saveOperatorSettings(store, {
      apifyToken: 'apify-secret',
      googleApiKeys: ['key-one', 'key-two'],
      proxyUrls: ['socks5h://operator:supersecret@127.0.0.1:60001'],
    });

    const saved = await loadOperatorSettings(store);
    expect(saved.apifyToken).toBe('apify-secret');
    expect(saved.googleApiKeys).toEqual(['key-one', 'key-two']);
    expect(saved.proxyUrls).toEqual(['socks5h://operator:supersecret@127.0.0.1:60001']);

    await saveOperatorSettings(store, { apifyToken: '', googleApiKeys: [] });
    const cleared = await loadOperatorSettings(store);
    expect(cleared.apifyToken).toBeUndefined();
    expect(cleared.googleApiKeys).toEqual([]);
    expect(cleared.proxyUrls).toEqual(['socks5h://operator:supersecret@127.0.0.1:60001']);
  });

  it('keeps stored credentials when a masked proxy entry is re-saved', async () => {
    const store = fakeSettingsStore();
    await saveOperatorSettings(store, {
      proxyUrls: ['socks5h://operator:supersecret@127.0.0.1:60001'],
    });

    await saveOperatorSettings(store, {
      proxyUrls: ['socks5h://operator:••••••@127.0.0.1:60001', 'http://127.0.0.1:9000'],
    });

    const saved = await loadOperatorSettings(store);
    expect(saved.proxyUrls).toEqual([
      'socks5h://operator:supersecret@127.0.0.1:60001',
      'http://127.0.0.1:9000',
    ]);
  });

  it('omitted fields leave stored values untouched', async () => {
    const store = fakeSettingsStore();
    await saveOperatorSettings(store, { apifyToken: 'apify-secret' });
    await saveOperatorSettings(store, { defaultGoogleMapsActorId: 'custom/actor' });

    const saved = await loadOperatorSettings(store);
    expect(saved.apifyToken).toBe('apify-secret');
    expect(saved.defaultGoogleMapsActorId).toBe('custom/actor');
  });
});

describe('toSafeOperatorSettings', () => {
  it('exposes statuses and masked proxies but never raw secrets', () => {
    const safe = toSafeOperatorSettings(
      {
        apifyToken: 'apify-secret',
        googleApiKeys: ['key-one'],
        proxyUrls: ['socks5h://operator:supersecret@127.0.0.1:60001'],
      },
      { googleMapsActorId: 'default/maps', salesNavigatorActorId: 'default/sn' }
    );

    expect(safe).toEqual({
      defaultGoogleMapsActorId: 'default/maps',
      defaultSalesNavigatorActorId: 'default/sn',
      hasSavedApifyToken: true,
      hasSavedGoogleApiKeys: true,
      googleApiKeyCount: 1,
      proxyCount: 1,
      proxies: ['socks5h://operator:••••••@127.0.0.1:60001'],
    });
    expect(JSON.stringify(safe)).not.toContain('supersecret');
    expect(JSON.stringify(safe)).not.toContain('apify-secret');
    expect(JSON.stringify(safe)).not.toContain('key-one');
  });
});

describe('withSavedCredentials', () => {
  const settings = {
    googleApiKeys: ['saved-google-key'],
    apifyToken: 'saved-apify-token',
    proxyUrls: ['socks5h://operator:supersecret@127.0.0.1:60001'],
  };

  it('fills missing credentials from the store', () => {
    const merged = withSavedCredentials(
      { leadSource: 'google_maps', routeMode: 'proxy' },
      settings
    );

    expect(merged).toMatchObject({
      googleApiKey: 'saved-google-key',
      googleApiKeys: ['saved-google-key'],
      apifyToken: 'saved-apify-token',
      proxyUrls: ['socks5h://operator:supersecret@127.0.0.1:60001'],
    });
  });

  it('never overrides request-scoped credentials and stays direct without a proxy route', () => {
    const merged = withSavedCredentials(
      { googleApiKey: 'request-key', routeMode: 'direct' },
      settings
    );

    expect(merged.googleApiKey).toBe('request-key');
    expect(merged.googleApiKeys).toBeUndefined();
    expect(merged.proxyUrls).toBeUndefined();
  });
});
