# Jarvis UI - Strategy & Implementation Plan

## Executive Summary

This document outlines the strategy and architecture for building a web-based UI for Jarvis, an AI assistant. The solution uses a **backend-hosted LLM architecture** where the FastAPI backend directly communicates with LLM providers, with n8n serving as a **tool executor** for infrastructure operations. This design enables:

- ✅ Native streaming support via WebSocket
- ✅ Easy model swapping via LLM abstraction layer
- ✅ Faster response times (direct LLM calls)
- ✅ Single n8n entry point for all tools
- ✅ Future extensibility (speech I/O, file sharing, multi-device)

---

## Architecture Overview

### High-Level Architecture (v2 - Backend-Hosted LLM)

```
┌─────────────────┐
│  React Frontend │ (Port 20006)
└────────┬────────┘
         │ WebSocket (streaming)
         │ HTTP REST API
┌────────▼─────────────────────────────────────────────────┐
│  Python FastAPI Backend (Port 20005)                     │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  LLM Orchestrator                                   │ │
│  │  - Direct LLM API calls (OpenAI, Anthropic, etc.)   │ │
│  │  - Streaming responses to WebSocket                 │ │
│  │  - Tool/function calling                            │ │
│  │  - Session & conversation memory                    │ │
│  └─────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Tool Registry                                      │ │
│  │  - Built-in tools (calculator, memory, etc.)        │ │
│  │  - n8n tool executor (HTTP calls to n8n webhook)    │ │
│  └─────────────────────────────────────────────────────┘ │
└────────┬─────────────────────────────────────────────────┘
         │ HTTP POST (only when tool execution needed)
┌────────▼────────────────────┐     ┌─────────────────────┐
│  n8n Tool Executor Workflow │     │  PostgreSQL+PGVector │
│  (Single Entry Point)       │     │  - sessions          │
│  ├── System Status          │     │  - messages          │
│  ├── Docker Control         │     │  - long_term_memory  │
│  ├── Service Control        │     └─────────────────────┘
│  ├── Jellyfin API           │
│  ├── SSH Commands           │
│  └── Gemini CLI             │
└─────────────────────────────┘
```

### Why This Architecture?

| Aspect | Previous (n8n-hosted LLM) | New (Backend-hosted LLM) |
|--------|---------------------------|--------------------------|
| **Streaming** | ❌ Broken through webhook | ✅ Native WebSocket streaming |
| **Latency** | ~2-5s overhead per request | ~200ms overhead |
| **Model Swapping** | Edit n8n workflow | Change config/env var |
| **Tool Calls** | n8n sub-workflows for everything | HTTP only when needed |
| **Session Memory** | Duplicated (backend + n8n) | Single source (backend) |
| **Debugging** | Complex n8n execution logs | Python logging/tracing |

---

## Technology Stack

### Backend
- **Python FastAPI**: Modern, async, excellent WebSocket support
- **LLM Client**: OpenAI SDK with abstraction layer for easy model swapping
- **PostgreSQL + PGVector**: Sessions, messages, and vector memory storage
- **WebSocket**: Real-time bidirectional streaming
- **httpx**: Async HTTP client for n8n tool calls

### Frontend
- **React**: Modern UI framework, future React Native compatibility
- **WebSocket Client**: Real-time streaming message updates
- **LocalStorage**: Session persistence across reloads

### n8n (Tool Executor)
- **Single Webhook Endpoint**: Routes to appropriate tool sub-workflows
- **Existing Tools**: System Status, Docker Control, Service Control, Jellyfin API, SSH Commands, Gemini CLI
- **No LLM Logic**: Pure tool execution, no AI decision-making

---

## LLM Abstraction Layer

### Purpose
Decouple LLM provider logic from the application, enabling easy switching between providers (OpenAI, Anthropic, local models, etc.)

### Implementation

```python
from abc import ABC, abstractmethod
from typing import AsyncIterator, Optional

class LLMProvider(ABC):
    """Abstract base for LLM providers"""
    
    @abstractmethod
    async def chat_stream(
        self, 
        messages: list[dict], 
        tools: Optional[list[dict]] = None,
        system_prompt: Optional[str] = None
    ) -> AsyncIterator[dict]:
        """Stream chat completions with optional tool calling"""
        pass
    
    @abstractmethod
    async def chat(
        self, 
        messages: list[dict], 
        tools: Optional[list[dict]] = None,
        system_prompt: Optional[str] = None
    ) -> dict:
        """Non-streaming chat completion"""
        pass

class OpenAIProvider(LLMProvider):
    """OpenAI/GPT implementation"""
    def __init__(self, model: str = "gpt-4o", api_key: str = None):
        self.model = model
        self.client = AsyncOpenAI(api_key=api_key)
    
    async def chat_stream(self, messages, tools=None, system_prompt=None):
        # Stream tokens directly to WebSocket
        response = await self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            tools=tools,
            stream=True
        )
        async for chunk in response:
            yield chunk

class AnthropicProvider(LLMProvider):
    """Anthropic/Claude implementation"""
    # Similar implementation

class GeminiProvider(LLMProvider):
    """Google Gemini implementation"""
    # Similar implementation with google-generativeai SDK

class LocalProvider(LLMProvider):
    """Local model (Ollama, llama.cpp) implementation"""
    # Similar implementation

# Factory function
def get_llm_provider(provider: str = "openai") -> LLMProvider:
    providers = {
        "openai": OpenAIProvider,
        "anthropic": AnthropicProvider,
        "gemini": GeminiProvider,
        "local": LocalProvider,
    }
    return providers[provider]()
```

