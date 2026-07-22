import { run } from '../utils.js';

/**
 * Canonical system-health collector.
 *
 * Single source of truth for the shell probes behind both the `/status`
 * command (detailed view) and the daily briefing's health line (compact view).
 * Gathers a superset of metrics once so the two surfaces can't drift apart.
 *
 * @returns {Promise<{
 *   uptime: string|null,
 *   load: { one: string, five: string, fifteen: string }|null,
 *   mem: { block: string, pct: number|null }|null,
 *   disk: { size: string, used: string, avail: string, pct: number }|null,
 *   containers: Array<{ name: string, status: string, up: boolean }>,
 * }>}
 */
export async function collectHealth() {
  const [uptime, load, memBlock, memPct, disk, docker] = await Promise.all([
    run('uptime -p'),
    run("cat /proc/loadavg | awk '{print $1, $2, $3}'"),
    run('free -h --si | head -3'),
    run("free -m --si | awk '/Mem:/ {printf \"%d\", $3/$2*100}'"),
    run('df -h / --output=size,used,avail,pcent | tail -1'),
    run('docker ps -a --format "{{.Names}}|{{.Status}}" 2>/dev/null'),
  ]);

  const health = { uptime: null, load: null, mem: null, disk: null, containers: [] };

  if (uptime.ok && uptime.output) {
    health.uptime = uptime.output.replace('up ', '').trim();
  }

  if (load.ok && load.output) {
    const [one, five, fifteen] = load.output.trim().split(/\s+/);
    health.load = { one, five, fifteen };
  }

  if (memBlock.ok && memBlock.output) {
    const pct = memPct.ok ? parseInt(memPct.output.trim(), 10) : NaN;
    health.mem = { block: memBlock.output, pct: Number.isFinite(pct) ? pct : null };
  }

  if (disk.ok && disk.output) {
    const [size, used, avail, pcent] = disk.output.trim().split(/\s+/);
    health.disk = { size, used, avail, pct: parseInt(pcent, 10) };
  }

  if (docker.ok && docker.output) {
    health.containers = docker.output.split('\n').filter(Boolean).map((line) => {
      const [name, status = ''] = line.split('|');
      return { name, status, up: status.toLowerCase().includes('up') };
    });
  }

  return health;
}
