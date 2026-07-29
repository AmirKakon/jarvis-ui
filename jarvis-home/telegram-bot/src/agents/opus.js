import { exec } from 'node:child_process';

const JARVIS_DIR = process.env.HOME + '/jarvis';

const DEFAULT_MODEL = 'claude-opus-5';

// Per-model timeouts — cheaper/faster models get shorter leashes.
const MODEL_TIMEOUTS = {
  'claude-opus-5': 360_000,            // 6 min
  'claude-sonnet-5': 120_000,          // 2 min
  'claude-haiku-4-5-20251001': 60_000, // 1 min
};

// Build the shell command that runs a headless Claude Code agent for `prompt`
// on the given `model`, in the deploy dir. Shared by runOpus (awaited) and the
// background job runner (agents/jobs.js), so both escape/quote identically.
export function claudeCmd(prompt, model = DEFAULT_MODEL) {
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
export function runOpus(prompt, model = DEFAULT_MODEL) {
  const timeout = MODEL_TIMEOUTS[model] || MODEL_TIMEOUTS[DEFAULT_MODEL];
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
