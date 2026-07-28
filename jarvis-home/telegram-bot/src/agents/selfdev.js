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
import { existsSync } from 'node:fs';
import { run } from '../utils.js';

const DEFAULT_MODEL = 'claude-opus-4-8';
const SELFDEV_TIMEOUT = 15 * 60 * 1000; // 15 min — code edits are slow

// Lazy env reads so .env values loaded at startup are respected.
export function repoDir() {
  return process.env.JARVIS_REPO_DIR || `${process.env.HOME}/repos/jarvis-ui`;
}
function selfDevEnabled() {
  return String(process.env.SELFDEV_ENABLED || '').toLowerCase() === 'true';
}
function selfDevModel() {
  return process.env.SELFDEV_MODEL || DEFAULT_MODEL;
}

// One self-edit at a time — git operations must not race.
let inProgress = false;

const SELFDEV_INSTRUCTIONS = (task, absDir) => `You are editing the JARVIS source code, which lives in a git repository. Your current working directory IS the project root for this edit:

    ${absDir}

Every file you may change — scripts, the Telegram bot, prompts, agents — lives HERE, under this directory.

CRITICAL LOCATION RULES (read carefully):
- Edit ONLY files under ${absDir}, using paths relative to it (e.g. scripts/samba-monitor.sh, telegram-bot/src/agents/foo.js).
- This directory is the GIT REPO checkout — the source of truth. There is ALSO a generated deploy copy at /home/iot/jarvis (aka ~/jarvis). NEVER edit anything under /home/iot/jarvis or ~/jarvis: those files are overwritten from this repo on every deploy, so edits there are silently thrown away.
- If CLAUDE.md, the rules, or any note tells you files live in ~/jarvis or /home/iot/jarvis, IGNORE that for the purpose of THIS edit — always edit the copy here in ${absDir}.
- Do NOT touch the repository's backend/, frontend/, or n8n/ folders.

TASK RULES:
- Keep the change minimal and focused on the request. Do not refactor unrelated code.
- Match the existing code style and conventions.
- Do NOT run any git commands. Do NOT commit or push. The orchestrator handles that.
- Do NOT restart, stop, or start any services. Do NOT edit .env or any secrets.
- When done, write a short summary (2-4 sentences) naming exactly which files (relative paths) you changed and why.

REQUESTED CHANGE:
${task}`;

