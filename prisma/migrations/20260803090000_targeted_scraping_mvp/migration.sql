-- CreateTable
CREATE TABLE "TargetedCampaign" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "prompt" TEXT NOT NULL,
    "filterJson" TEXT NOT NULL,
    "policyJson" TEXT NOT NULL,
    "plannedUnitCount" INTEGER NOT NULL DEFAULT 0,
    "completedUnitCount" INTEGER NOT NULL DEFAULT 0,
    "discoveredCount" INTEGER NOT NULL DEFAULT 0,
    "alignedCount" INTEGER NOT NULL DEFAULT 0,
    "strictCount" INTEGER NOT NULL DEFAULT 0,
    "mailboxVerifiedCount" INTEGER NOT NULL DEFAULT 0,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TargetedCampaign_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "TargetedWorkUnit" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "campaignId" INTEGER NOT NULL,
    "workKey" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "documentType" TEXT NOT NULL DEFAULT 'html',
    "geographyJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "checkpointJson" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TargetedWorkUnit_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TargetedCampaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "TargetedSourceArtifact" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "campaignId" INTEGER NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "contentType" TEXT,
    "contentHash" TEXT,
    "retrievalStatus" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "metadataJson" TEXT,
    "discoveredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TargetedSourceArtifact_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TargetedCampaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "TargetedCandidate" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "campaignId" INTEGER NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT,
    "jobTitle" TEXT,
    "companyName" TEXT,
    "website" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "visibleProvider" TEXT,
    "infrastructureJson" TEXT NOT NULL DEFAULT '[]',
    "relevanceScore" INTEGER NOT NULL DEFAULT 0,
    "relevanceReason" TEXT,
    "qualityTier" TEXT NOT NULL DEFAULT 'review',
    "verificationDepth" TEXT NOT NULL DEFAULT 'syntax',
    "complianceStatus" TEXT NOT NULL DEFAULT 'review',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TargetedCandidate_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TargetedCampaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "TargetedEvidence" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "candidateId" INTEGER NOT NULL,
    "artifactId" INTEGER,
    "evidenceType" TEXT NOT NULL,
    "excerpt" TEXT,
    "fieldsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TargetedEvidence_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "TargetedCandidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TargetedEvidence_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "TargetedSourceArtifact" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "TargetedVerification" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "candidateId" INTEGER NOT NULL,
    "checkType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "depth" TEXT NOT NULL,
    "providerVersion" TEXT,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    CONSTRAINT "TargetedVerification_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "TargetedCandidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "TargetedEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "campaignId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TargetedEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TargetedCampaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "TargetedCampaign_userId_createdAt_idx" ON "TargetedCampaign"("userId", "createdAt");
CREATE INDEX "TargetedCampaign_status_updatedAt_idx" ON "TargetedCampaign"("status", "updatedAt");
CREATE INDEX "TargetedWorkUnit_campaignId_status_idx" ON "TargetedWorkUnit"("campaignId", "status");
CREATE UNIQUE INDEX "TargetedWorkUnit_campaignId_workKey_key" ON "TargetedWorkUnit"("campaignId", "workKey");
CREATE INDEX "TargetedSourceArtifact_campaignId_retrievalStatus_idx" ON "TargetedSourceArtifact"("campaignId", "retrievalStatus");
CREATE UNIQUE INDEX "TargetedSourceArtifact_campaignId_canonicalUrl_key" ON "TargetedSourceArtifact"("campaignId", "canonicalUrl");
CREATE INDEX "TargetedCandidate_campaignId_qualityTier_idx" ON "TargetedCandidate"("campaignId", "qualityTier");
CREATE UNIQUE INDEX "TargetedCandidate_campaignId_normalizedEmail_key" ON "TargetedCandidate"("campaignId", "normalizedEmail");
CREATE INDEX "TargetedEvidence_candidateId_evidenceType_idx" ON "TargetedEvidence"("candidateId", "evidenceType");
CREATE INDEX "TargetedEvidence_artifactId_idx" ON "TargetedEvidence"("artifactId");
CREATE INDEX "TargetedVerification_candidateId_checkType_checkedAt_idx" ON "TargetedVerification"("candidateId", "checkType", "checkedAt");
CREATE INDEX "TargetedEvent_campaignId_createdAt_idx" ON "TargetedEvent"("campaignId", "createdAt");
