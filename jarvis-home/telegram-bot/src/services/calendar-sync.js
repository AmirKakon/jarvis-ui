const TZ = 'Asia/Jerusalem';
const DEFAULT_DURATION_MIN = 30;
const WEBHOOK_PATH = 'jarvis-create-calendar-event';

const DAY_TO_RRULE = { 1: 'MO', 2: 'TU', 3: 'WE', 4: 'TH', 5: 'FR', 6: 'SA', 7: 'SU' };

/**
 * Map our internal recurrence patterns to an iCal RRULE string.
 * Only calendar-grade patterns (daily/weekly/monthly) translate; interval/hourly
 * are short-cycle "timer" recurrences that don't belong on a calendar.
 * Returns null when there is no calendar-appropriate rule.
 */
export function recurrenceToRRule(recurrence) {
  if (!recurrence) return null;
  const [type, ...parts] = recurrence.split(':');

  if (type === 'daily') return 'RRULE:FREQ=DAILY';

  if (type === 'weekly') {
    const day = DAY_TO_RRULE[parseInt(parts[0], 10)];
    return day ? `RRULE:FREQ=WEEKLY;BYDAY=${day}` : 'RRULE:FREQ=WEEKLY';
  }

  if (type === 'monthly') {
    const dom = parseInt(parts[0], 10);
    return Number.isFinite(dom) ? `RRULE:FREQ=MONTHLY;BYMONTHDAY=${dom}` : 'RRULE:FREQ=MONTHLY';
  }

  return null;
}

function resolveWebhookBase() {
  if (process.env.N8N_WEBHOOK_URL) return process.env.N8N_WEBHOOK_URL.replace(/\/+$/, '');
  if (process.env.N8N_URL) return `${process.env.N8N_URL.replace(/\/+$/, '')}/webhook`;
  return null;
}

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  // Optional shared-secret header for the n8n "Header Auth" credential on the webhook.
  const secret = process.env.N8N_WEBHOOK_SECRET;
  if (secret) headers['x-jarvis-secret'] = secret;
  return headers;
}

/**
 * Best-effort: push a scheduled reminder to Google Calendar via the n8n webhook.
 * Never throws — returns { ok, eventId, error } so the caller can degrade gracefully
 * (the local reminder still fires regardless).
 */
export async function createCalendarEvent({ summary, fireAt, recurrence = null, durationMin = DEFAULT_DURATION_MIN, location = null, description = null }) {
  if (process.env.CALENDAR_SYNC_ENABLED === 'false') {
    return { ok: false, error: 'disabled' };
  }

  const base = resolveWebhookBase();
  if (!base) return { ok: false, error: 'n8n webhook not configured' };

  const start = fireAt instanceof Date ? fireAt : new Date(fireAt);
  if (isNaN(start.getTime())) return { ok: false, error: 'invalid start time' };
  const end = new Date(start.getTime() + durationMin * 60_000);

  // Fold location into the description too, so it survives even if the n8n
  // workflow hasn't been re-imported to forward the native `location` field.
  let desc = description || 'Created by JARVIS';
  if (location) desc += `\nLocation: ${location}`;

  const payload = {
    summary,
    description: desc,
    start: start.toISOString(),
    end: end.toISOString(),
    timezone: TZ,
    rrule: recurrenceToRRule(recurrence),
    location: location || undefined,
    // Which calendar to write to. With a service account, the SA's own "primary"
    // is not your calendar, so we must pass your calendar id explicitly (the calendar
    // you shared with the service account — usually your Gmail address).
    calendarId: process.env.GCAL_CALENDAR_ID || 'primary',
  };

  try {
    const res = await fetch(`${base}/${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[calendar-sync] webhook ${res.status}: ${body.slice(0, 200)}`);
      return { ok: false, error: `HTTP ${res.status}` };
    }

    const data = await res.json().catch(() => ({}));
    const eventId = extractEventId(data);
    console.log(`[calendar-sync] created GCal event id=${eventId || '(unknown)'} for "${summary}"`);
    return { ok: true, eventId };
  } catch (err) {
    console.error('[calendar-sync] create failed:', err.message);
    return { ok: false, error: err.message };
  }
}

function extractEventId(data) {
  if (!data) return null;
  if (Array.isArray(data)) return extractEventId(data[0]);
  return data.eventId || data.id || data.json?.id || null;
}

// Re-exported for potential reuse / testing.
export const _internal = { resolveWebhookBase, extractEventId, WEBHOOK_PATH };