// Run the headless claude editor in `absDir`. Resolves { ok, output }.
function runEditor(task, absDir) {
  const model = selfDevModel();
  const prompt = SELFDEV_INSTRUCTIONS(task, absDir);
  return new Promise((resolve) => {
    const escaped = prompt.replace(/'/g, "'\\''");
    const cmd = `cd ${absDir} && claude --dangerously-skip-permissions --model ${model} -p '${escaped}'`;
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
// resolving renames to their new path. Returns ALL paths (caller filters).
function parseChangedPaths(porcelain) {
  const paths = [];
  for (const raw of porcelain.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.length < 4) continue;
    let p = line.slice(3);
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4); // rename: take the destination
    p = p.replace(/^"|"$/g, '');
    paths.push(p);
  }
  return paths;
}

// Syntax-check one changed file. `rel` is whatever `git status` reported; it may
// be repo-root-relative ("jarvis-home/scripts/x.sh") or jarvis-home-relative
// ("scripts/x.sh") depending on git's cwd behaviour, so we normalise it to an
// ABSOLUTE path (no cwd dependence) before checking. Returns { ok, output }.
async function syntaxCheck(root, rel) {
  const relFromHome = rel.startsWith('jarvis-home/') ? rel.slice('jarvis-home/'.length) : rel;
  const abs = `${root}/jarvis-home/${relFromHome}`;
  if (!existsSync(abs)) return { ok: true, output: '' }; // deleted/moved — nothing to check
  if (abs.endsWith('.js') || abs.endsWith('.mjs')) {
    return run(`node --check "${abs}"`, { cwd: root, timeout: 30_000 });
  }
  if (abs.endsWith('.sh')) {
    return run(`bash -n "${abs}"`, { cwd: root, timeout: 30_000 });
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
  try {
    // Resolve the TRUE repo root, so every git command prints repo-root-relative
    // paths deterministically (git otherwise prints paths relative to cwd, which
    // made prefix checks unreliable). Works even if JARVIS_REPO_DIR points at a
    // subdirectory of the repo.
    const topRes = await run('git rev-parse --show-toplevel', { cwd: repoDir(), timeout: 15_000 });
    if (!topRes.ok || !topRes.output.trim()) {
      return { ok: false, output: `I couldn't find a git repository at ${repoDir()}, Sir: ${topRes.output}` };
    }
    const root = topRes.output.trim();
    const absHome = `${root}/jarvis-home`;

    const branch = (await run('git rev-parse --abbrev-ref HEAD', { cwd: root, timeout: 15_000 })).output.trim();
    const prevSha = (await run('git rev-parse HEAD', { cwd: root, timeout: 15_000 })).output.trim();

    // Refuse if jarvis-home already has uncommitted changes — we won't risk
    // sweeping unrelated work into our commit.
    const dirty = await run('git status --porcelain -- jarvis-home', { cwd: root, timeout: 15_000 });
    if (dirty.ok && dirty.output.trim()) {
      return { ok: false, output: 'The repository already has uncommitted changes under jarvis-home/, Sir. Discard them from a shell first (git -C ~/repos/jarvis-ui checkout -- jarvis-home), then ask me again.' };
    }

    // Let claude make the edit (cwd = the repo's jarvis-home).
    console.log(`[selfdev] Editing (${selfDevModel()}) on branch ${branch}: ${task.slice(0, 100)}`);
    const edit = await runEditor(task, absHome);
    if (!edit.ok) {
      await run('git checkout -- jarvis-home', { cwd: root, timeout: 20_000 });
      return { ok: false, output: `The edit didn't complete, Sir: ${edit.output}` };
    }

    // What changed under jarvis-home? Pathspec-scoped + run from the repo root,
    // so reported paths are repo-root-relative (jarvis-home/...).
    const status = await run('git status --porcelain -- jarvis-home', { cwd: root, timeout: 15_000 });
    const changed = parseChangedPaths(status.output || '');
    if (!changed.length) {
      return { ok: false, output: `I didn't change any files in my source tree, Sir — the edit may have gone somewhere outside the repo. Nothing was committed.\n\n${edit.output}` };
    }

    // Syntax-check every changed code file; revert everything on any failure.
    const codeFiles = changed.filter((p) => /\.(js|mjs|sh)$/.test(p));
    for (const rel of codeFiles) {
      const check = await syntaxCheck(root, rel);
      if (!check.ok) {
        await run('git checkout -- jarvis-home', { cwd: root, timeout: 20_000 });
        await run('git clean -fd -- jarvis-home', { cwd: root, timeout: 20_000 });
        return { ok: false, output: `Syntax check failed on ${rel}, so I reverted the change, Sir:\n${check.output.slice(-500)}` };
      }
    }

    // Commit (pathspec-scoped to jarvis-home) and push.
    const shortTask = task.trim().replace(/\s+/g, ' ').slice(0, 60);
    const msg = `jarvis: ${shortTask}`.replace(/'/g, "'\\''");
    const add = await run('git add -- jarvis-home', { cwd: root, timeout: 20_000 });
    if (!add.ok) {
      await run('git checkout -- jarvis-home', { cwd: root, timeout: 20_000 });
      return { ok: false, output: `Failed to stage the change, Sir: ${add.output}` };
    }
    const commit = await run(`git commit -m '${msg}'`, { cwd: root, timeout: 20_000 });
    if (!commit.ok) {
      return { ok: false, output: `Failed to commit, Sir: ${commit.output}` };
    }
    const newSha = (await run('git rev-parse HEAD', { cwd: root, timeout: 15_000 })).output.trim();

    const push = await pushBranch(root, branch);
    const pushed = push.ok;

    const stat = await run(`git diff --stat ${prevSha} HEAD -- jarvis-home`, { cwd: root, timeout: 15_000 });

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
