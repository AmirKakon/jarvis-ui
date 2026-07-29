import pg from 'pg';
import { createCalendarEvent } from '../services/calendar-sync.js';
import { haikuModel } from '../models.js';
const { Pool } = pg;

const TZ = 'Asia/Jerusalem';

// One-shot reminders firing further out than this (and all dated recurring ones)
// are treated as calendar-worthy "scheduled" reminders rather than ephemeral timers.
const SCHEDULED_HORIZON_MS = 4 * 3600_000;

let pool = null;

function getPool() {
  if (!pool) {
    const connStr = process.env.DATABASE_URL;
    if (!connStr) return null;
    pool = new Pool({ connectionString: connStr, max: 2 });
    pool.on('error', (err) => console.error('[remind] PG pool error:', err.message));
  }
  return pool;
}

async function query(sql, params = []) {
  const p = getPool();
  if (!p) return { rows: [], rowCount: 0 };
  return p.query(sql, params);
}

let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id          SERIAL PRIMARY KEY,
      chat_id     TEXT NOT NULL,
      message     TEXT NOT NULL,
      fire_at     TIMESTAMPTZ NOT NULL,
      recurrence  TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      fired       BOOLEAN DEFAULT FALSE
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_reminders_pending
    ON reminders (fire_at) WHERE fired = FALSE
  `);
  // Calendar-sync columns (added idempotently for pre-existing tables):
  //   kind              — 'timer' (ephemeral) or 'scheduled' (calendar-worthy)
  //   calendar_event_id — Google Calendar event id when mirrored, else NULL
  await query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS kind TEXT`);
  await query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS calendar_event_id TEXT`);
  tableReady = true;
}

/**
 * Classify a reminder as an ephemeral "timer" or a calendar-worthy "scheduled" item.
 * - Recurring daily/weekly/monthly → scheduled (these are the "every Sunday 8am" kind).
 * - interval/hourly recurrence → timer (short-cycle, calendar clutter).
 * - One-shot → scheduled only if it fires beyond the near-term horizon.
 */
function classifyKind(fireAt, recurrence) {
  if (recurrence) {
    const type = recurrence.split(':')[0];
    return (type === 'daily' || type === 'weekly' || type === 'monthly') ? 'scheduled' : 'timer';
  }
  return (fireAt.getTime() - Date.now() > SCHEDULED_HORIZON_MS) ? 'scheduled' : 'timer';
}

export function nowJerusalemISO() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  const rawOffsetMs = new Date(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`).getTime() - now.getTime();
  const offsetMin = Math.round(rawOffsetMs / 60_000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const offH = String(Math.floor(absMin / 60)).padStart(2, '0');
  const offM = String(absMin % 60).padStart(2, '0');

  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${sign}${offH}:${offM}`;
}

async function parseWithHaiku(userMessage) {
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
        max_tokens: 256,
        system: `You parse reminder requests into structured JSON.

CURRENT TIME: ${isoNow}

Return ONLY a JSON object:
{
  "message": "what to remind about",
  "fire_at": "ISO 8601 datetime — MUST use the SAME UTC offset as CURRENT TIME above",
  "recurrence": null or pattern
}

CRITICAL: For relative times ("in 30 minutes", "in 2 hours"), add the duration to CURRENT TIME directly. Keep the same UTC offset. Example: if CURRENT TIME is 2026-03-31T09:39:00+03:00 and user says "in 2 minutes", fire_at = 2026-03-31T09:41:00+03:00.

DEFAULT TIME: If the user gives a day or date but NO time of day (e.g. "tomorrow", "on Tuesday", "every Sunday", "on the 15th"), default the time to 08:00 Jerusalem local time on that date. Do NOT use the current time-of-day. Keep the same UTC offset as CURRENT TIME. For recurring patterns with no stated time, use 08:00 as the HH:MM (e.g. "weekly:2:08:00").

Recurrence patterns (null for one-shot):
- "interval:N:min" — every N minutes (e.g. every 5 minutes)
- "interval:N:hour" — every N hours (e.g. every 2 hours)
- "hourly:MM" — every hour at :MM
- "daily:HH:MM" — every day at HH:MM (Jerusalem local time)
- "weekly:D:HH:MM" — every week on day D (1=Mon..7=Sun) at HH:MM
- "monthly:DD:HH:MM" — every month on day DD at HH:MM

IMPORTANT: You MUST use ONLY these exact patterns. Never invent your own format.

Examples:
- "in 30 minutes" → fire_at = CURRENT TIME + 30min, recurrence = null
- "tomorrow at 9am" → fire_at = tomorrow 09:00 same offset, recurrence = null
- "tomorrow" (no time) → fire_at = tomorrow 08:00 same offset, recurrence = null
- "on Tuesday" (no time) → fire_at = next Tuesday 08:00 same offset, recurrence = null
- "every Sunday" (no time) → fire_at = next Sunday 08:00, recurrence = "weekly:7:08:00"
- "every minute" → fire_at = CURRENT TIME + 1min, recurrence = "interval:1:min"
- "every 5 minutes" → fire_at = CURRENT TIME + 5min, recurrence = "interval:5:min"
- "every 2 hours" → fire_at = CURRENT TIME + 2h, recurrence = "interval:2:hour"
- "every hour at :30" → fire_at = next :30, recurrence = "hourly:30"
- "every Monday at 9" → fire_at = next Monday 09:00, recurrence = "weekly:1:09:00"
- "every day at 8:30" → fire_at = next 08:30, recurrence = "daily:08:30"`,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[remind] Haiku parse error ${res.status}: ${errBody.slice(0, 300)}`);
      return null;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text?.trim();
    if (!text) return null;

    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
    console.log(`[remind] Haiku parsed: now=${isoNow} fire_at=${parsed.fire_at} msg="${parsed.message}"`);
    return parsed;
  } catch (err) {
    console.error('[remind] Parse failed:', err.message);
    return null;
  }
}

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function formatRecurrence(rec) {
  if (!rec) return '';
  const [type, ...parts] = rec.split(':');
  if (type === 'interval') {
    const n = parseInt(parts[0]);
    const unit = parts[1] === 'hour' ? 'hour' : 'minute';
    return `every ${n} ${unit}${n > 1 ? 's' : ''}`;
  }
  if (type === 'hourly') return `every hour at :${parts[0]}`;
  if (type === 'daily') return `daily at ${parts[0]}:${parts[1]}`;
  if (type === 'weekly') return `every ${DAY_NAMES[parseInt(parts[0])] || parts[0]} at ${parts[1]}:${parts[2]}`;
  if (type === 'monthly') return `monthly on the ${parts[0]}th at ${parts[1]}:${parts[2]}`;
  return rec;
}

