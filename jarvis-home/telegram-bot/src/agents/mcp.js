import { getMcpTools, callMcpTool } from '../services/mcp-client.js';
import { mcpSimpleModel, mcpComplexModel } from '../models.js';
import { clockContext, nowJerusalem, todayJerusalemISO } from '../utils.js';

// MCP tool-use agent: runs a short tool-calling loop over every tool exposed by
// the connected MCP servers (see services/mcp-client.js). The front router hands
// off natural-language requests that map to a connected provider (e.g. QRganize
// home inventory), and this agent picks and chains the right tools.
//
// Two tiers: simple single-provider lookups run on cheap/fast Haiku; complex or
// cross-provider tasks (e.g. cross-referencing a recipe against inventory) run
// on Sonnet, which is markedly more reliable at multi-step tool chaining. The
// front router flags which via the `complex` hint. Both resolve lazily from
// models.js (env-overridable via MCP_AGENT_MODEL / MCP_AGENT_MODEL_COMPLEX).
// Complex tasks get more tool-call rounds (e.g. checking many recipe ingredients
// against inventory one by one) before hitting the safety ceiling.
const MAX_ITERATIONS = { simple: 6, complex: 10 };

function mcpSystemPrompt() {
  return `You are JARVIS, a British AI assistant, using external tools on the user's behalf.

${clockContext()}

- Use the provided tools to fulfil the request, chaining calls when needed.
- You may combine tools from DIFFERENT providers in a single task — e.g. read a recipe's ingredients from one provider, then check stock and update a shopping list via another. Chain across them freely to satisfy the request.
- When matching names across providers (e.g. a recipe ingredient vs. an inventory item), normalise and search rather than expecting an exact string match; suggest sensible alternatives from what's available when something is missing.
- Resolve relative dates ("Friday night", "this week", "tonight") against the CURRENT TIME above before querying tools. Prefer concrete ISO dates in tool arguments when the tool accepts them.
- When the user asks to change something (add/consume/finish an item, update a shopping list), perform the action, then confirm concisely what you did.
- Give a short, clear final answer in British English, addressing the user as "Sir".
- If the tools return nothing useful or an item can't be found, say so honestly rather than inventing data.`;
}

const toText = (content) =>
  (content || []).map((c) => (c?.type === 'text' ? c.text : '')).join('');

export async function runMcpAgent(task, { complex = false } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, output: 'ANTHROPIC_API_KEY not configured' };

  const model = complex ? mcpComplexModel() : mcpSimpleModel();
  const maxIterations = complex ? MAX_ITERATIONS.complex : MAX_ITERATIONS.simple;

  let tools, lookup;
  try {
    ({ tools, lookup } = await getMcpTools());
  } catch (err) {
    return { ok: false, output: `MCP connection error: ${err.message}` };
  }
  if (!tools.length) {
    return { ok: false, output: 'No MCP tools are available. Check ~/jarvis/mcp.json.' };
  }

  console.log(`[mcp-agent] ${complex ? 'complex' : 'simple'} run on ${model} (max ${maxIterations} rounds)`);
  // Pin the clock in the user turn too — models attend more reliably to task text
  // than system text when resolving "Friday" / "this week" for meal-plan tools.
  const datedTask = `[Today is ${nowJerusalem()} (ISO ${todayJerusalemISO()}, Asia/Jerusalem).]\n\n${task}`;
  const messages = [{ role: 'user', content: datedTask }];

  for (let i = 0; i < maxIterations; i++) {
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
          model,
          max_tokens: 2048,
          system: mcpSystemPrompt(),
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
