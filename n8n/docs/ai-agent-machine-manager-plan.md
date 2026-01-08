# AI Agent Machine Manager for n8n

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    n8n AI Agent (Main)                      │
│                    Port 20003                               │
├─────────────────────────────────────────────────────────────┤
│                         TOOLS                               │
├──────────────┬──────────────┬──────────────┬───────────────┤
│   System     │   Services   │   AI/LLM     │   Media       │
│   Tools      │   Tools      │   Tools      │   Tools       │
└──────────────┴──────────────┴──────────────┴───────────────┘
         │              │              │              │
         ▼              ▼              ▼              ▼
    Linux Shell    Systemd/      Gemini CLI     Jellyfin API
                   Docker                       Port 20001
```

---

## 🌐 Port Mapping

| Port  | Service      | Description           |
|-------|--------------|----------------------|
| 20000 | SSH          | Remote access         |
| 20001 | nginx        | Reverse proxy (streaming) |
| 20002 | Jellyfin     | Media server          |
| 20003 | n8n          | Automation platform   |
| 20004 | PostgreSQL   | Database (pgvector)   |
| 20005 | Jarvis Backend | FastAPI backend     |
| 20006 | Jarvis Frontend | React frontend     |

---

## 🛠️ Tool Categories & Workflows

### 1. System Management Tools

| Tool Name | Description | Implementation |
|-----------|-------------|----------------|
| `system_status` | Get CPU, RAM, disk usage | Execute Node (bash) |
| `process_list` | List running processes | Execute Node |
| `process_kill` | Kill a process by PID/name | Execute Node |
| `disk_usage` | Check disk space per mount | Execute Node |
| `network_info` | Get network interfaces, open ports | Execute Node |
| `file_read` | Read file contents | Execute Node |
| `file_write` | Write/append to files | Execute Node |
| `file_list` | List directory contents | Execute Node |
| `log_viewer` | Read system/service logs | Execute Node |

### 2. Service Management Tools

| Tool Name | Description | Implementation |
|-----------|-------------|----------------|
| `service_status` | Check status of a service | `systemctl status` |
| `service_start` | Start a service | `systemctl start` |
| `service_stop` | Stop a service | `systemctl stop` |
| `service_restart` | Restart a service | `systemctl restart` |
| `service_list` | List all services with status | `systemctl list-units` |
| `port_check` | Check what's running on a port | `netstat/ss` |

### 3. Gemini CLI Tools

| Tool Name | Description | Implementation |
|-----------|-------------|----------------|
| `gemini_query` | Ask Gemini a question | Execute `gemini` CLI |
| `gemini_analyze` | Analyze file/log content | Pipe to gemini CLI |
| `gemini_code` | Generate/review code | Execute gemini CLI |

### 4. Jellyfin Tools (Port 20001)

| Tool Name | Description | Implementation |
|-----------|-------------|----------------|
| `jellyfin_library_scan` | Trigger library scan | HTTP Request to API |
| `jellyfin_users` | List/manage users | HTTP Request |
| `jellyfin_sessions` | View active sessions | HTTP Request |
| `jellyfin_items` | Search media items | HTTP Request |
| `jellyfin_playback` | Control playback | HTTP Request |

### 5. Docker/Container Tools

| Tool Name | Description | Implementation |
|-----------|-------------|----------------|
| `docker_ps` | List containers | Execute Node |
| `docker_logs` | Get container logs | Execute Node |
| `docker_restart` | Restart container | Execute Node |
| `docker_stats` | Container resource usage | Execute Node |

### 6. Utility Tools

| Tool Name | Description | Implementation |
|-----------|-------------|----------------|
| `run_command` | Execute arbitrary bash command | Execute Node (with safety) |
| `cron_list` | List scheduled tasks | Execute Node |
| `backup_trigger` | Trigger backup workflow | Workflow call |
| `notification_send` | Send notification (email/webhook) | n8n nodes |

---

## 📋 n8n Workflows to Create

### Workflow 1: Main AI Agent
- Webhook trigger (or chat trigger)
- AI Agent node with all tools connected
- Response handling

### Workflow 2: System Commands Tool
Sub-workflow for safe command execution with:
- Input validation
- Command whitelist/sanitization
- Timeout handling
- Error capture

### Workflow 3: Jellyfin Manager
Sub-workflow handling all Jellyfin API calls:
- Auth token management
- API endpoint routing
- Response formatting

### Workflow 4: Service Registry
Maintain a list of known services:

```json
{
  "services": [
    {"name": "samba", "port": 20000, "type": "file-sharing"},
    {"name": "jellyfin", "port": 20001, "type": "media"},
    {"name": "n8n", "port": 20003, "type": "automation"}
  ]
}
```

### Workflow 5: Health Monitor
Scheduled workflow that:
- Checks all services are running
- Monitors resource usage
- Alerts on issues

---

## 🔐 Security Considerations

1. **Command Sanitization** - Never allow raw shell injection
2. **Whitelist Commands** - Only allow pre-approved commands
3. **Rate Limiting** - Prevent abuse
4. **Audit Logging** - Log all agent actions
5. **Credentials** - Use n8n credentials store for API keys

---

## 🚀 Implementation Phases

### Phase 1 - Core System ✅ COMPLETE
- [x] `system_status` tool → **Machine Manager - System Status**
- [x] `service_status` / `service_restart` tools → **Machine Manager - Service Control**
- [x] `log_viewer` tool → Integrated via Service Control (logs action)
- [x] Main AI Agent workflow → **Jarvis AI Agent Orchestrator** updated

### Phase 2 - Service Integration ✅ COMPLETE
- [x] Jellyfin tools → **Machine Manager - Jellyfin API**
- [x] Docker tools → **Machine Manager - Docker Control**
- [x] `port_check` tool → Integrated via System Status (network info)

### Phase 3 - AI Enhancement ✅ COMPLETE
- [x] Gemini CLI integration → **gemini cli trigger** (existing)
- [x] Log analysis with AI → Via Jarvis + service logs
- [x] Smart troubleshooting → Jarvis with all Machine Manager tools

### Phase 4 - Automation ✅ COMPLETE
- [x] Health monitor → **Machine Manager - Health Monitor** (every 15 min)
- [ ] Auto-healing workflows → Placeholder ready for expansion
- [x] Notification system → Placeholder in Health Monitor (add Telegram/Email)

---

## 📝 Notes

- All services use ports 20000+ for organization
- The agent runs on the same machine as the services
- Gemini CLI is available for AI-powered analysis
- Future services can be added to the service registry

