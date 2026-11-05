import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { twilioSignature, isValidTwilioRequest, handleVoiceRequest } from './voice.js';

const TOKEN = 'test-auth-token';
const ORIGIN = 'https://kakischer.duckdns.org:20443';
const OWNER = '+972500000001';
const ENV = {
  TWILIO_AUTH_TOKEN: TOKEN,
  VOICE_PUBLIC_URL: `${ORIGIN}/`,
  VOICE_ALLOWED_CALLERS: '972 50-000-0001',
  VOICE_LANGUAGE: 'en-GB',
  VOICE_TTS_VOICE: 'Polly.Brian-Neural',
  VOICE_INLINE_BUDGET_MS: '60000',
};

let saved;
beforeEach(() => {
  saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// A Twilio webhook as Twilio would send it: form body + signature over the public URL.
function twilioCall(url, fields, { from = OWNER, signWith = TOKEN } = {}) {
  const params = new URLSearchParams({ CallSid: 'CA123', From: from, To: '+97290000000', ...fields });
  return {
    url,
    rawBody: params.toString(),
    headers: { 'x-twilio-signature': twilioSignature(signWith, `${ORIGIN}${url}`, params) },
  };
}

function fakeAnswer(result) {
  const calls = [];
  const answer = async (query, sessionKey, opts) => {
    calls.push({ query, sessionKey, opts });
    return result;
  };
  return { answer, calls };
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

test('handleVoiceRequest refuses requests it should not serve, without answering', async () => {
  const { answer, calls } = fakeAnswer({ text: 'x', deferred: false });
  const forged = twilioCall('/voice', {}, { signWith: 'not-the-token' });
  const stranger = twilioCall('/voice', {}, { from: '+15550000000' });

  assert.equal((await handleVoiceRequest({ ...forged, answer })).status, 403);

  const rejected = await handleVoiceRequest({ ...stranger, answer });
  assert.equal(rejected.status, 200);
  assert.match(rejected.body, /<Reject reason="rejected"\/>/);

  delete process.env.TWILIO_AUTH_TOKEN;
  assert.equal((await handleVoiceRequest({ ...twilioCall('/voice', {}), answer })).status, 404);
  assert.equal(calls.length, 0);
});

test('an incoming call is greeted and listened to', async () => {
  const res = await handleVoiceRequest(twilioCall('/voice', { CallStatus: 'ringing' }));
  assert.equal(res.status, 200);
  assert.equal(res.contentType, 'text/xml');
  assert.match(res.body, /<Gather input="speech" action="\/voice\/turn" method="POST" speechTimeout="auto" language="en-GB" actionOnEmptyResult="true"><Say voice="Polly.Brian-Neural">Yes, Sir\?<\/Say><\/Gather>/);
});

test('silence and goodbyes end the call without asking JARVIS', async () => {
  const cases = [
    ['first silence prompts once', '/voice/turn', '', /<Gather[^>]*action="\/voice\/turn\?idle=1"[^>]*><Say[^>]*>Anything else, Sir\?<\/Say><\/Gather>/],
    ['second silence hangs up', '/voice/turn?idle=1', '', /Very good, Sir\.<\/Say><Hangup\/>/],
    ['goodbye hangs up', '/voice/turn', 'Goodbye.', /<Hangup\/>/],
    ['"that will be all" hangs up', '/voice/turn?idle=1', 'That will be all', /<Hangup\/>/],
  ];
  for (const [name, url, speech, expected] of cases) {
    const { answer, calls } = fakeAnswer({ text: 'x', deferred: false });
    const fields = speech ? { SpeechResult: speech } : {};
    const res = await handleVoiceRequest({ ...twilioCall(url, fields), answer });
    assert.match(res.body, expected, name);
    assert.equal(calls.length, 0, name);
  }
});

test('a question is answered aloud on a stable hashed session and the call keeps listening', async () => {
  const { answer, calls } = fakeAnswer({ text: '**Sunny**, 24° & clear <tonight>', deferred: false });
  const sent = [];
  const res = await handleVoiceRequest({
    ...twilioCall('/voice/turn', { SpeechResult: ' what is the weather? ' }),
    answer,
    notifyTelegram: async (text) => { sent.push(text); },
  });

  assert.equal(calls.length, 1);
  const [{ query, sessionKey, opts }] = calls;
  assert.equal(query, 'what is the weather?');
  assert.match(sessionKey, /^phone:[0-9a-f]{16}$/);
  assert.ok(!sessionKey.includes('972'), 'the raw number is not used as the session key');
  assert.equal(opts.source, 'phone');
  assert.equal(opts.budgetMs, 13000, 'budget is capped below Twilio\'s 15s webhook timeout');
  assert.match(res.body, /<Gather[^>]*action="\/voice\/turn"[^>]*><Say voice="Polly.Brian-Neural">Sunny , 24° &amp; clear<\/Say><\/Gather>/);
  assert.deepEqual(sent, []);

  const again = fakeAnswer({ text: 'ok', deferred: false });
  await handleVoiceRequest({ ...twilioCall('/voice/turn', { SpeechResult: 'and tomorrow?' }), answer: again.answer });
  assert.equal(again.calls[0].sessionKey, sessionKey);
});

test('long answers are cut at a sentence and sent to Telegram in full; deferred acks are not', async () => {
  const long = `${'The forecast is fine. '.repeat(40)}End.`;
  const sent = [];
  const notifyTelegram = async (text) => { sent.push(text); };

  const res = await handleVoiceRequest({
    ...twilioCall('/voice/turn', { SpeechResult: 'forecast' }), answer: fakeAnswer({ text: long, deferred: false }).answer, notifyTelegram,
  });
  const spoken = /<Say[^>]*>([^<]*)<\/Say>/.exec(res.body)[1];
  assert.ok(spoken.length < 760, `spoken text is short (${spoken.length})`);
  assert.match(spoken, /fine\. The rest is in Telegram, Sir\.$/);
  assert.deepEqual(sent, [long]);

  sent.length = 0;
  const deferred = fakeAnswer({ text: "That will take a moment, Sir. I'll send the answer to Telegram.", deferred: true });
  const ack = await handleVoiceRequest({ ...twilioCall('/voice/turn', { SpeechResult: 'research' }), answer: deferred.answer, notifyTelegram });
  assert.match(ack.body, /That will take a moment, Sir\. I&apos;ll send the answer to Telegram\./);
  assert.equal(typeof deferred.calls[0].opts.deliver, 'function');
  await deferred.calls[0].opts.deliver('the late answer');
  assert.deepEqual(sent, ['the late answer']);
});
