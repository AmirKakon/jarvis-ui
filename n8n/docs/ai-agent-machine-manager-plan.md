# AI Agent Machine Manager - Architecture Plan

> Last updated: January 11, 2026

## 🏗️ Architecture Overview (v2 - Backend-Hosted LLM)

The Machine Manager tools are now called by the **FastAPI backend** rather than an n8n AI Agent. This provides better streaming, lower latency, and easier model swapping.

```
┌─────────────────────────────────────────────────────────────┐
│                    FastAPI Backend                          │
│                    Port 20005                               │
├─────────────────────────────────────────────────────────────┤
│  LLM Orchestrator (Python)                                  │
│  - Direct OpenAI/Anthropic API calls                        │
│  - Native WebSocket streaming                               │
│  - Tool/function calling                                    │
├─────────────────────────────────────────────────────────────┤
│                     Tool Registry                           │
├──────────────┬──────────────┬──────────────┬───────────────┤
│   Built-in   │   n8n Tools  │   Memory     │   Workflow    │
│   (Python)   │   (HTTP)     │   (Python)   │   (n8n)       │
└──────────────┴──────────────┴──────────────┴───────────────┘
         │              │              │              │
         ▼              ▼              ▼              ▼
    Calculator     Tool Executor   PGVector DB    N8N Manager
    Time/Date      (n8n Webhook)
```

### Tool Execution Flow

```
User Message → Backend → LLM (with tools) → Tool Call Decision
                                                    ↓
                              ┌─────────────────────┴─────────────────────┐
                              │                                           │
                        Built-in Tool                              n8n Tool
                        (Python function)                          (HTTP POST)
                              │                                           │
                              ▼                                           ▼
                        Direct execution                    Tool Executor Webhook
                              │                                           │
                              └─────────────────────┬─────────────────────┘
                                                    ▼
                                        Tool Result → LLM → Response
                                                    ↓
                                        Stream to Frontend via WebSocket
```

---

## 🌐 Port Mapping

| Port  | Service           | Description                |
|-------|-------------------|---------------------------|
| 20000 | SSH               | Remote access              |
| 20001 | Jellyfin          | Media server               |
| 20002 | n8n               | Automation platform        |
| 20004 | PostgreSQL        | Database (pgvector)        |
| 20005 | Jarvis Backend    | FastAPI backend (LLM host) |
| 20006 | Jarvis Frontend   | React frontend             |

---

## 🛠️ Tool Categories

### 1. Built-in Tools (Python - Backend)

These run directly in the FastAPI backend without calling n8n:

| Tool Name | Description | Implementation |
|-----------|-------------|----------------|
| `calculator` | Mathematical operations | Python `eval` with safety |
| `get_current_time` | Current date/time | Python `datetime` |
| `search_memory` | Search long-term memory | PGVector similarity search |
| `store_memory` | Store to long-term memory | PGVector insert with governance |

### 2. Infrastructure Tools (n8n via Tool Executor)

These call the n8n Tool Executor webhook which routes to sub-workflows:

| Tool Name | Description | n8n Workflow |
|-----------|-------------|--------------|
| `system_status` | CPU, RAM, disk, network | Machine Manager - System Status |
| `docker_control` | Container management | Machine Manager - Docker Control |
| `service_control` | Systemd services | Machine Manager - Service Control |
| `jellyfin_api` | Media server API | Machine Manager - Jellyfin API |
| `ssh_command` | Arbitrary SSH commands | sudo ssh commands |
| `gemini_cli` | Query Gemini AI | gemini cli trigger |

### 3. Workflow Management Tools (n8n via Tool Executor)

