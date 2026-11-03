import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  atJerusalem, stagesFor, dueStage, isChecklistDay, shouldSend, renderChecklist, plataWindow, hm,
  shiftTime, adjustTime, renderTimes,
} from './shabbat.js';

// Friday 2026-10-23, candle lighting 16:42 Jerusalem (UTC+3 until DST ends on Oct 25).
const candle = new Date('2026-10-23T13:42:00Z');
const at = (hmStr, date = '2026-10-23') => atJerusalem(date, hmStr);

const items = [
  { uid: 'u-ice', summary: 'Fill ice trays in the freezer', done: false, tag: 'early' },
  { uid: 'u-plata', summary: 'Plata: plug in and pick a timer', done: false, tag: 'auto' },
  { uid: 'u-urn', summary: 'Hot water urn: fill and turn on', done: true, tag: 'main' },
];
const base = {
  ok: true, candle, items, home: 'home', plata: 'both', channel: 'both', lead: 30,
  nightOff: '23:30', dayOn: '07:00', dayOff: '14:00', plugOnline: true,
  vacuumSetUp: true, vacuumOn: false, vacuumLead: 120, issur: false,
};
const buttons = (extra) => (extra.reply_markup?.inline_keyboard || []).flat();

test('atJerusalem handles summer and winter offsets', () => {
  assert.equal(atJerusalem('2026-10-23', '09:00').toISOString(), '2026-10-23T06:00:00.000Z');
  assert.equal(atJerusalem('2026-12-04', '09:00').toISOString(), '2026-12-04T07:00:00.000Z');
});

test('stagesFor orders morning, main, nudge, lock relative to candle lighting', () => {
  const stages = stagesFor(candle);
  assert.deepEqual(stages.map((s) => s.id), ['morning', 'main', 'nudge', 'lock']);
  assert.deepEqual(stages.map((s) => hm(s.at)), ['09:00', '13:42', '15:57', '16:27']);
});

test('dueStage returns the latest due stage and skips missed earlier ones', () => {
  const stages = stagesFor(candle);
  assert.equal(dueStage(stages, at('08:59'), candle), null);
  assert.equal(dueStage(stages, at('09:00'), candle).id, 'morning');
  assert.equal(dueStage(stages, at('14:30'), candle).id, 'main');
  assert.equal(dueStage(stages, at('14:30'), candle, ['morning', 'main']), null);
  assert.equal(dueStage(stages, at('16:30'), candle, ['morning']).id, 'lock');
  assert.equal(dueStage(stages, at('16:42'), candle), null);
});

test('isChecklistDay only on the candle-lighting date, before it, outside issur melacha', () => {
  assert.equal(isChecklistDay(candle, at('10:00')), true);
  assert.equal(isChecklistDay(candle, at('10:00', '2026-10-22')), false);
  assert.equal(isChecklistDay(candle, at('17:00')), false);
  assert.equal(isChecklistDay(candle, at('10:00'), true), false);
  assert.equal(isChecklistDay(null, at('10:00')), false);
});

test('shouldSend respects channel, away, and empty nudges', () => {
  assert.equal(shouldSend('main', { ...base, channel: 'ha' }), false);
  assert.equal(shouldSend('main', { ...base, home: 'away' }), false);
  assert.equal(shouldSend('main', { ...base, issur: true }), false);
  assert.equal(shouldSend('lock', { ...base, home: 'unanswered' }), true);
  assert.equal(shouldSend('nudge', base), true);
  assert.equal(shouldSend('nudge', { ...base, items: items.map((i) => ({ ...i, done: true })) }), false);
});

test('plataWindow describes each mode', () => {
  assert.equal(plataWindow({ ...base, plata: 'night' }), 'on 16:12, off 23:30');
  assert.equal(plataWindow({ ...base, plata: 'day' }), 'on 07:00, off 14:00 on the day');
  assert.equal(plataWindow(base), 'on 16:12, off 14:00 the next day');
  assert.equal(plataWindow({ ...base, plata: 'off' }), null);
});

test('unanswered renders the home/away question with a no-plata answer and plata times', () => {
  const { html, extra } = renderChecklist({ ...base, home: 'unanswered' }, { now: at('09:00') });
  assert.match(html, /Are you home for Shabbat\?/);
  assert.deepEqual(buttons(extra).map((b) => b.callback_data), ['sc:h:home', 'sc:h:noplata', 'sc:h:away', 'sc:e']);
});

test('plata off while home counts as an answer; unset reads as not picked', () => {
  const off = renderChecklist({ ...base, plata: 'off', plugOnline: false }, { now: at('12:00') });
  assert.match(off.html, /Plata timer: <b>Off<\/b> \(no plata this time\)/);
  assert.doesNotMatch(off.html, /plug is offline/);
  assert.ok(buttons(off.extra).some((b) => b.text === '● Off'));
  const unset = renderChecklist({ ...base, plata: 'unset', plugOnline: false }, { now: at('12:00') });
  assert.match(unset.html, /Plata timer: <b>Not picked<\/b>/);
  assert.doesNotMatch(unset.html, /plug is offline/);
  assert.ok(!buttons(unset.extra).some((b) => b.text.startsWith('●')));
  assert.ok(buttons(unset.extra).some((b) => b.callback_data === 'sc:e'));
});

test('shiftTime wraps around midnight', () => {
  assert.equal(shiftTime('23:30', 30), '00:00');
  assert.equal(shiftTime('23:45', 30), '00:15');
  assert.equal(shiftTime('00:10', -15), '23:55');
  assert.equal(shiftTime('07:00', 15), '07:15');
});

