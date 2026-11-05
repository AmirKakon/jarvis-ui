// Phone-call surface for JARVIS (Twilio Programmable Voice).
//
// Call the Twilio number (e.g. from the Gear S watch, which calls through the
// phone) and talk to the SAME brain as Telegram and Alexa, or have JARVIS call
// you (POST /voice/call). Twilio does speech recognition (<Gather input="speech">)
// and text-to-speech (<Say>); this module runs each recognised sentence through
// askCore in voice mode and replies with TwiML.
//
// Call flow (all Twilio webhooks, POST form-encoded, signed):
//   POST /voice       — call comes in: reject unknown callers (before answering, so
//                       they cost nothing), else "Yes, Sir?" and listen.
//   POST /voice/turn  — Twilio's recognised speech in SpeechResult. Starts the answer
//                       in the background; if it's ready within ~1s it is spoken at
//                       once, otherwise JARVIS says "Right, Sir." and redirects to…
//   POST /voice/wait  — speaks the brain's own progress line ("Checking the weather,
//                       Sir."), then "Still on it, Sir." every few seconds, until the
//                       answer is ready. Each request stays well under Twilio's 15s
//                       webhook limit. After VOICE_MAX_TURN_MS the answer is sent to
//                       Telegram instead and the call listens again.
//   Silence → "Anything else, Sir?" once, then hang up. "Bye", "thanks", "that's it"
//   hang up; "no" / "nothing" hang up only right after "Anything else, Sir?".
//
// Answers too long to read out are cut at a sentence and sent to Telegram in full;
// background jobs and answers finished after the caller hung up go there too.
//
// Outbound (POST /voice/call, bearer token, see server.js): JARVIS rings the owner,
// says the message, then listens — the reply continues as a normal call, and the
// brain is told what it called about. A copy goes to Telegram; one call per
// VOICE_CALL_COOLDOWN_MS.
//
// Security: every webhook must carry a valid X-Twilio-Signature (HMAC-SHA1 of the
// public URL + POST params with the account's auth token), and only numbers in
// VOICE_ALLOWED_CALLERS are served (the caller, or the callee for JARVIS's own
// calls). Caller ID can be spoofed; the signature proves the request came from
// Twilio, not who is on the line.
//
// Config (~/jarvis/.env):
//   TWILIO_AUTH_TOKEN        required — enables /voice; verifies signatures, authenticates calls out
//   VOICE_PUBLIC_URL         required — origin Twilio calls, e.g. https://kakischer.duckdns.org:20443
//   VOICE_ALLOWED_CALLERS    required — CSV of numbers in E.164 (+9725…)
//   VOICE_LANGUAGE           speech recognition language (default en-US; he-IL for Hebrew)
//   VOICE_TTS_VOICE          Twilio <Say> voice (default Polly.Brian-Neural, British)
//   VOICE_MAX_TURN_MS        longest a caller waits for one answer before it goes to Telegram (default 40000)
//   TWILIO_ACCOUNT_SID       outbound calls — the account SID (AC…)
//   TWILIO_FROM_NUMBER       outbound calls — your Twilio number (+972…)
//   VOICE_CALL_TO            outbound calls — who to ring (default: first VOICE_ALLOWED_CALLERS)
//   VOICE_CALL_COOLDOWN_MS   minimum gap between outbound calls (default 300000)
//   JARVIS_IDENTITY_MAP      add phone:*=<user> to share the session with Telegram/Alexa

import crypto from 'node:crypto';
import { askCore } from './brain.js';
import { cleanForSpeech } from './alexa.js';

const MAX_SPOKEN = 400;
const MAX_CALL_MESSAGE = 500;
const DEFAULT_TIMING = { fastMs: 1200, waitSliceMs: 7000, orphanMs: 30_000 };
const ACKS = ['Right, Sir.', 'One moment, Sir.', 'Let me see, Sir.', 'Certainly, Sir.'];
const STILL_WORKING = 'Still on it, Sir.';
const DEFER_LINE = "This is taking a while, Sir. I'll send the answer to Telegram.";
const BACKGROUND_LINE = "I'll send the result to Telegram, Sir.";
const FAREWELL = 'Very good, Sir.';

