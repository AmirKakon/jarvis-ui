import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

const TOKEN = 'test-token';
const injected = [];
let baseUrl;
let stopAskServer;

before(async () => {
  process.env.ASK_HTTP_TOKEN = TOKEN;
  const mod = await import('./server.js');
  stopAskServer = mod.stopAskServer;
  const server = mod.startAskServer({
    port: 0,
    onTelegramText: async (text, opts) => { injected.push({ text, opts }); },
  });
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await stopAskServer();
  delete process.env.ASK_HTTP_TOKEN;
});

function say(body, auth = `Bearer ${TOKEN}`) {
  return fetch(`${baseUrl}/telegram/say`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('POST /telegram/say rejects bad requests without injecting', async () => {
  const cases = [
    ['no token', { text: 'hi' }, null, 401],
    ['wrong token', { text: 'hi' }, 'Bearer nope', 401],
    ['invalid JSON', '{', undefined, 400],
    ['missing text', { text: '   ' }, undefined, 400],
    ['text too long', { text: 'x'.repeat(2001) }, undefined, 413],
  ];
  for (const [name, body, auth, status] of cases) {
    const res = await say(body, auth === undefined ? `Bearer ${TOKEN}` : auth);
    assert.equal(res.status, status, name);
  }
  assert.equal(injected.length, 0);
});

test('POST /telegram/say accepts trimmed text and injects it with the label', async () => {
  const res = await say({ text: '  next bus?  ', label: '📱' });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(injected.at(-1), { text: 'next bus?', opts: { label: '📱' } });
});
