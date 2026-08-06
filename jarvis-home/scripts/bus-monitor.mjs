#!/usr/bin/env node
/**
 * Commute bus monitor — Open Bus Stride → Home Assistant sensors + alerts.
 *
 * Routes (Asia/Jerusalem):
 *   608 Metropoline  Sun/Mon/Wed/Thu  # TEMP: Thu for testing; drop Thu after
 *     08:00–09:00  home → work   (board 39360)
 *     17:00–18:00  work → home   (board 26749)
 *   65  Extra        Sun/Mon/Wed/Thu
 *     08:00–09:00  home → train  (board 39358)
 *     17:00–18:00  train → home  (board 33004)
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
const STRIDE = 'https://open-bus-stride-api.hasadna.org.il';

const ETA_ANNOUNCE_MIN = 10;

/** @type {Array<{
 *  id: string, shortName: string, agencyRe: RegExp, longNameRe?: RegExp,
 *  days: string[], morning: [number, number], evening: [number, number],
 *  legs: Record<string, object>
 * }>} */
const ROUTES = [
  {
    id: '608',
    shortName: '608',
    agencyRe: /מטרופולין/,
    days: ['Sun', 'Mon', 'Wed', 'Thu'], // TEMP: Thu for testing — drop Thu after
    morning: [8 * 60, 9 * 60],
    evening: [17 * 60, 18 * 60],
    legs: {
      to_work: {
        label: 'home → work',
        boardCode: 39360,
        boardName: 'מרכז דוד/דרך דגניה',
        alightCode: 26966,
        alightName: 'סינמה סיטי/כביש 2',
        direction: '1',
        stop: { lat: 32.308448, lon: 34.874746 },
      },
      from_work: {
        label: 'work → home',
        boardCode: 26749,
        boardName: 'סינמה סיטי/כביש 2',
        alightCode: 39525,
        alightName: 'האוניברסיטה/דרך דגניה',
        direction: '2',
        stop: { lat: 32.148067, lon: 34.803856 },
      },
    },
  },
  {
    id: '65',
    shortName: '65',
    agencyRe: /אקסטרה/,
    longNameRe: /נתניה/,
    days: ['Sun', 'Mon', 'Wed', 'Thu'],
    morning: [8 * 60, 9 * 60],
    evening: [17 * 60, 18 * 60],
    legs: {
      to_train: {
        label: 'home → train',
        boardCode: 39358,
        boardName: 'דרך דגניה/פרופסור יוסף קלאוזנר',
        alightCode: 39427,
        alightName: 'האורזים/העמל',
        // Extra 65 dir 2: south → north (home → station / עין התכלת)
        direction: '2',
        stop: { lat: 32.307437, lon: 34.874793 },
      },
      from_train: {
        label: 'train → home',
        boardCode: 33004,
        boardName: 'האורזים/העמל',
        alightCode: 39360,
        alightName: 'מרכז דוד/דרך דגניה',
        // Extra 65 dir 1: north → south (station → home / פולג)
        direction: '1',
        stop: { lat: 32.319489, lon: 34.871658 },
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
  const weekday = parts.weekday; // Sun, Mon, …
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

async function strideGet(path, params = {}) {
  const url = new URL(STRIDE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Stride ${path} ${res.status}`);
  return res.json();
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Shift a YYYY-MM-DD string by delta days (UTC calendar). */
function addDays(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

/**
 * Resolve GTFS line_refs for short name + direction.
 * Stride often lags publishing today's GTFS date — walk back up to 7 days.
 */
async function resolveLineRefs(route, date, direction) {
  for (let back = 0; back <= 7; back++) {
    const day = addDays(date, -back);
    const routes = await strideGet('/gtfs_routes/list', {
      route_short_name: route.shortName,
      date_from: day,
      date_to: day,
      limit: 100,
    });
    const matches = (routes || []).filter(r => {
      if (String(r.route_direction) !== String(direction)) return false;
      if (route.agencyRe && !route.agencyRe.test(r.agency_name || '')) return false;
      if (route.longNameRe && !route.longNameRe.test(r.route_long_name || '')) return false;
      return true;
    });
    if (!matches.length) continue;
    const refs = [...new Set(matches.map(r => r.line_ref).filter(Boolean))];
    return { refs, agency: matches[0]?.agency_name || '', gtfsDate: day };
  }
  return { refs: [], agency: '', gtfsDate: null };
}

async function nearestEta(lineRefs, stop) {
  if (!lineRefs.length) return null;
  const to = new Date();
  const from = new Date(to.getTime() - 12 * 60 * 1000);
  const iso = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

  let best = null;
  for (const lineRef of lineRefs) {
    const locs = await strideGet('/siri_vehicle_locations/list', {
      siri_routes__line_ref: lineRef,
      recorded_at_time_from: iso(from),
      recorded_at_time_to: iso(to),
      order_by: 'recorded_at_time desc',
      limit: 40,
    });
    const byVehicle = new Map();
    for (const loc of locs || []) {
      const v = loc.siri_ride__vehicle_ref || loc.id;
      if (!byVehicle.has(v)) byVehicle.set(v, loc);
    }
    for (const loc of byVehicle.values()) {
      if (loc.lat == null || loc.lon == null) continue;
      const dist = haversineKm({ lat: loc.lat, lon: loc.lon }, stop);
      if (dist > 45) continue;
      let speedKmh = Number(loc.velocity) || 0;
      if (speedKmh > 0 && speedKmh < 3) speedKmh *= 3.6;
      if (speedKmh < 12) speedKmh = 28;
      if (speedKmh > 90) speedKmh = 50;
      const etaMin = Math.max(1, Math.round((dist / speedKmh) * 60));
      const candidate = {
        etaMin,
        distKm: Math.round(dist * 10) / 10,
        vehicle: loc.siri_ride__vehicle_ref || String(loc.siri_ride__id || ''),
        lineRef,
        recordedAt: loc.recorded_at_time,
        lat: loc.lat,
        lon: loc.lon,
      };
      if (!best || candidate.etaMin < best.etaMin) best = candidate;
    }
  }
  return best;
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
    jerusalem: `${now.weekday} ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`,
  });
}

async function processRoute(env, route, leg, now, state) {
  const ids = sensorIds(route.id);
  log(`[${route.shortName}] Active leg ${leg.key} (${leg.label})`);

  let best = null;
  let lineRefs = [];
  try {
    const resolved = await resolveLineRefs(route, now.date, leg.direction);
    lineRefs = resolved.refs;
    const gtfsNote = resolved.gtfsDate && resolved.gtfsDate !== now.date
      ? ` (gtfs ${resolved.gtfsDate}; today empty)`
      : resolved.gtfsDate
        ? ` (gtfs ${resolved.gtfsDate})`
        : '';
    log(`[${route.shortName}] line_refs dir=${leg.direction}: ${lineRefs.join(',') || '(none)'}${gtfsNote}`);
    best = await nearestEta(lineRefs, leg.stop);
  } catch (e) {
    log(`[${route.shortName}] Stride error: ${e.message}`);
  }

  const eta = best?.etaMin ?? null;
  const status = best
    ? `ETA ${eta} min · ${best.distKm} km · veh ${best.vehicle}`
    : 'no live vehicle';

  try {
    await setSensor(env, ids.eta, eta ?? 'unknown', {
      friendly_name: `Bus ${route.shortName} ETA (min)`,
      unit_of_measurement: 'min',
      icon: 'mdi:bus-clock',
      device_class: 'duration',
      leg: leg.key,
      leg_label: leg.label,
      board_stop: `${leg.boardName} (${leg.boardCode})`,
      alight_stop: `${leg.alightName} (${leg.alightCode})`,
      vehicle: best?.vehicle || null,
      distance_km: best?.distKm ?? null,
      line_refs: lineRefs.join(','),
      recorded_at: best?.recordedAt || null,
    });
    await setSensor(env, ids.status, status, {
      friendly_name: `Bus ${route.shortName} status`,
      icon: 'mdi:bus',
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
    const dedupeKey = `${now.date}:${route.id}:${leg.key}:${best.vehicle || 'unknown'}`;
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
