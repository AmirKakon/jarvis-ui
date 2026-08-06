#!/usr/bin/env node
/**
 * Commute bus monitor — curlbus (MOT SIRI-SM) → Home Assistant sensors only.
 *
 * Data: GET https://curlbus.app/<stop_code>  Accept: application/json
 *
 * Weekdays Sun–Thu (Asia/Jerusalem), all day:
 *   616 Metropoline — leaving (home→work) + returning (work→home)
 *   65  Extra       — leaving (home→train) + returning (train→home)
 *
 * Both directions are fetched every run. HA UI can toggle which to show.
 * Notifications (Alexa / phone) are disabled.
 *
 * Sensors per line + direction:
 *   sensor.bus_{id}_leaving_eta / _leaving_status
 *   sensor.bus_{id}_returning_eta / _returning_status
 *
 * Cron: every minute. Requires HA_URL + HA_TOKEN in ~/jarvis/.env
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HOME || homedir();
const ENV_PATH = join(HOME, 'jarvis/.env');
const LOG_PATH = join(HOME, 'jarvis/logs/bus-monitor.log');
const CURLBUS = 'https://curlbus.app';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'];
const MAX_ETA_MIN = 120;

const ROUTES = [
  {
    id: '616',
    shortName: '616',
    agencyRe: /מטרופולין|Metropoline/i,
    legs: {
      leaving: {
        label: 'home → work',
        boardCode: 39360,
        boardNameEn: 'Merkaz David / Degania Road',
        alightNameEn: 'Kiryat Aryeh Rail / Park and Ride',
        destRe: /קריית אריה|קרית אריה|פתח תקווה|חנה וסע|Kiryat Arye|Petah Tikva|Park & Ride|Park and Ride/i,
      },
      returning: {
        label: 'work → home',
        // TODO: confirm Kiryat Aryeh board stop code
        boardCode: 26749,
        boardNameEn: 'Cinema City / Highway 2',
        alightNameEn: 'Merkaz David / Degania Road',
        destRe: /נתניה|דגניה|רכבת נתניה|Netanya|Degania/i,
      },
    },
  },
  {
    id: '65',
    shortName: '65',
    agencyRe: /אקסטרה|Extra/i,
    legs: {
      leaving: {
        label: 'home → train',
        boardCode: 39358,
        boardNameEn: 'Degania Road / Professor Klausner',
        alightNameEn: 'HaOrezim / HaAmal (train)',
        destRe: /עין התכלת|אורזים|העמל|הארוזים|Tkhelet|Orezim|Amal/i,
      },
      returning: {
        label: 'train → home',
        boardCode: 33004,
        boardNameEn: 'HaOrezim / HaAmal (train)',
        alightNameEn: 'Merkaz David / Degania Road',
        destRe: /פולג|דגניה|מרכז דוד|קלאוזנר|Poleg|Degania|Klausner/i,
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

function destLabel(visit) {
  const name = visit?.static_info?.route?.destination?.name;
  if (!name) return '';
  if (typeof name === 'string') return name;
  return name.EN || name.HE || name.AR || '';
}

function destLabelAll(visit) {
  const name = visit?.static_info?.route?.destination?.name;
  if (!name) return '';
  if (typeof name === 'string') return name;
  return [name.HE, name.EN, name.AR].filter(Boolean).join(' ');
}

function agencyLabel(visit) {
  const a = visit?.static_info?.route?.agency?.name;
  if (!a) return '';
  if (typeof a === 'string') return a;
  return [a.HE, a.EN].filter(Boolean).join(' ');
}

function etaMinutesFrom(etaStr) {
  if (!etaStr) return null;
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

async function nextArrival(route, leg) {
  const data = await curlbusStop(leg.boardCode);
  const visits = data?.visits?.[String(leg.boardCode)] || data?.visits?.[leg.boardCode] || [];
  let best = null;

  for (const v of visits) {
    if (String(v.line_name) !== String(route.shortName)) continue;
    const agency = agencyLabel(v);
    if (route.agencyRe && agency && !route.agencyRe.test(agency)) continue;

    const destAll = destLabelAll(v);
    const destEn = destLabel(v);
    if (leg.destRe && destAll && !leg.destRe.test(destAll)) continue;

    const etaMin = etaMinutesFrom(v.eta);
    if (etaMin == null || etaMin < 0 || etaMin > MAX_ETA_MIN) continue;

    const candidate = {
      etaMin,
      vehicle: v.vehicle_ref || '',
      destination: destEn || String(v.destination_id || ''),
      etaAt: v.eta,
      recordedAt: v.timestamp || data.timestamp || null,
      lineId: v.line_id || v.route_id || null,
      agency,
    };
    if (!best || candidate.etaMin < best.etaMin) best = candidate;
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

function sensorIds(routeId, direction) {
  return {
    eta: `sensor.bus_${routeId}_${direction}_eta`,
    status: `sensor.bus_${routeId}_${direction}_status`,
  };
}

async function setDirectionIdle(env, route, direction, leg, now) {
  const ids = sensorIds(route.id, direction);
  const label = direction === 'leaving' ? 'leaving home' : 'returning home';
  await setSensor(env, ids.eta, 'unknown', {
    friendly_name: `Bus ${route.shortName} ${label} ETA`,
    unit_of_measurement: 'min',
    icon: 'mdi:bus-clock',
    source: 'curlbus',
    direction,
    window: 'weekend',
    jerusalem: `${now.weekday} ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`,
  });
  await setSensor(env, ids.status, 'idle', {
    friendly_name: `Bus ${route.shortName} ${label} status`,
    icon: 'mdi:bus-clock',
    source: 'curlbus',
    direction,
    label: leg.label,
    window: 'weekend',
  });
}

async function processDirection(env, route, direction, leg) {
  const ids = sensorIds(route.id, direction);
  const label = direction === 'leaving' ? 'leaving home' : 'returning home';
  log(`[${route.shortName}/${direction}] ${leg.label} board=${leg.boardCode}`);

  let best = null;
  try {
    const { best: b, visitCount } = await nextArrival(route, leg);
    best = b;
    log(
      `[${route.shortName}/${direction}] curlbus ${leg.boardCode}: ${visitCount} visits` +
        (best ? ` → ETA ${best.etaMin} min` : ' → no matching line'),
    );
  } catch (e) {
    log(`[${route.shortName}/${direction}] curlbus error: ${e.message}`);
  }

  const eta = best?.etaMin ?? null;
  const status = best ? `ETA ${eta} min` : 'no live arrival';

  try {
    await setSensor(env, ids.eta, eta ?? 'unknown', {
      friendly_name: `Bus ${route.shortName} ${label} ETA`,
      unit_of_measurement: 'min',
      icon: 'mdi:bus-clock',
      device_class: 'duration',
      source: 'curlbus',
      direction,
      label: leg.label,
      board_stop: `${leg.boardNameEn} (${leg.boardCode})`,
      alight_stop: leg.alightNameEn || null,
      vehicle: best?.vehicle || null,
      destination: best?.destination || null,
      eta_at: best?.etaAt || null,
      recorded_at: best?.recordedAt || null,
      line_id: best?.lineId || null,
    });
    await setSensor(env, ids.status, status, {
      friendly_name: `Bus ${route.shortName} ${label} status`,
      icon: 'mdi:bus',
      source: 'curlbus',
      direction,
      label: leg.label,
      board_stop_code: leg.boardCode,
    });
  } catch (e) {
    log(`[${route.shortName}/${direction}] HA update failed: ${e.message}`);
    return;
  }

  log(`[${route.shortName}/${direction}] ${status}`);
}

async function main() {
  const env = loadEnv();
  if (!env.HA_TOKEN) {
    log('HA_TOKEN not set — abort');
    process.exit(1);
  }

  const now = jerusalemNow();
  const active = WEEKDAYS.includes(now.weekday);

  for (const route of ROUTES) {
    for (const [direction, leg] of Object.entries(route.legs)) {
      if (!active) {
        try {
          await setDirectionIdle(env, route, direction, leg, now);
        } catch (e) {
          log(`[${route.shortName}/${direction}] idle failed: ${e.message}`);
        }
        continue;
      }
      await processDirection(env, route, direction, leg);
    }
  }
}

main().catch(err => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
