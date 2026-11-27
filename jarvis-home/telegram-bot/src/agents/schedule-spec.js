// Turns the structured timing fields of the remind and calendar tools into
// concrete instants and recurrence patterns. All date maths and time zones live
// here, not in a model prompt.
//
// Recurrence patterns (reminders.recurrence, calendar-sync RRULE input):
//   interval:N:min | interval:N:hour | hourly:MM | daily:HH:MM
//   weekly:D:HH:MM (1=Mon..7=Sun) | monthly:DD:HH:MM

import { jerusalemParts, jerusalemTime, daysInMonth } from '../time.js';

const PAST_TOLERANCE_MS = 2 * 60_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_RANGE_DAYS = 92;

const ALL_REPEATS = ['minutes', 'hours', 'hourly', 'daily', 'weekly', 'monthly'];
const CALENDAR_REPEATS = ['daily', 'weekly', 'monthly'];

const pad = (n) => String(n).padStart(2, '0');

function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

function parseDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month) ? { year, month, day } : null;
}

const positiveInt = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** First Jerusalem-local day (from today) whose time is still ahead and that passes `accept`. */
function nextLocal(now, { hour, minute }, accept = () => true, maxDays = 400) {
  const today = jerusalemParts(now);
  for (let i = 0; i <= maxDays; i++) {
    const at = jerusalemTime(today.year, today.month, today.day + i, hour, minute);
    if (at > now && accept(jerusalemParts(at))) return at;
  }
  return null;
}

/** True when the spec carries timing the structured path can use. */
export function hasTiming(spec) {
  return !!spec && ((spec.repeat && spec.repeat !== 'none') || spec.in_minutes != null || !!spec.date || !!spec.time);
}

/**
 * Resolve timing fields (in_minutes, date, time, repeat, every, minute,
 * weekday, day_of_month) to { ok, at, recurrence } or { ok: false, error }.
 */
export function resolveSchedule(spec, now = new Date(), { defaultTime = '08:00', repeats = ALL_REPEATS } = {}) {
  const repeat = spec.repeat && spec.repeat !== 'none' ? spec.repeat : null;
  if (repeat && !repeats.includes(repeat)) {
    return { ok: false, error: `I can only repeat that ${repeats.join(', ').replace(/, ([^,]*)$/, ' or $1')}, Sir.` };
  }
  const inMinutes = spec.in_minutes != null ? positiveInt(spec.in_minutes) : null;
  if (spec.in_minutes != null && !inMinutes) return { ok: false, error: 'That time is in the past, Sir.' };

  const time = parseTime(spec.time ?? defaultTime);
  if (!time) return { ok: false, error: `I couldn't read the time "${spec.time}".` };
  const date = spec.date ? parseDate(spec.date) : null;
  if (spec.date && !date) return { ok: false, error: `I couldn't read the date "${spec.date}".` };
  const atDate = date && jerusalemTime(date.year, date.month, date.day, time.hour, time.minute);

  let at;
  let recurrence = null;

  switch (repeat) {
    case null:
      if (inMinutes) at = new Date(now.getTime() + inMinutes * MINUTE);
      else if (date) at = atDate;
      else if (spec.time) at = nextLocal(now, time);
      else return { ok: false, error: 'When should that be, Sir?' };
      break;

    case 'minutes':
    case 'hours': {
      const every = positiveInt(spec.every);
      if (!every) return { ok: false, error: `How many ${repeat} between reminders, Sir?` };
      const unitMs = repeat === 'hours' ? 60 * MINUTE : MINUTE;
      recurrence = `interval:${every}:${repeat === 'hours' ? 'hour' : 'min'}`;
      at = inMinutes ? new Date(now.getTime() + inMinutes * MINUTE)
        : atDate || new Date(now.getTime() + every * unitMs);
      break;
    }

    case 'hourly': {
      const minute = Number(spec.minute ?? 0);
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) return { ok: false, error: 'Which minute past the hour, Sir?' };
      recurrence = `hourly:${pad(minute)}`;
      const next = new Date(now.getTime() + MINUTE);
      next.setUTCSeconds(0, 0);
      while (jerusalemParts(next).minute !== minute) next.setTime(next.getTime() + MINUTE);
      at = next;
      break;
    }

    case 'daily':
      recurrence = `daily:${pad(time.hour)}:${pad(time.minute)}`;
      at = atDate && atDate > now ? atDate : nextLocal(now, time);
      break;

    case 'weekly': {
      const weekday = spec.weekday != null ? Number(spec.weekday) : atDate && jerusalemParts(atDate).weekday;
      if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return { ok: false, error: 'Which day of the week, Sir?' };
      recurrence = `weekly:${weekday}:${pad(time.hour)}:${pad(time.minute)}`;
      at = atDate && atDate > now && jerusalemParts(atDate).weekday === weekday
        ? atDate
        : nextLocal(now, time, (p) => p.weekday === weekday);
      break;
    }

    case 'monthly': {
      const dom = spec.day_of_month != null ? Number(spec.day_of_month) : date?.day;
      if (!Number.isInteger(dom) || dom < 1 || dom > 31) return { ok: false, error: 'Which day of the month, Sir?' };
      recurrence = `monthly:${pad(dom)}:${pad(time.hour)}:${pad(time.minute)}`;
      at = nextLocal(now, time, (p) => p.day === dom);
      break;
    }

    default:
      return { ok: false, error: `I don't know how to repeat "${repeat}".` };
  }

  if (!at || at.getTime() < now.getTime() - PAST_TOLERANCE_MS) {
    return { ok: false, error: 'That time is in the past, Sir.' };
  }
  return { ok: true, at, recurrence };
}

