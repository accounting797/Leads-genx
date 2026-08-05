import { PrismaTargetedStore } from './store';
import { GooglePlacesApiClient } from '../../integrations/googlePlacesApiClient';
import { LocalMapsScraperKitClient } from '../../integrations/localMapsScraperClient';
import { WebsiteEmailExtractor } from '../emailExtractor';
import { PublicWebSearchClient } from './publicWebSearch';
import { safeErrorMessage } from '../errorLogger';

export interface TargetedFilters {
  keywords: string[];
  locations: string[];
  categories?: string[];
  maxResultsPerLocation?: number;
  publicSearchRequestBudget?: number;
  enableGooglePlaces?: boolean;
  enableLocalMapsScraper?: boolean;
  enablePublicWebSearch?: boolean;
  extractEmails?: boolean;
  proxyUrls?: string[];
  googleApiKeys?: string[];
}

export interface CampaignProgress {
  totalLocations: number;
  completedLocations: number;
  currentLocation: string;
  totalLeadsFound: number;
  errors: string[];
}

export class TargetedService {
  private googleClient: GooglePlacesApiClient;
  private localClient: LocalMapsScraperKitClient;
  private emailExtractor: WebsiteEmailExtractor;
  private webSearchClient: PublicWebSearchClient;
  private store: PrismaTargetedStore;
  private settingsLoader: () => Promise<{ googleApiKeys?: string[]; proxyUrls?: string[] }>;

  constructor(deps: {
    store: PrismaTargetedStore;
    googleClient: GooglePlacesApiClient;
    localClient: LocalMapsScraperKitClient;
    emailExtractor: WebsiteEmailExtractor;
    webSearchClient: PublicWebSearchClient;
    settingsLoader: () => Promise<{ googleApiKeys?: string[]; proxyUrls?: string[] }>;
  }) {
    this.store = deps.store;
    this.googleClient = deps.googleClient;
    this.localClient = deps.localClient;
    this.emailExtractor = deps.emailExtractor;
    this.webSearchClient = deps.webSearchClient;
    this.settingsLoader = deps.settingsLoader;
  }

  async createCampaign(name: string, description: string | undefined, filters: TargetedFilters, ownerId?: string) {
    if (!name || name.trim().length === 0) {
      throw new Error('Campaign name is required');
    }
    if (!filters.keywords || filters.keywords.length === 0) {
      throw new Error('At least one keyword is required');
    }
    if (!filters.locations || filters.locations.length === 0) {
      throw new Error('At least one location is required');
    }

    const cleanKeywords = filters.keywords.map(k => k.trim()).filter(k => k.length > 0);
    const cleanLocations = filters.locations.map(l => l.trim()).filter(l => l.length > 0);

    if (cleanKeywords.length === 0) {
      throw new Error('Keywords cannot be empty after trimming');
    }
    if (cleanLocations.length === 0) {
      throw new Error('Locations cannot be empty after trimming');
    }

    const normalizedFilters: TargetedFilters = {
      ...filters,
      keywords: cleanKeywords,
      locations: cleanLocations,
      maxResultsPerLocation: Math.min(filters.maxResultsPerLocation ?? 50, 200),
      publicSearchRequestBudget: filters.publicSearchRequestBudget !== undefined ? filters.publicSearchRequestBudget : 1200,
      enableGooglePlaces: filters.enableGooglePlaces ?? true,
      enableLocalMapsScraper: filters.enableLocalMapsScraper ?? false,
      enablePublicWebSearch: filters.enablePublicWebSearch ?? true,
      extractEmails: filters.extractEmails ?? true,
    };

    return this.store.createCampaign({
      name: name.trim(),
      description: description?.trim(),
      filters: normalizedFilters as Record<string, unknown>,
      ownerId,
    });
  }