// Short utterances that END with a farewell ("ok thanks bye", "that's all Jarvis").
const END_RE = /(?:^|\s)(?:good ?bye|bye(?: bye)?|that will be all|thats all|thats it|hang up|no thanks|no thank you|nothing else|thanks|thank you|ביי|להתראות|תודה)(?: jarvis| sir)?$/;
// Declines that only mean "end the call" as an answer to "Anything else, Sir?".
const DECLINE_RE = /^(?:no|nope|nothing|no thats it|im good|im fine|im done|לא)$/;

const jobs = new Map(); // CallSid → in-flight answer for that call
const outboundCalls = new Map(); // CallSid → { message, at } for calls JARVIS placed
let lastOutboundAt = 0;

const csv = (raw) => (raw || '').split(',').map((s) => s.trim()).filter(Boolean);

function normalizeNumber(raw) {
  const digits = String(raw || '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  return digits.startsWith('+') ? digits : `+${digits}`;
}

function voiceConfig() {
  const allowedCallers = csv(process.env.VOICE_ALLOWED_CALLERS).map(normalizeNumber);
  return {
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    publicUrl: (process.env.VOICE_PUBLIC_URL || '').replace(/\/+$/, ''),
    allowedCallers,
    language: process.env.VOICE_LANGUAGE || 'en-US',
    ttsVoice: process.env.VOICE_TTS_VOICE || 'Polly.Brian-Neural',
    maxTurnMs: Number(process.env.VOICE_MAX_TURN_MS) || 40_000,
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    fromNumber: normalizeNumber(process.env.TWILIO_FROM_NUMBER),
    callTo: normalizeNumber(process.env.VOICE_CALL_TO) || allowedCallers[0] || '',
    callCooldownMs: Number(process.env.VOICE_CALL_COOLDOWN_MS) || 300_000,
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
const redirect = (path) => `<Redirect method="POST">${xml(path)}</Redirect>`;

// The prompt is spoken INSIDE <Gather>, so the caller can interrupt it by talking.
function listen(prompt, action, cfg) {
  return `<Gather input="speech" action="${xml(action)}" method="POST" speechTimeout="auto" `
    + `language="${xml(cfg.language)}" actionOnEmptyResult="true">${prompt ? say(prompt, cfg) : ''}</Gather>`;
}

const hangUp = (cfg) => twiml(`${say(FAREWELL, cfg)}<Hangup/>`);

// Cut long answers at a sentence boundary; the full text goes to Telegram.
export function spokenVersion(text, max = MAX_SPOKEN) {
  const clean = cleanForSpeech(text) || 'Done, Sir.';
  if (clean.length <= max) return { spoken: clean, truncated: false };
  const cut = clean.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  const head = end > max / 2 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
  return { spoken: `${head} The rest is in Telegram, Sir.`, truncated: true };
}

export function isEndOfCall(heard, { afterAnythingElse = false } = {}) {
  const t = String(heard || '').toLowerCase().replace(/[.,!?'’]/g, '').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 6) return false;
  return END_RE.test(t) || (afterAnythingElse && DECLINE_RE.test(t));
}

function sessionKeyFor(number) {
  // Hash so the raw phone number isn't stored as a session key or logged.
  return `phone:${crypto.createHash('sha256').update(number).digest('hex').slice(0, 16)}`;
}

const maskNumber = (n) => (n.length > 4 ? `…${n.slice(-3)}` : '…');
const pick = (list) => list[Math.floor(Math.random() * list.length)];

// --- Background answer per call ---

function deliverToTelegram(notifyTelegram, text) {
  if (!notifyTelegram || !text) return;
  Promise.resolve(notifyTelegram(text)).catch((err) => console.error('[voice] Telegram delivery failed:', err.message));
}

function hasBackgroundJob(result) {
  return Array.isArray(result?.results) && result.results.some((x) => x?.res?.background);
}

// Send a finished answer nobody heard (caller hung up, or the turn was deferred).
function deliverLate(job) {
  if (job.delivered) return;
  job.delivered = true;
  const text = (job.result?.text || '').trim();
  if (text) deliverToTelegram(job.notifyTelegram, text);
}

function startJob(callSid, query, sessionKey, { ask, notifyTelegram, timing }) {
  const job = {
    started: Date.now(), done: false, result: null, ack: null, ackSpoken: false,
    collected: false, deferred: false, delivered: false, planMs: null, waits: 0, notifyTelegram,
  };
  let wake;
  const rearm = () => { job.changed = new Promise((resolve) => { wake = resolve; }); };
  rearm();
  const signal = () => { const w = wake; rearm(); w(); };

  job.promise = Promise.resolve()
    .then(() => ask(query, {
      sessionKey,
      source: 'phone',
      voice: true,
      onPlan: async (actions) => {
        job.planMs = Date.now() - job.started;
        job.ack = actions.map((a) => a?.acknowledge).find((a) => typeof a === 'string' && a.trim()) || null;
        signal();
      },
      onBackground: async ({ res }) => {
        deliverToTelegram(notifyTelegram, res?.ok ? res.output : 'That task ran into a problem, Sir.');
      },
    }))
    .catch((err) => {
      console.error('[voice] askCore error:', err?.message);
      return { ok: false, text: 'Something went wrong, Sir.', results: [] };
    })
    .then((result) => {
      job.done = true;
      job.result = result;
      signal();
      const timer = setTimeout(() => {
        if (!job.collected) {
          if (jobs.get(callSid) === job) jobs.delete(callSid);
          deliverLate(job);
        }
      }, timing.orphanMs);
      timer.unref?.();
    });

  jobs.set(callSid, job);
  return job;
}

function waitForChange(job, ms) {
  let timer;
  return Promise.race([
    job.changed,
    new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, ms)); }),
  ]).finally(() => clearTimeout(timer));
}

async function waitUntilDone(job, ms) {
  const deadline = Date.now() + ms;
  while (!job.done && Date.now() < deadline) await waitForChange(job, deadline - Date.now());
}

function speakAnswer(callSid, job, cfg) {
  job.collected = true;
  jobs.delete(callSid);
  const r = job.result || {};
  const background = hasBackgroundJob(r);
  let text = (r.text || '').trim();
  if (!text) text = background ? BACKGROUND_LINE : (r.ok ? 'Done, Sir.' : 'Something went wrong, Sir.');
  else if (background) text = `${text} ${BACKGROUND_LINE}`;

  const { spoken, truncated } = spokenVersion(text);
  if (truncated) deliverToTelegram(job.notifyTelegram, text);
  console.log(`[voice] answered in ${Date.now() - job.started} ms (plan ${job.planMs ?? '-'} ms, ${job.waits} wait(s)${truncated ? ', full text to Telegram' : ''})`);
  return twiml(listen(spoken, '/voice/turn', cfg));
}

function deferToTelegram(callSid, job, cfg) {
  job.deferred = true;
  jobs.delete(callSid);
  job.promise.then(() => deliverLate(job));
  console.log(`[voice] deferred to Telegram after ${Date.now() - job.started} ms`);
  return twiml(listen(DEFER_LINE, '/voice/turn', cfg));
}

async function handleWait(callSid, cfg, timing) {
  const job = jobs.get(callSid);
  if (!job) return twiml(listen('Anything else, Sir?', '/voice/turn?idle=1', cfg)); // e.g. bot restarted
  job.waits += 1;

  const progress = () => {
    if (job.done) return speakAnswer(callSid, job, cfg);
    if (job.ack && !job.ackSpoken) {
      job.ackSpoken = true;
      return twiml(say(job.ack, cfg) + redirect('/voice/wait'));
    }
    if (Date.now() - job.started >= cfg.maxTurnMs) return deferToTelegram(callSid, job, cfg);
    return null;
  };

  const now = progress();
  if (now) return now;
  await waitForChange(job, Math.min(timing.waitSliceMs, cfg.maxTurnMs - (Date.now() - job.started)));
  return progress() || twiml(say(STILL_WORKING, cfg) + redirect('/voice/wait'));
}

async function handleTurn(callSid, party, params, query, cfg, { ask, notifyTelegram, timing }) {
  const heard = (params.get('SpeechResult') || '').trim();
  const afterAnythingElse = new URLSearchParams(query).has('idle');
  if (!heard) return afterAnythingElse ? hangUp(cfg) : twiml(listen('Anything else, Sir?', '/voice/turn?idle=1', cfg));
  if (isEndOfCall(heard, { afterAnythingElse })) return hangUp(cfg);

  console.log(`[voice] heard: ${heard.slice(0, 80)}`);
  // On a call JARVIS placed, the first reply needs to know what the call was about.
  const placed = outboundCalls.get(callSid);
  outboundCalls.delete(callSid);
  const prompt = placed ? `[Context: you phoned Sir to say: "${placed.message}"] ${heard}` : heard;

  const job = startJob(callSid, prompt, sessionKeyFor(party), { ask, notifyTelegram, timing });
  await waitUntilDone(job, timing.fastMs);
  if (job.done) return speakAnswer(callSid, job, cfg);
  return twiml(say(pick(ACKS), cfg) + redirect('/voice/wait'));
}

// --- Entry point (called by server.js for POST /voice, /voice/turn, /voice/wait) ---
//
// `url` is the request path + query exactly as received (the signature covers it).
// notifyTelegram(text) delivers long/late answers; optional. `ask` and `timing`
// are swappable in tests (they default to askCore and the production timings).
// Returns { status, contentType, body }.
export async function handleVoiceRequest({
  url, rawBody, headers = {}, notifyTelegram = null, ask = askCore, timing = DEFAULT_TIMING,
}) {
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

  const ok = (body) => ({ status: 200, contentType: 'text/xml', body });
  // On calls JARVIS placed, Twilio reports our number as From and the owner as To.
  const outbound = (params.get('Direction') || '').startsWith('outbound');
  const party = normalizeNumber(params.get(outbound ? 'To' : 'From'));
  if (!party || !cfg.allowedCallers.includes(party)) {
    console.warn(`[voice] rejected call with unlisted number ${maskNumber(party)}`);
    return ok(twiml('<Reject reason="rejected"/>'));
  }

  const callSid = params.get('CallSid') || 'unknown';
  const [path, query = ''] = url.split('?');
  if (path === '/voice') {
    console.log(`[voice] call from ${maskNumber(party)}`);
    return ok(twiml(listen('Yes, Sir?', '/voice/turn', cfg)));
  }
  if (path === '/voice/wait') return ok(await handleWait(callSid, cfg, timing));
  return ok(await handleTurn(callSid, party, params, query, cfg, { ask, notifyTelegram, timing }));
}

// --- Outbound: JARVIS calls the owner (POST /voice/call) ---
//
// Returns { status, body } (JSON body). `fetchImpl` is swappable in tests.
export async function placeCall(message, { notifyTelegram = null, fetchImpl = fetch } = {}) {
  const cfg = voiceConfig();
  if (!cfg.authToken || !cfg.publicUrl || !cfg.accountSid || !cfg.fromNumber || !cfg.callTo) {
    return { status: 503, body: { ok: false, error: 'outbound calls not configured' } };
  }
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return { status: 400, body: { ok: false, error: 'missing "message"' } };
  if (text.length > MAX_CALL_MESSAGE) return { status: 413, body: { ok: false, error: 'message too long' } };

  const now = Date.now();
  const waitMs = lastOutboundAt + cfg.callCooldownMs - now;
  if (waitMs > 0) {
    return { status: 429, body: { ok: false, error: 'cooldown', retryAfterSec: Math.ceil(waitMs / 1000) } };
  }
  lastOutboundAt = now;

  const form = new URLSearchParams({
    To: cfg.callTo,
    From: cfg.fromNumber,
    Timeout: '25',
    Twiml: twiml(listen(text, `${cfg.publicUrl}/voice/turn`, cfg)),
  });
  let res;
  let data = {};
  try {
    res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Calls.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    lastOutboundAt = 0; // nothing was placed, so allow a retry
    console.error('[voice] outbound call failed:', err.message);
    return { status: 502, body: { ok: false, error: 'could not reach Twilio' } };
  }
  if (!res.ok || !data.sid) {
    lastOutboundAt = 0;
    console.error(`[voice] Twilio refused the call: ${res.status} ${data.message || ''}`);
    return { status: 502, body: { ok: false, error: data.message || `Twilio error ${res.status}` } };
  }

  for (const [sid, c] of outboundCalls) if (now - c.at > 3_600_000) outboundCalls.delete(sid);
  outboundCalls.set(data.sid, { message: text, at: now });
  console.log(`[voice] calling ${maskNumber(cfg.callTo)}: ${text.slice(0, 80)}`);
  deliverToTelegram(notifyTelegram, `Calling you: ${text}`);
  return { status: 202, body: { ok: true, callSid: data.sid } };
}

// Exported for unit testing.
export const _internal = {
  normalizeNumber,
  signedUrlVariants,
  reset() {
    jobs.clear();
    outboundCalls.clear();
    lastOutboundAt = 0;
  },
};
