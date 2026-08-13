import { collectContactCandidates, EmailExtractor, extractEmailCandidatesFromText } from '../emailExtractor';
import { normalizeLead } from '../leadNormalizer';
import { GoogleMapsFilters, NormalizedLead } from '../types';
import { GooglePlacesClient } from '../../integrations/googlePlacesClient';
import { LocalMapsScraperClient } from '../../integrations/localMapsScraperClient';
import { FdicBankMarketsClient } from './fdicBankMarkets';
import { classifyMailInfrastructure, MxResolver } from './mailInfrastructure';
import { planTargetedQueries, TargetedQueryInput } from './queryPlanner';
import { scoreTargetedCandidate } from './relevance';
import { PrismaTargetedStore } from './store';
import { TargetedCampaignRecord, TargetedDraftInput, TargetedQualityTier } from './types';
import { validateTargetedDraft } from './validation';
import { validateGeography } from './geography';
import { visibleDomainProvider } from './providerCatalog';
import { targetedBankById } from './bankCatalog';
import { TargetedValidationError } from './validation';
import { CanadianBankMarketsClient } from './canadianBankMarkets';
import { derivePromptIntent } from './promptIntent';
import { associatePublicContact } from './publicContactAssociation';
import { discoverPublicDocumentLinks, PublicWebSearchClient } from './publicWebSearch';
import { FetchedArtifact, fetchPublicArtifact } from './artifactFetcher';
import { extractDocumentSections, ExtractedSection } from './documentExtractor';
import { metricForWorkUnit, rankPendingWork, WorkPerformanceMetric } from './adaptiveScheduler';

export interface TargetedStartOptions {
  googleApiKey?: string;
  googleApiKeys?: string[];
  proxyUrls?: string[];
  background?: boolean;
}

export interface TargetedSettings {
  googleApiKeys: string[];
  proxyUrls: string[];
}

export interface TargetedServiceDependencies {
  store: PrismaTargetedStore;
  googleClient?: GooglePlacesClient;
  localClient?: LocalMapsScraperClient;
  emailExtractor?: EmailExtractor;
  mxResolver?: MxResolver;
  bankMarketsClient?: FdicBankMarketsClient;
  canadianBankMarketsClient?: CanadianBankMarketsClient;
  webSearchClient?: Pick<PublicWebSearchClient, 'search'>;
  artifactFetcher?: (url: string) => Promise<FetchedArtifact>;
  documentExtractor?: (artifact: FetchedArtifact) => Promise<ExtractedSection[]>;
  settingsLoader?: () => Promise<TargetedSettings>;
}

function googleMapsFilters(input: TargetedDraftInput, geography: { city: string; state: string; postalCode: string }): GoogleMapsFilters {
  const searchTerms = [...input.keywords, ...input.industries, ...input.companyTypes].filter(Boolean);
  const location = [geography.city, geography.state, geography.postalCode].filter(Boolean).join(' ');
  return {
    provider: 'hybrid', searchTerms: searchTerms.length ? searchTerms : ['business'],
    categoryFilters: input.industries, companyTypes: input.companyTypes,
    locations: location ? [location] : [], locationQuery: location,
    maxPlaces: input.maxResults, apiRequestBudget: input.googleRequestBudget,
    skipClosedPlaces: true,
  };
}

function targetedNormalize(raw: unknown): NormalizedLead {
  const lead = normalizeLead(raw, 'google_maps');
  const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const displayName = item.displayName && typeof item.displayName === 'object'
    ? (item.displayName as Record<string, unknown>).text : undefined;
  if (typeof displayName === 'string' && (!lead.companyName || lead.companyName.startsWith('places/'))) {
    lead.companyName = displayName;
  }
  return lead;
}

function leadIdentity(lead: NormalizedLead): string {
  return [lead.email, lead.website, lead.phone, lead.companyName, lead.address]
    .filter(Boolean).join('|').toLowerCase();
}

export class TargetedService {
  private readonly store: PrismaTargetedStore;
  private readonly bankMarketsClient: FdicBankMarketsClient;
  private readonly canadianBankMarketsClient: CanadianBankMarketsClient;
  private readonly artifactFetcher: (url: string) => Promise<FetchedArtifact>;
  private readonly documentExtractor: (artifact: FetchedArtifact) => Promise<ExtractedSection[]>;
  private readonly cancelledCampaigns = new Set<number>();

