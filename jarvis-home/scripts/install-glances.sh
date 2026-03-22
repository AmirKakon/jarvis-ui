#!/bin/bash
# Installs Glances system monitor with web API for Home Assistant integration.
# Runs Glances as a user-level systemd service on port 61208.
# Safe to re-run — will update existing installation.

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

GLANCES_PORT=61208

echo -e "${GREEN}Installing Glances...${NC}"

if command -v glances &>/dev/null; then
    echo "  Glances already installed: $(glances --version 2>&1 | head -1)"
    echo "  Upgrading..."
    pip3 install --upgrade --quiet glances[web] 2>/dev/null || \
        pip3 install --upgrade --quiet --break-system-packages glances[web] 2>/dev/null
else
    echo "  Installing via pip..."
    pip3 install --quiet glances[web] 2>/dev/null || \
        pip3 install --quiet --break-system-packages glances[web] 2>/dev/null
fi

GLANCES_PATH=$(which glances)
echo "  Installed at: $GLANCES_PATH"

echo -e "${GREEN}Setting up systemd service...${NC}"

SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_USER_DIR"

cat > "$SYSTEMD_USER_DIR/glances.service" << EOF
[Unit]
Description=Glances system monitor (web API)
After=network.target

[Service]
Type=simple
ExecStart=$GLANCES_PATH -w --port $GLANCES_PORT --disable-webui
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable glances.service 2>/dev/null
systemctl --user restart glances.service 2>/dev/null

# Ensure user services start at boot without requiring a login session
if ! loginctl show-user "$(whoami)" -p Linger 2>/dev/null | grep -q "yes"; then
    echo "  Enabling lingering for $(whoami) (allows services to start at boot)..."
    sudo loginctl enable-linger "$(whoami)" 2>/dev/null || \
        loginctl enable-linger "$(whoami)" 2>/dev/null || true
fi

sleep 2

if systemctl --user is-active --quiet glances.service; then
    echo -e "  ${GREEN}Glances service is running on port $GLANCES_PORT${NC}"
else
    echo -e "  ${YELLOW}Warning: service may not have started. Check: systemctl --user status glances${NC}"
fi

LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "  API endpoint: http://${LOCAL_IP:-localhost}:$GLANCES_PORT/api/3"
echo "  Add Glances integration in HA: Settings > Integrations > Glances"
echo "  Host: ${LOCAL_IP:-<this-machine-ip>}  Port: $GLANCES_PORT"
