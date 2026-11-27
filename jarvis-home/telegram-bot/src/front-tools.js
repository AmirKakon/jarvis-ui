// Front-router tools. The front model picks actions by calling these tools
// natively (Anthropic tool use, or OpenAI function calling on the fallback);
// each call becomes an action object `{ <tool name>: true, ...input }`, the
// shape runOne() in brain.js dispatches on.

const ACK = { type: 'string', description: 'A brief in-persona message shown to the user while this runs, e.g. "Checking the weather, Sir."' };

const str = (description) => ({ type: 'string', description });

function tool(name, description, properties, required) {
  return {
    name,
    description,
    input_schema: {
      type: 'object',
      properties: { ...properties, acknowledge: ACK },
      required: [...required, 'acknowledge'],
    },
  };
}

const BASE_TOOLS = [
  tool('delegate',
    'Run a server task on the home server: Docker, systemctl, SSH, logs, deploys, disk/network diagnostics, file operations, n8n, qBittorrent, system health, curl/HTTP API calls (the server has full network access). Only RUNS things; never use it to change your own source code (that is selfdev).',
    {
      task: str('Full description of what to do, with context'),
      agent: {
        type: 'string',
        enum: ['docker-ops', 'diagnostics'],
        description: 'Optional faster, cheaper specialist: docker-ops for Docker/container work, diagnostics for system health/status checks. Omit for anything complex or multi-step.',
      },
    },
    ['task']),
  tool('search',
    'Quick web search for current events, real-time info, news, prices, weather in OTHER cities, anything needing up-to-date knowledge that one lookup can answer.',
    { query: str('Concise search query') },
    ['query']),
  tool('fetch',
    'Read a public web page or PDF the user shared and answer about its content. Not for Stremio/local stream URLs, magnet links or torrent hashes.',
    { url: str('The URL to read'), question: str('What the user wants to know about it') },
    ['url', 'question']),
  tool('compute',
    'Calculations, conversions, data analysis, charts, CSV analysis, programming puzzles. Runs code with NO internet access.',
    { task: str('What to calculate or generate') },
    ['task']),
  tool('ha',
    'Home Assistant: turn devices, scenes or scripts on/off, run the robot vacuum, and questions about Home Assistant states, history, automations, scripts, scenes and helpers.',
    { command: str('The full natural-language command or question') },
    ['command']),
  tool('remind',
    'Set, list, cancel or extend reminders: one-shot, recurring daily/weekly/monthly, and interval-based ("every N minutes/hours"). Never refuse a reminder request; always use this. '
      + 'For "set", fill the timing fields from the user\'s words; times are Israel local time and the code does all date maths. '
      + 'Relative ("in 30 minutes", "in 2 hours") → in_minutes. A day and/or clock time → date and/or time (time alone means the next time that clock time comes round; a day without a time defaults to 08:00). '
      + 'Repeating → repeat plus its fields: minutes/hours + every; hourly + minute; daily + time; weekly + weekday + time; monthly + day_of_month + time.',
    {
      action: { type: 'string', enum: ['set', 'list', 'cancel', 'extend'] },
      text: str("The user's full message"),
      message: str('set: what to remind about, without the timing words'),
      in_minutes: { type: 'integer', description: 'set: minutes from now for a relative time (also the first fire of a minutes/hours repeat when the user gives one)' },
      date: str('set: local date YYYY-MM-DD, resolved from CURRENT TIME ("tomorrow", "on Friday", "the 15th")'),
      time: str('set: local 24h clock time HH:MM ("9am" → 09:00, "8:30pm" → 20:30)'),
      repeat: { type: 'string', enum: ['none', 'minutes', 'hours', 'hourly', 'daily', 'weekly', 'monthly'], description: 'set: how it repeats; none for one-shot' },
      every: { type: 'integer', description: 'set: N for repeat minutes/hours ("every 5 minutes" → 5)' },
      minute: { type: 'integer', description: 'set: minute past the hour for repeat hourly ("every hour at :30" → 30)' },
      weekday: { type: 'integer', description: 'set: 1=Monday … 7=Sunday for repeat weekly' },
      day_of_month: { type: 'integer', description: 'set: 1-31 for repeat monthly' },
      reminder_id: { type: 'integer', description: 'cancel/extend: the reminder number, when the user gives one' },
      minutes: { type: 'integer', description: 'extend: how many minutes to push it back' },
    },
    ['action', 'text']),
  tool('weather',
    'Local weather here in Netanya: current conditions or forecast ("the weather", "will it rain", "this weekend", "tomorrow"). Other cities use search.',
    { question: str("The user's weather question") },
    ['question']),
  tool('calendar',
    'Calendar events: schedule/add a meeting, appointment or event, or list what is on the calendar for a day or range.',
    {
      action: { type: 'string', enum: ['create', 'list'] },
      text: str("The user's full message"),
    },
    ['action', 'text']),
  tool('research',
    "Deep research / multi-step analysis: several searches, cross-referencing sources, reading full pages, or web data combined with calculations/charts. Anything a single quick lookup can't answer.",
    { query: str('The full research question with all relevant context') },
    ['query']),
  tool('jellyfin',
    'Media library (Jellyfin): search movies/TV, recently added, continue watching / next up, "what should I watch tonight" recommendations, now playing, library scan.',
    { query: str("The user's full request") },
    ['query']),
  tool('bus',
    'Commute buses: next bus / ETA for lines 616 or 65, leaving home or returning, the train shuttle. Reads the bus monitor sensors.',
    { question: str("The user's bus question") },
    ['question']),
  tool('selfdev',
    "Modify your OWN source code or behaviour: monitoring scripts (scripts/*.sh), Telegram bot code (telegram-bot/src/**), prompts, .claude config. Use for any request to add/edit/comment/rename/refactor those files, add a feature or command to yourself, fix a bug in your own code, or make a check self-healing. Edits the codebase, syntax-checks, commits and offers a deploy.",
    { task: str('A clear, complete description of the code change, with all context') },
    ['task']),
];

