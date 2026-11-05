// Phone-call surface for JARVIS (Twilio Programmable Voice).
//
// Call the Twilio number (e.g. from the Gear S watch, which calls through the
// phone) and talk to the SAME brain as Telegram and Alexa. Twilio does the speech
// recognition (<Gather input="speech">) and text-to-speech (<Say>); this module
// turns each recognised sentence into an answerForVoice() turn and replies with
// TwiML that speaks the answer and listens again, so a call is a conversation.
//
// Call flow (both routes are Twilio webhooks, POST form-encoded):
//   POST /voice       — call comes in: reject unknown callers (before answering, so
//                       they cost nothing), else "Yes, Sir?" and listen.
//   POST /voice/turn  — Twilio's recognised speech in SpeechResult: answer, then
//                       listen again. Silence → "Anything else, Sir?" once, then
//                       hang up; "goodbye" / "that will be all" hangs up.
//
// Slow answers: Twilio waits ~15s for a webhook, so a turn answers within
// VOICE_INLINE_BUDGET_MS, else says so and the answer arrives in Telegram (which
// mirrors to the watch). Answers too long to read out are cut at a sentence and
// sent to Telegram in full.
//
// Security: every request must carry a valid X-Twilio-Signature (HMAC-SHA1 of the
// public URL + POST params with the account's auth token), and only callers in
// VOICE_ALLOWED_CALLERS are answered. Caller ID can be spoofed, so the signature
// proves the request came from Twilio, not who is on the line.
//
// Config (~/jarvis/.env):
//   TWILIO_AUTH_TOKEN        required — enables /voice; used to verify signatures
//   VOICE_PUBLIC_URL         required — origin Twilio calls, e.g.
//                            https://kakischer.duckdns.org:20443 (signatures cover it)
//   VOICE_ALLOWED_CALLERS    required — CSV of caller numbers in E.164 (+9725…)
//   VOICE_LANGUAGE           speech recognition language (default en-US; he-IL for Hebrew)
//   VOICE_TTS_VOICE          Twilio <Say> voice (default Polly.Brian-Neural, British)
//   VOICE_INLINE_BUDGET_MS   time to answer inline before deferring (default 10000, max 13000)
//   JARVIS_IDENTITY_MAP      add phone:*=<user> to share the session with Telegram/Alexa

import crypto from 'node:crypto';
import { answerForVoice, cleanForSpeech } from './alexa.js';

