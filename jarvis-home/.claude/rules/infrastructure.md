# Infrastructure Knowledge

## Server Details
- **Machine**: kamuri-mini-pc (Mini PC)
- **OS**: Ubuntu / Debian-based Linux
- **User**: iot (has sudo access)
- **Home**: /home/iot

## Service Ports
- 20003: n8n (automation platform)
- 20004: PostgreSQL
- 20005: Jarvis backend (legacy FastAPI)
- 20006: Jarvis frontend (legacy React/nginx)
- 20008: qBittorrent WebUI
- 20010: JARVIS HTTP brain (`/ask`, Assist shim, `/cam/snapshot`)
- 20011: ustreamer webcam (MJPEG stream / stills for Home Assistant). Listens on all interfaces.

## Webcam (ustreamer)
- Camera: **Logitech C930e** (`046d:0843`), a reliable UVC cam. Stays on the **host**. Do not USB-passthrough into the HA VM. (Replaced a defective Jieli `1224:2a25` cam that constantly re-enumerated and only ever delivered one frame.)
- **apt `ustreamer` + systemd user unit** (`jarvis-ustreamer.service`), not Docker/go2rtc — go2rtc/ffmpeg-in-Docker couldn't drive it reliably. `ustreamer --persistent` serves MJPEG stream + stills.
- Flags: `--format=MJPEG --resolution=640x480 --desired-fps=15 --persistent --drop-same-frames=30 --host=0.0.0.0 --port=20011`. Targets **`/dev/jarvis-cam`** (falls back to `/dev/video0`).
- HA still: `http://192.168.68.124:20011/snapshot` — HA live: `http://192.168.68.124:20011/stream` (MJPEG IP Camera).
- Health signal: **`/state` → `result.source.online`**. The "NO SIGNAL" placeholder is a valid ~13.8KB JPEG, so snapshot byte-size is NOT a health check — use `online`.
- Snapshot helper: `~/jarvis/scripts/webcam-snapshot.sh` (sends Telegram). `/cam` in Telegram.
- `99-jarvis-webcam.rules` (written by `scripts/install-ustreamer.sh`, keyed to `WEBCAM_VID/PID`):
  - `video` group + setfacl ACL → headless `--user` session can open the device.
  - `power/control=on` → no USB autosuspend.
  - `ATTR{index}=="0" SYMLINK+="jarvis-cam"` → stable capture node (cam exposes video node + metadata node; numbers can shuffle).
- **Self-heal:** `scripts/webcam-watchdog.sh` (cron, every minute) restarts the service when `/state` reports the source offline. Log: `~/jarvis/logs/webcam-watchdog.log`.
- **To swap cameras:** change `WEBCAM_VID`/`WEBCAM_PID` in `scripts/install-ustreamer.sh` (find via `lsusb`), then `bash setup.sh`.
- After unplug/replug: `systemctl --user restart jarvis-ustreamer`.

## External Drives
- `~/shared-storage` — 1TB WD USB (exfat), movies, tv-shows, music, gopro, camera, programming
- `~/shared-storage-2` — 5TB WD Elements USB (ntfs), movies, tv-shows, ha-backups
- Both shared via Samba to the local network
- shared-storage-2 may need manual mount after reboot: `sudo mount /dev/sdc1 ~/shared-storage-2`

## Docker
- Docker Compose is used for multi-container services
- Use `docker compose` (v2 syntax, not `docker-compose`)
- Common operations: `docker ps`, `docker logs <name>`, `docker compose up -d`

## systemd
- User-level services are in `~/.config/systemd/user/`
- System-level services are in `/etc/systemd/system/`
- Use `systemctl --user` for user services, `sudo systemctl` for system services
- After modifying service files, run `daemon-reload` before restart

## n8n
- Runs at http://localhost:20003
- Workflows are version-controlled in the jarvis-ui repo under `n8n/workflows/`
- Has API access for programmatic workflow management
- Used primarily for complex multi-step automations

## PostgreSQL
- Runs on port 20004
- Has PGVector extension for embeddings
- Stores Jarvis session history and memory (legacy)

## Jellyfin
- Media server for movies, TV shows, music
- Accessible on the local network

## Home Assistant
- Smart home control platform at http://192.168.68.113:8123
- REST API with long-lived access token (stored in ~/jarvis/.env as HA_TOKEN)
- Source `~/jarvis/.env` before making API calls
- Manages lights, switches, sensors, climate, automations, and scenes
- Automations: POST /api/config/automation/config/{id} to create/update
- Scenes: POST /api/config/scene/config/{id} to create/update
