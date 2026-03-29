import { readFileSync, writeFileSync, unlinkSync, readdirSync, existsSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { Markup } from 'telegraf';
import { run, bold, code, pre, escapeHtml, sendLong, editOrReply } from '../utils.js';

const HOME = process.env.HOME || '/home/iot';
const PENDING_DIR = HOME + '/jarvis/downloads/pending';
const DOWNLOADS_HOST = HOME + '/shared-storage-2/downloads';
const MOVIES_HOST = HOME + '/shared-storage-2/movies';
const TV_HOST = HOME + '/shared-storage-2/tv-shows';

const pendingEdits = new Map(); // chatId -> { shortHash, timestamp }
const PENDING_EDIT_TTL = 300_000; // 5 minutes
const QBT_URL = () => process.env.QBT_URL || 'http://localhost:20008';
const QBT_USER = () => process.env.QBT_USERNAME || 'admin';
const QBT_PASS = () => process.env.QBT_PASSWORD || '';

let sid = '';
let loginCooldownUntil = 0;

async function diagnoseUnreachable() {
  const { ok: loopback } = await run('ping -c 1 -W 2 127.0.0.1', { timeout: 5_000 });
  if (!loopback) return 'System networking is down entirely.';

  const { ok: containerUp } = await run('docker inspect -f "{{.State.Running}}" qbittorrent', { timeout: 5_000 });
  if (!containerUp) return 'The qBittorrent container is not running. Use /docker start qbittorrent';

  const { ok: gateway } = await run('ping -c 1 -W 2 $(ip route | awk \'/default/ {print $3}\')', { timeout: 5_000 });
  if (!gateway) {
    return 'Network is down — cannot reach the gateway. ' +
      'This is likely the WiFi driver crashing after heavy I/O.\n\n' +
      '<b>Quick fix:</b>\n<code>sudo iw dev wlan0 set power_save off</code>\n' +
      'Or restart networking:\n<code>sudo systemctl restart NetworkManager</code>';
  }

  return null;
}

async function qbtLogin() {
  if (Date.now() < loginCooldownUntil) {
    return false;
  }
  const { ok, output } = await run(
    `curl -s -c - -X POST "${QBT_URL()}/api/v2/auth/login" ` +
    `-d "username=${QBT_USER()}&password=${QBT_PASS()}"`,
    { timeout: 10_000 }
  );
  if (ok && output.includes('SID')) {
    const match = output.match(/SID\s+(\S+)/);
    if (match) sid = match[1];
    loginCooldownUntil = 0;
    return true;
  }
  console.error(`qBT login failed: ok=${ok} output=${output}`);
  loginCooldownUntil = Date.now() + 60_000;
  return false;
}

async function qbtApi(endpoint, method = 'GET', body = null) {
  if (!sid) {
    if (!await qbtLogin()) return { ok: false, output: 'qBittorrent login failed — check credentials in ~/jarvis/.env' };
  }
  const bodyFlag = body ? `-d '${body}'` : '';
  const curlCmd = (sessionId) =>
    `curl -sS -w "\\n%{http_code}" -X ${method} -b "SID=${sessionId}" ` +
    `${bodyFlag} "${QBT_URL()}/api/v2/${endpoint}"`;

  const { ok, output } = await run(curlCmd(sid), { timeout: 15_000 });

  // Extract HTTP status code from last line
  const lines = output.split('\n');
  const httpCode = lines.pop()?.trim();
  const responseBody = lines.join('\n');

  if (httpCode === '403' || (!ok && /403|Forbidden/i.test(output))) {
    sid = '';
    if (!await qbtLogin()) return { ok: false, output: 'qBittorrent session expired and re-login failed' };
    const retry = await run(curlCmd(sid), { timeout: 15_000 });
    return { ok: retry.ok, output: retry.ok ? retry.output.split('\n').slice(0, -1).join('\n') : 'qBittorrent request failed after re-login' };
  }

  if (!ok) {
    const diagnosis = await diagnoseUnreachable();
    return { ok: false, output: diagnosis || 'qBittorrent is unreachable.' };
  }

  return { ok: true, output: responseBody };
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

  const buildAddCmd = (sessionId) => {
    let c = `curl -sS -w "\\n%{http_code}" -X POST -b "SID=${sessionId}" ` +
      `--data-urlencode "urls=${magnetUri}" ` +
      `--data-urlencode "savepath=/downloads" `;
    if (category) c += `--data-urlencode "category=${category}" `;
    c += `"${QBT_URL()}/api/v2/torrents/add"`;
    return c;
  };

  let { ok, output } = await run(buildAddCmd(sid), { timeout: 15_000 });

  // Check for 403 (stale session)
  if (!ok || /403|Forbidden/i.test(output)) {
    sid = '';
    await qbtLogin();
    if (sid) {
      ({ ok, output } = await run(buildAddCmd(sid), { timeout: 15_000 }));
    }
  }

  if (!ok) {
    const diagnosis = await diagnoseUnreachable();
    return editOrReply(ctx, placeholder.message_id,
      `🔴 ${diagnosis || 'Failed to add torrent — qBittorrent unreachable.'}`
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
    return editOrReply(ctx, placeholder.message_id, `🔴 ${escapeHtml(output)}`);
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
    const diagnosis = await diagnoseUnreachable();
    const pingResult = await run(`curl -s -o /dev/null -w "%{http_code}" "${QBT_URL()}/api/v2/app/version"`, { timeout: 5_000 });
    const httpCode = pingResult.ok ? pingResult.output : 'unreachable';
    let msg = `🔴 qBittorrent is unreachable.\n\n` +
      `<b>URL:</b> <code>${escapeHtml(QBT_URL())}</code>\n` +
      `<b>HTTP:</b> <code>${httpCode}</code>\n` +
      `<b>Login SID:</b> <code>${sid ? 'set' : 'none'}</code>`;
    if (diagnosis) msg += `\n\n<b>Diagnosis:</b> ${diagnosis}`;
    return ctx.replyWithHTML(msg);
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

  // Remove torrent from qBittorrent (files already moved, skip for orphans)
  if (meta.hash && !meta.orphan) {
    await qbtApi('torrents/delete', 'POST', `hashes=${meta.hash}&deleteFiles=false`);
  }

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

  const chatId = String(ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id);
  pendingEdits.set(chatId, { shortHash, timestamp: Date.now() });

  await ctx.replyWithHTML(
    `Current destination:\n<code>${escapeHtml(meta.destination)}</code>\n\n` +
    `Reply with the correct full path (under ~/shared-storage-2/), ` +
    `or send the folder structure like:\n<code>tv-shows/Show Name/Season 1</code>`
  );
}

async function handleOrganizeApplyEdit(ctx, shortHash, newPath) {
  const pendingFile = `${PENDING_DIR}/${shortHash}.json`;
  let meta;
  try {
    meta = JSON.parse(readFileSync(pendingFile, 'utf-8'));
  } catch {
    await ctx.replyWithHTML('⚠️ Pending entry expired or not found.');
    return;
  }

  let dest = newPath.trim();
  // If relative path, resolve under shared-storage-2
  if (!dest.startsWith('/')) {
    dest = `${HOME}/shared-storage-2/${dest}`;
  }
  // Append the content name if the user provided a directory path
  const contentName = basename(meta.source_file);
  if (!dest.endsWith(contentName)) {
    dest = dest.replace(/\/+$/, '') + '/' + contentName;
  }

  meta.destination = dest;
  writeFileSync(pendingFile, JSON.stringify(meta, null, 2));

  const shortDest = dest.replace(/.*shared-storage-2\//, '');
  await ctx.replyWithHTML(
    `Updated destination:\n<code>${escapeHtml(shortDest)}</code>`,
    Markup.inlineKeyboard([[
      Markup.button.callback('✅ Confirm', `dl:c:${shortHash}`),
      Markup.button.callback('✏️ Edit', `dl:e:${shortHash}`),
      Markup.button.callback('⏭ Skip', `dl:s:${shortHash}`),
    ]])
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

// --- Organize helpers ---

function titleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

function containerToHostPath(containerPath) {
  return containerPath.replace(/^\/downloads/, DOWNLOADS_HOST);
}

function parseTorrentName(name, containerContentPath, category = '') {
  const hostPath = containerToHostPath(containerContentPath);
  const isDir = existsSync(hostPath) && statSync(hostPath).isDirectory();
  const contentName = basename(hostPath);

  const qualityMatch = name.match(/\d{3,4}p/i);
  const quality = qualityMatch ? qualityMatch[0] : 'unknown';
  const cleanName = name.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();

  // TV show: match SxxExx pattern (single episode)
  const tvMatch = name.match(/[.\s_-][Ss](\d{1,2})[Ee](\d{1,2})/);
  if (tvMatch) {
    const show = titleCase(name.replace(/[.\s_-]*[Ss]\d+[Ee]\d+.*/i, '').replace(/[._]/g, ' ').trim());
    const season = parseInt(tvMatch[1]);
    const episode = parseInt(tvMatch[2]);
    const dest = `${TV_HOST}/${show}/Season ${season}/${contentName}`;
    return { type: 'tv', title: show, season, episode, quality, is_dir: isDir, source_file: hostPath, destination: dest };
  }

  // TV season pack: match Sxx without Exx (e.g. "The.Bear.S01.1080p")
  const seasonPackMatch = name.match(/[.\s_-][Ss](\d{1,2})(?:[.\s_-]|$)(?![Ee]\d)/);
  if (seasonPackMatch) {
    const show = titleCase(name.replace(/[.\s_-]*[Ss]\d+.*/i, '').replace(/[._]/g, ' ').trim());
    const season = parseInt(seasonPackMatch[1]);
    const dest = `${TV_HOST}/${show}/Season ${season}/${contentName}`;
    return { type: 'tv', title: show, season, quality, is_dir: isDir, source_file: hostPath, destination: dest };
  }

  // Movie: match year pattern or use category hint
  const movieMatch = name.match(/[.\s_(-]((?:19[2-9]|20[0-2])\d)[.\s_)-]/);
  if (movieMatch) {
    const title = titleCase(name.replace(/[\s._(-]*(?:19[2-9]|20[0-2])\d.*/i, '').replace(/[._]/g, ' ').trim());
    const year = parseInt(movieMatch[1]);
    const dest = isDir
      ? `${MOVIES_HOST}/${title} (${year})`
      : `${MOVIES_HOST}/${title} (${year})/${contentName}`;
    return { type: 'movie', title, year, quality, is_dir: isDir, source_file: hostPath, destination: dest };
  }

  // No regex match but category was provided -- use it as a hint
  if (category === 'movie') {
    const title = titleCase(cleanName.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim());
    const dest = isDir
      ? `${MOVIES_HOST}/${title}`
      : `${MOVIES_HOST}/${title}/${contentName}`;
    return { type: 'movie', title, quality, is_dir: isDir, source_file: hostPath, destination: dest };
  }
  if (category === 'tv') {
    const title = titleCase(cleanName.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim());
    const dest = `${TV_HOST}/${title}/${contentName}`;
    return { type: 'tv', title, quality, is_dir: isDir, source_file: hostPath, destination: dest };
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

const COMPLETED_STATES = new Set([
  'uploading', 'stalledUP', 'pausedUP', 'queuedUP', 'checkingUP', 'forcedUP',
  'stoppedUP',  // qBittorrent v5+ renamed pausedUP to stoppedUP
]);

function scanOrphanedDownloads(knownTorrents) {
  if (!existsSync(DOWNLOADS_HOST)) return [];

  const knownNames = new Set(knownTorrents.map(t => basename(t.content_path)));
  const entries = [];

  try {
    for (const name of readdirSync(DOWNLOADS_HOST)) {
      if (name.startsWith('.') || knownNames.has(name)) continue;
      const fullPath = `${DOWNLOADS_HOST}/${name}`;
      try {
        const isDir = statSync(fullPath).isDirectory();
        entries.push({ name, path: fullPath, isDir });
      } catch { /* stat failed */ }
    }
  } catch { /* readdir failed */ }

  return entries;
}

async function handleOrganize(ctx) {
  const placeholder = await ctx.replyWithHTML('<i>Scanning for completed downloads...</i>');
  const { ok, output } = await qbtApi('torrents/info');

  if (!ok) {
    const diagnosis = await diagnoseUnreachable();
    const detail = diagnosis || '<i>Try: <code>cd ~/jarvis && docker compose restart qbittorrent</code></i>';
    return editOrReply(ctx, placeholder.message_id, `🔴 qBittorrent unreachable.\n\n${detail}`);
  }

  let torrents;
  try { torrents = JSON.parse(output); } catch {
    return editOrReply(ctx, placeholder.message_id, '🔴 Failed to parse qBT response.');
  }

  const completed = torrents.filter(t => COMPLETED_STATES.has(t.state));

  // Fallback: scan filesystem for orphaned folders not tracked by qBittorrent
  if (!completed.length) {
    const orphans = scanOrphanedDownloads(torrents);
    if (!orphans.length) {
      return editOrReply(ctx, placeholder.message_id, 'No completed downloads to organize.');
    }

    await editOrReply(ctx, placeholder.message_id,
      `Found <b>${orphans.length}</b> orphaned download(s) on disk. Processing...`
    );

    for (const entry of orphans) {
      const fakeHash = Buffer.from(entry.name).toString('hex').slice(0, 40).padEnd(40, '0');
      const shortHash = fakeHash.slice(0, 8);

      let meta = parseTorrentName(entry.name, `/downloads/${entry.name}`, '');
      if (!meta) meta = await claudeParseFallback(entry.name, `/downloads/${entry.name}`);
      if (!meta) {
        meta = {
          type: 'unknown',
          title: entry.name,
          quality: 'unknown',
          is_dir: entry.isDir,
          source_file: entry.path,
          destination: `${DOWNLOADS_HOST}/${entry.name}`,
        };
      }

      meta.hash = fakeHash;
      meta.orphan = true;

      try {
        writeFileSync(`${PENDING_DIR}/${shortHash}.json`, JSON.stringify(meta, null, 2));
      } catch (err) {
        await ctx.replyWithHTML(`🔴 Failed to write pending file for ${escapeHtml(entry.name)}: ${escapeHtml(err.message)}`);
        continue;
      }

      const icon = meta.type === 'tv' ? '📺' : meta.type === 'movie' ? '🎬' : '❓';
      const shortDest = meta.destination.replace(new RegExp(`^${HOME}/`), '');

      await ctx.replyWithHTML(
        [
          `<b>${icon} ${escapeHtml(meta.title)}</b> <i>(orphaned)</i>`,
          `Type: ${meta.type} | Quality: ${meta.quality || 'unknown'}`,
          '',
          `Move to:\n<code>${escapeHtml(shortDest)}</code>`,
        ].join('\n'),
        Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Confirm', `dl:c:${shortHash}`),
            Markup.button.callback('✏️ Edit path', `dl:e:${shortHash}`),
            Markup.button.callback('⏭ Skip', `dl:s:${shortHash}`),
          ],
        ])
      );
    }
    return;
  }

  await editOrReply(ctx, placeholder.message_id,
    `Found <b>${completed.length}</b> completed download(s). Processing...`
  );

  for (const t of completed) {
    const shortHash = t.hash.slice(0, 8);

    let meta = parseTorrentName(t.name, t.content_path, t.category);
    if (!meta) meta = await claudeParseFallback(t.name, t.content_path);

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

    meta.hash = t.hash;

    try {
      writeFileSync(`${PENDING_DIR}/${shortHash}.json`, JSON.stringify(meta, null, 2));
    } catch (err) {
      await ctx.replyWithHTML(`🔴 Failed to write pending file for ${escapeHtml(t.name)}: ${escapeHtml(err.message)}`);
      continue;
    }

    const icon = meta.type === 'tv' ? '📺' : meta.type === 'movie' ? '🎬' : '❓';
    const shortDest = meta.destination.replace(new RegExp(`^${HOME}/`), '');

    await ctx.replyWithHTML(
      [
        `<b>${icon} ${escapeHtml(meta.title)}</b>`,
        `Type: ${meta.type} | Quality: ${meta.quality || 'unknown'}`,
        '',
        `<b>Move to:</b>`,
        `<code>${escapeHtml(shortDest)}</code>`,
      ].join('\n'),
      Markup.inlineKeyboard([[
        Markup.button.callback('✅ Confirm', `dl:c:${shortHash}`),
        Markup.button.callback('✏️ Edit', `dl:e:${shortHash}`),
        Markup.button.callback('⏭ Skip', `dl:s:${shortHash}`),
      ]])
    );
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
        'Send a hash, Stremio URL, or magnet link.',
        'Append <code>movie</code> or <code>tv</code> for category.',
        '',
        bold('Input formats:'),
        '• 40-char info hash',
        '• Stremio streaming URL',
        '• Magnet link',
      ].join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback('📋 Downloads', 'dl:cmd:list'),
         Markup.button.callback('📡 Status', 'dl:cmd:status')],
        [Markup.button.callback('📂 Organize Completed', 'dl:cmd:organize')],
      ])
    );
  }

  if (sub === 'list' || sub === 'ls') return handleList(ctx);
  if (sub === 'status') return handleStatus(ctx);
  if (sub === 'organize' || sub === 'org') return handleOrganize(ctx);

  // Treat everything else as a torrent to add
  const input = args[0];
  const category = args[1]?.toLowerCase();
  const validCategories = ['movie', 'tv'];
  return handleAdd(ctx, input, validCategories.includes(category) ? category : '');
}

export function handlePendingDownloadEdit(ctx) {
  const chatId = String(ctx.chat?.id);
  const pending = pendingEdits.get(chatId);
  if (!pending) return false;
  if (Date.now() - pending.timestamp > PENDING_EDIT_TTL) {
    pendingEdits.delete(chatId);
    return false;
  }
  pendingEdits.delete(chatId);
  handleOrganizeApplyEdit(ctx, pending.shortHash, ctx.message.text).catch((err) =>
    console.error('Download edit failed:', err.message)
  );
  return true;
}

export async function downloadCallback(ctx) {
  const data = ctx.match[1];

  // Sub-command buttons from /download help
  const cmdMatch = data.match(/^cmd:(.+)$/);
  if (cmdMatch) {
    await ctx.answerCbQuery();
    if (cmdMatch[1] === 'list') return handleList(ctx);
    if (cmdMatch[1] === 'status') return handleStatus(ctx);
    if (cmdMatch[1] === 'organize') return handleOrganize(ctx);
    return;
  }

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
  if (!ok) {
    const diagnosis = await diagnoseUnreachable();
    const detail = diagnosis ? `\n\n${diagnosis}` : '';
    return ctx.replyWithHTML(`🔴 qBittorrent unreachable.${detail}`);
  }

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
