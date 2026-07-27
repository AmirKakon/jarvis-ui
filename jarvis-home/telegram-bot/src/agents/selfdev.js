// Self-development agent — lets JARVIS modify its own source code.
//
// Flow: a headless `claude` agent edits files under the repo's jarvis-home/
// directory, then this orchestrator syntax-checks the changed files, commits,
// and pushes to the CURRENTLY CHECKED-OUT branch (whatever the server deploys
// from). Deployment (redeploy + self-restart) is a separate, user-gated step —
// see commands/deploy.js.
//
// Safety posture:
//   - Opt-in only: disabled unless SELFDEV_ENABLED=true.
//   - Aborts if the working tree already has uncommitted jarvis-home changes
//     (so we never commit unrelated work-in-progress).
//   - Syntax-checks every changed .js (node --check) and .sh (bash -n); reverts
//     and refuses to commit if anything fails.
//   - Records the pre-change commit SHA so a bad change can be rolled back.
//   - Only ever touches paths under jarvis-home/ (git ops are pathspec-scoped).
//   - Never commits straight to a protected branch without you: it commits to
//     the current branch, but the actual deploy is behind a one-tap button.

import { exec } from 'node:child_process';
import { run } from '../utils.js';

const DEFAULT_MODEL = 'claude-opus-4-8';
const SELFDEV_TIMEOUT = 15 * 60 * 1000; // 15 min — code edits are slow

// Lazy env reads so .env values loaded at startup are respected.
export function repoDir() {
  return process.env.JARVIS_REPO_DIR || `${process.env.HOME}/repos/jarvis-ui`;
}
function jarvisHomeDir() {
  return `${repoDir()}/jarvis-home`;
}
function selfDevEnabled() {
  return String(process.env.SELFDEV_ENABLED || '').toLowerCase() === 'true';
}
function selfDevModel() {
  return process.env.SELFDEV_MODEL || DEFAULT_MODEL;
}

// One self-edit at a time — git operations must not race.
let inProgress = false;

const SELFDEV_INSTRUCTIONS = (task) => `You are editing the JARVIS codebase. The current working directory is the jarvis-home/ folder of the jarvis-ui repository — this is your own source code.

Make the change requested below.

STRICT RULES:
- Only modify files inside the current directory (jarvis-home/). NEVER touch the repository's backend/, frontend/, or n8n/ folders.
- Keep the change minimal and focused on the request. Do not refactor unrelated code.
- Match the existing code style and conventions (see CLAUDE.md).
- Do NOT run any git commands. Do NOT commit or push. The orchestrator handles that.
- Do NOT restart, stop, or start any services.
- Do NOT edit .env or any secrets.
- When done, write a short summary (2-4 sentences) of exactly which files you changed and why.

REQUESTED CHANGE:
${task}`;

// Run the headless claude editor. Resolves { ok, output }.
function runEditor(task) {
  const model = selfDevModel();
  const prompt = SELFDEV_INSTRUCTIONS(task);
  return new Promise((resolve) => {
    const escaped = prompt.replace(/'/g, "'\\''");
    const cmd = `cd ${jarvisHomeDir()} && claude --dangerously-skip-permissions --model ${model} -p '${escaped}'`;
    exec(cmd, { timeout: SELFDEV_TIMEOUT, shell: '/bin/bash', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) {
          const mins = Math.round(SELFDEV_TIMEOUT / 60_000);
          resolve({ ok: false, output: `The code edit timed out after ${mins} minutes.` });
        } else {
          resolve({ ok: false, output: stderr?.trim() || err.message });
        }
      } else {
        resolve({ ok: true, output: stdout?.trim() || '(no summary returned)' });
      }
    });
  });
}

// Parse `git status --porcelain` into changed file paths (repo-relative),
// resolving renames to their new path. Only jarvis-home/ paths are returned.
function parseChangedPaths(porcelain) {
  const paths = [];
  for (const raw of porcelain.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.length < 4) continue;
    let p = line.slice(3);
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4); // rename: take the destination
    p = p.replace(/^"|"$/g, '');
    if (p.startsWith('jarvis-home/')) paths.push(p);
  }
  return paths;
}

// Syntax-check one file based on extension. Returns { ok, output }.
async function syntaxCheck(repo, relPath) {
  if (relPath.endsWith('.js') || relPath.endsWith('.mjs')) {
    return run(`node --check "${relPath}"`, { cwd: repo, timeout: 30_000 });
  }
  if (relPath.endsWith('.sh')) {
    return run(`bash -n "${relPath}"`, { cwd: repo, timeout: 30_000 });
  }
  return { ok: true, output: '' }; // non-code file — nothing to check
}

// Push the current branch. Uses GIT_PUSH_TOKEN via an inline credential helper
// (keeps the token out of argv and out of .git/config) when set; otherwise
// relies on whatever credentials git already has (SSH key / cached https).
async function pushBranch(repo, branch) {
  const token = process.env.GIT_PUSH_TOKEN;
  if (token) {
    // The helper reads the password from the environment, so the token never
    // appears in the command line. `-c credential.helper=` first clears any
    // pre-configured helper so ours is the only one consulted.
    const helper = `!f() { echo username=x-access-token; echo "password=$GIT_PUSH_TOKEN"; }; f`;
    const cmd = `git -c credential.helper= -c credential.helper='${helper}' push origin ${branch} 2>&1`;
    return run(cmd, { cwd: repo, timeout: 60_000 });
  }
  return run(`git push origin ${branch} 2>&1`, { cwd: repo, timeout: 60_000 });
}

