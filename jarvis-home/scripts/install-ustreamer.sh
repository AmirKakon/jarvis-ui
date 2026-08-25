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

# --- 1. Packages (ustreamer + v4l-utils/acl for device handling) ---
NEED_PKGS=()
command -v ustreamer >/dev/null 2>&1 || NEED_PKGS+=(ustreamer)
command -v v4l2-ctl  >/dev/null 2>&1 || NEED_PKGS+=(v4l-utils)
command -v setfacl   >/dev/null 2>&1 || NEED_PKGS+=(acl)
if [ ${#NEED_PKGS[@]} -gt 0 ]; then
  echo "Installing: ${NEED_PKGS[*]}"
  if ! sudo apt-get install -y "${NEED_PKGS[@]}"; then
    echo "  apt install failed — install ${NEED_PKGS[*]} manually and re-run." >&2
    exit 1
  fi
else
  echo "ustreamer/v4l-utils/acl already installed."
fi

# --- 2. Device handling across reboots/re-enumerations ---
# This cheap cam (VID:PID 1224:2a25, "USB PHY 2.0") keeps re-enumerating on the
# USB bus. Symptoms and fixes:
#   * device access:  video group + udev ACL for the headless --user session
#   * "no signal":    USB autosuspend power-cycles it -> pin power/control=on
#   * capture node:   it exposes video (index 0) + metadata (index 1) nodes and
#                     the numbers can shuffle -> a stable /dev/jarvis-cam symlink
#                     always points at the index-0 capture node
#   * reset storms:   its broken USB-audio function spams the bus -> unbind
#                     snd-usb-audio from this device
# ustreamer targets /dev/jarvis-cam; the webcam-watchdog cron bounces the
# service if it ever wedges on a stale handle.
WEBCAM_VID="${WEBCAM_VID:-1224}"
WEBCAM_PID="${WEBCAM_PID:-2a25}"

if ! id -nG "$USER" | tr ' ' '\n' | grep -qx video; then
  echo "Adding $USER to video group..."
  sudo usermod -aG video "$USER" || true
fi

# (Re)write the udev rule idempotently.
UDEV_RULE="/etc/udev/rules.d/99-jarvis-webcam.rules"
{
  echo "# Managed by jarvis install-ustreamer.sh — do not edit by hand."
  echo "# Grant the headless systemd --user session access to any video node."
  echo "KERNEL==\"video[0-9]*\", SUBSYSTEM==\"video4linux\", RUN+=\"/usr/bin/setfacl -m u:${USER}:rw /dev/%k\""
  echo "# Stable symlink to the index-0 capture node (survives re-enumeration)."
  echo "SUBSYSTEM==\"video4linux\", ATTRS{idVendor}==\"${WEBCAM_VID}\", ATTRS{idProduct}==\"${WEBCAM_PID}\", ATTR{index}==\"0\", SYMLINK+=\"jarvis-cam\""
  echo "# Never USB-autosuspend the cam."
  echo "ACTION==\"add\", SUBSYSTEM==\"usb\", ATTR{idVendor}==\"${WEBCAM_VID}\", ATTR{idProduct}==\"${WEBCAM_PID}\", TEST==\"power/control\", ATTR{power/control}=\"on\""
  echo "# Detach the broken USB-audio function that triggers reset storms."
  echo "ACTION==\"add\", SUBSYSTEM==\"usb\", DRIVER==\"snd-usb-audio\", ATTRS{idVendor}==\"${WEBCAM_VID}\", ATTRS{idProduct}==\"${WEBCAM_PID}\", RUN+=\"/bin/sh -c 'echo %k > /sys/bus/usb/drivers/snd-usb-audio/unbind'\""
} | sudo tee "$UDEV_RULE" >/dev/null
sudo udevadm control --reload-rules || true
sudo udevadm trigger --subsystem-match=video4linux || true

# Apply to the currently-plugged cam now (don't wait for a replug/reboot).
if command -v setfacl >/dev/null 2>&1; then
  for v in /dev/video0 /dev/video1 /dev/jarvis-cam; do
    [ -e "$v" ] && sudo setfacl -m "u:${USER}:rw" "$v" 2>/dev/null || true
  done
fi
for d in /sys/bus/usb/devices/*; do
  if [ "$(cat "$d/idVendor" 2>/dev/null)" = "$WEBCAM_VID" ] \
     && [ "$(cat "$d/idProduct" 2>/dev/null)" = "$WEBCAM_PID" ]; then
    [ -f "$d/power/control" ] && echo on | sudo tee "$d/power/control" >/dev/null 2>&1 || true
  fi
done
# Unbind snd-usb-audio from this cam right now (matches the udev rule above).
for i in /sys/bus/usb/drivers/snd-usb-audio/*:*; do
  [ -e "$i" ] || continue
  dev="/sys/bus/usb/devices/${i##*/}/.."
  vid="$(cat "$dev/idVendor" 2>/dev/null || true)"
  pid="$(cat "$dev/idProduct" 2>/dev/null || true)"
  if [ "$vid" = "$WEBCAM_VID" ] && [ "$pid" = "$WEBCAM_PID" ]; then
    echo "$(basename "$i")" | sudo tee /sys/bus/usb/drivers/snd-usb-audio/unbind >/dev/null 2>&1 || true
  fi
done

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