  constructor(private readonly deps: TargetedServiceDependencies) {
    this.store = deps.store;
    this.bankMarketsClient = deps.bankMarketsClient ?? new FdicBankMarketsClient();
    this.canadianBankMarketsClient = deps.canadianBankMarketsClient ?? new CanadianBankMarketsClient();
    this.artifactFetcher = deps.artifactFetcher ?? ((url) => fetchPublicArtifact(url));
    this.documentExtractor = deps.documentExtractor ?? extractDocumentSections;
  }

  async createDraft(userId: number, value: unknown): Promise<TargetedCampaignRecord> {
    return this.store.createDraft(userId, validateTargetedDraft(value));
  }

  async plan(campaignId: number): Promise<TargetedCampaignRecord> {
    const campaign = await this.requireCampaign(campaignId);
    let filters = validateTargetedDraft({ ...campaign.filters, prompt: campaign.prompt });
    validateGeography(filters);
    const derivedIntent = derivePromptIntent(filters.prompt);
    filters = {
      ...filters,
      keywords: [...new Set([...filters.keywords, ...derivedIntent.keywords])],
      industries: [...new Set([...filters.industries, ...derivedIntent.industries])],
    };

    if (filters.mode === 'bank' && !filters.cities.length && filters.bankIds.length) {
      const entries = filters.bankIds.map((id) => targetedBankById(id)).filter((entry) => entry?.country === filters.country);
      const resolved = [];
      for (const entry of entries) {
        if (!entry) continue;
        resolved.push(...await this.bankMarkets(entry.id, 100, campaign.userId));
      }
      const markets = [...new Map(resolved
        .sort((a, b) => b.branchCount - a.branchCount)
        .map((market) => [`${market.city.toLowerCase()}|${market.state}|${market.postalCodes[0] ?? ''}`, market])).values()].slice(0, 100);
      if (!markets.length) {
        throw new TargetedValidationError({ bankIds: 'No US/Canadian bank markets were resolved; no unrestricted search was created.' });
      }
      filters = {
        ...filters,
        areaCodes: markets.map((market) => market.areaCodes[0] ?? ''),
        states: markets.map((market) => market.state),
        cities: markets.map((market) => market.city),
        postalCodes: markets.map((market) => market.postalCodes[0] ?? ''),
        keywords: filters.keywords.length ? filters.keywords : ['business'],
      };
    }

    await this.store.updateFilters(campaignId, filters);

    const proposedUnits = planTargetedQueries(filters as TargetedQueryInput);
    const usedWorkKeys = await this.store.usedWorkKeys(campaign.userId, campaignId);
    const units = proposedUnits.filter((unit) => !usedWorkKeys.has(unit.workKey));
    if (!units.length) throw new TargetedValidationError({ history: 'Every planned substitution was already used by an earlier run. Choose a fresh bank market or change the target.' });
    await this.store.replaceWorkUnits(campaignId, units);
    await this.store.addEvent(campaignId, 'planned', `Planned ${units.length} targeted work units.`, {
      executable: units.length, skippedPreviouslyUsed: proposedUnits.length - units.length,
      businessSearches: units.filter((unit) => unit.connector === 'public_web').length,
      documentSearches: units.filter((unit) => unit.connector === 'public_document').length,
    });
    await this.store.addEvent(campaignId, 'document_plan', 'PDF, XLS, XLSX, CSV, DOCX, and TXT query variants are executable when public web discovery is available.');
    return (await this.store.get(campaignId))!;
  }

  async start(campaignId: number, options: TargetedStartOptions = {}): Promise<TargetedCampaignRecord> {
    const run = async () => this.execute(campaignId, options);
    if (options.background !== false) {
      void run().catch(() => undefined);
      return this.requireCampaign(campaignId);
    }
    await run();
    return this.requireCampaign(campaignId);
  }

  async recoverInterruptedCampaigns(): Promise<number> {
    const interrupted = (await this.store.list(100))
      .filter((campaign) => campaign.status === 'running' || campaign.status === 'queued');
    for (const campaign of interrupted) void this.start(campaign.id, { background: true });
    return interrupted.length;
  }

