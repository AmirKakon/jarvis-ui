import { extractResponseContent } from './shared.js';
import { researchModel } from '../models.js';

// Deep-research agent: a capable model (Sonnet by default) with the full
// server-tool set, chaining web search -> web fetch -> code execution
// autonomously in a single call. This is the escalation target for
// tool-heavy / multi-step queries the Haiku front model can't handle
// (Haiku only supports direct, single-tool calls — see agents/search.js).
//
// DYNAMIC FILTERING: on capable models (Sonnet 5 / 4.6, Opus 4.6–4.8/5, Fable 5)
// the newer web_search_20260209 / web_fetch_20260209 tools let Claude write and
// run code that filters raw search results BEFORE they hit the context window —
// keeping only what's relevant, so heavy research is cheaper and sharper. That
// filtering runs inside a code-execution sandbox (allowed_callers defaults to
// ["code_execution_20260120"]); we declare that SAME sandbox as a tool so the
// model can also use it for our own analysis/charts — one shared environment,
// not a second one. Older models fall back to the basic tools. Force the basic
// path with RESEARCH_DYNAMIC_FILTER=false. Model via RESEARCH_MODEL (models.js).

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

// Which models support the dynamic-filtering (20260209) tools. Everything
// current-gen except Haiku; Haiku and older models use the basic variants.
function supportsDynamicFiltering(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('haiku')) return false;
  return /(sonnet-5|sonnet-4-6|opus-5|opus-4-6|opus-4-7|opus-4-8|fable-5)/.test(m);
}

function useDynamicFilter(model) {
  if (String(process.env.RESEARCH_DYNAMIC_FILTER || '').toLowerCase() === 'false') return false;
  return supportsDynamicFiltering(model);
}

const USER_LOCATION = {
  // Israel ('IL') is not a supported web_search country code — omit it.
  // city + timezone still localise results (at least one field is required).
  type: 'approximate',
  city: 'Netanya',
  timezone: 'Asia/Jerusalem',
};

// Tool set for the request. Dynamic-filtering variants on capable models,
// basic variants (direct web_search) otherwise.
function buildTools(dynamic) {
  if (dynamic) {
    return [
      { type: 'web_search_20260209', name: 'web_search', max_uses: 5, user_location: USER_LOCATION },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5, max_content_tokens: 20000 },
      { type: 'code_execution_20260120', name: 'code_execution' },
    ];
  }
  return [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 5, allowed_callers: ['direct'], user_location: USER_LOCATION },
    { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5, max_content_tokens: 20000 },
    { type: 'code_execution_20250825', name: 'code_execution' },
  ];
}

// Pull any base64 images out of code-execution result blocks. Tolerant of the
// block-type name changing across code_execution versions.
function extractCodeImages(data) {
  const images = [];
  for (const block of (data.content || [])) {
    if (!/code_execution/.test(block.type || '')) continue;
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

  const model = researchModel();
  const dynamic = useDynamicFilter(model);
  console.log(`[research] model=${model} dynamicFilter=${dynamic}`);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: RESEARCH_SYSTEM,
        messages: [{ role: 'user', content: query }],
        tools: buildTools(dynamic),
      }),
      signal: AbortSignal.timeout(240_000),
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
