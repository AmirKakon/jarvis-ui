#!/bin/bash
# Jarvis Claude Code Setup Script
# Run this on the Linux machine to deploy the Claude Code configuration.
# Safe to re-run — syncs ~/jarvis/ to match the repo and updates the alias.
#
# Usage: bash setup.sh

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

JARVIS_DIR="$HOME/jarvis"
GLOBAL_CLAUDE_DIR="$HOME/.claude"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${CYAN}=============================================${NC}"
echo -e "${CYAN}  Jarvis — Claude Code Setup${NC}"
echo -e "${CYAN}=============================================${NC}"
echo ""

if [ -d "$JARVIS_DIR/.claude" ]; then
    echo -e "${YELLOW}  Existing installation detected — updating.${NC}"
    echo ""
fi

# --- Step 1: Global Claude config ---
echo -e "${GREEN}[1/17]${NC} Setting up global Claude config (~/.claude/CLAUDE.md)..."
mkdir -p "$GLOBAL_CLAUDE_DIR"
cp "$SCRIPT_DIR/global-claude/CLAUDE.md" "$GLOBAL_CLAUDE_DIR/CLAUDE.md"
echo "  Done."

# --- Step 2: Project CLAUDE.md ---
echo -e "${GREEN}[2/17]${NC} Setting up Jarvis project directory ($JARVIS_DIR)..."
mkdir -p "$JARVIS_DIR"
cp "$SCRIPT_DIR/CLAUDE.md" "$JARVIS_DIR/CLAUDE.md"
echo "  Done."

# --- Step 3: Rules (clean sync) ---
echo -e "${GREEN}[3/17]${NC} Syncing rules ($JARVIS_DIR/.claude/rules/)..."
mkdir -p "$JARVIS_DIR/.claude/rules"
rm -f "$JARVIS_DIR/.claude/rules/"*.md
cp "$SCRIPT_DIR/.claude/rules/"*.md "$JARVIS_DIR/.claude/rules/"
echo "  Done."

# --- Step 4: Commands (clean sync) ---
echo -e "${GREEN}[4/17]${NC} Syncing commands ($JARVIS_DIR/.claude/commands/)..."
mkdir -p "$JARVIS_DIR/.claude/commands"
rm -f "$JARVIS_DIR/.claude/commands/"*.md
cp "$SCRIPT_DIR/.claude/commands/"*.md "$JARVIS_DIR/.claude/commands/"
echo "  Done."

# --- Step 5: Agents (clean sync) ---
echo -e "${GREEN}[5/17]${NC} Syncing subagents ($JARVIS_DIR/.claude/agents/)..."
mkdir -p "$JARVIS_DIR/.claude/agents"
rm -f "$JARVIS_DIR/.claude/agents/"*.md
cp "$SCRIPT_DIR/.claude/agents/"*.md "$JARVIS_DIR/.claude/agents/"
echo "  Done."

# --- Step 6: Settings ---
echo -e "${GREEN}[6/17]${NC} Setting up project settings ($JARVIS_DIR/.claude/settings.json)..."
cp "$SCRIPT_DIR/.claude/settings.json" "$JARVIS_DIR/.claude/settings.json"
echo "  Done."

# --- Step 7: Monitoring scripts ---
echo -e "${GREEN}[7/17]${NC} Syncing monitoring scripts ($JARVIS_DIR/scripts/)..."
mkdir -p "$JARVIS_DIR/scripts"
mkdir -p "$JARVIS_DIR/logs"
mkdir -p "$JARVIS_DIR/downloads/pending"
mkdir -p "$JARVIS_DIR/telegram-media"
cp "$SCRIPT_DIR/scripts/"*.sh "$JARVIS_DIR/scripts/"
chmod +x "$JARVIS_DIR/scripts/"*.sh
if [ -f "$SCRIPT_DIR/known-devices-labels.conf" ]; then
    cp "$SCRIPT_DIR/known-devices-labels.conf" "$JARVIS_DIR/known-devices-labels.conf"
fi
echo "  Done."

# --- Step 8: Cron jobs ---
echo -e "${GREEN}[8/17]${NC} Installing monitoring cron jobs..."
bash "$JARVIS_DIR/scripts/install-cron.sh"