const MAX_SPOKEN = 700;
const DEFAULT_BUDGET_MS = 10_000;
const MAX_BUDGET_MS = 13_000;
const DEFERRED_ACK = "That will take a moment, Sir. I'll send the answer to Telegram.";
const GOODBYE_RE = /^(good ?bye|bye|bye bye|that will be all|that's all|thats all|hang up|dismiss|ביי|להתראות)$/i;

const csv = (raw) => (raw || '').split(',').map((s) => s.trim()).filter(Boolean);

function normalizeNumber(raw) {
  const digits = String(raw || '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  return digits.startsWith('+') ? digits : `+${digits}`;
}

function voiceConfig() {
  const budget = Number(process.env.VOICE_INLINE_BUDGET_MS) || DEFAULT_BUDGET_MS;
  return {
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    publicUrl: (process.env.VOICE_PUBLIC_URL || '').replace(/\/+$/, ''),
    allowedCallers: csv(process.env.VOICE_ALLOWED_CALLERS).map(normalizeNumber),
    language: process.env.VOICE_LANGUAGE || 'en-US',
    ttsVoice: process.env.VOICE_TTS_VOICE || 'Polly.Brian-Neural',
    budgetMs: Math.min(budget, MAX_BUDGET_MS),
  };
}

export function voiceEnabled() {
  const cfg = voiceConfig();
  return !!(cfg.authToken && cfg.publicUrl);
}

// --- Twilio request signature ---

export function twilioSignature(authToken, url, params) {
  const pairs = [...params.entries()].sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : (a < b ? -1 : 1)));
  const data = pairs.reduce((acc, [k, v]) => acc + k + v, url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

// Twilio is inconsistent about including the port in the URL it signs, so accept
// the signature computed with and without it (as Twilio's own SDKs do).
function signedUrlVariants(url) {
  const u = new URL(url);
  const path = `${u.pathname}${u.search}`;
  const defaultPort = u.protocol === 'https:' ? '443' : '80';
  return [...new Set([
    url,
    `${u.protocol}//${u.hostname}${path}`,
    `${u.protocol}//${u.hostname}:${u.port || defaultPort}${path}`,
  ])];
}

export function isValidTwilioRequest({ authToken, url, params, signature }) {
  if (!authToken || !signature) return false;
  const given = Buffer.from(String(signature), 'utf8');
  return signedUrlVariants(url).some((candidate) => {
    const expected = Buffer.from(twilioSignature(authToken, candidate, params), 'utf8');
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  });
}

// --- TwiML ---

const XML_ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => XML_ESCAPES[c]);

const twiml = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
const say = (text, cfg) => `<Say voice="${xml(cfg.ttsVoice)}">${xml(text)}</Say>`;

// The prompt is spoken INSIDE <Gather>, so the caller can interrupt it by talking.
function listen(prompt, action, cfg) {
  return `<Gather input="speech" action="${xml(action)}" method="POST" speechTimeout="auto" `
    + `language="${xml(cfg.language)}" actionOnEmptyResult="true">${prompt ? say(prompt, cfg) : ''}</Gather>`;
}

const hangUp = (text, cfg) => twiml(`${say(text, cfg)}<Hangup/>`);

// Cut long answers at a sentence boundary; the full text goes to Telegram.
export function spokenVersion(text, max = MAX_SPOKEN) {
  const clean = cleanForSpeech(text) || 'Done, Sir.';
  if (clean.length <= max) return { spoken: clean, truncated: false };
  const cut = clean.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  const head = end > max / 2 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
  return { spoken: `${head} The rest is in Telegram, Sir.`, truncated: true };
}

function sessionKeyFor(caller) {
  // Hash so the raw phone number isn't stored as a session key or logged.
  return `phone:${crypto.createHash('sha256').update(caller).digest('hex').slice(0, 16)}`;
}

const maskNumber = (n) => (n.length > 4 ? `…${n.slice(-3)}` : '…');

// --- Entry point (called by server.js for POST /voice and /voice/turn) ---
//
// `url` is the request path + query exactly as received (the signature covers it).
// notifyTelegram(text) delivers late/long answers; optional. `answer` is the
// voice answering function (swappable in tests so they don't need the brain).
// Returns { status, contentType, body }.
export async function handleVoiceRequest({ url, rawBody, headers = {}, notifyTelegram = null, answer = answerForVoice }) {
  const cfg = voiceConfig();
  if (!cfg.authToken || !cfg.publicUrl) {
    return { status: 404, contentType: 'text/plain', body: 'not found' };
  }

  const params = new URLSearchParams(rawBody || '');
  const signature = headers['x-twilio-signature'];
  if (!isValidTwilioRequest({ authToken: cfg.authToken, url: `${cfg.publicUrl}${url}`, params, signature })) {
    console.warn('[voice] rejected request with invalid Twilio signature');
    return { status: 403, contentType: 'text/plain', body: 'forbidden' };
  }

  const ok = (inner) => ({ status: 200, contentType: 'text/xml', body: inner });
  const caller = normalizeNumber(params.get('From'));
  if (!caller || !cfg.allowedCallers.includes(caller)) {
    console.warn(`[voice] rejected call from unlisted number ${maskNumber(caller)}`);
    return ok(twiml('<Reject reason="rejected"/>'));
  }

  const [path, query = ''] = url.split('?');
  if (path === '/voice') {
    console.log(`[voice] call from ${maskNumber(caller)}`);
    return ok(twiml(listen('Yes, Sir?', '/voice/turn', cfg)));
  }

  const heard = (params.get('SpeechResult') || '').trim();
  if (!heard) {
    if (new URLSearchParams(query).has('idle')) return ok(hangUp('Very good, Sir.', cfg));
    return ok(twiml(listen('Anything else, Sir?', '/voice/turn?idle=1', cfg)));
  }
  if (GOODBYE_RE.test(heard.replace(/[.,!?]/g, '').trim())) return ok(hangUp('Very good, Sir.', cfg));

  console.log(`[voice] heard: ${heard.slice(0, 80)}`);
  const deliver = async (text) => {
    if (notifyTelegram) await notifyTelegram(text);
  };
  const { text, deferred } = await answer(heard, sessionKeyFor(caller), {
    source: 'phone',
    budgetMs: cfg.budgetMs,
    ceilingMs: cfg.budgetMs,
    deliver,
    deferredAck: DEFERRED_ACK,
  });

  const { spoken, truncated } = spokenVersion(text);
  if (truncated && !deferred) {
    deliver(text).catch((err) => console.error('[voice] Telegram delivery failed:', err.message));
  }
  return ok(twiml(listen(spoken, '/voice/turn', cfg)));
}

// Exported for unit testing.
export const _internal = { normalizeNumber, signedUrlVariants, sessionKeyFor, GOODBYE_RE };
