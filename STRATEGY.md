# Jarvis UI - Strategy & Implementation Plan

## Executive Summary

This document outlines the strategy and architecture for building a web-based UI for Jarvis, an AI assistant running in n8n. The solution is designed to be extensible, supporting future features like speech I/O, file sharing, camera/screen sharing, and multi-device access (web + Android app).

## Architecture Overview

### High-Level Architecture

```
┌─────────────────┐
│  Web Frontend   │ (React/Vanilla JS)
│  Port: 20003    │
└────────┬────────┘
         │ WebSocket
         │ HTTP REST API
┌────────▼─────────────────────────┐
│  Python FastAPI Backend          │
│  - WebSocket Server               │
│  - Session Management             │
│  - Message History                │
│  - n8n Communication Layer        │
│  - MCP Abstraction Layer          │
└────────┬──────────────────────────┘
         │ HTTP POST (Webhook)
┌────────▼────────┐
│   n8n Workflow  │
│   (Jarvis)      │
└─────────────────┘
```

### Technology Stack

**Backend:**
- **Python FastAPI**: Modern, async, excellent WebSocket support, easy to extend
- **PostgreSQL**: Production-ready database for sessions and chat history (already running locally)
- **WebSocket**: Real-time bidirectional communication for best UX
- **HTTP Client**: `httpx` or `requests` for n8n webhook communication
- **Database ORM**: SQLAlchemy with asyncpg for async PostgreSQL operations

**Frontend:**
- **React** (recommended) or **Vanilla JS**: React preferred for future React Native Android app
- **WebSocket Client**: Real-time message updates
- **LocalStorage**: Persist sessionId across page reloads

**Database Schema:**

**Existing Table (already in database):**
- `long_term_memory`: Used by Jarvis for storing important notes and long-term memory

**New Tables (to be created):**
```sql
sessions:
  - session_id (UUID, PRIMARY KEY)
  - user_id (TEXT, optional for future multi-user)
  - created_at (TIMESTAMP WITH TIME ZONE)
  - last_activity (TIMESTAMP WITH TIME ZONE)
  - metadata (JSONB, for future features)

messages:
  - id (SERIAL, PRIMARY KEY)
  - session_id (UUID, FOREIGN KEY REFERENCES sessions(session_id))
  - role (TEXT: 'user' | 'assistant')
  - content (TEXT)
  - timestamp (TIMESTAMP WITH TIME ZONE)
  - metadata (JSONB, for images/files in future)
  
CREATE INDEX idx_messages_session_id ON messages(session_id);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
CREATE INDEX idx_sessions_last_activity ON sessions(last_activity);
```

**Note:** The existing `long_term_memory` table will remain separate and continue to be used by the n8n workflow. The new `sessions` and `messages` tables are specifically for UI chat history and session management.

**Database Initialization:**
- Use Alembic for database migrations (standard with SQLAlchemy)
- Initial migration will create `sessions` and `messages` tables
- Existing `long_term_memory` table will not be modified
- Safe to run migrations multiple times (idempotent)

## Session Management Strategy

### Current State
- No sessionId implementation in n8n
- Each page load creates a new session

### Recommended Approach

**1. Client-Side Session Persistence**
- Generate UUID sessionId on first visit
- Store in browser `localStorage` (persists across reloads)
- Send sessionId with every message to backend

**2. Backend Session Storage**
- Backend maintains session database
- On first message with new sessionId: create session record
- Store all messages linked to sessionId
- Load chat history when sessionId is recognized

**3. Session Lifecycle**
- **Creation**: First message from client generates new sessionId (if not in localStorage)
- **Persistence**: SessionId stored in localStorage + database
- **Retrieval**: On page load, check localStorage → load history from backend
- **Expiration**: Optional TTL (e.g., 30 days of inactivity) - future enhancement

**4. Future Multi-Device Support**
- Same sessionId can be used across devices
- Backend syncs messages by sessionId
- User can "continue conversation" by entering sessionId or via account linking

### Implementation Details

**Frontend Flow:**
```
1. Page Load:
   - Check localStorage for sessionId
   - If exists: Connect WebSocket with sessionId, load history
   - If not: Generate new UUID, store in localStorage

2. Send Message:
   - Include sessionId in WebSocket message
   - Backend handles session creation/retrieval

3. Receive Message:
   - Display in chat UI
   - History automatically synced from backend
```

**Backend Flow:**
```
1. Receive Message:
   - Extract sessionId from request
   - If session doesn't exist: create new session
   - Store user message in database
   - Forward to n8n webhook

2. Receive Response from n8n:
   - Store assistant message in database
   - Push to client via WebSocket

3. Client Requests History:
   - Query messages by sessionId
   - Return chronological list
```

