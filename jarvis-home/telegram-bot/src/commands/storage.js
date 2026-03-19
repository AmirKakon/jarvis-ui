import { run, bold, pre, sendLong } from '../utils.js';

export async function storageCommand(ctx) {
  const [df, lsblk] = await Promise.all([
    run('df -h / /home/iot/shared-storage /home/iot/shared-storage-2 2>/dev/null'),
    run('lsblk -o NAME,SIZE,TYPE,MOUNTPOINT 2>/dev/null'),
  ]);

  const lines = [bold('Storage Overview'), ''];

  if (df.ok) {
    lines.push(bold('Disk Usage'));
    lines.push(pre(df.output));
  }

  if (lsblk.ok) {
    lines.push('');
    lines.push(bold('Block Devices'));
    lines.push(pre(lsblk.output));
  }

  await sendLong(ctx, lines.join('\n'));
}
