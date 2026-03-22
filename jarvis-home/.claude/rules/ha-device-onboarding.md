# Home Assistant Device Onboarding

Step-by-step workflow for adding a new device to Home Assistant. Follow this when the user asks to onboard, add, or set up a new smart device.

## Prerequisites

- **HA URL**: `$HA_URL` from `~/jarvis/.env` (default: `http://192.168.68.113:8123`)
- **HA Token**: `$HA_TOKEN` from `~/jarvis/.env`
- **WebSocket**: `ws://192.168.68.113:8123/api/websocket` -- for registry operations (areas, labels, devices, entities)
- **REST API**: `$HA_URL/api/` -- for state queries and config flows

Always run `source ~/jarvis/.env` before any API calls.

## Onboarding Checklist

```
- [ ] Step 1: Identify the device and integration type
- [ ] Step 2: Add integration to HA (if new)
- [ ] Step 3: Rename entities (clean entity IDs + friendly names)
- [ ] Step 4: Assign area and labels
- [ ] Step 5: Add to dashboard(s)
- [ ] Step 6: Verify everything works
```

## Step 1: Identify Device

Ask the user: what device (brand, model, type) and how it connects (WiFi/Zigbee/Bluetooth/cloud).

Active integrations: Tuya (WiFi devices), ZHA (Zigbee sensors), Alexa Media Player (Echo), Android TV Remote, Oref Alert, Glances (system monitoring at `192.168.68.124:61208`).

## Step 2: Add Integration

For API-configurable integrations:
```bash
# Start config flow
curl -s -X POST -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" \
  "$HA_URL/api/config/config_entries/flow" -d '{"handler": "integration_name"}'

# Submit config (use flow_id from response)
curl -s -X POST -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" \
  "$HA_URL/api/config/config_entries/flow/{flow_id}" -d '{"host": "...", "port": ...}'
```

For OAuth/UI integrations (Tuya, Alexa), instruct user to add via **Settings > Integrations** in the HA UI.

## Step 3: Rename Entities

Use WebSocket `config/entity_registry/update` via a Python script:

```python
await send_cmd(ws, "config/entity_registry/update",
               entity_id="light.old_name",
               new_entity_id="light.clean_name",
               name="Clean Friendly Name")
```

**Naming conventions:**
- Entity IDs: `domain.location_device_type` (e.g., `light.bedroom_light`, `switch.livingroom_ac_plug`)
- Friendly names: Title case, human readable (e.g., "Bedroom Light")

## Step 4: Assign Area and Labels

Available areas:

| Area | ID |
|------|----|
| Balcony | `balcony` |
| Bathroom | `bathroom` |
| Bedroom | `bedroom` |
| Entrance | `entrance` |
| Hallway | `hallway` |
| Kitchen | `kitchen` |
| Living Room | `living_room` |
| Work room | `work_room` |

Assign at the **device level** (not entity) for dashboard visibility:
```python
await send_cmd(ws, "config/device_registry/update",
               device_id="...", area_id="bedroom")
```

Create new area: `await send_cmd(ws, "config/area_registry/create", name="New Area")`

## Step 5: Add to Dashboard

Key dashboards:
- **House User** (`dashboard-house`) -- primary mobile view
- **House Tablet** (`house-tablet`) -- wall tablet view
- **Devices** (`dashboard-devices`) -- system monitoring

Fetch, modify, save via WebSocket:
```python
resp = await send_cmd(ws, "lovelace/config", url_path="dashboard-house")
config = resp["result"]
# modify config["views"][i]["sections"][j]["cards"]
await send_cmd(ws, "lovelace/config/save", url_path="dashboard-house", config=config)
```

Card types by device:
- **Lights/switches**: button card with `tap_action: toggle` in Lights view Section 0
- **Climate**: thermostat card in Lights view Section 1
- **Sensors/monitoring**: entities card or gauge in Devices view
- **Media**: media-control card in Home view

Always update **both** House User and House Tablet to keep them in sync.

## Step 6: Verify

1. Entity states are not "unavailable" or "unknown"
2. Entity appears in the correct area
3. Dashboard card renders correctly
4. Device responds to control commands

## WebSocket Boilerplate

```python
import asyncio, json, sys, websockets
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HA_WS = "ws://192.168.68.113:8123/api/websocket"

# Source token from env: import os; HA_TOKEN = os.environ.get("HA_TOKEN")

msg_id = 0
def next_id():
    global msg_id; msg_id += 1; return msg_id

async def send_cmd(ws, cmd_type, **kwargs):
    mid = next_id()
    await ws.send(json.dumps({"id": mid, "type": cmd_type, **kwargs}))
    while True:
        resp = json.loads(await ws.recv())
        if resp.get("id") == mid: return resp

async def main():
    async with websockets.connect(HA_WS) as ws:
        json.loads(await ws.recv())
        await ws.send(json.dumps({"type": "auth", "access_token": HA_TOKEN}))
        auth = json.loads(await ws.recv())
        if auth.get("type") != "auth_ok":
            print(f"Auth failed: {auth}"); return
        # --- logic here ---

asyncio.run(main())
```

Delete temporary scripts after use.

## Common Pitfalls

- **Tuya/Bluetooth don't support device deletion via API** -- disable with `disabled_by="user"` instead.
- **Area assignment**: always at **device** level, not entity level, for dashboard Areas view.
- **`model` attribute can be None** -- use `(d.get("model") or "").lower()`.
- **HA updates drop WebSocket** -- use REST polling for update monitoring.
