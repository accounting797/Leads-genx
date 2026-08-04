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
import { safeErrorMessage } from './domain/errorLogger';
import { loadOperatorSettings, loadQuarantinedCredentials, quarantineCredential } from './domain/operatorSettings';
import { createDeployService } from './domain/deployService';
import { PrismaTargetedStore } from './domain/targeted/store';
import { TargetedService } from './domain/targeted/service';
import { PublicWebSearchClient } from './domain/targeted/publicWebSearch';

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
      loadOperatorSettings: () => loadOperatorSettings(runtimePrisma),
      loadQuarantinedCredentials: () => loadQuarantinedCredentials(runtimePrisma),
      quarantineCredential: (provider, credential, reason) =>
        quarantineCredential(runtimePrisma, provider, credential, reason),
    });
  const targetedService = deps.targetedService ?? new TargetedService({
    store: new PrismaTargetedStore(runtimePrisma),
    googleClient: new GooglePlacesApiClient(),
    localClient: new LocalMapsScraperKitClient({ maxPolls: 120 }),
    emailExtractor: new WebsiteEmailExtractor(),
    webSearchClient: new PublicWebSearchClient(),
    settingsLoader: async () => {
      const settings = await loadOperatorSettings(runtimePrisma);
      return { googleApiKeys: settings.googleApiKeys, proxyUrls: settings.proxyUrls };
    },
  });

  if (deps.recoverOnStartup && runService.recoverInterruptedRuns) {
    setImmediate(() => {
      void runService.recoverInterruptedRuns?.().catch((error) => {
        console.error(`Local-first recovery failed: ${safeErrorMessage(error)}`);
      });
    });
  }
  if (deps.recoverOnStartup) {
    setImmediate(() => {
      void targetedService.recoverInterruptedCampaigns().catch((error) => {
        console.error(`Targeted recovery failed: ${safeErrorMessage(error)}`);
      });
    });
  }

  app.use(express.json({ limit: '1mb' }));
  app.use(
    '/api',
    createApiRouter({
      prisma: runtimePrisma,
      runService,
      proxyTester: deps.proxyTester,
      credentialTester: deps.credentialTester,
      authDisabled: deps.authDisabled,
      deployService: deps.deployService ?? createDeployService(),
      targetedService,
    })
  );
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    etag: false,
    maxAge: 0,
    setHeaders: (response) => {
      response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      response.setHeader('Pragma', 'no-cache');
      response.setHeader('Expires', '0');
    },
  }));

  return app;
}
