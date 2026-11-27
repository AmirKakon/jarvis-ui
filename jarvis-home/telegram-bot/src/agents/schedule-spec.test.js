import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReminder, buildEvent, resolveDateRange, hasTiming } from './schedule-spec.js';
import { jerusalemTime, jerusalemParts } from '../time.js';

// Thursday 26 Nov 2026, 12:00 in Jerusalem (winter, UTC+2).
const NOW = new Date('2026-11-26T10:00:00Z');

const build = (spec, now = NOW) => buildReminder({ message: 'test', ...spec }, now);
const iso = (r) => r.fireAt.toISOString();

test('jerusalemTime handles winter, summer and the spring DST gap', () => {
  assert.equal(jerusalemTime(2026, 12, 1, 9, 0).toISOString(), '2026-12-01T07:00:00.000Z');
  assert.equal(jerusalemTime(2026, 7, 1, 9, 0).toISOString(), '2026-07-01T06:00:00.000Z');
  assert.equal(jerusalemTime(2026, 3, 27, 2, 30).toISOString(), '2026-03-27T00:30:00.000Z');
  assert.equal(jerusalemTime(2026, 11, 32, 8, 0).toISOString(), '2026-12-02T06:00:00.000Z');
  assert.equal(jerusalemParts(NOW).weekday, 4);
});

test('relative one-shot', () => {
  const r = build({ in_minutes: 30 });
  assert.equal(iso(r), '2026-11-26T10:30:00.000Z');
  assert.equal(r.recurrence, null);
});

test('date and time, and a date alone defaults to 08:00', () => {
  assert.equal(iso(build({ date: '2026-11-27', time: '09:00' })), '2026-11-27T07:00:00.000Z');
  assert.equal(iso(build({ date: '2026-11-27' })), '2026-11-27T06:00:00.000Z');
});

test('a time alone is today if still ahead, otherwise tomorrow', () => {
  assert.equal(iso(build({ time: '18:00' })), '2026-11-26T16:00:00.000Z');
  assert.equal(iso(build({ time: '07:30' })), '2026-11-27T05:30:00.000Z');
});

test('a time already gone today is refused, not moved', () => {
  assert.equal(build({ date: '2026-11-26', time: '09:00' }).ok, false);
});

test('minute and hour intervals', () => {
  const m = build({ repeat: 'minutes', every: 5 });
  assert.equal(m.recurrence, 'interval:5:min');
  assert.equal(iso(m), '2026-11-26T10:05:00.000Z');
  const h = build({ repeat: 'hours', every: 2 });
  assert.equal(h.recurrence, 'interval:2:hour');
  assert.equal(iso(h), '2026-11-26T12:00:00.000Z');
  assert.equal(build({ repeat: 'minutes' }).ok, false);
});

test('hourly at a minute', () => {
  const r = build({ repeat: 'hourly', minute: 30 });
  assert.equal(r.recurrence, 'hourly:30');
  assert.equal(iso(r), '2026-11-26T10:30:00.000Z');
});

test('daily picks the next occurrence', () => {
  const r = build({ repeat: 'daily', time: '08:30' });
  assert.equal(r.recurrence, 'daily:08:30');
  assert.equal(iso(r), '2026-11-27T06:30:00.000Z');
});

test('weekly on a weekday defaults to 08:00, or takes the weekday from a date', () => {
  const sun = build({ repeat: 'weekly', weekday: 7 });
  assert.equal(sun.recurrence, 'weekly:7:08:00');
  assert.equal(iso(sun), '2026-11-29T06:00:00.000Z');
  const fromDate = build({ repeat: 'weekly', date: '2026-12-01', time: '09:15' });
  assert.equal(fromDate.recurrence, 'weekly:2:09:15');
  assert.equal(iso(fromDate), '2026-12-01T07:15:00.000Z');
  assert.equal(build({ repeat: 'weekly' }).ok, false);
});

test('monthly skips months without that day', () => {
  const r = build({ repeat: 'monthly', day_of_month: 15, time: '10:00' });
  assert.equal(r.recurrence, 'monthly:15:10:00');
  assert.equal(iso(r), '2026-12-15T08:00:00.000Z');
  assert.equal(iso(build({ repeat: 'monthly', day_of_month: 31, time: '10:00' })), '2026-12-31T08:00:00.000Z');
});

test('missing or bad input is refused with a question, not guessed', () => {
  assert.equal(buildReminder({ in_minutes: 5 }, NOW).ok, false);
  assert.equal(build({}).ok, false);
  assert.equal(build({ time: '25:00' }).ok, false);
  assert.equal(build({ date: '2026-02-30' }).ok, false);
  assert.equal(build({ in_minutes: -5 }).ok, false);
  assert.equal(build({ repeat: 'yearly' }).ok, false);
});

test('hasTiming tells structured specs from bare text', () => {
  assert.equal(hasTiming({ text: 'remind me later' }), false);
  assert.equal(hasTiming({ repeat: 'none' }), false);
  assert.equal(hasTiming({ in_minutes: 5 }), true);
  assert.equal(hasTiming({ repeat: 'daily' }), true);
});

const event = (spec) => buildEvent({ summary: 'Meeting', ...spec }, NOW);

test('events default to 09:00 and 60 minutes', () => {
  const e = event({ date: '2026-11-27' });
  assert.equal(e.start.toISOString(), '2026-11-27T07:00:00.000Z');
  assert.equal(e.durationMin, 60);
  assert.equal(e.recurrence, null);
  assert.equal(e.location, null);
});

test('event length from duration or end time, including past midnight', () => {
  assert.equal(event({ date: '2026-11-27', time: '15:00', duration_min: 30 }).durationMin, 30);
  assert.equal(event({ date: '2026-11-27', time: '14:00', end_time: '15:30' }).durationMin, 90);
  assert.equal(event({ date: '2026-11-27', time: '23:00', end_time: '01:00' }).durationMin, 120);
});

test('repeating events and their limits', () => {
  const e = event({ repeat: 'weekly', weekday: 1, time: '09:00', location: ' Office ' });
  assert.equal(e.recurrence, 'weekly:1:09:00');
  assert.equal(e.start.toISOString(), '2026-11-30T07:00:00.000Z');
  assert.equal(e.location, 'Office');
  assert.equal(event({ repeat: 'minutes', every: 5 }).ok, false);
  assert.equal(buildEvent({ date: '2026-11-27' }, NOW).ok, false);
  assert.equal(event({}).ok, false);
});

test('date ranges are inclusive local days', () => {
  const week = resolveDateRange('2026-11-26', '2026-11-29');
  assert.equal(week.startISO, '2026-11-25T22:00:00.000Z');
  assert.equal(week.endISO, '2026-11-29T22:00:00.000Z');
  assert.equal(week.label, 'Thu 26 Nov – Sun 29 Nov');
  const day = resolveDateRange('2026-11-27');
  assert.equal(day.endISO, '2026-11-27T22:00:00.000Z');
  assert.equal(day.label, 'Fri 27 Nov');
  assert.equal(resolveDateRange('2026-11-29', '2026-11-26').ok, false);
  assert.equal(resolveDateRange('2026-01-01', '2026-12-31').ok, false);
  assert.equal(resolveDateRange('Friday').ok, false);
});
