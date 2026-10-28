'use strict';

const DOMAIN_GROUPS = Object.freeze({
  membersApi: {
    handler: 'src/functions/membersApi.membersApiHandler',
    sources: [
      'inviteMember', 'updateMemberStatus', 'resetPassword', 'listMembers', 'getMember',
      'updateMember', 'requestCell', 'selfRegisterMember', 'batchImportMembers'
    ]
  },
  pdvInventory: {
    handler: 'src/functions/pdvApi.pdvApiHandler',
    sources: [
      'getPdvProducts', 'createPdvProduct', 'deletePdvProduct', 'createPdvOrder',
      'getPdvOrders', 'updatePdvOrderStatus', 'pdvInventory'
    ]
  },
  contentApi: {
    handler: 'src/functions/contentApi.contentApiHandler',
    sources: [
      'createOrUpdateBroadcast', 'getBroadcasts', 'getActiveBroadcast', 'deleteBroadcast',
      'getStudies', 'createOrUpdateStudy', 'deleteStudy', 'getStudyBooks', 'getStudyBookById',
      'createOrUpdateStudyBook', 'deleteStudyBook', 'saveStudyChapter', 'deleteStudyChapter',
      'toggleChapterCompletion', 'getPosts', 'createPost', 'deletePost', 'reactPost',
      'getUploadUrl', 'getPartilhas', 'createPartilha', 'togglePartilha', 'deletePartilha',
      'getDevotionals', 'getTodayDevotional', 'createOrUpdateDevotional', 'deleteDevotional',
      'saveUserNote', 'getPrayers', 'createPrayer', 'prayForRequest', 'deletePrayer',
      'respondPrayerPastoral', 'submitTestimony', 'updatePrayerStatus'
    ]
  },
  communityApi: {
    handler: 'src/functions/communityApi.communityApiHandler',
    sources: [
      'getGroups', 'createOrUpdateGroup', 'getGroup', 'deleteGroup', 'evaluateRequest',
      'evaluateJoinRequest', 'addCellMember', 'removeCellMember', 'recordMeeting',
      'getCellMeetings', 'getCellMeetingDetails', 'getEvents', 'getEventById',
      'createOrUpdateEvent', 'deleteEvent', 'checkoutTicket', 'myTickets', 'scanTicket',
      'getTicketPass', 'getTicketCalendar'
    ]
  },
  tenantApi: {
    handler: 'src/functions/tenantApi.tenantApiHandler',
    sources: [
      'getChurchSettings', 'updateChurchSettings', 'getPagarmeSettings', 'updatePagarmeSettings',
      'listOrganizations', 'getOrganization', 'createOrUpdateOrganization', 'listCampuses',
      'getCampus', 'createOrUpdateCampus', 'deleteCampus', 'getFeatureFlags',
      'toggleFeatureFlag', 'batchUpdateFeatureFlags', 'resetTenantFlags', 'listAuditLogs'
    ]
  },
  saasApi: {
    handler: 'src/functions/saasApi.saasApiHandler',
    sources: [
      'createProposal', 'listProposals', 'getPublicProposal', 'acceptProposal',
      'listSaasSubscriptions', 'handleAsaasWebhook', 'listSaasPlans',
      'createOrUpdateSaasPlan', 'deleteSaasPlan'
    ]
  }
});

class ServerlessDomainConsolidation {
  constructor(serverless) {
    this.serverless = serverless;
    this.hooks = {
      'before:package:initialize': () => {
        if (process.env.FAITH_HUB_PRESERVE_LEGACY_STACK !== '1') this.consolidate();
      },
      'before:aws:package:finalize:mergeCustomProviderResources': () => this.retainLogGroups()
    };
  }

  retainLogGroups() {
    const template = this.serverless.service.provider.compiledCloudFormationTemplate;
    for (const resource of Object.values(template.Resources || {})) {
      if (resource.Type === 'AWS::Logs::LogGroup') {
        resource.DeletionPolicy = 'Retain';
        resource.UpdateReplacePolicy = 'Retain';
      }
    }
  }

  consolidate() {
    const functions = this.serverless.service.functions;
    const assigned = new Set();

    for (const [targetName, group] of Object.entries(DOMAIN_GROUPS)) {
      const missing = group.sources.filter((name) => !functions[name]);
      if (missing.length) {
        throw new Error(`Domain consolidation ${targetName} is missing functions: ${missing.join(', ')}`);
      }

      for (const sourceName of group.sources) {
        if (assigned.has(sourceName)) {
          throw new Error(`Function ${sourceName} belongs to more than one domain stack`);
        }
        assigned.add(sourceName);
      }

      const existingTarget = functions[targetName];
      const baseFunction = existingTarget || functions[group.sources[0]];
      const events = group.sources.flatMap((sourceName) => functions[sourceName].events || []);
      for (const sourceName of group.sources) delete functions[sourceName];

      functions[targetName] = {
        ...baseFunction,
        name: existingTarget?.name || `${this.serverless.service.service}-${this.serverless.service.provider.stage}-${targetName}`,
        handler: group.handler,
        events
      };
    }
  }
}

ServerlessDomainConsolidation.domainGroups = DOMAIN_GROUPS;
module.exports = ServerlessDomainConsolidation;
