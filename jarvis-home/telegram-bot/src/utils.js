import { exec } from 'node:child_process';
import MarkdownIt from 'markdown-it';

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

// --- Telegram HTML renderer powered by markdown-it ---
const md = new MarkdownIt({ linkify: true });
const _rules = md.renderer.rules;
let _listStack = [];

_rules.paragraph_open = () => '';
_rules.paragraph_close = (tokens, idx) => (tokens[idx].hidden ? '' : '\n');

_rules.heading_open = () => '<b>';
_rules.heading_close = () => '</b>\n';

_rules.hr = () => '———\n';

_rules.blockquote_open = () => '<blockquote>';
_rules.blockquote_close = () => '</blockquote>';

_rules.bullet_list_open = () => {
  const nested = _listStack.length > 0;
  _listStack.push({ ordered: false });
  return nested ? '\n' : '';
};
_rules.bullet_list_close = () => { _listStack.pop(); return ''; };
_rules.ordered_list_open = (tokens, idx) => {
  const nested = _listStack.length > 0;
  _listStack.push({ ordered: true, counter: Number(tokens[idx].attrGet('start') || 1) });
  return nested ? '\n' : '';
};
_rules.ordered_list_close = () => { _listStack.pop(); return ''; };
_rules.list_item_open = () => {
  const indent = '  '.repeat(Math.max(0, _listStack.length - 1));
  const item = _listStack[_listStack.length - 1];
  if (item?.ordered) return `${indent}${item.counter++}. `;
  return `${indent}• `;
};
_rules.list_item_close = () => '\n';

_rules.fence = (tokens, idx) => {
  const lang = tokens[idx].info.trim().split(/\s+/)[0];
  const content = escapeHtml(tokens[idx].content.replace(/\n$/, ''));
  if (lang) return `<pre><code class="language-${escapeHtml(lang)}">${content}</code></pre>\n`;
  return `<pre>${content}</pre>\n`;
};
_rules.code_block = (tokens, idx) =>
  `<pre>${escapeHtml(tokens[idx].content.replace(/\n$/, ''))}</pre>\n`;
_rules.code_inline = (tokens, idx) =>
  `<code>${escapeHtml(tokens[idx].content)}</code>`;

_rules.table_open = () => '<pre>';
_rules.table_close = () => '</pre>\n';
_rules.thead_open = () => '';
_rules.thead_close = () => '';
_rules.tbody_open = () => '';
_rules.tbody_close = () => '';
_rules.tr_open = () => '| ';
_rules.tr_close = () => '\n';
_rules.th_open = () => '';
_rules.th_close = () => ' | ';
_rules.td_open = () => '';
_rules.td_close = () => ' | ';

_rules.text = (tokens, idx) => escapeHtml(tokens[idx].content);
_rules.softbreak = () => '\n';
_rules.hardbreak = () => '\n';
_rules.html_block = (tokens, idx) => escapeHtml(tokens[idx].content);
_rules.html_inline = (tokens, idx) => escapeHtml(tokens[idx].content);

_rules.link_open = (tokens, idx) => {
  const href = tokens[idx].attrGet('href') || '';
  return `<a href="${escapeHtml(href)}">`;
};
_rules.link_close = () => '</a>';
_rules.image = (tokens, idx) => {
  const src = tokens[idx].attrGet('src') || '';
  const alt = tokens[idx].children?.reduce((s, t) => s + t.content, '') || 'image';
  return `<a href="${escapeHtml(src)}">${escapeHtml(alt)}</a>`;
};

_rules.strong_open = () => '<b>';
_rules.strong_close = () => '</b>';
_rules.em_open = () => '<i>';
_rules.em_close = () => '</i>';
_rules.s_open = () => '<s>';
_rules.s_close = () => '</s>';

md.renderer.renderToken = () => '';

/**
 * Convert markdown to Telegram-compatible HTML using markdown-it.
 * Supports bold, italic, strikethrough, code, pre (with language),
 * links, blockquotes, lists, tables (as pre), and headings.
 */
export function mdToHtml(text) {
  _listStack = [];
  return md.render(text).replace(/\n{3,}/g, '\n\n').trim();
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
