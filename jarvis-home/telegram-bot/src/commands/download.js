import { readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { Markup } from 'telegraf';
import { run, bold, code, pre, escapeHtml, sendLong, editOrReply } from '../utils.js';

const PENDING_DIR = (process.env.HOME || '/home/iot') + '/jarvis/downloads/pending';
const QBT_URL = () => process.env.QBT_URL || 'http://localhost:20007';
const QBT_USER = () => process.env.QBT_USERNAME || 'admin';
const QBT_PASS = () => process.env.QBT_PASSWORD || '';

let sid = '';

async function qbtLogin() {
  const { ok, output } = await run(
    `curl -sf -c - -X POST "${QBT_URL()}/api/v2/auth/login" ` +
    `-d "username=${QBT_USER()}&password=${QBT_PASS()}"`,
    { timeout: 10_000 }
  );
  if (ok && output.includes('SID')) {
    const match = output.match(/SID\s+(\S+)/);
    if (match) sid = match[1];
    return true;
  }
  return false;
}

async function qbtApi(endpoint, method = 'GET', body = null) {
  if (!sid) await qbtLogin();
  const bodyFlag = body ? `-d '${body}'` : '';
  const { ok, output } = await run(
    `curl -sf -X ${method} -b "SID=${sid}" ` +
    `${bodyFlag} "${QBT_URL()}/api/v2/${endpoint}"`,
    { timeout: 15_000 }
  );
  if (!ok && output.includes('403')) {
    await qbtLogin();
    const retry = await run(
      `curl -sf -X ${method} -b "SID=${sid}" ` +
      `${bodyFlag} "${QBT_URL()}/api/v2/${endpoint}"`,
      { timeout: 15_000 }
    );
    return retry;
  }
  return { ok, output };
}

function extractHash(input) {
  const hex40 = input.match(/\b([a-fA-F0-9]{40})\b/);
  if (hex40) return hex40[1].toLowerCase();

  const magnetHash = input.match(/btih:([a-fA-F0-9]{40})/i);
  if (magnetHash) return magnetHash[1].toLowerCase();

  return null;
}

function buildMagnet(hash) {
  return `magnet:?xt=urn:btih:${hash}`;
}

function progressBar(progress) {
  const pct = Math.round(progress * 100);
  const filled = Math.round(pct / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  return `${bar} ${pct}%`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

async function handleAdd(ctx, input, category) {
  const isMagnet = input.startsWith('magnet:');
  let magnetUri;

  if (isMagnet) {
    magnetUri = input;
  } else {
    const hash = extractHash(input);
    if (!hash) {
      return ctx.replyWithHTML(
        '🔴 Could not extract info hash.\n\n' +
        'Accepted formats:\n' +
        '• Info hash: <code>c4f64729...</code> (40 hex chars)\n' +
        '• Stremio URL: <code>http://127.0.0.1:11470/HASH/file.mp4</code>\n' +
        '• Magnet link: <code>magnet:?xt=urn:btih:...</code>'
      );
    }
    magnetUri = buildMagnet(hash);
  }

  const placeholder = await ctx.replyWithHTML('<i>Adding torrent...</i>');

  let body = `urls=${encodeURIComponent(magnetUri)}`;
  if (category) body += `&category=${encodeURIComponent(category)}`;
  body += '&savepath=/downloads';

  const { ok, output } = await qbtApi('torrents/add', 'POST', body);

  if (!ok) {
    return editOrReply(ctx, placeholder.message_id,
      `🔴 Failed to add torrent:\n${pre(output || 'qBittorrent unreachable')}`
    );
  }

  const hash = extractHash(input) || 'unknown';
  const catInfo = category ? ` (${category})` : '';
  return editOrReply(ctx, placeholder.message_id,
    `🟢 Torrent added${catInfo}\n\nHash: ${code(hash)}\n\nUse /download list to check progress.`
  );
}

async function handleList(ctx) {
  const placeholder = await ctx.replyWithHTML('<i>Fetching downloads...</i>');
  const { ok, output } = await qbtApi('torrents/info');

  if (!ok) {
    return editOrReply(ctx, placeholder.message_id,
      `🔴 qBittorrent unreachable:\n${pre(output || 'Connection refused')}`
    );
  }

  let torrents;
  try {
    torrents = JSON.parse(output);
  } catch {
    return editOrReply(ctx, placeholder.message_id, '🔴 Failed to parse response.');
  }

  if (!torrents.length) {
    return editOrReply(ctx, placeholder.message_id, 'No active downloads.');
  }

  const lines = [bold('Downloads'), ''];
  for (const t of torrents.slice(0, 15)) {
    const icon = t.state === 'uploading' || t.state === 'stalledUP' ? '🟢' :
                 t.state === 'downloading' || t.state === 'stalledDL' ? '⬇️' :
                 t.state === 'pausedDL' || t.state === 'pausedUP' ? '⏸' : '⚪';
    const name = escapeHtml(t.name.length > 40 ? t.name.slice(0, 37) + '...' : t.name);
    const bar = progressBar(t.progress);
    const size = formatSize(t.size);
    const speed = t.dlspeed > 0 ? ` ⬇${formatSize(t.dlspeed)}/s` : '';
    lines.push(`${icon} ${name}`);
    lines.push(`   ${bar} ${size}${speed}`);
    lines.push('');
  }

  if (torrents.length > 15) {
    lines.push(`<i>...and ${torrents.length - 15} more</i>`);
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh', 'x:download')],
  ]);

  return editOrReply(ctx, placeholder.message_id, lines.join('\n'), keyboard);
}

async function handleStatus(ctx) {
  const { ok, output } = await qbtApi('app/version');
  if (!ok) {
    return ctx.replyWithHTML('🔴 qBittorrent is unreachable.');
  }
  const version = output.trim();
  const { ok: ok2, output: info } = await qbtApi('transfer/info');
  let transferInfo = '';
  if (ok2) {
    try {
      const t = JSON.parse(info);
      transferInfo = `\n⬇️ ${formatSize(t.dl_info_speed)}/s  ⬆️ ${formatSize(t.up_info_speed)}/s`;
    } catch { /* ignore */ }
  }
  return ctx.replyWithHTML(`🟢 qBittorrent ${code(version)}${transferInfo}`);
}

async function handleOrganizeConfirm(ctx, shortHash) {
  const pendingFile = `${PENDING_DIR}/${shortHash}.json`;
  let meta;
  try {
    meta = JSON.parse(readFileSync(pendingFile, 'utf-8'));
  } catch {
    await ctx.answerCbQuery('Pending entry not found');
    return;
  }

  await ctx.answerCbQuery('Moving file...');

  const dest = meta.destination;
  const destDir = dest.replace(/\/[^/]+$/, '');
  const src = meta.source_file;

  const { ok, output } = await run(
    `mkdir -p "${destDir}" && mv "${src}" "${dest}"`,
    { timeout: 30_000 }
  );

  if (!ok) {
    return ctx.replyWithHTML(`🔴 Move failed:\n${pre(output)}`);
  }

  try { unlinkSync(pendingFile); } catch { /* ignore */ }

  // Trigger Jellyfin library scan if configured
  await run(
    'curl -sf -X POST "http://localhost:20001/Library/Refresh" ' +
    '-H "X-Emby-Token: ${JELLYFIN_TOKEN:-}" 2>/dev/null',
    { timeout: 10_000 }
  );

  const shortDest = dest.replace(/.*shared-storage-2\//, '');
  await editOrReply(
    ctx,
    ctx.callbackQuery?.message?.message_id,
    `🟢 <b>Organized</b>\n\nMoved to:\n<code>${escapeHtml(shortDest)}</code>`
  );
}

async function handleOrganizeEdit(ctx, shortHash) {
  const pendingFile = `${PENDING_DIR}/${shortHash}.json`;
  let meta;
  try {
    meta = JSON.parse(readFileSync(pendingFile, 'utf-8'));
  } catch {
    await ctx.answerCbQuery('Pending entry not found');
    return;
  }

  await ctx.answerCbQuery('Send the correct path');

  // Store that we're waiting for a path edit
  ctx._downloadEditHash = shortHash;

  await ctx.replyWithHTML(
    `Current destination:\n<code>${escapeHtml(meta.destination)}</code>\n\n` +
    `Reply with the correct full path (under ~/shared-storage-2/), ` +
    `or send the folder structure like:\n<code>tv-shows/Show Name/Season 1</code>`
  );
}

async function handleOrganizeSkip(ctx, shortHash) {
  const pendingFile = `${PENDING_DIR}/${shortHash}.json`;
  try { unlinkSync(pendingFile); } catch { /* ignore */ }
  await ctx.answerCbQuery('Skipped');
  await editOrReply(
    ctx,
    ctx.callbackQuery?.message?.message_id,
    '⏭ <b>Skipped</b> — file left in downloads folder.'
  );
}

export async function downloadCommand(ctx) {
  const text = (ctx.message.text || '').replace(/^\/download\s*/, '').trim();
  const args = text.split(/\s+/);
  const sub = args[0]?.toLowerCase();

  if (!sub || sub === 'help') {
    return ctx.replyWithHTML(
      [
        bold('Media Downloads'),
        '',
        bold('Add torrent:'),
        '/download &lt;hash|url|magnet&gt;',
        '/download &lt;hash&gt; movie',
        '/download &lt;hash&gt; tv',
        '',
        bold('Manage:'),
        '/download list — active downloads',
        '/download status — qBittorrent health',
        '',
        bold('Input formats:'),
        '• 40-char info hash',
        '• Stremio streaming URL',
        '• Magnet link',
      ].join('\n')
    );
  }

  if (sub === 'list' || sub === 'ls') return handleList(ctx);
  if (sub === 'status') return handleStatus(ctx);

  // Treat everything else as a torrent to add
  const input = args[0];
  const category = args[1]?.toLowerCase();
  const validCategories = ['movie', 'tv'];
  return handleAdd(ctx, input, validCategories.includes(category) ? category : '');
}

export async function downloadCallback(ctx) {
  const data = ctx.match[1];
  const match = data.match(/^([ces]):(.+)$/);
  if (!match) {
    await ctx.answerCbQuery('Unknown action');
    return;
  }

  const action = match[1];
  const shortHash = match[2];

  if (action === 'c') return handleOrganizeConfirm(ctx, shortHash);
  if (action === 'e') return handleOrganizeEdit(ctx, shortHash);
  if (action === 's') return handleOrganizeSkip(ctx, shortHash);
}

export async function downloadRefresh(ctx) {
  await ctx.answerCbQuery('Refreshing...');
  const { ok, output } = await qbtApi('torrents/info');
  if (!ok) return ctx.replyWithHTML('🔴 qBittorrent unreachable.');

  let torrents;
  try {
    torrents = JSON.parse(output);
  } catch {
    return ctx.replyWithHTML('🔴 Failed to parse response.');
  }

  if (!torrents.length) {
    return editOrReply(ctx, ctx.callbackQuery?.message?.message_id, 'No active downloads.');
  }

  const lines = [bold('Downloads'), ''];
  for (const t of torrents.slice(0, 15)) {
    const icon = t.state === 'uploading' || t.state === 'stalledUP' ? '🟢' :
                 t.state === 'downloading' || t.state === 'stalledDL' ? '⬇️' :
                 t.state === 'pausedDL' || t.state === 'pausedUP' ? '⏸' : '⚪';
    const name = escapeHtml(t.name.length > 40 ? t.name.slice(0, 37) + '...' : t.name);
    const bar = progressBar(t.progress);
    const size = formatSize(t.size);
    const speed = t.dlspeed > 0 ? ` ⬇${formatSize(t.dlspeed)}/s` : '';
    lines.push(`${icon} ${name}`);
    lines.push(`   ${bar} ${size}${speed}`);
    lines.push('');
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh', 'x:download')],
  ]);

  return editOrReply(ctx, ctx.callbackQuery?.message?.message_id, lines.join('\n'), keyboard);
}
