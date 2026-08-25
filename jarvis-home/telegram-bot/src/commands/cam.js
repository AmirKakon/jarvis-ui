import { escapeHtml } from '../utils.js';

const DEFAULT_WEBCAM_SNAPSHOT = 'http://127.0.0.1:20011/snapshot';

export function webcamSnapshotUrl() {
  return process.env.WEBCAM_SNAPSHOT_URL || process.env.GO2RTC_URL || DEFAULT_WEBCAM_SNAPSHOT;
}

export async function grabWebcamJpeg() {
  const url = webcamSnapshotUrl();
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) {
    throw new Error(`ustreamer ${res.status} from ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error('snapshot too small');
  return buf;
}

export async function sendWebcamPhoto(telegram, chatId, caption) {
  const buf = await grabWebcamJpeg();
  await telegram.sendPhoto(chatId, { source: buf, filename: 'webcam.jpg' }, {
    caption: caption || 'Mini-PC webcam',
  });
  return buf.length;
}

export async function pushWebcamToTelegram(caption) {
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  if (!token || !chatId) throw new Error('TG_BOT_TOKEN or TG_CHAT_ID missing');

  const buf = await grabWebcamJpeg();
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption || 'Mini-PC webcam');
  form.append('photo', new Blob([buf], { type: 'image/jpeg' }), 'webcam.jpg');

  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`telegram ${res.status} ${text.slice(0, 180)}`);
  }
  return buf.length;
}

export async function camCommand(ctx) {
  try {
    await ctx.sendChatAction('upload_photo').catch(() => {});
    await sendWebcamPhoto(ctx.telegram, ctx.chat.id, 'Live still from the mini-PC webcam');
  } catch (err) {
    console.error('[cam]', err.message);
    await ctx.replyWithHTML(
      `🔴 Could not grab a frame. Is ustreamer up?\n<pre>${escapeHtml(err.message)}</pre>`
    );
  }
}
