# n8n Workflow Builder - Self-Generating Workflows

## Overview

n8n can programmatically create, update, and manage its own workflows through its built-in REST API. This enables building an AI agent that can generate new automation workflows on demand.

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

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     User Request                            │
│        "Create a workflow that monitors disk space"         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      AI Agent                               │
│              (Gemini CLI / OpenAI / etc.)                   │
│                                                             │
│   Understands request → Generates workflow JSON             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   n8n API Call                              │
│              POST /api/v1/workflows                         │
│                                                             │
│   Creates workflow → Returns ID → Optionally activates      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  New Workflow Created                       │
│              Ready to use or activate                       │
└─────────────────────────────────────────────────────────────┘
```

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

### Node Structure

```json
{
  "parameters": {
    // Node-specific parameters
  },
  "id": "unique-uuid",
  "name": "Display Name",
  "type": "n8n-nodes-base.nodeType",
  "typeVersion": 1,
  "position": [x, y]
}
```

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

---

## 🤖 AI-Powered Workflow Generation

### Process Flow

1. **User Input**: Natural language description of desired workflow
2. **AI Processing**: LLM generates valid n8n workflow JSON
3. **Validation**: Check JSON structure and node types
4. **Creation**: POST to n8n API
5. **Activation**: Optionally activate the workflow

### Example Prompts → Workflows

| User Request | Generated Workflow |
|--------------|-------------------|
| "Check disk space every hour, alert if > 90%" | Schedule Trigger → Execute Command → IF → Telegram |
| "When I receive a webhook, save data to file" | Webhook → Code → Write File |
| "Monitor a URL and notify me if it's down" | Schedule Trigger → HTTP Request → IF → Email |

---

## 🛠️ Workflow Management Tools

### Tool Definitions for AI Agent

| Tool Name | Description | Implementation |
|-----------|-------------|----------------|
| `workflow_list` | List all workflows with status | GET /api/v1/workflows |
| `workflow_get` | Get details of a specific workflow | GET /api/v1/workflows/{id} |
| `workflow_create` | Create new workflow from JSON or description | POST /api/v1/workflows |
| `workflow_update` | Modify existing workflow | PUT /api/v1/workflows/{id} |
| `workflow_delete` | Delete a workflow | DELETE /api/v1/workflows/{id} |
| `workflow_activate` | Activate a workflow | POST /api/v1/workflows/{id}/activate |
| `workflow_deactivate` | Deactivate a workflow | POST /api/v1/workflows/{id}/deactivate |
| `workflow_execute` | Run a workflow manually | POST /api/v1/workflows/{id}/execute |
| `workflow_generate` | AI generates workflow from description | AI + POST to API |

---

## 📋 Implementation Options

### Option 1: Using n8n's Built-in "n8n" Node

n8n has a native node for self-management:
- No API key needed (internal calls)
- Simpler setup
- Limited to same n8n instance

### Option 2: Using HTTP Request Node

- More flexible
- Can manage remote n8n instances
- Requires API key
- Full control over requests

### Option 3: Using Code Node + API

```javascript
const apiKey = $env.N8N_API_KEY;
const baseUrl = 'http://localhost:20002/api/v1';

const workflow = {
  name: 'Generated Workflow',
  nodes: [...],
  connections: {...}
};

const response = await fetch(`${baseUrl}/workflows`, {
  method: 'POST',
  headers: {
    'X-N8N-API-KEY': apiKey,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(workflow)
});

return response.json();
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
2. **Validation layer** - Check workflow JSON before creation
3. **Approval workflow** - Human approval for sensitive workflows
4. **Audit logging** - Log all workflow changes
5. **Sandboxing** - Test generated workflows before activation

---

## 📚 Workflow Templates

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
        "command": "={{ $json.command }}"
      },
      "name": "Run Command",
      "type": "n8n-nodes-base.executeCommand",
      "typeVersion": 1,
      "position": [450, 300]
    },
    {
      "parameters": {
        "conditions": {
          "string": [{"value1": "={{ $json.stdout }}", "operation": "contains", "value2": "ERROR"}]
        }
      },
      "name": "Check Result",
      "type": "n8n-nodes-base.if",
      "typeVersion": 1,
      "position": [650, 300]
    }
  ],
  "connections": {
    "Schedule": {"main": [[{"node": "Run Command", "type": "main", "index": 0}]]},
    "Run Command": {"main": [[{"node": "Check Result", "type": "main", "index": 0}]]}
  }
}
```

### Template: Webhook to Action

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

## 🎯 Integration with AI Agent

Add these tools to your main AI Agent Machine Manager:

```
AI Agent Tools:
├── System Tools (existing)
├── Service Tools (existing)
├── Gemini Tools (existing)
├── Jellyfin Tools (existing)
└── Workflow Tools (NEW)
    ├── workflow_list
    ├── workflow_create
    ├── workflow_generate  ← AI-powered
    ├── workflow_update
    ├── workflow_delete
    ├── workflow_activate
    └── workflow_execute
```

This enables the agent to create new tools for itself dynamically!

---

## 📝 Notes

- API available at: `http://localhost:20002/api/v1/`
- Generate API key in n8n Settings → API
- Workflow IDs are returned on creation
- Test workflows before activating in production
- Keep template library for common patterns

