import { run, bold, pre, sendLong } from '../utils.js';

export async function statusCommand(ctx) {
  await ctx.replyWithHTML(`${bold('Gathering system health...')}`);

  const [uptime, mem, disk, docker, load] = await Promise.all([
    run('uptime -p'),
    run('free -h --si | head -3'),
    run('df -h / --output=size,used,avail,pcent | tail -1'),
    run('docker ps --format "{{.Names}}|{{.Status}}" 2>/dev/null'),
    run("cat /proc/loadavg | awk '{print $1, $2, $3}'"),
  ]);

  const lines = [];
  lines.push(bold('System Status'));
  lines.push('');

  if (uptime.ok) lines.push(`<b>Uptime:</b> ${uptime.output.replace('up ', '')}`);
  if (load.ok) lines.push(`<b>Load:</b> ${load.output}`);

  if (mem.ok) {
    lines.push('');
    lines.push(bold('Memory'));
    lines.push(pre(mem.output));
  }

  if (disk.ok) {
    const parts = disk.output.trim().split(/\s+/);
    const pct = parseInt(parts[3], 10);
    const warn = pct > 90 ? ' ⚠️' : '';
    lines.push(`<b>Root disk:</b> ${parts[1]} / ${parts[0]} (${parts[3]} used)${warn}`);
  }

  if (docker.ok && docker.output) {
    lines.push('');
    lines.push(bold('Docker Containers'));
    const containers = docker.output.split('\n').map((line) => {
      const [name, status] = line.split('|');
      const icon = status?.toLowerCase().includes('up') ? '🟢' : '🔴';
      return `  ${icon} ${name}`;
    });
    lines.push(containers.join('\n'));
  }

  await sendLong(ctx, lines.join('\n'));
}