| Tool Name | Description | n8n Workflow |
|-----------|-------------|--------------|
| `n8n_workflow_list` | List all workflows | N8N Manager - Workflow List |
| `n8n_workflow_get` | Get workflow details | N8N Manager - Workflow Get |
| `n8n_workflow_create` | Create new workflow | N8N Manager - Workflow Create |
| `n8n_workflow_update` | Update workflow | N8N Manager - Workflow Update |
| `n8n_workflow_delete` | Delete workflow | N8N Manager - Workflow Delete |
| `n8n_workflow_activate` | Activate workflow | N8N Manager - Workflow Activate |
| `n8n_workflow_deactivate` | Deactivate workflow | N8N Manager - Workflow Deactivate |
| `n8n_workflow_execute` | Execute workflow | N8N Manager - Workflow Execute |

---

## 📋 n8n Workflows

### Workflow 1: Tool Executor (NEW - Single Entry Point)

**Purpose**: Route incoming tool requests to the appropriate sub-workflow.

**Trigger**: Webhook POST `/webhook/tool-executor`

**Input Schema**:
```json
{
  "tool": "docker_control",
  "params": {
    "action": "ps",
    "containerName": "optional"
  }
}
```

**Output Schema**:
```json
{
  "status": "success",
  "tool": "docker_control",
  "result": { ... },
  "error": null,
  "timestamp": "2026-01-11T12:00:00Z"
}
```

**Nodes**:
1. Webhook - Receive POST requests
2. Switch - Route by `tool` field
3. Execute Workflow - Call appropriate sub-workflow
4. Format Output - Standardize response
5. Respond to Webhook - Return result

### Workflow 2: Machine Manager - System Status (Existing)

**Purpose**: Get system information via SSH.

**Input**: `infoType` (cpu, memory, disk, network, processes, uptime, all)

### Workflow 3: Machine Manager - Docker Control (Existing)

**Purpose**: Manage Docker containers via SSH.

**Input**: `action`, `containerName`

### Workflow 4: Machine Manager - Service Control (Existing)

**Purpose**: Manage systemd services via SSH.

**Input**: `action`, `serviceName`

### Workflow 5: Machine Manager - Jellyfin API (Existing)

**Purpose**: Interact with Jellyfin media server.

**Input**: `action`, `params`

### Workflow 6: Machine Manager - Health Monitor (Existing, Scheduled)

**Purpose**: Automated health checks with Telegram alerts.

**Trigger**: Schedule (every 1 hour)

---

## 🔧 Backend Tool Registry Implementation

