import { fetchHA } from './ha.js';
import { escapeHtml, cbData } from '../utils.js';

// Pre-Shabbat / Chag checklist. Home Assistant owns the data (todo list + helpers,
// homeassistant/packages/shabbat_checklist.yaml) and the plata timer; this module
// reads/writes it and renders the Telegram view.

const TZ = 'Asia/Jerusalem';

// Minutes before candle lighting. Keep in sync with the HA package.
export const STAGES = [
  { id: 'main', before: 180 },
  { id: 'nudge', before: 45 },
  { id: 'lock', before: 15 },
];

export const PLATA_MODES = ['night', 'day', 'both', 'off'];
const PLATA_LABELS = { night: 'Night', day: 'Day', both: 'Both', off: 'Off' };

const CANDLE_SENSORS = [
  'sensor.shabbat_checklist_candle_lighting',
  'sensor.jewish_calendar_upcoming_candle_lighting',
  'sensor.jewish_calendar_upcoming_shabbat_candle_lighting',
];

function entities() {
  return {
    todo: 'todo.shabbat_checklist',
    home: 'input_select.shabbat_home',
    plata: 'input_select.shabbat_plata',
    channel: 'input_select.shabbat_checklist_channel',
    lead: 'input_number.shabbat_plata_lead_minutes',
    nightOff: 'input_datetime.shabbat_plata_night_off',
    dayOn: 'input_datetime.shabbat_plata_day_on',
    dayOff: 'input_datetime.shabbat_plata_day_off',
    plug: process.env.SHABBAT_PLATA_SWITCH || 'switch.ac_plug_socket_1',
    issur: 'binary_sensor.jewish_calendar_issur_melacha_in_effect',
  };
}

// --- Time helpers (Asia/Jerusalem) ---

function parts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  if (p.hour === '24') p.hour = '00';
  return p;
}

export function jerusalemDate(date) {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function hm(date) {
  const p = parts(date);
  return `${p.hour}:${p.minute}`;
}

function weekday(date) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(date);
}

/** Date for a Jerusalem wall-clock time ('YYYY-MM-DD', 'HH:MM'). */
export function atJerusalem(dateStr, hmStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi] = hmStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const p = parts(new Date(guess));
  const wallAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess - (wallAsUtc - guess));
}

// --- Schedule ---

export function stagesFor(candle, morning = '09:00') {
  return [
    { id: 'morning', at: atJerusalem(jerusalemDate(candle), morning) },
    ...STAGES.map((s) => ({ id: s.id, at: new Date(candle.getTime() - s.before * 60_000) })),
  ].sort((a, b) => a.at - b.at);
}

/** The latest stage that is due and not yet sent; earlier missed stages are skipped. */
export function dueStage(stages, now, candle, sent = []) {
  if (now >= candle) return null;
  const due = stages.filter((s) => s.at <= now);
  if (!due.length) return null;
  const latest = due[due.length - 1];
  return sent.includes(latest.id) ? null : latest;
}

export function isChecklistDay(candle, now, issur = false) {
  return !!candle && !issur && now < candle && jerusalemDate(candle) === jerusalemDate(now);
}

export function shouldSend(stageId, cl) {
  if (cl.issur || cl.channel === 'ha' || cl.home === 'away') return false;
  if (cl.home === 'unanswered') return true;
  if (stageId === 'nudge') return cl.items.some((i) => !i.done);
  return true;
}

// --- Home Assistant ---

async function state(entityId) {
  const res = await fetchHA(`states/${entityId}`);
  return res.ok ? res.data : null;
}

const hmOf = (s) => (s && /^\d{2}:\d{2}/.test(s.state) ? s.state.slice(0, 5) : null);

export async function getCandle() {
  for (const id of CANDLE_SENSORS) {
    const s = await state(id);
    const d = s ? new Date(s.state) : null;
    if (d && !Number.isNaN(d.getTime())) return d;
  }
  return null;
}

async function getItems() {
  const { todo } = entities();
  const res = await fetchHA('services/todo/get_items?return_response', 'POST', { entity_id: todo });
  const items = res.ok ? res.data?.service_response?.[todo]?.items : null;
  if (!Array.isArray(items)) return null;
  return items.map((i) => ({
    uid: i.uid,
    summary: i.summary,
    done: i.status === 'completed',
    tag: i.description || 'main',
  }));
}

export async function getChecklist() {
  const e = entities();
  const [candle, items, home, plata, channel, lead, nightOff, dayOn, dayOff, plug, issur] = await Promise.all([
    getCandle(), getItems(), state(e.home), state(e.plata), state(e.channel), state(e.lead),
    state(e.nightOff), state(e.dayOn), state(e.dayOff), state(e.plug), state(e.issur),
  ]);
  if (!items || !home) {
    const missing = !items ? e.todo : e.home;
    return { ok: false, output: `Shabbat checklist isn't set up in Home Assistant (${missing} missing). See homeassistant/packages/shabbat_checklist.yaml.` };
  }
  const leadMin = Number(lead?.state);
  return {
    ok: true,
    candle,
    items,
    home: home.state,
    plata: plata?.state || 'off',
    channel: channel?.state || 'both',
    lead: Number.isFinite(leadMin) ? leadMin : 30,
    nightOff: hmOf(nightOff),
    dayOn: hmOf(dayOn),
    dayOff: hmOf(dayOff),
    plugOnline: !!plug && !['unavailable', 'unknown'].includes(plug.state),
    issur: issur?.state === 'on',
  };
}

