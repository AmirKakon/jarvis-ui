# n8n Workflows Summary

> Last updated: January 8, 2026

This document provides an overview of all n8n workflows used in the JARVIS system.

---

## Table of Contents

1. [Jarvis AI Agent Orchestrator](#1-jarvis-ai-agent-orchestrator) - Main AI assistant
2. [AI Long Term Memory Agent](#2-ai-long-term-memory-agent) - Memory storage/retrieval
3. [Memory governance](#3-memory-governance) - Memory classification & validation
4. [Memory deduplication](#4-memory-deduplication) - Duplicate detection
5. [Add Memory](#5-add-memory) - Persist memories to database
6. [gemini cli trigger](#6-gemini-cli-trigger) - Execute Gemini CLI commands
7. [sudo ssh commands](#7-sudo-ssh-commands) - Execute SSH commands
8. [n8n creator](#8-n8n-creator) - Create/manage n8n workflows via API
9. [download video](#9-download-video) - Video download utility
10. [Upload File](#10-upload-file) - File upload to network storage

---

## 1. Jarvis AI Agent Orchestrator

| Property | Value |
|----------|-------|
| **ID** | `bGlXB1gv8DM69uIQ` |
| **Status** | Active |
| **Trigger** | Webhook (POST, streaming) |
| **Model** | GPT-5-nano |
| **Description** | Main JARVIS orchestrator - receives user messages via webhook, coordinates responses using AI agent with tools for memory, SSH, Gemini CLI, and n8n API management. |

### Purpose
The main JARVIS AI assistant workflow. Acts as the central orchestrator that receives user messages via webhook and coordinates responses using various tools.

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
- **Context** - Location (Jerusalem) and local time

### Connected Tools
| Tool | Purpose |
|------|---------|
| **AI Long Term Memory Agent** | Store/retrieve long-term memories |
| **gemini cli trigger** | Execute Gemini CLI commands on local machine |
| **sudo ssh commands** | Run SSH commands with sudo |
| **n8n creator** | Create/manage n8n workflows via API |
| **Calculator** | Mathematical calculations |

### Nodes
- Webhook (streaming response)
- AI Agent (LangChain)
- OpenAI Chat Model (gpt-5-nano)
- Simple Memory (buffer window with sessionId)
- Respond to Webhook

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

## 6. gemini cli trigger

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

## 7. sudo ssh commands

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

## 8. n8n creator

| Property | Value |
|----------|-------|
| **ID** | `rJoy4infFhxMynsJ` |
| **Status** | Active |
| **Trigger** | Execute Workflow Trigger |
| **Description** | Makes HTTP requests to the n8n API for workflow management (create, read, update, delete workflows). |

### Purpose
Make HTTP requests to the n8n API to create and manage workflows programmatically.

### Input
- `requestPath`: API path (e.g., `/workflows`)
- `requestBody`: JSON body for the request
- `requestMethod`: HTTP method (GET, POST, DELETE, etc.)

### Base URL

```
http://localhost:20002/api/v1
```

### Nodes
1. **Edit Fields** - Ensure path starts with `/`
2. **HTTP Request** - Execute API call with auth header

---

## 9. download video

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

## 10. Upload File

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
┌─────────────────────────────────────────────────────────────────┐
│                    Jarvis AI Agent Orchestrator                  │
│                         (Main Entry Point)                       │
│                      Webhook → AI Agent → Response               │
└─────────────────────────────────────────────────────────────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          │                       │                       │
          ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ AI Long Term    │    │ gemini cli      │    │ sudo ssh        │
│ Memory Agent    │    │ trigger         │    │ commands        │
│ (with sessionId)│    │                 │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
          │                                           │
          │                                           │
    ┌─────┴─────┬─────────────┐              ┌────────┘
    │           │             │              │
    ▼           ▼             ▼              ▼
┌────────┐ ┌────────┐  ┌────────────┐  ┌─────────┐
│Memory  │ │Memory  │  │Add Memory  │  │n8n      │
│govern. │ │dedup.  │  │            │  │creator  │
└────────┘ └────────┘  └────────────┘  └─────────┘
    │           │             │
    └───────────┴─────────────┘
                │
                ▼
    ┌─────────────────────┐
    │  PostgreSQL + PGVector │
    │   (long_term_memory)   │
    └─────────────────────┘
```

---

## Credentials Used

| Credential Name | Type | Used By |
|-----------------|------|---------|
| OpenAi account | OpenAI API | Multiple workflows |
| N8N-Kamuri | PostgreSQL | Memory workflows |
| IOT_Kamuri | SSH Password | gemini cli, sudo ssh, download video |
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

5. **Recent Optimizations** (January 2026):
   - Added descriptions to all workflows
   - Fixed sessionId usage in AI Long Term Memory Agent
   - Simplified Memory governance (removed unnecessary bypass)
   - Added rejection output to Memory governance
   - Improved node naming across workflows
   - Fixed typos and double-space bugs
