import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIdentityMap, resolveIdentity } from './identity.js';

const map = parseIdentityMap(' tg:111 = Amir , alexa:abc=amir, ha:*=amir, alexa:*=guest, api:default=amir, broken, =x, nokey=amir, tg:222=Bad User!');

test('parseIdentityMap keeps valid exact and wildcard entries, lowercases ids, skips malformed', () => {
  assert.deepEqual([...map.exact], [['tg:111', 'amir'], ['alexa:abc', 'amir'], ['api:default', 'amir']]);
  assert.deepEqual([...map.wildcard], [['ha:', 'amir'], ['alexa:', 'guest']]);
  assert.deepEqual([...parseIdentityMap(undefined).exact], []);
});

test('mapped surface keys fold into one user session with that user\'s Telegram chat', () => {
  for (const key of ['tg:111', 'alexa:abc', 'api:default', 'ha:conv-42']) {
    assert.deepEqual(resolveIdentity(key, map), { userId: 'amir', sessionKey: 'user:amir', chatId: '111' });
  }
});

test('exact entries win over the surface wildcard', () => {
  assert.equal(resolveIdentity('alexa:abc', map).userId, 'amir');
  assert.deepEqual(resolveIdentity('alexa:zzz', map), { userId: 'guest', sessionKey: 'user:guest', chatId: null });
});

test('resolving a user: key is idempotent', () => {
  assert.deepEqual(resolveIdentity('user:amir', map), { userId: 'amir', sessionKey: 'user:amir', chatId: '111' });
});

test('unmapped keys keep their own session and never yield a chat id', () => {
  assert.deepEqual(resolveIdentity('tg:999', map), { userId: null, sessionKey: 'tg:999', chatId: null });
  assert.deepEqual(resolveIdentity('api:other', map), { userId: null, sessionKey: 'api:other', chatId: null });
  assert.deepEqual(resolveIdentity('', map), { userId: null, sessionKey: '', chatId: null });
});

test('reads JARVIS_IDENTITY_MAP from the environment and picks up changes', () => {
  const prev = process.env.JARVIS_IDENTITY_MAP;
  try {
    process.env.JARVIS_IDENTITY_MAP = 'alexa:abc=amir';
    assert.equal(resolveIdentity('alexa:abc').sessionKey, 'user:amir');
    process.env.JARVIS_IDENTITY_MAP = '';
    assert.equal(resolveIdentity('alexa:abc').sessionKey, 'alexa:abc');
  } finally {
    if (prev === undefined) delete process.env.JARVIS_IDENTITY_MAP;
    else process.env.JARVIS_IDENTITY_MAP = prev;
  }
});