## n8n Integration Strategy

### Connection Method: Webhook + Backend Bridge

**Why not direct WebSocket to n8n?**
- n8n's native WebSocket support is limited
- Webhook is standard, reliable, and well-supported
- Backend bridge provides better control and session management

**Implementation:**
1. **n8n Webhook Node**: Configure to accept POST requests
   - Endpoint: `/webhook/jarvis` (or custom)
   - Method: POST
   - Expected payload: `{ "message": "...", "sessionId": "..." }`

2. **Backend Bridge**:
   - FastAPI receives WebSocket message from frontend
   - Converts to HTTP POST to n8n webhook
   - Waits for response (sync)
   - Converts response back to WebSocket message
   - Stores in database

3. **Error Handling**:
   - Timeout handling (n8n might be slow)
   - Retry logic for failed requests
   - User-friendly error messages

### n8n Workflow Modifications

**Current:** Request → Response (sync)

**Recommended Enhancement:**
- Add sessionId handling in n8n workflow
- Store sessionId in workflow context (optional, backend handles primary storage)
- Return sessionId in response for verification

**n8n Workflow Structure:**
```
Webhook Trigger
  ↓
Extract: message, sessionId
  ↓
[Your existing Jarvis logic]
  ↓
Return: { "response": "...", "sessionId": "..." }
```

## MCP (Model Context Protocol) Abstraction

### Purpose
Decouple LLM provider logic from n8n workflow, enabling easy switching between providers (OpenAI, Anthropic, etc.)

### Implementation

**Backend Abstraction Layer:**
```python
class LLMProvider:
    """Abstract base for LLM providers"""
    def send_message(self, message: str, session_id: str, context: dict) -> str:
        raise NotImplementedError

class OpenAIProvider(LLMProvider):
    """OpenAI implementation"""
    # Handles OpenAI-specific logic

class N8NProvider(LLMProvider):
    """n8n webhook implementation (current)"""
    # Handles n8n communication
    # Can be replaced with direct API calls later
```

**Benefits:**
- Easy to switch providers without changing frontend
- Can add multiple providers (fallback, A/B testing)
- Future: Direct API calls bypassing n8n if needed

## Future Features Roadmap

### Phase 1: Text Chat (Current Focus)
- ✅ WebSocket-based text chat
- ✅ Session management
- ✅ Chat history
- ✅ Basic UI

### Phase 2: Enhanced Chat
- Speech-to-text input
- Text-to-speech output
- Voice activity detection

### Phase 3: Media Support
- Image upload/display
- File sharing
- Image generation display

### Phase 4: Real-time Media
- Live camera feed
- Screen sharing
- Video chat

### Phase 5: Multi-Device
- Android app (React Native)
- Cross-device session sync
- Push notifications
- User authentication (optional)

## File Structure

```
jarvis-ui/
├── backend/
│   ├── main.py                 # FastAPI app entry point
│   ├── models/
│   │   ├── session.py          # Session database model
│   │   └── message.py          # Message database model
│   ├── routers/
│   │   ├── websocket.py        # WebSocket endpoints
│   │   └── api.py              # REST API endpoints
│   ├── services/
│   │   ├── n8n_client.py      # n8n webhook communication
│   │   ├── session_manager.py # Session management logic
│   │   └── llm_provider.py    # MCP abstraction layer
│   ├── database/
│   │   ├── db.py              # Database setup and connection (PostgreSQL)
│   │   └── migrations/        # Alembic migrations for schema
│   └── config.py              # Configuration (n8n URL, port, etc.)
├── frontend/
│   ├── public/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Chat.jsx       # Main chat component
│   │   │   ├── MessageList.jsx
│   │   │   └── MessageInput.jsx
│   │   ├── services/
│   │   │   └── websocket.js   # WebSocket client
│   │   ├── utils/
│   │   │   └── session.js     # SessionId management
│   │   └── App.jsx
│   └── package.json
├── requirements.txt           # Python dependencies
├── alembic.ini                # Alembic configuration for migrations
├── alembic/                   # Migration scripts
│   └── versions/
├── README.md
└── STRATEGY.md               # This file
```

**Key Python Dependencies:**
- `fastapi` - Web framework
- `uvicorn` - ASGI server
- `websockets` - WebSocket support
- `sqlalchemy` - ORM
- `asyncpg` - Async PostgreSQL driver
- `alembic` - Database migrations
- `httpx` - Async HTTP client for n8n
- `python-dotenv` - Environment variable management

