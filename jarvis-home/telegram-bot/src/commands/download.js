import { readFileSync, writeFileSync, unlinkSync, readdirSync, existsSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { Markup } from 'telegraf';
import { run, bold, code, pre, escapeHtml, sendLong, editOrReply } from '../utils.js';

const HOME = process.env.HOME || '/home/iot';
const PENDING_DIR = HOME + '/jarvis/downloads/pending';
const PROCESSED_FILE = HOME + '/jarvis/downloads/processed.json';
const DOWNLOADS_HOST = HOME + '/shared-storage-2/downloads';
const MOVIES_HOST = HOME + '/shared-storage-2/movies';
const TV_HOST = HOME + '/shared-storage-2/tv-shows';
const QBT_URL = () => process.env.QBT_URL || 'http://localhost:20008';
const QBT_USER = () => process.env.QBT_USERNAME || 'admin';
const QBT_PASS = () => process.env.QBT_PASSWORD || '';

let sid = '';

async function qbtLogin() {
  const { ok, output } = await run(
    `curl -s -c - -X POST "${QBT_URL()}/api/v2/auth/login" ` +
    `-d "username=${QBT_USER()}&password=${QBT_PASS()}"`,
    { timeout: 10_000 }
  );
  if (ok && output.includes('SID')) {
    const match = output.match(/SID\s+(\S+)/);
    if (match) sid = match[1];
    return true;
  }
  console.error(`qBT login failed: ok=${ok} output=${output}`);
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
  let hash;

  if (isMagnet) {
    hash = extractHash(input);
  } else {
    hash = extractHash(input);
  }

  if (!hash) {
    return ctx.replyWithHTML(
      '🔴 Could not extract info hash.\n\n' +
      'Accepted formats:\n' +
      '• Info hash: <code>c4f64729...</code> (40 hex chars)\n' +
      '• Stremio URL: <code>http://127.0.0.1:11470/HASH/file.mp4</code>\n' +
      '• Magnet link: <code>magnet:?xt=urn:btih:...</code>'
    );
  }

  const magnetUri = isMagnet ? input : buildMagnet(hash);
  const placeholder = await ctx.replyWithHTML('<i>Adding torrent...</i>');

  if (!sid) await qbtLogin();

  let cmd = `curl -sf -X POST -b "SID=${sid}" ` +
    `--data-urlencode "urls=${magnetUri}" ` +
    `--data-urlencode "savepath=/downloads" `;
  if (category) cmd += `--data-urlencode "category=${category}" `;
  cmd += `"${QBT_URL()}/api/v2/torrents/add"`;

  let { ok, output } = await run(cmd, { timeout: 15_000 });

  if (!ok && (output.includes('403') || output.includes('Forbidden'))) {
    await qbtLogin();
    cmd = cmd.replace(/SID=[^"]*/, `SID=${sid}`);
    ({ ok, output } = await run(cmd, { timeout: 15_000 }));
  }

  if (!ok) {
    return editOrReply(ctx, placeholder.message_id,
      `🔴 Failed to add torrent:\n${pre(output || 'qBittorrent unreachable')}`
    );
  }

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
    const pingResult = await run(`curl -s -o /dev/null -w "%{http_code}" "${QBT_URL()}/api/v2/app/version"`, { timeout: 5_000 });
    const httpCode = pingResult.ok ? pingResult.output : 'unreachable';
    return ctx.replyWithHTML(
      `🔴 qBittorrent is unreachable.\n\n` +
      `<b>URL:</b> <code>${escapeHtml(QBT_URL())}</code>\n` +
      `<b>HTTP:</b> <code>${httpCode}</code>\n` +
      `<b>Login SID:</b> <code>${sid ? 'set' : 'none'}</code>`
    );
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

  await ctx.answerCbQuery('Moving...');

  const dest = meta.destination;
  const src = meta.source_file;
  const isDir = meta.is_dir === true || meta.is_dir === 'true';

  let moveCmd;
  if (isDir) {
    moveCmd = `mkdir -p "$(dirname "${dest}")" && mv "${src}" "${dest}"`;
  } else {
    const destDir = dest.replace(/\/[^/]+$/, '');
    moveCmd = `mkdir -p "${destDir}" && mv "${src}" "${dest}"`;
  }

  const { ok, output } = await run(moveCmd, { timeout: 30_000 });

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

// --- Completion watcher ---

function titleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

function containerToHostPath(containerPath) {
  return containerPath.replace(/^\/downloads/, DOWNLOADS_HOST);
}

function parseTorrentName(name, containerContentPath) {
  const hostPath = containerToHostPath(containerContentPath);
  const isDir = existsSync(hostPath) && statSync(hostPath).isDirectory();
  const contentName = basename(hostPath);

  const qualityMatch = name.match(/\d{3,4}p/i);
  const quality = qualityMatch ? qualityMatch[0] : 'unknown';

  // TV show: match SxxExx
  const tvMatch = name.match(/[.\s_-][Ss](\d{1,2})[Ee](\d{1,2})/);
  if (tvMatch) {
    const show = titleCase(name.replace(/[.\s_-]*[Ss]\d+[Ee]\d+.*/i, '').replace(/[._]/g, ' ').trim());
    const season = parseInt(tvMatch[1]);
    const episode = parseInt(tvMatch[2]);
    const dest = `${TV_HOST}/${show}/Season ${season}/${contentName}`;
    return { type: 'tv', title: show, season, episode, quality, is_dir: isDir, source_file: hostPath, destination: dest };
  }

  // Movie: match year (1920-2029)
  const movieMatch = name.match(/[.\s_-]((?:19[2-9]|20[0-2])\d)[.\s_-]/);
  if (movieMatch) {
    const title = titleCase(name.replace(/[.\s_-]*(?:19[2-9]|20[0-2])\d.*/i, '').replace(/[._]/g, ' ').trim());
    const year = parseInt(movieMatch[1]);
    const dest = isDir
      ? `${MOVIES_HOST}/${title} (${year})`
      : `${MOVIES_HOST}/${title} (${year})/${contentName}`;
    return { type: 'movie', title, year, quality, is_dir: isDir, source_file: hostPath, destination: dest };
  }

  return null;
}

async function claudeParseFallback(torrentName, containerContentPath) {
  const hostPath = containerToHostPath(containerContentPath);
  const isDir = existsSync(hostPath) && statSync(hostPath).isDirectory();
  const contentName = basename(hostPath);

  const prompt = `Parse this torrent filename and return ONLY a JSON object (no markdown, no explanation):
"${torrentName}"

Return exactly this JSON structure:
{
  "type": "movie" or "tv",
  "title": "Clean Title Name",
  "year": 2024,
  "season": 1,
  "episode": 5,
  "quality": "720p",
  "is_dir": ${isDir},
  "source_file": "${hostPath}",
  "destination": "(fill: for movies use ${MOVIES_HOST}/<Title> (<Year>)${isDir ? '' : '/<filename>'}; for tv use ${TV_HOST}/<Title>/Season <N>/${contentName})"
}

Omit year for TV, omit season/episode for movies.`;

  const escaped = prompt.replace(/'/g, "'\\''");
  const { ok, output } = await run(
    `cd ${HOME}/jarvis && claude --dangerously-skip-permissions --model claude-haiku-4-20250514 -p '${escaped}' 2>/dev/null`,
    { timeout: 60_000 }
  );

  if (!ok) return null;

  const jsonMatch = output.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return null;

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

function loadProcessed() {
  try {
    return new Set(JSON.parse(readFileSync(PROCESSED_FILE, 'utf-8')));
  } catch {
    return new Set();
  }
}

function saveProcessed(processed) {
  try {
    writeFileSync(PROCESSED_FILE, JSON.stringify([...processed]));
  } catch (err) {
    console.error(`Failed to save processed hashes: ${err.message}`);
  }
}

const COMPLETED_STATES = new Set(['uploading', 'stalledUP', 'pausedUP', 'queuedUP', 'checkingUP', 'forcedUP']);
let watcherInterval = null;

export function startCompletionWatcher(bot, chatId) {
  const processed = loadProcessed();
  console.log(`Download watcher started (${processed.size} previously processed torrents)`);

  watcherInterval = setInterval(async () => {
    try {
      const { ok, output } = await qbtApi('torrents/info');
      if (!ok) return;

      let torrents;
      try { torrents = JSON.parse(output); } catch { return; }

      for (const t of torrents) {
        if (!COMPLETED_STATES.has(t.state)) continue;
        if (processed.has(t.hash)) continue;

        processed.add(t.hash);
        saveProcessed(processed);

        const shortHash = t.hash.slice(0, 8);

        let meta = parseTorrentName(t.name, t.content_path);

        if (!meta) {
          meta = await claudeParseFallback(t.name, t.content_path);
        }

        if (!meta) {
          const hostPath = containerToHostPath(t.content_path);
          const isDir = existsSync(hostPath) && statSync(hostPath).isDirectory();
          meta = {
            type: 'unknown',
            title: t.name,
            quality: 'unknown',
            is_dir: isDir,
            source_file: hostPath,
            destination: `${DOWNLOADS_HOST}/${basename(hostPath)}`,
          };
        }

        try {
          writeFileSync(`${PENDING_DIR}/${shortHash}.json`, JSON.stringify(meta, null, 2));
        } catch (err) {
          console.error(`Failed to write pending file: ${err.message}`);
          continue;
        }

        const icon = meta.type === 'tv' ? '📺' : meta.type === 'movie' ? '🎬' : '❓';
        const shortDest = meta.destination.replace(new RegExp(`^${HOME}/`), '');
        const msg = [
          `<b>${icon} Download Complete</b>`,
          '',
          `<b>Title:</b> ${escapeHtml(meta.title)}`,
          `<b>Type:</b> ${meta.type}`,
          `<b>Quality:</b> ${meta.quality || 'unknown'}`,
          '',
          `<b>Move to:</b>`,
          `<code>${escapeHtml(shortDest)}</code>`,
          '',
          'Tap below to confirm or edit.',
        ].join('\n');

        const keyboard = {
          inline_keyboard: [[
            { text: '✅ Confirm', callback_data: `dl:c:${shortHash}` },
            { text: '✏️ Edit', callback_data: `dl:e:${shortHash}` },
            { text: '⏭ Skip', callback_data: `dl:s:${shortHash}` },
          ]],
        };

        try {
          await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch (err) {
          console.error(`Failed to send completion notification: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`Watcher error: ${err.message}`);
    }
  }, 60_000);
}

export function stopCompletionWatcher() {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
  }
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
