import { Markup } from 'telegraf';
import { run, bold, code, editOrReply } from '../utils.js';

const REFRESH_BTN = Markup.inlineKeyboard([
  Markup.button.callback('🔄 Refresh', 'x:security'),
]);

async function buildSecurity() {
  const [network, ssh, docker, ssl, firewall] = await Promise.all([
    getNetworkStatus(),
    getSSHStatus(),
    getDockerStatus(),
    getSSLStatus(),
    getFirewallStatus(),
  ]);

  const lines = [bold('Security Dashboard'), ''];

  lines.push(bold('🔍 Network Scanner'));
  lines.push(network);
  lines.push('');

  lines.push(bold('🔐 SSH Logins (24h)'));
  lines.push(ssh);
  lines.push('');

  lines.push(bold('🐳 Docker Security'));
  lines.push(docker);
  lines.push('');

  lines.push(bold('🔒 SSL Certificates'));
  lines.push(ssl);
  lines.push('');

  lines.push(bold('🛡️ Firewall'));
  lines.push(firewall);

  return lines.join('\n');
}

async function getNetworkStatus() {
  const known = await run('wc -l < ~/jarvis/known-devices.txt 2>/dev/null || echo 0');
  const lastScan = await run('tail -1 ~/jarvis/logs/network-scanner.log 2>/dev/null');

  const count = known.ok ? known.output.trim() : '?';
  const last = lastScan.ok ? lastScan.output.replace(/\[.*?\]\s*/, '') : 'No scans yet';

  return `Known devices: ${code(count)}\nLast: ${last}`;
}

async function getSSHStatus() {
  const result = await run(
    `grep -c "Failed password\\|authentication failure" /var/log/auth.log 2>/dev/null || echo 0; ` +
    `grep -c "Accepted " /var/log/auth.log 2>/dev/null || echo 0`
  );

  if (result.ok) {
    const parts = result.output.split('\n');
    return `Failed: ${code(parts[0] || '0')} | Successful: ${code(parts[1] || '0')}`;
  }

  const jResult = await run(
    'journalctl -u ssh -u sshd --since "24 hours ago" --no-pager 2>/dev/null | grep -c "Failed password" || echo 0; ' +
    'journalctl -u ssh -u sshd --since "24 hours ago" --no-pager 2>/dev/null | grep -c "Accepted " || echo 0'
  );
  if (jResult.ok) {
    const parts = jResult.output.split('\n');
    return `Failed: ${code(parts[0] || '0')} | Successful: ${code(parts[1] || '0')}`;
  }
  return 'Could not read auth logs';
}

async function getDockerStatus() {
  const lastAudit = await run('tail -1 ~/jarvis/logs/docker-security.log 2>/dev/null');
  if (lastAudit.ok && lastAudit.output) {
    return lastAudit.output.replace(/\[.*?\]\s*/, '');
  }
  return 'No audit run yet';
}

async function getSSLStatus() {
  const lastCheck = await run('tail -1 ~/jarvis/logs/ssl-monitor.log 2>/dev/null');
  if (lastCheck.ok && lastCheck.output) {
    return lastCheck.output.replace(/\[.*?\]\s*/, '');
  }
  return 'No endpoints configured';
}

async function getFirewallStatus() {
  const [fwStatus, portCount] = await Promise.all([
    run('sudo ufw status 2>/dev/null | head -1 || echo "ufw not available"'),
    run('ss -tlnp 2>/dev/null | grep LISTEN | wc -l'),
  ]);

  const status = fwStatus.ok ? fwStatus.output : 'Unknown';
  const ports = portCount.ok ? portCount.output.trim() : '?';
  const lastAudit = await run('tail -1 ~/jarvis/logs/firewall-audit.log 2>/dev/null');
  const last = lastAudit.ok && lastAudit.output ? lastAudit.output.replace(/\[.*?\]\s*/, '') : 'No audit yet';

  return `Status: ${code(status)}\nListening ports: ${code(ports)}\nLast: ${last}`;
}

export async function securityCommand(ctx) {
  const placeholder = await ctx.replyWithHTML('<i>Checking security status...</i>');
  const html = await buildSecurity();
  await editOrReply(ctx, placeholder.message_id, html, REFRESH_BTN);
}

export async function securityRefresh(ctx) {
  await ctx.answerCbQuery('Refreshing...');
  const html = await buildSecurity();
  await editOrReply(ctx, ctx.callbackQuery.message.message_id, html, REFRESH_BTN);
}
