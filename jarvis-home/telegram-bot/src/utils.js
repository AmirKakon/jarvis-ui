import { exec } from 'node:child_process';

const TG_MAX_LENGTH = 4096;
const TG_SAFE_LENGTH = 4000; // leave room for tags

export function run(cmd, { timeout = 30_000, cwd } = {}) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, cwd, shell: '/bin/bash' }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, output: stderr?.trim() || err.message });
      } else {
        resolve({ ok: true, output: stdout?.trim() || '' });
      }
    });
  });
}

export function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function pre(text) {
  return `<pre>${escapeHtml(text)}</pre>`;
}

export function bold(text) {
  return `<b>${escapeHtml(text)}</b>`;
}

export function code(text) {
  return `<code>${escapeHtml(text)}</code>`;
}

export function truncate(text, max = TG_SAFE_LENGTH) {
  if (text.length <= max) return text;
  const suffix = '\n\n... (truncated)';
  return text.slice(0, max - suffix.length) + suffix;
}

/**
 * Send a long message, splitting into multiple Telegram messages if needed.
 * Each chunk respects the 4096-char limit.
 */
export async function sendLong(ctx, text, extra = {}) {
  if (text.length <= TG_MAX_LENGTH) {
    return ctx.replyWithHTML(text, extra);
  }

  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= TG_SAFE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf('\n', TG_SAFE_LENGTH);
    if (cut < TG_SAFE_LENGTH / 2) cut = TG_SAFE_LENGTH;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }

  for (const chunk of chunks) {
    await ctx.replyWithHTML(chunk, extra);
  }
}
