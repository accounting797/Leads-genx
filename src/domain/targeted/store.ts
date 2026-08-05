import { PrismaClient, Prisma } from '@prisma/client';

export interface CampaignCreateInput {
  name: string;
  description?: string;
  filters: Record<string, unknown>;
  ownerId?: string;
}

export interface CampaignUpdateInput {
  name?: string;
  description?: string;
  filters?: Record<string, unknown>;
  status?: string;
}

export interface LeadCreateInput {
  campaignId: string;
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
}

export class PrismaTargetedStore {
  constructor(private prisma: PrismaClient) {}

  async createCampaign(data: CampaignCreateInput) {
    try {
      return await this.prisma.targetedCampaign.create({
        data: {
          name: data.name,
          description: data.description,
          filters: data.filters as Prisma.InputJsonValue,
          status: 'pending',
          ownerId: data.ownerId,
        },
      });
    } catch (error) {
      console.error('[TargetedStore] createCampaign failed:', error);
      throw new Error(`Failed to create campaign: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getCampaign(id: string) {
    try {
      return await this.prisma.targetedCampaign.findUnique({
        where: { id },
        include: {
          leads: {
            orderBy: { createdAt: 'desc' },
          },
        },
      });
    } catch (error) {
      console.error('[TargetedStore] getCampaign failed:', error);
      throw new Error(`Failed to fetch campaign: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async listCampaigns(options?: { ownerId?: string; status?: string; limit?: number; offset?: number }) {
    try {
      const where: Prisma.TargetedCampaignWhereInput = {};

      if (options?.ownerId) {
        where.ownerId = options.ownerId;
      }
      if (options?.status) {
        where.status = options.status;
      }

      const [campaigns, total] = await Promise.all([
        this.prisma.targetedCampaign.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: options?.limit ?? 50,
          skip: options?.offset ?? 0,
          include: {
            _count: {
              select: { leads: true },
            },
          },
        }),
        this.prisma.targetedCampaign.count({ where }),
      ]);

      return { campaigns, total };
    } catch (error) {
      console.error('[TargetedStore] listCampaigns failed:', error);
      throw new Error(`Failed to list campaigns: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async updateCampaign(id: string, data: CampaignUpdateInput) {
    try {
      return await this.prisma.targetedCampaign.update({
        where: { id },
        data: {
          ...(data.name && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.filters && { filters: data.filters as Prisma.InputJsonValue }),
          ...(data.status && { status: data.status }),
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      console.error('[TargetedStore] updateCampaign failed:', error);
      throw new Error(`Failed to update campaign: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async deleteCampaign(id: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.targetedLead.deleteMany({
          where: { campaignId: id },
        });

        return await tx.targetedCampaign.delete({
          where: { id },
        });
      });
    } catch (error) {
      console.error('[TargetedStore] deleteCampaign failed:', error);
      throw new Error(`Failed to delete campaign: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async addLeads(leads: LeadCreateInput[]) {
    if (leads.length === 0) return { count: 0 };

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const campaignIds = [...new Set(leads.map(l => l.campaignId))];

        const existingLeads = await tx.targetedLead.findMany({
          where: {
            campaignId: { in: campaignIds },
            OR: leads.map(l => ({
              AND: [
                { campaignId: l.campaignId },
                { businessName: l.businessName },
                ...(l.website ? [{ website: l.website }] : []),
              ],
            })),
          },
          select: {
            campaignId: true,
            businessName: true,
            website: true,
          },
        });

        const existingSet = new Set(
          existingLeads.map(l => `${l.campaignId}:${l.businessName}:${l.website || ''}`)
        );

        const uniqueLeads = leads.filter(l => {
          const key = `${l.campaignId}:${l.businessName}:${l.website || ''}`;
          return !existingSet.has(key);
        });

        if (uniqueLeads.length === 0) {
          return { count: 0 };
        }

        const created = await tx.targetedLead.createMany({
          data: uniqueLeads.map(l => ({
            campaignId: l.campaignId,
            source: l.source,
            businessName: l.businessName,
            address: l.address,
            phone: l.phone,
            website: l.website,
            email: l.email,
            category: l.category,
            rating: l.rating,
            reviewsCount: l.reviewsCount,
            rawData: l.rawData as Prisma.InputJsonValue,
          })),
          skipDuplicates: true,
        });

        return created;
      });

      return result;
    } catch (error) {
      console.error('[TargetedStore] addLeads failed:', error);
      throw new Error(`Failed to add leads: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getLeads(campaignId: string, options?: { limit?: number; offset?: number; hasEmail?: boolean }) {
    try {
      const where: Prisma.TargetedLeadWhereInput = { campaignId };

      if (options?.hasEmail === true) {
        where.email = { not: null };
      } else if (options?.hasEmail === false) {
        where.email = null;
      }

      const [leads, total] = await Promise.all([
        this.prisma.targetedLead.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: options?.limit ?? 100,
          skip: options?.offset ?? 0,
        }),
        this.prisma.targetedLead.count({ where }),
      ]);

      return { leads, total };
    } catch (error) {
      console.error('[TargetedStore] getLeads failed:', error);
      throw new Error(`Failed to fetch leads: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getInterruptedCampaigns() {
    try {
      return await this.prisma.targetedCampaign.findMany({
        where: {
          status: { in: ['running', 'paused'] },
        },
        orderBy: { updatedAt: 'desc' },
      });
    } catch (error) {
      console.error('[TargetedStore] getInterruptedCampaigns failed:', error);
      return [];
    }
  }
}
