# n8n Workflows Summary

> Last updated: January 11, 2026

This document provides an overview of all n8n workflows used in the JARVIS system.

---

## Architecture Change Notice ⚠️

**As of January 2026, the JARVIS architecture is transitioning to a backend-hosted LLM model.**

### What's Changing

| Component | Old (n8n-hosted) | New (Backend-hosted) |
|-----------|------------------|----------------------|
| **LLM Orchestration** | n8n AI Agent workflow | FastAPI backend |
| **Streaming** | Broken through webhooks | Native WebSocket streaming |
| **Tool Execution** | Multiple entry points | Single Tool Executor workflow |
| **Model Swapping** | Edit n8n workflow | Change environment variable |

### New Architecture Diagram

```
┌─────────────────┐
│  React Frontend │
└────────┬────────┘
         │ WebSocket (streaming)
┌────────▼────────────────────────────┐
│  FastAPI Backend                    │
│  - LLM Orchestrator (NEW)           │
│  - Tool Registry                    │
│  - Session Management               │
└────────┬────────────────────────────┘
         │ HTTP POST (tool calls only)
┌────────▼────────────────────────────┐
│  n8n Tool Executor (NEW)            │
│  Single webhook → Routes to tools   │
└────────┬────────────────────────────┘
         │
    ┌────┴────┬────────┬────────┬────────┐
    ▼         ▼        ▼        ▼        ▼
 System    Docker   Service  Jellyfin   SSH
 Status    Control  Control    API    Commands
```

### Workflow Status

| Status | Meaning |
|--------|---------|
| 🟢 **Active** | Currently in use |
| 🔄 **Transitioning** | Being migrated to new architecture |
| ⚠️ **Deprecated** | Will be removed after migration |
| 🆕 **New** | To be created for new architecture |

---

## Table of Contents