  async stop(campaignId: number): Promise<void> {
    await this.requireCampaign(campaignId);
    this.cancelledCampaigns.add(campaignId);
    await this.store.stop(campaignId);
    await this.store.addEvent(campaignId, 'cancelled', 'Targeted campaign stopped at a safe work-unit boundary.');
  }

  async delete(campaignId: number): Promise<void> {
    const campaign = await this.requireCampaign(campaignId);
    if (['queued', 'running', 'waiting_for_scraper'].includes(campaign.status)) await this.stop(campaignId);
    await this.store.deleteCampaign(campaignId);
  }

  get(campaignId: number) { return this.store.get(campaignId); }
  list(limit?: number, userId?: number) { return this.store.list(limit, userId); }
  listCandidates(campaignId: number, options?: { tier?: TargetedQualityTier; limit?: number; offset?: number }) {
    return this.store.listCandidates(campaignId, options);
  }
  async strictEmails(campaignId: number) { await this.store.quarantineForeignCandidates(undefined, campaignId); return this.store.strictEmails(campaignId); }
  async strictEmailsAll(userId: number) { await this.store.quarantineForeignCandidates(userId); return this.store.strictEmailsAll(userId); }
  auditGeography(userId: number) { return this.store.quarantineForeignCandidates(userId); }
  resetLearning() { return this.store.resetWorkMetrics(); }
  workUnits(campaignId: number) { return this.store.listWorkUnits(campaignId); }
  editWorkUnit(campaignId: number, unitId: number, query: string) {
    if (query.trim().length < 3) throw new Error('Work-unit query must contain at least 3 characters.');
    return this.store.editWorkUnit(campaignId, unitId, query);
  }
  async bankMarkets(bankId: string, limit = 100, userId?: number) {
    const bank = targetedBankById(bankId);
    if (!bank) {
      throw new TargetedValidationError({ bankId: 'Automatic markets are not available for this bank.' });
    }
    const boundedLimit = Math.min(100, Math.max(1, limit));
    const discoveryLimit = Math.min(500, Math.max(100, boundedLimit * 5));
    let markets;
    if (bank.country === 'CA') markets = await this.canadianBankMarketsClient.markets(bank.label, discoveryLimit);
    else {
      if (!bank.fdicName || !bank.fdicCertificate) throw new TargetedValidationError({ bankId: 'Automatic markets are not available for this bank.' });
      markets = await this.bankMarketsClient.markets(bank.fdicName, discoveryLimit, bank.fdicCertificate);
    }
    if (!userId) return markets.slice(0, boundedLimit);
    const used = await this.store.usedGeographyKeys(userId);
    return markets.filter((market) => !used.has([bank.country, market.areaCodes[0] ?? '', market.city, market.state, market.postalCodes[0] ?? '']
      .map((value) => String(value).trim().toLowerCase()).join('|'))).slice(0, boundedLimit);
  }

  private async requireCampaign(campaignId: number): Promise<TargetedCampaignRecord> {
    const campaign = await this.store.get(campaignId);
    if (!campaign) throw new Error(`Targeted campaign ${campaignId} was not found.`);
    return campaign;
  }

  private async wasCancelled(campaignId: number): Promise<boolean> {
    return this.cancelledCampaigns.has(campaignId) || this.store.isCancelled(campaignId);
  }

