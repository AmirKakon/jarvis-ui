import { run, bold, pre, sendLong } from '../utils.js';

export async function networkCommand(ctx) {
  const [addrs, ports] = await Promise.all([
    run('ip -br addr'),
    run('ss -tlnp 2>/dev/null | head -30'),
  ]);

  const lines = [bold('Network Overview'), ''];

  if (addrs.ok) {
    lines.push(bold('Interfaces'));
    lines.push(pre(addrs.output));
  }

  if (ports.ok) {
    lines.push('');
    lines.push(bold('Listening Ports'));
    lines.push(pre(ports.output));
  }

  await sendLong(ctx, lines.join('\n'));
}