# --- Step 9: Environment file ---
echo -e "${GREEN}[9/17]${NC} Setting up environment file ($JARVIS_DIR/.env)..."
if [ -f "$JARVIS_DIR/.env" ]; then
    echo "  .env already exists — skipping (won't overwrite your secrets)."
else
    cp "$SCRIPT_DIR/env.example" "$JARVIS_DIR/.env"
    echo -e "  ${YELLOW}Created .env from template. Edit ~/jarvis/.env to add your tokens.${NC}"
fi

# --- Step 10: Telegram bot ---
echo -e "${GREEN}[10/17]${NC} Setting up Telegram bot ($JARVIS_DIR/telegram-bot/)..."
if command -v node &>/dev/null; then
    mkdir -p "$JARVIS_DIR/telegram-bot"
    cp -r "$SCRIPT_DIR/telegram-bot/src" "$JARVIS_DIR/telegram-bot/"
    cp "$SCRIPT_DIR/telegram-bot/package.json" "$JARVIS_DIR/telegram-bot/"
    cd "$JARVIS_DIR/telegram-bot" && npm install --production --silent 2>/dev/null
    cd "$SCRIPT_DIR"
    echo "  Done."
else
    echo -e "  ${YELLOW}Node.js not found — skipping Telegram bot install.${NC}"
    echo "  Install Node.js 18+ and re-run setup to enable the bot."
fi

# --- Step 11: Glances system monitor ---
echo -e "${GREEN}[11/17]${NC} Installing Glances system monitor..."
bash "$SCRIPT_DIR/scripts/install-glances.sh"

# --- Step 12: Telegram bot systemd service ---
echo -e "${GREEN}[12/17]${NC} Installing Telegram bot service..."
if command -v node &>/dev/null; then
    SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SYSTEMD_USER_DIR"
    cp "$SCRIPT_DIR/telegram-bot/jarvis-telegram-bot.service" "$SYSTEMD_USER_DIR/"
    systemctl --user daemon-reload
    systemctl --user enable jarvis-telegram-bot.service 2>/dev/null
    systemctl --user restart jarvis-telegram-bot.service 2>/dev/null
    echo "  Done. Service enabled and (re)started."
else
    echo -e "  ${YELLOW}Skipped (Node.js not available).${NC}"
fi

