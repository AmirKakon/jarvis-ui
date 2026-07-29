import { exec } from 'node:child_process';
import { opusModel, sonnetModel, haikuModel } from '../models.js';

const JARVIS_DIR = process.env.HOME + '/jarvis';

// Timeout by tier — cheaper/faster models get shorter leashes. Resolved by
// comparing against the configured tier IDs so it stays correct even when the
// model IDs are overridden in .env (see models.js).
function timeoutFor(model) {
  if (model === haikuModel()) return 60_000;   // 1 min
  if (model === sonnetModel()) return 120_000; // 2 min
  return 360_000;                              // 6 min (opus/fable/default)
}

// Build the shell command that runs a headless Claude Code agent for `prompt`
// on the given `model`, in the deploy dir. Shared by runOpus (awaited) and the
// background job runner (agents/jobs.js), so both escape/quote identically.
export function claudeCmd(prompt, model = opusModel()) {
  const escaped = prompt.replace(/'/g, "'\\''");
  return {
    cmd: `cd ${JARVIS_DIR} && claude --dangerously-skip-permissions --model ${model} -p '${escaped}'`,
    shell: '/bin/bash',
  };
}

// Run a headless Claude Code agent for a task. `model` selects the tier;
// obvious server ops can run on haiku (cheaper + faster) while complex
// reasoning stays on Opus. Subagents in .claude/agents/ remain available
// to whichever model runs, via the Task tool.
export function runOpus(prompt, model = opusModel()) {
  const timeout = timeoutFor(model);
  return new Promise((resolve) => {
    const { cmd, shell } = claudeCmd(prompt, model);

    exec(cmd, { timeout, shell, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) {
          const mins = Math.round(timeout / 60_000);
          resolve({ ok: false, output: `Claude timed out after ${mins} minute${mins === 1 ? '' : 's'}. Try a simpler question or use a slash command.` });
        } else {
          resolve({ ok: false, output: stderr?.trim() || err.message });
        }
      } else {
        resolve({ ok: true, output: stdout?.trim() || '(no response)' });
      }
    });
  });
}
