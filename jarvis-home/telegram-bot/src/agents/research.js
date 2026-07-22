import { extractResponseContent } from './shared.js';

// Deep-research agent: a capable model (Sonnet by default) with the full
// server-tool set, chaining web search -> web fetch -> code execution
// autonomously in a single call. This is the escalation target for
// tool-heavy / multi-step queries the Haiku front model can't handle
// (Haiku only supports direct, single-tool calls — see agents/search.js).
//
// Model is overridable via RESEARCH_MODEL. Defaults to Sonnet 5 — capable
// enough to chain tools and synthesise well, and it supports dynamic filtering.
// To unlock dynamic filtering (code-execution-backed result filtering, lower
// token use), switch web_search below to web_search_20260209 once this is
// confirmed working. Use claude-opus-4-8 for maximum depth at higher cost.
const RESEARCH_MODEL = process.env.RESEARCH_MODEL || 'claude-sonnet-5';

const RESEARCH_SYSTEM = `You are JARVIS's deep-research analyst, working for a user in Netanya, Israel.

You have three tools and should chain them autonomously to fully answer the question:
- web_search: find current information and discover relevant sources
- web_fetch: read a specific page or PDF in full when a search snippet isn't enough
- code_execution: compute, analyse data, or generate charts

Approach:
1. Search for the information needed. Fetch specific pages when you need their full content.
2. If the task involves numbers, data, or a chart, pass the gathered data to the code sandbox for analysis or plotting.
3. Synthesise a clear, well-structured final answer.

Rules:
- The code sandbox has NO internet access. Never make HTTP requests from code — gather web data with web_search/web_fetch first, then feed it to code.
- Always cite your sources.
- Be thorough but concise. Use British English.`;

function extractCodeImages(data) {
  const images = [];
  for (const block of (data.content || [])) {
    if (block.type !== 'code_execution_result') continue;
    for (const item of (block.content || [])) {
      if (item.type === 'image' && item.source?.type === 'base64') {
        images.push({ base64: item.source.data, mediaType: item.source.media_type || 'image/png' });
      }
    }
  }
  return images;
}

export async function runResearch(query) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, output: 'ANTHROPIC_API_KEY not configured', sources: [], images: [] };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: RESEARCH_MODEL,
        max_tokens: 4096,
        system: RESEARCH_SYSTEM,
        messages: [{ role: 'user', content: query }],
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 5,
            allowed_callers: ['direct'],
            user_location: {
              // Israel ('IL') is not a supported web_search country code — omit it.
              // city + timezone still localise results (at least one field is required).
              type: 'approximate',
              city: 'Netanya',
              timezone: 'Asia/Jerusalem',
            },
          },
          {
            type: 'web_fetch_20250910',
            name: 'web_fetch',
            max_uses: 5,
            max_content_tokens: 20000,
          },
          { type: 'code_execution_20250825', name: 'code_execution' },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[research] API error ${res.status}: ${errBody.slice(0, 500)}`);
      let detail = '';
      try { detail = JSON.parse(errBody)?.error?.message || ''; } catch { /* non-JSON body */ }
      return {
        ok: false,
        output: `Research API error ${res.status}${detail ? `: ${detail}` : ''}`,
        sources: [],
        images: [],
      };
    }

    const data = await res.json();
    const { text, sources } = extractResponseContent(data);
    const images = extractCodeImages(data);
    return { ok: !!text, output: text || 'No results found.', sources, images };
  } catch (err) {
    return { ok: false, output: err.message, sources: [], images: [] };
  }
}
