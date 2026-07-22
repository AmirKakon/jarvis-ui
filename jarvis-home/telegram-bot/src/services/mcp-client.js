// Generic, config-driven MCP client for JARVIS.
//
// Connects to any number of MCP servers declared in a JSON config file
// (default: ~/jarvis/mcp.json). Each server may be reached over HTTP
// (Streamable HTTP, with SSE fallback) or spawned as a stdio child process.
// Tools from every connected server are exposed to the LLM in Anthropic
// tool format, namespaced as `<server>__<tool>` so names never collide.
//
// Adding a new tool provider is purely a config change — no code edits.
//
// Config shape (~/jarvis/mcp.json):
// {
//   "mcpServers": {
//     "qrganize": {
//       "url": "https://host/api/mcp",
//       "headers": { "Authorization": "Bearer <token>" },
//       "description": "Home inventory: stock, locations, shopping list, expiring items"
//     },
//     "some-local-tool": {
//       "command": "node",
//       "args": ["/path/to/server.js"],
//       "env": { "FOO": "bar" },
//       "description": "..."
//     }
//   }
// }

import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CONFIG_PATH = process.env.MCP_CONFIG_PATH
  || `${process.env.HOME || '/home/iot'}/jarvis/mcp.json`;

let configCache;        // parsed config (undefined until first read)
let connections;        // Map<serverName, { client, tools }> — lazily populated
let initPromise;        // in-flight connect-all promise (dedupes concurrent calls)

// --- Config ---

function loadConfig() {
  if (configCache !== undefined) return configCache;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    configCache = (parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers)
      ? { mcpServers: parsed.mcpServers }
      : { mcpServers: {} };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[mcp] Failed to read ${CONFIG_PATH}: ${err.message}`);
    configCache = { mcpServers: {} };
  }
  return configCache;
}

const enabledServers = () =>
  Object.entries(loadConfig().mcpServers).filter(([, c]) => c && !c.disabled);

// One-line summaries for prompt injection (name + description).
export function mcpServerSummaries() {
  return enabledServers().map(([name, c]) => ({ name, description: c.description || '' }));
}

export function hasMcpServers() {
  return enabledServers().length > 0;
}

// --- Connection ---

async function connectServer(name, cfg) {
  const client = new Client({ name: 'jarvis', version: '1.0.0' }, { capabilities: {} });

  if (cfg.url) {
    const url = new URL(cfg.url);
    const headers = cfg.headers || undefined;
    try {
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
    } catch (httpErr) {
      // Fall back to SSE transport for older/alternative MCP servers.
      console.error(`[mcp] "${name}" Streamable HTTP failed (${httpErr.message}); trying SSE`);
      await client.connect(new SSEClientTransport(url, {
        requestInit: { headers },
        eventSourceInit: {
          fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers || {}), ...(headers || {}) } }),
        },
      }));
    }
  } else if (cfg.command) {
    await client.connect(new StdioClientTransport({
      command: cfg.command,
      args: cfg.args || [],
      env: { ...process.env, ...(cfg.env || {}) },
    }));
  } else {
    throw new Error('server config has neither "url" nor "command"');
  }

  const { tools } = await client.listTools();
  return { client, tools };
}

// Connect to every enabled server once; cache the result. Failures are logged
// and skipped so one bad server doesn't take down the rest.
function ensureConnected() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    connections = new Map();
    for (const [name, cfg] of enabledServers()) {
      try {
        const conn = await connectServer(name, cfg);
        connections.set(name, conn);
        console.log(`[mcp] Connected "${name}" (${conn.tools.length} tools)`);
      } catch (err) {
        console.error(`[mcp] Failed to connect "${name}": ${err.message}`);
      }
    }
    return connections;
  })();
  return initPromise;
}

// --- Tool exposure ---

const sanitize = (s) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

// Returns Anthropic-format tools across all servers plus a lookup map from the
// namespaced tool name back to { server, tool } for dispatching calls.
export async function getMcpTools() {
  const conns = await ensureConnected();
  const tools = [];
  const lookup = new Map();

  for (const [server, { tools: serverTools }] of conns) {
    const prefix = sanitize(server);
    for (const t of serverTools) {
      let fq = `${prefix}__${t.name}`;
      if (fq.length > 64) fq = fq.slice(0, 64);
      // Guard against the rare truncation collision.
      let n = 1;
      while (lookup.has(fq)) fq = `${prefix}__${t.name}`.slice(0, 62) + String(n++).padStart(2, '0');

      tools.push({
        name: fq,
        description: t.description || `${t.name} (via ${server})`,
        input_schema: t.inputSchema || { type: 'object', properties: {} },
      });
      lookup.set(fq, { server, tool: t.name });
    }
  }

  return { tools, lookup };
}

export async function callMcpTool(server, tool, args) {
  const conns = await ensureConnected();
  const conn = conns.get(server);
  if (!conn) throw new Error(`MCP server "${server}" not connected`);
  return conn.client.callTool({ name: tool, arguments: args || {} });
}

// --- Lifecycle ---

export async function closeMcp() {
  if (!connections) return;
  for (const [, { client }] of connections) {
    try { await client.close(); } catch { /* ignore */ }
  }
  connections = null;
  initPromise = null;
}
