import { exec } from 'node:child_process';

const JARVIS_DIR = process.env.HOME + '/jarvis';
const OPUS_TIMEOUT = 360_000; // 6 minutes

export function runOpus(prompt) {
  return new Promise((resolve) => {
    const escaped = prompt.replace(/'/g, "'\\''");
    const cmd = `cd ${JARVIS_DIR} && claude --dangerously-skip-permissions --model claude-opus-4-20250514 -p '${escaped}' 2>/dev/null`;

    exec(cmd, { timeout: OPUS_TIMEOUT, shell: '/bin/bash', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) {
          resolve({ ok: false, output: 'Claude timed out after 6 minutes. Try a simpler question or use a slash command.' });
        } else {
          resolve({ ok: false, output: stderr?.trim() || err.message });
        }
      } else {
        resolve({ ok: true, output: stdout?.trim() || '(no response)' });
      }
    });
  });
}
