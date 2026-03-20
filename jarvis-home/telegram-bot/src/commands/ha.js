import { Markup } from 'telegraf';
import { run, bold, code, pre, sendLong, escapeHtml, cbData, editOrReply } from '../utils.js';

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

const STATUS_KEYBOARD = Markup.inlineKeyboard([
  [Markup.button.callback('🔄 Refresh', 'h:s')],
  [Markup.button.callback('📋 Entity States', 'h:l')],
]);

function formatDate(iso) {
  if (!iso || iso === 'None') return 'never';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 30) return `${diffDays}d ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

async function buildStatusReport(env) {
  const [configRes, statesRes] = await Promise.all([
    curlHA(env, 'config'),
    curlHA(env, 'states'),
  ]);

  if (!configRes.ok || !statesRes.ok) {
    return '🔴 Home Assistant is unreachable.';
  }

  let config, states;
  try {
    config = JSON.parse(configRes.output);
    states = JSON.parse(statesRes.output);
  } catch {
    return '🔴 Failed to parse HA response.';
  }

  const lines = [];
  lines.push(`${bold('Home Assistant')} v${config.version} — ${config.state}`);
  lines.push('');

  const domains = {};
  const unavail = [];
  const unknown = [];
  for (const s of states) {
    const d = s.entity_id.split('.')[0];
    domains[d] = (domains[d] || 0) + 1;
    if (s.state === 'unavailable') unavail.push(s);
    if (s.state === 'unknown') unknown.push(s);
  }

  const total = states.length;
  const okCount = total - unavail.length - unknown.length;
  lines.push(`<b>Entities:</b> ${total} total, ${okCount} ok, ${unavail.length} unavailable, ${unknown.length} unknown`);
  lines.push('');

  if (unavail.length > 0) {
    const grouped = {};
    for (const s of unavail) {
      const d = s.entity_id.split('.')[0];
      if (!grouped[d]) grouped[d] = 0;
      grouped[d]++;
    }

    lines.push(bold('Unavailable'));
    const order = ['light', 'switch', 'sensor', 'binary_sensor', 'media_player', 'climate', 'scene', 'script', 'select', 'remote', 'event', 'update'];
    const shown = new Set();
    for (const d of order) {
      if (grouped[d]) {
        const domainTotal = domains[d] || 0;
        const allDown = grouped[d] === domainTotal ? ' (all)' : '';
        lines.push(`  ${d}: ${grouped[d]}/${domainTotal}${allDown}`);
        shown.add(d);
      }
    }
    for (const d of Object.keys(grouped).sort()) {
      if (!shown.has(d)) {
        lines.push(`  ${d}: ${grouped[d]}/${domains[d] || 0}`);
      }
    }
    lines.push('');
  }

  const autos = states.filter((s) => s.entity_id.startsWith('automation.'));
  if (autos.length) {
    lines.push(bold('Automations'));
    for (const a of autos) {
      const icon = a.state === 'on' ? '🟢' : '⚪';
      const name = escapeHtml(a.attributes?.friendly_name || a.entity_id.split('.')[1]);
      const last = formatDate(a.attributes?.last_triggered);
      lines.push(`  ${icon} ${name} (${last})`);
    }
    lines.push('');
  }

  const updates = states.filter((s) => s.entity_id.startsWith('update.') && s.state === 'on');
  if (updates.length) {
    lines.push(bold('Updates Available'));
    for (const u of updates) {
      const name = escapeHtml(u.attributes?.friendly_name || u.entity_id);
      const cur = u.attributes?.installed_version || '?';
      const next = u.attributes?.latest_version || '?';
      lines.push(`  ${name}: ${cur} → ${next}`);
    }
    lines.push('');
  }

  if (unavail.length === 0 && unknown.length === 0 && updates.length === 0) {
    lines.push('✅ All systems healthy.');
  }

  return lines.join('\n');
}

async function handleStatus(ctx, env, messageId) {
  const html = await buildStatusReport(env);
  if (messageId) {
    return editOrReply(ctx, messageId, html, STATUS_KEYBOARD);
  }
  return sendLong(ctx, html, STATUS_KEYBOARD);
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
      if (s.state === 'unavailable') continue;
      const label = `${s.state === 'on' ? '🟢' : '⚪'} ${s.entity_id.split('.')[1].replace(/_/g, ' ')}`;
      const data = cbData('h:t:', s.entity_id);
      if (data) buttons.push([Markup.button.callback(label, data)]);
    }

    if (buttons.length === 0) {
      return ctx.replyWithHTML('No controllable entities available.');
    }

    const keyboard = Markup.inlineKeyboard(buttons.slice(0, 20));
    return ctx.replyWithHTML(`${bold('Controllable Entities')}\nTap to toggle:`, keyboard);
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
        [Markup.button.callback('📡 Full Diagnostic', 'h:s')],
        [Markup.button.callback('📋 Entity Controls', 'h:l')],
      ])
    );
  }

  if (sub === 'status') {
    const placeholder = await ctx.replyWithHTML('<i>Running HA diagnostic...</i>');
    return handleStatus(ctx, env, placeholder.message_id);
  }
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
    await ctx.answerCbQuery('Running diagnostic...');
    const msgId = ctx.callbackQuery?.message?.message_id;
    return handleStatus(ctx, env, msgId);
  }

  if (data === 'l') {
    await ctx.answerCbQuery('Loading entities...');
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
