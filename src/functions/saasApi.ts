import * as proposals from './proposals';
import * as asaas from './asaasWebhook';
import * as plans from './saasPlans';
import { createDomainApiHandler, DomainRouteMap } from './domainApiRouter';

export const saasApiRoutes: DomainRouteMap = {
  'POST /PROPOSALS': proposals.createProposal,
  'GET /PROPOSALS': proposals.listProposals,
  'GET /PROPOSALS/PUBLIC/{TOKEN}': proposals.getPublicProposal,
  'POST /PROPOSALS/PUBLIC/{TOKEN}/ACCEPT': proposals.acceptProposal,
  'GET /SAAS-SUBSCRIPTIONS': proposals.listSubscriptions,
  'POST /WEBHOOKS/ASAAS': asaas.handleAsaasWebhook,
  'GET /SAAS-PLANS': plans.listPlans,
  'POST /SAAS-PLANS': plans.createOrUpdatePlan,
  'DELETE /SAAS-PLANS/{ID}': plans.deletePlan
};

export const saasApiHandler = createDomainApiHandler(saasApiRoutes);
