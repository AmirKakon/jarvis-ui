import { extractResponseContent } from './shared.js';

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

export async function runCodeExecution(task) {
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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: 'You are a precise computation assistant. Write and execute code to solve the task. Show results clearly. Use British English.',
        messages: [{ role: 'user', content: task }],
        tools: [
          { type: 'code_execution_20250825', name: 'code_execution' },
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 0,
            user_location: { type: 'approximate', city: 'Jerusalem', country: 'IL', timezone: 'Asia/Jerusalem' },
          },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return { ok: false, output: `Code execution API error: ${res.status}`, sources: [], images: [] };
    }

    const data = await res.json();
    const { text, sources } = extractResponseContent(data);
    const images = extractCodeImages(data);
    return { ok: !!text, output: text || 'No output.', sources, images };
  } catch (err) {
    return { ok: false, output: err.message, sources: [], images: [] };
  }
}