## Configuration

### Environment Variables
```bash
# Backend
N8N_WEBHOOK_URL=http://localhost:5678/webhook/jarvis
PORT=20003
DATABASE_URL=postgresql://user:password@localhost:5432/dbname
# Or if using connection pooling:
# DATABASE_URL=postgresql+asyncpg://user:password@localhost:5432/dbname

# Optional
SESSION_TTL_DAYS=30
N8N_TIMEOUT_SECONDS=60
```

**Note:** Update `DATABASE_URL` with your actual PostgreSQL connection details. The database should already contain the `long_term_memory` table used by Jarvis.

## Deployment Strategy

### Local Development
- Run FastAPI with `uvicorn` (auto-reload)
- Run frontend dev server (Vite/Webpack)
- Connect to existing PostgreSQL database (local or Docker)
- Database migrations will create `sessions` and `messages` tables if they don't exist

### Production (Local Machine)
- Run FastAPI with `gunicorn` + `uvicorn` workers
- Serve frontend as static files from FastAPI
- Connect to existing PostgreSQL database
- Process manager: `systemd` or `supervisord`
- Ensure PostgreSQL is accessible (check if running directly or via Docker)

### Future: Docker Deployment
- Multi-stage Dockerfile
- Docker Compose for n8n + UI + database
- Volume mounts for persistence

## Security Considerations

### Current (MVP)
- Basic input validation
- SQL injection prevention (ORM/SQLAlchemy with parameterized queries)
- CORS configuration
- PostgreSQL connection security (credentials via environment variables)

### Future Enhancements
- Rate limiting
- Authentication/authorization
- HTTPS/TLS
- Input sanitization
- Session encryption

## Testing Strategy

### Phase 1 (MVP)
- Manual testing of chat flow
- Session persistence testing
- n8n integration testing

### Future
- Unit tests for backend services
- Integration tests for WebSocket
- E2E tests for chat flow
- Load testing for concurrent sessions

## Implementation Phases

### Phase 1: MVP (Current Focus)
1. ✅ Set up FastAPI backend with WebSocket
2. ✅ Create basic React frontend
3. ✅ Implement session management (localStorage + database)
4. ✅ Connect to n8n webhook
5. ✅ Display chat history
6. ✅ Basic error handling

### Phase 2: Polish
1. Improve UI/UX
2. Add loading states
3. Better error messages
4. Message timestamps
5. Auto-scroll to latest message

### Phase 3: Future Features
- Speech I/O
- Media support
- Multi-device sync
- Android app

## Questions & Decisions

### Open Questions
1. **n8n Webhook URL**: What is your current n8n webhook URL? (Will be configurable)
2. **UI Style**: Any design preferences? (Material-UI, Tailwind, custom?)
3. **Message Format**: Does n8n return plain text or JSON? (Will handle both)
4. **PostgreSQL Connection**: What are your PostgreSQL connection details? (host, port, database name, user, password - can be provided via environment variable)
5. **Database Access**: Is PostgreSQL running directly on the host or in Docker? (affects connection string format)

### Decisions Made
- ✅ WebSocket for real-time UX
- ✅ FastAPI backend (async, WebSocket support)
- ✅ PostgreSQL database (already running locally, production-ready)
- ✅ React frontend (future Android app compatibility)
- ✅ MCP abstraction for LLM flexibility
- ✅ SessionId in localStorage + database
- ✅ Backend bridge to n8n webhook
- ✅ Use existing PostgreSQL instance with `long_term_memory` table

## Next Steps

1. **Review this strategy** - Confirm approach and answer open questions
2. **Set up project structure** - Create directories and base files
3. **Implement backend** - FastAPI, WebSocket, database, n8n client
4. **Implement frontend** - React app with WebSocket client
5. **Integration testing** - Connect to n8n and test full flow
6. **Deploy** - Run on port 20003

---

## Appendix: Alternative Approaches Considered

### Direct HTTP Polling
- ❌ Poor UX, inefficient
- ✅ Simple implementation

### Server-Sent Events (SSE)
- ✅ Simpler than WebSocket
- ❌ One-way only (would need HTTP for requests)

### WebSocket Direct to n8n
- ❌ n8n WebSocket support limited
- ❌ Less control over session management

### Streamlit/Gradio
- ✅ Very fast to build
- ❌ Less flexible for future features
- ❌ Harder to extend to Android app

**Decision: FastAPI + React + WebSocket** - Best balance of UX, flexibility, and future extensibility.

