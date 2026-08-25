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
- Cheap **Jieli combo cam** `1224:2a25` ("USB PHY 2.0"). Stays on the **host**. Do not USB-passthrough into the HA VM.
- **apt `ustreamer` + systemd user unit** (`jarvis-ustreamer.service`), not Docker/go2rtc — ffmpeg/go2rtc could not keep it streaming; `ustreamer --persistent` rides over its corrupt first buffers and `select() Inappropriate ioctl` reopen loop.
- Flags: `--format=MJPEG --resolution=640x480 --desired-fps=15 --persistent --drop-same-frames=30 --host=0.0.0.0 --port=20011`. Targets **`/dev/jarvis-cam`** (falls back to `/dev/video0`).
- HA still: `http://192.168.68.124:20011/snapshot` — HA live: `http://192.168.68.124:20011/stream` (MJPEG IP Camera).
- Snapshot helper: `~/jarvis/scripts/webcam-snapshot.sh` (sends Telegram). `/cam` in Telegram.
- **This cam re-enumerates on the USB bus constantly.** All mitigations live in `99-jarvis-webcam.rules` (written by `scripts/install-ustreamer.sh`):
  - `video` group + setfacl ACL → headless `--user` session can open the device.
  - `power/control=on` → no USB autosuspend (autosuspend blanked it to "no signal").
  - `ATTR{index}=="0" SYMLINK+="jarvis-cam"` → stable capture node (it exposes a video node **and** a metadata node whose numbers can shuffle).
  - unbind `snd-usb-audio` → its broken mic function was spamming `set freq 48000` / `set_interface -19` and triggering resets.
- **Self-heal:** `scripts/webcam-watchdog.sh` (cron, every minute) restarts the service when `/snapshot` returns empty — ustreamer wedges on a stale handle after a re-enumeration and a bounce always recovers it. Log: `~/jarvis/logs/webcam-watchdog.log`.
- Root cause is flaky USB firmware/power. If drops are frequent: rear USB 2.0 port, no extension cable, or a powered hub. `dmesg | grep -i 'usb 1-2'` shows the re-enumerations.
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
