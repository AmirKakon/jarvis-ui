const VALID_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];

function isValidVoice(voice) {
  return VALID_VOICES.includes(voice);
}

async function generateSpeech(text, voice = 'onyx') {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const input = text.slice(0, 4096);

  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'tts-1',
        input,
        voice,
        response_format: 'opus',
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[tts] API error ${res.status}: ${errBody.slice(0, 300)}`);
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.error('[tts] Failed:', err.message);
    return null;
  }
}

export { generateSpeech, isValidVoice, VALID_VOICES };