# --- Step 13: Docker compose for media services ---
echo -e "${GREEN}[13/17]${NC} Setting up Docker Compose for media services..."
if [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
    cp "$SCRIPT_DIR/docker-compose.yml" "$JARVIS_DIR/docker-compose.yml"
    mkdir -p "$JARVIS_DIR/qbittorrent-config" "$JARVIS_DIR/qbittorrent-init"
    cp "$SCRIPT_DIR"/qbittorrent-init/*.sh "$JARVIS_DIR/qbittorrent-init/" 2>/dev/null
    chmod +x "$JARVIS_DIR"/qbittorrent-init/*.sh 2>/dev/null
    if command -v docker &>/dev/null; then
        (cd "$JARVIS_DIR" && docker compose up -d --quiet-pull 2>&1 | tail -1)
        echo "  Done. qBittorrent container is running."
    else
        echo "  Done. Install Docker and run 'cd ~/jarvis && docker compose up -d'."
    fi
else
    echo "  No docker-compose.yml found — skipping."
fi

# --- Step 14: Memory maintenance cron (weekly) ---
echo -e "${GREEN}[14/17]${NC} Installing weekly memory maintenance cron..."
MEMORY_CRON="0 3 * * 0 ${JARVIS_DIR}/scripts/memory-maintenance.sh >> ${JARVIS_DIR}/logs/memory-maintenance.log 2>&1"
if crontab -l 2>/dev/null | grep -q "memory-maintenance"; then
    echo "  Memory maintenance cron already installed — skipping."
else
    (crontab -l 2>/dev/null; echo "$MEMORY_CRON") | crontab -
    echo "  Done. Runs every Sunday at 3 AM."
fi

# --- Step 15: WiFi power save fix (RTL8821CE) ---
echo -e "${GREEN}[15/17]${NC} Installing WiFi power save fix..."
if iw dev wlan0 info &>/dev/null; then
    sudo cp "$SCRIPT_DIR/wifi-powersave-off.service" /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable wifi-powersave-off.service 2>/dev/null
    sudo systemctl start wifi-powersave-off.service 2>/dev/null
    echo "  Done. WiFi power save disabled (prevents driver crash after heavy I/O)."
else
    echo "  No wlan0 interface found — skipping (not needed on wired connections)."
fi

# --- Step 16: Seed monitoring allowlists ---
echo -e "${GREEN}[16/17]${NC} Seeding monitoring allowlists..."
ALLOWLIST="$JARVIS_DIR/logs/docker-security-allowlist.txt"
for CONTAINER in qbittorrent pgvector jarvis-frontend jarvis-backend; do
    if ! grep -qxF "$CONTAINER" "$ALLOWLIST" 2>/dev/null; then
        echo "$CONTAINER" >> "$ALLOWLIST"
    fi
done
echo "  Done. Docker security allowlist: $ALLOWLIST"

# --- Step 17: Finalise ---
echo -e "${GREEN}[17/17]${NC} Finalising..."
echo "  Done."

# --- Shell alias ---
echo ""

ALIAS_CMD='alias jarvis="cd ~/jarvis && claude --dangerously-skip-permissions"'
UPDATE_CMD='alias jarvis-update="cd ~/repos/jarvis-ui && sudo git pull && cd jarvis-home && bash setup.sh"'
SHELL_RC=""

if [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
elif [ -f "$HOME/.zshrc" ]; then
    SHELL_RC="$HOME/.zshrc"
fi

if [ -n "$SHELL_RC" ]; then
    # Remove any existing jarvis aliases and their comment header
    grep -v '^# Jarvis .* Claude Code' "$SHELL_RC" | grep -v '^alias jarvis=' | grep -v '^alias jarvis-update=' > "$SHELL_RC.tmp"
    mv "$SHELL_RC.tmp" "$SHELL_RC"

    # Add fresh aliases
    echo '' >> "$SHELL_RC"
    echo '# Jarvis — Claude Code assistant' >> "$SHELL_RC"
    echo 'alias jarvis="cd ~/jarvis && claude --dangerously-skip-permissions"' >> "$SHELL_RC"
    echo 'alias jarvis-update="cd ~/repos/jarvis-ui && sudo git pull && cd jarvis-home && bash setup.sh"' >> "$SHELL_RC"

    echo -e "  ${GREEN}Aliases configured in $SHELL_RC${NC}"
    echo ""
    echo -e "  Run 'source $SHELL_RC' or open a new terminal to activate."
else
    echo "  Could not detect shell config file. Add manually:"
    echo "    $ALIAS_CMD"
    echo "    $UPDATE_CMD"
fi

# --- Summary ---
echo ""
echo -e "${CYAN}=============================================${NC}"
echo -e "${CYAN}  Setup Complete${NC}"
echo -e "${CYAN}=============================================${NC}"
echo ""
echo "  Structure:"
echo ""
echo "    ~/.claude/CLAUDE.md                (global preferences)"
echo "    ~/jarvis/CLAUDE.md                 (project context)"
echo "    ~/jarvis/.claude/rules/            (persona, safety, infrastructure)"
echo "    ~/jarvis/.claude/commands/         (status, docker, services, jellyfin, homeassistant, ha-automate, ha-scene, n8n, storage, network)"
echo "    ~/jarvis/.claude/agents/           (diagnostics, docker-ops, research)"
echo "    ~/jarvis/.claude/settings.json     (permissions)"
echo "    ~/jarvis/scripts/                  (monitoring: disk, SMART, services, backups, samba, network, SSH, Docker, SSL, firewall)"
echo "    ~/jarvis/logs/                     (monitoring logs)"
echo "    ~/jarvis/telegram-bot/             (Telegram bot for mobile access)"
echo "    ~/jarvis/docker-compose.yml        (qBittorrent media service)"
    echo "    ~/jarvis/downloads/pending/        (download organize queue)"
    echo "    ~/jarvis/telegram-media/           (media from Telegram messages)"
    echo "    ~/jarvis/known-devices-labels.conf (network device labels)"
    echo "    ~/jarvis/.env                      (secrets - HA, n8n, Telegram, qBittorrent)"
    echo "    /etc/systemd/system/wifi-powersave-off.service (WiFi driver fix)"
echo ""
echo "  To start Jarvis:"
echo ""
echo "    cd ~/jarvis && claude --dangerously-skip-permissions"
echo ""
echo "  Or if you have the alias:"
echo ""
echo "    jarvis"
echo ""
