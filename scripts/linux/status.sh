#!/bin/bash
# Jarvis UI - Status Check for Linux

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

INSTALL_DIR="${JARVIS_INSTALL_DIR:-/opt/jarvis-ui}"

echo -e "${CYAN}=============================================${NC}"
echo -e "${CYAN}  Jarvis UI - Status${NC}"
echo -e "${CYAN}=============================================${NC}"
echo ""

# Check Docker containers
echo -e "${YELLOW}Docker Containers:${NC}"
if command -v docker &> /dev/null && [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    cd "$INSTALL_DIR"
    docker compose ps 2>/dev/null || echo "  Not running"
else
    echo "  Docker not used or not available"
fi
echo ""

# Check systemd services
echo -e "${YELLOW}Systemd Services:${NC}"
for service in jarvis-ui jarvis-backend jarvis-frontend; do
    if systemctl list-unit-files | grep -q "^$service.service"; then
        status=$(systemctl is-active $service 2>/dev/null)
        enabled=$(systemctl is-enabled $service 2>/dev/null)
        if [ "$status" = "active" ]; then
            echo -e "  $service: ${GREEN}running${NC} (${enabled})"
        else
            echo -e "  $service: ${RED}$status${NC} (${enabled})"
        fi
    fi
done
echo ""

# Check ports
echo -e "${YELLOW}Port Status:${NC}"
check_port() {
    local port=$1
    local name=$2
    if ss -tuln | grep -q ":$port "; then
        echo -e "  $name (port $port): ${GREEN}LISTENING${NC}"
    else
        echo -e "  $name (port $port): ${RED}NOT LISTENING${NC}"
    fi
}

check_port 20005 "Backend"
check_port 20006 "Frontend (dev)"
echo ""

# Health check
echo -e "${YELLOW}Health Check:${NC}"
if curl -s -o /dev/null -w "%{http_code}" http://localhost:20005/api/health 2>/dev/null | grep -q "200"; then
    echo -e "  API: ${GREEN}OK${NC}"
else
    echo -e "  API: ${RED}UNREACHABLE${NC}"
fi

if curl -s -o /dev/null -w "%{http_code}" http://localhost:20005 2>/dev/null | grep -q "200"; then
    echo -e "  Frontend: ${GREEN}OK${NC}"
else
    echo -e "  Frontend: ${RED}UNREACHABLE${NC}"
fi
echo ""

# Get IP address
IP=$(hostname -I | awk '{print $1}')
echo -e "${YELLOW}Access URLs:${NC}"
echo -e "  Local:    ${CYAN}http://localhost:20005${NC}"
echo -e "  Network:  ${CYAN}http://$IP:20005${NC}"
echo -e "  API Docs: ${CYAN}http://localhost:20005/docs${NC}"

