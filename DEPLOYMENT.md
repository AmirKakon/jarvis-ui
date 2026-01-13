# Jarvis UI Deployment Guide

Deploy Jarvis UI to your Linux server with auto-start on boot.

## Quick Deploy to Linux

SSH into your Linux server and run:

```bash
# Clone the repository
git clone https://github.com/AmirKakon/jarvis-ui.git /opt/jarvis-ui
cd /opt/jarvis-ui

# Make scripts executable
chmod +x scripts/linux/*.sh

# Deploy with Docker (recommended)
sudo ./scripts/linux/deploy.sh --docker

# OR deploy natively (Python + Node.js)
sudo ./scripts/linux/deploy.sh --native
```

The script will:
1. ✅ Install dependencies (Docker or Python/Node.js)
2. ✅ Prompt you to configure the `.env` file
3. ✅ Build and start the application
4. ✅ Create systemd service for auto-start on boot

---

## Configuration

Edit `/opt/jarvis-ui/backend/.env`:

```bash
nano /opt/jarvis-ui/backend/.env
```

**Key settings for your Linux server (same machine as n8n/Jellyfin):**

```env
# Database - localhost since PostgreSQL is on the same machine
DATABASE_URL=postgresql+asyncpg://n8n:n8npass@localhost:20004/jarvis
MEMORY_DATABASE_URL=postgresql+asyncpg://n8n:n8npass@localhost:20004/memory

# LLM API Key
OPENAI_API_KEY=sk-your-key-here

# n8n - localhost since it's on the same machine
N8N_API_URL=http://localhost:5678/api/v1
N8N_API_KEY=your-n8n-api-key
N8N_TOOL_EXECUTOR_URL=http://localhost:5678/webhook/tool-executor

# Server
HOST=0.0.0.0
PORT=20005
```

After editing, restart the service:

```bash
systemctl restart jarvis-ui   # Docker
# or
systemctl restart jarvis-backend   # Native
```

---

## Management Commands

| Command | Description |
|---------|-------------|
| `systemctl start jarvis-ui` | Start the service |
| `systemctl stop jarvis-ui` | Stop the service |
| `systemctl status jarvis-ui` | Check status |
| `journalctl -u jarvis-ui -f` | View logs (systemd) |
| `docker compose logs -f` | View logs (Docker) |
| `./scripts/linux/status.sh` | Full status report |
| `./scripts/linux/update.sh` | Update to latest version |
| `./scripts/linux/uninstall.sh` | Uninstall completely |

---

## Access URLs

| Service | URL |
|---------|-----|
| **Jarvis UI** | `http://YOUR_SERVER_IP:20005` |
| **API Docs** | `http://YOUR_SERVER_IP:20005/docs` |
| **WebSocket** | `ws://YOUR_SERVER_IP:20005/ws/{session_id}` |

---

## Manual Deployment (Alternative)

If you prefer to run commands manually:

### Docker Method

```bash
# Clone
git clone https://github.com/AmirKakon/jarvis-ui.git /opt/jarvis-ui
cd /opt/jarvis-ui

# Configure
cp backend/env.example backend/.env
nano backend/.env

# Copy env for docker-compose
cp backend/.env .env

# Build and start
docker compose up -d --build

# Create systemd service for auto-start
cat > /etc/systemd/system/jarvis-ui.service << 'EOF'
[Unit]
Description=Jarvis UI (Docker)
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/jarvis-ui
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable jarvis-ui
```

### Native Method

```bash
# Install dependencies
apt update && apt install -y python3 python3-pip python3-venv nodejs npm

# Clone
git clone https://github.com/AmirKakon/jarvis-ui.git /opt/jarvis-ui
cd /opt/jarvis-ui

# Setup backend
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp env.example .env
nano .env
alembic upgrade head
deactivate

# Build frontend
cd ../frontend
npm ci
npm run build

# Create systemd service
cat > /etc/systemd/system/jarvis-backend.service << 'EOF'
[Unit]
Description=Jarvis UI Backend
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/jarvis-ui/backend
Environment="PATH=/opt/jarvis-ui/backend/venv/bin"
ExecStart=/opt/jarvis-ui/backend/venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 20005
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable jarvis-backend
systemctl start jarvis-backend
```

---

## Windows Development

For local development on Windows:

```powershell
# Setup
.\scripts\setup.ps1

# Configure
copy backend\env.example backend\.env
notepad backend\.env

# Migrate database
.\scripts\migrate.ps1

# Start (dev mode)
.\scripts\start.ps1
```

---

## Troubleshooting

### Service won't start

```bash
# Check logs
journalctl -u jarvis-ui -n 50
docker compose logs

# Check if port is in use
ss -tuln | grep 20005
```

### Database connection failed

- Verify PostgreSQL is running: `systemctl status postgresql`
- Check the `DATABASE_URL` in `.env`
- Ensure PostgreSQL allows local connections

### n8n tools not working

- Verify n8n is running: `systemctl status n8n` or check Docker
- Check `N8N_API_URL` and `N8N_API_KEY` in `.env`
- Test n8n API: `curl -H "X-N8N-API-KEY: your-key" http://localhost:5678/api/v1/workflows`

---

## Updating

```bash
cd /opt/jarvis-ui
./scripts/linux/update.sh
```

Or manually:

```bash
cd /opt/jarvis-ui
git pull
docker compose down
docker compose up -d --build
```
