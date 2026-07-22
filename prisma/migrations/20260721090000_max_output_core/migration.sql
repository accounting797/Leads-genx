ALTER TABLE "Run" ADD COLUMN "outputMode" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "Run" ADD COLUMN "rawContactCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Run" ADD COLUMN "companiesWithQualifiedEmailCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Run" ADD COLUMN "plannedUnitCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Run" ADD COLUMN "completedUnitCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Run" ADD COLUMN "extendedRun" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Run" ADD COLUMN "lastHeartbeatAt" DATETIME;

ALTER TABLE "Lead" ADD COLUMN "normalizedEmail" TEXT;
ALTER TABLE "Lead" ADD COLUMN "contactQuality" TEXT NOT NULL DEFAULT 'qualified';
ALTER TABLE "Lead" ADD COLUMN "qualityReason" TEXT;
ALTER TABLE "Lead" ADD COLUMN "businessIdentityKey" TEXT;

CREATE TABLE "RunProviderState" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "runId" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "yieldCount" INTEGER NOT NULL DEFAULT 0,
  "budgetUsed" INTEGER,
  "budgetMax" INTEGER,
  "heartbeatAt" DATETIME NOT NULL,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "RunProviderState_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Lead_runId_normalizedEmail_key" ON "Lead"("runId", "normalizedEmail");
CREATE INDEX "Lead_runId_contactQuality_idx" ON "Lead"("runId", "contactQuality");
CREATE UNIQUE INDEX "RunProviderState_runId_provider_key" ON "RunProviderState"("runId", "provider");
CREATE INDEX "RunProviderState_runId_heartbeatAt_idx" ON "RunProviderState"("runId", "heartbeatAt");
