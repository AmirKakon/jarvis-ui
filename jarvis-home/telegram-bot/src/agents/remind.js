import pg from 'pg';
const { Pool } = pg;

const TZ = 'Asia/Jerusalem';

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
  tableReady = true;
}

function nowJerusalemISO() {
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
        model: 'claude-haiku-4-5-20251001',
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

Recurrence patterns (null for one-shot):
- "daily:HH:MM" — every day at HH:MM (Jerusalem local time)
- "weekly:D:HH:MM" — every week on day D (1=Mon..7=Sun) at HH:MM
- "monthly:DD:HH:MM" — every month on day DD at HH:MM

Examples:
- "in 30 minutes" → fire_at = CURRENT TIME + 30min, recurrence = null
- "tomorrow at 9am" → fire_at = tomorrow 09:00 same offset, recurrence = null
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

  const { rows } = await query(
    'INSERT INTO reminders (chat_id, message, fire_at, recurrence) VALUES ($1, $2, $3, $4) RETURNING id',
    [chatId, parsed.message, fireAt.toISOString(), parsed.recurrence || null]
  );

  const id = rows[0]?.id;
  const timeStr = fireAt.toLocaleString('en-GB', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });
  const recLabel = parsed.recurrence ? ` (repeats ${formatRecurrence(parsed.recurrence)})` : '';

  return {
    ok: true,
    output: `Reminder set: "${parsed.message}" — ${timeStr}${recLabel}`,
    id,
    fireAt: fireAt.toISOString(),
    recurrence: parsed.recurrence || null,
  };
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

  const lower = searchText.toLowerCase().replace(/cancel\s*(the\s*)?reminder\s*(about|for|to)?\s*/i, '').trim();
  const searchWords = lower.split(/\s+/).filter((w) => w.length > 1);

  const match = rows.find((r) => r.message.toLowerCase().includes(lower))
    || rows.find((r) => {
      const msg = r.message.toLowerCase();
      const matched = searchWords.filter((w) => msg.includes(w));
      return matched.length >= Math.ceil(searchWords.length * 0.6);
    });

  if (!match) {
    const list = rows.map((r) => `#${r.id} — ${r.message}`).join('\n');
    return { ok: false, output: `No reminder matching "${lower}". Active reminders:\n${list}` };
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

export async function closeReminderPool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
