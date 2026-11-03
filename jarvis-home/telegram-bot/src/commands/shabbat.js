import {
  getChecklist, renderChecklist, renderTimes, setHome, setPlata, setItemDone, setTime, setVacuum,
  adjustTime, PLATA_MODES, TIME_FIELDS,
} from '../agents/shabbat.js';
import { escapeHtml } from '../utils.js';

export async function shabbatCommand(ctx) {
  const cl = await getChecklist();
  if (!cl.ok) return ctx.replyWithHTML(`🔴 ${escapeHtml(cl.output)}`);
  const { html, extra } = renderChecklist(cl);
  return ctx.replyWithHTML(html, extra);
}

// HA automations react to these changes (plata auto-tick, home/away); give them a moment before re-reading.
const settle = () => new Promise((r) => setTimeout(r, 700));

/** sc:h:<home|away|noplata>, sc:p:<plata mode>, sc:t:<todo uid>, sc:e, sc:a:<field>:<minutes>, sc:v:<on|off>, sc:r */
export async function shabbatCallback(ctx) {
  const [, kind, arg] = ctx.match;
  const cl = await getChecklist();
  if (!cl.ok) return ctx.answerCbQuery(cl.output.slice(0, 190), { show_alert: true });
  if (kind !== 'r' && cl.issur) return ctx.answerCbQuery('Locked until havdalah');

  let note = '';
  let res = { ok: true };
  let view = renderChecklist;
  if (kind === 'h' && ['home', 'away'].includes(arg)) {
    res = await setHome(arg);
    note = arg === 'home' ? 'Home: checklist on' : 'Away: checklist skipped';
    await settle();
  } else if (kind === 'h' && arg === 'noplata') {
    res = await setPlata('off');
    if (res.ok) res = await setHome('home');
    note = 'Home, no plata';
    await settle();
  } else if (kind === 'p' && PLATA_MODES.includes(arg)) {
    if (cl.home !== 'home') return ctx.answerCbQuery('Answer home/away first');
    res = await setPlata(arg);
    note = `Plata timer: ${arg}`;
    await settle();
  } else if (kind === 't') {
    const item = cl.items.find((i) => i.uid === arg);
    if (!item) return ctx.answerCbQuery('Item not found, tap Refresh');
    if (item.tag === 'auto') {
      return ctx.answerCbQuery('Ticks itself once you pick a timer (plug online) or Off', { show_alert: true });
    }
    res = await setItemDone(item.uid, !item.done);
    note = item.done ? 'Unticked' : 'Done';
  } else if (kind === 'e') {
    view = renderTimes;
  } else if (kind === 'a') {
    view = renderTimes;
    const [field, raw] = (arg || '').split(':');
    const minutes = Number(raw);
    if (!TIME_FIELDS[field]?.steps.includes(minutes)) return ctx.answerCbQuery('Unknown adjustment');
    const value = adjustTime(cl, field, minutes);
    if (value === null) return ctx.answerCbQuery('Set this time once in Home Assistant first', { show_alert: true });
    res = await setTime(field, value);
    note = `${TIME_FIELDS[field].label}: ${typeof value === 'number' ? `${value} min` : value}`;
  } else if (kind === 'v' && ['on', 'off'].includes(arg)) {
    view = renderTimes;
    res = await setVacuum(arg === 'on');
    note = `Robot vacuum ${arg}`;
  }
  if (!res.ok) return ctx.answerCbQuery(`Home Assistant error: ${res.output}`.slice(0, 190), { show_alert: true });

  await ctx.answerCbQuery(note);
  const fresh = await getChecklist();
  if (!fresh.ok) return;
  const { html, extra } = view(fresh);
  try {
    await ctx.editMessageText(html, { parse_mode: 'HTML', ...extra });
  } catch (err) {
    if (!/message is not modified/i.test(err.message)) console.error('[shabbat] Edit failed:', err.message);
  }
}
