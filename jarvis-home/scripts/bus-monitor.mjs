#!/usr/bin/env node
/**
 * Commute bus monitor — curlbus (MOT SIRI-SM stop board) → HA sensors + alerts.
 *
 * Data: GET https://curlbus.app/<stop_code>  Accept: application/json
 *   (public wrapper; same stop-arrival class as Moovit — not Stride GPS)
 *
 * Routes (Asia/Jerusalem):
 *   TEMP full-day test — before noon = outbound, noon–midnight = return.
 *   Revert windows to 08–09 / 17–18 and drop Thu from 616 when done.
 *   616 Metropoline  Sun/Mon/Wed/Thu
 *     00:00–12:00  home → work   (board 39360)
 *     12:00–24:00  work → home   (board 26749)
 *   65  Extra        Sun/Mon/Wed/Thu
 *     00:00–12:00  home → train  (board 39358)
 *     12:00–24:00  train → home  (board 33004)
 *
 * Updates HA sensors; when ETA ≤ 10 min announces on Echo Dot + Amir's phone
 * (debounced per line/vehicle/window).
 *
 * Cron: every minute (no-ops outside windows). Requires HA_URL + HA_TOKEN in ~/jarvis/.env
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HOME || homedir();
const ENV_PATH = join(HOME, 'jarvis/.env');
const STATE_PATH = join(HOME, 'jarvis/state/bus-monitor.json');
const LOG_PATH = join(HOME, 'jarvis/logs/bus-monitor.log');
const CURLBUS = 'https://curlbus.app';

const ETA_ANNOUNCE_MIN = 10;
const MAX_ETA_MIN = 120;

/** @type {Array<{
 *  id: string, shortName: string,
 *  days: string[], morning: [number, number], evening: [number, number],
 *  legs: Record<string, object>
 * }>} */
const ROUTES = [
  {
    id: '616',
    shortName: '616',
    days: ['Sun', 'Mon', 'Wed', 'Thu'], // TEMP: Thu for testing — drop Thu after
    morning: [0, 12 * 60], // TEMP full-day test
    evening: [12 * 60, 24 * 60], // TEMP full-day test
    legs: {
      to_work: {
        label: 'home → work',
        boardCode: 39360,
        boardName: 'מרכז דוד/דרך דגניה',
        alightCode: 26966,
        alightName: 'סינמה סיטי/כביש 2',
        destRe: /תל אביב|סינמה|הרצליה|יפו|קומה 6|פתח תקווה|קריית אריה|קרית אריה/,
      },
      from_work: {
        label: 'work → home',
        boardCode: 26749,
        boardName: 'סינמה סיטי/כביש 2',
        alightCode: 39525,
        alightName: 'האוניברסיטה/דרך דגניה',
        destRe: /נתניה|דגניה|אוניברסיט|רכבת נתניה/,
      },
    },
  },
  {
    id: '65',
    shortName: '65',
    days: ['Sun', 'Mon', 'Wed', 'Thu'],
    morning: [0, 12 * 60], // TEMP full-day test
    evening: [12 * 60, 24 * 60], // TEMP full-day test
    legs: {
      to_train: {
        label: 'home → train',
        boardCode: 39358,
        boardName: 'דרך דגניה/פרופסור יוסף קלאוזנר',
        alightCode: 39427,
        alightName: 'האורזים/העמל',
        destRe: /עין התכלת|אורזים|העמל|הארוזים/,
      },
      from_train: {
        label: 'train → home',
        boardCode: 33004,
        boardName: 'האורזים/העמל',
        alightCode: 39360,
        alightName: 'מרכז דוד/דרך דגניה',
        destRe: /פולג|דגניה|מרכז דוד|קלאוזנר/,
      },
    },
  },
];

function loadEnv() {
  const out = { ...process.env };
  if (!existsSync(ENV_PATH)) return out;
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    mkdirSync(join(HOME, 'jarvis/logs'), { recursive: true });
    writeFileSync(LOG_PATH, line + '\n', { flag: 'a' });
  } catch { /* ignore */ }
  console.log(line);
}

function jerusalemNow() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  const weekday = parts.weekday;
  const hour = parseInt(parts.hour, 10);
  const minute = parseInt(parts.minute, 10);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { weekday, hour, minute, date, minutesOfDay: hour * 60 + minute };
}