// Main entry: make a self-edit, verify, commit, push.
//
// Returns:
//   { ok, output, deploy?: { branch, prevSha, newSha, pushed } }
// `deploy` is present only on a successful commit; the Telegram layer uses it
// to offer a Deploy button.
export async function runSelfDev(task) {
  if (!selfDevEnabled()) {
    return { ok: false, output: 'Self-modification is disabled, Sir. Set SELFDEV_ENABLED=true in ~/jarvis/.env to allow me to edit my own code.' };
  }
  if (!task || !task.trim()) {
    return { ok: false, output: 'No change was described, Sir.' };
  }
  if (inProgress) {
    return { ok: false, output: 'I am already working on a code change, Sir. One at a time.' };
  }

  inProgress = true;
  const repo = repoDir();
  try {
    // Repo sanity + branch/SHA capture.
    const branchRes = await run('git rev-parse --abbrev-ref HEAD', { cwd: repo, timeout: 15_000 });
    if (!branchRes.ok) {
      return { ok: false, output: `I couldn't read the repository at ${repo}, Sir: ${branchRes.output}` };
    }
    const branch = branchRes.output.trim();
    const prevShaRes = await run('git rev-parse HEAD', { cwd: repo, timeout: 15_000 });
    const prevSha = prevShaRes.output.trim();

    // Refuse if jarvis-home already has uncommitted changes — we won't risk
    // sweeping unrelated work into our commit.
    const dirty = await run('git status --porcelain -- jarvis-home', { cwd: repo, timeout: 15_000 });
    if (dirty.ok && dirty.output.trim()) {
      return { ok: false, output: 'The repository already has uncommitted changes under jarvis-home/, Sir. Commit or discard them first, then ask me again.' };
    }

    // Let claude make the edit.
    console.log(`[selfdev] Editing (${selfDevModel()}) on branch ${branch}: ${task.slice(0, 100)}`);
    const edit = await runEditor(task);
    if (!edit.ok) {
      await run('git checkout -- jarvis-home', { cwd: repo, timeout: 20_000 });
      return { ok: false, output: `The edit didn't complete, Sir: ${edit.output}` };
    }

    // What changed?
    const status = await run('git status --porcelain -- jarvis-home', { cwd: repo, timeout: 15_000 });
    const changed = parseChangedPaths(status.output || '');
    if (!changed.length) {
      return { ok: false, output: `I didn't end up changing any files, Sir.\n\n${edit.output}` };
    }

    // Syntax-check every changed code file; revert everything on any failure.
    const codeFiles = changed.filter((p) => /\.(js|mjs|sh)$/.test(p));
    for (const rel of codeFiles) {
      const check = await syntaxCheck(repo, rel);
      if (!check.ok) {
        await run('git checkout -- jarvis-home', { cwd: repo, timeout: 20_000 });
        await run('git clean -fd -- jarvis-home', { cwd: repo, timeout: 20_000 });
        return { ok: false, output: `Syntax check failed on ${rel}, so I reverted the change, Sir:\n${check.output.slice(-500)}` };
      }
    }

    // Commit (pathspec-scoped to jarvis-home) and push.
    const shortTask = task.trim().replace(/\s+/g, ' ').slice(0, 60);
    const msg = `jarvis: ${shortTask}`.replace(/'/g, "'\\''");
    const add = await run('git add -- jarvis-home', { cwd: repo, timeout: 20_000 });
    if (!add.ok) {
      await run('git checkout -- jarvis-home', { cwd: repo, timeout: 20_000 });
      return { ok: false, output: `Failed to stage the change, Sir: ${add.output}` };
    }
    const commit = await run(`git commit -m '${msg}'`, { cwd: repo, timeout: 20_000 });
    if (!commit.ok) {
      return { ok: false, output: `Failed to commit, Sir: ${commit.output}` };
    }
    const newSha = (await run('git rev-parse HEAD', { cwd: repo, timeout: 15_000 })).output.trim();

    const push = await pushBranch(repo, branch);
    const pushed = push.ok;

    const stat = await run(`git diff --stat ${prevSha} HEAD -- jarvis-home`, { cwd: repo, timeout: 15_000 });

    const parts = [
      edit.output.trim(),
      '',
      `📦 Committed to **${branch}** (${newSha.slice(0, 8)})`,
      pushed ? '⬆️ Pushed to origin.' : `⚠️ Commit is local only — push failed: ${push.output.slice(-200)}`,
    ];
    if (stat.ok && stat.output.trim()) {
      parts.push('', stat.output.trim());
    }

    return {
      ok: true,
      output: parts.join('\n'),
      deploy: { branch, prevSha, newSha, pushed },
    };
  } catch (err) {
    return { ok: false, output: `Self-development failed, Sir: ${err.message}` };
  } finally {
    inProgress = false;
  }
}
