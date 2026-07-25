import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';

/**
 * Regression for the exact production report: "saved my Bright Data key in
 * Settings, but SN filter runs say the server can't see it." The run-start
 * merge must inject the operator-saved key into the request body so the
 * Bright Data lane passes validation with no Apify token and no cookies.
 */
describe('Sales Navigator filter runs with a Settings-saved Bright Data key', () => {
  function appWithSavedKey(received: { input?: unknown }) {
    const prismaStub = {
      appSetting: {
        async findMany(args?: { where?: { key?: { in?: string[] } } }) {
          const wanted = args?.where?.key?.in;
          const rows = [
            { key: 'apifyToken', value: 'saved-apify-token' },
            { key: 'googleApiKeys', value: JSON.stringify(['saved-google-key']) },
            { key: 'brightDataApiKey', value: 'saved-brightdata-key' },
          ];
          return wanted ? rows.filter((row) => wanted.includes(row.key)) : rows;
        },
      },
    };
    return createApp({
      authDisabled: true,
      prisma: prismaStub as never,
      runService: {
        async startRun(input: unknown) {
          received.input = input;
          return { id: 42, status: 'queued', leadSource: 'sales_navigator' };
        },
      } as never,
    });
  }

  it('starts an SN filter run with no Apify token and no cookies', async () => {
    const received: { input?: unknown } = {};
    const app = appWithSavedKey(received);

    const res = await request(app)
      .post('/api/runs')
      .send({
        leadSource: 'sales_navigator',
        maxResults: 100,
        salesNavigator: {
          titles: ['VP Sales'],
          seniorities: ['Owner', 'VP', 'Director'],
          functions: ['Sales', 'Accounting'],
          headcounts: ['51-200'],
        },
      });

    expect(res.status).toBe(202);
    expect(received.input).toMatchObject({
      leadSource: 'sales_navigator',
      brightDataApiKey: 'saved-brightdata-key',
      salesNavigator: { titles: ['VP Sales'], headcounts: ['51-200'] },
    });
  });

  it('keeps the honest guidance when no Bright Data key is saved anywhere', async () => {
    const prismaStub = {
      appSetting: {
        async findMany() {
          return [];
        },
      },
    };
    const app = createApp({
      authDisabled: true,
      prisma: prismaStub as never,
      runService: { async startRun() { return { id: 1 }; } } as never,
    });

    const res = await request(app)
      .post('/api/runs')
      .send({
        leadSource: 'sales_navigator',
        maxResults: 100,
        salesNavigator: { titles: ['VP Sales'] },
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Bright Data');
  });

  it('settings round-trip: saving the key makes hasSavedBrightDataKey true', async () => {
    const stored = new Map<string, string>();
    const prismaStub = {
      appSetting: {
        async findMany() {
          return [...stored.entries()].map(([key, value]) => ({ key, value }));
        },
        async upsert(args: { where: { key: string }; create: { value: string } }) {
          stored.set(args.where.key, args.create.value);
          return {};
        },
        async deleteMany(args: { where: { key: string } }) {
          stored.delete(args.where.key);
          return {};
        },
      },
    };
    const app = createApp({
      authDisabled: true,
      prisma: prismaStub as never,
      runService: { async startRun() { return { id: 1 }; } } as never,
    });

    const save = await request(app).post('/api/settings').send({ brightDataApiKey: 'bd-live-key' });
    expect(save.status).toBe(200);
    expect(save.body.data.hasSavedBrightDataKey).toBe(true);
    expect(stored.get('brightDataApiKey')).toBe('bd-live-key');

    const get = await request(app).get('/api/settings');
    expect(get.body.data.hasSavedBrightDataKey).toBe(true);
    expect(JSON.stringify(get.body)).not.toContain('bd-live-key');
  });
});