export const FRONT_TOOL_NAMES = [...BASE_TOOLS.map((t) => t.name), 'mcp'];

function mcpTool(servers) {
  const list = servers.map((s) => `${s.name}${s.description ? ` (${s.description})` : ''}`).join('; ');
  return tool('mcp',
    `Connected external tool providers: ${list}. Use for requests matching one of these.`,
    {
      task: str("The user's full request in natural language"),
      complex: {
        type: 'boolean',
        description: 'true when the task spans several providers or needs multi-step reasoning (e.g. check a recipe against inventory, then update a list); false for a single simple lookup or action.',
      },
    },
    ['task']);
}

/** Anthropic tool definitions for the front router; adds `mcp` when any server is connected. */
export function frontTools(mcpServers = []) {
  return mcpServers.length ? [...BASE_TOOLS, mcpTool(mcpServers)] : BASE_TOOLS;
}

/** The same tools in OpenAI Chat Completions function-calling form. */
export function openaiTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function toAction(name, input) {
  if (!FRONT_TOOL_NAMES.includes(name)) {
    console.warn(`[front] Ignoring unknown tool call: ${name}`);
    return null;
  }
  return { ...(input && typeof input === 'object' ? input : {}), [name]: true };
}

/** Actions + direct-answer text from an Anthropic Messages response. */
export function fromAnthropic(data) {
  const blocks = data?.content || [];
  const actions = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => toAction(b.name, b.input))
    .filter(Boolean);
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { actions, text };
}

/** Actions + direct-answer text from an OpenAI Chat Completions response. */
export function fromOpenAI(data) {
  const message = data?.choices?.[0]?.message || {};
  const actions = (message.tool_calls || [])
    .map((c) => {
      try {
        return toAction(c.function?.name, JSON.parse(c.function?.arguments || '{}'));
      } catch {
        console.warn(`[front] Ignoring tool call with invalid arguments: ${c.function?.name}`);
        return null;
      }
    })
    .filter(Boolean);
  return { actions, text: (message.content || '').trim() };
}
