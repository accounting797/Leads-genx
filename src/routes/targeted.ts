import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { TargetedService } from '../domain/targeted/service';
import { PrismaTargetedStore } from '../domain/targeted/store';
import { GooglePlacesApiClient } from '../integrations/googlePlacesApiClient';
import { LocalMapsScraperKitClient } from '../integrations/localMapsScraperClient';
import { WebsiteEmailExtractor } from '../domain/emailExtractor';
import { PublicWebSearchClient } from '../domain/targeted/publicWebSearch';
import { loadOperatorSettings } from '../domain/operatorSettings';
import { asyncHandler } from '../utils/asyncHandler';
import { safeErrorMessage } from '../domain/errorLogger';

export function createTargetedRouter(deps: {
  prisma: PrismaClient;
  targetedService?: TargetedService;
}) {
  const router = Router();
  const { prisma } = deps;

  const store = new PrismaTargetedStore(prisma);
  const targetedService = deps.targetedService ?? new TargetedService({
    store,
    googleClient: new GooglePlacesApiClient(),
    localClient: new LocalMapsScraperKitClient({ maxPolls: 120 }),
    emailExtractor: new WebsiteEmailExtractor(),
    webSearchClient: new PublicWebSearchClient(),
    settingsLoader: async () => {
      const settings = await loadOperatorSettings(prisma);
      return { googleApiKeys: settings.googleApiKeys, proxyUrls: settings.proxyUrls };
    },
  });

  function validateCampaignInput(body: any): { valid: boolean; error?: string; data?: any } {
    if (!body || typeof body !== 'object') {
      return { valid: false, error: 'Request body is required' };
    }

    const { name, description, filters } = body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return { valid: false, error: 'Campaign name is required and must be a non-empty string' };
    }

    if (name.trim().length > 200) {
      return { valid: false, error: 'Campaign name must be 200 characters or less' };
    }

    if (!filters || typeof filters !== 'object') {
      return { valid: false, error: 'Filters object is required' };
    }

    if (!Array.isArray(filters.keywords) || filters.keywords.length === 0) {
      return { valid: false, error: 'filters.keywords must be a non-empty array' };
    }

    if (!Array.isArray(filters.locations) || filters.locations.length === 0) {
      return { valid: false, error: 'filters.locations must be a non-empty array' };
    }

    for (const keyword of filters.keywords) {
      if (typeof keyword !== 'string' || keyword.trim().length === 0) {
        return { valid: false, error: 'All keywords must be non-empty strings' };
      }
    }

    for (const location of filters.locations) {
      if (typeof location !== 'string' || location.trim().length === 0) {
        return { valid: false, error: 'All locations must be non-empty strings' };
      }
    }

    if (filters.maxResultsPerLocation !== undefined) {
      const val = Number(filters.maxResultsPerLocation);
      if (isNaN(val) || val < 1 || val > 500) {
        return { valid: false, error: 'maxResultsPerLocation must be between 1 and 500' };
      }
    }

    if (filters.publicSearchRequestBudget !== undefined) {
      const val = Number(filters.publicSearchRequestBudget);
      if (isNaN(val) || val < 0 || val > 10000) {
        return { valid: false, error: 'publicSearchRequestBudget must be between 0 and 10000' };
      }
    }

    return {
      valid: true,
      data: {
        name: name.trim(),
        description: description?.trim(),
        filters: {
          keywords: filters.keywords.map((k: string) => k.trim()).filter(Boolean),
          locations: filters.locations.map((l: string) => l.trim()).filter(Boolean),
          categories: Array.isArray(filters.categories) ? filters.categories : undefined,
          maxResultsPerLocation: filters.maxResultsPerLocation ? Number(filters.maxResultsPerLocation) : undefined,
          publicSearchRequestBudget: filters.publicSearchRequestBudget !== undefined ? Number(filters.publicSearchRequestBudget) : undefined,
          enableGooglePlaces: filters.enableGooglePlaces !== false,
          enableLocalMapsScraper: filters.enableLocalMapsScraper === true,
          enablePublicWebSearch: filters.enablePublicWebSearch !== false,
          extractEmails: filters.extractEmails !== false,
          proxyUrls: Array.isArray(filters.proxyUrls) ? filters.proxyUrls : undefined,
          googleApiKeys: Array.isArray(filters.googleApiKeys) ? filters.googleApiKeys : undefined,
        },
      },
    };
  }

  router.get('/campaigns', asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const status = req.query.status as string | undefined;
    const ownerId = (req as any).user?.id;

    const result = await store.listCampaigns({ ownerId, status, limit, offset });

    res.json({
      success: true,
      data: result.campaigns,
      pagination: {
        total: result.total,
        limit,
        offset,
        hasMore: offset + limit < result.total,
      },
    });
  }));

  router.post('/campaigns', asyncHandler(async (req: Request, res: Response) => {
    const validation = validateCampaignInput(req.body);

    if (!validation.valid) {
      res.status(400).json({ success: false, error: validation.error });
      return;
    }

    const { name, description, filters } = validation.data;
    const ownerId = (req as any).user?.id;

    try {
      const campaign = await targetedService.createCampaign(name, description, filters, ownerId);
      res.status(201).json({ success: true, data: campaign });
    } catch (error) {
      console.error('[TargetedRoutes] Create campaign failed:', safeErrorMessage(error));
      res.status(500).json({ success: false, error: safeErrorMessage(error) });
    }
  }));

  router.get('/campaigns/:id', asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    if (!id || id.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Campaign ID is required' });
      return;
    }

    const campaign = await store.getCampaign(id);

    if (!campaign) {
      res.status(404).json({ success: false, error: 'Campaign not found' });
      return;
    }

    res.json({ success: true, data: campaign });
  }));

  router.get('/campaigns/:id/status', asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    if (!id || id.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Campaign ID is required' });
      return;
    }

    const status = await targetedService.getCampaignStatus(id);

    if (!status) {
      res.status(404).json({ success: false, error: 'Campaign not found' });
      return;
    }

    res.json({ success: true, data: status });
  }));

  router.post('/campaigns/:id/run', asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    if (!id || id.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Campaign ID is required' });
      return;
    }

    const campaign = await store.getCampaign(id);
    if (!campaign) {
      res.status(404).json({ success: false, error: 'Campaign not found' });
      return;
    }

    if (campaign.status === 'running') {
      res.status(409).json({ success: false, error: 'Campaign is already running' });
      return;
    }

    res.status(202).json({
      success: true,
      message: 'Campaign started',
      campaignId: id,
      status: 'running',
    });

    targetedService.runCampaign(id).then((result) => {
      console.log(`[TargetedRoutes] Campaign ${id} completed:`, result);
    }).catch((error) => {
      console.error(`[TargetedRoutes] Campaign ${id} failed:`, safeErrorMessage(error));
    });
  }));

  router.delete('/campaigns/:id', asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    if (!id || id.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Campaign ID is required' });
      return;
    }

    const campaign = await store.getCampaign(id);
    if (!campaign) {
      res.status(404).json({ success: false, error: 'Campaign not found' });
      return;
    }

    if (campaign.status === 'running') {
      res.status(409).json({ success: false, error: 'Cannot delete a running campaign. Stop it first.' });
      return;
    }

    await store.deleteCampaign(id);
    res.json({ success: true, message: 'Campaign deleted' });
  }));

  router.get('/campaigns/:id/leads', asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    if (!id || id.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Campaign ID is required' });
      return;
    }

    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const hasEmail = req.query.hasEmail === 'true' ? true : req.query.hasEmail === 'false' ? false : undefined;

    const result = await store.getLeads(id, { limit, offset, hasEmail });

    res.json({
      success: true,
      data: result.leads,
      pagination: {
        total: result.total,
        limit,
        offset,
        hasMore: offset + limit < result.total,
      },
    });
  }));

  router.post('/campaigns/:id/leads', asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    if (!id || id.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Campaign ID is required' });
      return;
    }

    const campaign = await store.getCampaign(id);
    if (!campaign) {
      res.status(404).json({ success: false, error: 'Campaign not found' });
      return;
    }

    const leads = req.body.leads;
    if (!Array.isArray(leads) || leads.length === 0) {
      res.status(400).json({ success: false, error: 'leads array is required' });
      return;
    }

    for (const lead of leads) {
      if (!lead.businessName || typeof lead.businessName !== 'string') {
        res.status(400).json({ success: false, error: 'Each lead must have a businessName string' });
        return;
      }
    }

    const leadsWithCampaign = leads.map((lead: any) => ({
      campaignId: id,
      source: lead.source || 'manual',
      businessName: lead.businessName.trim(),
      address: lead.address?.trim(),
      phone: lead.phone?.trim(),
      website: lead.website?.trim(),
      email: lead.email?.trim(),
      category: lead.category?.trim(),
      rating: lead.rating ? Number(lead.rating) : undefined,
      reviewsCount: lead.reviewsCount ? Number(lead.reviewsCount) : undefined,
      rawData: lead.rawData || {},
    }));

    const result = await store.addLeads(leadsWithCampaign);

    res.status(201).json({
      success: true,
      message: `Added ${result.count} leads`,
      count: result.count,
    });
  }));

  router.post('/recover', asyncHandler(async (req: Request, res: Response) => {
    res.status(202).json({
      success: true,
      message: 'Recovery started',
    });

    targetedService.recoverInterruptedCampaigns().then((result) => {
      console.log('[TargetedRoutes] Recovery completed:', result);
    }).catch((error) => {
      console.error('[TargetedRoutes] Recovery failed:', safeErrorMessage(error));
    });
  }));

  router.use((error: any, req: Request, res: Response, _next: any) => {
    console.error('[TargetedRoutes] Unhandled error:', safeErrorMessage(error));
    res.status(500).json({
      success: false,
      error: process.env.NODE_ENV === 'production' 
        ? 'An unexpected error occurred' 
        : safeErrorMessage(error),
    });
  });

  return router;
}
