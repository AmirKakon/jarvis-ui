// Turns the remind tool's structured fields into a fire time and a recurrence
// pattern. All date maths and time zones live here, not in a model prompt.
//
// Recurrence patterns stored in reminders.recurrence:
//   interval:N:min | interval:N:hour | hourly:MM | daily:HH:MM
//   weekly:D:HH:MM (1=Mon..7=Sun) | monthly:DD:HH:MM

import { jerusalemParts, jerusalemTime, daysInMonth } from '../time.js';

const DEFAULT_TIME = '08:00';
const PAST_TOLERANCE_MS = 2 * 60_000;
const MINUTE = 60_000;

const pad = (n) => String(n).padStart(2, '0');

function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? DEFAULT_TIME).trim());
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
 * Build { ok, message, fireAt, recurrence } from the remind tool's fields, or
 * { ok: false, error } when they don't describe a valid future reminder.
 */
export function buildReminder(spec, now = new Date()) {
  const message = String(spec?.message || '').trim();
  if (!message) return { ok: false, error: 'What should I remind you about, Sir?' };

  const repeat = spec.repeat && spec.repeat !== 'none' ? spec.repeat : null;
  const inMinutes = spec.in_minutes != null ? positiveInt(spec.in_minutes) : null;
  if (spec.in_minutes != null && !inMinutes) return { ok: false, error: 'That time is in the past, Sir.' };

  const time = parseTime(spec.time);
  if (!time) return { ok: false, error: `I couldn't read the time "${spec.time}".` };
  const date = spec.date ? parseDate(spec.date) : null;
  if (spec.date && !date) return { ok: false, error: `I couldn't read the date "${spec.date}".` };
  const atDate = date && jerusalemTime(date.year, date.month, date.day, time.hour, time.minute);

  let fireAt;
  let recurrence = null;

  switch (repeat) {
    case null:
      if (inMinutes) fireAt = new Date(now.getTime() + inMinutes * MINUTE);
      else if (date) fireAt = atDate;
      else if (spec.time) fireAt = nextLocal(now, time);
      else return { ok: false, error: 'When should I remind you, Sir?' };
      break;

    case 'minutes':
    case 'hours': {
      const every = positiveInt(spec.every);
      if (!every) return { ok: false, error: `How many ${repeat} between reminders, Sir?` };
      const unitMs = repeat === 'hours' ? 60 * MINUTE : MINUTE;
      recurrence = `interval:${every}:${repeat === 'hours' ? 'hour' : 'min'}`;
      fireAt = inMinutes ? new Date(now.getTime() + inMinutes * MINUTE)
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
      fireAt = next;
      break;
    }

    case 'daily':
      recurrence = `daily:${pad(time.hour)}:${pad(time.minute)}`;
      fireAt = atDate && atDate > now ? atDate : nextLocal(now, time);
      break;

    case 'weekly': {
      const weekday = spec.weekday != null ? Number(spec.weekday) : atDate && jerusalemParts(atDate).weekday;
      if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return { ok: false, error: 'Which day of the week, Sir?' };
      recurrence = `weekly:${weekday}:${pad(time.hour)}:${pad(time.minute)}`;
      fireAt = atDate && atDate > now && jerusalemParts(atDate).weekday === weekday
        ? atDate
        : nextLocal(now, time, (p) => p.weekday === weekday);
      break;
    }

    case 'monthly': {
      const dom = spec.day_of_month != null ? Number(spec.day_of_month) : date?.day;
      if (!Number.isInteger(dom) || dom < 1 || dom > 31) return { ok: false, error: 'Which day of the month, Sir?' };
      recurrence = `monthly:${pad(dom)}:${pad(time.hour)}:${pad(time.minute)}`;
      fireAt = nextLocal(now, time, (p) => p.day === dom);
      break;
    }

    default:
      return { ok: false, error: `I don't know how to repeat "${repeat}".` };
  }

  if (!fireAt || fireAt.getTime() < now.getTime() - PAST_TOLERANCE_MS) {
    return { ok: false, error: 'That time is in the past, Sir.' };
  }
  return { ok: true, message, fireAt, recurrence };
}
