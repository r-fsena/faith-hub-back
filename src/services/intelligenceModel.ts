import { createHash } from 'crypto';

export const INTELLIGENCE_VERSION = '2026-11-06.v1';
export const INTELLIGENCE_FLAGS = ['intelligence.overview', 'intelligence.usage_collection'] as const;
export const USAGE_MODULE_FLAGS: Record<string, string | null> = {
  home: null, profile: null, welcome: null, auth: null,
  devotionals: 'devotionals.module_enabled', cells: 'cell_groups.module_enabled',
  bible: 'bible.module_enabled', prayers: 'prayers.module_enabled',
  events: 'events.module_enabled', store: 'pdv.module_enabled',
  giving: 'financial.online_pix_giving', volunteers: 'volunteers.module_enabled',
};
export const CONTENT_FLAGS: Record<string, string> = {
  EVENT: 'events.module_enabled', BROADCAST: 'broadcasts.module_enabled',
  DEVOTIONAL: 'devotionals.module_enabled', STUDY_BOOK: 'studies.module_enabled', STUDY_CHAPTER: 'studies.module_enabled',
};
const CONTENT_EVENTS:Record<string,string[]>={
  EVENT:['OPENED','CTA_CLICKED'],BROADCAST:['OPENED','STREAM_STARTED','STREAM_ENDED','NOTE_CREATED','CTA_CLICKED'],
  DEVOTIONAL:['OPENED','COMPLETED','CTA_CLICKED','NOTE_CREATED'],STUDY_BOOK:['OPENED','STARTED','COMPLETED'],STUDY_CHAPTER:['OPENED','COMPLETED'],
};
export const SAFE_ID = /^[a-zA-Z0-9_-]{1,100}$/;
export const safeIdentifier = (value: unknown): value is string => typeof value === 'string' && SAFE_ID.test(value);
export const subjectKey = (org: string, user: string) => createHash('sha256').update(`${org}:${user}:usage-v1`).digest('hex');
export const dayInSaoPaulo = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);
const dateString = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (day: string, amount: number) => dateString(new Date(Date.parse(`${day}T12:00:00Z`) + amount * 86400000));
export function utcBoundary(day: string) {
  const desired=Date.parse(`${day}T00:00:00.000Z`);
  let instant=desired;
  for(let attempt=0;attempt<3;attempt++){
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant)).map(part=>[part.type,part.value]));
    const local=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second));
    const correction=desired-local;if(!correction)break;instant+=correction;
  }
  return new Date(instant).toISOString();
}

