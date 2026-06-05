import { fetchHA } from './ha.js';

// Home Assistant standard weather conditions → emoji
const CONDITION_EMOJI = {
  'clear-night': '🌙',
  cloudy: '☁️',
  fog: '🌫️',
  hail: '🌨️',
  lightning: '⛈️',
  'lightning-rainy': '⛈️',
  partlycloudy: '⛅',
  pouring: '🌧️',
  rainy: '🌧️',
  snowy: '❄️',
  'snowy-rainy': '🌨️',
  sunny: '☀️',
  windy: '💨',
  'windy-variant': '💨',
  exceptional: '⚠️',
};

function prettyCondition(condition) {
  if (!condition) return 'Unknown';
  return condition.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

let cachedEntity = null;

async function resolveWeatherEntity() {
  if (process.env.WEATHER_ENTITY) return process.env.WEATHER_ENTITY;
  if (cachedEntity) return cachedEntity;

  const states = await fetchHA('states');
  if (!states.ok) return null;

  const weatherEntities = states.data.filter((s) => s.entity_id.startsWith('weather.'));
  if (!weatherEntities.length) return null;

  // Prefer an entity that is actually reporting a condition.
  const usable = weatherEntities.find((s) => s.state && s.state !== 'unavailable' && s.state !== 'unknown')
    || weatherEntities[0];

  cachedEntity = usable.entity_id;
  return cachedEntity;
}

async function fetchDailyForecast(entityId) {
  // HA 2023.9+: forecast must be requested via a service call with return_response.
  const res = await fetchHA(
    'services/weather/get_forecasts?return_response',
    'POST',
    { entity_id: entityId, type: 'daily' }
  );
  if (res.ok) {
    const forecast = res.data?.service_response?.[entityId]?.forecast;
    if (Array.isArray(forecast) && forecast.length) return forecast[0];
  }

  // Fallback for older HA versions that still expose forecast as an attribute.
  const state = await fetchHA(`states/${entityId}`);
  const legacy = state.ok ? state.data?.attributes?.forecast : null;
  if (Array.isArray(legacy) && legacy.length) return legacy[0];

  return null;
}

/**
 * Get the current weather + today's forecast from Home Assistant.
 * Best-effort: returns { ok: false } if HA or a weather entity is unavailable,
 * so the morning briefing can simply skip the section.
 */
export async function getWeather() {
  const entityId = await resolveWeatherEntity();
  if (!entityId) {
    return { ok: false, output: 'No Home Assistant weather entity found.' };
  }

  const state = await fetchHA(`states/${entityId}`);
  if (!state.ok) {
    return { ok: false, output: state.output };
  }

  const attrs = state.data.attributes || {};
  const condition = state.data.state;
  const unit = attrs.temperature_unit || '°C';

  const today = await fetchDailyForecast(entityId);

  return {
    ok: true,
    entity: entityId,
    condition,
    emoji: CONDITION_EMOJI[condition] || '🌡️',
    temp: attrs.temperature,
    unit,
    humidity: attrs.humidity,
    wind: attrs.wind_speed,
    windUnit: attrs.wind_speed_unit || 'km/h',
    high: today?.temperature,
    low: today?.templow,
    forecastCondition: today?.condition,
  };
}

/**
 * Render the weather as Telegram HTML lines. Returns { ok, text }.
 */
export async function getWeatherSummary() {
  const w = await getWeather();
  if (!w.ok) return { ok: false, output: w.output };

  const parts = [];
  parts.push(`${w.emoji} <b>${prettyCondition(w.condition)}</b>`);

  if (w.temp != null) {
    let line = `   ${Math.round(w.temp)}${w.unit}`;
    if (w.high != null || w.low != null) {
      const hi = w.high != null ? `↑${Math.round(w.high)}°` : '';
      const lo = w.low != null ? `↓${Math.round(w.low)}°` : '';
      line += ` (${[hi, lo].filter(Boolean).join(' ')})`;
    }
    parts.push(line);
  }

  const extras = [];
  if (w.humidity != null) extras.push(`💧 ${w.humidity}%`);
  if (w.wind != null) extras.push(`💨 ${Math.round(w.wind)} ${w.windUnit}`);
  if (extras.length) parts.push(`   ${extras.join('   ')}`);

  return { ok: true, text: parts.join('\n') };
}
