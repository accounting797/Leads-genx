ALTER TABLE "Run" ADD COLUMN "businessCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Run" ADD COLUMN "localBusinessCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Run" ADD COLUMN "googleBusinessCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Run" ADD COLUMN "duplicateCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Run" ADD COLUMN "websiteCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Run" ADD COLUMN "apiRequestBudget" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Run" ADD COLUMN "apiRequestsUsed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Run" ADD COLUMN "currentRoute" TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE "Run" ADD COLUMN "localConcurrency" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "RunBatch" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "runId" INTEGER NOT NULL,
  "batchKey" TEXT NOT NULL,
  "query" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "resultCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" DATETIME,
  "errorCode" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "RunBatch_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "DiscoveredBusiness" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "runId" INTEGER NOT NULL,
  "identityKey" TEXT NOT NULL,
  "sourceJson" TEXT NOT NULL DEFAULT '[]',
  "companyName" TEXT,
  "categoryName" TEXT,
  "address" TEXT,
  "website" TEXT,
  "phone" TEXT,
  "placeUrl" TEXT,
  "rating" REAL,
  "reviewsCount" INTEGER,
  "emailsJson" TEXT,
  "rawJson" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "DiscoveredBusiness_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RunBatch_runId_batchKey_key" ON "RunBatch"("runId", "batchKey");
CREATE INDEX "RunBatch_runId_status_nextAttemptAt_idx" ON "RunBatch"("runId", "status", "nextAttemptAt");
CREATE UNIQUE INDEX "DiscoveredBusiness_runId_identityKey_key" ON "DiscoveredBusiness"("runId", "identityKey");
CREATE INDEX "DiscoveredBusiness_runId_website_idx" ON "DiscoveredBusiness"("runId", "website");
