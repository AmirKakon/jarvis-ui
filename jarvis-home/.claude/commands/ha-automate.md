Create a Home Assistant automation. Argument: $ARGUMENTS

Load credentials: `source ~/jarvis/.env`

## Steps

1. **Parse the request** — understand what trigger(s), condition(s), and action(s) the user wants
2. **Discover entities** — query `GET $HA_URL/api/states` to find the correct entity_ids for the devices/sensors mentioned
3. **Generate the automation config** as JSON matching the HA REST API format
4. **Push to HA** via `POST $HA_URL/api/config/automation/config/{slug_id}`
5. **Verify** the automation exists via `GET $HA_URL/api/states/automation.{slug_id}`

## API Format

```bash
# Push automation
curl -s -X POST \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  "$HA_URL/api/config/automation/config/my_automation_id" \
  -d '{
    "alias": "Human Readable Name",
    "description": "What this automation does",
    "mode": "single",
    "triggers": [
      {"trigger": "state", "entity_id": "binary_sensor.motion", "to": "on"}
    ],
    "conditions": [],
    "actions": [
      {"action": "light.turn_on", "target": {"entity_id": "light.living_room"}}
    ]
  }'
```

## Trigger Types

- `state` — entity state change (`entity_id`, `from`, `to`)
- `time` — specific time (`at: "23:00:00"`)
- `sun` — sunrise/sunset (`event: "sunset"`, optional `offset`)
- `zone` — enter/leave zone (`entity_id`, `zone`, `event: "enter"|"leave"`)
- `numeric_state` — threshold (`entity_id`, `above`/`below`)
- `template` — Jinja2 condition (`value_template`)
- `time_pattern` — recurring (`hours`, `minutes`, `seconds`)

## Condition Types

- `state` — entity in specific state
- `time` — time window (`after`, `before`)
- `zone` — entity in zone
- `numeric_state` — value threshold
- `template` — Jinja2 template

## Action Types

- `<domain>.<service>` — e.g., `light.turn_on`, `switch.turn_off`, `climate.set_temperature`
- `scene.turn_on` — activate a scene
- `notify.notify` — send notification
- `delay` — wait (`"00:05:00"`)
- `wait_template` — wait for condition

## Guidelines

- Generate a snake_case slug id from the description
- Always include `alias` and `description`
- Default `mode` to `single` unless the user implies overlapping runs
- If entities are ambiguous, list candidates and pick the most likely one, noting the assumption
- Confirm success with the automation's entity_id and a summary of what it does
