// Alexa custom-skill surface for JARVIS.
//
// An Amazon Echo does its own speech-to-text / text-to-speech; this module just
// bridges the transcribed utterance to the SAME brain the Telegram bot uses
// (askCore) and shapes JARVIS's reply into the Alexa response envelope. Point an
// Alexa custom skill's HTTPS endpoint (via nginx) at POST /alexa in server.js.
//
// Two delivery channels, because Alexa gives a skill only ~8s to answer:
//   1. In-session speech  — fast asks (weather, HA, a quick lookup) answer inline.
//   2. Out-of-band announce — slow/complex asks (cross-provider MCP, delegate)
//      ack "Right away, Sir" within the window, then JARVIS speaks the finished
//      answer on the Echo later via Home Assistant's notify.alexa_media service.
//      This reuses askCore's existing onBackground fire-and-follow-up path.
//
// Continuity across turns is JARVIS's own doing: every turn (and the async
// job) shares a stable sessionKey (alexa:<hash of Alexa userId>), so memory
// carries across turns and even across separate invocations — independent of
// Alexa's own dialog session.
//
// Security: requests are verified as genuinely from Amazon (signature + cert
// chain + timestamp via alexa-verifier) and matched against our own skill id
// (ALEXA_SKILL_ID). The route does NOT use the bearer token — Alexa can't send
// one; the signature is the authentication.
//
// Config (~/jarvis/.env):
//   ALEXA_SKILL_ID          required — your skill's applicationId (amzn1.ask.skill.…)
//   ALEXA_DEVICE_MAP        optional CSV of <Alexa deviceId>=<media_player> so a delayed
//                           answer plays on the Echo you spoke to. Unmapped devices use
//                           Alexa Media Player's "last called" Echo; device ids are logged
//                           on every announce so the map is easy to fill in.
//   ALEXA_NOTIFY_SERVICE    HA notify service for delayed answers when neither the map
//                           nor "last called" finds the Echo (default alexa_media_alines_echo_dot)
//   ALEXA_NOTIFY_TYPE       alexa_media data.type: tts | announce | push (default tts)
//   ALEXA_NOTIFY_TARGET     optional CSV of media_player targets (for the generic
//                           notify.alexa_media service)
//   ALEXA_INLINE_BUDGET_MS  how long to wait for an inline answer before falling
//                           back to announce (default 6000; keep < Alexa's ~8s).
//                           Also the ceiling for /ask's announceIfSlow budgetMs.
//   ALEXA_VERIFY_SIGNATURE  set to "false" ONLY for local curl testing (default true)

import crypto from 'node:crypto';
import verifier from 'alexa-verifier';
import { askCore } from './brain.js';
import { fetchHA } from './agents/ha.js';

const MAX_SPEECH = 6500; // Alexa PlainText outputSpeech caps at 8000 chars; stay under.
const TIMEOUT = Symbol('timeout');

function inlineBudgetMs() {
  return Number(process.env.ALEXA_INLINE_BUDGET_MS) || 6000;
}

// --- Text shaping (markdown/HTML → plain speech) ---

