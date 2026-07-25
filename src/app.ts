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

  if (deps.recoverOnStartup && runService.recoverInterruptedRuns) {
    setImmediate(() => {
      void runService.recoverInterruptedRuns?.().catch((error) => {
        console.error(`Local-first recovery failed: ${safeErrorMessage(error)}`);
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
    })
  );
  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      setHeaders: (res, filePath) => {
        // HTML/JS/CSS must revalidate every load — a stale cached frontend
        // silently drops new fields (a "saved" key that never reaches the
        // server). Versioned assets can still be cached by the browser.
        if (/\.(html|js|css)$/.test(filePath)) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    })
  );

  return app;
}
