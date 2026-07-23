// Embedded HTTP endpoint for the headless JARVIS brain.
//
// Exposes the same askCore() the Telegram bot uses, so any surface (a home mic,
// HA Assist, a phone shortcut) can POST text and get JARVIS's reply. It lives in
// the bot process and shares its memory, agents, and rate limits.
//
// Security: this endpoint can drive the whole house, so it REQUIRES a bearer
// token (ASK_HTTP_TOKEN) and refuses to start without one. It binds to localhost
// by default; expose it on the LAN only via ASK_HTTP_BIND when the voice phase
// needs it, and keep the token secret.
//
// Config (~/jarvis/.env):
//   ASK_HTTP_TOKEN  required — bearer token clients must present
//   ASK_HTTP_PORT   default 20010 (20007 is taken by nginx HTTPS on this host)
//   ASK_HTTP_BIND   default 127.0.0.1

import http from 'node:http';
import crypto from 'node:crypto';
import { askCore } from './brain.js';

const MAX_BODY = 32 * 1024; // 32 KB — plenty for a text prompt

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

// --- Request handling ---

async function handleRequest(req, res, token) {
  try {
    const path = (req.url || '').split('?')[0];

    // Liveness check (unauthenticated — no data exposed).
    if (req.method === 'GET' && path === '/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && path === '/ask') {
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

    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    console.error('[ask-http] request error:', err.message);
    return sendJson(res, 500, { ok: false, error: 'internal error' });
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
    console.log(`[ask-http] Listening on http://${bind}:${port} (POST /ask, GET /health)`);
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
