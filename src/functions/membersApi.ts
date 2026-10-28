import * as members from './members';
import { createDomainApiHandler, DomainRouteMap } from './domainApiRouter';

export const membersApiRoutes: DomainRouteMap = {
  'POST /MEMBERS/INVITE': members.invite,
  'PUT /MEMBERS/STATUS': members.updateStatus,
  'POST /MEMBERS/RESET-PASSWORD': members.resetPassword,
  'GET /MEMBERS': members.list,
  'GET /MEMBERS/{ID}': members.get,
  'PUT /MEMBERS/{ID}': members.update,
  'POST /MEMBERS/{ID}/REQUEST-CELL': members.requestCell,
  'POST /MEMBERS/SELF-REGISTER': members.selfRegister,
  'POST /MEMBERS/BATCH-IMPORT': members.batchImport
};

export const membersApiHandler = createDomainApiHandler(membersApiRoutes);
