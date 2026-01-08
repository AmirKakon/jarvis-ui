# n8n Workflows Summary

> Last updated: January 8, 2026

This document provides an overview of all n8n workflows used in the JARVIS system.

---

## Table of Contents

### Core Workflows
1. [Jarvis AI Agent Orchestrator](#1-jarvis-ai-agent-orchestrator) - Main AI assistant
2. [AI Long Term Memory Agent](#2-ai-long-term-memory-agent) - Memory storage/retrieval
3. [Memory governance](#3-memory-governance) - Memory classification & validation
4. [Memory deduplication](#4-memory-deduplication) - Duplicate detection
5. [Add Memory](#5-add-memory) - Persist memories to database

### Machine Manager Workflows
6. [Machine Manager Agent](#6-machine-manager-agent) - AI Agent for machine management
7. [Machine Manager - System Status](#7-machine-manager---system-status) - CPU, RAM, disk, network info
8. [Machine Manager - Service Control](#8-machine-manager---service-control) - Systemd service management
9. [Machine Manager - Docker Control](#9-machine-manager---docker-control) - Docker container management
10. [Machine Manager - Jellyfin API](#10-machine-manager---jellyfin-api) - Media server management
11. [Machine Manager - Health Monitor](#11-machine-manager---health-monitor) - Automated health checks

### Utility Workflows
12. [gemini cli trigger](#12-gemini-cli-trigger) - Execute Gemini CLI commands
13. [sudo ssh commands](#13-sudo-ssh-commands) - Execute SSH commands

### N8N Manager Workflows
14. [N8N Manager - API Request](#14-n8n-manager---api-request) - Base n8n API handler
15. [N8N Manager - Workflow List](#15-n8n-manager---workflow-list) - List all workflows
16. [N8N Manager - Workflow Get](#16-n8n-manager---workflow-get) - Get workflow details
17. [N8N Manager - Workflow Create](#17-n8n-manager---workflow-create) - Create new workflow
18. [N8N Manager - Workflow Update](#18-n8n-manager---workflow-update) - Update existing workflow
19. [N8N Manager - Workflow Delete](#19-n8n-manager---workflow-delete) - Delete workflow
20. [N8N Manager - Workflow Activate](#20-n8n-manager---workflow-activate) - Activate workflow
21. [N8N Manager - Workflow Deactivate](#21-n8n-manager---workflow-deactivate) - Deactivate workflow
22. [N8N Manager - Workflow Execute](#22-n8n-manager---workflow-execute) - Execute workflow manually

### Media & File Workflows
23. [download video](#23-download-video) - Video download utility
24. [Upload File](#24-upload-file) - File upload to network storage

---

## 1. Jarvis AI Agent Orchestrator

| Property | Value |
|----------|-------|
| **ID** | `bGlXB1gv8DM69uIQ` |
| **Status** | Active |
| **Trigger** | Webhook (POST, streaming) |
| **Model** | GPT-5-nano |
| **Description** | Main JARVIS orchestrator with Machine Manager tools for system, service, Docker, and Jellyfin management. |

### Purpose
The main JARVIS AI assistant workflow. Acts as the central orchestrator that receives user messages via webhook and coordinates responses using various tools including the Machine Manager suite.

### Personality
- British AI assistant, addresses user as "Sir"
- Dry, courteous, slightly cheeky tone
- Uses British English spelling and phrasing
- Begins acknowledgements with phrases like "At once, Sir"

### System Prompt Structure
The system prompt is organized into sections:
- **Identity** - British persona, address user as "Sir"
- **Response Style** - Concise, lean responses with acknowledgements
- **Task Guidelines** - Technical, planning, and creative task handling
- **Commands** - "Jarvis, ..." and "Dismiss" handling
- **Memory** - Store important facts via Long Term Memory tool
- **Machine Management** - System, service, Docker, and Jellyfin tools
- **Context** - Location (Jerusalem) and local time

### Connected Sub-Agents & Tools
| Agent/Tool | Purpose |
|------------|---------|
| **Machine Manager Agent** | AI Agent for all infrastructure tasks |
| **Long-Term Memory Agent** | Store/retrieve long-term memories |
| **N8N Manager** | Create/manage n8n workflows via API |
| **Gemini CLI** | Execute Gemini CLI for AI analysis |
| **Calculator** | Mathematical calculations |

### Nodes
- Webhook (streaming response)
- AI Agent (LangChain)
- OpenAI Chat Model (gpt-5-nano)
- Simple Memory (buffer window with sessionId)
- Respond to Webhook
- Machine Manager tool connections

---

## 2. AI Long Term Memory Agent

| Property | Value |
|----------|-------|
| **ID** | `8ymvtOFFghcnFjjP` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Model** | GPT-5-nano |
| **Description** | Manages persistent storage and retrieval of long-term memories. Enforces governance rules, deduplication, and memory integrity for the JARVIS system. |

### Purpose
Responsible for persistent storage and retrieval of high-confidence, long-term knowledge. Acts as the authoritative source of truth for user facts, preferences, skills, and historical events.

### Input
- `chatInput`: The query or memory content
- `sessionId`: Session identifier for memory isolation

### Storage Workflow (Must Follow In Order)
1. **Governance Check** → Call Memory governance tool first
   - Only proceed if: type ≠ ephemeral, confidence ≥ 0.75, is_opinion = false, is_guess = false
2. **Deduplication Check** → Call Memory deduplication tool
   - If exists = true → Abort and return "duplicate_detected"
3. **Store** → Call Add Memory tool only after both checks pass

### Connected Tools
| Tool | Purpose |
|------|---------|
| **Memory governance** | Classify and validate memories |
| **Memory deduplication** | Check for duplicates |
| **Postgres PGVector Store** | Retrieve memories by similarity |
| **Add Memory** | Persist validated memories |

### Nodes
- Execute Workflow Trigger (chatInput, sessionId)
- AI Agent (LangChain)
- OpenAI Chat Model
- Simple Memory (buffer window with sessionId)
- Tool connections for memory operations

### Database
- Table: `long_term_memory`
- Storage: PostgreSQL with PGVector

---

## 3. Memory governance

| Property | Value |
|----------|-------|
| **ID** | `dUc4LsfxP25i11wD` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Model** | GPT-5-nano |
| **Description** | Classifies memory candidates and enforces governance rules. Returns classification (type, confidence) or rejection reason. |

### Purpose
Decides if a memory is allowed to be stored and how it should be structured. Always runs governance check (no bypass).

### Input Schema

```json
{
  "document": {
    "content": "The user is a software engineer"
  }
}
```

### Output Schema (Success)

```json
{
  "pageContent": "the user is a software engineer",
  "metadata": {
    "type": "fact",
    "confidence": 0.95,
    "is_opinion": false,
    "is_guess": false
  }
}
```

### Output Schema (Rejection)

```json
{
  "rejected": true,
  "reason": "Memory failed governance check",
  "details": {
    "type": "ephemeral",
    "confidence": 0.3,
    "is_opinion": true,
    "is_guess": false
  }
}
```

### Acceptance Rules
Memory proceeds only if:
- `type` ≠ ephemeral
- `confidence` ≥ 0.75
- `is_opinion` = false
- `is_guess` = false

### Nodes
1. **normalize data** - Lowercase, trim whitespace, collapse spaces
2. **Message Classifier** - AI classification with JSON schema (gpt-5-nano)
3. **Memory Gate** - Conditional check against acceptance rules
4. **Document Mapper** - Format successful output with metadata
5. **Rejection Output** - Format rejection with reason and details

---

## 4. Memory deduplication

| Property | Value |
|----------|-------|
| **ID** | `07RhLX2UKvMjY1cr` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Description** | Checks if a memory already exists in the database by comparing SHA-256 hash of normalized content. |

### Purpose
Normalize candidate memory, generate its hash, and verify whether it already exists in the database.

### Input
- `content`: The memory text to check
- `dbTable`: Target table name (e.g., `long_term_memory`)

### Output

```json
{
  "normalized_text": "string",
  "exists": true/false
}
```

### Nodes
1. **normalize content** - Lowercase, collapse whitespace, trim
2. **Check hash exists** - SQL query using SHA-256 hash
3. **output fields** - Format result with normalized_text and exists flag

### Logic
1. Normalize text (lowercase, collapse whitespace, trim)
2. Query database using SHA-256 hash
3. Return existence status

### Rule
If `exists` = true → **DO NOT STORE**

---

## 5. Add Memory

| Property | Value |
|----------|-------|
| **ID** | `sCcmYT1ufy8hrHMA` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Description** | Persists validated memories to PostgreSQL vector database with embeddings and metadata (type, confidence, source, timestamp). |

### Purpose
Persist validated memories to the PostgreSQL vector database.

### Input Schema

```json
{
  "document": {
    "content": "The user is a software engineer",
    "metadata": {
      "type": "fact",
      "confidence": 0.95
    }
  },
  "dbTable": "long_term_memory"
}
```

### Nodes
1. **normalize data** - Normalize content text
2. **Document Mapper** - Format document with metadata
3. **Default Data Loader** - Prepare for vector store
4. **Embeddings OpenAI** - Generate embeddings
5. **Postgres PGVector Store** - Insert into database

### Metadata Stored
- `type`: fact/preference/skill/event
- `confidence`: 0-1 score
- `source`: "agent_inference"
- `created_at`: ISO8601 timestamp

---

## 6. Machine Manager Agent

| Property | Value |
|----------|-------|
| **ID** | `3BKi0U0juxBNd3aO` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Model** | GPT-5-nano |
| **Description** | AI Agent specialized in machine and infrastructure management. Delegates to sub-tools for system, service, Docker, and Jellyfin operations. |

### Purpose
Expert AI Agent for all machine management tasks. Acts as a sub-agent to Jarvis, handling infrastructure requests with its own focused system prompt.

### Input
- `chatInput`: The task description (e.g., "check disk usage", "restart docker")
- `sessionId`: Session identifier for context

### Connected Tools
| Tool | Purpose |
|------|---------|
| **System Status** | CPU, memory, disk, network monitoring |
| **Service Control** | systemd service management |
| **Docker Control** | Container management |
| **Jellyfin API** | Media server operations |

### Nodes
- Execute Workflow Trigger
- AI Agent (LangChain) with infrastructure-focused system prompt
- OpenAI Chat Model (gpt-5-nano)
- Simple Memory (session-based)
- Tool workflow connections

### Credentials
- OpenAI: `OpenAi account`

---

## 7. Machine Manager - System Status

| Property | Value |
|----------|-------|
| **ID** | `7LHGwHNVnfFNR7Dz` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Description** | Retrieves system information including CPU, memory, disk, network, processes, and uptime. |

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

### Nodes
1. **When Executed by Another Workflow** - Trigger with infoType input
2. **Prepare Command** - JavaScript to build appropriate bash command
3. **Execute System Command** - SSH execution
4. **Format Output** - Clean and format results

### Credentials
- SSH: `IOT_Kamuri`

---

## 7. Machine Manager - Service Control

| Property | Value |
|----------|-------|
| **ID** | `EmRfZ7kbqyAIbz4m` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Description** | Manages systemd services: check status, start, stop, restart, enable/disable, and view logs. |

### Purpose
Control and monitor systemd services on the machine.

### Input
- `action`: Operation to perform
- `serviceName`: Name of the service (required for most actions)

### Actions

| Action | Description | Requires Service |
|--------|-------------|-----------------|
| `status` | Check service status | Optional (lists running if omitted) |
| `start` | Start a service | Yes |
| `stop` | Stop a service | Yes |
| `restart` | Restart a service | Yes |
| `enable` | Enable service at boot | Yes |
| `disable` | Disable service at boot | Yes |
| `list` | List all services | No |
| `failed` | List failed services | No |
| `logs` | View service logs (last 50 lines) | Yes |

### Output

```json
{
  "action": "status",
  "serviceName": "n8n",
  "status": "success",
  "output": "... service status ...",
  "errors": null,
  "timestamp": "2026-01-08T12:00:00Z"
}
```

### Nodes
1. **When Executed by Another Workflow** - Trigger with action and serviceName
2. **Prepare Command** - Build systemctl command
3. **Has Error?** - Validate inputs
4. **Execute Service Command** - SSH with sudo
5. **Format Output** - Clean results

### Credentials
- SSH: `IOT_Kamuri`

---

## 8. Machine Manager - Docker Control

| Property | Value |
|----------|-------|
| **ID** | `oj51dGKjapXRP91r` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Description** | Manages Docker containers: list, stats, logs, start/stop/restart, inspect, and more. |

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

### Output

```json
{
  "action": "ps",
  "containerName": "N/A",
  "status": "success",
  "output": "... container list ...",
  "errors": null,
  "timestamp": "2026-01-08T12:00:00Z"
}
```

### Nodes
1. **When Executed by Another Workflow** - Trigger with action and containerName
2. **Prepare Command** - Build docker command
3. **Has Error?** - Validate inputs
4. **Execute Docker Command** - SSH with sudo
5. **Format Output** - Clean results

### Credentials
- SSH: `IOT_Kamuri`

---

## 9. Machine Manager - Jellyfin API

| Property | Value |
|----------|-------|
| **ID** | `JlhBPAIfI8WHfCsj` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Description** | Interacts with Jellyfin media server API (port 20001) for server management and media operations. |

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

### Output

```json
{
  "action": "status",
  "status": "success",
  "data": { ... },
  "timestamp": "2026-01-08T12:00:00Z"
}
```

### Nodes
1. **When Executed by Another Workflow** - Trigger with action and params
2. **Prepare Request** - Build Jellyfin API URL
3. **Has Error?** - Validate inputs
4. **Jellyfin API Request** - HTTP request to localhost:20001
5. **Format Output** - Clean and truncate results

### Base URL
```
http://localhost:20001
```

---

## 10. Machine Manager - Health Monitor

| Property | Value |
|----------|-------|
| **ID** | `3P2iNI900z4nZIGc` |
| **Status** | Active |
| **Trigger** | Schedule Trigger (every 15 minutes) |
| **Description** | Automated health monitoring with alerts for disk usage, CPU load, and service status. |

### Purpose
Continuously monitor system health and alert on issues.

### Monitoring Checks
- **Disk Usage**: Alert if any partition > 90% (critical) or > 80% (warning)
- **CPU Load**: Alert if 1-minute load > 4 (assuming 4 cores)
- **Memory**: Track usage stats
- **Services**: Check n8n, jellyfin, smbd, docker status

### Output

```json
{
  "timestamp": "2026-01-08T12:00:00Z",
  "status": "healthy" | "warning" | "critical",
  "alertCount": 0,
  "alerts": [],
  "memory": {
    "total": "16Gi",
    "used": "8Gi",
    "free": "4Gi",
    "available": "7Gi"
  }
}
```

### Nodes
1. **Every 15 Minutes** - Schedule trigger
2. **Check System Health** - SSH command for comprehensive check
3. **Analyze Health** - Parse output and detect issues
4. **Has Alerts?** - Conditional check
5. **Send Alert (Placeholder)** - Notification (configure Telegram/Email)
6. **Log Health Status** - Log healthy status

### Alert Integration
The workflow has a placeholder for notifications. Connect a Telegram or Email node to `Send Alert (Placeholder)` to receive alerts.

### Credentials
- SSH: `IOT_Kamuri`

---

## 11. gemini cli trigger

| Property | Value |
|----------|-------|
| **ID** | `anunjMp26km77JN7` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Description** | Executes Gemini CLI commands on the local machine via SSH. Command format: gemini -y -p "<prompt>" |

### Purpose
Execute Gemini CLI commands on the local machine via SSH.

### Input
- `prompt`: The query to send to Gemini

### Command Format

```bash
gemini -y -p "<prompt>"
```

### Nodes
1. **Execute gemini cli** - SSH node with password auth

### Credentials
- SSH: `IOT_Kamuri`

---

## 12. sudo ssh commands

| Property | Value |
|----------|-------|
| **ID** | `TTqKNvyugLWoVF08` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Description** | Executes SSH commands with sudo privileges on the local machine. Sudo prefix is added automatically. |

### Purpose
Run any SSH command on the local machine with sudo privileges.

### Input
- `command`: The command to execute (without sudo prefix)

### Command Format

```bash
sudo <command>
```

### Nodes
1. **ssh command** - SSH node with password auth

### Credentials
- SSH: `IOT_Kamuri`

---

## 13. N8N Manager - API Request

| Property | Value |
|----------|-------|
| **ID** | `rJoy4infFhxMynsJ` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Description** | Base workflow for N8N Manager. Makes HTTP requests to the n8n API for workflow management (create, read, update, delete workflows). |

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

### Nodes
1. **Normalize Path** - Ensure path starts with `/`
2. **HTTP Request** - Execute API call with auth header

---

## 14. N8N Manager - Workflow List

| Property | Value |
|----------|-------|
| **ID** | `Qa93D3eLsEyc8lP8` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Description** | Lists all n8n workflows with their status, name, and ID. Returns array of workflow summaries. |

### Purpose
Retrieve a list of all workflows in the n8n instance.

### Input
- `activeOnly` (optional): Boolean to filter only active workflows

### Output

```json
{
  "total": 10,
  "workflows": [
    {
      "id": "abc123",
      "name": "My Workflow",
      "active": true,
      "createdAt": "2026-01-01T00:00:00Z",
      "updatedAt": "2026-01-07T00:00:00Z"
    }
  ]
}
```

### Nodes
1. **When Executed by Another Workflow** - Trigger
2. **Call N8N API** - Execute base API workflow
3. **Format Response** - Format workflow list for readability

---

## 15. N8N Manager - Workflow Get

| Property | Value |
|----------|-------|
| **ID** | `pnlb3Sp3BsBxRMwo` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Description** | Gets detailed information about a specific workflow by ID. Returns full workflow definition including nodes and connections. |

### Purpose
Retrieve complete details of a specific workflow.

### Input
- `workflowId`: The ID of the workflow to retrieve

### Output
Full workflow JSON including nodes, connections, settings, and metadata.

### Nodes
1. **When Executed by Another Workflow** - Trigger
2. **Call N8N API** - Execute base API workflow

---

## 16. N8N Manager - Workflow Create

| Property | Value |
|----------|-------|
| **ID** | `rmHtxGxBYPtmotHz` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Description** | Creates a new n8n workflow from a JSON definition. Requires name, nodes, and connections. Returns the created workflow with its assigned ID. |

### Purpose
Create a new workflow in n8n from a JSON definition.

### Input
- `workflowJson`: Complete workflow definition (string or object)

### Required Fields in workflowJson
- `name`: Workflow display name
- `nodes`: Array of node definitions (can be empty)
- `connections`: Node connections object (can be empty)
- `settings`: Workflow settings (can be empty object)

### Output

```json
{
  "success": true,
  "message": "Workflow created successfully",
  "workflow": {
    "id": "newWorkflowId",
    "name": "My New Workflow",
    "active": false,
    "createdAt": "2026-01-07T00:00:00Z"
  }
}
```

### Nodes
1. **When Executed by Another Workflow** - Trigger
2. **Validate Workflow** - Parse and validate JSON
3. **Call N8N API** - Execute base API workflow
4. **Format Response** - Return creation confirmation

---

## 17. N8N Manager - Workflow Update

| Property | Value |
|----------|-------|
| **ID** | `HGtPmkUCzYOy3lo1` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Description** | Updates an existing n8n workflow. Requires workflowId and the updated workflow JSON. Returns the updated workflow. |

### Purpose
Update an existing workflow with new definition.

### Input
- `workflowId`: ID of workflow to update
- `workflowJson`: Updated workflow definition

### Output

```json
{
  "success": true,
  "message": "Workflow updated successfully",
  "workflow": {
    "id": "workflowId",
    "name": "Updated Workflow",
    "active": true,
    "updatedAt": "2026-01-07T00:00:00Z"
  }
}
```

### Nodes
1. **When Executed by Another Workflow** - Trigger
2. **Validate Input** - Validate workflowId and JSON
3. **Call N8N API** - Execute base API workflow
4. **Format Response** - Return update confirmation

---

## 18. N8N Manager - Workflow Delete

| Property | Value |
|----------|-------|
| **ID** | `BMvwGw7h9cRylQUE` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Description** | Deletes an n8n workflow by ID. Returns confirmation of deletion. |

### Purpose
Permanently delete a workflow from n8n.

### Input
- `workflowId`: ID of workflow to delete

### Output

```json
{
  "success": true,
  "message": "Workflow abc123 deleted successfully"
}
```

### Nodes
1. **When Executed by Another Workflow** - Trigger
2. **Check ID Provided** - Validate workflowId exists
3. **Call N8N API** - Execute base API workflow
4. **Success Response** - Return deletion confirmation
5. **Error Response** - Handle missing ID error

---

## 19. N8N Manager - Workflow Activate

| Property | Value |
|----------|-------|
| **ID** | `GKM344aryPP29f2O` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Description** | Activates an n8n workflow by ID. The workflow will start listening for triggers after activation. |

### Purpose
Activate a workflow so it starts listening for triggers.

### Input
- `workflowId`: ID of workflow to activate

### Output

```json
{
  "success": true,
  "message": "Workflow abc123 activated successfully",
  "active": true
}
```

### Nodes
1. **When Executed by Another Workflow** - Trigger
2. **Call N8N API** - Execute base API workflow
3. **Success Response** - Return activation confirmation

---

## 20. N8N Manager - Workflow Deactivate

| Property | Value |
|----------|-------|
| **ID** | `OMqZ93GtwiWTuXne` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Description** | Deactivates an n8n workflow by ID. The workflow will stop listening for triggers after deactivation. |

### Purpose
Deactivate a workflow so it stops listening for triggers.

### Input
- `workflowId`: ID of workflow to deactivate

### Output

```json
{
  "success": true,
  "message": "Workflow abc123 deactivated successfully",
  "active": false
}
```

### Nodes
1. **When Executed by Another Workflow** - Trigger
2. **Call N8N API** - Execute base API workflow
3. **Success Response** - Return deactivation confirmation

---

## 21. N8N Manager - Workflow Execute

| Property | Value |
|----------|-------|
| **ID** | `eEtS2fTRa7FA8wAl` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Description** | Manually executes an n8n workflow by ID. Can optionally provide input data for the execution. |

### Purpose
Manually trigger execution of a workflow.

### Input
- `workflowId`: ID of workflow to execute
- `inputData` (optional): JSON data to pass to the workflow

### Output

```json
{
  "success": true,
  "message": "Workflow executed",
  "execution": {
    "id": "executionId",
    "workflowId": "abc123",
    "finished": true,
    "mode": "manual",
    "startedAt": "2026-01-07T00:00:00Z",
    "stoppedAt": "2026-01-07T00:00:01Z",
    "status": "success"
  },
  "data": { ... }
}
```

### Nodes
1. **When Executed by Another Workflow** - Trigger
2. **Prepare Request** - Validate and prepare input data
3. **Call N8N API** - Execute base API workflow
4. **Format Response** - Return execution result

---

## 22. download video

| Property | Value |
|----------|-------|
| **ID** | `dJmq3O0s7lDAMANm` |
| **Status** | Active |
| **Trigger** | Form Trigger |
| **Description** | Downloads videos from URLs to media library (movies/TV shows) with optional Jellyfin sync and Telegram notifications. |

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

### Nodes
1. **On form submission** - Form trigger
2. **Prepare Path** - Extract filename, determine base directory
3. **Prepare Target Directory** - Apply custom subfolder
4. **Prepare Full Path** - Combine path components
5. **Create Directory** - SSH mkdir -p
6. **Download video** - SSH wget with retries
7. **Verify File** - SSH test file exists and not empty
8. **Verify fails** - Conditional check
9. **Stop and Error** - Error handling
10. **Sync Jellyfin** - Check sync preference
11. **Sync** - Conditional for Jellyfin refresh
12. **Refresh Jellyfin Library** - HTTP POST to Jellyfin API
13. **Send a text message** - Telegram success notification
14. **Error Trigger** - Error trigger
15. **Send Error Notification** - Telegram error notification

### Features
- Automatic filename extraction from URL
- Custom subfolder support
- Optional Jellyfin library sync
- Telegram notifications (success/failure)
- File verification after download

### Credentials
- SSH: `IOT_Kamuri`
- Telegram: `kakischer_n8n_bot`

---

## 23. Upload File

| Property | Value |
|----------|-------|
| **ID** | `Ne4nanoy1AypIGqE` |
| **Status** | Active |
| **Trigger** | Form Trigger |
| **Description** | Uploads files to network storage via SFTP with auto-numbering for multiple files and custom subpath support. |

### Purpose
Upload files to network storage via SFTP.

### Form Fields
| Field | Type | Description |
|-------|------|-------------|
| FileName | Text | Custom filename (optional) |
| SubPath | Text | Subdirectory path |
| File | File | The file(s) to upload |

### Base Path

```
shared-storage/מסמכים
```

### Nodes
1. **On form submission** - Form trigger
2. **Build Upload Path** - JavaScript code for path construction
3. **Upload via SFTP** - FTP node with SFTP protocol

### Features
- Auto-numbering for multiple files
- Filename sanitization
- Extension preservation
- Custom subpath support

### Credentials
- SFTP: `FTP account`

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Jarvis AI Agent Orchestrator                        │
│                           (Main Entry Point)                             │
│                    Webhook → AI Agent → Response                         │
│                                                                          │
│  Tools: Calculator, Gemini CLI                                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
        ▼                           ▼                           ▼
┌───────────────────┐   ┌───────────────────┐   ┌───────────────────┐
│  Machine Manager  │   │  Long-Term Memory │   │    N8N Manager    │
│      AGENT        │   │       AGENT       │   │     (API Tool)    │
│  (Sub-Agent)      │   │   (Sub-Agent)     │   │                   │
└───────────────────┘   └───────────────────┘   └───────────────────┘
        │                           │                       │
        │                           │               ┌───────┴───────┐
        ▼                           ▼               │ Workflow CRUD │
┌───────────────────┐   ┌───────────────────┐       └───────────────┘
│ Machine Tools:    │   │  Memory Tools:    │
│ • System Status   │   │  • Governance     │
│ • Service Control │   │  • Deduplication  │
│ • Docker Control  │   │  • Add Memory     │
│ • Jellyfin API    │   │  • PGVector Store │
└───────────────────┘   └───────────────────┘
        │                           │
        │                           ▼
        │               ┌─────────────────────┐
        │               │  PostgreSQL+PGVector │
        │               │  (long_term_memory)  │
        │               └─────────────────────┘
        │
        ├─────────────────────────────────────┐
        ▼                                     ▼
┌───────────────┐                   ┌───────────────┐
│ Health Monitor│                   │ Jellyfin API  │
│ (Scheduled)   │                   │ Port 20001    │
└───────────────┘                   └───────────────┘
```

### Hierarchical Agent Pattern
The system uses a **hierarchical agent architecture**:
- **Jarvis** (Top-level) → Routes to specialized sub-agents
- **Machine Manager Agent** → Expert in infrastructure
- **Long-Term Memory Agent** → Expert in memory management
- **N8N Manager** → Direct API tool for workflow management

---

## Port Mapping

| Port  | Service      | Description                |
|-------|--------------|---------------------------|
| 20000 | Samba/SSH    | File sharing & remote access |
| 20001 | Jellyfin     | Media server              |
| 20002 | n8n          | Automation platform       |

---

## Machine Manager Tool Summary

| Tool | Purpose | Parameters |
|------|---------|------------|
| **System Status** | Get system info | `infoType`: cpu, memory, disk, network, processes, uptime, all |
| **Service Control** | Manage systemd services | `action`, `serviceName` |
| **Docker Control** | Manage containers | `action`, `containerName` |
| **Jellyfin API** | Media server management | `action`, `params` |
| **Health Monitor** | Automated monitoring | Runs every 15 minutes |

---

## N8N Manager Tool Summary

| Tool | Purpose | Input |
|------|---------|-------|
| **Workflow List** | List all workflows | `activeOnly` (optional) |
| **Workflow Get** | Get workflow details | `workflowId` |
| **Workflow Create** | Create new workflow | `workflowJson` |
| **Workflow Update** | Update existing workflow | `workflowId`, `workflowJson` |
| **Workflow Delete** | Delete workflow | `workflowId` |
| **Workflow Activate** | Activate workflow | `workflowId` |
| **Workflow Deactivate** | Deactivate workflow | `workflowId` |
| **Workflow Execute** | Execute workflow manually | `workflowId`, `inputData` (optional) |

---

## Credentials Used

| Credential Name | Type | Used By |
|-----------------|------|---------|
| OpenAi account | OpenAI API | Multiple workflows |
| N8N-Kamuri | PostgreSQL | Memory workflows |
| IOT_Kamuri | SSH Password | gemini cli, sudo ssh, Machine Manager, download video |
| FTP account | SFTP | Upload File |
| kakischer_n8n_bot | Telegram API | download video |

---

## Notes

1. **Memory System**: The JARVIS memory system uses a multi-layer governance approach:
   - Normalization → Classification → Deduplication → Storage
   - All memories are embedded using OpenAI and stored in PGVector
   - Session isolation ensures memories don't cross between sessions

2. **Streaming**: The main orchestrator uses streaming responses for real-time output

3. **Model**: All AI workflows currently use `gpt-5-nano`

4. **Location**: Default location is Jerusalem, Israel (Asia/Jerusalem timezone)

5. **N8N Manager**: The N8N Manager suite enables programmatic workflow management:
   - All specialized workflows call the base API Request workflow
   - Workflows can be created, updated, deleted, activated/deactivated, and executed
   - This enables the AI agent to create new tools for itself dynamically

6. **Machine Manager**: The Machine Manager suite provides comprehensive machine control:
   - System Status for monitoring CPU, memory, disk, and network
   - Service Control for systemd service management
   - Docker Control for container management
   - Jellyfin API for media server integration
   - Health Monitor for automated alerting (configure notifications as needed)