  private async execute(campaignId: number, supplied: TargetedStartOptions): Promise<void> {
    const campaign = await this.requireCampaign(campaignId);
    if (campaign.status === 'draft') await this.plan(campaignId);
    if (await this.wasCancelled(campaignId)) return;

    const saved = await this.deps.settingsLoader?.() ?? { googleApiKeys: [], proxyUrls: [] };
    const googleKeys = supplied.googleApiKeys?.length ? supplied.googleApiKeys
      : supplied.googleApiKey ? [supplied.googleApiKey] : saved.googleApiKeys;
    const proxyUrls = supplied.proxyUrls?.length ? supplied.proxyUrls : saved.proxyUrls;
    const hasLocal = Boolean(this.deps.localClient);
    const hasGoogle = Boolean(this.deps.googleClient && googleKeys.length);
    const hasWeb = Boolean(this.deps.webSearchClient);
    if (!hasLocal && !hasGoogle && !hasWeb) {
      await this.store.updateStatus(campaignId, { status: 'waiting_for_scraper', errorMessage: 'Docker scraper is unavailable and no Google Places key is configured.' });
      await this.store.addEvent(campaignId, 'waiting', 'No executable scraper is currently available. Progress was preserved.');
      return;
    }

    await this.store.updateStatus(campaignId, { status: 'running', errorMessage: null, startedAt: new Date() });
    const filters = validateTargetedDraft({ ...campaign.filters, prompt: campaign.prompt });
    const performanceHistory: WorkPerformanceMetric[] = await this.store.recentWorkMetrics();
    const workUnits = rankPendingWork(await this.store.listWorkUnits(campaignId, true), performanceHistory);
    const seenBusinesses = new Set<string>();
    let connectorFailures = 0;
    let connectorSuccesses = 0;
    let webRequestsUsed = 0;

    for (let unitIndex = 0; unitIndex < workUnits.length; unitIndex += 1) {
      const unit = workUnits[unitIndex];
      if (await this.wasCancelled(campaignId)) return;
      if (unit.status === 'completed') continue;
      const unitStartedAt = Date.now();
      const funnelBefore = (await this.requireCampaign(campaignId)).funnel;
      const recordPerformance = async (processed: number, failures = 0) => {
        const funnelAfter = (await this.requireCampaign(campaignId)).funnel;
        const metric = metricForWorkUnit(unit, {
          processed, unique: Math.max(0, funnelAfter.discovered - funnelBefore.discovered),
          strict: Math.max(0, funnelAfter.strict - funnelBefore.strict),
          rejected: Math.max(0, funnelAfter.rejected - funnelBefore.rejected),
          failures, elapsedMs: Date.now() - unitStartedAt,
        });
        await this.store.recordWorkUnitMetric(unit.id, metric);
        performanceHistory.push(metric);
        const ranked = rankPendingWork(workUnits.slice(unitIndex + 1), performanceHistory);
        workUnits.splice(unitIndex + 1, ranked.length, ...ranked);
        if (ranked[0] && unitIndex % 5 === 0) {
          await this.store.addEvent(campaignId, 'adaptive_priority', `Next work favors ${ranked[0].documentType} in ${ranked[0].geography.city || ranked[0].geography.state}.`, {
            workKey: ranked[0].workKey, priority: ranked[0].priority, reason: ranked[0].priorityReason,
          });
        }
      };
      await this.store.updateWorkUnit(unit.id, { status: 'running' });
      if (unit.connector === 'public_document') {
        if (!this.deps.webSearchClient) {
          await this.store.updateWorkUnit(unit.id, { status: 'skipped_unavailable', errorCode: 'web_search_unavailable', errorMessage: 'Public web search is unavailable; linked business-site documents can still be processed.' });
          continue;
        }
        if (webRequestsUsed >= (filters.publicSearchRequestBudget ?? 1_200)) {
          await this.store.updateWorkUnit(unit.id, { status: 'skipped_budget', errorCode: 'web_search_budget_exhausted', errorMessage: 'Adjust the discovery request budget to execute more document searches.' });
          continue;
        }
        try {
          const urls: string[] = [];
          const documentQueries = [
            unit.query,
            ['phone', unit.geography.areaCode, unit.geography.city, unit.geography.state, 'email contact directory', `filetype:${unit.documentType}`].filter(Boolean).join(' '),
          ];
          for (const query of [...new Set(documentQueries)]) {
            if (webRequestsUsed >= (filters.publicSearchRequestBudget ?? 1_200)) break;
            webRequestsUsed += 1;
            for (const url of await this.deps.webSearchClient.search(query, 50)) if (!urls.includes(url)) urls.push(url);
            if (await this.wasCancelled(campaignId)) return;
          }
          let processed = 0;
          for (const url of urls) {
            if (await this.wasCancelled(campaignId)) return;
            processed += await this.processDocumentUrl(campaignId, url, unit.documentType, unit.geography, filters);
          }
          if (await this.wasCancelled(campaignId)) return;
          connectorSuccesses += 1;
          await this.store.updateWorkUnit(unit.id, { status: 'completed', resultCount: processed });
          await recordPerformance(processed);
        } catch (error) {
          if (await this.wasCancelled(campaignId)) return;
          connectorFailures += 1;
          await this.store.updateWorkUnit(unit.id, { status: 'failed', errorCode: 'document_discovery_failed', errorMessage: error instanceof Error ? error.message : 'Document discovery failed.' });
          await recordPerformance(0, 1);
        }
        continue;
      }
      const mapsFilters = googleMapsFilters(filters, unit.geography);
      const marketCount = Math.max(1, filters.areaCodes.length, filters.states.length, filters.cities.length, filters.postalCodes.length);
      const perMarketResults = Math.min(250, Math.max(25, Math.ceil(filters.maxResults / marketCount)));
      const calls: Array<Promise<unknown[]>> = [];
      if (this.deps.localClient) calls.push(this.deps.localClient.search({
        filters: { ...mapsFilters, maxPlaces: perMarketResults }, maxResults: perMarketResults, proxyUrls,
        shouldStop: () => this.cancelledCampaigns.has(campaignId),
      }));
      if (this.deps.googleClient && googleKeys.length) calls.push(this.deps.googleClient.search({
        apiKey: googleKeys[0], apiKeys: googleKeys, filters: mapsFilters,
        maxResults: perMarketResults, requestBudget: filters.googleRequestBudget,
        shouldStop: () => this.cancelledCampaigns.has(campaignId),
      }));
      const settled = await Promise.allSettled(calls);
      if (await this.wasCancelled(campaignId)) return;
      connectorFailures += settled.filter((entry) => entry.status === 'rejected').length;
      connectorSuccesses += settled.filter((entry) => entry.status === 'fulfilled').length;
      const rawItems = settled.flatMap((entry) => entry.status === 'fulfilled' ? entry.value : []);
      let processed = 0;
      const scopedFilters: TargetedDraftInput = {
        ...filters,
        areaCodes: unit.geography.areaCode ? [unit.geography.areaCode] : [],
        states: unit.geography.state ? [unit.geography.state] : [],
        cities: unit.geography.city ? [unit.geography.city] : [],
        postalCodes: unit.geography.postalCode ? [unit.geography.postalCode] : [],
      };
      try {
        for (const raw of rawItems) {
          if (await this.wasCancelled(campaignId)) return;
          const lead = targetedNormalize(raw);
          const identity = leadIdentity(lead) || JSON.stringify(raw);
          if (seenBusinesses.has(identity)) continue;
          seenBusinesses.add(identity);
          processed += await this.processLead(campaignId, lead, scopedFilters);
        }
        await this.store.updateWorkUnit(unit.id, { status: 'completed', resultCount: processed });
        await recordPerformance(processed);
      } catch (error) {
        if (await this.wasCancelled(campaignId)) return;
        connectorFailures += 1;
        await this.store.updateWorkUnit(unit.id, {
          status: 'failed', resultCount: processed, errorCode: 'processing_failed',
          errorMessage: error instanceof Error ? error.message : 'Targeted processing failed.',
        });
        await recordPerformance(processed, 1);
      }
    }

    if (await this.wasCancelled(campaignId)) return;
    const final = await this.requireCampaign(campaignId);
    const status = connectorFailures > 0 && (connectorSuccesses > 0 || final.funnel.discovered > 0)
      ? 'partially_completed' : connectorFailures > 0 && connectorSuccesses === 0
        ? 'failed' : 'completed';
    await this.store.updateStatus(campaignId, { status, completedAt: new Date(), errorMessage: connectorFailures ? `${connectorFailures} connector or processing operation(s) failed.` : null });
    await this.store.addEvent(campaignId, status, `Targeted campaign ${status.replace('_', ' ')}.`, (await this.store.get(campaignId))?.funnel);
  }

