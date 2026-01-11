# n8n Workflow Builder - Self-Generating Workflows

> Last updated: January 11, 2026

## Overview

n8n can programmatically create, update, and manage its own workflows through its built-in REST API. The JARVIS AI assistant can use these capabilities via the N8N Manager tool suite, now called from the **FastAPI backend** through the Tool Executor.

---

## 🏗️ Architecture (v2 - Backend-Hosted LLM)

```
┌─────────────────────────────────────────────────────────────┐
│                     User Request                            │
│        "Create a workflow that monitors disk space"         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   FastAPI Backend                           │
│                                                             │
│   LLM Orchestrator (direct OpenAI/Anthropic API)            │
│   - Understands request                                     │
│   - Generates workflow JSON                                 │
│   - Calls n8n_workflow_create tool                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   n8n Tool Executor                         │
│              POST /webhook/tool-executor                    │
│                                                             │
│   Routes to: N8N Manager - Workflow Create                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   n8n API Call                              │
│              POST /api/v1/workflows                         │
│                                                             │
│   Creates workflow → Returns ID → Optionally activates      │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔧 n8n Management API

### Available Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/workflows` | GET | List all workflows |
| `/api/v1/workflows` | POST | Create a new workflow |
| `/api/v1/workflows/{id}` | GET | Get workflow details |
| `/api/v1/workflows/{id}` | PUT | Update a workflow |
| `/api/v1/workflows/{id}` | DELETE | Delete a workflow |
| `/api/v1/workflows/{id}/activate` | POST | Activate workflow |
| `/api/v1/workflows/{id}/deactivate` | POST | Deactivate workflow |
| `/api/v1/executions` | GET | List executions |
| `/api/v1/workflows/{id}/execute` | POST | Execute workflow |

### Authentication

- Generate API key in: **Settings → API → Create API Key**
- Use header: `X-N8N-API-KEY: your-api-key`
- Base URL: `http://localhost:20002/api/v1`

---

## 📝 Workflow JSON Structure

### Minimal Workflow Example

```json
{
  "name": "My New Workflow",
  "nodes": [
    {
      "parameters": {},
      "id": "start-node-uuid",
      "name": "Start",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [250, 300]
    },
    {
      "parameters": {
        "command": "echo 'Hello World'"
      },
      "id": "execute-node-uuid",
      "name": "Execute Command",
      "type": "n8n-nodes-base.executeCommand",
      "typeVersion": 1,
      "position": [450, 300]
    }
  ],
  "connections": {
    "Start": {
      "main": [[{"node": "Execute Command", "type": "main", "index": 0}]]
    }
  },
  "active": false,
  "settings": {}
}
```

### Key Components

| Component | Description |
|-----------|-------------|
| `name` | Workflow display name |
| `nodes` | Array of node objects |
| `connections` | How nodes are connected |
| `active` | Whether workflow is active (for triggers) |
| `settings` | Workflow settings (timezone, error handling, etc.) |

---

## 🔌 Common Node Types

### Triggers

| Node Type | Description |
|-----------|-------------|
| `n8n-nodes-base.manualTrigger` | Manual execution |
| `n8n-nodes-base.webhook` | HTTP webhook trigger |
| `n8n-nodes-base.scheduleTrigger` | Cron/interval trigger |
| `n8n-nodes-base.emailTrigger` | Email received trigger |

### Actions

| Node Type | Description |
|-----------|-------------|
| `n8n-nodes-base.executeCommand` | Run shell command |
| `n8n-nodes-base.httpRequest` | Make HTTP request |
| `n8n-nodes-base.code` | Run JavaScript/Python |
| `n8n-nodes-base.if` | Conditional branching |
| `n8n-nodes-base.set` | Set/transform data |
| `n8n-nodes-base.telegram` | Send Telegram message |
| `n8n-nodes-base.slack` | Send Slack message |
| `n8n-nodes-base.ssh` | Execute SSH commands |

---

## 🛠️ Workflow Management Tools (Backend → n8n)

The backend calls these tools via the Tool Executor webhook:

| Tool Name | Description | n8n Workflow |
|-----------|-------------|--------------|
| `n8n_workflow_list` | List all workflows | N8N Manager - Workflow List |
| `n8n_workflow_get` | Get workflow details | N8N Manager - Workflow Get |
| `n8n_workflow_create` | Create new workflow | N8N Manager - Workflow Create |
| `n8n_workflow_update` | Update workflow | N8N Manager - Workflow Update |
| `n8n_workflow_delete` | Delete workflow | N8N Manager - Workflow Delete |
| `n8n_workflow_activate` | Activate workflow | N8N Manager - Workflow Activate |
| `n8n_workflow_deactivate` | Deactivate workflow | N8N Manager - Workflow Deactivate |
| `n8n_workflow_execute` | Execute workflow | N8N Manager - Workflow Execute |

### Backend Tool Registry Schema

```python
# In backend/services/tool_registry.py

{
    "type": "function",
    "function": {
        "name": "n8n_workflow_list",
        "description": "List all n8n workflows",
        "parameters": {
            "type": "object",
            "properties": {
                "activeOnly": {
                    "type": "boolean",
                    "description": "Filter to only active workflows"
                }
            }
        }
    }
},
{
    "type": "function",
    "function": {
        "name": "n8n_workflow_create",
        "description": "Create a new n8n workflow from JSON definition",
        "parameters": {
            "type": "object",
            "properties": {
                "workflowJson": {
                    "type": "object",
                    "description": "Complete workflow definition with name, nodes, connections, settings"
                }
            },
            "required": ["workflowJson"]
        }
    }
},
# ... more tool schemas
```

