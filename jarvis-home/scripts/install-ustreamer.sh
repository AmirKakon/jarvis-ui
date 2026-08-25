#!/bin/bash
# Install ustreamer USB webcam streamer (host, not Docker) + systemd user service.
# go2rtc/ffmpeg could not keep this cheap Jieli (JLDV/AC54) cam streaming — its
# first USB buffers are corrupt and it drops frames, tripping go2rtc's producer
# timeout. ustreamer with --persistent tolerates that and serves MJPEG + stills.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_HOME="$(cd "${SCRIPT_DIR}/.." && pwd)"
JARVIS_DIR="${HOME}/jarvis"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"

mkdir -p "${JARVIS_DIR}/webcam" "${SYSTEMD_USER_DIR}"

# --- 1. Package ---
if command -v ustreamer >/dev/null 2>&1; then
  echo "ustreamer already installed: $(command -v ustreamer)"
else
  echo "Installing ustreamer..."
  if ! sudo apt-get install -y ustreamer; then
    echo "  apt install failed — install ustreamer manually and re-run." >&2
    exit 1
  fi
fi

# --- 2. Device access across reboots ---
# Group membership is the durable fix; the udev ACL covers the headless
# systemd --user session before the group is picked up, and on every hotplug.
if ! id -nG "$USER" | tr ' ' '\n' | grep -qx video; then
  echo "Adding $USER to video group..."
  sudo usermod -aG video "$USER" || true
fi

UDEV_RULE="/etc/udev/rules.d/99-jarvis-webcam.rules"
if command -v setfacl >/dev/null 2>&1; then
  if [ ! -f "$UDEV_RULE" ]; then
    echo "KERNEL==\"video[0-9]*\", SUBSYSTEM==\"video4linux\", RUN+=\"/usr/bin/setfacl -m u:${USER}:rw /dev/%k\"" \
      | sudo tee "$UDEV_RULE" >/dev/null
    sudo udevadm control --reload-rules || true
    sudo udevadm trigger --subsystem-match=video4linux || true
  fi
  [ -e /dev/video0 ] && sudo setfacl -m "u:${USER}:rw" /dev/video0 2>/dev/null || true
fi

# --- 3. Remove old go2rtc footprint (superseded by ustreamer) ---
systemctl --user disable --now jarvis-go2rtc.service >/dev/null 2>&1 || true
rm -f "${SYSTEMD_USER_DIR}/jarvis-go2rtc.service"
rm -f "${JARVIS_DIR}/go2rtc.yaml" "${JARVIS_DIR}/bin/go2rtc"
if command -v docker >/dev/null 2>&1; then
  docker rm -f go2rtc >/dev/null 2>&1 || true
fi

# --- 4. systemd user service ---
cp "${REPO_HOME}/jarvis-ustreamer.service" "${SYSTEMD_USER_DIR}/jarvis-ustreamer.service"
systemctl --user daemon-reload
systemctl --user enable jarvis-ustreamer.service
systemctl --user restart jarvis-ustreamer.service
echo "jarvis-ustreamer.service started."
echo "  still:  http://<lan-ip>:20011/snapshot"
echo "  stream: http://<lan-ip>:20011/stream"
