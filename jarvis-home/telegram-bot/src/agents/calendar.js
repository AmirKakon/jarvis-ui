import { fetchHA, getStates } from './ha.js';
import { escapeHtml } from '../utils.js';
import { createCalendarEvent } from '../services/calendar-sync.js';
import { haikuModel, quickCallOptions } from '../models.js';
import { responseText } from './shared.js';
import { nowJerusalemISO, insertReminder } from './remind.js';
import { buildEvent, resolveDateRange } from './schedule-spec.js';

const TZ = 'Asia/Jerusalem';
const DEFAULT_EVENT_DURATION_MIN = 60;

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

const isWorkoutCalendar = (entity) => entity.includes('workout');

const eventTag = (entity) => {
  if (entity.includes('birthday')) return '🎂 ';
  if (entity.includes('holiday')) return '🇮🇱 ';
  return '';
};

/**
 * Fetch + enrich calendar events across the configured/auto-detected calendars
 * for an arbitrary [startISO, endISO) window. Returns { ok, events } where each
 * event is { entity, allDay, date, sortKey, time, summary }.
 */
async function fetchCalendarRange(startISO, endISO, states = null) {
  if (process.env.CALENDAR_ENABLED === 'false') return { ok: false, output: 'disabled' };

  const entities = await resolveCalendarEntities(states);
  if (!entities.length) return { ok: false, output: 'No calendars found.' };

  const qs = `?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`;

  const results = await Promise.all(
    entities.map(async (entity) => {
      const res = await fetchHA(`calendars/${entity}${qs}`);
      if (!res.ok || !Array.isArray(res.data)) return [];
      return res.data.map((ev) => ({ entity, ev }));
    })
  );

  const enriched = results.flat()
    .map(({ entity, ev }) => {
      const raw = eventStartRaw(ev);
      const allDay = isAllDay(ev);
      const d = raw ? new Date(allDay ? `${raw}T00:00:00` : raw) : null;
      return {
        entity,
        allDay,
        date: d && !isNaN(d.getTime()) ? d : null,
        sortKey: allDay ? 0 : (d?.getTime() || 0),
        time: allDay || !d || isNaN(d.getTime())
          ? null
          : d.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }),
        summary: ev.summary || ev.message || '(untitled)',
      };
    })
    .sort((a, b) => a.sortKey - b.sortKey);

  return { ok: true, events: enriched };
}

/**
 * Today's calendar events across the configured/auto-detected calendars.
 * Best-effort: returns { ok:false } if no calendars or the API is unreachable.
 * Accepts an optional pre-fetched states array (for entity auto-detection).
 */
export async function getTodayCalendar(states = null) {
  const { start, end } = todayRangeUTC();
  const res = await fetchCalendarRange(start, end, states);
  if (!res.ok) return res;

  // Planned workouts (e.g. Garmin "Scheduled workouts" calendar) get their own section.
  const fmt = (events) => {
    if (!events.length) return null;
    return events
      .slice()
      .sort((a, b) => (a.allDay === b.allDay ? a.sortKey - b.sortKey : a.allDay ? -1 : 1))
      .slice(0, 8)
      .map((e) => {
        const when = e.allDay ? 'all-day' : e.time;
        return `   • <b>${when}</b> ${eventTag(e.entity)}${escapeHtml(e.summary)}`;
      })
      .join('\n');
  };

  return {
    ok: true,
    text: fmt(res.events.filter((e) => !isWorkoutCalendar(e.entity))),
    workouts: fmt(res.events.filter((e) => isWorkoutCalendar(e.entity))),
  };
}

// ---------------------------------------------------------------------------
// Event creation (natural language → Google Calendar via n8n)
// ---------------------------------------------------------------------------

