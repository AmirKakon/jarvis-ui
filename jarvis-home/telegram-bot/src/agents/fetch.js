import { extractResponseContent } from './shared.js';

export async function runWebFetch(url, question) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, output: 'ANTHROPIC_API_KEY not configured', sources: [] };

  try {
    const prompt = question
      ? `Fetch and read ${url}, then answer: ${question}`
      : `Fetch and read ${url}, then summarise the key content.`;

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
        system: 'You are a concise research assistant. Read the fetched content and answer the question or provide a summary. Cite sources. Use British English.',
        messages: [{ role: 'user', content: prompt }],
        tools: [{
          type: 'web_fetch_20250910',
          name: 'web_fetch',
          max_uses: 3,
          max_content_tokens: 20000,
        }],
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[fetch] API error ${res.status}: ${errBody.slice(0, 500)}`);
      return { ok: false, output: `Fetch API error: ${res.status}`, sources: [] };
    }

    const data = await res.json();
    const { text, sources } = extractResponseContent(data);
    return { ok: !!text, output: text || 'Could not read the page.', sources };
  } catch (err) {
    return { ok: false, output: err.message, sources: [] };
  }
}
