import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';

function createPrismaStub(leads: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    lead: {
      findMany: async () => leads,
    },
    ...overrides,
  };
}

describe('API', () => {
  it('returns health with supported sources', async () => {
    const app = createApp();

    const res = await request(app).get('/api/health').expect(200);

    expect(res.body).toEqual({
      data: {
        name: 'Leads-GenX',
        status: 'ok',
        sources: ['google_maps', 'sales_navigator'],
      },
    });
  });

  it('starts a Google Maps run without echoing the Apify token', async () => {
    const app = createApp({
      runService: {
        async startRun() {
          return {
            id: 7,
            status: 'queued',
            leadSource: 'google_maps',
            actorId: 'compass/google-maps-extractor',
            maxResults: 100,
          };
        },
      },
    });

    const res = await request(app)
      .post('/api/runs')
      .send({
        apifyToken: 'apify-secret-token',
        leadSource: 'google_maps',
        maxResults: 100,
        googleMaps: {
          searchTerms: ['dentist'],
          locationQuery: 'Austin, TX',
        },
      })
      .expect(202);

    expect(res.body).toEqual({
      data: {
        id: 7,
        status: 'queued',
        leadSource: 'google_maps',
      },
    });
    expect(JSON.stringify(res.body)).not.toContain('apify-secret-token');
  });

  it('starts a Google Places run without echoing the Google API key', async () => {
    let receivedInput: unknown;
    const app = createApp({
      runService: {
        async startRun(input) {
          receivedInput = input;
          return {
            id: 9,
            status: 'queued',
            leadSource: 'google_maps',
          };
        },
      },
    });

    const res = await request(app)
      .post('/api/runs')
      .send({
        googleApiKey: 'google-secret-key',
        leadSource: 'google_maps',
        maxResults: 40,
        googleMaps: {
          provider: 'google_places',
          searchTerms: ['oilfield services'],
          locations: ['Houston, TX'],
        },
      })
      .expect(202);

    expect(res.body).toEqual({
      data: {
        id: 9,
        status: 'queued',
        leadSource: 'google_maps',
      },
    });
    expect(receivedInput).toMatchObject({
      googleApiKey: 'google-secret-key',
      googleMaps: { provider: 'google_places' },
    });
    expect(JSON.stringify(res.body)).not.toContain('google-secret-key');
  });

  it('returns safe operator settings', async () => {
    const app = createApp();

    const res = await request(app).get('/api/settings').expect(200);

    expect(res.body).toEqual({
      data: {
        defaultGoogleMapsActorId: 'compass/google-maps-extractor',
        defaultSalesNavigatorActorId: 'harvestapi/linkedin-profile-search',
        hasSavedApifyToken: false,
      },
    });
  });

  it('downloads email-only TXT leads when format is omitted', async () => {
    const app = createApp({
      prisma: createPrismaStub([
        {
          leadType: 'person',
          fullName: 'Jane Doe',
          jobTitle: 'VP Sales',
          companyName: 'Example Inc',
          email: 'jane@example.com',
          profileUrl: 'https://linkedin.com/in/janedoe',
          location: 'Austin, TX',
        },
      ]) as never,
    });

    const res = await request(app).get('/api/leads/download').expect(200);

    expect(res.headers['content-disposition']).toContain('leads-genx-emails.txt');
    expect(res.text).toBe('jane@example.com');
  });

  it('downloads email-only leads when format is emails', async () => {
    const app = createApp({
      prisma: createPrismaStub([
        { email: 'jane@example.com' },
        { email: '' },
        { companyName: 'No Email Co' },
        { email: 'ops@example.com' },
      ]) as never,
    });

    const res = await request(app).get('/api/leads/download?format=emails').expect(200);

    expect(res.text).toBe(['jane@example.com', 'ops@example.com'].join('\n'));
  });

  it('rejects unsupported lead download formats', async () => {
    const app = createApp({
      prisma: createPrismaStub([]) as never,
    });

    const res = await request(app).get('/api/leads/download?format=csv').expect(400);

    expect(res.body).toEqual({ error: 'Unsupported download format.' });
  });

  it('deletes a run and its dependent records', async () => {
    const deleted: number[] = [];
    const app = createApp({
      prisma: createPrismaStub([], {
        run: {
          async findUnique({ where }: { where: { id: number } }) {
            return where.id === 12 ? { id: 12 } : null;
          },
          async delete({ where }: { where: { id: number } }) {
            deleted.push(where.id);
            return { id: where.id };
          },
        },
      }) as never,
    });

    await request(app).delete('/api/runs/12').expect(204);

    expect(deleted).toEqual([12]);
  });

  it('returns 404 when deleting a missing run', async () => {
    const app = createApp({
      prisma: createPrismaStub([], {
        run: {
          async findUnique() {
            return null;
          },
          async delete() {
            throw new Error('delete should not be called');
          },
        },
      }) as never,
    });

    const res = await request(app).delete('/api/runs/404').expect(404);

    expect(res.body).toEqual({ error: 'Run not found' });
  });

  it('reports local scraper health without exposing route credentials', async () => {
    const app = createApp({
      runService: {
        async startRun() { throw new Error('not used'); },
        async scraperHealth() { return { ok: true, route: 'direct', healthyProxyCount: 0 }; },
      },
    });

    const res = await request(app).get('/api/scraper/health').expect(200);
    expect(res.body).toEqual({ data: { ok: true, route: 'direct', healthyProxyCount: 0 } });
  });

  it('resumes a checkpointed run without echoing request-scoped credentials', async () => {
    let received: unknown;
    const app = createApp({
      runService: {
        async startRun() { throw new Error('not used'); },
        async resumeRun(runId, credentials) {
          received = { runId, credentials };
          return { id: runId, status: 'queued' };
        },
      },
    });

    const res = await request(app).post('/api/runs/12/resume').send({
      googleApiKey: 'google-key-sentinel',
      proxyUrls: 'socks5h://user:proxy-password-sentinel@127.0.0.1:60001',
    }).expect(202);

    expect(received).toMatchObject({ runId: 12, credentials: { googleApiKey: 'google-key-sentinel' } });
    expect(JSON.stringify(res.body)).not.toContain('google-key-sentinel');
    expect(JSON.stringify(res.body)).not.toContain('proxy-password-sentinel');
  });

  it('queues interrupted-run recovery once when startup recovery is enabled', async () => {
    let recoveries = 0;
    createApp({
      recoverOnStartup: true,
      runService: {
        async startRun() { throw new Error('not used'); },
        async recoverInterruptedRuns() { recoveries += 1; },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(recoveries).toBe(1);
  });
});
