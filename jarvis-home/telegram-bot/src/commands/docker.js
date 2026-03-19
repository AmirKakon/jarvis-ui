import { Markup } from 'telegraf';
import { run, bold, pre, code, sendLong, escapeHtml, cbData } from '../utils.js';

const ALLOWED_ACTIONS = ['restart', 'stop', 'start', 'logs'];
const ACTION_SHORT = { restart: 'r', stop: 's', start: 'S', logs: 'l' };
const SHORT_ACTION = { r: 'restart', s: 'stop', S: 'start', l: 'logs' };

function sanitiseName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '');
}

export async function dockerCommand(ctx) {
  const args = (ctx.message.text || '').replace(/^\/docker\s*/, '').trim().split(/\s+/);
  const action = args[0]?.toLowerCase();
  const target = args[1] ? sanitiseName(args[1]) : '';

  if (!action || action === 'list' || action === 'ps') {
    const { ok, output } = await run(
      'docker ps -a --format "{{.Names}}|{{.Status}}|{{.Ports}}"'
    );
    if (!ok) return ctx.replyWithHTML(`🔴 ${pre(output)}`);

    const lines = [bold('Docker Containers'), ''];
    const buttons = [];

    for (const row of output.split('\n').filter(Boolean)) {
      const [name, status, ports] = row.split('|');
      const isUp = status?.toLowerCase().includes('up');
      const icon = isUp ? '🟢' : '🔴';
      const portInfo = ports ? ` (${escapeHtml(ports)})` : '';
      lines.push(`${icon} ${code(name)} — ${escapeHtml(status)}${portInfo}`);

      const rowButtons = [];
      if (isUp) {
        const r = cbData('d:r:', name);
        const l = cbData('d:l:', name);
        const s = cbData('d:s:', name);
        if (r) rowButtons.push(Markup.button.callback(`🔄 ${name}`, r));
        if (l) rowButtons.push(Markup.button.callback('📋 logs', l));
        if (s) rowButtons.push(Markup.button.callback('⏹ stop', s));
      } else {
        const S = cbData('d:S:', name);
        if (S) rowButtons.push(Markup.button.callback(`▶️ start ${name}`, S));
      }
      if (rowButtons.length) buttons.push(rowButtons);
    }

    const keyboard = buttons.length ? Markup.inlineKeyboard(buttons) : {};
    return ctx.replyWithHTML(lines.join('\n'), keyboard);
  }

  if (!ALLOWED_ACTIONS.includes(action)) {
    return ctx.replyWithHTML(
      `Unknown action ${code(action)}.\nAllowed: ${ALLOWED_ACTIONS.map(code).join(', ')}`
    );
  }

  if (!target) {
    return ctx.replyWithHTML(`Usage: /docker ${action} ${code('container_name')}`);
  }

  if (action === 'logs') {
    const { ok, output } = await run(`docker logs --tail 40 ${target}`, { timeout: 15_000 });
    if (!ok) return ctx.replyWithHTML(`🔴 ${pre(output)}`);
    return sendLong(ctx, `${bold(`Logs: ${target}`)}\n${pre(output)}`);
  }

  await ctx.replyWithHTML(`Running ${code(`docker ${action} ${target}`)}...`);
  const { ok, output } = await run(`docker ${action} ${target}`, { timeout: 30_000 });
  if (!ok) return ctx.replyWithHTML(`🔴 Failed:\n${pre(output)}`);
  return ctx.replyWithHTML(`🟢 ${code(target)} — ${action} completed.`);
}

export async function dockerCallback(ctx) {
  const shortAction = ctx.match[1];
  const name = sanitiseName(ctx.match[2]);
  const action = SHORT_ACTION[shortAction] || shortAction;

  await ctx.answerCbQuery(`${action} ${name}...`);

  if (action === 'logs') {
    const { ok, output } = await run(`docker logs --tail 40 ${name}`, { timeout: 15_000 });
    if (!ok) return ctx.replyWithHTML(`🔴 ${pre(output)}`);
    return sendLong(ctx, `${bold(`Logs: ${name}`)}\n${pre(output)}`);
  }

  const { ok, output } = await run(`docker ${action} ${name}`, { timeout: 30_000 });
  if (!ok) return ctx.replyWithHTML(`🔴 Failed:\n${pre(output)}`);
  return ctx.replyWithHTML(`🟢 ${code(name)} — ${action} completed.`);
}
