import { run, bold, code, pre, sendLong, escapeHtml } from '../utils.js';

function loadEnv() {
  const url = process.env.HA_URL;
  const token = process.env.HA_TOKEN;
  if (!url || !token || token === 'your-home-assistant-long-lived-access-token-here') {
    return null;
  }
  return { url, token };
}

function curlHA(env, endpoint, method = 'GET', body = null) {
  const bodyFlag = body ? `-d '${JSON.stringify(body)}'` : '';
  return run(
    `curl -sf -X ${method} ` +
      `-H "Authorization: Bearer ${env.token}" ` +
      `-H "Content-Type: application/json" ` +
      `${bodyFlag} "${env.url}/api/${endpoint}"`,
    { timeout: 15_000 }
  );
}

export async function haCommand(ctx) {
  const env = loadEnv();
  if (!env) {
    return ctx.replyWithHTML(
      '🔴 Home Assistant not configured. Set <code>HA_URL</code> and <code>HA_TOKEN</code> in ~/jarvis/.env'
    );
  }

  const text = (ctx.message.text || '').replace(/^\/ha\s*/, '').trim();
  const args = text.split(/\s+/);
  const sub = args[0]?.toLowerCase();

  if (!sub || sub === 'help') {
    return ctx.replyWithHTML(
      [
        bold('Home Assistant'),
        '',
        '/ha status        — API health check',
        '/ha states        — list entity states',
        '/ha toggle &lt;id&gt;  — toggle an entity',
        '/ha turn_on &lt;id&gt; — turn on entity',
        '/ha turn_off &lt;id&gt; — turn off entity',
        '/ha state &lt;id&gt;   — get entity state',
      ].join('\n')
    );
  }

  if (sub === 'status') {
    const { ok, output } = await curlHA(env, '');
    return ctx.replyWithHTML(ok ? '🟢 Home Assistant is reachable.' : `🔴 Unreachable:\n${pre(output)}`);
  }

  if (sub === 'states') {
    const { ok, output } = await curlHA(env, 'states');
    if (!ok) return ctx.replyWithHTML(`🔴 ${pre(output)}`);
    try {
      const states = JSON.parse(output);
      const summary = states
        .slice(0, 40)
        .map((s) => `${s.entity_id}: ${s.state}`)
        .join('\n');
      return sendLong(ctx, `${bold('Entity States')}\n${pre(summary)}`);
    } catch {
      return ctx.replyWithHTML(`🔴 Failed to parse states.`);
    }
  }

  if (sub === 'state' && args[1]) {
    const entityId = args[1];
    const { ok, output } = await curlHA(env, `states/${entityId}`);
    if (!ok) return ctx.replyWithHTML(`🔴 ${pre(output)}`);
    try {
      const s = JSON.parse(output);
      return ctx.replyWithHTML(
        `${bold(escapeHtml(s.entity_id))}\nState: ${code(s.state)}\nLast changed: ${code(s.last_changed)}`
      );
    } catch {
      return ctx.replyWithHTML(`🔴 Failed to parse state.`);
    }
  }

  const serviceMap = { toggle: 'toggle', turn_on: 'turn_on', turn_off: 'turn_off' };
  if (serviceMap[sub] && args[1]) {
    const entityId = args[1];
    const domain = entityId.split('.')[0];
    const service = serviceMap[sub];
    const { ok, output } = await curlHA(
      env,
      `services/${domain}/${service}`,
      'POST',
      { entity_id: entityId }
    );
    if (!ok) return ctx.replyWithHTML(`🔴 ${pre(output)}`);
    return ctx.replyWithHTML(`🟢 ${code(entityId)} — ${service} executed.`);
  }

  return ctx.replyWithHTML(`Unknown sub-command. Try /ha help`);
}
