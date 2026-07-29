import { escapeHtml, truncate, mdToHtml } from '../utils.js';
import { extractResponseContent } from '../agents/shared.js';
import { haikuModel } from '../models.js';

const SEARCH_SYSTEM = `You are a web search assistant. Search for the user's query and provide a clear, concise answer based on the search results. Always cite your sources. Be brief but comprehensive. Use British English.`;

export async function searchCommand(ctx) {
  const query = (ctx.message.text || '').replace(/^\/search\s*/, '').trim();
  if (!query) {
    return ctx.replyWithHTML(
      '<b>Usage:</b> <code>/search &lt;query&gt;</code>\n\n' +
      'Search the web and get an AI-summarized answer.\n' +
      '<i>Uses Claude Haiku + web search (very low cost).</i>'
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return ctx.replyWithHTML('🔴 <code>ANTHROPIC_API_KEY</code> not configured.');
  }

  const placeholder = await ctx.replyWithHTML('🔍 <i>Searching...</i>');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: haikuModel(),
        max_tokens: 1024,
        system: SEARCH_SYSTEM,
        messages: [{ role: 'user', content: query }],
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 5,
          // Haiku 4.5 doesn't support programmatic tool calling (dynamic filtering),
          // so web search must be called directly or the API returns a 400.
          allowed_callers: ['direct'],
          user_location: {
            // Israel ('IL') is not a supported web_search country code — omit it.
            // city + timezone still localise results (at least one field is required).
            type: 'approximate',
            city: 'Netanya',
            timezone: 'Asia/Jerusalem',
          },
        }],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`API returned ${res.status}: ${errBody.slice(0, 200)}`);
    }

    const data = await res.json();
    const { text, sources } = extractResponseContent(data);

    if (!text) throw new Error('No response text from search');

    let response = truncate(mdToHtml(text), 3700);
    if (sources.length) {
      const links = sources.map((s) =>
        `<a href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a>`
      ).join('\n');
      response += `\n\n📎 <b>Sources:</b>\n${links}`;
    }

    await ctx.telegram.editMessageText(
      placeholder.chat.id, placeholder.message_id, undefined,
      response, { parse_mode: 'HTML', disable_web_page_preview: true }
    ).catch(() => ctx.replyWithHTML(response, { disable_web_page_preview: true }));

  } catch (err) {
    const errMsg = `🔴 Search failed: ${escapeHtml(err.message)}`;
    await ctx.telegram.editMessageText(
      placeholder.chat.id, placeholder.message_id, undefined,
      errMsg, { parse_mode: 'HTML' }
    ).catch(() => ctx.replyWithHTML(errMsg));
  }
}
