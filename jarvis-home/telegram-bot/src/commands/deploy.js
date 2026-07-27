// Deploy gate for self-development commits.
//
// After JARVIS commits a self-edit (see agents/selfdev.js), the Telegram layer
// offers a one-tap Deploy button. Pressing it redeploys the running code and
// restarts the bot's own systemd service. Because a restart would kill the
// process handling this very callback, the redeploy runs in an INDEPENDENT
// transient systemd unit (systemd-run --user), so it survives our restart.
//
// Callback scheme (namespaced `dep:`):
//   dep:go:<id>  redeploy + restart (runs setup.sh detached)
//   dep:x:<id>   dismiss (leave the commit on the branch, deploy nothing)

import crypto from 'node:crypto';
import { run, escapeHtml, code } from '../utils.js';
import { repoDir } from '../agents/selfdev.js';

// id → { branch, prevSha, newSha } (short-lived, in-memory).
const pending = new Map();

export function registerDeploy(info) {
  const id = crypto.randomBytes(5).toString('hex');
  pending.set(id, { ...info, ts: Date.now() });
  // Bound the map — drop entries older than 24h on each insert.
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, v] of pending) if (v.ts < cutoff) pending.delete(k);
  return id;
}

export function getDeploy(id) {
  return pending.get(id) || null;
}

// Fire the redeploy in a detached transient unit so it outlives our restart.
async function triggerRedeploy(branch) {
  const repo = repoDir();
  const logFile = `${process.env.HOME}/jarvis/logs/self-deploy.log`;
  const inner = `cd ${repo} && git pull --ff-only origin ${branch} && bash jarvis-home/setup.sh`;

  // Prefer systemd-run (own cgroup, survives the bot's restart). Fall back to
  // setsid+nohup if systemd-run is unavailable.
  const hasSystemdRun = await run('command -v systemd-run', { timeout: 10_000 });
  let cmd;
  if (hasSystemdRun.ok && hasSystemdRun.output.trim()) {
    const unit = `jarvis-selfdeploy-${Date.now()}`;
    cmd = `systemd-run --user --collect --unit=${unit} bash -lc '${inner} >> ${logFile} 2>&1'`;
  } else {
    cmd = `setsid bash -lc '${inner} >> ${logFile} 2>&1' >/dev/null 2>&1 < /dev/null &`;
  }
  return run(cmd, { timeout: 20_000 });
}

export async function deployCallback(ctx) {
  const action = ctx.match[1];
  const id = ctx.match[2];
  const info = getDeploy(id);

  if (!info) {
    return ctx.answerCbQuery('This deploy request has expired, Sir.');
  }

  if (action === 'x') {
    pending.delete(id);
    await ctx.answerCbQuery('Dismissed');
    try { await ctx.editMessageReplyMarkup(undefined); } catch { /* ignore */ }
    return ctx.replyWithHTML(
      `Left on <b>${escapeHtml(info.branch)}</b> without deploying, Sir. ` +
      `The change is committed (${code(info.newSha.slice(0, 8))}) but not live.`
    );
  }

  // action === 'go' → deploy
  pending.delete(id);
  await ctx.answerCbQuery('Deploying...');
  try { await ctx.editMessageReplyMarkup(undefined); } catch { /* ignore */ }

  const res = await triggerRedeploy(info.branch);
  if (!res.ok) {
    return ctx.replyWithHTML(`🔴 Couldn't start the redeploy, Sir:\n${escapeHtml(res.output.slice(-400))}`);
  }

  return ctx.replyWithHTML(
    `🚀 Redeploying <b>${escapeHtml(info.branch)}</b> now, Sir — I'll restart in a few seconds. ` +
    `If I don't come back, roll back with:\n${code(`git -C ${repoDir()} reset --hard ${info.prevSha.slice(0, 12)} && bash ${repoDir()}/jarvis-home/setup.sh`)}`
  );
}
