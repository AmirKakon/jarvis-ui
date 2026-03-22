# Home Assistant Cleanup Plan

All automated actions use the HA WebSocket API via a Python script. Each step is independent — work through them at your own pace.

## Automated Steps

### Step 1: Update HA Core (2026.3.2 -> 2026.3.3)

- Target: `update.home_assistant_core_update`
- Action: `update.install` service call
- Note: HA will be briefly unavailable during restart

**Status:** [x] Done (updated successfully)

---

### Step 1b: Add Weekly Auto-Update Cron Job

Create `jarvis-home/scripts/ha-update.sh` that:

1. Sources `~/jarvis/.env` for `HA_URL`, `HA_TOKEN`, and `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
2. Queries all `update.*` entities via HA REST API
3. Filters for entities with `state=on` (update available)
4. For each available update, calls `POST /api/services/update/install` with the entity_id
5. Waits up to 10 minutes per update for completion (polls every 30s)
6. Collects results (success/fail per update)
7. Sends a Telegram message summarizing what was updated (or "all up to date")
8. Logs output to `~/jarvis/logs/ha-update.log`

**Cron schedule:** Weekly, Sunday 3:00 AM (`0 3 * * 0`)

**Files to create/modify:**
- `jarvis-home/scripts/ha-update.sh` (new script)
- `jarvis-home/setup.sh` (add crontab entry)

**Status:** [ ] Done

---

### Step 2: Remove 3 Empty Devices

These devices have zero entities and serve no purpose:

- **Living Room AC** — Tuya "Air Conditioner (unsupported)". Dead entry; real AC is "Smart Air Conditioner" in Bedroom.
- **Smart IR** — Tuya "Smart IR (unsupported)". No usable entities created.
- **hci0 (B8:27:EB:65:57:19)** — RPi Bluetooth adapter. Not used for any tracking or automation.

**Status:** [ ] Done

---

### Step 3: Remove Duplicate OpenAI Entries

2x OpenAI AI Task, 2x STT, 2x TTS — all "unknown" state. Likely from re-adding the integration.

Remove duplicates (keep originals):
- `ai_task.openai_ai_task_2`
- `stt.openai_stt_2`
- `tts.openai_tts_2`

**Status:** [ ] Done

---

### Step 4: Delete 2 Broken Scripts

| Script | Issue |
|--------|-------|
| `script.dynamic_battery_icon` | Unavailable — references removed entities |
| `script.toggle_ac` | Unavailable — broken after Tuya reconnect |

**Status:** [ ] Done

---

### Step 5: Clean Up Stale Automations

| Automation | Last Triggered | Action |
|------------|---------------|--------|
| Bathroom lights trigger motion | 481 days ago | **Delete** — motion sensor offline, no light |
| Work Room lights trigger motion | 481 days ago | **Delete** — motion sensor offline, no light |
| Low Battery Motion Detectors | Never | **Disable** — keep for when sensors come back |
| Low Battery Notification | 307 days ago | **Disable** — keep for future use |

**Status:** [ ] Done

---

### Step 9: Disable ChatGPT Morning Chat

- Automation: `automation.chatgpt_morning_weatherchat`
- Last triggered 268 days ago. WeatherChat toggle is off.
- Action: Disable (keep for potential future use)

**Status:** [ ] Done

---

## Manual Steps (HA UI Required)

### Step 6: Re-authenticate Alexa Media Player

Fixes 18 unavailable entities (Amir's Echo Dot, Alexa App for PC, JBL earbuds, plus their shuffle/repeat/DND switches and alarm/timer sensors).

1. Go to **Settings > Devices & Services > Alexa Media Player**
2. Click **Reconfigure**
3. Log in with your Amazon credentials
4. Verify all 18 entities come back online

**Status:** [ ] Done

---

### Step 7: Re-establish Android TV ADB Connection

Fixes `media_player.android_tv_adb` and `remote.android_tv_adb`.

1. Make sure the Android TV is powered on and on the same network
2. Go to **Settings > Devices & Services > Android TV Remote**
3. Click **Reconfigure** or remove and re-add
4. Accept the ADB pairing prompt on the TV screen

**Status:** [ ] Done

---

### Step 8: Check Plata Plug (Tuya)

The Plata plug has 3 unavailable entities (child lock, socket, power-on behavior).

1. Verify the plug is powered and connected to WiFi
2. Check in the **Tuya app** if it appears
3. If not, re-pair it in Tuya, then reload the Tuya integration in HA

**Status:** [ ] Done
