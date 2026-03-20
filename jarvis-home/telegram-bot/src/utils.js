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

const CB_MAX = 64;

/**
 * Build callback data string, safely truncating to Telegram's 64-byte limit.
 * Returns null if the prefix alone exceeds the limit (skip the button).
 */
export function cbData(prefix, id) {
  const full = `${prefix}${id}`;
  if (Buffer.byteLength(full, 'utf-8') <= CB_MAX) return full;
  const prefixLen = Buffer.byteLength(prefix, 'utf-8');
  if (prefixLen >= CB_MAX) return null;
  const available = CB_MAX - prefixLen;
  let truncated = id;
  while (Buffer.byteLength(truncated, 'utf-8') > available) {
    truncated = truncated.slice(0, -1);
  }
  return `${prefix}${truncated}`;
}

/**
 * Convert Claude's markdown output to Telegram-compatible HTML.
 * Handles fenced code blocks, inline code, bold, headers, and preserves lists.
 */
export function mdToHtml(text) {
  const lines = text.split('\n');
  const out = [];
  let inCodeBlock = false;
  let codeBuffer = [];

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        out.push(`<pre>${escapeHtml(codeBuffer.join('\n'))}</pre>`);
        codeBuffer = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    let converted = escapeHtml(line);
    converted = converted.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    converted = converted.replace(/__(.+?)__/g, '<b>$1</b>');
    converted = converted.replace(/`([^`]+)`/g, '<code>$1</code>');
    if (/^#{1,3}\s+/.test(line)) {
      const heading = converted.replace(/^#{1,3}\s+/, '');
      converted = `<b>${heading}</b>`;
    }

    out.push(converted);
  }

  if (codeBuffer.length) {
    out.push(`<pre>${escapeHtml(codeBuffer.join('\n'))}</pre>`);
  }

  return out.join('\n');
}

/**
 * Edit an existing message with new HTML content.
 * Falls back to sending a new message if edit fails.
 */
export async function editOrReply(ctx, messageId, html, extra = {}) {
  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      messageId,
      undefined,
      html,
      { parse_mode: 'HTML', ...extra }
    );
  } catch {
    await ctx.replyWithHTML(html, extra);
  }
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
