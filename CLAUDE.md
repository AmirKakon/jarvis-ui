# CLAUDE.md

## Project Overview

Jarvis UI is a web-based AI assistant with a React frontend and Python FastAPI backend. The backend communicates directly with LLM providers (OpenAI, Anthropic, Gemini) and uses n8n exclusively as a tool executor for infrastructure operations. Real-time streaming is handled via WebSocket.

## Architecture

```
React Frontend (port 20006) → WebSocket/REST → FastAPI Backend (port 20005) → LLM Providers
                                                        ↓ (tool calls only)
                                                   n8n (port 20003)
                                                        ↓
                                                PostgreSQL + PGVector (port 20004)
```

- **Backend-hosted LLM**: The backend calls LLM APIs directly, not through n8n
- **Tool execution**: n8n handles system status, Docker control, service management, Jellyfin API, SSH, Gemini CLI
- **Memory**: PostgreSQL stores sessions/messages; PGVector stores embeddings for semantic memory over chat summaries
- **Orchestrator loop**: User message → LLM → (optional tool call → execute → feed back) → stream final response

## Repository Structure

```
backend/           Python FastAPI backend
  main.py          Entry point (uvicorn)
  config.py        Pydantic settings from .env
  routers/         api.py (REST), websocket.py (streaming)
  services/        orchestrator.py, llm_provider.py, tool_registry.py, n8n_client.py,
                   session_manager.py, session_cleanup.py, embeddings.py, query_classifier.py
  models/          SQLAlchemy models (session, message, chat_summary)
  prompts/         jarvis.py (system prompt)
  alembic/         Database migrations
frontend/          React SPA
  src/components/  Chat.jsx, MessageList.jsx, MessageInput.jsx
  src/services/    websocket.js
  src/utils/       session.js
  vite.config.js   Dev server on 20006, proxies /api and /ws to backend
  nginx.conf       Production reverse proxy config
n8n/workflows/     JSON workflow definitions (20+)
scripts/           PowerShell (Windows) and bash (Linux) scripts for setup, build, deploy
docker-compose.yml Backend + frontend containers on bridge network
```

## Tech Stack

- **Frontend**: React 18, Vite 5, plain JSX (no TypeScript), CSS files per component
- **Backend**: Python 3.11, FastAPI 0.109, Uvicorn, async everywhere
- **Database**: PostgreSQL + asyncpg, SQLAlchemy 2.0, Alembic migrations, PGVector for embeddings
- **LLM SDKs**: openai, anthropic, google-generativeai
- **HTTP client**: httpx (async)
- **Config**: pydantic-settings, loaded from .env files
- **Production**: Docker Compose, nginx serves frontend, systemd for Linux deployment

## Development Commands

```bash
# Frontend
cd frontend && npm install
npm run dev                    # Vite dev server on port 20006

# Backend
cd backend && pip install -r requirements.txt
python main.py                 # Uvicorn with auto-reload on port 20005

# Database migrations
cd backend && alembic upgrade head

# Build frontend for production
cd frontend && npm run build

# Docker
docker compose up -d --build

# Linux deploy
./scripts/linux/deploy.sh
```

## Code Conventions

- **Backend**: snake_case for files, functions, variables. Async functions throughout. Pydantic for config/validation.
- **Frontend**: PascalCase for components (Chat.jsx), camelCase for utilities (session.js). Each component has a co-located CSS file.
- **No TypeScript** in the frontend — everything is JSX.
- **No linter/formatter** configured (no ESLint, Prettier, or ruff).
- Keep responses and code concise. Avoid unnecessary abstractions.

## Key Design Patterns

- `LLMProvider` is an abstract base class with concrete implementations for each provider (OpenAI, Anthropic, Gemini, Local, Mock). New providers should extend this base.
- `ToolRegistry` manages built-in tools + n8n tools. Built-in tools are registered as Python functions; n8n tools are fetched via HTTP and executed through n8n webhooks.
- `Orchestrator` runs the agentic loop: classify query → select tools → call LLM → execute tool calls → loop until done → stream to client.
- `QueryClassifier` categorizes queries to load only relevant tools, reducing time-to-first-token.
- Session memory uses PGVector for semantic search over past conversation summaries.

## Environment Variables

Required (set in `backend/.env`):
- `DATABASE_URL` — PostgreSQL connection string
- At least one LLM key: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`

Optional:
- `LLM_PROVIDER` (default: openai) — openai, anthropic, gemini, n8n, mock
- `LLM_MODEL` (default: gpt-4o)
- `N8N_TOOL_EXECUTOR_URL`, `N8N_API_URL`, `N8N_API_KEY` — for tool execution
- `SESSION_TTL_DAYS` (default: 30)
- `CORS_ORIGINS` (default: *)
- `VERIFY_SSL` (default: true)

## Ports

| Port  | Service              |
|-------|----------------------|
| 20005 | Backend (FastAPI)    |
| 20006 | Frontend (Vite/nginx)|
| 20003 | n8n                  |
| 20004 | PostgreSQL           |

## Testing

No test framework is currently configured. When adding tests:
- Backend: use pytest + pytest-asyncio + httpx for async FastAPI testing
- Frontend: use Vitest + React Testing Library
- `backend/services/llm_provider.py` has a `MockProvider` for testing without real API keys

## Deployment

- **Docker**: `docker compose up -d --build` — builds both services, frontend depends on backend health check
- **Linux native**: `scripts/linux/deploy.sh` sets up systemd services
- **Frontend production**: Multi-stage Docker build (Node build → nginx Alpine serve), base path `/jarvis/`
- **Backend production**: Python 3.11-slim, uvicorn on port 20005

## Important Notes

- The frontend uses base path `/jarvis/` in production but `/` in development
- nginx proxies `/jarvis/api/` and `/jarvis/ws/` to the backend
- The backend `.env` file contains secrets — never commit it
- n8n workflows are version-controlled as JSON in `n8n/workflows/`
- Alembic migrations use the same DATABASE_URL from pydantic settings
