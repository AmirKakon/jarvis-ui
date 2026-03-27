import { run, bold, pre, escapeHtml } from '../utils.js';

const SCRIPTS_DIR = (process.env.HOME || '/home/iot') + '/jarvis/scripts';

const ALLOWED_SCRIPTS = new Set([
  'service-monitor',
  'disk-watchdog',
  'smart-monitor',
  'backup-checker',
  'samba-monitor',
  'ha-update',
  'network-scanner',
  'ssh-monitor',
  'docker-security',
  'ssl-monitor',
  'firewall-audit',
]);

export async function cronRerun(ctx) {
  const scriptName = ctx.match[1];

  if (!ALLOWED_SCRIPTS.has(scriptName)) {
    await ctx.answerCbQuery('Unknown script');
    return;
  }

  await ctx.answerCbQuery(`Running ${scriptName}...`);

  const statusMsg = await ctx.replyWithHTML(
    `⏳ Running ${bold(scriptName)}...`
  );

  const { ok, output } = await run(
    `bash "${SCRIPTS_DIR}/${scriptName}.sh"`,
    { timeout: 600_000 }
  );

  const icon = ok ? '✅' : '🔴';
  let result;
  if (output) {
    result = `\n${pre(output.slice(-1500))}`;
  } else if (ok) {
    result = '\n<i>All checks passed — no issues detected.</i>';
  } else {
    result = '\n<i>Script failed with no output.</i>';
  }

  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `${icon} ${bold(scriptName)} completed.${result}`,
      { parse_mode: 'HTML' }
    );
  } catch {
    await ctx.replyWithHTML(`${icon} ${bold(scriptName)} completed.${result}`);
  }
}
