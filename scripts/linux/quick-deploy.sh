#!/bin/bash
# Jarvis UI - Quick Deploy One-Liner
# 
# Run on your Linux server:
#   curl -sSL https://raw.githubusercontent.com/YOUR_USER/jarvis-ui/main/scripts/linux/quick-deploy.sh | sudo bash
#
# Or with custom repo:
#   REPO_URL=https://github.com/YOUR_USER/jarvis-ui.git curl -sSL ... | sudo bash

set -e

REPO_URL="${REPO_URL:-https://github.com/AmirKakon/jarvis-ui.git}"
INSTALL_DIR="/opt/jarvis-ui"
BRANCH="${BRANCH:-main}"

echo "========================================"
echo "  Jarvis UI Quick Deploy"
echo "========================================"
echo ""

# Install git if needed
if ! command -v git &> /dev/null; then
    apt-get update && apt-get install -y git || yum install -y git
fi

# Clone repo
if [ ! -d "$INSTALL_DIR" ]; then
    git clone -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

# Make scripts executable
chmod +x "$INSTALL_DIR/scripts/linux/"*.sh

# Run the main deploy script
cd "$INSTALL_DIR"
./scripts/linux/deploy.sh --docker

echo ""
echo "Done! Edit your config: nano $INSTALL_DIR/backend/.env"
echo "Then restart: systemctl restart jarvis-ui"

