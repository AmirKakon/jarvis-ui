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

/**
 * Fetch the full forecast array (not just the first entry) for an entity.
 * @param {string} entityId
 * @param {'daily'|'hourly'} type
 * @returns {Promise<Array>} forecast entries (possibly empty)
 */
async function fetchForecast(entityId, type = 'daily') {
  // HA 2023.9+: forecast must be requested via a service call with return_response.
  const res = await fetchHA(
    `services/weather/get_forecasts?return_response`,
    'POST',
    { entity_id: entityId, type }
  );
  if (res.ok) {
    const forecast = res.data?.service_response?.[entityId]?.forecast;
    if (Array.isArray(forecast) && forecast.length) return forecast;
  }

  // Fallback for older HA versions that still expose forecast as an attribute.
  const state = await fetchHA(`states/${entityId}`);
  const legacy = state.ok ? state.data?.attributes?.forecast : null;
  if (Array.isArray(legacy) && legacy.length) return legacy;

  return [];
}

/**
 * Get structured current weather + multi-day forecast from Home Assistant.
 * Best-effort: returns { ok: false } if HA or a weather entity is unavailable.
 * @returns {Promise<{ ok: boolean, entity?: string, current?: object, forecast?: Array, output?: string }>}
 */
export async function getWeatherData() {
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

  const forecastRaw = await fetchForecast(entityId, 'daily');
  const forecast = forecastRaw.map((f) => ({
    date: f.datetime,
    condition: f.condition,
    high: f.temperature,
    low: f.templow,
    precipitation: f.precipitation,
    precipitationProbability: f.precipitation_probability,
    wind: f.wind_speed,
    humidity: f.humidity,
  }));

  return {
    ok: true,
    entity: entityId,
    current: {
      condition,
      emoji: CONDITION_EMOJI[condition] || '🌡️',
      temp: attrs.temperature,
      unit,
      humidity: attrs.humidity,
      wind: attrs.wind_speed,
      windUnit: attrs.wind_speed_unit || 'km/h',
    },
    forecast,
  };
}

/**
 * Get the current weather + today's forecast from Home Assistant.
 * Kept for the morning briefing; shaped like the original flat return.
 */
export async function getWeather() {
  const data = await getWeatherData();
  if (!data.ok) return { ok: false, output: data.output };

  const { current, forecast, entity } = data;
  const today = forecast[0] || {};

  return {
    ok: true,
    entity,
    condition: current.condition,
    emoji: current.emoji,
    temp: current.temp,
    unit: current.unit,
    humidity: current.humidity,
    wind: current.wind,
    windUnit: current.windUnit,
    high: today.high,
    low: today.low,
    forecastCondition: today.condition,
  };
}

/**
 * Render the current weather as Telegram HTML lines. Returns { ok, text }.
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

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayLabel(dateStr, index) {
  if (!dateStr) return `Day ${index + 1}`;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return `Day ${index + 1}`;
  if (index === 0) return 'Today';
  if (index === 1) return 'Tomorrow';
  return `${WEEKDAY[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
}

/**
 * Format current + multi-day forecast as a Telegram HTML block (no LLM).
 * @param {object} data result of getWeatherData()
 * @param {number} days number of forecast days to include
 */
export function formatForecast(data, days = 5) {
  const { current, forecast } = data;
  const lines = [];

  lines.push(`${current.emoji} <b>${prettyCondition(current.condition)}</b> — Jerusalem`);
  if (current.temp != null) {
    const extras = [];
    if (current.humidity != null) extras.push(`💧 ${current.humidity}%`);
    if (current.wind != null) extras.push(`💨 ${Math.round(current.wind)} ${current.windUnit}`);
    lines.push(`   Now ${Math.round(current.temp)}${current.unit}${extras.length ? '   ' + extras.join('   ') : ''}`);
  }

  const upcoming = (forecast || []).slice(0, days);
  if (upcoming.length) {
    lines.push('');
    lines.push('<b>Forecast</b>');
    for (let i = 0; i < upcoming.length; i++) {
      const f = upcoming[i];
      const emoji = CONDITION_EMOJI[f.condition] || '🌡️';
      const hi = f.high != null ? `↑${Math.round(f.high)}°` : '';
      const lo = f.low != null ? `↓${Math.round(f.low)}°` : '';
      const temps = [hi, lo].filter(Boolean).join(' ');
      const rain = f.precipitationProbability != null ? `  🌧️ ${Math.round(f.precipitationProbability)}%` : '';
      lines.push(`${emoji} <b>${dayLabel(f.date, i)}</b>  ${temps}${rain}`);
    }
  }

  return lines.join('\n');
}

const WEATHER_QUERY_SYSTEM = `You are a concise weather assistant for Jerusalem, Israel. Answer the user's question using ONLY the Home Assistant weather data provided (current conditions + daily forecast). Be brief and direct. Use British English and metric units. If the question asks about a time or place not covered by the data, say so plainly rather than guessing.`;

/**
 * Answer a natural-language weather question over HA data.
 * - Empty/generic question → fast path (formatted forecast, no LLM).
 * - Otherwise → Haiku answers over the current+forecast JSON.
 * @param {string} question
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
export async function runWeatherQuery(question) {
  const data = await getWeatherData();
  if (!data.ok) {
    return { ok: false, output: data.output || 'Weather data is unavailable.' };
  }

  const q = (question || '').trim();
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Fast path: no specific question, or no key to run the LLM.
  if (!q || !apiKey) {
    return { ok: true, output: formatForecast(data) };
  }

  const context = JSON.stringify({
    location: 'Jerusalem, Israel',
    now: new Date().toISOString(),
    current: data.current,
    forecast: data.forecast,
  });

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
        max_tokens: 512,
        system: WEATHER_QUERY_SYSTEM,
        messages: [{
          role: 'user',
          content: `Weather data (JSON):\n${context}\n\nQuestion: ${q}`,
        }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[weather] API error ${res.status}: ${errBody.slice(0, 300)}`);
      // Degrade gracefully to the formatted forecast.
      return { ok: true, output: formatForecast(data) };
    }

    const dataJson = await res.json();
    const text = (dataJson.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    return { ok: true, output: text || formatForecast(data) };
  } catch (err) {
    console.error('[weather] query failed:', err.message);
    return { ok: true, output: formatForecast(data) };
  }
}
