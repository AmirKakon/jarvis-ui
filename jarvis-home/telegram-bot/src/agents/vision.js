import { readFileSync } from 'node:fs';

const MEDIA_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function getMediaType(filepath) {
  const ext = filepath.slice(filepath.lastIndexOf('.')).toLowerCase();
  return MEDIA_TYPES[ext] || 'image/jpeg';
}

export async function describeImage(filepath, question) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  let base64;
  try {
    base64 = readFileSync(filepath).toString('base64');
  } catch (err) {
    console.error('[vision] Failed to read image:', err.message);
    return null;
  }

  const mediaType = getMediaType(filepath);
  const prompt = question || 'Describe this image in detail. If it contains text, receipts, or documents, extract all readable text and numbers.';

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
        system: 'You are a concise image analyst. Describe what you see factually. For receipts, invoices, or documents, extract all text, numbers, dates, and amounts. For screenshots, describe the UI and any visible text. For photos, describe the scene. Use British English. Be thorough but not verbose.',
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[vision] API error ${res.status}: ${errBody.slice(0, 500)}`);
      return null;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text?.trim();
    return text || null;
  } catch (err) {
    console.error('[vision] Failed:', err.message);
    return null;
  }
}
