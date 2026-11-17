import { runMcpAgent } from './mcp.js';
import { resolveAndExecute } from './ha.js';
import { clockContext } from '../utils.js';

// Home Assistant subagent: the only route chat takes to HA. Reads, history,
// logs, automations, scripts, scenes and helpers go through the ha-mcp server
// (minus the tools below). Device changes go through ha_control, which keeps the
// on/off guard and HA_AGENT_EXCLUDE; ha-mcp's raw service calls would skip both.

export const HA_SERVER = 'homeassistant';

const DEVICE_BYPASS_TOOLS = new Set(['ha_call_service', 'ha_bulk_control', 'ha_call_event']);
// Restarting or reloading HA, and anything that removes or deletes config, data or files.
const DESTRUCTIVE_TOOL = /^ha_(restart|reload_core)$|(^|_)(remove|delete)(_|$)/;

export const isNonHaServer = (server) => server !== HA_SERVER;
export const isHaTool = (server, tool) =>
  server === HA_SERVER && !DEVICE_BYPASS_TOOLS.has(tool) && !DESTRUCTIVE_TOOL.test(tool);

const CONTROL_TOOL = {
  name: 'ha_control',
  description: 'Turn a Home Assistant device, scene or script on, off or toggle it, from the user\'s command as they said it (e.g. "turn off the bedroom light"). This is the only way to change device state.',
  input_schema: {
    type: 'object',
    properties: { command: { type: 'string', description: 'The user\'s command, as they said it' } },
    required: ['command'],
  },
};

function haSystemPrompt() {
  return `You are JARVIS, a British AI assistant, handling the user's Home Assistant.

${clockContext()}

- To change a device, scene or script, call ha_control with the user's command. Never use any other tool to change device state.
- Use the other tools to read states, history, logs, automations, scripts, scenes and helpers, and to edit them when the user asks.
- Report ha_control's result as it is; do not claim an action it did not report.
- Give a short, clear final answer in British English, addressing the user as "Sir".
- If a tool returns nothing useful, say so rather than inventing data.`;
}

export function runHaSubagent(command) {
  return runMcpAgent(command, {
    include: isHaTool,
    localTools: [{ tool: CONTROL_TOOL, run: (input) => resolveAndExecute(String(input.command || '')) }],
    system: haSystemPrompt(),
  });
}
