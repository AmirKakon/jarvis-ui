// Embedded HTTP endpoint for the headless JARVIS brain.
//
// Exposes the same askCore() the Telegram bot uses, so any surface (HA Assist,
// Companion, a phone shortcut) can send text and get JARVIS's reply. It lives in
// the bot process and shares its memory, agents, and rate limits.
//
// Endpoints:
//   GET  /health                 — liveness (unauthenticated)
//   POST /ask                    — JARVIS-native { text, sessionKey?, source? }
//                                  + { announceIfSlow: true, budgetMs?, deviceId? } for voice
//                                  callers: kind "deferred" means the reply is an
//                                  ack and the Echo will speak the answer via HA.
//   POST /cam/snapshot           — grab ustreamer still, send to Telegram (same bearer token)
//   POST /telegram/say           — { text, label? }: post text into the bot's chat as if the
//                                  owner typed it (silent echo + normal reply). Returns 202
//                                  at once; the answer arrives in Telegram. Used by the
//                                  watch-SMS relay in homeassistant/packages/jarvis_watch.yaml.
//   GET  /v1/models              — OpenAI-compatible model list (for HA setup)
//   POST /v1/chat/completions    — OpenAI-compatible chat (HA OpenAI Conversation)
//   POST /alexa                  — Alexa custom-skill endpoint (see alexa.js).
//                                  Auth is the Alexa request signature, NOT the
//                                  bearer token — Alexa cannot send one.
//   POST /voice, /voice/turn, /voice/wait — Twilio phone-call webhooks (see voice.js).
//                                  Auth is the Twilio request signature plus a caller allow list.
//   POST /voice/call             — { message }: JARVIS phones the owner, says it, then listens
//                                  (same bearer token; one call per VOICE_CALL_COOLDOWN_MS).
//
// The /v1 shim is chat-only (no tools). HA Assist points here; JARVIS owns all
// routing and device control via askCore. Long delegate/complex-MCP jobs are
// awaited on this path (Assist expects one reply).
//
// Security: REQUIRES a bearer token (ASK_HTTP_TOKEN) and refuses to start without
// one. Binds to localhost by default; set ASK_HTTP_BIND=0.0.0.0 when HA on another
// host needs to reach it (keep the token secret).
//
// Config (~/jarvis/.env):
//   ASK_HTTP_TOKEN  required — bearer token clients must present
//   ASK_HTTP_PORT   default 20010 (20007 is taken by nginx HTTPS on this host)
//   ASK_HTTP_BIND   default 127.0.0.1

import http from 'node:http';
import crypto from 'node:crypto';
import { askCore } from './brain.js';
import { pushWebcamToTelegram } from './commands/cam.js';
import { handleAlexaRequest, answerForVoice } from './alexa.js';
import { MAX_INJECT_TEXT } from './telegram-inject.js';
import { handleVoiceRequest, voiceEnabled, placeCall } from './voice.js';

const MAX_BODY = 32 * 1024; // 32 KB — plenty for a text prompt
const MODEL_ID = 'jarvis';
const CAM_COOLDOWN_MS = 15_000;
let lastCamSnapshotAt = 0;

let server = null;

// --- Helpers ---

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Constant-time bearer-token comparison (avoids timing side-channels).
function authorized(req, token) {
  if (!token) return false; // server may run for /alexa only, with no bearer token set
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  const provided = Buffer.from(m[1], 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

/** Last user turn from an OpenAI-style messages array. */
function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      const text = messageText(m.content).trim();
      if (text) return text;
    }
  }
  return '';
}

/**
 * Session key for Assist / OpenAI clients.
 * Prefer an explicit conversation id; else a short hash of user/metadata; else default.
 */
