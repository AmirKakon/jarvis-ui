import { haikuModel, quickCallOptions } from '../models.js';
import { responseText } from './shared.js';

const CONTROLLABLE_DOMAINS = ['light', 'switch', 'fan', 'cover', 'climate', 'media_player', 'scene', 'script'];
// Shown to the resolver as read-only context, e.g. input_select.livingroom_ac_mode
// holds the AC's real mode while the scripts that drive it always read "off".
const CONTEXT_DOMAINS = ['input_select'];
const ACTIONS = ['turn_on', 'turn_off', 'toggle'];

const RESOLVER_PROMPT = `You resolve Home Assistant commands. Given a user command and the entity list ("entity_id | name | current state"), return ONLY a JSON object {"action": "turn_on" | "turn_off" | "toggle", "entity_id": "..."}. If no entity matches, return {"error": "reason"}.
Rules:
- Prefer a device entity (switch, light, climate, fan, cover, media_player) over a script, and a script over a scene.
- Scenes and scripts can only be RUN; they have no on/off state, and running one never reverses it. To switch something off with a script or scene, pick the one whose name says off, with action "turn_on".
- A script's state "off" only means it isn't running right now; it says nothing about the device it controls.
- "Current modes" shows the real state of devices driven by scripts; use it when the command depends on it ("again", "if it's off").`;

export async function fetchHA(endpoint, method = 'GET', body = null) {
  const url = process.env.HA_URL;
  const token = process.env.HA_TOKEN;
  if (!url || !token) return { ok: false, output: 'HA_URL or HA_TOKEN not configured' };

  try {
    const res = await fetch(`${url}/api/${endpoint}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return { ok: false, output: `HA returned HTTP ${res.status}` };
    }

    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    console.error(`[ha] API error (${endpoint}):`, err.message);
    return { ok: false, output: err.message };
  }
}

/**
 * Fetch all Home Assistant entity states once. Returns { ok, data: [...] }.
 * Callers that need several derived summaries should fetch once and pass the
 * array down to avoid hammering the /api/states endpoint.
 */
export async function getStates() {
  return fetchHA('states');
}

/**
 * Summarise the state of controllable Home Assistant devices.
 * Returns counts of what's on, names of active lights/switches, and any
 * unavailable entities — used by the morning briefing.
 * Accepts an optional pre-fetched states array.
 */
export async function getHomeSummary(states = null) {
  let data = states;
  if (!data) {
    const statesResult = await fetchHA('states');
    if (!statesResult.ok) return { ok: false, output: statesResult.output };
    data = statesResult.data;
  }

  const onByDomain = {};
  const onNames = [];
  let unavailable = 0;

  for (const s of data) {
    const domain = s.entity_id.split('.')[0];
    if (!['light', 'switch', 'fan', 'cover', 'climate', 'media_player'].includes(domain)) continue;

    if (s.state === 'unavailable' || s.state === 'unknown') {
      unavailable++;
      continue;
    }

    const isActive = ['on', 'open', 'playing', 'heat', 'cool', 'auto'].includes(s.state);
    if (isActive) {
      onByDomain[domain] = (onByDomain[domain] || 0) + 1;
      if (['light', 'switch', 'fan'].includes(domain) && onNames.length < 8) {
        onNames.push(s.attributes?.friendly_name || s.entity_id.split('.')[1].replace(/_/g, ' '));
      }
    }
  }

  return { ok: true, onByDomain, onNames, unavailable };
}

// HA_AGENT_EXCLUDE: CSV of entity ids or * patterns the resolver never sees
// (look-alikes such as the raw IR scenes behind a script or template switch).
export function parseExcludes(raw) {
  return (raw || '').split(',').map((p) => p.trim()).filter(Boolean).map((p) => new RegExp(
    `^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i',
  ));
}

const entityName = (s) => s?.attributes?.friendly_name || (s ? s.entity_id.split('.')[1].replace(/_/g, ' ') : '');
const domainOf = (entityId) => entityId.split('.')[0];

function buildEntityList(states, excludes = parseExcludes(process.env.HA_AGENT_EXCLUDE)) {
  const usable = states.filter((s) => s.state !== 'unavailable' && !excludes.some((re) => re.test(s.entity_id)));
  const lines = (domains) => usable
    .filter((s) => domains.includes(domainOf(s.entity_id)))
    .map((s) => `${s.entity_id} | ${entityName(s)} | ${s.state}`)
    .join('\n');
  return { controllable: lines(CONTROLLABLE_DOMAINS), context: lines(CONTEXT_DOMAINS) };
}

