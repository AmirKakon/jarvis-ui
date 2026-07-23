// Jellyfin media agent: natural-language access to the local Jellyfin server.
// Follows the same shape as agents/weather.js — a small REST client + a Haiku
// intent classifier + a Haiku summariser — so it stays cheap and predictable.
//
// Talks directly to the Jellyfin REST API (the telegram-bot pattern, like ha.js),
// authenticated with an API key via the X-Emby-Token header.
//
// Config (~/jarvis/.env):
//   JELLYFIN_URL       default http://localhost:20001
//   JELLYFIN_TOKEN     Jellyfin API key (Dashboard → API Keys)
//   JELLYFIN_USER_ID   optional; otherwise the first user is used

const JELLYFIN_URL = (process.env.JELLYFIN_URL || 'http://localhost:20001').replace(/\/$/, '');
const HAIKU = 'claude-haiku-4-5-20251001';

function token() {
  const t = process.env.JELLYFIN_TOKEN;
  return t && t !== 'your-jellyfin-api-key-here' ? t : null;
}

async function jf(endpoint, method = 'GET', body = null) {
  const t = token();
  if (!t) return { ok: false, output: 'Jellyfin not configured (set JELLYFIN_TOKEN in ~/jarvis/.env).' };
  try {
    const res = await fetch(`${JELLYFIN_URL}${endpoint}`, {
      method,
      headers: {
        'X-Emby-Token': t,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, output: `Jellyfin returned HTTP ${res.status}` };
    // Some endpoints (e.g. Library/Refresh) return 204 with no body.
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    return { ok: true, data };
  } catch (err) {
    console.error(`[jellyfin] API error (${endpoint}):`, err.message);
    return { ok: false, output: err.message };
  }
}

// --- User resolution (cached) ---

let cachedUserId = null;
async function getUserId() {
  if (process.env.JELLYFIN_USER_ID) return process.env.JELLYFIN_USER_ID;
  if (cachedUserId) return cachedUserId;
  const res = await jf('/Users');
  if (!res.ok || !Array.isArray(res.data) || !res.data.length) return null;
  // Prefer an administrator, else the first user.
  const admin = res.data.find((u) => u.Policy?.IsAdministrator);
  cachedUserId = (admin || res.data[0]).Id;
  return cachedUserId;
}

// --- Data helpers ---

const asItems = (data) => (Array.isArray(data) ? data : (data?.Items || []));

async function searchItems(term) {
  const uid = await getUserId();
  if (!uid) return [];
  const qs = new URLSearchParams({
    searchTerm: term,
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series,Episode',
    Limit: '25',
    Fields: 'Genres,ProductionYear,CommunityRating,Overview',
    SortBy: 'SortName',
  });
  const res = await jf(`/Users/${uid}/Items?${qs}`);
  return res.ok ? asItems(res.data) : [];
}

async function getLatest() {
  const uid = await getUserId();
  if (!uid) return [];
  const qs = new URLSearchParams({ Limit: '20', Fields: 'Genres,ProductionYear,CommunityRating' });
  const res = await jf(`/Users/${uid}/Items/Latest?${qs}`);
  return res.ok ? asItems(res.data) : [];
}

async function getResume() {
  const uid = await getUserId();
  if (!uid) return [];
  const qs = new URLSearchParams({ Limit: '20', Fields: 'Genres,ProductionYear' });
  const res = await jf(`/Users/${uid}/Items/Resume?${qs}`);
  return res.ok ? asItems(res.data) : [];
}

async function getNextUp() {
  const uid = await getUserId();
  if (!uid) return [];
  const qs = new URLSearchParams({ UserId: uid, Limit: '20', Fields: 'Genres' });
  const res = await jf(`/Shows/NextUp?${qs}`);
  return res.ok ? asItems(res.data) : [];
}

async function getLibraries() {
  const res = await jf('/Library/VirtualFolders');
  return res.ok ? (res.data || []) : [];
}

async function getSessions() {
  const res = await jf('/Sessions');
  return res.ok ? (res.data || []) : [];
}

async function triggerScan() {
  return jf('/Library/Refresh', 'POST');
}

// Trim an item to the few fields worth sending to the LLM.
function compact(item) {
  const label = item.Type === 'Episode'
    ? `${item.SeriesName || ''}${item.SeasonName ? ` — ${item.SeasonName}` : ''}: ${item.Name}`
    : item.Name;
  return {
    title: label,
    type: item.Type,
    year: item.ProductionYear || undefined,
    genres: item.Genres?.slice(0, 4),
    rating: item.CommunityRating ? Math.round(item.CommunityRating * 10) / 10 : undefined,
    overview: item.Overview ? item.Overview.slice(0, 240) : undefined,
  };
}

// --- Intent classification ---

const HEURISTICS = [
  [/\b(scan|refresh|re-?index|update (the )?librar)/i, 'scan'],
  [/\b(now playing|currently (watching|playing|streaming)|who'?s watching|active (session|stream))/i, 'nowplaying'],
  [/\b(what libraries|list libraries|which libraries|my libraries)/i, 'libraries'],
  [/\b(continue|resume|carry on|pick up|finish watching|half.?watched|where i left off)/i, 'resume'],
  [/\b(recently added|what'?s new|new (movies|shows|stuff)|just added|latest)/i, 'recent'],
  [/\b(what should i watch|recommend|suggestion|what to watch|something to watch|in the mood)/i, 'recommend'],
];

async function classify(question) {
  // Cheap deterministic pass first.
  for (const [re, intent] of HEURISTICS) {
    if (re.test(question)) return { intent, searchTerm: null };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Default: treat as a search using the raw text.
    return { intent: 'search', searchTerm: question };
  }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: HAIKU,
        max_tokens: 128,
        system: `You classify a Jellyfin media request. Return ONLY JSON: {"intent": one of "search"|"recent"|"resume"|"nextup"|"recommend"|"nowplaying"|"libraries"|"scan", "searchTerm": string or null}. Use "search" with a searchTerm (the title/keywords) when the user is looking for a specific title or asking whether something is available. Use "recommend" for open-ended "what should I watch" style requests.`,
        messages: [{ role: 'user', content: question }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const data = await res.json();
      const text = (data.content?.[0]?.text || '').replace(/```json\s*|```/g, '').trim();
      const parsed = JSON.parse(text);
      if (parsed?.intent) return { intent: parsed.intent, searchTerm: parsed.searchTerm || null };
    }
  } catch (err) {
    console.error('[jellyfin] classify failed:', err.message);
  }
  return { intent: 'search', searchTerm: question };
}

// --- Summarisation ---

const CONCIERGE_SYSTEM = `You are JARVIS's media concierge for a home Jellyfin server. Answer the user's request using ONLY the provided library data (JSON). Be concise and helpful, use British English, address the user as "Sir". For recommendations, pick a few strong options from what's actually available and say briefly why. Never invent titles that aren't in the data. If the data is empty, say the library has nothing matching rather than guessing.`;

async function summarise(question, payload) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: HAIKU,
        max_tokens: 700,
        system: CONCIERGE_SYSTEM,
        messages: [{ role: 'user', content: `Request: ${question}\n\nLibrary data (JSON):\n${JSON.stringify(payload)}` }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim() || null;
  } catch (err) {
    console.error('[jellyfin] summarise failed:', err.message);
    return null;
  }
}

// --- Plain-text fallbacks (no LLM) ---

function listTitles(items, heading) {
  if (!items.length) return `${heading}: nothing found.`;
  const lines = [`**${heading}**`];
  for (const it of items.slice(0, 15)) {
    const c = compact(it);
    const meta = [c.year, c.genres?.join(', '), c.rating ? `★${c.rating}` : null].filter(Boolean).join(' · ');
    lines.push(`• ${c.title}${meta ? ` (${meta})` : ''}`);
  }
  return lines.join('\n');
}

// --- Public entry point ---

export async function runJellyfinQuery(question) {
  if (!token()) {
    return { ok: false, output: 'Jellyfin is not configured. Set JELLYFIN_TOKEN in ~/jarvis/.env.' };
  }

  const q = (question || '').trim() || 'What should I watch tonight?';
  const { intent, searchTerm } = await classify(q);

  // Action / status intents — deterministic formatting, no LLM.
  if (intent === 'scan') {
    const res = await triggerScan();
    return res.ok
      ? { ok: true, output: '🔄 Jellyfin library scan triggered, Sir.' }
      : { ok: false, output: `Failed to trigger scan: ${res.output}` };
  }

  if (intent === 'nowplaying') {
    const sessions = await getSessions();
    const playing = sessions.filter((s) => s.NowPlayingItem);
    if (!playing.length) return { ok: true, output: 'Nothing is playing on Jellyfin right now, Sir.' };
    const lines = ['**Now playing**'];
    for (const s of playing) {
      const item = s.NowPlayingItem;
      const who = s.UserName ? ` — ${s.UserName}` : '';
      const dev = s.DeviceName ? ` on ${s.DeviceName}` : '';
      const title = item.Type === 'Episode' ? `${item.SeriesName}: ${item.Name}` : item.Name;
      lines.push(`▶️ ${title}${who}${dev}`);
    }
    return { ok: true, output: lines.join('\n') };
  }

  if (intent === 'libraries') {
    const libs = await getLibraries();
    if (!libs.length) return { ok: true, output: 'No Jellyfin libraries found, Sir.' };
    const lines = ['**Libraries**', ...libs.map((l) => `• ${l.Name}${l.CollectionType ? ` (${l.CollectionType})` : ''}`)];
    return { ok: true, output: lines.join('\n') };
  }

  // Content intents — fetch, then let Haiku phrase it (with a plain fallback).
  let items = [];
  let heading = 'Results';
  let payload;

  if (intent === 'recommend') {
    const [latest, resume, nextup] = await Promise.all([getLatest(), getResume(), getNextUp()]);
    payload = {
      continueWatching: resume.map(compact),
      nextUp: nextup.map(compact),
      recentlyAdded: latest.map(compact),
    };
    const summary = await summarise(q, payload);
    if (summary) return { ok: true, output: summary };
    // Fallback: show what we have.
    const parts = [];
    if (resume.length) parts.push(listTitles(resume, 'Continue watching'));
    if (nextup.length) parts.push(listTitles(nextup, 'Next up'));
    if (latest.length) parts.push(listTitles(latest, 'Recently added'));
    return { ok: true, output: parts.join('\n\n') || 'Your library looks empty, Sir.' };
  }

  if (intent === 'search') {
    items = await searchItems(searchTerm || q);
    heading = `Search: ${searchTerm || q}`;
  } else if (intent === 'recent') {
    items = await getLatest();
    heading = 'Recently added';
  } else if (intent === 'resume') {
    items = await getResume();
    heading = 'Continue watching';
  } else if (intent === 'nextup') {
    items = await getNextUp();
    heading = 'Next up';
  } else {
    items = await searchItems(q);
    heading = `Search: ${q}`;
  }

  payload = { intent, items: items.map(compact) };
  const summary = await summarise(q, payload);
  if (summary) return { ok: true, output: summary };
  return { ok: true, output: listTitles(items, heading) };
}
