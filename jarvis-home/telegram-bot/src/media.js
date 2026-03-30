import { run, escapeHtml, editOrReply } from './utils.js';
import { askClaude } from './claude.js';
import { describeImage } from './agents/vision.js';

const HOME = process.env.HOME || '/home/iot';
const MEDIA_DIR = `${HOME}/jarvis/telegram-media`;

async function downloadFile(telegram, fileId, ext = '') {
  await run(`mkdir -p "${MEDIA_DIR}"`);
  try {
    const link = await telegram.getFileLink(fileId);
    const name = `${Date.now()}-${fileId.slice(-8)}${ext}`;
    const filepath = `${MEDIA_DIR}/${name}`;
    const { ok } = await run(`curl -sf -o "${filepath}" "${link.href}"`, { timeout: 60_000 });
    return ok ? filepath : null;
  } catch (err) {
    console.error('File download failed:', err.message);
    return null;
  }
}

async function transcribeVoice(filepath) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const { ok, output } = await run(
    `curl -sf https://api.openai.com/v1/audio/transcriptions ` +
    `-H "Authorization: Bearer ${apiKey}" ` +
    `-F file="@${filepath}" ` +
    `-F model="whisper-1"`,
    { timeout: 30_000 }
  );

  if (!ok) return null;
  try { return JSON.parse(output).text; } catch { return null; }
}

// --- Voice messages (OGG Opus) → transcribe → Claude ---

export async function handleVoice(ctx) {
  const filepath = await downloadFile(ctx.telegram, ctx.message.voice.file_id, '.ogg');
  if (!filepath) return ctx.replyWithHTML('🔴 Failed to download voice note.');

  const placeholder = await ctx.replyWithHTML('🎤 <i>Transcribing...</i>');
  const text = await transcribeVoice(filepath);

  if (!text) {
    return editOrReply(ctx, placeholder.message_id,
      '🔴 Could not transcribe voice note. Is <code>OPENAI_API_KEY</code> set in ~/jarvis/.env?'
    );
  }

  const short = text.length > 200 ? text.slice(0, 197) + '...' : text;
  await ctx.telegram.editMessageText(
    placeholder.chat.id, placeholder.message_id, undefined,
    `🎤 <i>"${escapeHtml(short)}"</i>`,
    { parse_mode: 'HTML' }
  ).catch(() => {});

  return askClaude(ctx, text);
}

// --- Audio files (MP3 etc.) → save + reference ---

export async function handleAudio(ctx) {
  const audio = ctx.message.audio;
  const ext = audio.file_name ? `.${audio.file_name.split('.').pop()}` : '.mp3';
  const filepath = await downloadFile(ctx.telegram, audio.file_id, ext);
  if (!filepath) return ctx.replyWithHTML('🔴 Failed to download audio file.');

  const caption = ctx.message.caption || '';
  const title = audio.title || audio.file_name || 'audio file';
  const prompt = caption
    ? `${caption}\n\n[User sent an audio file "${title}" saved at: ${filepath}]`
    : `[User sent an audio file "${title}" saved at: ${filepath}]`;

  return askClaude(ctx, prompt);
}

// --- Photos → vision analysis → Claude ---

export async function handlePhoto(ctx) {
  const photo = ctx.message.photo.at(-1);
  const filepath = await downloadFile(ctx.telegram, photo.file_id, '.jpg');
  if (!filepath) return ctx.replyWithHTML('🔴 Failed to download photo.');

  const caption = ctx.message.caption || '';
  const placeholder = await ctx.replyWithHTML('👁 <i>Analysing image...</i>');

  const description = await describeImage(filepath, caption || null);

  if (!description) {
    await ctx.telegram.editMessageText(
      placeholder.chat.id, placeholder.message_id, undefined,
      '🔴 Failed to analyse image.', { parse_mode: 'HTML' }
    ).catch(() => {});
    return;
  }

  const short = description.length > 200 ? description.slice(0, 197) + '...' : description;
  await ctx.telegram.editMessageText(
    placeholder.chat.id, placeholder.message_id, undefined,
    `👁 <i>${escapeHtml(short)}</i>`, { parse_mode: 'HTML' }
  ).catch(() => {});

  const prompt = caption
    ? `${caption}\n\n[Image analysis: ${description}]`
    : `[Image analysis: ${description}]`;

  return askClaude(ctx, prompt);
}

