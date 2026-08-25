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
- 20011: go2rtc webcam (MJPEG / stills for Home Assistant). Bound to localhost + `192.168.68.124` only.

## Webcam (go2rtc)
- USB camera stays on the **host** (`/dev/video0`). Do not USB-passthrough it into the HA VM.
- Config: `~/jarvis/go2rtc.yaml` (MJPEG 640x480 — YUY2 720p drops this Jieli cam).
- HA still: `http://192.168.68.124:20011/api/frame.jpeg?src=webcam`
- HA live: `http://192.168.68.124:20011/api/stream.mjpeg?src=webcam`
- Snapshot helper: `~/jarvis/scripts/webcam-snapshot.sh` (sends Telegram). `/cam` in Telegram.
- After unplug/replug, `docker restart go2rtc` if the stream dies.

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
