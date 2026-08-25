// Embedded HTTP endpoint for the headless JARVIS brain.
//
// Exposes the same askCore() the Telegram bot uses, so any surface (HA Assist,
// Companion, a phone shortcut) can send text and get JARVIS's reply. It lives in
// the bot process and shares its memory, agents, and rate limits.
//
// Endpoints:
//   GET  /health                 — liveness (unauthenticated)
//   POST /ask                    — JARVIS-native { text, sessionKey?, source? }
//   POST /cam/snapshot           — grab go2rtc still, send to Telegram (same bearer token)
//   GET  /v1/models              — OpenAI-compatible model list (for HA setup)
//   POST /v1/chat/completions    — OpenAI-compatible chat (HA OpenAI Conversation)
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

  // Headless surface: no Telegram chatId, so reminders/calendar-create degrade
  // gracefully inside askCore (they report they're Telegram-only for now).
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

async function handleRequest(req, res, token) {
  try {
    const path = (req.url || '').split('?')[0];

    // Liveness check (unauthenticated — no data exposed).
    if (req.method === 'GET' && path === '/health') {
      return sendJson(res, 200, { ok: true });
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

    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    console.error('[ask-http] request error:', err.message);
    return sendJson(res, 500, openaiError('internal error', 'server_error'));
  }
}

// --- Lifecycle ---

// Start the /ask HTTP server. No-op (returns null) if ASK_HTTP_TOKEN is unset,
// so the endpoint is opt-in and never runs unauthenticated.
export function startAskServer() {
  if (server) return server; // idempotent — never double-listen

  const token = process.env.ASK_HTTP_TOKEN;
  if (!token) {
    console.log('[ask-http] ASK_HTTP_TOKEN not set — HTTP /ask endpoint disabled.');
    return null;
  }

  const port = Number(process.env.ASK_HTTP_PORT) || 20010;
  const bind = process.env.ASK_HTTP_BIND || '127.0.0.1';

  server = http.createServer((req, res) => handleRequest(req, res, token));
  server.on('error', (err) => console.error('[ask-http] server error:', err.message));
  server.listen(port, bind, () => {
    console.log(`[ask-http] Listening on http://${bind}:${port} (POST /ask, POST /v1/chat/completions, POST /cam/snapshot, GET /v1/models, GET /health)`);
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