// --- Documents → save + reference ---

export async function handleDocument(ctx) {
  const doc = ctx.message.document;
  const filename = doc.file_name || 'file';
  const ext = filename.includes('.') ? `.${filename.split('.').pop()}` : '';
  const filepath = await downloadFile(ctx.telegram, doc.file_id, ext);
  if (!filepath) return ctx.replyWithHTML('🔴 Failed to download document.');

  const caption = ctx.message.caption || '';
  const prompt = caption
    ? `${caption}\n\n[User sent a file "${filename}" saved at: ${filepath}]`
    : `[User sent a file "${filename}" saved at: ${filepath}. Read and analyze it.]`;

  return askClaude(ctx, prompt);
}

// --- Videos → save + reference ---

export async function handleVideo(ctx) {
  const filepath = await downloadFile(ctx.telegram, ctx.message.video.file_id, '.mp4');
  if (!filepath) return ctx.replyWithHTML('🔴 Failed to download video.');

  const caption = ctx.message.caption || '';
  const prompt = caption
    ? `${caption}\n\n[User sent a video saved at: ${filepath}]`
    : `[User sent a video saved at: ${filepath}]`;

  return askClaude(ctx, prompt);
}

// --- Video notes (round videos) → save + reference ---

export async function handleVideoNote(ctx) {
  const filepath = await downloadFile(ctx.telegram, ctx.message.video_note.file_id, '.mp4');
  if (!filepath) return ctx.replyWithHTML('🔴 Failed to download video note.');

  return askClaude(ctx, `[User sent a video note saved at: ${filepath}]`);
}

// --- Animations (GIFs) → save + reference ---

export async function handleAnimation(ctx) {
  const filepath = await downloadFile(ctx.telegram, ctx.message.animation.file_id, '.mp4');
  if (!filepath) return ctx.replyWithHTML('🔴 Failed to download animation.');

  const caption = ctx.message.caption || '';
  const prompt = caption
    ? `${caption}\n\n[User sent a GIF saved at: ${filepath}]`
    : `[User sent a GIF saved at: ${filepath}]`;

  return askClaude(ctx, prompt);
}

// --- Stickers → vision for static, text fallback for animated/video ---

export async function handleSticker(ctx) {
  const sticker = ctx.message.sticker;
  const emoji = sticker.emoji || '';

  if (sticker.is_animated || sticker.is_video) {
    return askClaude(ctx, `[User sent a${sticker.is_animated ? 'n animated' : ' video'} sticker ${emoji}]`);
  }

  const filepath = await downloadFile(ctx.telegram, sticker.file_id, '.webp');
  if (!filepath) {
    return askClaude(ctx, `[User sent a sticker ${emoji}]`);
  }

  const description = await describeImage(filepath, 'Briefly describe this sticker image.');
  const prompt = description
    ? `[User sent a sticker ${emoji}. Image: ${description}]`
    : `[User sent a sticker ${emoji}]`;

  return askClaude(ctx, prompt);
}

// --- Location → text coordinates ---

export async function handleLocation(ctx) {
  const { latitude, longitude } = ctx.message.location;
  return askClaude(ctx, `[User shared a location: latitude ${latitude}, longitude ${longitude}]`);
}

// --- Contact → text details ---

export async function handleContact(ctx) {
  const { first_name, last_name, phone_number } = ctx.message.contact;
  const name = [first_name, last_name].filter(Boolean).join(' ');
  return askClaude(ctx, `[User shared a contact: ${name}, phone: ${phone_number}]`);
}
