import { getStates } from './ha.js';

const EMPTY = new Set(['unknown', 'unavailable', 'none', '', null, undefined]);

function val(map, id) {
  const s = map.get(id);
  if (!s) return null;
  const state = s.state;
  if (EMPTY.has(typeof state === 'string' ? state.toLowerCase() : state)) return null;
  return state;
}

function num(map, id) {
  const v = val(map, id);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtDuration(minutes) {
  if (minutes == null) return null;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function detectPrefix(states) {
  if (process.env.GARMIN_PREFIX) return process.env.GARMIN_PREFIX;
  const bb = states.find((s) => /^sensor\.garmin_connect_.*_body_battery$/.test(s.entity_id));
  if (bb) return bb.entity_id.replace(/body_battery$/, '');
  const any = states.find((s) => s.entity_id.startsWith('sensor.garmin_connect_'));
  if (any) {
    // strip trailing metric name — fall back to integration prefix
    const m = any.entity_id.match(/^(sensor\.garmin_connect_[a-z0-9]+_)/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Build a compact Garmin wellness summary for the morning briefing.
 * Best-effort: returns { ok:false } if Garmin entities aren't present.
 * Accepts an optional pre-fetched states array.
 */
export async function getGarminSummary(states = null) {
  if (process.env.GARMIN_ENABLED === 'false') return { ok: false, output: 'disabled' };

  let data = states;
  if (!data) {
    const res = await getStates();
    if (!res.ok) return { ok: false, output: res.output };
    data = res.data;
  }

  const prefix = detectPrefix(data);
  if (!prefix) return { ok: false, output: 'No Garmin entities found.' };

  const map = new Map(data.map((s) => [s.entity_id, s]));
  const at = (suffix) => `${prefix}${suffix}`;

  const lines = [];

  const battery = num(map, at('body_battery'));
  if (battery != null) {
    const lo = num(map, at('body_battery_lowest'));
    const hi = num(map, at('body_battery_highest'));
    const range = (lo != null && hi != null) ? ` (${lo}–${hi})` : '';
    lines.push(`   🔋 Body Battery: <b>${battery}%</b>${range}`);
  }

  const sleepScore = num(map, at('sleep_score'));
  const sleepDur = fmtDuration(num(map, at('total_sleep_duration')) ?? num(map, at('sleep_duration')));
  if (sleepScore != null || sleepDur) {
    const parts = [];
    if (sleepScore != null) parts.push(`score ${sleepScore}`);
    if (sleepDur) parts.push(sleepDur);
    lines.push(`   😴 Sleep: <b>${parts.join(' · ')}</b>`);
  }

  const rhr = num(map, at('resting_heart_rate'));
  const hrv = num(map, at('hrv_last_night_average'));
  if (rhr != null || hrv != null) {
    const parts = [];
    if (rhr != null) parts.push(`❤️ RHR ${rhr} bpm`);
    if (hrv != null) parts.push(`📊 HRV ${hrv} ms`);
    lines.push(`   ${parts.join('   ')}`);
  }

  const steps = num(map, at('steps'));
  const stepGoal = num(map, at('daily_step_goal'));
  if (steps != null) {
    const goal = stepGoal != null ? ` / ${stepGoal.toLocaleString()}` : '';
    lines.push(`   👣 Steps: <b>${steps.toLocaleString()}</b>${goal}`);
  }

  const training = val(map, at('training_status'));
  const readiness = num(map, at('training_readiness')) ?? num(map, at('morning_training_readiness'));
  if (training || readiness != null) {
    const parts = [];
    if (readiness != null) parts.push(`readiness ${readiness}%`);
    if (training) parts.push(training);
    lines.push(`   🏃 Training: <b>${parts.join(' · ')}</b>`);
  }

  const stress = num(map, at('average_stress_level'));
  if (stress != null) {
    const qual = val(map, at('stress_qualifier'));
    lines.push(`   😟 Stress: <b>${stress}</b>${qual ? ` (${qual})` : ''}`);
  }

  if (!lines.length) return { ok: false, output: 'No usable Garmin metrics.' };

  return { ok: true, text: lines.join('\n') };
}
