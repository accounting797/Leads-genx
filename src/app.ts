import express from 'express';
import path from 'path';
import { prisma } from './db/client';
import { PrismaRunStore } from './domain/prismaRunStore';
import { createRunService } from './domain/runService';
import { WebsiteEmailExtractor } from './domain/emailExtractor';
import { ApifyActorClient } from './integrations/apifyActorClient';
import { GooglePlacesApiClient } from './integrations/googlePlacesClient';
import { LocalMapsScraperKitClient } from './integrations/localMapsScraperClient';
import { ApiDeps, createApiRouter } from './routes/api';

export function createApp(deps: ApiDeps = {}) {
  const app = express();
  const runtimePrisma = deps.prisma ?? prisma;
  const runService =
    deps.runService ??
    createRunService({
      store: new PrismaRunStore(runtimePrisma),
      actorClient: new ApifyActorClient(),
      googlePlacesClient: new GooglePlacesApiClient(),
      localMapsScraperClient: new LocalMapsScraperKitClient({ maxPolls: 120 }),
      emailExtractor: new WebsiteEmailExtractor(),
      enableLocalMapsScraper: process.env.ENABLE_LOCAL_MAPS_SCRAPER === 'true',
    });

  app.use(express.json({ limit: '1mb' }));
  app.use('/api', createApiRouter({ prisma: runtimePrisma, runService }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  return app;
}