### Configuration

```bash
# .env
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o
OPENAI_API_KEY=sk-...

# Or for Anthropic
# LLM_PROVIDER=anthropic
# LLM_MODEL=claude-3-opus
# ANTHROPIC_API_KEY=sk-ant-...

# Or for Google Gemini
# LLM_PROVIDER=gemini
# LLM_MODEL=gemini-1.5-pro
# GEMINI_API_KEY=your-gemini-api-key
```

---

## Tool System

### Tool Registry

The backend maintains a registry of available tools that can be called by the LLM:

```python
class ToolRegistry:
    def __init__(self, n8n_webhook_url: str):
        self.n8n_url = n8n_webhook_url
        self.tools: dict[str, Callable] = {}
        self._register_builtin_tools()
        self._register_n8n_tools()
    
    def _register_builtin_tools(self):
        """Register Python-native tools"""
        self.tools["calculator"] = self._calculator
        self.tools["get_current_time"] = self._get_current_time
        self.tools["search_memory"] = self._search_memory
        self.tools["store_memory"] = self._store_memory
    
    def _register_n8n_tools(self):
        """Register tools that call n8n workflows"""
        n8n_tools = [
            ("system_status", "Get system CPU, RAM, disk, network info"),
            ("docker_control", "Manage Docker containers"),
            ("service_control", "Manage systemd services"),
            ("jellyfin_api", "Interact with Jellyfin media server"),
            ("ssh_command", "Execute SSH commands with sudo"),
            ("gemini_cli", "Execute Gemini CLI queries"),
            ("n8n_workflow", "Manage n8n workflows"),
        ]
        for tool_name, description in n8n_tools:
            self.tools[tool_name] = self._make_n8n_tool(tool_name)
    
    def _make_n8n_tool(self, tool_name: str):
        """Create a callable that invokes n8n tool executor"""
        async def call_n8n(params: dict) -> dict:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    self.n8n_url,
                    json={"tool": tool_name, "params": params},
                    timeout=120.0
                )
                return response.json()
        return call_n8n
    
    def get_tool_schemas(self) -> list[dict]:
        """Return OpenAI-compatible tool definitions"""
        return [
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
            # ... more tool schemas
        ]
```

### Tool Categories

| Category | Location | Tools |
|----------|----------|-------|
| **Built-in (Python)** | Backend | Calculator, Memory Search, Memory Store, Time |
| **Infrastructure (n8n)** | n8n Tool Executor | System Status, Docker, Services, Jellyfin, SSH |
| **AI (n8n)** | n8n Tool Executor | Gemini CLI |
| **Workflow (n8n)** | n8n Tool Executor | N8N Manager suite |

---

## n8n Tool Executor Workflow

### Single Entry Point

Instead of multiple entry points, create one "Tool Executor" workflow that routes to sub-workflows:

```
Webhook: POST /webhook/tool-executor
  ↓
Input: { "tool": "docker_control", "params": { "action": "ps" } }
  ↓
Switch Node (route by tool name)
  ├── system_status → Machine Manager - System Status
  ├── docker_control → Machine Manager - Docker Control
  ├── service_control → Machine Manager - Service Control
  ├── jellyfin_api → Machine Manager - Jellyfin API
  ├── ssh_command → sudo ssh commands
  ├── gemini_cli → gemini cli trigger
  └── n8n_workflow → N8N Manager suite
  ↓
Return: { "status": "success", "result": {...} }
```

### What Stays in n8n

| Workflow | Reason | Status |
|----------|--------|--------|
| Tool Executor | Single entry point for all tools | **NEW - To Create** |
| Machine Manager - System Status | SSH execution | Keep |
| Machine Manager - Docker Control | SSH execution | Keep |
| Machine Manager - Service Control | SSH execution | Keep |
| Machine Manager - Jellyfin API | HTTP to Jellyfin | Keep |
| gemini cli trigger | SSH execution | Keep |
| sudo ssh commands | SSH execution | Keep |
| N8N Manager suite | n8n API calls | Keep |
| Health Monitor | Scheduled task with Telegram | Keep |
| download video | Form trigger + file ops | Keep |
| Upload File | Form trigger + SFTP | Keep |