test('adjustTime clamps minute fields to their HA bounds and needs an existing time', () => {
  assert.equal(adjustTime(base, 'lead', 15), 45);
  assert.equal(adjustTime({ ...base, lead: 5 }, 'lead', -15), 0);
  assert.equal(adjustTime({ ...base, lead: 175 }, 'lead', 15), 180);
  assert.equal(adjustTime(base, 'vacuumLead', 30), 150);
  assert.equal(adjustTime({ ...base, vacuumLead: 15 }, 'vacuumLead', -15), 15);
  assert.equal(adjustTime({ ...base, vacuumLead: 345 }, 'vacuumLead', 30), 360);
  assert.equal(adjustTime(base, 'nightOff', 30), '00:00');
  assert.equal(adjustTime(base, 'dayOff', -30), '13:30');
  assert.equal(adjustTime({ ...base, dayOn: null }, 'dayOn', 15), null);
});

test('times view shows plata values and valid adjust buttons; vacuum off hides its minutes', () => {
  const { html, extra } = renderTimes(base);
  assert.match(html, /Plata on <b>30 min<\/b> before candle lighting \(16:12 this week\)/);
  assert.match(html, /Night: off at <b>23:30<\/b> · Day: on <b>07:00<\/b>, off <b>14:00<\/b>/);
  assert.match(html, /Robot vacuum: <b>off<\/b>/);
  const data = buttons(extra).map((b) => b.callback_data);
  assert.ok(data.includes('sc:a:lead:-15'));
  assert.ok(data.includes('sc:a:nightOff:30'));
  assert.ok(data.includes('sc:a:dayOff:-15'));
  assert.ok(!data.some((d) => d.startsWith('sc:a:vacuumLead')));
  assert.ok(data.includes('sc:v:on'));
  assert.equal(data[data.length - 1], 'sc:r');
  for (const d of data) assert.ok(/^sc:(e|r|v:(on|off)|a:\w+:-?\d+)$/.test(d) && Buffer.byteLength(d) <= 64);
});

test('vacuum on: times view shows start time and minutes; checklist shows the start line', () => {
  const on = { ...base, vacuumOn: true };
  const times = renderTimes(on);
  assert.match(times.html, /Robot vacuum starts <b>120 min<\/b> before candle lighting \(14:42 this week\), if you're home/);
  const data = buttons(times.extra).map((b) => b.callback_data);
  assert.ok(data.includes('sc:a:vacuumLead:-30'));
  assert.ok(data.includes('sc:v:off'));
  assert.match(renderChecklist(on, { now: at('12:00') }).html, /Robot vacuum starts <b>14:42<\/b>/);
  assert.doesNotMatch(renderChecklist(base, { now: at('12:00') }).html, /Robot vacuum/);
});

test('vacuum helper missing in HA: times view says so and offers no toggle', () => {
  const { html, extra } = renderTimes({ ...base, vacuumSetUp: false });
  assert.match(html, /not set up in Home Assistant yet/);
  assert.ok(!buttons(extra).some((b) => b.callback_data.startsWith('sc:v:')));
});

test('home renders plata modes, items, and the morning early list', () => {
  const { html, extra } = renderChecklist(base, { stage: 'morning', now: at('09:00') });
  assert.match(html, /1\/3<\/b> done/);
  assert.match(html, /Start early: Fill ice trays in the freezer\./);
  assert.match(html, /Plata timer: <b>Both<\/b> \(on 16:12, off 14:00 the next day\)/);
  assert.match(html, /in 7h 42m/);
  const data = buttons(extra).map((b) => b.callback_data);
  assert.deepEqual(data.slice(0, 4), ['sc:p:night', 'sc:p:day', 'sc:p:both', 'sc:p:off']);
  assert.ok(data.includes('sc:t:u-ice'));
  assert.ok(buttons(extra).some((b) => b.text === '● Both'));
  assert.ok(buttons(extra).some((b) => b.text.endsWith('(auto)')));
  for (const d of data) assert.ok(Buffer.byteLength(d) <= 64);
});

test('offline plug with a timer chosen shows a warning', () => {
  const { html } = renderChecklist({ ...base, plugOnline: false }, { now: at('12:00') });
  assert.match(html, /plata plug is offline/);
});

test('lock stage and issur melacha render a summary without buttons', () => {
  const lock = renderChecklist(base, { stage: 'lock', now: at('16:27') });
  assert.match(lock.html, /Shabbat shalom/);
  assert.match(lock.html, /Not done: Fill ice trays in the freezer, Plata: plug in and pick a timer\./);
  assert.deepEqual(lock.extra, {});
  const locked = renderChecklist({ ...base, issur: true }, { now: at('20:00') });
  assert.match(locked.html, /Locked until havdalah/);
  assert.deepEqual(locked.extra, {});
});

test('a Chag (non-Friday) candle lighting is labelled Chag', () => {
  const chag = new Date('2026-10-01T14:20:00Z'); // Thursday
  const { html } = renderChecklist({ ...base, candle: chag, home: 'unanswered' }, { now: new Date('2026-10-01T07:00:00Z') });
  assert.match(html, /Chag checklist/);
  assert.match(html, /Are you home for Chag\?/);
});

test('item summaries are HTML-escaped', () => {
  const cl = { ...base, items: [{ uid: 'x', summary: 'Salt & <pepper>', done: false, tag: 'main' }] };
  const { html } = renderChecklist(cl, { stage: 'lock', now: at('16:27') });
  assert.match(html, /Salt &amp; &lt;pepper&gt;/);
});
