import { fetchHA } from './ha.js';

/**
 * Commute bus Q&A — reads HA sensors written by scripts/bus-monitor.mjs (curlbus).
 * Same numbers as the Lovelace dashboard. No Alexa/notify from here.
 */

const LINES = {
  '616': {
    label: '616 (Metropoline)',
    leaving: {
      eta: 'sensor.bus_616_leaving_eta',
      status: 'sensor.bus_616_leaving_status',
      toward: 'Kiryat Aryeh',
    },
    returning: {
      eta: 'sensor.bus_616_returning_eta',
      status: 'sensor.bus_616_returning_status',
      toward: 'home / Degania',
    },
  },
  '65': {
    label: '65 (Extra)',
    leaving: {
      eta: 'sensor.bus_65_leaving_eta',
      status: 'sensor.bus_65_leaving_status',
      toward: 'the train (HaOrezim)',
    },
    returning: {
      eta: 'sensor.bus_65_returning_eta',
      status: 'sensor.bus_65_returning_status',
      toward: 'home / Degania',
    },
  },
};

const DIRECTION_HELPER = 'input_boolean.bus_leaving_home';

async function getEntity(entityId) {
  const res = await fetchHA(`states/${entityId}`);
  if (!res.ok) return null;
  return res.data;
}

function parseDirection(question, helperState) {
  const q = (question || '').toLowerCase();
  if (/\b(leav(e|ing)|outbound|to work|to the train|to train|going to work)\b/.test(q)) {
    return 'leaving';
  }
  if (/\b(return|returning|homebound|coming home|on (my|the) way home|from work|from (the )?train)\b/.test(q)) {
    return 'returning';
  }
  if (helperState === 'on') return 'leaving';
  if (helperState === 'off') return 'returning';
  return 'both';
}

function parseLines(question) {
  const q = (question || '').toLowerCase();
  const lines = [];
  if (/\b616\b/.test(q) || /\bwork\b/.test(q) || /\bkiryat|aryeh|petah\b/.test(q)) lines.push('616');
  if (/\b65\b/.test(q) || /\btrain\b/.test(q)) lines.push('65');
  if (!lines.length) return ['616', '65'];
  return [...new Set(lines)];
}

function formatEta(state) {
  if (!state) return { text: 'unavailable', minutes: null };
  const raw = state.state;
  if (raw == null || raw === 'unknown' || raw === 'unavailable') {
    return { text: 'unknown', minutes: null };
  }
  const n = Number(raw);
  if (Number.isFinite(n)) {
    if (n <= 0) return { text: 'due now', minutes: n };
    if (n === 1) return { text: '1 minute', minutes: 1 };
    return { text: `${n} minutes`, minutes: n };
  }
  return { text: String(raw), minutes: null };
}

function formatLineDirection(lineId, direction, etaEnt, statusEnt) {
  const meta = LINES[lineId][direction];
  const eta = formatEta(etaEnt);
  const status = statusEnt?.state;
  const dirLabel = direction === 'leaving' ? 'leaving home' : 'returning home';

  if (status === 'idle') {
    return `• <b>${LINES[lineId].label}</b> (${dirLabel} → ${meta.toward}): idle (outside weekday window)`;
  }
  if (eta.minutes == null && (status === 'no live arrival' || !etaEnt)) {
    return `• <b>${LINES[lineId].label}</b> (${dirLabel} → ${meta.toward}): no live arrival`;
  }
  return `• <b>${LINES[lineId].label}</b> (${dirLabel} → ${meta.toward}): <b>${eta.text}</b>`;
}

/**
 * Fetch commute bus snapshot from HA sensors.
 * @returns {Promise<{ ok: boolean, helper?: string|null, lines?: object, output?: string }>}
 */
export async function getBusData() {
  const entityIds = [DIRECTION_HELPER];
  for (const line of Object.values(LINES)) {
    for (const dir of ['leaving', 'returning']) {
      entityIds.push(line[dir].eta, line[dir].status);
    }
  }

  const results = await Promise.all(entityIds.map((id) => getEntity(id)));
  const byId = {};
  entityIds.forEach((id, i) => {
    byId[id] = results[i];
  });

  const any = Object.values(byId).some((e) => e && e.entity_id?.startsWith('sensor.bus_'));
  if (!any) {
    return {
      ok: false,
      output: 'No bus sensors found in Home Assistant yet. Is bus-monitor cron running on the mini-pc?',
    };
  }

  const helper = byId[DIRECTION_HELPER]?.state ?? null;
  const lines = {};
  for (const [id, line] of Object.entries(LINES)) {
    lines[id] = {
      leaving: {
        eta: byId[line.leaving.eta],
        status: byId[line.leaving.status],
      },
      returning: {
        eta: byId[line.returning.eta],
        status: byId[line.returning.status],
      },
    };
  }

  return { ok: true, helper, lines };
}

/**
 * Natural-language bus ETA answer for Telegram / Assist (via askCore).
 * @param {string} [question]
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
export async function runBusQuery(question = '') {
  const data = await getBusData();
  if (!data.ok) return { ok: false, output: data.output };

  const direction = parseDirection(question, data.helper);
  const lineIds = parseLines(question);
  const directions = direction === 'both' ? ['leaving', 'returning'] : [direction];

  const lines = [];
  lines.push('<b>Next buses</b>');
  if (data.helper === 'on' || data.helper === 'off') {
    lines.push(
      data.helper === 'on'
        ? '<i>Dashboard toggle: leaving home</i>'
        : '<i>Dashboard toggle: returning home</i>',
    );
  }
  lines.push('');

  for (const lineId of lineIds) {
    for (const dir of directions) {
      const pack = data.lines[lineId][dir];
      lines.push(formatLineDirection(lineId, dir, pack.eta, pack.status));
    }
  }

  // Plain-English one-liner for the soonest matching bus (Assist-friendly)
  let soonest = null;
  for (const lineId of lineIds) {
    for (const dir of directions) {
      const pack = data.lines[lineId][dir];
      const eta = formatEta(pack.eta);
      if (eta.minutes == null) continue;
      if (!soonest || eta.minutes < soonest.minutes) {
        soonest = {
          minutes: eta.minutes,
          text: eta.text,
          line: LINES[lineId].label,
          dir: dir === 'leaving' ? 'leaving home' : 'returning home',
          toward: LINES[lineId][dir].toward,
        };
      }
    }
  }

  if (soonest) {
    lines.push('');
    lines.push(
      `Soonest: <b>${soonest.line}</b> ${soonest.dir} in <b>${soonest.text}</b> (toward ${soonest.toward}).`,
    );
  } else if (direction !== 'both' || lineIds.length === 1) {
    lines.push('');
    lines.push('No live arrival for that selection right now, Sir.');
  }

  return { ok: true, output: lines.join('\n') };
}
