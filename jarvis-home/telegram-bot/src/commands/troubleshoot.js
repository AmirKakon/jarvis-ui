import { Markup } from 'telegraf';
import { run, bold, pre, code, sendLong, escapeHtml } from '../utils.js';

// Interactive troubleshooting actions triggered from cron-alert inline buttons.
//
// Callback scheme (namespaced `ts:` — see notify.sh for the button side):
//   ts:rs:<service>  restart a SYSTEM systemd service (sudo)
//   ts:ru:<service>  restart a USER   systemd service (--user)
//   ts:ls:<service>  view SYSTEM service logs (sudo journalctl)
//   ts:lu:<service>  view USER   service logs (journalctl --user)
//   ts:bi:<ip>       block an IP (asks for confirmation first)
//   ts:bic:<ip>      block confirmed → ufw deny
//   ts:x:<any>       cancel (dismiss confirmation)
//
// Docker container restart/logs reuse the existing `d:r:` / `d:l:` docker
// callbacks, so there's a single source of truth for container ops.

// systemd unit names: letters, digits, and @ . _ - (bounded length).
const SERVICE_RE = /^[a-zA-Z0-9@._-]{1,64}$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function validService(name) {
  return typeof name === 'string' && SERVICE_RE.test(name);
}

function validIp(ip) {
  const m = IPV4_RE.exec(ip || '');
  if (!m) return false;
  return m.slice(1, 5).every((o) => {
    const n = Number(o);
    return n >= 0 && n <= 255;
  });
}

async function restartService(ctx, name, userScope) {
  const prefix = userScope ? 'systemctl --user' : 'sudo systemctl';
  const { ok, output } = await run(`${prefix} restart ${name}`, { timeout: 30_000 });

  if (!ok) {
    return ctx.replyWithHTML(`🔴 Failed to restart ${code(name)}:\n${pre(output.slice(-500))}`);
  }

  const active = await run(`${prefix} is-active ${name}`, { timeout: 10_000 });
  const state = active.output.trim() || 'unknown';
  const icon = state === 'active' ? '🟢' : '⚠️';
  return ctx.replyWithHTML(`${icon} ${code(name)} restarted — now <b>${escapeHtml(state)}</b>.`);
}

async function serviceLogs(ctx, name, userScope) {
  const cmd = userScope
    ? `journalctl --user -u ${name} -n 40 --no-pager`
    : `sudo journalctl -u ${name} -n 40 --no-pager`;
  const { ok, output } = await run(cmd, { timeout: 15_000 });
  if (!ok) return ctx.replyWithHTML(`🔴 ${pre(output.slice(-500))}`);
  return sendLong(ctx, `${bold(`Logs: ${name}`)}\n${pre(output || '(no recent logs)')}`);
}

async function blockIpConfirmed(ctx, ip) {
  const { ok, output } = await run(`sudo ufw deny from ${ip}`, { timeout: 15_000 });
  if (!ok) return ctx.replyWithHTML(`🔴 Failed to block ${code(ip)}:\n${pre(output.slice(-400))}`);
  return ctx.replyWithHTML(`🚫 Blocked ${code(ip)} via ufw.\n${pre(output.slice(0, 300) || 'Rule added.')}`);
}

export async function troubleshootCallback(ctx) {
  const action = ctx.match[1];
  const arg = ctx.match[2];

  // --- Cancel a pending confirmation ---
  if (action === 'x') {
    await ctx.answerCbQuery('Cancelled');
    try { await ctx.editMessageText('✅ Cancelled — no changes made.'); } catch { /* ignore */ }
    return;
  }

  // --- IP blocking (two-step: ask, then confirm) ---
  if (action === 'bi') {
    if (!validIp(arg)) return ctx.answerCbQuery('Invalid IP');
    await ctx.answerCbQuery();
    return ctx.replyWithHTML(
      `⚠️ Block <code>${escapeHtml(arg)}</code> with ufw? This denies <b>all</b> traffic from that address.`,
      Markup.inlineKeyboard([[
        Markup.button.callback('🚫 Confirm block', `ts:bic:${arg}`),
        Markup.button.callback('Cancel', 'ts:x:0'),
      ]])
    );
  }
  if (action === 'bic') {
    if (!validIp(arg)) return ctx.answerCbQuery('Invalid IP');
    await ctx.answerCbQuery(`Blocking ${arg}...`);
    try { await ctx.editMessageReplyMarkup(undefined); } catch { /* ignore */ }
    return blockIpConfirmed(ctx, arg);
  }

  // --- Service actions ---
  if (!validService(arg)) return ctx.answerCbQuery('Invalid service name');

  switch (action) {
    case 'rs':
      await ctx.answerCbQuery(`Restarting ${arg}...`);
      return restartService(ctx, arg, false);
    case 'ru':
      await ctx.answerCbQuery(`Restarting ${arg}...`);
      return restartService(ctx, arg, true);
    case 'ls':
      await ctx.answerCbQuery('Fetching logs...');
      return serviceLogs(ctx, arg, false);
    case 'lu':
      await ctx.answerCbQuery('Fetching logs...');
      return serviceLogs(ctx, arg, true);
    default:
      return ctx.answerCbQuery('Unknown action');
  }
}
