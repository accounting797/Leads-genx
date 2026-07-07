import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';

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
});
