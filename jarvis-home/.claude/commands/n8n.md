Manage n8n automation workflows. Argument: $ARGUMENTS

Load credentials from `~/jarvis/.env` by running: `source ~/jarvis/.env`

Use the n8n REST API via curl. Base URL and API key come from `N8N_URL` and `N8N_API_KEY`.

All API calls should use:
```
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" "$N8N_URL/api/v1/..."
```

## Common Patterns

- **No arguments or "list"**: List all workflows with `GET /api/v1/workflows` and show ID, name, active status
- **"active"**: List only active workflows by filtering the response
- **"get <id>"**: Get workflow details with `GET /api/v1/workflows/<id>`
- **"activate <id>"**: Activate a workflow with `PATCH /api/v1/workflows/<id>` body `{"active": true}`
- **"deactivate <id>"**: Deactivate a workflow with `PATCH /api/v1/workflows/<id>` body `{"active": false}`
- **"execute <id>"**: Execute a workflow with `POST /api/v1/workflows/<id>/run`
- **"executions"**: List recent executions with `GET /api/v1/executions?limit=10`
- **"executions <id>"**: List executions for a specific workflow with `GET /api/v1/executions?workflowId=<id>&limit=10`
- **"delete <id>"**: Delete a workflow (confirm first) with `DELETE /api/v1/workflows/<id>`
- **"credentials"**: List credentials with `GET /api/v1/credentials`
- **"status"**: Check if n8n is running with `GET /api/v1/workflows?limit=1` and report success/failure

## Workflow Reference

These are key workflows by ID (from the legacy tool registry):
- `7LHGwHNVnfFNR7Dz` - System Status
- `oj51dGKjapXRP91r` - Docker Control
- `EmRfZ7kbqyAIbz4m` - Service Control
- `JlhBPAIfI8WHfCsj` - Jellyfin API
- `TTqKNvyugLWoVF08` - SSH Command
- `anunjMp26km77JN7` - Gemini CLI

## Tips
- When listing workflows, format output as a clean table with ID, name, and active status
- For execution results, extract the output from the last node in the execution data
- Parse JSON responses with `python3 -m json.tool` or `jq` for readability
- For complex automations, prefer using n8n workflows over raw shell commands