  private async processDocumentUrl(
    campaignId: number,
    url: string,
    documentType: string,
    geography: { country: 'US' | 'CA'; areaCode: string; state: string; city: string; postalCode: string },
    filters: TargetedDraftInput,
  ): Promise<number> {
    let artifactId = await this.store.createArtifact(campaignId, {
      canonicalUrl: url, sourceType: 'public_document', retrievalStatus: 'discovered', metadata: { documentType, geography },
    });
    try {
      const artifact = await this.artifactFetcher(url);
      const sections = await this.documentExtractor(artifact);
      artifactId = await this.store.createArtifact(campaignId, {
        canonicalUrl: artifact.finalUrl, sourceType: 'public_document', retrievalStatus: 'parsed',
        contentType: artifact.contentType, metadata: { documentType, geography, byteCount: artifact.byteCount, sectionCount: sections.length },
      });
      const scopedFilters: TargetedDraftInput = {
        ...filters,
        areaCodes: geography.areaCode ? [geography.areaCode] : [], states: geography.state ? [geography.state] : [],
        cities: geography.city ? [geography.city] : [], postalCodes: geography.postalCode ? [geography.postalCode] : [],
      };
      let count = 0;
      let artifactContacts = 0;
      for (const section of sections) {
        const remaining = Math.max(0, 20_000 - artifactContacts);
        for (const email of extractEmailCandidatesFromText(section.text).slice(0, Math.min(500, remaining))) {
          const association = associatePublicContact({ email }, {
            website: artifact.finalUrl, text: section.text, contactSource: 'public_document', exactEmailPublished: true,
          });
          const mail = await classifyMailInfrastructure(email, this.deps.mxResolver);
          const relevance = scoreTargetedCandidate({
            companyName: section.text, category: section.text, address: section.text,
            email, sourceUrl: artifact.finalUrl, visibleProvider: visibleDomainProvider(email)?.id,
            infrastructureProviders: mail.infrastructureProviders,
          }, scopedFilters);
          let qualityTier: TargetedQualityTier = relevance.tier;
          if (!association.accepted || mail.tier === 'rejected' || !relevance.accepted) qualityTier = 'rejected';
          else if (mail.tier === 'review' || relevance.tier === 'review') qualityTier = 'review';
          await this.store.upsertCandidate(campaignId, {
            email, website: artifact.finalUrl, address: section.text, visibleProvider: visibleDomainProvider(email)?.id,
            infrastructureProviders: mail.infrastructureProviders, relevanceScore: relevance.score,
            relevanceReason: relevance.reason, qualityTier, verificationDepth: mail.depth,
            complianceStatus: 'public_b2b', artifactId,
            evidence: {
              evidenceType: 'public_document_contact', excerpt: section.text,
              fields: { documentType, page: section.page, sheet: section.sheet, row: section.row, contactReason: association.reason, geography },
            },
            verification: { checkType: 'mx', status: mail.mxValid ? 'valid' : qualityTier, depth: mail.depth, reason: mail.reason, providerVersion: 'catalog-2026-08-03' },
          });
          count += 1;
          artifactContacts += 1;
        }
        if (artifactContacts >= 20_000) break;
      }
      return count;
    } catch (error) {
      await this.store.createArtifact(campaignId, {
        canonicalUrl: url, sourceType: 'public_document', retrievalStatus: 'quarantined',
        metadata: { documentType, reason: error instanceof Error ? error.message : 'Document processing failed.' },
      });
      return 0;
    }
  }