### What Moves to Backend

| Component | New Location |
|-----------|--------------|
| LLM orchestration | FastAPI backend |
| System prompt (Jarvis personality) | Backend config |
| Session/conversation memory | Backend (PostgreSQL) |
| Tool calling logic | Backend (LLM function calling) |
| Streaming responses | Backend (WebSocket) |

### What Gets Deprecated

| Workflow | Reason |
|----------|--------|
| Jarvis AI Agent Orchestrator | Replaced by backend LLM orchestrator |
| AI Long Term Memory Agent | Memory now handled by backend |
| Memory governance | Can move to backend or stay in n8n |
| Memory deduplication | Can move to backend or stay in n8n |
| Add Memory | Can move to backend or stay in n8n |
| Machine Manager Agent | No longer needed - backend calls tools directly |

---

## Database Schema

### Existing Tables

```sql
-- Already exists in 'memory' database
long_term_memory:
  - id (UUID, PRIMARY KEY)
  - text (TEXT) -- Note: n8n pgvector uses 'text' not 'content'
  - metadata (JSONB)
  - embedding (vector(1536))
  - hash (TEXT, generated)
  - created_at (TIMESTAMPTZ)
```

### New Tables (in 'jarvis' database)

```sql
sessions:
  - session_id (UUID, PRIMARY KEY)
  - user_id (TEXT, optional for future multi-user)
  - created_at (TIMESTAMPTZ)
  - last_activity (TIMESTAMPTZ)
  - metadata (JSONB)

messages:
  - id (SERIAL, PRIMARY KEY)
  - session_id (UUID, FK → sessions)
  - role (TEXT: 'user' | 'assistant' | 'tool')
  - content (TEXT)
  - tool_calls (JSONB, optional)
  - tool_call_id (TEXT, optional)
  - timestamp (TIMESTAMPTZ)
  - metadata (JSONB)

CREATE INDEX idx_messages_session_id ON messages(session_id);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
CREATE INDEX idx_sessions_last_activity ON sessions(last_activity);
```

---

## Session Management

### Flow

```
1. Page Load:
   - Check localStorage for sessionId
   - If exists: Connect WebSocket, request history from backend
   - If not: Generate UUID, store in localStorage, connect WebSocket

2. Send Message:
   - Send via WebSocket: { "type": "message", "content": "..." }
   - Backend stores message, calls LLM, streams response

3. Receive Streaming Response:
   - Backend streams tokens via WebSocket
   - Frontend displays in real-time
   - On complete, backend stores full response

4. Tool Execution:
   - LLM requests tool call
   - Backend executes tool (built-in or n8n)
   - Result fed back to LLM
   - Continue streaming response
```

---

## System Prompt

The Jarvis personality and capabilities are defined in the backend:

```python
JARVIS_SYSTEM_PROMPT = """
You are JARVIS, a British AI assistant. You address the user as "Sir" and maintain a dry, courteous, slightly cheeky tone. You use British English spelling and phrasing.

## Response Style
- Begin acknowledgements with phrases like "At once, Sir" or "Certainly, Sir"
- Be concise and lean in your responses
- Use markdown formatting when appropriate

## Available Tools
You have access to the following tools:

### Infrastructure Tools (via n8n)
- system_status: Get CPU, memory, disk, network information
- docker_control: Manage Docker containers (ps, start, stop, restart, logs)
- service_control: Manage systemd services (status, start, stop, restart)
- jellyfin_api: Interact with Jellyfin media server
- ssh_command: Execute arbitrary SSH commands with sudo

### Utility Tools
- calculator: Perform mathematical calculations
- get_current_time: Get current date and time
- gemini_cli: Query Google's Gemini AI

### Memory Tools
- search_memory: Search long-term memory for relevant information
- store_memory: Store important facts to long-term memory

### Workflow Tools
- n8n_workflow: Manage n8n workflows (list, create, update, delete, activate, execute)

## Location & Context
- Default timezone: Asia/Jerusalem
- Location: Jerusalem, Israel
"""
```

---

## Configuration

### Environment Variables

```bash
# Backend Server
HOST=0.0.0.0
PORT=20005
CORS_ORIGINS=*

# Database
DATABASE_URL=postgresql+asyncpg://n8n:n8npass@192.168.1.100:20004/jarvis
MEMORY_DATABASE_URL=postgresql+asyncpg://n8n:n8npass@192.168.1.100:20004/memory

# LLM Provider
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o
OPENAI_API_KEY=sk-...

# n8n Tool Executor
N8N_TOOL_EXECUTOR_URL=http://192.168.1.100:20002/webhook/tool-executor
N8N_TIMEOUT_SECONDS=120

# Session
SESSION_TTL_DAYS=30
```

