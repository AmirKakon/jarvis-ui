# Jarvis UI

A modern web interface for Jarvis AI Assistant running in n8n.

![Jarvis UI](https://via.placeholder.com/800x400?text=Jarvis+UI+Screenshot)

## Features

- 🚀 **Real-time Chat** - WebSocket-based communication for instant responses
- 💾 **Session Persistence** - Chat history saved across page reloads
- 🎨 **Modern UI** - Beautiful dark theme with smooth animations
- 🔌 **n8n Integration** - Seamlessly connects to your n8n Jarvis workflow
- 📱 **Responsive Design** - Works on desktop and mobile devices
- 🔧 **Easy Setup** - PowerShell scripts for quick installation

## Architecture

```
┌─────────────────┐
│  React Frontend │ (Port 3000 dev / served by backend in prod)
└────────┬────────┘
         │ WebSocket + REST API
┌────────▼────────┐
│  FastAPI Backend│ (Port 20003)
│  - WebSocket    │
│  - Sessions     │
│  - Messages     │
└────────┬────────┘
         │ HTTP POST (Webhook)
┌────────▼────────┐     ┌─────────────┐
│  n8n Workflow   │     │ PostgreSQL  │
│  (Jarvis)       │     │ (Messages)  │
└─────────────────┘     └─────────────┘
```

## Prerequisites

- **Python 3.10+** - [Download](https://python.org)
- **Node.js 18+** - [Download](https://nodejs.org)
- **PostgreSQL** - Running on your target machine
- **n8n** - With Jarvis workflow configured

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
# PostgreSQL connection (on your target machine)
DATABASE_URL=postgresql+asyncpg://username:password@192.168.1.100:5432/jarvis

# n8n webhook URL
N8N_WEBHOOK_URL=http://192.168.1.100:5678/webhook/jarvis
```

### 3. Run Database Migrations

```powershell
.\scripts\migrate.ps1
```

This creates the `sessions` and `messages` tables in your PostgreSQL database.

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
│   │   └── websocket.py     # WebSocket handler
│   ├── services/
│   │   ├── n8n_client.py    # n8n webhook client
│   │   ├── session_manager.py
│   │   └── llm_provider.py  # LLM abstraction layer
│   ├── alembic/             # Database migrations
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Chat.jsx     # Main chat component
│   │   │   ├── MessageList.jsx
│   │   │   └── MessageInput.jsx
│   │   ├── services/
│   │   │   └── websocket.js # WebSocket client
│   │   └── utils/
│   │       └── session.js   # Session management
│   └── package.json
├── scripts/
│   ├── setup.ps1            # Initial setup
│   ├── migrate.ps1          # Database migrations
│   ├── start.ps1            # Start all services
│   ├── start-backend.ps1    # Start backend only
│   ├── start-frontend.ps1   # Start frontend only
│   └── build.ps1            # Production build
└── README.md
```

## Configuration Options

### Backend Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `N8N_WEBHOOK_URL` | n8n Jarvis webhook URL | Required |
| `N8N_TIMEOUT_SECONDS` | Timeout for n8n requests | `120` |
| `HOST` | Server bind address | `0.0.0.0` |
| `PORT` | Server port | `20003` |
| `CORS_ORIGINS` | Allowed CORS origins | `*` |
| `SESSION_TTL_DAYS` | Session expiration days | `30` |

## n8n Webhook Setup

Your n8n Jarvis workflow should have a webhook node configured to:

1. **Receive**: POST requests with JSON body:
   ```json
   {
     "message": "User message text",
     "sessionId": "uuid-session-id"
   }
   ```

2. **Return**: JSON response:
   ```json
   {
     "response": "AI response text"
   }
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

# The backend will serve the built frontend from /
.\scripts\start-backend.ps1
```

### Database Migrations

```powershell
# Apply all migrations
.\scripts\migrate.ps1

# Apply specific revision
.\scripts\migrate.ps1 -Revision "001"

# Rollback
.\scripts\migrate.ps1 -Downgrade -Revision "-1"
```

## API Endpoints

### REST API

- `GET /api/health` - Health check
- `GET /api/history/{session_id}` - Get chat history
- `GET /api/session/{session_id}` - Check if session exists

### WebSocket

Connect to: `ws://localhost:20003/ws/{session_id}`

**Client → Server Messages:**
```json
{"type": "message", "content": "Hello!"}
{"type": "get_history"}
```

**Server → Client Messages:**
```json
{"type": "message", "role": "assistant", "content": "...", "timestamp": "..."}
{"type": "history", "messages": [...]}
{"type": "typing", "status": true}
{"type": "error", "content": "..."}
```

## Deploying to Target Machine

Since PostgreSQL and n8n are on a different machine:

1. Copy the entire `jarvis-ui` folder to the target machine
2. Run `.\scripts\setup.ps1` to install dependencies
3. Configure `backend/.env` with correct IP addresses
4. Run `.\scripts\migrate.ps1` to create database tables
5. Build for production: `.\scripts\build.ps1`
6. Start the server: `.\scripts\start-backend.ps1`

### Running as a Service

For production, consider running the backend as a Windows service using:
- [NSSM](https://nssm.cc/) - Non-Sucking Service Manager
- [PM2](https://pm2.keymetrics.io/) - Process manager for Node.js (works with Python too)

## Troubleshooting

### Connection Issues

1. **Cannot connect to PostgreSQL**
   - Verify the database server is running
   - Check firewall allows connections on port 5432
   - Verify credentials in `DATABASE_URL`

2. **Cannot connect to n8n**
   - Verify n8n is running
   - Check the webhook URL is correct
   - Ensure n8n webhook is enabled

3. **WebSocket connection fails**
   - Check if backend is running on port 20003
   - Verify no firewall blocking WebSocket connections

### Common Errors

- **"Virtual environment not found"**: Run `.\scripts\setup.ps1` first
- **"Migration failed"**: Check `DATABASE_URL` and network connectivity
- **"Connection refused"**: Ensure backend/n8n/PostgreSQL are running

## Future Roadmap

- [ ] Speech-to-text input
- [ ] Text-to-speech output
- [ ] Image upload/display
- [ ] File sharing
- [ ] Android app (React Native)
- [ ] User authentication

## License

MIT License

