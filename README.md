# Jarvis UI

A modern web interface for Jarvis AI Assistant with native streaming support and easy model swapping.

![Jarvis UI](https://via.placeholder.com/800x400?text=Jarvis+UI+Screenshot)

## Features

- 🚀 **Real-time Streaming** - Native WebSocket streaming for instant token-by-token responses
- 🔄 **Easy Model Swapping** - Switch between OpenAI, Anthropic, or local models via config
- 💾 **Session Persistence** - Chat history saved across page reloads
- 🛠️ **Tool Execution** - AI can control your infrastructure via n8n tools
- 🎨 **Modern UI** - Beautiful dark theme with smooth animations
- 📱 **Responsive Design** - Works on desktop and mobile devices

## Architecture

The system uses a **backend-hosted LLM architecture** where the FastAPI backend directly communicates with LLM providers, with n8n serving as a tool executor:

```
┌─────────────────┐
│  React Frontend │ (Port 20006)
└────────┬────────┘
         │ WebSocket (streaming)
┌────────▼──────────────────────────────────────────┐
│  FastAPI Backend (Port 20005)                     │
│  ┌──────────────────────────────────────────────┐ │
│  │  LLM Orchestrator                            │ │
│  │  - Direct LLM API calls (streaming)          │ │
│  │  - Tool/function calling                     │ │
│  │  - Session & memory management               │ │
│  └──────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────┐ │
│  │  Tool Registry                               │ │
│  │  - Built-in: calculator, memory, time        │ │
│  │  - n8n: system, docker, services, jellyfin   │ │
│  └──────────────────────────────────────────────┘ │
└────────┬──────────────────────────────────────────┘
         │ HTTP (only for tool execution)
┌────────▼────────┐     ┌─────────────────────┐
│  n8n Tool       │     │  PostgreSQL+PGVector │
│  Executor       │     │  - sessions          │
│  (Port 20003)   │     │  - messages          │
└─────────────────┘     │  - long_term_memory  │
                        └─────────────────────┘
```

### Why This Architecture?

| Feature | Benefit |
|---------|---------|
| **Native Streaming** | Token-by-token responses via WebSocket |
| **Low Latency** | Direct LLM calls, no n8n overhead |
| **Model Flexibility** | Switch providers via environment variable |
| **Simple Debugging** | Python logging instead of n8n execution traces |

## Prerequisites

- **Python 3.10+** - [Download](https://python.org)
- **Node.js 18+** - [Download](https://nodejs.org)
- **PostgreSQL with PGVector** - Running on your target machine
- **n8n** - With tool workflows configured
- **OpenAI API Key** (or other LLM provider)

## Quick Start

### 1. Clone and Setup

```powershell
# Clone the repository
git clone <repository-url>
cd jarvis-ui

# Run the setup script
.\scripts\setup.ps1
```

### 2. Configure Environment

Edit `backend/.env` with your settings:

```env
# Server
HOST=0.0.0.0
PORT=20005

# PostgreSQL connection
DATABASE_URL=postgresql+asyncpg://n8n:n8npass@192.168.1.100:20004/jarvis
MEMORY_DATABASE_URL=postgresql+asyncpg://n8n:n8npass@192.168.1.100:20004/memory

# LLM Provider (openai, anthropic, or local)
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o
OPENAI_API_KEY=sk-your-key-here

# n8n Tool Executor webhook
N8N_TOOL_EXECUTOR_URL=http://192.168.1.100:20003/webhook/tool-executor
N8N_TIMEOUT_SECONDS=120
```

### 3. Run Database Migrations

```powershell
.\scripts\migrate.ps1
```

### 4. Start the Application

```powershell
# Start both frontend and backend
.\scripts\start.ps1

# Or start them separately:
.\scripts\start-backend.ps1  # In one terminal
.\scripts\start-frontend.ps1 # In another terminal
```

### 5. Access the UI

- **Development**: http://localhost:20006
- **Production**: http://localhost:20005
- **API Docs**: http://localhost:20005/docs

## Project Structure

```
jarvis-ui/
├── backend/
│   ├── main.py              # FastAPI entry point
│   ├── config.py            # Configuration settings
│   ├── database/
│   │   └── db.py            # Database connection
│   ├── models/
│   │   ├── session.py       # Session model
│   │   └── message.py       # Message model
│   ├── routers/
│   │   ├── api.py           # REST API endpoints
│   │   └── websocket.py     # WebSocket handler (streaming)
│   ├── services/
│   │   ├── llm_provider.py  # LLM abstraction layer
│   │   ├── tool_registry.py # Tool definitions
│   │   ├── orchestrator.py  # AI orchestration
│   │   ├── n8n_client.py    # n8n tool executor client
│   │   └── session_manager.py
│   ├── prompts/
│   │   └── jarvis.py        # Jarvis system prompt
│   ├── alembic/             # Database migrations
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Chat.jsx
│   │   │   ├── MessageList.jsx
│   │   │   └── MessageInput.jsx
│   │   ├── services/
│   │   │   └── websocket.js # WebSocket with streaming
│   │   └── utils/
│   │       └── session.js
│   └── package.json
├── n8n/
│   ├── workflows/           # n8n tool workflows
│   └── docs/
│       └── workflows-summary.md
├── scripts/
│   ├── setup.ps1
│   ├── migrate.ps1
│   ├── start.ps1
│   └── ...
└── README.md
```

## Configuration Options

### Backend Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HOST` | Server bind address | `0.0.0.0` |
| `PORT` | Server port | `20005` |
| `DATABASE_URL` | PostgreSQL connection (jarvis db) | Required |
| `MEMORY_DATABASE_URL` | PostgreSQL connection (memory db) | Required |
| `LLM_PROVIDER` | LLM provider: openai, anthropic, gemini, local | `openai` |
| `LLM_MODEL` | Model name | `gpt-4o` |
| `OPENAI_API_KEY` | OpenAI API key | Required if using OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic API key | Required if using Anthropic |
| `GEMINI_API_KEY` | Google Gemini API key | Required if using Gemini |
| `N8N_TOOL_EXECUTOR_URL` | n8n tool executor webhook URL | Required |
| `N8N_TIMEOUT_SECONDS` | Timeout for n8n requests | `120` |
| `CORS_ORIGINS` | Allowed CORS origins | `*` |
| `SESSION_TTL_DAYS` | Session expiration days | `30` |

### Switching LLM Providers

```bash
# OpenAI (default)
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o
OPENAI_API_KEY=sk-...

# Anthropic Claude
LLM_PROVIDER=anthropic
LLM_MODEL=claude-3-opus-20240229
ANTHROPIC_API_KEY=sk-ant-...

# Google Gemini
LLM_PROVIDER=gemini
LLM_MODEL=gemini-1.5-pro
GEMINI_API_KEY=your-gemini-api-key

# Local (Ollama)
LLM_PROVIDER=local
LLM_MODEL=llama3
LOCAL_LLM_URL=http://localhost:11434
```

## n8n Tool Executor Setup

The backend calls n8n for infrastructure tools. Set up a single "Tool Executor" workflow:

### Tool Executor Webhook

Create a webhook workflow that routes to your existing tool workflows:

```
POST /webhook/tool-executor
Body: {
  "tool": "docker_control",
  "params": { "action": "ps" }
}

Response: {
  "status": "success",
  "result": { ... }
}
```

### Available Tools

| Tool | Description |
|------|-------------|
| `system_status` | CPU, memory, disk, network info |
| `docker_control` | Manage Docker containers |
| `service_control` | Manage systemd services |
| `jellyfin_api` | Jellyfin media server API |
| `ssh_command` | Execute SSH commands with sudo |
| `gemini_cli` | Query Gemini AI |
| `n8n_workflow` | Manage n8n workflows |

## API Endpoints

### REST API

- `GET /api/health` - Health check
- `GET /api/history/{session_id}` - Get chat history
- `GET /api/session/{session_id}` - Check if session exists

### WebSocket

Connect to: `ws://localhost:20005/ws/{session_id}`

**Client → Server Messages:**
```json
{"type": "message", "content": "Hello!"}
{"type": "get_history"}
{"type": "stop"}
```

**Server → Client Messages (Streaming):**
```json
{"type": "stream_start"}
{"type": "stream_token", "content": "Hello"}
{"type": "stream_token", "content": ", Sir"}
{"type": "stream_end", "full_content": "Hello, Sir!"}
{"type": "tool_call", "tool": "docker_control", "params": {...}}
{"type": "tool_result", "result": {...}}
{"type": "error", "content": "..."}
```

## Development

### Running in Development Mode

```powershell
# Terminal 1: Backend with hot reload
.\scripts\start-backend.ps1

# Terminal 2: Frontend with hot reload
.\scripts\start-frontend.ps1
```

### Building for Production

```powershell
# Build the frontend
.\scripts\build.ps1

# The backend will serve the built frontend
.\scripts\start-backend.ps1
```

## Troubleshooting

### Connection Issues

1. **Cannot connect to PostgreSQL**
   - Verify the database server is running
   - Check firewall allows connections on port 20004
   - Verify credentials in `DATABASE_URL`

2. **LLM API errors**
   - Verify your API key is correct
   - Check the model name is valid
   - Ensure you have API credits

3. **Tool execution fails**
   - Verify n8n is running on port 20003
   - Check the Tool Executor webhook is active
   - Check n8n execution logs

4. **Streaming not working**
   - Ensure WebSocket connection is established
   - Check browser console for errors
   - Verify no proxy is buffering responses

### Common Errors

- **"Virtual environment not found"**: Run `.\scripts\setup.ps1` first
- **"Migration failed"**: Check `DATABASE_URL` and network connectivity
- **"LLM provider not found"**: Check `LLM_PROVIDER` env var
- **"Tool execution timeout"**: Increase `N8N_TIMEOUT_SECONDS`

## Future Roadmap

- [ ] Speech-to-text input
- [ ] Text-to-speech output
- [ ] Image upload/display
- [ ] File sharing
- [ ] Android app (React Native)
- [ ] User authentication
- [ ] Multi-user support

## License

MIT License