function activeLeg(route, now) {
  if (!route.days.includes(now.weekday)) return null;
  const [m0, m1] = route.morning;
  const [e0, e1] = route.evening;
  const morningKey = Object.keys(route.legs).find(k => k.startsWith('to_'));
  const eveningKey = Object.keys(route.legs).find(k => k.startsWith('from_'));
  if (now.minutesOfDay >= m0 && now.minutesOfDay < m1 && morningKey) {
    return { key: morningKey, ...route.legs[morningKey] };
  }
  if (now.minutesOfDay >= e0 && now.minutesOfDay < e1 && eveningKey) {
    return { key: eveningKey, ...route.legs[eveningKey] };
  }
  return null;
}

function destLabel(visit) {
  const name = visit?.static_info?.route?.destination?.name;
  if (!name) return '';
  if (typeof name === 'string') return name;
  return [name.HE, name.EN, name.AR].filter(Boolean).join(' ');
}

function etaMinutesFrom(etaStr) {
  if (!etaStr) return null;
  // "2026-08-06 09:52:00+03:00"
  const d = new Date(String(etaStr).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - Date.now()) / 60000);
}

async function curlbusStop(stopCode) {
  const res = await fetch(`${CURLBUS}/${stopCode}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`curlbus ${stopCode} ${res.status}`);
  return res.json();
}

/**
 * Next arrival for shortName at board stop, optionally filtered by destination regex.
 */
async function nextArrival(shortName, leg) {
  const data = await curlbusStop(leg.boardCode);
  const visits = data?.visits?.[String(leg.boardCode)] || data?.visits?.[leg.boardCode] || [];
  let best = null;

  for (const v of visits) {
    if (String(v.line_name) !== String(shortName)) continue;
    const dest = destLabel(v);
    if (leg.destRe && dest && !leg.destRe.test(dest)) continue;

    const etaMin = etaMinutesFrom(v.eta);
    if (etaMin == null || etaMin < 0 || etaMin > MAX_ETA_MIN) continue;

    const candidate = {
      etaMin,
      vehicle: v.vehicle_ref || '',
      destination: dest || String(v.destination_id || ''),
      etaAt: v.eta,
      recordedAt: v.timestamp || data.timestamp || null,
      lineId: v.line_id || v.route_id || null,
      lat: v.location?.lat != null ? Number(v.location.lat) : null,
      lon: v.location?.lon != null ? Number(v.location.lon) : null,
      producer: v.producer || null,
    };
    if (!best || candidate.etaMin < best.etaMin) best = candidate;
  }

  // If dest filter wiped everything, retry line-only (better than empty; log it)
  if (!best && leg.destRe) {
    for (const v of visits) {
      if (String(v.line_name) !== String(shortName)) continue;
      const etaMin = etaMinutesFrom(v.eta);
      if (etaMin == null || etaMin < 0 || etaMin > MAX_ETA_MIN) continue;
      const dest = destLabel(v);
      const candidate = {
        etaMin,
        vehicle: v.vehicle_ref || '',
        destination: dest || String(v.destination_id || ''),
        etaAt: v.eta,
        recordedAt: v.timestamp || data.timestamp || null,
        lineId: v.line_id || v.route_id || null,
        lat: v.location?.lat != null ? Number(v.location.lat) : null,
        lon: v.location?.lon != null ? Number(v.location.lon) : null,
        producer: v.producer || null,
        destFilterSkipped: true,
      };
      if (!best || candidate.etaMin < best.etaMin) best = candidate;
    }
  }

  return { best, visitCount: visits.length };
}

async function haCall(env, method, path, body) {
  const base = (env.HA_URL || 'http://192.168.68.113:8123').replace(/\/$/, '');
  const token = env.HA_TOKEN;
  if (!token) throw new Error('HA_TOKEN not set');
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HA ${path} ${res.status} ${t.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function setSensor(env, entityId, state, attributes = {}) {
  return haCall(env, 'POST', `/api/states/${entityId}`, {
    state: state === null || state === undefined ? 'unknown' : String(state),
    attributes: {
      friendly_name: attributes.friendly_name || entityId,
      ...attributes,
    },
  });
}

async function notifyAll(env, title, message) {
  await haCall(env, 'POST', '/api/services/notify/mobile_app_amir_phone', {
    title,
    message,
  });
  await haCall(env, 'POST', '/api/services/notify/alexa_media_alines_echo_dot', {
    message,
    data: { type: 'announce' },
  });
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { announced: {} };
  }
}

function saveState(state) {
  mkdirSync(join(HOME, 'jarvis/state'), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function sensorIds(routeId) {
  return {
    eta: `sensor.bus_${routeId}_eta`,
    status: `sensor.bus_${routeId}_status`,
    leg: `sensor.bus_${routeId}_leg`,
  };
}

async function setIdle(env, route, now) {
  const ids = sensorIds(route.id);
  await setSensor(env, ids.status, 'idle', {
    friendly_name: `Bus ${route.shortName} status`,
    icon: 'mdi:bus-clock',
    window: 'outside',
    source: 'curlbus',
    jerusalem: `${now.weekday} ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`,
  });
}

async function processRoute(env, route, leg, now, state) {
  const ids = sensorIds(route.id);
  log(`[${route.shortName}] Active leg ${leg.key} (${leg.label}) board=${leg.boardCode}`);

  let best = null;
  try {
    const { best: b, visitCount } = await nextArrival(route.shortName, leg);
    best = b;
    log(
      `[${route.shortName}] curlbus stop ${leg.boardCode}: ${visitCount} visits` +
        (best
          ? ` → ETA ${best.etaMin}m dest=${best.destination}${best.destFilterSkipped ? ' (dest filter skipped)' : ''}`
          : ' → no matching line'),
    );
  } catch (e) {
    log(`[${route.shortName}] curlbus error: ${e.message}`);
  }

  const eta = best?.etaMin ?? null;
  const status = best
    ? `ETA ${eta} min · ${best.destination || '—'} · veh ${best.vehicle || '?'}`
    : 'no live arrival';

  try {
    await setSensor(env, ids.eta, eta ?? 'unknown', {
      friendly_name: `Bus ${route.shortName} ETA (min)`,
      unit_of_measurement: 'min',
      icon: 'mdi:bus-clock',
      device_class: 'duration',
      source: 'curlbus',
      leg: leg.key,
      leg_label: leg.label,
      board_stop: `${leg.boardName} (${leg.boardCode})`,
      alight_stop: `${leg.alightName} (${leg.alightCode})`,
      vehicle: best?.vehicle || null,
      destination: best?.destination || null,
      eta_at: best?.etaAt || null,
      recorded_at: best?.recordedAt || null,
      line_id: best?.lineId || null,
    });
    await setSensor(env, ids.status, status, {
      friendly_name: `Bus ${route.shortName} status`,
      icon: 'mdi:bus',
      source: 'curlbus',
      leg: leg.key,
      board_stop_code: leg.boardCode,
    });
    await setSensor(env, ids.leg, leg.key, {
      friendly_name: `Bus ${route.shortName} active leg`,
      icon: 'mdi:routes',
      label: leg.label,
    });
  } catch (e) {
    log(`[${route.shortName}] HA sensor update failed: ${e.message}`);
    return;
  }

  log(`[${route.shortName}] ${status}`);

  if (eta != null && eta <= ETA_ANNOUNCE_MIN) {
    const dedupeKey = `${now.date}:${route.id}:${leg.key}:${best.vehicle || best.etaAt || 'unknown'}`;
    if (!state.announced[dedupeKey]) {
      const title = `🚌 קו ${route.shortName}`;
      const message = `קו ${route.shortName} בעוד כ־${eta} דקות מ${leg.boardName}. יעד: ${leg.alightName}.`;
      try {
        await notifyAll(env, title, message);
        state.announced[dedupeKey] = new Date().toISOString();
        log(`[${route.shortName}] Announced ${dedupeKey}`);
      } catch (e) {
        log(`[${route.shortName}] Notify failed: ${e.message}`);
      }
    }
  }
}

async function main() {
  const env = loadEnv();
  const now = jerusalemNow();
  const state = loadState();
  let anyActive = false;

  for (const route of ROUTES) {
    const leg = activeLeg(route, now);
    if (!leg) {
      if (env.HA_TOKEN) {
        try {
          await setIdle(env, route, now);
        } catch (e) {
          log(`[${route.shortName}] idle HA update failed: ${e.message}`);
        }
      }
      continue;
    }
    anyActive = true;
    await processRoute(env, route, leg, now, state);
  }

  if (anyActive) {
    for (const k of Object.keys(state.announced)) {
      if (!k.startsWith(now.date)) delete state.announced[k];
    }
    saveState(state);
  }
}

main().catch(err => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
