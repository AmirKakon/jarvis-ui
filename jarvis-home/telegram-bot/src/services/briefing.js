import { escapeHtml } from '../utils.js';
import { collectHealth } from './health.js';
import { getWeatherSummary } from '../agents/weather.js';
import { getHomeSummary, getStates } from '../agents/ha.js';
import { getTodayReminders } from '../agents/remind.js';
import { getGarminSummary } from '../agents/garmin.js';
import { getJewishSummary } from '../agents/jewish.js';
import { getTodayCalendar } from '../agents/calendar.js';

const TZ = 'Asia/Jerusalem';

function greeting() {
  const hour = parseInt(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date()),
    10
  );
  if (hour < 5) return 'Burning the midnight oil';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function dateLine() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date());
}

async function buildHealthSection() {
  const h = await collectHealth();

  const bits = [];
  if (h.disk) bits.push(`💾 Disk ${h.disk.pct}%${h.disk.pct > 90 ? ' ⚠️' : ''}`);
  if (h.mem && h.mem.pct != null) bits.push(`🧠 RAM ${h.mem.pct}%`);
  if (h.load) bits.push(`📈 Load ${h.load.one}`);

  const lines = [];
  if (bits.length) lines.push(`   ${bits.join('   ')}`);

  if (h.containers.length) {
    const down = h.containers.filter((c) => !c.up).map((c) => c.name);
    if (down.length) {
      lines.push(`   🔴 Containers down: ${down.map(escapeHtml).join(', ')}`);
    } else {
      lines.push('   🟢 All containers up');
    }
  }

  return lines.join('\n');
}

function buildHomeFromSummary(home) {
  if (!home || !home.ok) return null;

  const counts = Object.entries(home.onByDomain)
    .map(([domain, n]) => `${n} ${domain}${n > 1 ? 's' : ''}`)
    .join(', ');

  const lines = [];
  if (!counts) {
    lines.push('   Everything is off.');
  } else {
    lines.push(`   On: ${counts}`);
    if (home.onNames.length) lines.push(`   <i>${escapeHtml(home.onNames.join(', '))}</i>`);
  }
  if (home.unavailable > 0) lines.push(`   ⚠️ ${home.unavailable} entity(ies) unavailable`);

  return lines.join('\n');
}

async function buildRemindersSection(chatId) {
  const res = await getTodayReminders(chatId);
  if (!res.ok || !res.items.length) return null;

  return res.items
    .map((r) => {
      const rec = r.recurrence ? ` 🔁` : '';
      return `   • <b>${r.time}</b> ${escapeHtml(r.message)}${rec}`;
    })
    .join('\n');
}

/**
 * Build the full daily briefing as Telegram HTML.
 * Every section is best-effort — a failing source is simply omitted.
 * Home Assistant state is fetched once and shared across HA-backed sections.
 */
export async function buildBriefing(chatId) {
  const statesRes = await getStates().catch(() => ({ ok: false }));
  const states = statesRes.ok ? statesRes.data : null;

  const [weather, jewish, calendar, reminders, garmin, home, health] = await Promise.all([
    getWeatherSummary().catch(() => ({ ok: false })),
    getJewishSummary(states).catch(() => ({ ok: false })),
    getTodayCalendar(states).catch(() => ({ ok: false })),
    buildRemindersSection(chatId).catch(() => null),
    getGarminSummary(states).catch(() => ({ ok: false })),
    getHomeSummary(states).then(buildHomeFromSummary).catch(() => null),
    buildHealthSection().catch(() => ''),
  ]);

  const lines = [];
  lines.push(`☀️ <b>${greeting()}, Sir.</b>`);
  lines.push(`<i>${escapeHtml(dateLine())}</i>`);

  if (jewish.ok) {
    lines.push('');
    lines.push('<b>Hebrew Calendar</b>');
    lines.push(jewish.text);
  }

  if (weather.ok) {
    lines.push('');
    lines.push('<b>Weather</b>');
    lines.push(weather.text);
  }

  if (calendar.ok && calendar.text) {
    lines.push('');
    lines.push('<b>Today\u2019s Calendar</b>');
    lines.push(calendar.text);
  }

  if (reminders) {
    lines.push('');
    lines.push('<b>Today\u2019s Reminders</b>');
    lines.push(reminders);
  }

  if (garmin.ok) {
    lines.push('');
    lines.push('<b>Health</b>');
    lines.push(garmin.text);
  }

  if (home) {
    lines.push('');
    lines.push('<b>Home</b>');
    lines.push(home);
  }

  if (health) {
    lines.push('');
    lines.push('<b>System</b>');
    lines.push(health);
  }

  return lines.join('\n');
}
