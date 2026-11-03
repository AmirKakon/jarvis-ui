import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;
process.env.JARVIS_IDENTITY_MAP = 'tg:111=amir,alexa:abc=amir,ha:*=amir';

const { getOrRotateSession, forceNewSession } = await import('./brain.js');

test('mapped surfaces continue the same live session', () => {
  const tg = getOrRotateSession('tg:111', 'telegram');
  const alexa = getOrRotateSession('alexa:abc', 'alexa');
  const assist = getOrRotateSession('ha:conv-7', 'ha-assist');
  assert.equal(tg.isNew, true);
  assert.equal(alexa.isNew, false);
  assert.equal(alexa.sessionId, tg.sessionId);
  assert.equal(assist.sessionId, tg.sessionId);
});

test('unmapped surfaces keep their own session', () => {
  const shared = getOrRotateSession('tg:111', 'telegram').sessionId;
  const other = getOrRotateSession('alexa:someone-else', 'alexa');
  assert.notEqual(other.sessionId, shared);
});

test('/new from one surface closes the shared session for all of them', async () => {
  const before = getOrRotateSession('alexa:abc', 'alexa').sessionId;
  await forceNewSession('tg:111', 'telegram');
  const after = getOrRotateSession('alexa:abc', 'alexa');
  assert.equal(after.isNew, true);
  assert.notEqual(after.sessionId, before);
});
