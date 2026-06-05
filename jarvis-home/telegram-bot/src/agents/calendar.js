import { fetchHA, getStates } from './ha.js';
import { escapeHtml } from '../utils.js';

const TZ = 'Asia/Jerusalem';

// Calendars covered by other sections / not useful as event lists.
const DEFAULT_EXCLUDE = new Set(['calendar.hebcal_jerusalem']);

function tzOffsetMinutes(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUTC - date.getTime()) / 60000;
}

function todayRangeUTC() {
  const now = new Date();
  const offsetMin = tzOffsetMinutes(now, TZ);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now).map((x) => [x.type, x.value])
  );
  const startUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), 0, 0, 0) - offsetMin * 60000;
  return {
    start: new Date(startUTC).toISOString(),
    end: new Date(startUTC + 24 * 3600 * 1000).toISOString(),
  };
}

function eventStartRaw(ev) {
  const s = ev.start;
  if (!s) return null;
  if (typeof s === 'string') return s;
  return s.dateTime || s.date || null;
}

function isAllDay(ev) {
  const s = ev.start;
  if (s && typeof s === 'object') return !!s.date && !s.dateTime;
  return typeof s === 'string' && s.length === 10;
}

async function resolveCalendarEntities(states) {
  if (process.env.CALENDAR_ENTITIES) {
    return process.env.CALENDAR_ENTITIES.split(',').map((s) => s.trim()).filter(Boolean);
  }
  let data = states;
  if (!data) {
    const res = await getStates();
    if (!res.ok) return [];
    data = res.data;
  }
  return data
    .filter((s) => s.entity_id.startsWith('calendar.') && !DEFAULT_EXCLUDE.has(s.entity_id))
    .map((s) => s.entity_id);
}

/**
 * Today's calendar events across the configured/auto-detected calendars.
 * Best-effort: returns { ok:false } if no calendars or the API is unreachable.
 * Accepts an optional pre-fetched states array (for entity auto-detection).
 */
export async function getTodayCalendar(states = null) {
  if (process.env.CALENDAR_ENABLED === 'false') return { ok: false, output: 'disabled' };

  const entities = await resolveCalendarEntities(states);
  if (!entities.length) return { ok: false, output: 'No calendars found.' };

  const { start, end } = todayRangeUTC();
  const qs = `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;

  const results = await Promise.all(
    entities.map(async (entity) => {
      const res = await fetchHA(`calendars/${entity}${qs}`);
      if (!res.ok || !Array.isArray(res.data)) return [];
      return res.data.map((ev) => ({ entity, ev }));
    })
  );

  const events = results.flat();
  if (!events.length) return { ok: true, text: null }; // nothing scheduled today

  const enriched = events
    .map(({ entity, ev }) => {
      const raw = eventStartRaw(ev);
      const allDay = isAllDay(ev);
      const d = raw ? new Date(allDay ? `${raw}T00:00:00` : raw) : null;
      return {
        entity,
        allDay,
        sortKey: allDay ? 0 : (d?.getTime() || 0),
        time: allDay || !d || isNaN(d.getTime())
          ? null
          : d.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }),
        summary: ev.summary || ev.message || '(untitled)',
      };
    })
    .sort((a, b) => (a.allDay === b.allDay ? a.sortKey - b.sortKey : a.allDay ? -1 : 1))
    .slice(0, 8);

  const tag = (entity) => {
    if (entity.includes('birthday')) return '🎂 ';
    if (entity.includes('holiday')) return '🇮🇱 ';
    return '';
  };

  const lines = enriched.map((e) => {
    const when = e.allDay ? 'all-day' : e.time;
    return `   • <b>${when}</b> ${tag(e.entity)}${escapeHtml(e.summary)}`;
  });

  return { ok: true, text: lines.join('\n') };
}