export async function parseAndCreate(chatId, userMessage) {
  await ensureTable();

  const parsed = await parseWithHaiku(userMessage);
  if (!parsed || !parsed.message || !parsed.fire_at) {
    return { ok: false, output: 'Could not understand the reminder request.' };
  }

  const fireAt = new Date(parsed.fire_at);
  if (isNaN(fireAt.getTime())) {
    return { ok: false, output: 'Could not parse the reminder time.' };
  }

  const TOLERANCE_MS = 2 * 60_000;
  if (fireAt.getTime() < Date.now() - TOLERANCE_MS) {
    return { ok: false, output: 'That time is in the past, Sir.' };
  }

  const recurrence = parsed.recurrence || null;
  const kind = classifyKind(fireAt, recurrence);

  const { rows } = await query(
    'INSERT INTO reminders (chat_id, message, fire_at, recurrence, kind) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [chatId, parsed.message, fireAt.toISOString(), recurrence, kind]
  );

  const id = rows[0]?.id;
  const timeStr = fireAt.toLocaleString('en-GB', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });
  const recLabel = recurrence ? ` (repeats ${formatRecurrence(recurrence)})` : '';

  // Scheduled reminders are mirrored to Google Calendar (via n8n) — calendar-only
  // delivery: Google Calendar owns the notification and the long-term record. On a
  // successful sync we retire the local row (mark fired) so the Telegram poller does
  // NOT double-notify. If the sync fails, we keep the local row so the poller still
  // delivers it via Telegram — a reminder is never silently lost.
  let calendarNote = '';
  if (kind === 'scheduled') {
    const cal = await createCalendarEvent({ summary: parsed.message, fireAt, recurrence });
    if (cal.ok) {
      await query(
        'UPDATE reminders SET calendar_event_id = $1, fired = TRUE WHERE id = $2',
        [cal.eventId || null, id]
      );
      calendarNote = recurrence
        ? "\n📅 On your Google Calendar (recurring) — it'll notify you there"
        : "\n📅 On your Google Calendar — it'll notify you there";
    } else if (cal.error !== 'disabled' && cal.error !== 'n8n webhook not configured') {
      calendarNote = '\n⚠️ Calendar sync failed — keeping it as a Telegram reminder';
    }
  }

  return {
    ok: true,
    output: `Reminder set: "${parsed.message}" — ${timeStr}${recLabel}${calendarNote}`,
    id,
    fireAt: fireAt.toISOString(),
    recurrence,
    kind,
  };
}

