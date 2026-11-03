// Cross-surface identity: folds one person's per-surface session keys
// (tg:<chatId>, alexa:<hash>, ha:<id>, api:default) into a single user, so a
// conversation started on the Echo continues in Telegram (and vice versa), and
// chat-bound actions (reminders, calendar fallback) from a headless surface can
// still reach that user's Telegram chat.
//
// Long-term memory (facts, past-conversation summaries) is already global; this
// only unifies the live 30-minute session and the Telegram delivery target.
//
// Config (~/jarvis/.env):
//   JARVIS_IDENTITY_MAP  CSV of <surface key>=<user id>. A key may end in ":*" to
//                        match every key on that surface. Exact keys win. e.g.
//                        tg:123456=amir,alexa:9f3c0d1e2a4b5c6d=amir,ha:*=amir
//                        A user's Telegram chat comes from their tg:<chatId> entry.
//                        Unmapped keys keep their own per-surface session (and are
//                        logged once so they're easy to add).

const USER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const USER_PREFIX = 'user:';

const loggedUnmapped = new Set();
let cache = { raw: null, map: null };

export function parseIdentityMap(raw) {
  const exact = new Map();
  const wildcard = new Map();
  for (const pair of (raw || '').split(',')) {
    const idx = pair.lastIndexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const userId = pair.slice(idx + 1).trim().toLowerCase();
    if (!key.includes(':') || !USER_ID_RE.test(userId)) continue;
    if (key.endsWith(':*')) wildcard.set(key.slice(0, -1), userId);
    else exact.set(key, userId);
  }
  return { exact, wildcard };
}

function currentMap() {
  const raw = process.env.JARVIS_IDENTITY_MAP || '';
  if (cache.raw !== raw) cache = { raw, map: parseIdentityMap(raw) };
  return cache.map;
}

function telegramChatFor(userId, map) {
  for (const [key, uid] of map.exact) {
    if (uid === userId && key.startsWith('tg:')) return key.slice(3);
  }
  return null;
}

function userIdFor(surfaceKey, map) {
  if (map.exact.has(surfaceKey)) return map.exact.get(surfaceKey);
  const prefix = surfaceKey.slice(0, surfaceKey.indexOf(':') + 1);
  return prefix ? map.wildcard.get(prefix) || null : null;
}

/**
 * Resolve a surface session key to { userId, sessionKey, chatId }.
 *   sessionKey — `user:<id>` for mapped keys, otherwise the surface key unchanged
 *   chatId     — the mapped user's Telegram chat (from their tg: entry), or null.
 *                Never derived from an unmapped key, so an /ask caller can't
 *                aim reminders at an arbitrary chat by choosing its sessionKey.
 * Idempotent: resolving a `user:<id>` key returns the same identity.
 */
export function resolveIdentity(surfaceKey, map = currentMap()) {
  const key = String(surfaceKey || '');

  if (key.startsWith(USER_PREFIX)) {
    const userId = key.slice(USER_PREFIX.length);
    return { userId, sessionKey: key, chatId: telegramChatFor(userId, map) };
  }

  const userId = userIdFor(key, map);
  if (userId) {
    return { userId, sessionKey: `${USER_PREFIX}${userId}`, chatId: telegramChatFor(userId, map) };
  }

  if (key && !key.startsWith('tg:') && !loggedUnmapped.has(key)) {
    loggedUnmapped.add(key);
    console.log(`[identity] unmapped session key ${key} — add "${key}=<user>" to JARVIS_IDENTITY_MAP to share its session`);
  }
  return { userId: null, sessionKey: key, chatId: null };
}
