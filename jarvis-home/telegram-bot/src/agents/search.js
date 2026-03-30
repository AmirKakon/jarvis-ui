import { extractResponseContent } from './shared.js';

export async function runWebSearch(query) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, output: 'ANTHROPIC_API_KEY not configured', sources: [] };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: 'You are a concise research assistant. Answer based on web search results. Cite sources. Use British English.',
        messages: [{ role: 'user', content: query }],
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 3,
          user_location: {
            type: 'approximate',
            city: 'Jerusalem',
            country: 'IL',
            timezone: 'Asia/Jerusalem',
          },
        }],
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[search] API error ${res.status}: ${errBody.slice(0, 500)}`);
      return { ok: false, output: `Search API error: ${res.status}`, sources: [] };
    }

    const data = await res.json();
    const { text, sources } = extractResponseContent(data);
    return { ok: !!text, output: text || 'No results found.', sources };
  } catch (err) {
    return { ok: false, output: err.message, sources: [] };
  }
}