---

## File Structure

```
jarvis-ui/
├── backend/
│   ├── main.py                 # FastAPI app entry point
│   ├── config.py               # Configuration settings
│   ├── database/
│   │   └── db.py               # Database connection
│   ├── models/
│   │   ├── session.py          # Session model
│   │   └── message.py          # Message model
│   ├── routers/
│   │   ├── api.py              # REST API endpoints
│   │   └── websocket.py        # WebSocket handler with streaming
│   ├── services/
│   │   ├── llm_provider.py     # LLM abstraction layer (NEW)
│   │   ├── tool_registry.py    # Tool definitions and execution (NEW)
│   │   ├── orchestrator.py     # AI orchestration logic (NEW)
│   │   ├── memory_service.py   # Memory search/store (NEW)
│   │   ├── n8n_client.py       # n8n tool executor client
│   │   └── session_manager.py  # Session management
│   ├── prompts/
│   │   └── jarvis.py           # System prompt (NEW)
│   ├── alembic/                # Database migrations
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Chat.jsx
│   │   │   ├── MessageList.jsx
│   │   │   └── MessageInput.jsx
│   │   ├── services/
│   │   │   └── websocket.js    # WebSocket with streaming support
│   │   └── utils/
│   │       └── session.js
│   └── package.json
├── n8n/
│   ├── workflows/
│   │   ├── Tool Executor.json  # NEW - Single entry point
│   │   ├── Machine Manager - *.json
│   │   ├── N8N Manager - *.json
│   │   └── ... other tools
│   └── docs/
│       └── workflows-summary.md
├── scripts/
├── README.md
└── STRATEGY.md                 # This file
```

---

## Implementation Phases

### Phase 1: Backend LLM Integration (Current)
1. [ ] Add LLM provider abstraction layer
2. [ ] Implement tool registry with schemas
3. [ ] Create AI orchestrator service
4. [ ] Update WebSocket handler for streaming
5. [ ] Port Jarvis system prompt to backend

### Phase 2: n8n Tool Executor
1. [ ] Create Tool Executor workflow in n8n
2. [ ] Test all tool routes
3. [ ] Update n8n client in backend
4. [ ] Deprecate old orchestrator workflow

### Phase 3: Memory Integration
1. [ ] Implement memory search in backend (PGVector)
2. [ ] Implement memory store with governance
3. [ ] Decide: keep memory workflows in n8n or move to backend

### Phase 4: Polish & Testing
1. [ ] End-to-end streaming tests
2. [ ] Tool execution tests
3. [ ] Performance benchmarking
4. [ ] Error handling improvements

### Phase 5: Future Features
- Speech-to-text input
- Text-to-speech output
- Image upload/display
- Android app (React Native)

---

## Migration Path

### Parallel Operation
During migration, both systems can run in parallel:
1. Backend can fall back to n8n orchestrator if needed
2. Gradually move tool calls to new system
3. Test streaming with real users
4. Deprecate n8n orchestrator once stable

### Rollback Plan
If issues arise:
1. Set `LLM_PROVIDER=n8n` in config
2. Backend falls back to calling n8n orchestrator
3. No data loss (same database)

---

## Security Considerations

### Current (MVP)
- Input validation on all endpoints
- SQL injection prevention (SQLAlchemy ORM)
- CORS configuration
- API keys via environment variables
- Rate limiting on WebSocket connections

### Future Enhancements
- User authentication
- API key authentication for tool execution
- Audit logging
- HTTPS/TLS
- Session encryption

---

## Appendix: Architecture Comparison

### Previous Architecture (n8n-hosted LLM)

```
Frontend → Backend → n8n Webhook → n8n AI Agent → LLM API
                                        ↓
                                  Sub-agent workflows
                                        ↓
                                  Tool execution
```

**Problems:**
- Streaming broken (webhook doesn't preserve streaming)
- High latency (multiple hops)
- Complex debugging
- Duplicated session management

### New Architecture (Backend-hosted LLM)

```
Frontend → Backend → LLM API (streaming)
              ↓
        Tool Registry
              ↓
        n8n Tool Executor (only when needed)
```

**Benefits:**
- Native streaming via WebSocket
- Low latency (direct LLM calls)
- Simple debugging (Python logs)
- Single source of truth for sessions
- Easy model swapping

---

## Port Mapping

| Port  | Service          | Description                |
|-------|------------------|---------------------------|
| 20000 | SSH              | Remote access              |
| 20001 | Jellyfin         | Media server               |
| 20002 | n8n              | Automation platform        |
| 20004 | PostgreSQL       | Database (pgvector)        |
| 20005 | Jarvis Backend   | FastAPI backend            |
| 20006 | Jarvis Frontend  | React frontend             |
