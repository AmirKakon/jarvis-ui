import { getChecklist, renderChecklist, setHome, setPlata, setItemDone, PLATA_MODES } from '../agents/shabbat.js';
import { escapeHtml } from '../utils.js';

export async function shabbatCommand(ctx) {
  const cl = await getChecklist();
  if (!cl.ok) return ctx.replyWithHTML(`🔴 ${escapeHtml(cl.output)}`);
  const { html, extra } = renderChecklist(cl);
  return ctx.replyWithHTML(html, extra);
}

/** sc:h:<home|away>, sc:p:<plata mode>, sc:t:<todo uid>, sc:r */
export async function shabbatCallback(ctx) {
  const [, kind, arg] = ctx.match;
  const cl = await getChecklist();
  if (!cl.ok) return ctx.answerCbQuery(cl.output.slice(0, 190), { show_alert: true });
  if (kind !== 'r' && cl.issur) return ctx.answerCbQuery('Locked until havdalah');

  let note = '';
  let res = { ok: true };
  if (kind === 'h' && ['home', 'away'].includes(arg)) {
    res = await setHome(arg);
    note = arg === 'home' ? 'Home: checklist on' : 'Away: checklist skipped';
  } else if (kind === 'p' && PLATA_MODES.includes(arg)) {
    if (cl.home !== 'home') return ctx.answerCbQuery('Answer home/away first');
    res = await setPlata(arg);
    note = `Plata timer: ${arg}`;
    // HA ticks the plata item in an automation; give it a moment before re-reading.
    await new Promise((r) => setTimeout(r, 700));
  } else if (kind === 't') {
    const item = cl.items.find((i) => i.uid === arg);
    if (!item) return ctx.answerCbQuery('Item not found, tap Refresh');
    if (item.tag === 'auto') {
      return ctx.answerCbQuery('Ticks itself once the plug is online and a timer is picked', { show_alert: true });
    }
    res = await setItemDone(item.uid, !item.done);
    note = item.done ? 'Unticked' : 'Done';
  }
  if (!res.ok) return ctx.answerCbQuery(`Home Assistant error: ${res.output}`.slice(0, 190), { show_alert: true });

  await ctx.answerCbQuery(note);
  const fresh = await getChecklist();
  if (!fresh.ok) return;
  const { html, extra } = renderChecklist(fresh);
  try {
    await ctx.editMessageText(html, { parse_mode: 'HTML', ...extra });
  } catch (err) {
    if (!/message is not modified/i.test(err.message)) console.error('[shabbat] Edit failed:', err.message);
  }
}