export function intelligencePeriod(preset: string = 'month', now = new Date()) {
  const today = dayInSaoPaulo(now);
  const end = today; // exclusive: only complete local days
  const [year, month, day] = today.split('-').map(Number);
  let start: string, previousStart: string, previousEnd: string;
  if (preset === 'last_month' || (preset === 'month' && day === 1)) {
    const currentStart = `${today.slice(0, 7)}-01`;
    start = dateString(new Date(Date.UTC(year, month - 2, 1)));
    previousStart = dateString(new Date(Date.UTC(year, month - 3, 1)));
    previousEnd = start;
    return { preset: 'last_month', start, end: currentStart, previousStart, previousEnd, comparison: 'MoM · meses encerrados', timezone: 'America/Sao_Paulo' };
  }
  if (preset === 'month') {
    const previousMonthStart = dateString(new Date(Date.UTC(year, month - 2, 1)));
    const previousMonthDays = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
    const days = Math.min(day - 1, previousMonthDays);
    start = `${today.slice(0, 7)}-01`;
    previousStart = previousMonthStart;
    previousEnd = addDays(previousStart, days);
    // A month longer than its predecessor is truncated to a common number of full days.
    return { preset, start, end: addDays(start, days), previousStart, previousEnd, comparison: 'MTD · mesmos dias completos', timezone: 'America/Sao_Paulo' };
  }
  if (!['7d', '30d'].includes(preset)) throw Error('Período inválido.');
  const days = preset === '7d' ? 7 : 30;
  start = addDays(today, -days);
  previousStart = addDays(start, -days);
  previousEnd = start;
  return { preset, start, end, previousStart, previousEnd, comparison: 'Períodos de igual duração', timezone: 'America/Sao_Paulo' };
}
export function variation(current: number | null, previous: number | null) {
  if (current === null || previous === null) return { delta: null, percent: null, reason: 'no_comparable_baseline' };
  return { delta: current - previous, percent: previous > 0 ? (current - previous) / previous * 100 : null,
    reason: previous > 0 ? null : current > 0 ? 'new_occurrence' : 'zero_baseline' };
}
export function adultEligibility(birth: unknown, now = new Date()) {
  if (!birth) return false;
  if(typeof birth !== 'string' && !Number.isFinite(new Date(birth as any).getTime())) return false;
  const day = typeof birth === 'string' ? birth.slice(0, 10) : dateString(new Date(birth as any));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) return false;
  const [y, m, d] = day.split('-').map(Number);
  if (dateString(new Date(Date.UTC(y, m - 1, d))) !== day) return false;
  const today = dayInSaoPaulo(now);
  const cutoff = `${Number(today.slice(0, 4)) - 18}${today.slice(4)}`;
  return day <= cutoff && y >= 1900;
}
export interface UsageEvent {
  id: string; name: 'screen_view' | 'content_interaction'; module: string;
  occurred_at: string; session_id: string; version: 'v1' | 'v2';
  content_type?: string; content_id?: string; event_type?: string;
  duration_seconds?: number; progress_percent?: number;
}
export function validateUsageBatch(value: unknown, flags: Record<string, boolean>, now = Date.now()): UsageEvent[] {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw Error('Envie entre 1 e 20 interações.');
  return value.map((input: any) => {
    if (!input || typeof input !== 'object' || !safeIdentifier(input.id) || !safeIdentifier(input.session_id) ||
      !['v1', 'v2'].includes(input.version) || !Object.hasOwn(USAGE_MODULE_FLAGS, input.module) ||
      !['screen_view', 'content_interaction'].includes(input.name)) throw Error('Interação inválida.');
    const timestamp = Date.parse(input.occurred_at);
    if (!Number.isFinite(timestamp) || timestamp > now + 300000 || timestamp < now - 86400000) throw Error('Interação fora da janela de 24 horas.');
    const flag = USAGE_MODULE_FLAGS[input.module];
    if (flag && !flags[flag]) throw Error('Módulo não disponível.');
    const event: UsageEvent = { id: input.id, session_id: input.session_id, name: input.name,
      module: input.module, version: input.version, occurred_at: new Date(timestamp).toISOString() };
    if (input.name === 'content_interaction') {
      if (!Object.hasOwn(CONTENT_FLAGS, input.content_type) || !flags[CONTENT_FLAGS[input.content_type]] ||
        !flags['content.analytics_dashboard'] || !safeIdentifier(input.content_id) ||
        !CONTENT_EVENTS[input.content_type]?.includes(input.event_type)) throw Error('Conteúdo inválido ou não contratado.');
      const expectedModule = input.content_type === 'EVENT' ? 'events' : input.content_type === 'DEVOTIONAL' ? 'devotionals' : input.content_type === 'BROADCAST' ? 'home' : 'cells';
      if(input.module!==expectedModule)throw Error('Módulo inválido para a interação.');
      Object.assign(event, { content_type: input.content_type, content_id: input.content_id, event_type: input.event_type });
      for (const key of ['duration_seconds', 'progress_percent'] as const) {
        if (input[key] !== undefined) {
          const n = Number(input[key]);
          if (!Number.isFinite(n) || n < 0 || n > (key === 'progress_percent' ? 100 : 86400)) throw Error('Medida inválida.');
          event[key] = n;
        }
      }
    }
    return event; // No free text, email, prayer, note body, address, URL or arbitrary properties.
  });
}