async function parseEventWithHaiku(userMessage) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const isoNow = nowJerusalemISO();

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: haikuModel(),
        ...quickCallOptions(haikuModel()),
        max_tokens: 448,
        system: `You parse calendar event / meeting requests into structured JSON.

CURRENT TIME: ${isoNow}

Return ONLY a JSON object:
{
  "summary": "concise event title (no date/time words)",
  "start": "ISO 8601 datetime — MUST use the SAME UTC offset as CURRENT TIME above",
  "duration_min": number (event length in minutes),
  "location": "place string or null",
  "description": "extra notes or null",
  "recurrence": null or pattern
}

CRITICAL: For relative times ("in 2 hours", "tomorrow at 3pm"), compute from CURRENT TIME and keep the same UTC offset. Example: if CURRENT TIME is 2026-03-31T09:39:00+03:00 and user says "tomorrow at 3pm", start = 2026-04-01T15:00:00+03:00.

DURATION: If the user gives an explicit length ("for an hour", "30 min") or an end time ("2-3pm", "from 10 to 11:30"), use it. Otherwise default duration_min to 60.

DEFAULT TIME: If a day/date is given but NO time (e.g. "on Friday", "tomorrow"), default start to 09:00 local time that day, keeping the same UTC offset.

Recurrence patterns (null for one-shot):
- "daily:HH:MM" — every day at HH:MM
- "weekly:D:HH:MM" — every week on day D (1=Mon..7=Sun) at HH:MM
- "monthly:DD:HH:MM" — every month on day DD at HH:MM
Use ONLY these exact patterns. For "every weekday" use weekly on the stated day, or omit if ambiguous.

Examples:
- "schedule a meeting with Dana tomorrow 3pm for an hour" → summary "Meeting with Dana", start tomorrow 15:00, duration_min 60
- "dentist appointment Friday 10am for 30 min at Clinic X" → summary "Dentist appointment", start Friday 10:00, duration_min 30, location "Clinic X"
- "lunch 1-2pm" → summary "Lunch", start today 13:00, duration_min 60
- "standup every Monday at 9" → summary "Standup", start next Monday 09:00, duration_min 60, recurrence "weekly:1:09:00"`,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[calendar] Haiku parse error ${res.status}: ${errBody.slice(0, 300)}`);
      return null;
    }

    const data = await res.json();
    const text = responseText(data);
    if (!text) return null;

    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
    console.log(`[calendar] Haiku parsed event: start=${parsed.start} dur=${parsed.duration_min} "${parsed.summary}"`);
    return parsed;
  } catch (err) {
    console.error('[calendar] Event parse failed:', err.message);
    return null;
  }
}

/**
 * Create a calendar event from the calendar tool's structured fields (summary,
 * date, time, duration_min / end_time, location, repeat …). See schedule-spec.js.
 */
export async function createEventFromSpec(chatId, spec) {
  const built = buildEvent(spec);
  if (!built.ok) return { ok: false, output: built.error };
  console.log(`[calendar] structured: start=${built.start.toISOString()} dur=${built.durationMin} recurrence=${built.recurrence} "${built.summary}"`);
  return scheduleEvent(chatId, built);
}

/**
 * Create a calendar event from free text (the /calendar command, or when the
 * router sent no structured timing): parsed by a separate Haiku call.
 */
export async function createEvent(chatId, userMessage) {
  const parsed = await parseEventWithHaiku(userMessage);
  if (!parsed || !parsed.summary || !parsed.start) {
    return { ok: false, output: 'Could not understand the event request.' };
  }

  const start = new Date(parsed.start);
  if (isNaN(start.getTime())) {
    return { ok: false, output: 'Could not parse the event time.' };
  }

  const TOLERANCE_MS = 2 * 60_000;
  if (start.getTime() < Date.now() - TOLERANCE_MS) {
    return { ok: false, output: 'That time is in the past, Sir.' };
  }

  return scheduleEvent(chatId, {
    summary: parsed.summary,
    start,
    durationMin: Number.isFinite(parsed.duration_min) && parsed.duration_min > 0 ? parsed.duration_min : DEFAULT_EVENT_DURATION_MIN,
    recurrence: parsed.recurrence || null,
    location: parsed.location || null,
    description: parsed.description || null,
  });
}

/**
 * Push an event to Google Calendar via n8n; on failure, fall back to a local
 * Telegram reminder at the start time so the event is never silently lost.
 */
async function scheduleEvent(chatId, { summary, start, durationMin, recurrence, location, description }) {
  const timeStr = start.toLocaleString('en-GB', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });
  const durLabel = durationMin >= 60 && durationMin % 60 === 0
    ? `${durationMin / 60}h`
    : `${durationMin}m`;
  const locLabel = location ? ` @ ${location}` : '';

  const cal = await createCalendarEvent({ summary, fireAt: start, recurrence, durationMin, location, description });

  if (cal.ok) {
    return {
      ok: true,
      output: `📅 Scheduled: "${summary}"${locLabel} — ${timeStr} (${durLabel})\nIt's on your Google Calendar — it'll notify you there.`,
    };
  }

  // GCal unavailable — fall back to a local Telegram reminder so it's not lost.
  const fb = await insertReminder(chatId, summary, start);
  if (fb.ok) {
    return {
      ok: true,
      output: `⚠️ Couldn't reach Google Calendar, so I set a Telegram reminder instead: "${summary}"${locLabel} — ${timeStr}`,
    };
  }

  return { ok: false, output: `Failed to schedule the event (${cal.error || 'unknown error'}).` };
}