const selectOption = (entity_id, option) =>
  fetchHA('services/input_select/select_option', 'POST', { entity_id, option });

export const setHome = (option) => selectOption(entities().home, option);
export const setPlata = (option) => selectOption(entities().plata, option);
export const setItemDone = (uid, done) =>
  fetchHA('services/todo/update_item', 'POST', {
    entity_id: entities().todo, item: uid, status: done ? 'completed' : 'needs_action',
  });

// --- Telegram view ---

export function plataWindow(cl) {
  const onNight = cl.candle ? hm(new Date(cl.candle.getTime() - cl.lead * 60_000)) : '?';
  const t = (v) => v || '?';
  switch (cl.plata) {
    case 'night': return `on ${onNight}, off ${t(cl.nightOff)}`;
    case 'day': return `on ${t(cl.dayOn)}, off ${t(cl.dayOff)} on the day`;
    case 'both': return `on ${onNight}, off ${t(cl.dayOff)} the next day`;
    default: return null;
  }
}

function plataLine(cl) {
  const window = plataWindow(cl);
  let line = `🍲 Plata timer: <b>${PLATA_LABELS[cl.plata] || escapeHtml(cl.plata)}</b>${window ? ` (${window})` : ''}`;
  if (cl.plata !== 'off' && !cl.plugOnline) line += '\n⚠️ The plata plug is offline. Plug it in so the timer can switch it.';
  return line;
}

function countdown(candle, now) {
  const min = Math.round((candle - now) / 60_000);
  if (min <= 0) return '';
  const h = Math.floor(min / 60);
  return ` · in ${h ? `${h}h ` : ''}${min % 60}m`;
}

const button = (text, data) => ({ text, callback_data: data });
const short = (s, max = 48) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Returns { html, extra } for sendMessage / editMessageText. */
export function renderChecklist(cl, { stage = null, now = new Date() } = {}) {
  const label = cl.candle && weekday(cl.candle) === 'Fri' ? 'Shabbat' : 'Chag';
  const lines = [`🕯️ <b>${label} checklist</b>`];
  if (cl.candle) {
    const today = jerusalemDate(cl.candle) === jerusalemDate(now);
    lines.push(`Candle lighting <b>${today ? '' : `${weekday(cl.candle)} `}${hm(cl.candle)}</b>${today ? countdown(cl.candle, now) : ''}`);
  }
  lines.push('');

  const left = cl.items.filter((i) => !i.done);
  const notDone = left.length ? `Not done: ${left.map((i) => escapeHtml(i.summary)).join(', ')}.` : 'Everything is done.';

  if (cl.issur) {
    lines.push('🔒 Locked until havdalah.');
    if (cl.home === 'home') lines.push(plataLine(cl), notDone);
    return { html: lines.join('\n'), extra: {} };
  }

  if (stage === 'lock') {
    if (cl.home === 'home') lines.push(label === 'Shabbat' ? 'Shabbat shalom 🕯️' : 'Chag sameach 🕯️', plataLine(cl), notDone);
    else lines.push('No answer, so nothing is scheduled and the plata timer is off.');
    return { html: lines.join('\n'), extra: {} };
  }

  if (cl.home === 'unanswered') {
    lines.push(`Are you home for ${label}?`);
    return {
      html: lines.join('\n'),
      extra: { reply_markup: { inline_keyboard: [[button('🏠 Yes, home', 'sc:h:home'), button('🧳 No, away', 'sc:h:away')]] } },
    };
  }

  if (cl.home === 'away') {
    lines.push(`🧳 Away for ${label}: checklist skipped, plata timer off.`);
    return {
      html: lines.join('\n'),
      extra: { reply_markup: { inline_keyboard: [[button("🏠 I'm home after all", 'sc:h:home')]] } },
    };
  }

  lines.push(`<b>${cl.items.length - left.length}/${cl.items.length}</b> done`);
  const early = left.filter((i) => i.tag === 'early');
  if (stage === 'morning' && early.length) lines.push(`Start early: ${early.map((i) => escapeHtml(i.summary)).join(', ')}.`);
  if (stage === 'nudge') lines.push(`⏰ 45 minutes to candle lighting, ${left.length} left.`);
  lines.push(plataLine(cl));

  const rows = [
    PLATA_MODES.map((m) => button(`${cl.plata === m ? '● ' : ''}${PLATA_LABELS[m]}`, `sc:p:${m}`)),
    ...cl.items
      .map((i) => {
        const data = cbData('sc:t:', i.uid);
        return data && [button(short(`${i.done ? '✅' : '⬜'} ${i.summary}${i.tag === 'auto' ? ' (auto)' : ''}`), data)];
      })
      .filter(Boolean),
    [button('🔄 Refresh', 'sc:r'), button('🧳 Away', 'sc:h:away')],
  ];
  return { html: lines.join('\n'), extra: { reply_markup: { inline_keyboard: rows } } };
}
