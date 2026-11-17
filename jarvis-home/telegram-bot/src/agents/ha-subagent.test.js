import { test } from 'node:test';
import assert from 'node:assert/strict';

// No mcp.json and a dummy key: the run uses only the local tool and a stubbed fetch.
process.env.MCP_CONFIG_PATH = '/nonexistent/mcp.json';
process.env.ANTHROPIC_API_KEY = 'test-key';
const { HA_SERVER, isHaTool, isNonHaServer } = await import('./ha-subagent.js');
const { runMcpAgent } = await import('./mcp.js');

test('HA subagent keeps HA tools but not the raw device service calls, restarts, deletes or other servers', () => {
  assert.equal(isHaTool(HA_SERVER, 'ha_get_state'), true);
  assert.equal(isHaTool(HA_SERVER, 'ha_config_set_automation'), true);
  assert.equal(isHaTool(HA_SERVER, 'ha_call_service'), false);
  assert.equal(isHaTool(HA_SERVER, 'ha_restart'), false);
  assert.equal(isHaTool(HA_SERVER, 'ha_reload_core'), false);
  assert.equal(isHaTool(HA_SERVER, 'ha_config_remove_automation'), false);
  assert.equal(isHaTool(HA_SERVER, 'ha_remove_entity'), false);
  assert.equal(isHaTool(HA_SERVER, 'ha_delete_file'), false);
  assert.equal(isHaTool(HA_SERVER, 'ha_config_delete_dashboard'), false);
  assert.equal(isHaTool('qrganize', 'list_inventory'), false);
  assert.equal(isNonHaServer('qrganize'), true);
  assert.equal(isNonHaServer(HA_SERVER), false);
});

test('runMcpAgent runs a local tool and returns its result to the model', async () => {
  const replies = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'ha_control', input: { command: 'turn off the bedroom light' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Bedroom light is off, Sir.' }] },
  ];
  const bodies = [];
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(replies[bodies.length - 1]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await runMcpAgent('turn off the bedroom light', {
      system: 'test system',
      localTools: [{
        tool: { name: 'ha_control', description: 'control', input_schema: { type: 'object', properties: {} } },
        run: async (input) => {
          calls.push(input);
          return { ok: true, output: 'Bedroom Light — turn_off executed.' };
        },
      }],
    });

    assert.deepEqual(bodies[0].tools.map((t) => t.name), ['ha_control']);
    assert.equal(bodies[0].system, 'test system');
    assert.deepEqual(calls, [{ command: 'turn off the bedroom light' }]);
    assert.deepEqual(result, { ok: true, output: 'Bedroom light is off, Sir.' });
    const toolResult = bodies[1].messages.at(-1).content[0];
    assert.equal(toolResult.tool_use_id, 't1');
    assert.equal(toolResult.content, 'Bedroom Light — turn_off executed.');
    assert.equal(toolResult.is_error, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
