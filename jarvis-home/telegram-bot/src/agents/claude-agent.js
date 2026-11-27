// In-process Claude Code agent (Claude Agent SDK) for delegated server tasks,
// /deep and self-development. Replaces shelling out to `claude -p`: no prompt
// quoting, no PATH dependency on a global CLI, and the safety rules that used
// to be prompt text are enforced by a PreToolUse hook.

import { posix } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const DESTRUCTIVE_BASH = [
  [/\brm\b[^;&|]*\s(?:\/\*?|~\/?\*?|\$HOME\/?\*?|\$\{HOME\}\/?\*?|\/home\/iot\/?\*?)(?=\s|$|[;&|])/, 'deletes the root or home directory'],
  [/\bmkfs(?:\.\w+)?\b/, 'formats a filesystem'],
  [/\bdd\b[^;&|]*\bof=\/dev\//, 'writes raw data to a device'],
  [/>\s*\/dev\/(?:sd|nvme|mmcblk|hd)\w*/, 'writes raw data to a device'],
  [/(?:^|[;&|]\s*|\bsudo\s+)(?:shutdown|reboot|poweroff|halt)\b/, 'powers off or reboots the server'],
  [/\bsystemctl\s+(?:reboot|poweroff|halt)\b/, 'powers off or reboots the server'],
  [/:\(\)\s*\{/, 'is a fork bomb'],
];

const GIT_WRITE = /\bgit\s+(?:commit|push|reset|checkout|switch|add|rm|mv|rebase|merge|stash|clean|restore|tag|branch\s+-[dD])\b/;
const SERVICE_CONTROL = /\bsystemctl\s+(?:--user\s+)?(?:start|stop|restart|reload|enable|disable|kill)\b/;

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const isEnvFile = (p) => /(?:^|\/)\.env(?:\.[\w.-]+)?$/.test(p) && !/\.example$/.test(p);

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Blocked by JARVIS safety rules: ${reason}.`,
    },
  };
}

/**
 * PreToolUse guard.
 *   writeRoot   when set, file edits must stay under this absolute path
 *   editOnly    self-development: no git writes and no service start/stop
 */
export function toolGuard({ writeRoot = null, editOnly = false } = {}) {
  return async (input) => {
    const tool = input?.tool_name;
    const args = input?.tool_input || {};

    if (tool === 'Bash') {
      const command = String(args.command || '');
      for (const [pattern, why] of DESTRUCTIVE_BASH) {
        if (pattern.test(command)) return deny(`the command ${why}`);
      }
      if (editOnly && GIT_WRITE.test(command)) return deny('git changes are made by the self-development orchestrator, not the editor');
      if (editOnly && SERVICE_CONTROL.test(command)) return deny('services are not started or stopped during a code edit');
      return {};
    }

    if (WRITE_TOOLS.has(tool)) {
      const raw = String(args.file_path || args.notebook_path || '');
      const target = posix.resolve(input.cwd || '/', raw.replace(/\\/g, '/'));
      if (isEnvFile(target)) return deny('.env files are never edited automatically');
      if (writeRoot && target !== writeRoot && !target.startsWith(`${writeRoot.replace(/\/$/, '')}/`)) {
        return deny(`edits must stay under ${writeRoot}`);
      }
    }
    return {};
  };
}

/**
 * Run a Claude Code agent in-process. Always resolves (never rejects) to
 * { ok, output, status } with status ∈ 'done' | 'failed' | 'timeout'.
 */
export async function runClaudeAgent({ prompt, model, cwd, timeoutMs, guard = toolGuard(), queryFn = query }) {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  const stderr = [];

  try {
    const messages = queryFn({
      prompt,
      options: {
        model,
        cwd,
        abortController,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        hooks: { PreToolUse: [{ hooks: [guard], onFailure: 'block' }] },
        stderr: (data) => { stderr.push(data); if (stderr.length > 50) stderr.shift(); },
      },
    });

    for await (const msg of messages) {
      if (msg.type !== 'result') continue;
      if (msg.subtype === 'success' && !msg.is_error) {
        return { ok: true, output: msg.result?.trim() || '(no response)', status: 'done' };
      }
      const detail = msg.errors?.join('\n') || msg.result || msg.subtype;
      return { ok: false, output: detail, status: 'failed' };
    }
    return { ok: false, output: stderr.join('').trim() || 'The agent ended without a result.', status: 'failed' };
  } catch (err) {
    if (abortController.signal.aborted) return { ok: false, output: '', status: 'timeout' };
    return { ok: false, output: stderr.join('').trim() || err?.message || String(err), status: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}
