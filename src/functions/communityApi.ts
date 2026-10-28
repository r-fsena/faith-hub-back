import * as cells from './cellGroups';
import * as events from './events';
import * as tickets from './tickets';
import { createDomainApiHandler, DomainRouteMap } from './domainApiRouter';

export const communityApiRoutes: DomainRouteMap = {
  'GET /CELL-GROUPS': cells.getGroups,
  'POST /CELL-GROUPS': cells.createOrUpdateGroup,
  'GET /CELL-GROUPS/{ID}': cells.getGroup,
  'DELETE /CELL-GROUPS/{ID}': cells.deleteGroup,
  'POST /CELL-GROUPS/{ID}/EVALUATE-REQUEST': cells.evaluateRequest,
  'POST /CELL-GROUPS/{ID}/JOIN-REQUESTS/{USERID}': cells.evaluateJoinRequest,
  'POST /CELL-GROUPS/{ID}/MEMBERS': cells.addMember,
  'DELETE /CELL-GROUPS/{ID}/MEMBERS/{MEMBERID}': cells.removeMember,
  'POST /CELL-GROUPS/{ID}/MEETINGS': cells.recordMeeting,
  'GET /CELL-GROUPS/{ID}/MEETINGS': cells.getCellMeetings,
  'GET /CELL-GROUPS/{ID}/MEETINGS/{MEETINGID}': cells.getCellMeetingDetails,
  'GET /EVENTS': events.getEvents,
  'GET /EVENTS/{ID}': events.getEventById,
  'POST /EVENTS': events.createOrUpdateEvent,
  'DELETE /EVENTS/{ID}': events.deleteEvent,
  'POST /TICKETS/CHECKOUT': tickets.checkout,
  'GET /TICKETS/ME': tickets.myTickets,
  'POST /TICKETS/SCAN': tickets.scanTicket,
  'GET /TICKETS/{ID}/PASS': tickets.getTicketPass,
  'GET /TICKETS/{ID}/CALENDAR.ICS': tickets.getTicketCalendar
};

export const communityApiHandler = createDomainApiHandler(communityApiRoutes);
