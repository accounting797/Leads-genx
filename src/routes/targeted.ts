import { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { currentUser } from '../domain/auth';
import { providerCatalog } from '../domain/targeted/providerCatalog';
import { TargetedService } from '../domain/targeted/service';
import { TargetedQualityTier } from '../domain/targeted/types';
import { asyncHandler } from '../utils/asyncHandler';
import { targetedBankCatalog } from '../domain/targeted/bankCatalog';

export const TARGETED_BANKS = targetedBankCatalog();

export function createTargetedRouter({ prisma, targetedService }: { prisma: PrismaClient; targetedService: TargetedService }) {
  const router = Router();

  async function ownedCampaign(id: number, userId: number) {
    const campaign = await targetedService.get(id);
    return campaign?.userId === userId ? campaign : undefined;
  }

  router.get('/catalog', (_req, res) => {
    res.json({ data: {
      providers: providerCatalog(), banks: TARGETED_BANKS,
      defaults: { topBankMarkets: 100, maxContactsPerCompany: 10, maximumContactsPerCompany: 50, maxWorkUnits: 5000 },
      policy: { eligiblePublicAddressTypes: ['personal', 'business'], mailboxVerificationIncluded: false },
    } });
  });

  router.post('/markets/banks', asyncHandler(async (req, res) => {
    const user = currentUser(res)!;
    const bankId = String(req.body?.bankId ?? req.body?.bankName ?? '').trim();
    if (!bankId) { res.status(400).json({ error: 'Choose a bank.', fields: { bankId: 'Choose a bank.' } }); return; }
    res.json({ data: await targetedService.bankMarkets(bankId, Number(req.body?.limit ?? 100), user.id) });
  }));

  router.post('/learning/reset', asyncHandler(async (_req, res) => {
    res.json({ data: { resetWorkUnits: await targetedService.resetLearning() } });
  }));

  router.post('/geography/audit', asyncHandler(async (_req, res) => {
    const user = currentUser(res)!;
    res.json({ data: { quarantined: await targetedService.auditGeography(user.id) } });
  }));

  router.get('/export', asyncHandler(async (req, res) => {
    const user = currentUser(res)!;
    if (req.query.quality !== 'strict') { res.status(400).json({ error: 'Only Strict targeted contacts can be exported.' }); return; }
    const emails = await targetedService.strictEmailsAll(user.id);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads-genx-targeted-all-strict.txt"');
    res.send(emails.length ? `${emails.join('\n')}\n` : '');
  }));

  router.post('/campaigns', asyncHandler(async (req, res) => {
    const user = currentUser(res);
    if (!user) { res.status(401).json({ error: 'Sign in required.' }); return; }
    res.status(201).json({ data: await targetedService.createDraft(user.id, req.body) });
  }));

  router.get('/campaigns', asyncHandler(async (req, res) => {
    const user = currentUser(res)!;
    res.json({ data: await targetedService.list(Number(req.query.limit ?? 50), user.id) });
  }));

  router.post('/campaigns/:id/plan', asyncHandler(async (req, res) => {
    const id = Number(req.params.id); const user = currentUser(res)!;
    if (!await ownedCampaign(id, user.id)) { res.status(404).json({ error: 'Targeted campaign not found.' }); return; }
    res.json({ data: await targetedService.plan(id) });
  }));

  router.patch('/campaigns/:id/work-units/:unitId', asyncHandler(async (req, res) => {
    const id = Number(req.params.id); const user = currentUser(res)!;
    if (!await ownedCampaign(id, user.id)) { res.status(404).json({ error: 'Targeted campaign not found.' }); return; }
    const unit = await targetedService.editWorkUnit(id, Number(req.params.unitId), String(req.body?.query ?? ''));
    if (!unit) { res.status(404).json({ error: 'Targeted work unit not found.' }); return; }
    res.json({ data: unit });
  }));

  router.post('/campaigns/:id/start', asyncHandler(async (req, res) => {
    const id = Number(req.params.id); const user = currentUser(res)!;
    if (!await ownedCampaign(id, user.id)) { res.status(404).json({ error: 'Targeted campaign not found.' }); return; }
    const data = await targetedService.start(id, { ...req.body, background: true });
    res.status(202).json({ data });
  }));

  router.post('/campaigns/:id/stop', asyncHandler(async (req, res) => {
    const id = Number(req.params.id); const user = currentUser(res)!;
    if (!await ownedCampaign(id, user.id)) { res.status(404).json({ error: 'Targeted campaign not found.' }); return; }
    await targetedService.stop(id);
    res.status(202).json({ data: { id, status: 'cancelled' } });
  }));

  router.delete('/campaigns/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id); const user = currentUser(res)!;
    if (!await ownedCampaign(id, user.id)) { res.status(404).json({ error: 'Targeted campaign not found.' }); return; }
    await targetedService.delete(id);
    res.status(204).send();
  }));

  router.get('/campaigns/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id); const user = currentUser(res)!;
    const campaign = await ownedCampaign(id, user.id);
    if (!campaign) { res.status(404).json({ error: 'Targeted campaign not found.' }); return; }
    res.json({ data: { ...campaign, workUnits: await targetedService.workUnits(id) } });
  }));

  router.get('/campaigns/:id/candidates', asyncHandler(async (req, res) => {
    const id = Number(req.params.id); const user = currentUser(res)!;
    if (!await ownedCampaign(id, user.id)) { res.status(404).json({ error: 'Targeted campaign not found.' }); return; }
    const tier = ['strict', 'review', 'rejected'].includes(String(req.query.tier))
      ? String(req.query.tier) as TargetedQualityTier : undefined;
    res.json({ data: await targetedService.listCandidates(id, {
      tier, limit: Number(req.query.limit ?? 1_000), offset: Number(req.query.offset ?? 0),
    }) });
  }));

  router.get('/campaigns/:id/export', asyncHandler(async (req, res) => {
    const id = Number(req.params.id); const user = currentUser(res)!;
    if (!await ownedCampaign(id, user.id)) { res.status(404).json({ error: 'Targeted campaign not found.' }); return; }
    if (req.query.quality !== 'strict') { res.status(400).json({ error: 'Only Strict targeted contacts can be exported.' }); return; }
    const emails = await targetedService.strictEmails(id);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-genx-targeted-${id}-strict.txt"`);
    res.send(emails.length ? `${emails.join('\n')}\n` : '');
  }));

  return router;
}