---

## 🤖 AI-Powered Workflow Generation

The LLM in the FastAPI backend can generate workflow JSON based on natural language requests:

### Process Flow

1. **User Input**: "Create a workflow that checks disk space every hour and alerts me if > 90%"
2. **Backend LLM**: Generates valid n8n workflow JSON
3. **Tool Call**: `n8n_workflow_create` with the JSON
4. **Tool Executor**: Routes to N8N Manager - Workflow Create
5. **n8n API**: Creates the workflow
6. **Response**: Workflow ID returned to user

### Example Prompts → Workflows

| User Request | Generated Workflow |
|--------------|-------------------|
| "Check disk space every hour, alert if > 90%" | Schedule Trigger → SSH Command → IF → Telegram |
| "When I receive a webhook, save data to file" | Webhook → Code → Write File |
| "Monitor a URL and notify me if it's down" | Schedule Trigger → HTTP Request → IF → Email |

---

## 📋 Workflow Templates

### Template: Scheduled Command with Alert

```json
{
  "name": "Scheduled Command with Alert",
  "nodes": [
    {
      "parameters": {
        "rule": {
          "interval": [{"field": "hours", "hoursInterval": 1}]
        }
      },
      "name": "Schedule",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.1,
      "position": [250, 300]
    },
    {
      "parameters": {
        "command": "df -h | grep -E '^/dev'"
      },
      "name": "Check Disk",
      "type": "n8n-nodes-base.executeCommand",
      "typeVersion": 1,
      "position": [450, 300]
    },
    {
      "parameters": {
        "conditions": {
          "string": [{"value1": "={{ $json.stdout }}", "operation": "contains", "value2": "9"}]
        }
      },
      "name": "Check Result",
      "type": "n8n-nodes-base.if",
      "typeVersion": 1,
      "position": [650, 300]
    }
  ],
  "connections": {
    "Schedule": {"main": [[{"node": "Check Disk", "type": "main", "index": 0}]]},
    "Check Disk": {"main": [[{"node": "Check Result", "type": "main", "index": 0}]]}
  }
}
```

### Template: Webhook Handler

```json
{
  "name": "Webhook Handler",
  "nodes": [
    {
      "parameters": {
        "path": "my-webhook",
        "httpMethod": "POST"
      },
      "name": "Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 1,
      "position": [250, 300],
      "webhookId": "unique-webhook-id"
    },
    {
      "parameters": {
        "jsCode": "// Process incoming data\nreturn items;"
      },
      "name": "Process Data",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [450, 300]
    }
  ],
  "connections": {
    "Webhook": {"main": [[{"node": "Process Data", "type": "main", "index": 0}]]}
  }
}
```

---

## ⚠️ Security Considerations

| Risk | Mitigation |
|------|------------|
| Arbitrary code execution | Validate generated workflows before creation |
| Credential exposure | Never include credentials in workflow JSON |
| Infinite loops | Limit trigger frequency, add circuit breakers |
| Resource exhaustion | Set execution limits and timeouts |
| Unauthorized access | Secure API key, use internal network only |

### Recommended Safeguards

1. **Template-based generation** - Use pre-approved templates that AI modifies
2. **Validation layer** - Backend checks workflow JSON before creation
3. **Approval workflow** - Human approval for sensitive workflows (future)
4. **Audit logging** - Log all workflow changes with session ID
5. **Sandboxing** - Test generated workflows before activation

---

## 🎯 Integration with Tool Executor

All N8N Manager calls now go through the Tool Executor:

```
Backend Tool Call:
{
  "tool": "n8n_workflow_create",
  "params": {
    "workflowJson": { ... }
  }
}
    ↓
Tool Executor Webhook:
POST /webhook/tool-executor
    ↓
Switch Node → Routes to N8N Manager - Workflow Create
    ↓
Result returned to Backend
```

### N8N Manager Suite (All Active)

| Workflow | ID | Status |
|----------|-----|--------|
| N8N Manager - API Request | `rJoy4infFhxMynsJ` | 🟢 Active |
| N8N Manager - Workflow List | `Qa93D3eLsEyc8lP8` | 🟢 Active |
| N8N Manager - Workflow Get | `pnlb3Sp3BsBxRMwo` | 🟢 Active |
| N8N Manager - Workflow Create | `rmHtxGxBYPtmotHz` | 🟢 Active |
| N8N Manager - Workflow Update | `HGtPmkUCzYOy3lo1` | 🟢 Active |
| N8N Manager - Workflow Delete | `BMvwGw7h9cRylQUE` | 🟢 Active |
| N8N Manager - Workflow Activate | `GKM344aryPP29f2O` | 🟢 Active |
| N8N Manager - Workflow Deactivate | `OMqZ93GtwiWTuXne` | 🟢 Active |
| N8N Manager - Workflow Execute | `eEtS2fTRa7FA8wAl` | 🟢 Active |

---

## 📝 Notes

- API available at: `http://localhost:20002/api/v1/`
- API key stored in n8n credentials
- Workflow IDs are returned on creation
- Test workflows before activating in production
- Keep template library for common patterns
- All calls now routed through Tool Executor for consistency