  async runCampaign(campaignId: string): Promise<{ success: boolean; leadsFound: number; errors: string[] }> {
    const errors: string[] = [];
    let totalLeadsFound = 0;

    try {
      const campaign = await this.store.getCampaign(campaignId);
      if (!campaign) {
        throw new Error(`Campaign ${campaignId} not found`);
      }

      await this.store.updateCampaign(campaignId, { status: 'running' });

      const filters = campaign.filters as TargetedFilters;
      const keywords = filters.keywords || [];
      const locations = filters.locations || [];
      const maxResults = filters.maxResultsPerLocation ?? 50;

      // FIX: Handle budget of 0 correctly - only fallback when undefined, not when 0
      const budget = filters.publicSearchRequestBudget !== undefined 
        ? filters.publicSearchRequestBudget 
        : 1200;

      const extractEmails = filters.extractEmails ?? true;
      const enableGoogle = filters.enableGooglePlaces ?? true;
      const enableLocal = filters.enableLocalMapsScraper ?? false;
      const enableWeb = filters.enablePublicWebSearch ?? true;

      let settings: { googleApiKeys?: string[]; proxyUrls?: string[] } = {};
      try {
        settings = await this.settingsLoader();
      } catch (e) {
        console.warn('[TargetedService] Failed to load operator settings:', safeErrorMessage(e));
      }

      const proxyUrls = filters.proxyUrls ?? settings.proxyUrls ?? [];
      const googleApiKeys = filters.googleApiKeys ?? settings.googleApiKeys ?? [];

      let webRequestsUsed = 0;

      for (let locIndex = 0; locIndex < locations.length; locIndex++) {
        const location = locations[locIndex];

        try {
          console.log(`[TargetedService] Processing location ${locIndex + 1}/${locations.length}: ${location}`);

          for (const keyword of keywords) {
            const searchQuery = `${keyword} in ${location}`;
            const leadsFromLocation: Array<{
              source: string;
              businessName: string;
              address?: string;
              phone?: string;
              website?: string;
              email?: string;
              category?: string;
              rating?: number;
              reviewsCount?: number;
              rawData?: Record<string, unknown>;
            }> = [];

            if (enableGoogle && googleApiKeys.length > 0) {
              try {
                const apiKey = googleApiKeys[locIndex % googleApiKeys.length];
                const places = await this.googleClient.searchPlaces({
                  query: searchQuery,
                  apiKey,
                  maxResults,
                });

                for (const place of places) {
                  leadsFromLocation.push({
                    source: 'google_places',
                    businessName: place.name || 'Unknown',
                    address: place.formatted_address || place.vicinity,
                    phone: place.formatted_phone_number,
                    website: place.website,
                    category: place.types?.[0],
                    rating: place.rating,
                    reviewsCount: place.user_ratings_total,
                    rawData: place as Record<string, unknown>,
                  });
                }
              } catch (e) {
                const msg = `Google Places failed for "${searchQuery}": ${safeErrorMessage(e)}`;
                console.error(`[TargetedService] ${msg}`);
                errors.push(msg);
              }
            }

            if (enableLocal) {
              try {
                const scraperResults = await this.localClient.scrape({
                  searchString: searchQuery,
                  maxResults,
                  proxyUrls,
                });

                for (const result of scraperResults) {
                  leadsFromLocation.push({
                    source: 'local_maps_scraper',
                    businessName: result.title,
                    address: result.address,
                    phone: result.phone,
                    website: result.website,
                    category: result.category,
                    rating: result.rating,
                    reviewsCount: result.reviewsCount,
                    rawData: result as unknown as Record<string, unknown>,
                  });
                }
              } catch (e) {
                const msg = `Local Maps Scraper failed for "${searchQuery}": ${safeErrorMessage(e)}`;
                console.error(`[TargetedService] ${msg}`);
                errors.push(msg);
              }
            }

            if (enableWeb && webRequestsUsed < budget) {
              try {
                const webResults = await this.webSearchClient.search({
                  query: searchQuery,
                  maxResults: Math.min(10, maxResults),
                });

                webRequestsUsed += 1;

                for (const result of webResults) {
                  leadsFromLocation.push({
                    source: 'public_web_search',
                    businessName: result.title,
                    website: result.link,
                    category: 'Web Result',
                    rawData: { snippet: result.snippet, displayUrl: result.displayUrl },
                  });
                }
              } catch (e) {
                const msg = `Public Web Search failed for "${searchQuery}": ${safeErrorMessage(e)}`;
                console.error(`[TargetedService] ${msg}`);
                errors.push(msg);
              }
            }

            if (extractEmails) {
              for (const lead of leadsFromLocation) {
                if (lead.website && !lead.email) {
                  try {
                    const emails = await this.emailExtractor.extract(lead.website);
                    if (emails.length > 0) {
                      lead.email = emails[0];
                    }
                  } catch (e) {
                    console.warn(`[TargetedService] Email extraction failed for ${lead.website}: ${safeErrorMessage(e)}`);
                  }
                }
              }
            }

            const uniqueLeads = this.deduplicateLeads(leadsFromLocation);

            if (uniqueLeads.length > 0) {
              const saveResult = await this.store.addLeads(
                uniqueLeads.map(l => ({
                  campaignId,
                  ...l,
                }))
              );
              totalLeadsFound += saveResult.count;
            }
          }
        } catch (e) {
          const msg = `Location "${location}" failed: ${safeErrorMessage(e)}`;
          console.error(`[TargetedService] ${msg}`);
          errors.push(msg);
        }
      }

      await this.store.updateCampaign(campaignId, { status: 'completed' });

      return {
        success: true,
        leadsFound: totalLeadsFound,
        errors,
      };
    } catch (e) {
      const fatalError = safeErrorMessage(e);
      console.error(`[TargetedService] Campaign ${campaignId} failed fatally: ${fatalError}`);

      await this.store.updateCampaign(campaignId, { status: 'failed' }).catch(() => {});

      return {
        success: false,
        leadsFound: totalLeadsFound,
        errors: [...errors, fatalError],
      };
    }
  }

  async recoverInterruptedCampaigns(): Promise<{ recovered: number; failed: number }> {
    const interrupted = await this.store.getInterruptedCampaigns();
    let recovered = 0;
    let failed = 0;

    for (const campaign of interrupted) {
      try {
        console.log(`[TargetedService] Recovering campaign ${campaign.id}: ${campaign.name}`);

        await this.store.updateCampaign(campaign.id, { status: 'pending' });

        const result = await this.runCampaign(campaign.id);

        if (result.success) {
          recovered++;
        } else {
          failed++;
        }
      } catch (e) {
        console.error(`[TargetedService] Recovery failed for ${campaign.id}: ${safeErrorMessage(e)}`);
        failed++;

        await this.store.updateCampaign(campaign.id, { status: 'failed' }).catch(() => {});
      }
    }

    return { recovered, failed };
  }

  async getCampaignStatus(campaignId: string) {
    const campaign = await this.store.getCampaign(campaignId);
    if (!campaign) return null;

    const leadStats = await this.store.getLeads(campaignId);

    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
      totalLeads: leadStats.total,
      leadsWithEmail: leadStats.leads.filter(l => l.email).length,
      leadsWithPhone: leadStats.leads.filter(l => l.phone).length,
      leadsWithWebsite: leadStats.leads.filter(l => l.website).length,
    };
  }

  private deduplicateLeads(leads: Array<{ businessName: string; website?: string; address?: string }>) {
    const seen = new Set<string>();
    return leads.filter(lead => {
      const key = `${lead.businessName.toLowerCase().trim()}:${(lead.website || '').toLowerCase().trim()}:${(lead.address || '').toLowerCase().trim()}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
}