```python
# backend/services/tool_registry.py

from typing import Callable, Any
import httpx

class ToolRegistry:
    """Registry of all available tools for the LLM"""
    
    def __init__(self, n8n_webhook_url: str):
        self.n8n_url = n8n_webhook_url
        self.tools: dict[str, Callable] = {}
        self._register_all_tools()
    
    def _register_all_tools(self):
        """Register all available tools"""
        # Built-in tools
        self.tools["calculator"] = self._calculator
        self.tools["get_current_time"] = self._get_current_time
        self.tools["search_memory"] = self._search_memory
        self.tools["store_memory"] = self._store_memory
        
        # n8n infrastructure tools
        for tool in ["system_status", "docker_control", "service_control", 
                     "jellyfin_api", "ssh_command", "gemini_cli"]:
            self.tools[tool] = self._make_n8n_tool(tool)
        
        # n8n workflow management tools
        for action in ["list", "get", "create", "update", "delete", 
                       "activate", "deactivate", "execute"]:
            self.tools[f"n8n_workflow_{action}"] = self._make_n8n_tool(f"n8n_workflow_{action}")
    
    def _make_n8n_tool(self, tool_name: str) -> Callable:
        """Create a callable that invokes n8n Tool Executor"""
        async def call_n8n(params: dict) -> dict:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    self.n8n_url,
                    json={"tool": tool_name, "params": params},
                    timeout=120.0
                )
                return response.json()
        return call_n8n
    
    async def execute(self, tool_name: str, params: dict) -> dict:
        """Execute a tool by name"""
        if tool_name not in self.tools:
            return {"status": "error", "error": f"Unknown tool: {tool_name}"}
        
        try:
            result = await self.tools[tool_name](params)
            return {"status": "success", "result": result}
        except Exception as e:
            return {"status": "error", "error": str(e)}
    
    def get_schemas(self) -> list[dict]:
        """Return OpenAI-compatible tool schemas"""
        return [
            # Infrastructure tools
            {
                "type": "function",
                "function": {
                    "name": "system_status",
                    "description": "Get system information: CPU, memory, disk, network",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "infoType": {
                                "type": "string",
                                "enum": ["cpu", "memory", "disk", "network", "processes", "uptime", "all"],
                                "description": "Type of system info to retrieve"
                            }
                        },
                        "required": ["infoType"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "docker_control",
                    "description": "Manage Docker containers",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "action": {
                                "type": "string",
                                "enum": ["ps", "list", "running", "stats", "logs", "start", "stop", "restart", "inspect", "images", "volumes", "networks"],
                                "description": "Docker operation to perform"
                            },
                            "containerName": {
                                "type": "string",
                                "description": "Container name (required for some actions)"
                            }
                        },
                        "required": ["action"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "service_control",
                    "description": "Manage systemd services",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "action": {
                                "type": "string",
                                "enum": ["status", "start", "stop", "restart", "enable", "disable", "list", "failed", "logs"],
                                "description": "Service operation to perform"
                            },
                            "serviceName": {
                                "type": "string",
                                "description": "Service name (required for most actions)"
                            }
                        },
                        "required": ["action"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "ssh_command",
                    "description": "Execute an SSH command with sudo privileges",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "command": {
                                "type": "string",
                                "description": "The command to execute (without sudo prefix)"
                            }
                        },
                        "required": ["command"]
                    }
                }
            },
            # ... more tool schemas
        ]
```

---

## 🔐 Security Considerations

1. **Command Sanitization** - Backend validates tool parameters before sending to n8n
2. **Whitelist Commands** - Only pre-approved commands allowed for ssh_command
3. **Rate Limiting** - Backend limits tool calls per session
4. **Audit Logging** - All tool calls logged with session ID and timestamp
5. **Credentials** - n8n uses credentials store, backend uses env vars

---

## 🚀 Implementation Status

### Phase 1 - Core Infrastructure ✅ COMPLETE
- [x] `system_status` tool → Machine Manager - System Status
- [x] `service_control` tool → Machine Manager - Service Control
- [x] `docker_control` tool → Machine Manager - Docker Control
- [x] `jellyfin_api` tool → Machine Manager - Jellyfin API
- [x] `ssh_command` tool → sudo ssh commands
- [x] `gemini_cli` tool → gemini cli trigger

### Phase 2 - Workflow Management ✅ COMPLETE
- [x] N8N Manager - API Request (base)
- [x] N8N Manager - Workflow List
- [x] N8N Manager - Workflow Get
- [x] N8N Manager - Workflow Create
- [x] N8N Manager - Workflow Update
- [x] N8N Manager - Workflow Delete
- [x] N8N Manager - Workflow Activate
- [x] N8N Manager - Workflow Deactivate
- [x] N8N Manager - Workflow Execute

### Phase 3 - Backend Migration 🔄 IN PROGRESS
- [ ] Tool Executor workflow (single entry point)
- [ ] Backend LLM orchestrator
- [ ] Backend tool registry
- [ ] WebSocket streaming handler
- [ ] Memory tools in backend

### Phase 4 - Health & Monitoring ✅ COMPLETE
- [x] Machine Manager - Health Monitor (scheduled)
- [x] Telegram notifications

---

## 📝 Notes

- All infrastructure tools require SSH access via `IOT_Kamuri` credentials
- The Tool Executor provides a single entry point for all n8n tool calls
- Backend handles LLM orchestration, streaming, and session management
- n8n focuses on infrastructure operations via SSH/HTTP
- Model swapping now done via `LLM_PROVIDER` and `LLM_MODEL` env vars
