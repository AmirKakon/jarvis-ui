Manage Home Assistant. Argument: $ARGUMENTS

Load credentials from `~/jarvis/.env` by running: `source ~/jarvis/.env`

Use the Home Assistant REST API via curl. Base URL and token come from the environment variables `HA_URL` and `HA_TOKEN`.

All API calls should use:
```
curl -s -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" "$HA_URL/api/..."
```

## Common Patterns

- **No arguments or "status"**: Get HA status with `GET /api/` and show a summary
- **"entities" or "list"**: Get all entity states with `GET /api/states`, summarise by domain (light, switch, sensor, climate, etc.) with counts
- **"entity <entity_id>"**: Get a specific entity's state with `GET /api/states/<entity_id>`
- **"lights"**: List all light entities and their on/off state
- **"switches"**: List all switch entities and their state
- **"sensors"**: List key sensor readings (temperature, humidity, etc.)
- **"turn on <entity_id>"**: Call service via `POST /api/services/<domain>/turn_on` with `{"entity_id": "<entity_id>"}`
- **"turn off <entity_id>"**: Call service via `POST /api/services/<domain>/turn_off` with `{"entity_id": "<entity_id>"}`
- **"climate <entity_id> <temp>"**: Set temperature via `POST /api/services/climate/set_temperature`
- **"automations"**: List all automations and their enabled/disabled state
- **"scenes"**: List all available scenes
- **"activate <scene_id>"**: Activate a scene via `POST /api/services/scene/turn_on`
- **"history <entity_id>"**: Get recent history for an entity

## Tips
- Entity IDs follow the pattern `domain.name` (e.g., `light.living_room`, `switch.bedroom_fan`)
- When the user says "turn on the lights" without a specific entity, list available lights and ask which one
- For bulk operations (e.g., "turn off all lights"), get all light entities first, then confirm before executing
- Parse JSON responses with `python3 -m json.tool` or `jq` for readability
