Create a Home Assistant scene. Argument: $ARGUMENTS

Load credentials: `source ~/jarvis/.env`

## Steps

1. **Parse the request** — understand what the scene should set (lights, switches, climate, media, etc.)
2. **Discover entities** — query `GET $HA_URL/api/states` to find relevant entity_ids and their current attributes
3. **Generate the scene config** as JSON matching the HA REST API format
4. **Push to HA** via `POST $HA_URL/api/config/scene/config/{slug_id}`
5. **Verify** the scene exists via `GET $HA_URL/api/states/scene.{slug_id}`

## API Format

```bash
# Push scene
curl -s -X POST \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  "$HA_URL/api/config/scene/config/movie_night" \
  -d '{
    "name": "Movie Night",
    "entities": {
      "light.living_room": {"state": "on", "brightness": 50},
      "light.hallway": {"state": "off"},
      "media_player.tv": {"state": "on"}
    }
  }'
```

## Entity State Formats

- **Lights**: `{"state": "on", "brightness": 0-255, "color_temp": 150-500}` or `{"state": "off"}`
- **Switches**: `{"state": "on"}` or `{"state": "off"}`
- **Climate**: `{"state": "heat", "temperature": 22}`
- **Media players**: `{"state": "on"}` or `{"state": "off"}`
- **Covers**: `{"state": "open", "current_position": 50}` or `{"state": "closed"}`
- **Fans**: `{"state": "on", "percentage": 50}` or `{"state": "off"}`

## Common Scene Patterns

- **Movie night**: dim lights, TV on, maybe close covers
- **Goodnight**: all lights off, climate to night mode, locks engaged
- **Good morning**: bedroom light on low, kitchen light on, climate to day mode
- **Away**: all lights off, climate to eco, covers closed
- **Reading**: specific light on at high brightness, others dimmed

## Guidelines

- Generate a snake_case slug id from the description (e.g., "movie night" → `movie_night`)
- Discover available entities first — don't assume entity_ids
- For lights, use reasonable brightness values (dim = 30-50, medium = 100-150, bright = 200-255)
- Include only entities relevant to the scene description
- Confirm success with the scene's entity_id and what entities/states are included
- Mention that the scene can be activated via: `/ha toggle scene.{id}` or HA UI