/**
 * Insert a one-shot local reminder directly (no NL parsing). Used as a
 * fallback when a calendar event fails to sync to Google Calendar, so the
 * item still fires via Telegram and is never silently lost.
 */
export async function insertReminder(chatId, message, fireAt) {
  await ensureTable();
  const when = fireAt instanceof Date ? fireAt : new Date(fireAt);
  if (isNaN(when.getTime())) return { ok: false, output: 'invalid time' };
  const { rows } = await query(
    'INSERT INTO reminders (chat_id, message, fire_at, kind) VALUES ($1, $2, $3, $4) RETURNING id',
    [chatId, message, when.toISOString(), 'timer']
  );
  return { ok: true, id: rows[0]?.id };
}

export async function listReminders(chatId) {
  await ensureTable();

  const { rows } = await query(
    'SELECT id, message, fire_at, recurrence FROM reminders WHERE chat_id = $1 AND fired = FALSE ORDER BY fire_at ASC',
    [chatId]
  );

  if (!rows.length) {
    return { ok: true, output: 'No active reminders.' };
  }

  const lines = rows.map((r) => {
    const time = new Date(r.fire_at).toLocaleString('en-GB', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });
    const rec = r.recurrence ? ` 🔁 ${formatRecurrence(r.recurrence)}` : '';
    return `#${r.id} — ${r.message} — ${time}${rec}`;
  });

  return { ok: true, output: `Active reminders:\n${lines.join('\n')}` };
}

/**
 * Reminders scheduled to fire today (Jerusalem local date), not yet fired.
 * Used by the morning briefing. Returns { ok, items: [{id, message, time, recurrence}] }.
 */
export async function getTodayReminders(chatId) {
  await ensureTable();

  const { rows } = await query(
    `SELECT id, message, fire_at, recurrence
     FROM reminders
     WHERE chat_id = $1
       AND fired = FALSE
       AND (fire_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date
     ORDER BY fire_at ASC`,
    [chatId, TZ]
  );

  const items = rows.map((r) => ({
    id: r.id,
    message: r.message,
    time: new Date(r.fire_at).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }),
    recurrence: r.recurrence ? formatRecurrence(r.recurrence) : null,
  }));

  return { ok: true, items };
}

export async function cancelReminder(chatId, id) {
  await ensureTable();

  const { rows } = await query(
    'SELECT message FROM reminders WHERE id = $1 AND chat_id = $2 AND fired = FALSE',
    [id, chatId]
  );

  if (!rows.length) {
    return { ok: false, output: 'Reminder not found or already cancelled.' };
  }

  await query('UPDATE reminders SET fired = TRUE WHERE id = $1', [id]);
  return { ok: true, output: `Reminder cancelled: "${rows[0].message}"` };
}

export async function cancelByText(chatId, searchText) {
  await ensureTable();

  const { rows } = await query(
    'SELECT id, message FROM reminders WHERE chat_id = $1 AND fired = FALSE ORDER BY fire_at ASC',
    [chatId]
  );

  if (!rows.length) {
    return { ok: false, output: 'No active reminders to cancel.' };
  }

  const NOISE = new Set(['cancel', 'delete', 'remove', 'stop', 'the', 'my', 'a', 'reminder', 'reminders', 'alarm', 'about', 'for', 'to']);
  const lower = searchText.toLowerCase();
  const searchWords = lower.split(/\s+/).filter((w) => w.length > 1 && !NOISE.has(w));

  const cleanedQuery = searchWords.join(' ');

  const match = searchWords.length > 0
    && (rows.find((r) => r.message.toLowerCase().includes(cleanedQuery))
      || rows.find((r) => {
        const msg = r.message.toLowerCase();
        const matched = searchWords.filter((w) => msg.includes(w));
        return matched.length >= Math.ceil(searchWords.length * 0.6);
      }));

  if (!match) {
    const list = rows.map((r) => `#${r.id} — ${r.message}`).join('\n');
    return { ok: false, output: `No reminder matching "${cleanedQuery}". Active reminders:\n${list}` };
  }

  await query('UPDATE reminders SET fired = TRUE WHERE id = $1', [match.id]);
  return { ok: true, output: `Reminder cancelled: "${match.message}"` };
}

