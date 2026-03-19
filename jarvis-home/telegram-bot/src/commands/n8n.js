import { run, bold, code, pre, sendLong, escapeHtml } from '../utils.js';

function loadEnv() {
  const url = process.env.N8N_URL;
  const key = process.env.N8N_API_KEY;
  if (!url || !key || key === 'your-n8n-api-key-here') {
    return null;
  }
  return { url, key };
}

function curlN8n(env, endpoint) {
  return run(
    `curl -sf -H "X-N8N-API-KEY: ${env.key}" "${env.url}/api/v1/${endpoint}"`,
    { timeout: 15_000 }
  );
}

export async function n8nCommand(ctx) {
  const env = loadEnv();
  if (!env) {
    return ctx.replyWithHTML(
      '🔴 n8n not configured. Set <code>N8N_URL</code> and <code>N8N_API_KEY</code> in ~/jarvis/.env'
    );
  }

  const text = (ctx.message.text || '').replace(/^\/n8n\s*/, '').trim();
  const sub = text.split(/\s+/)[0]?.toLowerCase();

  if (!sub || sub === 'list') {
    const { ok, output } = await curlN8n(env, 'workflows');
    if (!ok) return ctx.replyWithHTML(`🔴 Failed to reach n8n:\n${pre(output)}`);

    try {
      const data = JSON.parse(output);
      const workflows = data.data || data;
      const lines = [bold('n8n Workflows'), ''];
      for (const wf of workflows) {
        const icon = wf.active ? '🟢' : '⚪';
        lines.push(`${icon} ${code(wf.id)} ${escapeHtml(wf.name)}`);
      }
      return sendLong(ctx, lines.join('\n'));
    } catch {
      return ctx.replyWithHTML('🔴 Failed to parse workflow list.');
    }
  }

  if (sub === 'status') {
    const { ok } = await curlN8n(env, 'workflows?limit=1');
    return ctx.replyWithHTML(ok ? '🟢 n8n API is reachable.' : '🔴 n8n API is unreachable.');
  }

  return ctx.replyWithHTML(
    [
      bold('n8n Commands'),
      '',
      '/n8n          — list all workflows',
      '/n8n status   — API health check',
    ].join('\n')
  );
}
