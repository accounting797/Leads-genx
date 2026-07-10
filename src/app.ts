import express from 'express';
import path from 'path';
import { prisma } from './db/client';
import { PrismaRunStore } from './domain/prismaRunStore';
import { createRunService } from './domain/runService';
import { ApifyActorClient } from './integrations/apifyActorClient';
import { GooglePlacesApiClient } from './integrations/googlePlacesClient';
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
    });

  app.use(express.json({ limit: '1mb' }));
  app.use('/api', createApiRouter({ prisma: runtimePrisma, runService }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  return app;
}
