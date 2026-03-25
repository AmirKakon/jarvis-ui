/**
 * Memory commands: /remember, /recall, /memory, /new
 */

import { Markup } from 'telegraf';
import { storeFact, searchMemory, getAllFacts, getMemoryStats } from '../memory.js';
import { forceNewSession } from '../claude.js';
import { escapeHtml, truncate } from '../utils.js';

/**
 * /remember <fact> — store a durable fact that never decays.
 */
async function handleRemember(ctx, args) {
  const fact = args.trim();
  if (!fact) {
    return ctx.replyWithHTML(
      '<b>Usage:</b> <code>/remember &lt;fact&gt;</code>\n\n' +
      'Examples:\n' +
      '<code>/remember NAS IP is 192.168.1.50</code>\n' +
      '<code>/remember Media library is on shared-storage-2</code>'
    );
  }

  const thinking = await ctx.replyWithHTML('💾 <i>Storing fact...</i>');

  try {
    const result = await storeFact(fact, null, 'telegram', String(ctx.chat?.id));

    let response;
    if (result.deduplicated) {
      response = `⚠️ Similar fact already exists:\n<i>"${escapeHtml(result.existing)}"</i>\n\nSkipped to avoid duplicates.`;
    } else {
      response = `✅ Remembered:\n<i>"${escapeHtml(fact)}"</i>\n\nThis fact will be included in all future conversations.`;
    }

    await ctx.telegram.editMessageText(
      thinking.chat.id, thinking.message_id, undefined,
      response, { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.error('Remember error:', err.message);
    await ctx.telegram.editMessageText(
      thinking.chat.id, thinking.message_id, undefined,
      `🔴 Failed to store fact: ${escapeHtml(err.message)}`,
      { parse_mode: 'HTML' }
    );
  }
}

/**
 * /recall <query> — search memory for relevant past conversations and facts.
 */
async function handleRecall(ctx, args) {
  const query = args.trim();
  if (!query) {
    return ctx.replyWithHTML(
      '<b>Usage:</b> <code>/recall &lt;query&gt;</code>\n\n' +
      'Examples:\n' +
      '<code>/recall NAS setup</code>\n' +
      '<code>/recall qBittorrent configuration</code>'
    );
  }

  const thinking = await ctx.replyWithHTML('🔍 <i>Searching memory...</i>');

  try {
    const [memories, facts] = await Promise.all([
      searchMemory(query, 5),
      getAllFacts(),
    ]);

    const parts = [];

    // Filter facts by simple keyword match for display
    const queryWords = query.toLowerCase().split(/\s+/);
    const matchingFacts = facts.filter((f) =>
      queryWords.some((w) => f.content.toLowerCase().includes(w))
    );

    if (matchingFacts.length) {
      parts.push('<b>📌 Matching Facts:</b>');
      for (const f of matchingFacts) {
        parts.push(`• ${escapeHtml(f.content)}`);
      }
      parts.push('');
    }

    if (memories.length) {
      parts.push('<b>🧠 Relevant Conversations:</b>');
      for (const m of memories) {
        const age = m.age_days === 0 ? 'today' : m.age_days === 1 ? 'yesterday' : `${m.age_days}d ago`;
        const score = (m.score * 100).toFixed(0);
        const topics = m.topics?.length ? ` <i>(${m.topics.join(', ')})</i>` : '';
        parts.push(`• [${age}, ${score}%]${topics}\n  ${escapeHtml(truncate(m.summary, 200))}`);
      }
    }

    if (!parts.length) {
      parts.push('No matching memories found.');
    }

    await ctx.telegram.editMessageText(
      thinking.chat.id, thinking.message_id, undefined,
      parts.join('\n'), { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.error('Recall error:', err.message);
    await ctx.telegram.editMessageText(
      thinking.chat.id, thinking.message_id, undefined,
      `🔴 Memory search failed: ${escapeHtml(err.message)}`,
      { parse_mode: 'HTML' }
    );
  }
}

/**
 * /memory — show memory stats.
 */
async function handleStats(ctx) {
  try {
    const stats = await getMemoryStats();

    const lines = [
      '<b>🧠 Memory Stats</b>',
      '',
      `📌 Durable facts: <b>${stats.facts}</b>`,
      `📝 Session summaries: <b>${stats.summaries}</b>`,
    ];

    if (stats.oldest) {
      lines.push(`📅 Oldest memory: ${new Date(stats.oldest).toLocaleDateString()}`);
    }
    if (stats.newest) {
      lines.push(`📅 Newest memory: ${new Date(stats.newest).toLocaleDateString()}`);
    }

    if (stats.topTopics.length) {
      lines.push('', '<b>Top topics:</b>');
      for (const t of stats.topTopics.slice(0, 5)) {
        lines.push(`  • ${escapeHtml(t.topic)} (${t.count})`);
      }
    }

    await ctx.replyWithHTML(lines.join('\n'));
  } catch (err) {
    console.error('Memory stats error:', err.message);
    await ctx.replyWithHTML(`🔴 Could not fetch memory stats: ${escapeHtml(err.message)}`);
  }
}

/**
 * /new — end current session, summarize it, start fresh.
 */
async function handleNew(ctx) {
  const chatId = String(ctx.chat?.id || 'default');
  const thinking = await ctx.replyWithHTML('📋 <i>Summarizing current session...</i>');

  try {
    const result = await forceNewSession(chatId);

    let response;
    if (result) {
      const topics = result.topics?.length ? `\n<b>Topics:</b> ${result.topics.join(', ')}` : '';
      const factsLine = result.facts > 0 ? `\n📌 Extracted <b>${result.facts}</b> durable fact(s)` : '';
      response = `✅ Session summarized and archived.\n\n<i>"${escapeHtml(truncate(result.summary, 300))}"</i>${topics}${factsLine}\n\nStarting a fresh session.`;
    } else {
      response = '✅ Starting a fresh session. (Previous session was too short to summarize.)';
    }

    await ctx.telegram.editMessageText(
      thinking.chat.id, thinking.message_id, undefined,
      response, { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.error('New session error:', err.message);
    await ctx.telegram.editMessageText(
      thinking.chat.id, thinking.message_id, undefined,
      `🔴 Failed to close session: ${escapeHtml(err.message)}`,
      { parse_mode: 'HTML' }
    );
  }
}

/**
 * Main /remember, /recall, /memory, /new command router.
 */
export function memoryCommand(commandName) {
  return async (ctx) => {
    const text = (ctx.message.text || '').trim();
    const args = text.replace(/^\/\w+(@\w+)?\s*/, '');

    switch (commandName) {
      case 'remember': return handleRemember(ctx, args);
      case 'recall':   return handleRecall(ctx, args);
      case 'memory':   return handleStats(ctx);
      case 'new':      return handleNew(ctx);
    }
  };
}