export function cleanForSpeech(input) {
  if (!input) return '';
  let t = String(input);
  t = t.replace(/```[\s\S]*?```/g, ' ');            // fenced code blocks
  t = t.replace(/`([^`]+)`/g, '$1');                // inline code
  t = t.replace(/<[^>]+>/g, ' ');                   // HTML tags (before md, which eats '>')
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');      // images
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');    // links → link text
  t = t.replace(/^\s*[-*•]\s+/gm, '');              // bullet markers
  t = t.replace(/[*_#>~]+/g, ' ');                  // md emphasis/headers/quotes
  t = t.replace(/&nbsp;/g, ' ')
       .replace(/&amp;/g, ' and ')
       .replace(/&lt;/g, ' less than ')
       .replace(/&gt;/g, ' greater than ');
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, MAX_SPEECH);
}

// --- Alexa response envelope ---

function speak(text, { keepOpen = true, reprompt } = {}) {
  const resp = {
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text: cleanForSpeech(text) || 'Yes, Sir?' },
      shouldEndSession: !keepOpen,
    },
  };
  if (keepOpen) {
    resp.response.reprompt = {
      outputSpeech: { type: 'PlainText', text: reprompt || 'Anything else, Sir?' },
    };
  }
  return resp;
}

// --- Home Assistant announce (delayed / out-of-band answers) ---

const csv = (raw) => (raw || '').split(',').map((s) => s.trim()).filter(Boolean);

function parseDeviceMap(raw) {
  return Object.fromEntries(csv(raw).map((pair) => pair.split('=').map((s) => s.trim())).filter(([id, player]) => id && player));
}

function lastCalledPlayer(states) {
  const hit = (states || []).find((s) => s.entity_id?.startsWith('media_player.') && s.attributes?.last_called === true);
  return hit?.entity_id || null;
}

async function resolvePlayer(deviceId) {
  const mapped = deviceId && parseDeviceMap(process.env.ALEXA_DEVICE_MAP)[deviceId];
  if (mapped) return { player: mapped, how: 'map' };
  await fetchHA('services/alexa_media/update_last_called', 'POST', {});
  const r = await fetchHA('states');
  const player = r.ok ? lastCalledPlayer(r.data) : null;
  return { player, how: player ? 'last called' : 'default' };
}

async function announce(text, deviceId) {
  const type = process.env.ALEXA_NOTIFY_TYPE || 'tts';
  const body = { message: cleanForSpeech(text) || 'Done, Sir.', data: { type } };
  const { player, how } = await resolvePlayer(deviceId);
  let service = 'alexa_media';
  if (player) {
    body.target = [player];
  } else {
    service = process.env.ALEXA_NOTIFY_SERVICE || 'alexa_media_alines_echo_dot';
    const target = csv(process.env.ALEXA_NOTIFY_TARGET);
    if (target.length) body.target = target;
  }
  console.log(`[alexa] announce on ${player || `notify.${service}`} (${how}; device ${deviceId || 'unknown'})`);

  const r = await fetchHA(`services/notify/${service}`, 'POST', body);
  if (!r.ok) console.error('[alexa] announce via HA failed:', r.output);
  return r.ok;
}

// --- Event helpers ---

function sessionKeyFor(event) {
  const uid = event?.context?.System?.user?.userId
    || event?.session?.user?.userId
    || 'unknown';
  // Hash so we don't persist the raw (long) Alexa userId; it's stable per
  // account+skill, so this yields a stable per-user conversation thread.
  const h = crypto.createHash('sha256').update(uid).digest('hex').slice(0, 16);
  return `alexa:${h}`;
}

function deviceIdOf(event) {
  return event?.context?.System?.device?.deviceId || null;
}

function applicationIdOf(event) {
  return event?.context?.System?.application?.applicationId
    || event?.session?.application?.applicationId;
}

function hasBackgroundJob(result) {
  return Array.isArray(result?.results) && result.results.some((x) => x?.res?.background);
}

// --- Core answer flow: race an inline reply against Alexa's ~8s window ---

const DEFERRED_ACK = "Right away, Sir — I'll speak the answer in just a moment.";

// Answer within a voice assistant's reply window, or acknowledge now and deliver
// the finished answer later. Shared by POST /alexa, by POST /ask when the Alexa
// Lambda sets announceIfSlow, and by the phone surface (voice.js). `budgetMs` can
// only shorten the window up to `ceilingMs` (default ALEXA_INLINE_BUDGET_MS).
// `deliver(text)` sends a late answer; by default it is spoken on the Echo that
// heard the request (`deviceId`) via Home Assistant.
// Returns { text, deferred } — deferred means the real answer will be delivered.
export async function answerForVoice(query, sessionKey, {
  budgetMs, ceilingMs, source = 'alexa', deviceId = null, deliver = null, deferredAck = DEFERRED_ACK,
} = {}) {
  const ceiling = Number(ceilingMs) || inlineBudgetMs();
  const budget = Math.max(1000, Math.min(Number(budgetMs) || ceiling, ceiling));
  const send = deliver || ((text) => announce(text, deviceId));
  let announced = false; // guard against double delivery

  const askPromise = askCore(query, {
    sessionKey,
    source,
    // Slow/complex actions (cross-provider MCP, delegate) run in the background
    // and finish after we've already replied — deliver the result late.
    onBackground: async ({ res }) => {
      announced = true;
      try {
        await send(res?.ok ? res.output : 'That task ran into a problem, Sir.');
      } catch (err) {
        console.error(`[${source}] onBackground delivery error:`, err?.message);
      }
    },
  });

  let timer;
  const timeoutPromise = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), budget); });
  const outcome = await Promise.race([
    askPromise.then((r) => r, (err) => ({ __err: err })),
    timeoutPromise,
  ]);
  clearTimeout(timer);

  if (outcome === TIMEOUT) {
    // We couldn't answer within the voice window. Deliver the eventual answer
    // when it's ready — unless a background job already owns it.
    askPromise.then((r) => {
      if (r && !hasBackgroundJob(r) && !announced) {
        send(r.text || 'Done, Sir.').catch(() => {});
      }
    }, () => {
      send('Something went wrong with that, Sir.').catch(() => {});
    });
    return { text: deferredAck, deferred: true };
  }

  if (outcome?.__err) {
    console.error(`[${source}] askCore error:`, outcome.__err?.message);
    return { text: 'Something went wrong, Sir.', deferred: false };
  }

  // Got a result in time. If a background job was kicked off, outcome.text is the
  // acknowledgement ("Checking that for you, Sir.") — onBackground will speak the
  // real answer shortly. Otherwise it's the full answer.
  return { text: outcome.text || 'Done, Sir.', deferred: hasBackgroundJob(outcome) };
}

// A deferred answer ends the Alexa session so the Echo is idle (not listening)
// when the Home Assistant announcement arrives.
async function answer(query, event) {
  const { text, deferred } = await answerForVoice(query, sessionKeyFor(event), { deviceId: deviceIdOf(event) });
  return speak(text, { keepOpen: !deferred });
}

// --- Request routing ---

async function route(event) {
  const request = event?.request;
  const type = request?.type;

  if (type === 'LaunchRequest') {
    return speak('At your service, Sir. How may I help?', { keepOpen: true });
  }

  if (type === 'SessionEndedRequest') {
    return { version: '1.0', response: {} }; // no speech permitted on session end
  }

  if (type === 'IntentRequest') {
    const name = request.intent?.name;

    if (name === 'AMAZON.StopIntent' || name === 'AMAZON.CancelIntent') {
      return speak('Very good, Sir.', { keepOpen: false });
    }
    if (name === 'AMAZON.HelpIntent') {
      return speak(
        'Ask me anything, Sir — the weather, your meal plan, what is in the pantry, '
        + 'the next bus, or to control the house.',
        { keepOpen: true },
      );
    }
    if (name === 'AskJarvisIntent') {
      const query = (request.intent?.slots?.query?.value || '').trim();
      if (!query) {
        return speak("I didn't catch that, Sir. What would you like?", { keepOpen: true });
      }
      return answer(query, event);
    }
    // AMAZON.FallbackIntent, NavigateHomeIntent, or anything unmapped.
    return speak("I didn't quite catch that, Sir. Could you rephrase?", { keepOpen: true });
  }

  return speak('At your service, Sir.', { keepOpen: true });
}

// --- Entry point (called by server.js for POST /alexa) ---
//
// Returns { status, body }. `rawBody` MUST be the exact request body string as
// received (signature is computed over the raw bytes).
export async function handleAlexaRequest(rawBody, headers = {}) {
  const skillId = process.env.ALEXA_SKILL_ID;
  if (!skillId) {
    console.error('[alexa] ALEXA_SKILL_ID not set — refusing request.');
    return { status: 500, body: { error: 'Alexa skill not configured' } };
  }

  // 1) Authenticate: verify the request genuinely came from Amazon.
  const verify = (process.env.ALEXA_VERIFY_SIGNATURE || 'true') !== 'false';
  if (verify) {
    const certUrl = headers['signaturecertchainurl'];
    const signature = headers['signature'];
    try {
      await verifier(certUrl, signature, rawBody);
    } catch (err) {
      console.warn('[alexa] signature verification failed:', err?.message || err);
      return { status: 400, body: { error: 'invalid request signature' } };
    }
  }

  // 2) Parse.
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'invalid JSON' } };
  }

  // 3) Only serve requests addressed to OUR skill.
  if (applicationIdOf(event) !== skillId) {
    console.warn('[alexa] applicationId mismatch — rejecting.');
    return { status: 400, body: { error: 'unexpected applicationId' } };
  }

  // 4) Route + shape the reply. Never throw back to Alexa: always speak something.
  try {
    const body = await route(event);
    return { status: 200, body };
  } catch (err) {
    console.error('[alexa] handler error:', err?.message);
    return { status: 200, body: speak('Something went wrong, Sir.', { keepOpen: false }) };
  }
}

// Exported for unit testing.
export const _internal = {
  cleanForSpeech, sessionKeyFor, applicationIdOf, deviceIdOf, hasBackgroundJob, parseDeviceMap, lastCalledPlayer,
};
