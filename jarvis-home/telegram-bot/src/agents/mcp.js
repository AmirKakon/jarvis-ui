import { getMcpTools, callMcpTool } from '../services/mcp-client.js';

// MCP tool-use agent: runs a short tool-calling loop over every tool exposed by
// the connected MCP servers (see services/mcp-client.js). The front router hands
// off natural-language requests that map to a connected provider (e.g. QRganize
// home inventory), and this agent picks and chains the right tools.
//
// Default model is Haiku 4.5 — plenty capable for the mostly single-step tool
// calls these providers expose, and cheap/fast. Override with MCP_AGENT_MODEL
// (e.g. claude-sonnet-5) for heavier multi-step reasoning.
const MCP_AGENT_MODEL = process.env.MCP_AGENT_MODEL || 'claude-haiku-4-5-20251001';
const MAX_ITERATIONS = 6;

const SYSTEM = `You are JARVIS, a British AI assistant, using external tools on the user's behalf.

- Use the provided tools to fulfil the request, chaining calls when needed.
- When the user asks to change something (add/consume/finish an item, update a shopping list), perform the action, then confirm concisely what you did.
- Give a short, clear final answer in British English, addressing the user as "Sir".
- If the tools return nothing useful or an item can't be found, say so honestly rather than inventing data.`;

const toText = (content) =>
  (content || []).map((c) => (c?.type === 'text' ? c.text : '')).join('');

export async function runMcpAgent(task) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, output: 'ANTHROPIC_API_KEY not configured' };

  let tools, lookup;
  try {
    ({ tools, lookup } = await getMcpTools());
  } catch (err) {
    return { ok: false, output: `MCP connection error: ${err.message}` };
  }
  if (!tools.length) {
    return { ok: false, output: 'No MCP tools are available. Check ~/jarvis/mcp.json.' };
  }

  const messages = [{ role: 'user', content: task }];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let data;
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MCP_AGENT_MODEL,
          max_tokens: 2048,
          system: SYSTEM,
          tools,
          messages,
        }),
        signal: AbortSignal.timeout(90_000),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.error(`[mcp-agent] API error ${res.status}: ${errBody.slice(0, 500)}`);
        let detail = '';
        try { detail = JSON.parse(errBody)?.error?.message || ''; } catch { /* non-JSON */ }
        return { ok: false, output: `MCP agent API error ${res.status}${detail ? `: ${detail}` : ''}` };
      }
      data = await res.json();
    } catch (err) {
      return { ok: false, output: err.message };
    }

    const toolUses = (data.content || []).filter((b) => b.type === 'tool_use');
    if (data.stop_reason !== 'tool_use' || !toolUses.length) {
      const text = toText(data.content).trim();
      return { ok: !!text, output: text || 'Done, Sir.' };
    }

    // Feed the assistant's tool-use turn back, then execute each tool call.
    messages.push({ role: 'assistant', content: data.content });

    const results = [];
    for (const tu of toolUses) {
      const target = lookup.get(tu.name);
      if (!target) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: `Unknown tool: ${tu.name}` });
        continue;
      }
      try {
        console.log(`[mcp-agent] ${target.server}.${target.tool}(${JSON.stringify(tu.input || {}).slice(0, 200)})`);
        const r = await callMcpTool(target.server, target.tool, tu.input || {});
        const text = toText(r.content) || JSON.stringify(r.content ?? r);
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: text.slice(0, 8000),
          is_error: !!r.isError,
        });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: err.message });
      }
    }
    messages.push({ role: 'user', content: results });
  }

  return { ok: false, output: 'MCP agent reached its step limit without finishing.' };
}
