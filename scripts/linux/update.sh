#!/bin/bash
# Jarvis UI - Update Script for Linux
# Updates the installation to the latest version

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

INSTALL_DIR="${JARVIS_INSTALL_DIR:-/opt/jarvis-ui}"

echo -e "${CYAN}=============================================${NC}"
echo -e "${CYAN}  Jarvis UI - Update${NC}"
echo -e "${CYAN}=============================================${NC}"
echo ""

cd "$INSTALL_DIR"

# Detect deployment method
USE_DOCKER=false
if [ -f "docker-compose.yml" ] && systemctl is-active --quiet jarvis-ui 2>/dev/null; then
    USE_DOCKER=true
elif docker compose ps 2>/dev/null | grep -q "jarvis"; then
    USE_DOCKER=true
fi

echo -e "${YELLOW}Stopping services...${NC}"
if [ "$USE_DOCKER" = true ]; then
    docker compose down || true
else
    systemctl stop jarvis-backend 2>/dev/null || true
    systemctl stop jarvis-frontend 2>/dev/null || true
fi

echo -e "${YELLOW}Pulling latest changes...${NC}"
git fetch origin
git pull origin main

if [ "$USE_DOCKER" = true ]; then
    echo -e "${YELLOW}Rebuilding Docker images...${NC}"
    docker compose build
    
    echo -e "${YELLOW}Starting services...${NC}"
    docker compose up -d
else
    echo -e "${YELLOW}Updating backend dependencies...${NC}"
    cd "$INSTALL_DIR/backend"
    source venv/bin/activate
    pip install -r requirements.txt
    
    echo -e "${YELLOW}Running migrations...${NC}"
    alembic upgrade head || true
    deactivate
    
    echo -e "${YELLOW}Rebuilding frontend...${NC}"
    cd "$INSTALL_DIR/frontend"
    npm ci
    npm run build
    
    echo -e "${YELLOW}Starting services...${NC}"
    systemctl start jarvis-backend
fi

echo ""
echo -e "${GREEN}Update complete!${NC}"
echo -e "Access at: ${CYAN}http://localhost:20005${NC}"

