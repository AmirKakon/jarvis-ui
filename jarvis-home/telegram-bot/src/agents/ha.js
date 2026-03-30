const CONTROLLABLE_DOMAINS = ['light', 'switch', 'fan', 'cover', 'climate', 'media_player', 'scene', 'script'];

const DOMAIN_SERVICE_MAP = {
  scene:  { toggle: 'turn_on', turn_off: 'turn_on' },
  script: { toggle: 'turn_on', turn_off: 'turn_on' },
};

async function fetchHA(endpoint, method = 'GET', body = null) {
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

function buildEntityList(states) {
  return states
    .filter((s) => {
      const domain = s.entity_id.split('.')[0];
      return CONTROLLABLE_DOMAINS.includes(domain) && s.state !== 'unavailable';
    })
    .map((s) => {
      const name = s.attributes?.friendly_name || s.entity_id.split('.')[1].replace(/_/g, ' ');
      return `${s.entity_id} | ${name} | ${s.state}`;
    })
    .join('\n');
}

async function resolveEntity(command, entityList) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

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
        max_tokens: 256,
        system: `You resolve Home Assistant commands. Given a user command and entity list, return ONLY a JSON object with "action" (turn_on, turn_off, or toggle) and "entity_id". If the command is ambiguous, pick the most likely match. If no entity matches, return {"error": "reason"}.`,
        messages: [{
          role: 'user',
          content: `Command: "${command}"\n\nAvailable entities:\n${entityList}`,
        }],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[ha] Haiku resolution error ${res.status}: ${errBody.slice(0, 300)}`);
      return null;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text?.trim();
    if (!text) return null;

    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    return JSON.parse(cleaned);
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
  if (!entityList) {
    return { ok: false, output: 'No controllable entities found in Home Assistant.' };
  }

  const resolved = await resolveEntity(command, entityList);
  if (!resolved) {
    return { ok: false, output: 'Failed to resolve the command — could not determine which entity to control.' };
  }

  if (resolved.error) {
    return { ok: false, output: `Could not match: ${resolved.error}` };
  }

  const { action, entity_id } = resolved;
  if (!action || !entity_id) {
    return { ok: false, output: 'Could not determine the action or entity from the command.' };
  }

  const domain = entity_id.split('.')[0];
  const resolvedAction = DOMAIN_SERVICE_MAP[domain]?.[action] || action;

  const serviceResult = await fetchHA(`services/${domain}/${resolvedAction}`, 'POST', { entity_id });
  if (!serviceResult.ok) {
    return { ok: false, output: `Failed to ${resolvedAction} ${entity_id}: ${serviceResult.output}` };
  }

  const friendlyName = statesResult.data.find((s) => s.entity_id === entity_id)
    ?.attributes?.friendly_name || entity_id;

  return {
    ok: true,
    output: `${friendlyName} — ${resolvedAction} executed.`,
    entity: entity_id,
    action: resolvedAction,
  };
}