// The resolver sometimes wraps its JSON in prose or code fences.
export function parseResolution(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  for (const candidate of [cleaned, cleaned.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // not JSON — try the next candidate
    }
  }
  return null;
}

// Scenes and scripts can only be run. Running one for "turn off" used to switch
// things ON (e.g. the AC's "Turn on … Cold" scene), so an off/toggle request may
// only run a scene or script whose own name says off/toggle.
export function serviceFor(entityId, action, name = '') {
  const domain = domainOf(entityId);
  if (domain !== 'scene' && domain !== 'script') return { service: action };
  const label = `${entityId} ${name}`.toLowerCase();
  if (action === 'turn_on') return { service: 'turn_on' };
  if (action === 'turn_off' && /(^|[^a-z])off([^a-z]|$)/.test(label)) return { service: 'turn_on' };
  if (action === 'toggle' && label.includes('toggle')) return { service: 'turn_on' };
  return { error: `I didn't run "${name || entityId}": it's a ${domain}, so it can't turn anything off.` };
}

async function resolveEntity(command, entityList) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const context = entityList.context ? `\n\nCurrent modes (read-only, cannot be controlled):\n${entityList.context}` : '';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: haikuModel(),
        ...quickCallOptions(haikuModel()),
        max_tokens: 384,
        system: RESOLVER_PROMPT,
        messages: [{
          role: 'user',
          content: `Command: "${command}"\n\nAvailable entities:\n${entityList.controllable}${context}`,
        }],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[ha] Haiku resolution error ${res.status}: ${errBody.slice(0, 300)}`);
      return null;
    }

    const text = responseText(await res.json());
    const parsed = parseResolution(text);
    if (!parsed) console.error(`[ha] unreadable resolver reply for "${command.slice(0, 80)}": ${(text || '').slice(0, 300)}`);
    return parsed;
  } catch (err) {
    console.error('[ha] Entity resolution failed:', err.message);
    return null;
  }
}

export async function resolveAndExecute(command) {
  const statesResult = await fetchHA('states');
  if (!statesResult.ok) {
    return { ok: false, output: `Cannot reach Home Assistant: ${statesResult.output}` };
  }

  const entityList = buildEntityList(statesResult.data);
  if (!entityList.controllable) {
    return { ok: false, output: 'No controllable entities found in Home Assistant.' };
  }

  const resolved = await resolveEntity(command, entityList);
  if (!resolved) {
    return { ok: false, output: 'Failed to resolve the command — could not determine which entity to control.' };
  }

  if (resolved.error) {
    console.log(`[ha] "${command.slice(0, 80)}" → no match: ${String(resolved.error).slice(0, 120)}`);
    return { ok: false, output: `Could not match: ${resolved.error}` };
  }

  const { action, entity_id: entityId } = resolved;
  const listed = typeof entityId === 'string'
    && entityList.controllable.split('\n').some((line) => line.startsWith(`${entityId} |`));
  if (!ACTIONS.includes(action) || !listed) {
    console.error(`[ha] "${command.slice(0, 80)}" → invalid pick ${JSON.stringify(resolved).slice(0, 200)}`);
    return { ok: false, output: 'Could not determine the action or entity from the command.' };
  }

  const domain = domainOf(entityId);
  const friendlyName = entityName(statesResult.data.find((s) => s.entity_id === entityId)) || entityId;
  const { service, error } = serviceFor(entityId, action, friendlyName);
  console.log(`[ha] "${command.slice(0, 80)}" → ${entityId} (${action}${service ? ` → ${domain}.${service}` : ', refused'})`);
  if (error) return { ok: false, output: error };

  const serviceResult = await fetchHA(`services/${domain}/${service}`, 'POST', { entity_id: entityId });
  if (!serviceResult.ok) {
    return { ok: false, output: `Failed to ${service} ${entityId}: ${serviceResult.output}` };
  }

  return {
    ok: true,
    output: `${friendlyName} — ${service} executed.`,
    entity: entityId,
    action: service,
  };
}

// Exported for unit testing.
export const _internal = { buildEntityList };
