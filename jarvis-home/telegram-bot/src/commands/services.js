import { run, bold, pre, sendLong } from '../utils.js';

export async function servicesCommand(ctx) {
  const [userUnits, sysUnits, failedUser, failedSys] = await Promise.all([
    run('systemctl --user list-units --type=service --state=running --no-pager --no-legend'),
    run('sudo systemctl list-units --type=service --state=running --no-pager --no-legend'),
    run('systemctl --user list-units --state=failed --no-pager --no-legend'),
    run('sudo systemctl list-units --state=failed --no-pager --no-legend'),
  ]);

  const lines = [bold('Services'), ''];

  const failedLines = [failedUser.output, failedSys.output].filter(Boolean).join('\n');
  if (failedLines) {
    lines.push('🔴 <b>Failed Services</b>');
    lines.push(pre(failedLines));
    lines.push('');
  }

  if (userUnits.ok && userUnits.output) {
    lines.push(bold('User Services (running)'));
    const names = userUnits.output
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean);
    lines.push(pre(names.join('\n')));
    lines.push('');
  }

  if (sysUnits.ok && sysUnits.output) {
    lines.push(bold('System Services (running)'));
    const names = sysUnits.output
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean)
      .slice(0, 30); // cap to avoid massive output
    lines.push(pre(names.join('\n')));
  }

  await sendLong(ctx, lines.join('\n'));
}