export async function snoozeReminder(id, minutes = 5) {
  await ensureTable();

  const { rows } = await query('SELECT chat_id, message, recurrence FROM reminders WHERE id = $1', [id]);
  if (!rows.length) {
    return { ok: false, output: 'Reminder not found.' };
  }

  const fireAt = new Date(Date.now() + minutes * 60_000);
  const timeStr = fireAt.toLocaleString('en-GB', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });

  if (rows[0].recurrence) {
    const { rows: inserted } = await query(
      'INSERT INTO reminders (chat_id, message, fire_at) VALUES ($1, $2, $3) RETURNING id',
      [rows[0].chat_id, rows[0].message, fireAt.toISOString()]
    );
    return { ok: true, output: `Snoozed for ${minutes}m — ${timeStr}`, newId: inserted[0]?.id };
  }

  await query('UPDATE reminders SET fire_at = $1, fired = FALSE WHERE id = $2', [fireAt.toISOString(), id]);
  return { ok: true, output: `Snoozed for ${minutes}m — ${timeStr}`, newId: id };
}

export async function extendReminder(chatId, id, minutes) {
  await ensureTable();

  const { rows } = await query(
    'SELECT fire_at FROM reminders WHERE id = $1 AND chat_id = $2 AND fired = FALSE',
    [id, chatId]
  );

  if (!rows.length) {
    return { ok: false, output: 'Reminder not found or already fired.' };
  }

  const currentFireAt = new Date(rows[0].fire_at);
  const newFireAt = new Date(currentFireAt.getTime() + minutes * 60_000);

  await query('UPDATE reminders SET fire_at = $1 WHERE id = $2', [newFireAt.toISOString(), id]);

  const timeStr = newFireAt.toLocaleString('en-GB', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });

  return { ok: true, output: `Reminder extended by ${minutes}m — now at ${timeStr}` };
}

export function computeNextFire(recurrence, lastFire) {
  if (!recurrence) return null;

  const [type, ...parts] = recurrence.split(':');
  const base = new Date(lastFire);

  if (type === 'interval') {
    const n = parseInt(parts[0]);
    const unit = parts[1];
    const ms = unit === 'hour' ? n * 3600_000 : n * 60_000;
    return new Date(base.getTime() + ms);
  }

  if (type === 'hourly') {
    const mm = parseInt(parts[0]);
    base.setHours(base.getHours() + 1);
    base.setMinutes(mm, 0, 0);
    return base;
  }

  if (type === 'daily') {
    const [hh, mm] = parts;
    base.setDate(base.getDate() + 1);
    base.setHours(parseInt(hh), parseInt(mm), 0, 0);
    return base;
  }

  if (type === 'weekly') {
    const [, hh, mm] = parts;
    base.setDate(base.getDate() + 7);
    base.setHours(parseInt(hh), parseInt(mm), 0, 0);
    return base;
  }

  if (type === 'monthly') {
    const [dayOfMonth, hh, mm] = parts;
    base.setMonth(base.getMonth() + 1);
    base.setDate(parseInt(dayOfMonth));
    base.setHours(parseInt(hh), parseInt(mm), 0, 0);
    return base;
  }

  return null;
}

export async function getDueReminders() {
  await ensureTable();
  const { rows } = await query(
    'SELECT * FROM reminders WHERE fire_at <= NOW() AND fired = FALSE ORDER BY fire_at ASC'
  );
  return rows;
}

export async function markFired(id) {
  await query('UPDATE reminders SET fired = TRUE WHERE id = $1', [id]);
}

export async function updateFireAt(id, newFireAt) {
  await query('UPDATE reminders SET fire_at = $1 WHERE id = $2', [newFireAt.toISOString(), id]);
}

export async function purgeOldReminders() {
  await ensureTable();
  const { rowCount } = await query(
    "DELETE FROM reminders WHERE fired = TRUE AND fire_at < NOW() - INTERVAL '1 day'"
  );
  if (rowCount > 0) {
    console.log(`[remind] Purged ${rowCount} old fired reminder(s)`);
  }
  return rowCount;
}

export async function closeReminderPool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
