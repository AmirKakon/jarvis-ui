import { getStates } from './ha.js';

const TZ = 'Asia/Jerusalem';
const EMPTY = new Set(['unknown', 'unavailable', 'none', '']);

function val(map, id) {
  const s = map.get(id);
  if (!s) return null;
  const state = s.state;
  if (state == null || EMPTY.has(String(state).toLowerCase())) return null;
  return state;
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

/**
 * Build a Hebrew/Jewish-calendar summary from the HA jewish_calendar integration.
 * Best-effort: returns { ok:false } if the integration isn't present.
 * Accepts an optional pre-fetched states array.
 */
export async function getJewishSummary(states = null) {
  if (process.env.JEWISH_ENABLED === 'false') return { ok: false, output: 'disabled' };

  let data = states;
  if (!data) {
    const res = await getStates();
    if (!res.ok) return { ok: false, output: res.output };
    data = res.data;
  }

  const map = new Map(data.map((s) => [s.entity_id, s]));

  const hebrewDate = val(map, 'sensor.jewish_calendar_date');
  const parsha = val(map, 'sensor.jewish_calendar_parshat_hashavua');
  const holiday = val(map, 'sensor.jewish_calendar_holiday');
  const omer = val(map, 'sensor.jewish_calendar_day_of_the_omer');
  const erevShabbat = map.get('binary_sensor.jewish_calendar_erev_shabbat_hag')?.state === 'on';
  const issurMelacha = map.get('binary_sensor.jewish_calendar_issur_melacha_in_effect')?.state === 'on';

  if (!hebrewDate && !parsha && !holiday) return { ok: false, output: 'No Jewish calendar data.' };

  const lines = [];

  const head = [];
  if (hebrewDate) head.push(hebrewDate);
  if (parsha) head.push(`Parashat ${parsha}`);
  if (head.length) lines.push(`   📜 ${head.join(' · ')}`);

  if (holiday) lines.push(`   🕎 ${holiday}`);

  const omerNum = parseInt(omer, 10);
  if (Number.isFinite(omerNum) && omerNum > 0) lines.push(`   🌾 Omer: day ${omerNum}`);

  if (erevShabbat) {
    const candle = fmtTime(val(map, 'sensor.jewish_calendar_upcoming_shabbat_candle_lighting'));
    if (candle) lines.push(`   🕯️ Candle lighting: <b>${candle}</b>`);
  }

  if (issurMelacha) {
    const havdalah = fmtTime(val(map, 'sensor.jewish_calendar_upcoming_shabbat_havdalah'));
    if (havdalah) lines.push(`   ✨ Havdalah: <b>${havdalah}</b>`);
  }

  if (!lines.length) return { ok: false, output: 'No Jewish calendar data.' };

  return { ok: true, text: lines.join('\n') };
}
