import { Markup } from 'telegraf';
import { run, bold, code, pre, sendLong, escapeHtml, cbData } from '../utils.js';

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

async function handleStatus(ctx, env) {
  const { ok, output } = await curlHA(env, '');
  return ctx.replyWithHTML(ok ? '🟢 Home Assistant is reachable.' : `🔴 Unreachable:\n${pre(output)}`);
}

async function handleStates(ctx, env) {
  const { ok, output } = await curlHA(env, 'states');
  if (!ok) return ctx.replyWithHTML(`🔴 ${pre(output)}`);
  try {
    const states = JSON.parse(output);

    const controllable = ['light', 'switch', 'fan', 'cover', 'climate', 'media_player', 'scene', 'script'];
    const buttons = [];
    for (const s of states) {
      const domain = s.entity_id.split('.')[0];
      if (!controllable.includes(domain)) continue;
      const label = `${s.state === 'on' ? '🟢' : '⚪'} ${s.entity_id.split('.')[1].replace(/_/g, ' ')}`;
      const data = cbData('h:t:', s.entity_id);
      if (data) buttons.push([Markup.button.callback(label, data)]);
    }

    const summary = states
      .slice(0, 40)
      .map((s) => `${s.entity_id}: ${s.state}`)
      .join('\n');

    const keyboard = buttons.length > 0
      ? Markup.inlineKeyboard(buttons.slice(0, 20))
      : undefined;

    return sendLong(ctx, `${bold('Entity States')}\n${pre(summary)}`, keyboard || {});
  } catch {
    return ctx.replyWithHTML('🔴 Failed to parse states.');
  }
}

async function handleEntityState(ctx, env, entityId) {
  const { ok, output } = await curlHA(env, `states/${entityId}`);
  if (!ok) return ctx.replyWithHTML(`🔴 ${pre(output)}`);
  try {
    const s = JSON.parse(output);
    const domain = s.entity_id.split('.')[0];
    const isControllable = ['light', 'switch', 'fan', 'cover', 'climate', 'media_player'].includes(domain);

    const btnRow = [];
    if (isControllable) {
      const t = cbData('h:t:', s.entity_id);
      const on = cbData('h:1:', s.entity_id);
      const off = cbData('h:0:', s.entity_id);
      if (t) btnRow.push(Markup.button.callback('🔄 Toggle', t));
      if (on) btnRow.push(Markup.button.callback('💡 On', on));
      if (off) btnRow.push(Markup.button.callback('🔌 Off', off));
    }

    const keyboard = btnRow.length ? Markup.inlineKeyboard([btnRow]) : {};
    return ctx.replyWithHTML(
      `${bold(escapeHtml(s.entity_id))}\nState: ${code(s.state)}\nLast changed: ${code(s.last_changed)}`,
      keyboard
    );
  } catch {
    return ctx.replyWithHTML('🔴 Failed to parse state.');
  }
}

async function handleService(ctx, env, service, entityId) {
  const domain = entityId.split('.')[0];
  const { ok, output } = await curlHA(
    env,
    `services/${domain}/${service}`,
    'POST',
    { entity_id: entityId }
  );
  if (!ok) return ctx.replyWithHTML(`🔴 ${pre(output)}`);
  return ctx.replyWithHTML(`🟢 ${code(entityId)} — ${service} executed.`);
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
      [bold('Home Assistant'), ''].join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback('📡 Status', 'h:s')],
        [Markup.button.callback('📋 Entity States', 'h:l')],
      ])
    );
  }

  if (sub === 'status') return handleStatus(ctx, env);
  if (sub === 'states') return handleStates(ctx, env);
  if (sub === 'state' && args[1]) return handleEntityState(ctx, env, args[1]);

  const serviceMap = { toggle: 'toggle', turn_on: 'turn_on', turn_off: 'turn_off' };
  if (serviceMap[sub] && args[1]) return handleService(ctx, env, serviceMap[sub], args[1]);

  return ctx.replyWithHTML('Unknown sub-command. Try /ha help');
}

const ACTION_MAP = { t: 'toggle', 1: 'turn_on', 0: 'turn_off' };

export async function haCallback(ctx) {
  const env = loadEnv();
  if (!env) {
    await ctx.answerCbQuery('HA not configured');
    return;
  }

  const data = ctx.match[1];

  if (data === 's') {
    await ctx.answerCbQuery('Checking HA...');
    return handleStatus(ctx, env);
  }

  if (data === 'l') {
    await ctx.answerCbQuery('Loading states...');
    return handleStates(ctx, env);
  }

  const match = data.match(/^([t10]):(.+)$/);
  if (match) {
    const service = ACTION_MAP[match[1]];
    const entityId = match[2];
    await ctx.answerCbQuery(`${service}: ${entityId}`);
    return handleService(ctx, env, service, entityId);
  }

  await ctx.answerCbQuery('Unknown action');
}