// ---------------------------------------------------------------------------
// Schedule listing (natural-language date range → agenda)
// ---------------------------------------------------------------------------

/** Convert a Jerusalem-local Y-M-D (00:00) to a UTC ISO string. */
function localDateToUTC(year, month, day, tz = TZ) {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offsetMin = tzOffsetMinutes(new Date(guess), tz);
  return new Date(guess - offsetMin * 60000).toISOString();
}

/** Today's Jerusalem-local date parts. */
function todayParts(tz = TZ) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).map((x) => [x.type, x.value])
  );
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day) };
}

/**
 * Resolve a natural-language range ("today", "tomorrow", "this week", "friday")
 * to { startISO, endISO, label }. Uses Haiku when available; defaults to the
 * next 7 days. The window is [start 00:00, end 00:00) in Jerusalem local time.
 */
async function resolveRange(text) {
  const { year, month, day } = todayParts();
  const startDefault = localDateToUTC(year, month, day);
  const endDefault = new Date(new Date(startDefault).getTime() + 7 * 86400_000).toISOString();
  const fallback = { startISO: startDefault, endISO: endDefault, label: 'the next 7 days' };

  const q = (text || '').trim();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!q || !apiKey) return fallback;

  try {
    const isoNow = nowJerusalemISO();
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: haikuModel(),
        ...quickCallOptions(haikuModel()),
        max_tokens: 256,
        system: `You resolve a calendar date-range query to JSON. CURRENT TIME: ${isoNow}.
Return ONLY: {"start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD","label":"short human label"}
- end_date is EXCLUSIVE (the day after the last day you want to include).
- "today" → start=today, end=tomorrow. "tomorrow" → start=tomorrow, end=day after.
- "this week" → today through the coming Sunday (end = next Monday). "next week" → the following Mon..Sun.
- A weekday name ("friday") → the next occurrence of that day (start=that day, end=next day).
- If unclear, use today through today+7.`,
        messages: [{ role: 'user', content: q }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return fallback;
    const data = await res.json();
    const raw = responseText(data);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
    const s = String(parsed.start_date || '').split('-').map(Number);
    const e = String(parsed.end_date || '').split('-').map(Number);
    if (s.length !== 3 || e.length !== 3 || s.some(isNaN) || e.some(isNaN)) return fallback;
    return {
      startISO: localDateToUTC(s[0], s[1], s[2]),
      endISO: localDateToUTC(e[0], e[1], e[2]),
      label: parsed.label || 'the selected range',
    };
  } catch (err) {
    console.error('[calendar] range parse failed:', err.message);
    return fallback;
  }
}

/**
 * List calendar events for a natural-language range (the /calendar command, or
 * when the router sent no dates). Returns { ok, output }.
 * Reads Home Assistant calendar entities (same source as the briefing), so
 * JARVIS-created events appear only if HA is connected to that Google Calendar.
 */
export async function listEvents(text) {
  return listRange(await resolveRange(text));
}

/** List events for an inclusive local date range (YYYY-MM-DD) from the calendar tool. */
export async function listEventsBetween(startDate, endDate) {
  const range = resolveDateRange(startDate, endDate);
  if (!range.ok) return { ok: false, output: range.error };
  return listRange(range);
}

async function listRange({ startISO, endISO, label }) {
  const res = await fetchCalendarRange(startISO, endISO);
  if (!res.ok) {
    return { ok: false, output: res.output === 'disabled' ? 'Calendar listing is disabled.' : (res.output || 'No calendars found.') };
  }

  if (!res.events.length) {
    return { ok: true, output: `Nothing on your calendar for ${label}, Sir.` };
  }

  const events = res.events
    .slice()
    .sort((a, b) => {
      const da = a.date ? a.date.getTime() : 0;
      const db = b.date ? b.date.getTime() : 0;
      if (da !== db) return da - db;
      return (a.allDay ? 0 : 1) - (b.allDay ? 0 : 1);
    })
    .slice(0, 25);

  const dayKey = (d) => d
    ? new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
    : 'unknown';
  const dayHeading = (d) => d
    ? d.toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })
    : 'Undated';

  const lines = [`📅 <b>Schedule — ${escapeHtml(label)}</b>`];
  let lastKey = null;
  for (const e of events) {
    const key = dayKey(e.date);
    if (key !== lastKey) {
      lines.push('');
      lines.push(`<b>${escapeHtml(dayHeading(e.date))}</b>`);
      lastKey = key;
    }
    const when = e.allDay ? 'all-day' : (e.time || '');
    lines.push(`   • <b>${when}</b> ${eventTag(e.entity)}${escapeHtml(e.summary)}`);
  }

  return { ok: true, output: lines.join('\n') };
}