### Tool Executor (NEW)
1. [Tool Executor](#1-tool-executor-new) 🆕 - Single entry point for all tools

### Infrastructure Tools
2. [Machine Manager - System Status](#2-machine-manager---system-status) 🟢
3. [Machine Manager - Service Control](#3-machine-manager---service-control) 🟢
4. [Machine Manager - Docker Control](#4-machine-manager---docker-control) 🟢
5. [Machine Manager - Jellyfin API](#5-machine-manager---jellyfin-api) 🟢
6. [Machine Manager - Health Monitor](#6-machine-manager---health-monitor) 🟢

### Utility Tools
7. [gemini cli trigger](#7-gemini-cli-trigger) 🟢
8. [sudo ssh commands](#8-sudo-ssh-commands) 🟢

### N8N Manager Tools
9. [N8N Manager - API Request](#9-n8n-manager---api-request) 🟢
10. [N8N Manager - Workflow List](#10-n8n-manager---workflow-list) 🟢
11. [N8N Manager - Workflow Get](#11-n8n-manager---workflow-get) 🟢
12. [N8N Manager - Workflow Create](#12-n8n-manager---workflow-create) 🟢
13. [N8N Manager - Workflow Update](#13-n8n-manager---workflow-update) 🟢
14. [N8N Manager - Workflow Delete](#14-n8n-manager---workflow-delete) 🟢
15. [N8N Manager - Workflow Activate](#15-n8n-manager---workflow-activate) 🟢
16. [N8N Manager - Workflow Deactivate](#16-n8n-manager---workflow-deactivate) 🟢
17. [N8N Manager - Workflow Execute](#17-n8n-manager---workflow-execute) 🟢

### Media & File Tools
18. [download video](#18-download-video) 🟢
19. [Upload File](#19-upload-file) 🟢

### Deprecated Workflows (Being Migrated)
20. [Jarvis AI Agent Orchestrator](#20-jarvis-ai-agent-orchestrator-deprecated) ⚠️
21. [Machine Manager Agent](#21-machine-manager-agent-deprecated) ⚠️
22. [AI Long Term Memory Agent](#22-ai-long-term-memory-agent-deprecated) ⚠️
23. [Memory governance](#23-memory-governance-deprecated) 🔄
24. [Memory deduplication](#24-memory-deduplication-deprecated) 🔄
25. [Add Memory](#25-add-memory-deprecated) 🔄

---

## 1. Tool Executor (NEW)

| Property | Value |
|----------|-------|
| **ID** | `TBD` |
| **Status** | 🆕 To Be Created |
| **Trigger** | Webhook (POST) |
| **Purpose** | Single entry point for all backend tool calls |

### Purpose

Central routing workflow that receives tool requests from the FastAPI backend and routes them to the appropriate tool workflow.

### Input Schema

```json
{
  "tool": "docker_control",
  "params": {
    "action": "ps",
    "containerName": "optional"
  }
}
```

### Output Schema

```json
{
  "status": "success",
  "tool": "docker_control",
  "result": { ... },
  "timestamp": "2026-01-11T12:00:00Z"
}
```

### Routing Table

| Tool Name | Routes To |
|-----------|-----------|
| `system_status` | Machine Manager - System Status |
| `docker_control` | Machine Manager - Docker Control |
| `service_control` | Machine Manager - Service Control |
| `jellyfin_api` | Machine Manager - Jellyfin API |
| `ssh_command` | sudo ssh commands |
| `gemini_cli` | gemini cli trigger |
| `n8n_workflow_list` | N8N Manager - Workflow List |
| `n8n_workflow_get` | N8N Manager - Workflow Get |
| `n8n_workflow_create` | N8N Manager - Workflow Create |
| `n8n_workflow_update` | N8N Manager - Workflow Update |
| `n8n_workflow_delete` | N8N Manager - Workflow Delete |
| `n8n_workflow_activate` | N8N Manager - Workflow Activate |
| `n8n_workflow_deactivate` | N8N Manager - Workflow Deactivate |
| `n8n_workflow_execute` | N8N Manager - Workflow Execute |

### Proposed Nodes

1. **Webhook** - POST `/webhook/tool-executor`
2. **Switch Node** - Route by `tool` field
3. **Execute Workflow Nodes** - Call appropriate sub-workflow
4. **Merge Results** - Standardize output format
5. **Respond to Webhook** - Return result

---

## 2. Machine Manager - System Status

| Property | Value |
|----------|-------|
| **ID** | `7LHGwHNVnfFNR7Dz` |
| **Status** | 🟢 Active |
| **Trigger** | Execute Workflow Trigger |
| **Updated** | January 8, 2026 |

### Purpose

Get comprehensive system status information from the machine.

### Input

- `infoType`: Type of information to retrieve

### Info Types

| Type | Description |
|------|-------------|
| `cpu` | CPU usage and info |
| `memory` / `ram` | Memory usage details |
| `disk` | Disk space usage |
| `network` | Network interfaces and listening ports |
| `processes` | Top processes by memory usage |
| `uptime` | System uptime and kernel info |
| `all` | Overview of everything (default) |

### Output

```json
{
  "infoType": "all",
  "status": "success",
  "output": "... system info ...",
  "errors": null,
  "timestamp": "2026-01-08T12:00:00Z"
}
```

### Credentials

- SSH: `IOT_Kamuri`

---

## 3. Machine Manager - Service Control

| Property | Value |
|----------|-------|
| **ID** | `EmRfZ7kbqyAIbz4m` |
| **Status** | 🟢 Active |
| **Trigger** | Execute Workflow Trigger |
| **Updated** | January 8, 2026 |

### Purpose

Control and monitor systemd services on the machine.

### Input

- `action`: Operation to perform
- `serviceName`: Name of the service (required for most actions)

### Actions

| Action | Description | Requires Service |
|--------|-------------|-----------------|
| `status` | Check service status | Optional |
| `start` | Start a service | Yes |
| `stop` | Stop a service | Yes |
| `restart` | Restart a service | Yes |
| `enable` | Enable service at boot | Yes |
| `disable` | Disable service at boot | Yes |
| `list` | List all services | No |
| `failed` | List failed services | No |
| `logs` | View service logs (last 50 lines) | Yes |

### Credentials

- SSH: `IOT_Kamuri`

---

## 4. Machine Manager - Docker Control

| Property | Value |
|----------|-------|
| **ID** | `oj51dGKjapXRP91r` |
| **Status** | 🟢 Active |
| **Trigger** | Execute Workflow Trigger |
| **Updated** | January 8, 2026 |

### Purpose

Control and monitor Docker containers on the machine.

### Input

- `action`: Operation to perform
- `containerName`: Name of the container (required for some actions)

### Actions

| Action | Description | Requires Container |
|--------|-------------|-------------------|
| `ps` / `list` | List all containers | No |
| `running` | List running containers | No |
| `stats` | Container resource usage | Optional |
| `logs` | Container logs (last 100 lines) | Yes |
| `start` | Start a container | Yes |
| `stop` | Stop a container | Yes |
| `restart` | Restart a container | Yes |
| `inspect` | Get container details | Yes |
| `images` | List Docker images | No |
| `volumes` | List Docker volumes | No |
| `networks` | List Docker networks | No |
| `compose-ps` | List docker-compose services | No |

### Credentials

- SSH: `IOT_Kamuri`

---

## 5. Machine Manager - Jellyfin API

| Property | Value |
|----------|-------|
| **ID** | `JlhBPAIfI8WHfCsj` |
| **Status** | 🟢 Active |
| **Trigger** | Execute Workflow Trigger |
| **Updated** | January 8, 2026 |

### Purpose

Manage Jellyfin media server via its REST API.

### Input

- `action`: API operation to perform
- `params`: Optional JSON string with additional parameters

### Actions

| Action | Description |
|--------|-------------|
| `status` / `info` | Get server information |
| `health` | Health check endpoint |
| `users` | List all users |
| `sessions` | View active sessions |
| `libraries` / `items` | List media libraries |
| `scan` / `refresh` | Trigger library scan |
| `activity` | View activity log |
| `scheduled-tasks` | List scheduled tasks |
| `search` | Search media (use params.query) |
| `playing` | Currently playing sessions |
| `logs` | Server logs |

### Base URL

```
http://localhost:20001
```

---

## 6. Machine Manager - Health Monitor

| Property | Value |
|----------|-------|
| **ID** | `3P2iNI900z4nZIGc` |
| **Status** | 🟢 Active |
| **Trigger** | Schedule Trigger (every 1 hour) |
| **Updated** | January 8, 2026 |

### Purpose

Continuously monitor system health and alert on issues via Telegram.

### Monitoring Checks

- **Disk Usage**: Alert if any partition > 95% (critical) or > 85% (warning)
- **CPU Load**: Alert if 1-minute load > 4 (assuming 4 cores)
- **Memory**: Track usage stats
- **Services**: Check n8n, jellyfin, smbd, docker status

### Alert Integration

Alerts are sent via Telegram to the configured chat ID when issues are detected.

### Credentials

- SSH: `IOT_Kamuri`
- Telegram: `kakischer_n8n_bot`

---

## 7. gemini cli trigger

| Property | Value |
|----------|-------|
| **ID** | `anunjMp26km77JN7` |
| **Status** | 🟢 Active |
| **Trigger** | Execute Workflow Trigger |
| **Updated** | January 8, 2026 |

### Purpose

Execute Gemini CLI commands on the local machine via SSH.

### Input

- `prompt`: The query to send to Gemini

### Command Format

```bash
gemini -y -p "<prompt>"
```

### Credentials

- SSH: `IOT_Kamuri`

---

## 8. sudo ssh commands

| Property | Value |
|----------|-------|
| **ID** | `TTqKNvyugLWoVF08` |
| **Status** | 🟢 Active |
| **Trigger** | Execute Workflow Trigger |
| **Updated** | January 8, 2026 |

### Purpose

Run any SSH command on the local machine with sudo privileges.

### Input

- `command`: The command to execute (without sudo prefix)

### Command Format

```bash
sudo <command>
```

### Credentials

- SSH: `IOT_Kamuri`

---

## 9. N8N Manager - API Request

| Property | Value |
|----------|-------|
| **ID** | `rJoy4infFhxMynsJ` |
| **Status** | 🟢 Active |
| **Trigger** | Execute Workflow Trigger |
| **Updated** | January 8, 2026 |

### Purpose

Base API handler for all N8N Manager operations. Makes HTTP requests to the n8n REST API.

### Input

- `requestPath`: API path (e.g., `/workflows`)
- `requestBody`: JSON body for the request
- `requestMethod`: HTTP method (GET, POST, PUT, DELETE)

### Base URL

```
http://localhost:20002/api/v1
```

---

## 10-17. N8N Manager Workflows

The N8N Manager suite provides programmatic workflow management:

| Workflow | ID | Purpose |
|----------|-----|---------|
| **Workflow List** | `Qa93D3eLsEyc8lP8` | List all workflows |
| **Workflow Get** | `pnlb3Sp3BsBxRMwo` | Get workflow details |
| **Workflow Create** | `rmHtxGxBYPtmotHz` | Create new workflow |
| **Workflow Update** | `HGtPmkUCzYOy3lo1` | Update existing workflow |
| **Workflow Delete** | `BMvwGw7h9cRylQUE` | Delete workflow |
| **Workflow Activate** | `GKM344aryPP29f2O` | Activate workflow |
| **Workflow Deactivate** | `OMqZ93GtwiWTuXne` | Deactivate workflow |
| **Workflow Execute** | `eEtS2fTRa7FA8wAl` | Execute workflow manually |

All workflows call the base API Request workflow.

---

## 18. download video

| Property | Value |
|----------|-------|
| **ID** | `dJmq3O0s7lDAMANm` |
| **Status** | 🟢 Active |
| **Trigger** | Form Trigger |
| **Updated** | January 8, 2026 |

### Purpose

Download videos from URLs and organize them into the media library.

### Form Fields

| Field | Type | Description |
|-------|------|-------------|
| Download URL | Text | The video URL |
| Video Type | Dropdown | movies / tv show |
| Custom Subfolder | Text | Optional subfolder |
| Sync to Jellyfin | Checkbox | Trigger library scan |

### Storage Paths

- Movies: `/home/iot/shared-storage-2/movies`
- TV Shows: `/home/iot/shared-storage-2/tv-shows`

### Credentials

- SSH: `IOT_Kamuri`
- Telegram: `kakischer_n8n_bot`

---

## 19. Upload File

| Property | Value |
|----------|-------|
| **ID** | `Ne4nanoy1AypIGqE` |
| **Status** | 🟢 Active |
| **Trigger** | Form Trigger |
| **Updated** | January 8, 2026 |

### Purpose

Upload files to network storage via SFTP.

### Form Fields

| Field | Type | Description |
|-------|------|-------------|
| FileName | Text | Custom filename (optional) |
| SubPath | Text | Subdirectory path |
| File | File | The file(s) to upload |

### Credentials

- SFTP: `FTP account`

---

## 20. Jarvis AI Agent Orchestrator (DEPRECATED)

| Property | Value |
|----------|-------|
| **ID** | `bGlXB1gv8DM69uIQ` |
| **Status** | ⚠️ Deprecated |
| **Trigger** | Webhook (POST, streaming) |
| **Model** | GPT-5-nano |
| **Updated** | January 9, 2026 |

### ⚠️ Deprecation Notice

**This workflow is being replaced by the FastAPI backend LLM orchestrator.**

Reasons for deprecation:
- Streaming responses don't work properly through webhook
- High latency due to multiple hops
- Difficult to swap LLM models
- Duplicated session management with backend

### Migration Path

The Jarvis personality, system prompt, and tool definitions are being moved to the FastAPI backend. The backend will call the new Tool Executor workflow for infrastructure operations.

### Previous Purpose

The main JARVIS AI assistant workflow. Acted as the central orchestrator that received user messages via webhook and coordinated responses using various tools.

---

## 21. Machine Manager Agent (DEPRECATED)

| Property | Value |
|----------|-------|
| **ID** | `3BKi0U0juxBNd3aO` |
| **Status** | ⚠️ Deprecated |
| **Trigger** | Execute Workflow Trigger |
| **Model** | GPT-5-nano |
| **Updated** | January 9, 2026 |

### ⚠️ Deprecation Notice

**This workflow is being replaced by direct tool calls from the backend.**

The backend's Tool Registry will call the individual Machine Manager tools (System Status, Docker Control, etc.) directly via the Tool Executor workflow, without needing an intermediate AI agent.

---

## 22. AI Long Term Memory Agent (DEPRECATED)

| Property | Value |
|----------|-------|
| **ID** | `8ymvtOFFghcnFjjP` |
| **Status** | ⚠️ Deprecated |
| **Trigger** | Execute Workflow Trigger |
| **Model** | GPT-5-nano |
| **Updated** | January 8, 2026 |

### ⚠️ Deprecation Notice

**Memory management is moving to the FastAPI backend.**

The backend will handle:
- Memory search via PGVector
- Memory storage with governance rules
- Deduplication checks

---

## 23-25. Memory Workflows (Transitioning)

| Workflow | ID | Status |
|----------|-----|--------|
| **Memory governance** | `dUc4LsfxP25i11wD` | 🔄 May move to backend |
| **Memory deduplication** | `07RhLX2UKvMjY1cr` | 🔄 May move to backend |
| **Add Memory** | `sCcmYT1ufy8hrHMA` | 🔄 May move to backend |

These workflows may remain in n8n if called via the Tool Executor, or may be implemented directly in Python in the backend. Decision pending based on complexity and performance requirements.

---

## Port Mapping

| Port  | Service          | Description                |
|-------|------------------|---------------------------|
| 20000 | SSH              | Remote access              |
| 20001 | Jellyfin         | Media server               |
| 20002 | n8n              | Automation platform        |
| 20004 | PostgreSQL       | Database (pgvector)        |
| 20005 | Jarvis Backend   | FastAPI backend (NEW)      |
| 20006 | Jarvis Frontend  | React frontend             |

---

## Tool Summary (New Architecture)

### Tools Called via Tool Executor

| Tool | n8n Workflow | Parameters |
|------|--------------|------------|
| `system_status` | Machine Manager - System Status | `infoType` |
| `docker_control` | Machine Manager - Docker Control | `action`, `containerName` |
| `service_control` | Machine Manager - Service Control | `action`, `serviceName` |
| `jellyfin_api` | Machine Manager - Jellyfin API | `action`, `params` |
| `ssh_command` | sudo ssh commands | `command` |
| `gemini_cli` | gemini cli trigger | `prompt` |
| `n8n_workflow_*` | N8N Manager suite | various |

### Tools Implemented in Backend (Python)

| Tool | Description |
|------|-------------|
| `calculator` | Mathematical calculations |
| `get_current_time` | Current date/time |
| `search_memory` | Search long-term memory (PGVector) |
| `store_memory` | Store to long-term memory |

---

## Credentials Used

| Credential Name | Type | Used By |
|-----------------|------|---------|
| OpenAi account | OpenAI API | Backend (not n8n) |
| N8N-Kamuri | PostgreSQL | Memory workflows (if kept) |
| IOT_Kamuri | SSH Password | gemini cli, sudo ssh, Machine Manager, download video |
| FTP account | SFTP | Upload File |
| kakischer_n8n_bot | Telegram API | download video, Health Monitor |

---

## Notes

1. **Architecture Transition**: The system is moving from n8n-hosted LLM to backend-hosted LLM for better streaming and performance.

2. **Tool Executor**: A new single-entry-point workflow will be created to route all tool calls from the backend.

3. **Streaming**: Native WebSocket streaming from the backend replaces broken webhook streaming.

4. **Model Swapping**: LLM provider can now be changed via environment variable, not workflow edits.

5. **Memory System**: May move entirely to backend or remain as n8n tools called via Tool Executor.

6. **Health Monitor**: Continues to run independently on schedule with Telegram alerts.

7. **Form Triggers**: download video and Upload File continue to use form triggers for direct user access.