function haSessionKey(body, req) {
  const user = body?.user;
  if (typeof user === 'string' && user.trim()) {
    return `ha:${user.trim().slice(0, 64)}`;
  }
  // Some OpenAI-compatible clients send metadata.conversation_id
  const meta = body?.metadata;
  if (meta && typeof meta.conversation_id === 'string' && meta.conversation_id.trim()) {
    return `ha:${meta.conversation_id.trim().slice(0, 64)}`;
  }
  // Fall back to a stable-ish key from User-Agent + Authorization presence (not the token).
  const ua = req.headers['user-agent'] || '';
  if (ua) {
    const hash = crypto.createHash('sha256').update(ua).digest('hex').slice(0, 12);
    return `ha:ua-${hash}`;
  }
  return 'ha:default';
}

function openaiCompletion(content, model = MODEL_ID) {
  const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || MODEL_ID,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function openaiError(message, type = 'invalid_request_error') {
  return { error: { message, type, param: null, code: null } };
}

// --- Request handling ---

async function handleAsk(req, res, token) {
  if (!authorized(req, token)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  let raw;
  try {
    raw = await readBody(req, MAX_BODY);
  } catch {
    return sendJson(res, 413, { ok: false, error: 'payload too large' });
  }

  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return sendJson(res, 400, { ok: false, error: 'missing "text"' });

  const sessionKey = typeof body.sessionKey === 'string' && body.sessionKey ? body.sessionKey : 'api:default';
  const source = typeof body.source === 'string' && body.source ? body.source : 'api';

  // Voice callers (the Alexa Lambda) can't wait for slow answers: reply within
  // budgetMs, or acknowledge and have the Echo speak the answer later via HA.
  if (body.announceIfSlow === true) {
    const deviceId = typeof body.deviceId === 'string' && body.deviceId.length <= 200 ? body.deviceId : null;
    const { text: reply, deferred } = await answerForVoice(text, sessionKey, { budgetMs: body.budgetMs, source, deviceId });
    return sendJson(res, 200, { ok: true, kind: deferred ? 'deferred' : 'voice', reply, actions: [] });
  }

  // Headless surface: no Telegram chatId of its own. If sessionKey is mapped in
  // JARVIS_IDENTITY_MAP, askCore uses that user's chat for reminders/calendar;
  // otherwise those actions report they're Telegram-only.
  const result = await askCore(text, { sessionKey, source });

  const actions = (result.results || []).map((r) => ({
    type: r.key,
    ok: r.res.ok,
    output: r.res.output,
  }));
  const status = result.ok ? 200 : (result.kind === 'rate_limited' ? 429 : 500);
  return sendJson(res, status, {
    ok: result.ok,
    kind: result.kind,
    reply: result.text,
    sessionId: result.sessionId,
    actions,
  });
}

async function handleChatCompletions(req, res, token) {
  if (!authorized(req, token)) {
    return sendJson(res, 401, openaiError('Invalid Authentication', 'invalid_request_error'));
  }

  let raw;
  try {
    raw = await readBody(req, MAX_BODY);
  } catch {
    return sendJson(res, 413, openaiError('payload too large'));
  }

  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJson(res, 400, openaiError('invalid JSON'));
  }

  // Chat-only shim: ignore tools/functions — JARVIS owns all agency inside askCore.
  const text = lastUserText(body.messages);
  if (!text) {
    return sendJson(res, 400, openaiError('messages must include a user turn with text content'));
  }

  // Non-streaming only (Assist / OpenAI Conversation work with a single JSON reply).
  if (body.stream === true) {
    return sendJson(res, 400, openaiError('stream=true is not supported; omit stream or set stream=false'));
  }

  const sessionKey = haSessionKey(body, req);
  console.log(`[ask-http] /v1/chat/completions session=${sessionKey} text=${text.slice(0, 80)}`);

  const result = await askCore(text, { sessionKey, source: 'ha-assist' });
  const reply = (result.text || '').trim()
    || (result.ok ? 'Done, Sir.' : 'Something went wrong, Sir.');

  const status = result.kind === 'rate_limited' ? 429 : 200;
  // Always return a completion-shaped body so HA Assist can speak/show something
  // even when askCore reports failure (error text is in result.text).
  return sendJson(res, status, openaiCompletion(reply, typeof body.model === 'string' ? body.model : MODEL_ID));
}

function handleModels(req, res, token) {
  if (!authorized(req, token)) {
    return sendJson(res, 401, openaiError('Invalid Authentication', 'invalid_request_error'));
  }
  return sendJson(res, 200, {
    object: 'list',
    data: [{
      id: MODEL_ID,
      object: 'model',
      created: 0,
      owned_by: 'jarvis',
    }],
  });
}

async function handleCamSnapshot(req, res, token) {
  if (!authorized(req, token)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  const now = Date.now();
  if (now - lastCamSnapshotAt < CAM_COOLDOWN_MS) {
    return sendJson(res, 429, { ok: false, error: 'cooldown' });
  }

  let caption = 'Motion while away';
  try {
    const raw = await readBody(req, MAX_BODY);
    if (raw) {
      const body = JSON.parse(raw);
      if (typeof body.caption === 'string' && body.caption.trim()) {
        caption = body.caption.trim().slice(0, 200);
      }
    }
  } catch {
    // empty or invalid body is fine — use the default caption
  }

  try {
    const bytes = await pushWebcamToTelegram(caption);
    lastCamSnapshotAt = Date.now();
    return sendJson(res, 200, { ok: true, bytes });
  } catch (err) {
    console.error('[ask-http] /cam/snapshot:', err.message);
    return sendJson(res, 502, { ok: false, error: err.message });
  }
}

async function handleTelegramSay(req, res, token, onTelegramText) {
  if (!authorized(req, token)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  if (!onTelegramText) return sendJson(res, 503, { ok: false, error: 'telegram not available' });

  let body;
  try {
    const raw = await readBody(req, MAX_BODY);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid body' });
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return sendJson(res, 400, { ok: false, error: 'missing "text"' });
  if (text.length > MAX_INJECT_TEXT) return sendJson(res, 413, { ok: false, error: 'text too long' });
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 16) : undefined;

  console.log(`[ask-http] /telegram/say text=${text.slice(0, 80)}`);
  // The caller (an HA rest_command) only needs to know it was accepted; the reply
  // can take minutes (research, delegated jobs) and is delivered in Telegram.
  onTelegramText(text, { label }).catch((err) => console.error('[ask-http] /telegram/say:', err.message));
  return sendJson(res, 202, { ok: true });
}

// Alexa custom-skill endpoint. Authentication is the Alexa request signature
// (verified inside handleAlexaRequest), so this route intentionally does NOT
// require the bearer token — an Echo cannot send one.
async function handleAlexa(req, res) {
  let raw;
  try {
    raw = await readBody(req, MAX_BODY);
  } catch {
    return sendJson(res, 413, { error: 'payload too large' });
  }

  try {
    const { status, body } = await handleAlexaRequest(raw, req.headers);
    return sendJson(res, status, body);
  } catch (err) {
    console.error('[ask-http] /alexa:', err.message);
    return sendJson(res, 500, { error: 'internal error' });
  }
}

// Twilio phone-call webhooks. Authentication is the Twilio request signature
// (verified inside handleVoiceRequest), not the bearer token.
async function handleVoice(req, res, notifyTelegram) {
  let raw;
  try {
    raw = await readBody(req, MAX_BODY);
  } catch {
    return sendJson(res, 413, { error: 'payload too large' });
  }

  try {
    const { status, contentType, body } = await handleVoiceRequest({ url: req.url || '', rawBody: raw, headers: req.headers, notifyTelegram });
    res.writeHead(status, { 'Content-Type': `${contentType}; charset=utf-8`, 'Content-Length': Buffer.byteLength(body) });
    return res.end(body);
  } catch (err) {
    console.error('[ask-http] /voice:', err.message);
    return sendJson(res, 500, { error: 'internal error' });
  }
}

async function handleVoiceCall(req, res, token, notifyTelegram) {
  if (!authorized(req, token)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  let body;
  try {
    const raw = await readBody(req, MAX_BODY);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid body' });
  }

  const { status, body: out } = await placeCall(body.message, { notifyTelegram });
  return sendJson(res, status, out);
}

async function handleRequest(req, res, token, { onTelegramText, notifyTelegram }) {
  try {
    const path = (req.url || '').split('?')[0];

    // Liveness check (unauthenticated — no data exposed).
    if (req.method === 'GET' && path === '/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && path === '/alexa') {
      return handleAlexa(req, res);
    }

    if (req.method === 'POST' && path === '/voice/call') {
      return handleVoiceCall(req, res, token, notifyTelegram);
    }

    if (req.method === 'POST' && (path === '/voice' || path === '/voice/turn' || path === '/voice/wait')) {
      return handleVoice(req, res, notifyTelegram);
    }

    if (req.method === 'POST' && path === '/ask') {
      return handleAsk(req, res, token);
    }

    if (req.method === 'GET' && path === '/v1/models') {
      return handleModels(req, res, token);
    }

    if (req.method === 'POST' && path === '/v1/chat/completions') {
      return handleChatCompletions(req, res, token);
    }

    if (req.method === 'POST' && path === '/cam/snapshot') {
      return handleCamSnapshot(req, res, token);
    }

    if (req.method === 'POST' && path === '/telegram/say') {
      return handleTelegramSay(req, res, token, onTelegramText);
    }

    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    console.error('[ask-http] request error:', err.message);
    return sendJson(res, 500, openaiError('internal error', 'server_error'));
  }
}

// --- Lifecycle ---

// Start the HTTP server. No-op (returns null) unless at least one surface is
// enabled: ASK_HTTP_TOKEN (bearer-protected /ask + /v1 shim), ALEXA_SKILL_ID
// (signature-authenticated /alexa) or TWILIO_AUTH_TOKEN + VOICE_PUBLIC_URL
// (signature-authenticated /voice). Token-protected routes 401 when no token is
// set, so running Alexa- or phone-only never exposes /ask unauthenticated.
// onTelegramText(text, { label }) — injects text into the Telegram chat (backs /telegram/say).
// notifyTelegram(text) — sends JARVIS's own message to the chat (late phone answers).
export function startAskServer({ onTelegramText = null, notifyTelegram = null, port: portOverride } = {}) {
  if (server) return server; // idempotent — never double-listen

  const token = process.env.ASK_HTTP_TOKEN;
  const alexaEnabled = !!process.env.ALEXA_SKILL_ID;
  const phoneEnabled = voiceEnabled();
  if (!token && !alexaEnabled && !phoneEnabled) {
    console.log('[ask-http] none of ASK_HTTP_TOKEN, ALEXA_SKILL_ID or TWILIO_AUTH_TOKEN set — HTTP endpoint disabled.');
    return null;
  }

  const port = portOverride ?? (Number(process.env.ASK_HTTP_PORT) || 20010);
  const bind = process.env.ASK_HTTP_BIND || '127.0.0.1';

  server = http.createServer((req, res) => handleRequest(req, res, token, { onTelegramText, notifyTelegram }));
  server.on('error', (err) => console.error('[ask-http] server error:', err.message));
  server.listen(port, bind, () => {
    const routes = ['GET /health'];
    if (token) routes.push('POST /ask', 'POST /v1/chat/completions', 'POST /cam/snapshot', 'POST /telegram/say', 'POST /voice/call', 'GET /v1/models');
    if (alexaEnabled) routes.push('POST /alexa');
    if (phoneEnabled) routes.push('POST /voice', 'POST /voice/turn', 'POST /voice/wait');
    console.log(`[ask-http] Listening on http://${bind}:${port} (${routes.join(', ')})`);
  });
  return server;
}

export function stopAskServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server = null;
  });
}
