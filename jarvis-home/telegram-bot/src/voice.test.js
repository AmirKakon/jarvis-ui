import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { twilioSignature, isValidTwilioRequest, handleVoiceRequest, placeCall, _internal } from './voice.js';

const TOKEN = 'test-auth-token';
const ORIGIN = 'https://kakischer.duckdns.org:20443';
const OWNER = '+972500000001';
const TWILIO_NUMBER = '+97290000000';
const ENV = {
  TWILIO_AUTH_TOKEN: TOKEN,
  VOICE_PUBLIC_URL: `${ORIGIN}/`,
  VOICE_ALLOWED_CALLERS: '972 50-000-0001',
  VOICE_LANGUAGE: 'en-GB',
  VOICE_TTS_VOICE: 'Polly.Brian-Neural',
  VOICE_MAX_TURN_MS: '40000',
  TWILIO_ACCOUNT_SID: 'AC-test',
  TWILIO_FROM_NUMBER: TWILIO_NUMBER,
  VOICE_CALL_COOLDOWN_MS: '300000',
};
const FAST = { fastMs: 15, waitSliceMs: 40, orphanMs: 60 };
const ACKS = /Right, Sir\.|One moment, Sir\.|Let me see, Sir\.|Certainly, Sir\./;

let saved;
beforeEach(() => {
  saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  _internal.reset();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// A Twilio webhook as Twilio would send it: form body + signature over the public URL.
function twilioCall(url, fields = {}, { signWith = TOKEN } = {}) {
  const params = new URLSearchParams({ CallSid: 'CA123', From: OWNER, To: TWILIO_NUMBER, Direction: 'inbound', ...fields });
  return {
    url,
    rawBody: params.toString(),
    headers: { 'x-twilio-signature': twilioSignature(signWith, `${ORIGIN}${url}`, params) },
  };
}

// Stand-in for askCore: optionally reports a plan (with its spoken ack), then answers.
function fakeAsk({ result = { ok: true, text: 'ok', results: [] }, ack = null, ackAfterMs = 0, answerAfterMs = 0 } = {}) {
  const calls = [];
  const ask = async (prompt, opts) => {
    calls.push({ prompt, opts });
    if (ack) {
      await sleep(ackAfterMs);
      await opts.onPlan([{ weather: true, acknowledge: ack }]);
    }
    await sleep(answerAfterMs);
    return result;
  };
  return { ask, calls };
}

const spokenLines = (body) => [...body.matchAll(/<Say[^>]*>([^<]*)<\/Say>/g)].map((m) => m[1]);
const isListening = (body) => /<Gather /.test(body);

// Drive one turn the way Twilio does: /voice/turn, then follow <Redirect>s to /voice/wait.
async function runTurn(speech, deps, fields = {}) {
  const said = [];
  let res = await handleVoiceRequest({ ...twilioCall('/voice/turn', { SpeechResult: speech, ...fields }), timing: FAST, ...deps });
  for (let i = 0; i < 50; i++) {
    said.push(...spokenLines(res.body));
    if (!res.body.includes('<Redirect')) return { said, last: res.body };
    res = await handleVoiceRequest({ ...twilioCall('/voice/wait', fields), timing: FAST, ...deps });
  }
  throw new Error('turn never finished');
}

test('twilioSignature matches the reference value from the Twilio SDK', () => {
  const params = new URLSearchParams({
    CallSid: 'CA1234567890ABCDE', From: '+972500000001', SpeechResult: 'what is the weather & <time>?', To: '+97293763549',
  });
  assert.equal(
    twilioSignature(TOKEN, `${ORIGIN}/voice/turn?idle=1`, params),
    'mjjcaR1YCVG4SFIf0ec2PUjG0Uk=',
  );
});

test('isValidTwilioRequest accepts the URL signed with or without the port, and nothing else', () => {
  const params = new URLSearchParams({ From: OWNER, SpeechResult: 'hi' });
  const url = `${ORIGIN}/voice/turn`;
  const cases = [
    ['signed with the port', twilioSignature(TOKEN, url, params), true],
    ['signed without the port', twilioSignature(TOKEN, 'https://kakischer.duckdns.org/voice/turn', params), true],
    ['wrong auth token', twilioSignature('other-token', url, params), false],
    ['different path', twilioSignature(TOKEN, `${ORIGIN}/voice`, params), false],
    ['missing signature', undefined, false],
  ];
  for (const [name, signature, expected] of cases) {
    assert.equal(isValidTwilioRequest({ authToken: TOKEN, url, params, signature }), expected, name);
  }
  const tampered = new URLSearchParams({ From: OWNER, SpeechResult: 'open the gate' });
  assert.equal(isValidTwilioRequest({ authToken: TOKEN, url, params: tampered, signature: twilioSignature(TOKEN, url, params) }), false);
});

test('handleVoiceRequest refuses requests it should not serve, without asking JARVIS', async () => {
  const { ask, calls } = fakeAsk();
  const forged = twilioCall('/voice', {}, { signWith: 'not-the-token' });
  assert.equal((await handleVoiceRequest({ ...forged, ask })).status, 403);

  for (const fields of [{ From: '+15550000000' }, { Direction: 'outbound-api', From: OWNER, To: '+15550000000' }]) {
    const rejected = await handleVoiceRequest({ ...twilioCall('/voice/turn', { SpeechResult: 'hi', ...fields }), ask });
    assert.match(rejected.body, /<Reject reason="rejected"\/>/, JSON.stringify(fields));
  }

  delete process.env.TWILIO_AUTH_TOKEN;
  assert.equal((await handleVoiceRequest({ ...twilioCall('/voice', {}), ask })).status, 404);
  assert.equal(calls.length, 0);
});

test('an incoming call is greeted and listened to', async () => {
  const res = await handleVoiceRequest(twilioCall('/voice', { CallStatus: 'ringing' }));
  assert.equal(res.status, 200);
  assert.equal(res.contentType, 'text/xml');
  assert.match(res.body, /<Gather input="speech" action="\/voice\/turn" method="POST" speechTimeout="auto" language="en-GB" actionOnEmptyResult="true"><Say voice="Polly.Brian-Neural">Yes, Sir\?<\/Say><\/Gather>/);
});

test('farewells and silence end the call; "no" only ends it after "Anything else, Sir?"', async () => {
  const cases = [
    ['first silence prompts once', '/voice/turn', '', 'prompt'],
    ['second silence hangs up', '/voice/turn?idle=1', '', 'hangup'],
    ['goodbye', '/voice/turn', 'Goodbye.', 'hangup'],
    ['thanks, bye', '/voice/turn', 'Okay, thanks. Bye!', 'hangup'],
    ["that's all, Jarvis", '/voice/turn', "That's all, Jarvis.", 'hangup'],
    ['no after "Anything else"', '/voice/turn?idle=1', 'No.', 'hangup'],
    ['no to a real question', '/voice/turn', 'No.', 'ask'],
    ['bye inside a request', '/voice/turn', 'Remind me to say bye to Dana tomorrow', 'ask'],
  ];
  for (const [name, url, speech, expected] of cases) {
    const { ask, calls } = fakeAsk();
    const fields = speech ? { SpeechResult: speech } : {};
    const { body } = await handleVoiceRequest({ ...twilioCall(url, fields), ask, timing: FAST });
    if (expected === 'hangup') assert.match(body, /Very good, Sir\.<\/Say><Hangup\/>/, name);
    if (expected === 'prompt') assert.match(body, /action="\/voice\/turn\?idle=1"[^>]*><Say[^>]*>Anything else, Sir\?/, name);
    assert.equal(calls.length, expected === 'ask' ? 1 : 0, name);
  }
});

test('a quick answer is spoken at once, in voice mode, on a stable hashed session', async () => {
  const { ask, calls } = fakeAsk({ result: { ok: true, text: '**Sunny**, 24° & clear <tonight>', results: [] } });
  const { said, last } = await runTurn(' what is the weather? ', { ask });

  assert.deepEqual(said, ['Sunny , 24° &amp; clear'], 'no acknowledgement for a fast answer');
  assert.ok(isListening(last));
  const [{ prompt, opts }] = calls;
  assert.equal(prompt, 'what is the weather?');
  assert.equal(opts.voice, true);
  assert.equal(opts.source, 'phone');
  assert.match(opts.sessionKey, /^phone:[0-9a-f]{16}$/);
  assert.ok(!opts.sessionKey.includes('972'), 'the raw number is not used as the session key');

  const again = fakeAsk();
  await runTurn('and tomorrow?', { ask: again.ask });
  assert.equal(again.calls[0].opts.sessionKey, opts.sessionKey);
});

test('a slow answer gets an instant ack, the brain\'s progress line, "still on it", then the answer', async () => {
  const { ask } = fakeAsk({
    ack: 'Checking the weather, Sir.', ackAfterMs: 30, answerAfterMs: 120,
    result: { ok: true, text: 'Rain later, Sir.', results: [] },
  });
  const { said, last } = await runTurn('weather?', { ask });

  assert.match(said[0], ACKS);
  assert.ok(said.includes('Checking the weather, Sir.'), said.join(' | '));
  assert.ok(said.includes('Still on it, Sir.'), said.join(' | '));
  assert.equal(said.at(-1), 'Rain later, Sir.');
  assert.ok(isListening(last));
});

test('answers nobody hears go to Telegram: over the turn limit, after a hang-up, or a background job', async () => {
  const sent = [];
  const notifyTelegram = async (text) => { sent.push(text); };

  process.env.VOICE_MAX_TURN_MS = '60';
  const slow = fakeAsk({ answerAfterMs: 200, result: { ok: true, text: 'The research summary.', results: [] } });
  const deferred = await runTurn('research this', { ask: slow.ask, notifyTelegram });
  assert.match(deferred.said.at(-1), /I&apos;ll send the answer to Telegram\./);
  assert.ok(isListening(deferred.last));
  await sleep(250);
  assert.deepEqual(sent, ['The research summary.']);

  sent.length = 0;
  process.env.VOICE_MAX_TURN_MS = '40000';
  const hungUp = fakeAsk({ answerAfterMs: 40, result: { ok: true, text: 'Nobody heard this.', results: [] } });
  const first = await handleVoiceRequest({ ...twilioCall('/voice/turn', { SpeechResult: 'question' }), ask: hungUp.ask, notifyTelegram, timing: FAST });
  assert.match(first.body, /<Redirect/); // caller hangs up instead of following it
  await sleep(150);
  assert.deepEqual(sent, ['Nobody heard this.']);

  sent.length = 0;
  const background = {
    ask: async (prompt, opts) => {
      setTimeout(() => opts.onBackground({ res: { ok: true, output: 'Delegated job done.' } }), 10);
      return { ok: true, text: '', results: [{ res: { background: true } }] };
    },
  };
  const bg = await runTurn('run the backup', { ask: background.ask, notifyTelegram });
  assert.deepEqual(bg.said, ["I&apos;ll send the result to Telegram, Sir."]);
  await sleep(30);
  assert.deepEqual(sent, ['Delegated job done.']);
});

test('long answers are cut at a sentence and sent to Telegram in full', async () => {
  const long = `${'The list goes on. '.repeat(40)}End.`;
  const sent = [];
  const { said } = await runTurn('shopping list', {
    ask: fakeAsk({ result: { ok: true, text: long, results: [] } }).ask,
    notifyTelegram: async (text) => { sent.push(text); },
  });
  assert.ok(said[0].length < 460, `spoken text is short (${said[0].length})`);
  assert.match(said[0], /on\. The rest is in Telegram, Sir\.$/);
  assert.deepEqual(sent, [long]);
});

test('placeCall validates, rate-limits, and asks Twilio to ring the owner with the message', async () => {
  const requests = [];
  let reply = { ok: true, status: 201, body: { sid: 'CA-out-1' } };
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return { ok: reply.ok, status: reply.status, json: async () => reply.body };
  };
  const sent = [];
  const notifyTelegram = async (text) => { sent.push(text); };

  const cases = [
    ['missing message', '  ', 400],
    ['too long', 'x'.repeat(501), 413],
  ];
  for (const [name, message, status] of cases) {
    assert.equal((await placeCall(message, { fetchImpl })).status, status, name);
  }

  reply = { ok: false, status: 400, body: { message: 'Unverified number' } };
  const refused = await placeCall('Gate open', { fetchImpl });
  assert.deepEqual([refused.status, refused.body.error], [502, 'Unverified number']);

  reply = { ok: true, status: 201, body: { sid: 'CA-out-1' } };
  const placed = await placeCall('The gate is open, Sir.', { fetchImpl, notifyTelegram });
  assert.deepEqual([placed.status, placed.body], [202, { ok: true, callSid: 'CA-out-1' }], 'a failed call does not start the cooldown');

  const { url, init } = requests.at(-1);
  assert.equal(url, 'https://api.twilio.com/2010-04-01/Accounts/AC-test/Calls.json');
  assert.equal(init.headers.Authorization, `Basic ${Buffer.from(`AC-test:${TOKEN}`).toString('base64')}`);
  const form = new URLSearchParams(init.body);
  assert.equal(form.get('To'), OWNER);
  assert.equal(form.get('From'), TWILIO_NUMBER);
  assert.match(form.get('Twiml'), /<Gather[^>]*action="https:\/\/kakischer\.duckdns\.org:20443\/voice\/turn"[^>]*><Say[^>]*>The gate is open, Sir\.<\/Say><\/Gather>/);
  assert.deepEqual(sent, ['Calling you: The gate is open, Sir.']);

  const tooSoon = await placeCall('Again', { fetchImpl });
  assert.equal(tooSoon.status, 429);
  assert.ok(tooSoon.body.retryAfterSec > 0);

  delete process.env.TWILIO_ACCOUNT_SID;
  assert.equal((await placeCall('x', { fetchImpl })).status, 503);
});

test('on a call JARVIS placed, the first reply carries what the call was about', async () => {
  const fetchImpl = async () => ({ ok: true, status: 201, json: async () => ({ sid: 'CA-out-2' }) });
  await placeCall('The gate is open, Sir.', { fetchImpl });

  const outbound = { CallSid: 'CA-out-2', Direction: 'outbound-api', From: TWILIO_NUMBER, To: OWNER };
  const { ask, calls } = fakeAsk();
  await runTurn('close it', { ask }, outbound);
  await runTurn('thanks, and the lights?', { ask }, outbound);

  assert.equal(calls[0].prompt, '[Context: you phoned Sir to say: "The gate is open, Sir."] close it');
  assert.equal(calls[1].prompt, 'thanks, and the lights?');
});