/** Reminder from the remind tool: { ok, message, fireAt, recurrence } or { ok: false, error }. */
export function buildReminder(spec, now = new Date()) {
  const message = String(spec?.message || '').trim();
  if (!message) return { ok: false, error: 'What should I remind you about, Sir?' };
  const s = resolveSchedule(spec, now);
  return s.ok ? { ok: true, message, fireAt: s.at, recurrence: s.recurrence } : s;
}

/**
 * Calendar event from the calendar tool (summary, date, time, duration_min or
 * end_time, location, description, repeat daily/weekly/monthly):
 * { ok, summary, start, durationMin, recurrence, location, description } or { ok: false, error }.
 * A day without a time starts at 09:00; the default length is 60 minutes.
 */
export function buildEvent(spec, now = new Date()) {
  const summary = String(spec?.summary || '').trim();
  if (!summary) return { ok: false, error: 'What should I call the event, Sir?' };
  const s = resolveSchedule(spec, now, { defaultTime: '09:00', repeats: CALENDAR_REPEATS });
  if (!s.ok) return s;

  let durationMin = positiveInt(spec.duration_min) || 60;
  if (spec.end_time && !spec.duration_min) {
    const end = parseTime(spec.end_time);
    if (!end) return { ok: false, error: `I couldn't read the end time "${spec.end_time}".` };
    const start = jerusalemParts(s.at);
    let mins = (end.hour * 60 + end.minute) - (start.hour * 60 + start.minute);
    if (mins <= 0) mins += 24 * 60;
    durationMin = mins;
  }

  return {
    ok: true,
    summary,
    start: s.at,
    durationMin,
    recurrence: s.recurrence,
    location: String(spec.location || '').trim() || null,
    description: String(spec.description || '').trim() || null,
  };
}

const dayLabel = (d) => d.toLocaleDateString('en-GB', { timeZone: 'Asia/Jerusalem', weekday: 'short', day: 'numeric', month: 'short' });

/**
 * Inclusive local date range (start_date, end_date as YYYY-MM-DD) →
 * { ok, startISO, endISO (exclusive, next midnight), label } or { ok: false, error }.
 */
export function resolveDateRange(startDate, endDate = startDate) {
  const s = parseDate(startDate);
  const e = parseDate(endDate || startDate);
  if (!s || !e) return { ok: false, error: `I couldn't read the dates "${startDate}" – "${endDate}".` };
  const start = jerusalemTime(s.year, s.month, s.day);
  const end = jerusalemTime(e.year, e.month, e.day + 1);
  if (end <= start) return { ok: false, error: 'The end date is before the start date, Sir.' };
  if (end - start > MAX_RANGE_DAYS * DAY) return { ok: false, error: `That range is too long; ask for ${MAX_RANGE_DAYS} days or fewer, Sir.` };
  const lastDay = jerusalemTime(e.year, e.month, e.day, 12);
  const label = startDate === (endDate || startDate) ? dayLabel(start) : `${dayLabel(start)} – ${dayLabel(lastDay)}`;
  return { ok: true, startISO: start.toISOString(), endISO: end.toISOString(), label };
}
