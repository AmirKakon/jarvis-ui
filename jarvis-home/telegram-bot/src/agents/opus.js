import { opusModel, sonnetModel, haikuModel } from '../models.js';
import { runClaudeAgent } from './claude-agent.js';

// Delegated agents run in the deploy dir, so its CLAUDE.md, rules and
// .claude/agents subagents apply. Read lazily: HOME comes from the service env.
export const jarvisDir = () => `${process.env.HOME}/jarvis`;

// Timeout by tier — cheaper/faster models get shorter leashes. Resolved by
// comparing against the configured tier IDs so it stays correct even when the
// model IDs are overridden in .env (see models.js).
function timeoutFor(model) {
  if (model === haikuModel()) return 60_000;   // 1 min
  if (model === sonnetModel()) return 120_000; // 2 min
  return 360_000;                              // 6 min (opus/fable/default)
}

// Run a Claude Code agent for a task and wait for it. `model` selects the tier;
// obvious server ops can run on haiku (cheaper + faster) while complex
// reasoning stays on Opus. Subagents in .claude/agents/ remain available
// to whichever model runs, via the Task tool.
export async function runOpus(prompt, model = opusModel()) {
  const timeoutMs = timeoutFor(model);
  const res = await runClaudeAgent({ prompt, model, cwd: jarvisDir(), timeoutMs });
  if (res.status === 'timeout') {
    const mins = Math.round(timeoutMs / 60_000);
    return { ok: false, output: `Claude timed out after ${mins} minute${mins === 1 ? '' : 's'}. Try a simpler question or use a slash command.` };
  }
  return { ok: res.ok, output: res.output };
}
