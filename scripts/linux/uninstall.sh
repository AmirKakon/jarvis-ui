#!/bin/bash
# Jarvis UI - Uninstall Script for Linux

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

INSTALL_DIR="${JARVIS_INSTALL_DIR:-/opt/jarvis-ui}"

echo -e "${CYAN}=============================================${NC}"
echo -e "${CYAN}  Jarvis UI - Uninstall${NC}"
echo -e "${CYAN}=============================================${NC}"
echo ""

read -p "Are you sure you want to uninstall Jarvis UI? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 0
fi

echo -e "${YELLOW}Stopping services...${NC}"

# Stop Docker
if command -v docker &> /dev/null; then
    cd "$INSTALL_DIR" 2>/dev/null && docker compose down 2>/dev/null || true
fi

# Stop and disable systemd services
systemctl stop jarvis-ui 2>/dev/null || true
systemctl stop jarvis-backend 2>/dev/null || true
systemctl stop jarvis-frontend 2>/dev/null || true

systemctl disable jarvis-ui 2>/dev/null || true
systemctl disable jarvis-backend 2>/dev/null || true
systemctl disable jarvis-frontend 2>/dev/null || true

# Remove systemd service files
rm -f /etc/systemd/system/jarvis-ui.service
rm -f /etc/systemd/system/jarvis-backend.service
rm -f /etc/systemd/system/jarvis-frontend.service
systemctl daemon-reload

echo -e "${YELLOW}Removing installation directory...${NC}"
read -p "Remove $INSTALL_DIR? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -rf "$INSTALL_DIR"
    echo -e "${GREEN}Directory removed${NC}"
else
    echo -e "${YELLOW}Directory kept at $INSTALL_DIR${NC}"
fi

echo ""
echo -e "${GREEN}Uninstall complete!${NC}"