  private async processLinkedDocuments(campaignId: number, website: string, filters: TargetedDraftInput): Promise<number> {
    try {
      const page = await this.artifactFetcher(website);
      if (page.contentType !== 'text/html') return 0;
      const links = discoverPublicDocumentLinks(page.body.toString('utf8'), page.finalUrl, 20);
      await this.store.createArtifact(campaignId, {
        canonicalUrl: page.finalUrl, sourceType: 'public_business_website', retrievalStatus: 'scanned',
        contentType: page.contentType, metadata: { byteCount: page.byteCount, linkedDocumentCount: links.length },
      });
      const geography = {
        country: filters.country,
        areaCode: filters.areaCodes[0] ?? '', state: filters.states[0] ?? '',
        city: filters.cities[0] ?? '', postalCode: filters.postalCodes[0] ?? '',
      };
      let count = 0;
      for (const link of links) {
        const documentType = new URL(link).pathname.split('.').at(-1)?.toLowerCase() ?? 'document';
        count += await this.processDocumentUrl(campaignId, link, documentType, geography, filters);
      }
      return count;
    } catch {
      return 0;
    }
  }

  private async processLead(campaignId: number, lead: NormalizedLead, filters: TargetedDraftInput): Promise<number> {
    const preliminary = scoreTargetedCandidate({
      companyName: lead.companyName, category: lead.categoryName, jobTitle: lead.jobTitle,
      address: lead.address ?? lead.location, email: lead.email ?? '', sourceUrl: lead.website ?? lead.placeUrl,
    }, filters);
    const sourceUrl = lead.website ?? lead.placeUrl;
    const artifactId = sourceUrl ? await this.store.createArtifact(campaignId, {
      canonicalUrl: sourceUrl, sourceType: lead.website ? 'public_business_website' : 'public_business_listing',
      retrievalStatus: 'discovered', metadata: { companyName: lead.companyName, address: lead.address },
    }) : undefined;

    if (!preliminary.accepted) {
      if (!lead.email) return 0;
      await this.store.upsertCandidate(campaignId, {
        email: lead.email, companyName: lead.companyName, jobTitle: lead.jobTitle, website: lead.website,
        phone: lead.phone, address: lead.address ?? lead.location, infrastructureProviders: [],
        visibleProvider: visibleDomainProvider(lead.email)?.id, relevanceScore: preliminary.score,
        relevanceReason: preliminary.reason, qualityTier: 'rejected', verificationDepth: 'syntax',
        complianceStatus: 'public_b2b', artifactId,
        evidence: { evidenceType: 'public_business_source', excerpt: `${lead.companyName ?? ''} ${lead.address ?? ''}`.trim(), fields: preliminary },
        verification: { checkType: 'relevance', status: 'rejected', depth: 'syntax', reason: preliminary.reason, providerVersion: 'rules-2026-08-03' },
      });
      return 1;
    }

    if (await this.store.isCancelled(campaignId)) return 0;
    const contacts = (await collectContactCandidates(lead, this.deps.emailExtractor)).slice(0, filters.maxContactsPerCompany);
    let count = 0;
    for (const contact of contacts) {
      const association = associatePublicContact({ email: contact.email! }, {
        website: contact.website,
        contactSource: contact.contactSource,
        exactEmailPublished: true,
      });
      const mail = await classifyMailInfrastructure(contact.email!, this.deps.mxResolver);
      const relevance = scoreTargetedCandidate({
        companyName: contact.companyName, category: contact.categoryName, jobTitle: contact.jobTitle,
        address: contact.address ?? contact.location, email: contact.email!, sourceUrl: contact.website ?? contact.placeUrl,
        visibleProvider: visibleDomainProvider(contact.email!)?.id,
        infrastructureProviders: mail.infrastructureProviders,
      }, filters);
      let qualityTier: TargetedQualityTier = relevance.tier;
      if (!association.accepted || mail.tier === 'rejected' || !relevance.accepted) qualityTier = 'rejected';
      else if (mail.tier === 'review' || relevance.tier === 'review') qualityTier = 'review';
      await this.store.upsertCandidate(campaignId, {
        email: contact.email!, fullName: contact.fullName, jobTitle: contact.jobTitle,
        companyName: contact.companyName, website: contact.website, phone: contact.phone,
        address: contact.address ?? contact.location, visibleProvider: visibleDomainProvider(contact.email!)?.id,
        infrastructureProviders: mail.infrastructureProviders, relevanceScore: relevance.score,
        relevanceReason: relevance.reason, qualityTier, verificationDepth: mail.depth,
        complianceStatus: 'public_b2b', artifactId,
        evidence: {
          evidenceType: 'public_business_source',
          excerpt: `${contact.companyName ?? ''} ${contact.jobTitle ?? ''} ${contact.address ?? ''}`.trim(),
          fields: { matchedRules: relevance.matchedRules, missingRules: relevance.missingRules, contactReason: association.reason },
        },
        verification: { checkType: 'mx', status: mail.mxValid ? 'valid' : qualityTier, depth: mail.depth, reason: mail.reason, providerVersion: 'catalog-2026-08-03' },
      });
      count += 1;
    }
    if (lead.website) count += await this.processLinkedDocuments(campaignId, lead.website, filters);
    return count;
  }
}
