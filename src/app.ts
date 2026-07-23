import { EventEmitter } from 'events';
import express from 'express';
import path from 'path';
import { prisma } from './db/client';
import { PrismaRunStore, FileApifyCheckpointStore } from './domain/prismaRunStore';
import { createRunService } from './domain/runService';
import { WebsiteEmailExtractor } from './domain/emailExtractor';
import { createEmailVerifier } from './domain/emailVerifier';
import { ApifyActorClient } from './integrations/apifyActorClient';
import { GooglePlacesApiClient } from './integrations/googlePlacesClient';
import { LocalMapsScraperKitClient } from './integrations/localMapsScraperClient';
import { createProxyRotator } from './integrations/proxyRotator';
import { ApiDeps, createApiRouter } from './routes/api';
import { safeErrorMessage } from './domain/errorLogger';

export function createApp(deps: ApiDeps = {}) {
  const app = express();
  const runtimePrisma = deps.prisma ?? prisma;
  const eventBus = deps.runService?.eventBus ?? new EventEmitter();
  const emailVerifier = createEmailVerifier();
  const proxyRotator = createProxyRotator();

  const runService =
    deps.runService ??
    createRunService({
      store: new PrismaRunStore(runtimePrisma),
      actorClient: new ApifyActorClient(),
      googlePlacesClient: new GooglePlacesApiClient(),
      localMapsScraperClient: new LocalMapsScraperKitClient({ maxPolls: 120, proxyRotator }),
      emailExtractor: new WebsiteEmailExtractor(),
      enableLocalMapsScraper: process.env.ENABLE_LOCAL_MAPS_SCRAPER === 'true',
      apifyCheckpointStore: new FileApifyCheckpointStore(path.join(__dirname, '..', 'outputs')),
      emailVerifier,
      proxyRotator,
      eventBus,
    });

  if (deps.recoverOnStartup && runService.recoverInterruptedRuns) {
    setImmediate(() => {
      void runService.recoverInterruptedRuns?.().catch((error) => {
        console.error(`Local-first recovery failed: ${safeErrorMessage(error)}`);
      });
    });
  }

  app.use(express.json({ limit: '1mb' }));
  app.use('/api', createApiRouter({ prisma: runtimePrisma, runService }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  return app;
}
