#!/bin/bash
# Jarvis UI - Linux Deployment Script
# Run this on your Linux server to deploy Jarvis UI
#
# Usage: 
#   curl -sSL https://raw.githubusercontent.com/YOUR_REPO/jarvis-ui/main/scripts/linux/deploy.sh | bash
#   OR
#   ./deploy.sh [--docker|--native] [--no-autostart]

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
INSTALL_DIR="${JARVIS_INSTALL_DIR:-/opt/jarvis-ui}"
REPO_URL="${JARVIS_REPO_URL:-https://github.com/AmirKakon/jarvis-ui.git}"
USE_DOCKER=false
ENABLE_AUTOSTART=true
BRANCH="main"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --docker)
            USE_DOCKER=true
            shift
            ;;
        --native)
            USE_DOCKER=false
            shift
            ;;
        --no-autostart)
            ENABLE_AUTOSTART=false
            shift
            ;;
        --branch)
            BRANCH="$2"
            shift 2
            ;;
        --dir)
            INSTALL_DIR="$2"
            shift 2
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

echo -e "${CYAN}=============================================${NC}"
echo -e "${CYAN}  Jarvis UI - Linux Deployment${NC}"
echo -e "${CYAN}=============================================${NC}"
echo ""
echo -e "Install directory: ${GREEN}$INSTALL_DIR${NC}"
echo -e "Method: ${GREEN}$([ "$USE_DOCKER" = true ] && echo "Docker" || echo "Native")${NC}"
echo -e "Auto-start: ${GREEN}$([ "$ENABLE_AUTOSTART" = true ] && echo "Yes" || echo "No")${NC}"
echo ""

# Check if running as root for system-wide install
if [ "$EUID" -ne 0 ] && [[ "$INSTALL_DIR" == /opt/* ]]; then
    echo -e "${YELLOW}Note: Installing to /opt requires sudo. Re-running with sudo...${NC}"
    exec sudo "$0" "$@"
fi

# Install dependencies
echo -e "${YELLOW}Checking dependencies...${NC}"

install_package() {
    if command -v apt-get &> /dev/null; then
        apt-get update && apt-get install -y "$@"
    elif command -v dnf &> /dev/null; then
        dnf install -y "$@"
    elif command -v yum &> /dev/null; then
        yum install -y "$@"
    elif command -v pacman &> /dev/null; then
        pacman -S --noconfirm "$@"
    else
        echo -e "${RED}Unable to install packages. Please install manually: $@${NC}"
        return 1
    fi
}

# Git
if ! command -v git &> /dev/null; then
    echo -e "${YELLOW}Installing git...${NC}"
    install_package git
fi

if [ "$USE_DOCKER" = true ]; then
    # Docker
    if ! command -v docker &> /dev/null; then
        echo -e "${YELLOW}Installing Docker...${NC}"
        curl -fsSL https://get.docker.com | sh
        systemctl enable docker
        systemctl start docker
    fi
    
    # Docker Compose
    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
        echo -e "${YELLOW}Installing Docker Compose...${NC}"
        apt-get install -y docker-compose-plugin || install_package docker-compose
    fi
else
    # Python
    if ! command -v python3 &> /dev/null; then
        echo -e "${YELLOW}Installing Python...${NC}"
        install_package python3 python3-pip python3-venv
    fi
    
    # Node.js
    if ! command -v node &> /dev/null; then
        echo -e "${YELLOW}Installing Node.js...${NC}"
        if command -v apt-get &> /dev/null; then
            curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
            apt-get install -y nodejs
        else
            install_package nodejs npm
        fi
    fi
fi

echo -e "${GREEN}Dependencies OK${NC}"
echo ""

# Clone or update repository
if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}Updating existing installation...${NC}"
    cd "$INSTALL_DIR"
    git fetch origin
    git checkout "$BRANCH"
    git pull origin "$BRANCH"
else
    echo -e "${YELLOW}Cloning repository...${NC}"
    git clone -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

echo -e "${GREEN}Repository ready${NC}"
echo ""

# Setup environment file
ENV_FILE="$INSTALL_DIR/backend/.env"
if [ ! -f "$ENV_FILE" ]; then
    echo -e "${YELLOW}Creating environment file...${NC}"
    cp "$INSTALL_DIR/backend/env.example" "$ENV_FILE"
    
    echo ""
    echo -e "${CYAN}=============================================${NC}"
    echo -e "${CYAN}  IMPORTANT: Configure your environment${NC}"
    echo -e "${CYAN}=============================================${NC}"
    echo ""
    echo -e "Edit the environment file with your settings:"
    echo -e "  ${GREEN}nano $ENV_FILE${NC}"
    echo ""
    echo -e "Required settings:"
    echo -e "  - DATABASE_URL (PostgreSQL connection)"
    echo -e "  - OPENAI_API_KEY (or other LLM provider key)"
    echo -e "  - N8N_API_URL and N8N_API_KEY"
    echo ""
    read -p "Press Enter to edit the .env file now (or Ctrl+C to exit)..."
    ${EDITOR:-nano} "$ENV_FILE"
fi

# Docker deployment
if [ "$USE_DOCKER" = true ]; then
    echo -e "${YELLOW}Building and starting Docker containers...${NC}"
    
    # Create .env for docker-compose in project root
    if [ ! -f "$INSTALL_DIR/.env" ]; then
        # Copy values from backend .env
        cp "$ENV_FILE" "$INSTALL_DIR/.env"
    fi
    
    cd "$INSTALL_DIR"
    docker compose down 2>/dev/null || true
    docker compose up -d --build
    
    echo -e "${GREEN}Docker containers started${NC}"
    
# Native deployment
else
    echo -e "${YELLOW}Setting up native deployment...${NC}"
    
    # Backend setup
    echo -e "${YELLOW}Setting up backend...${NC}"
    cd "$INSTALL_DIR/backend"
    
    if [ ! -d "venv" ]; then
        python3 -m venv venv
    fi
    
    source venv/bin/activate
    pip install --upgrade pip
    pip install -r requirements.txt
    
    # Run migrations
    echo -e "${YELLOW}Running database migrations...${NC}"
    alembic upgrade head || echo -e "${YELLOW}Migration warning (may be OK if already up to date)${NC}"
    
    deactivate
    
    # Frontend setup
    echo -e "${YELLOW}Setting up frontend...${NC}"
    cd "$INSTALL_DIR/frontend"
    npm ci
    npm run build
    
    echo -e "${GREEN}Application built${NC}"
fi

# Setup systemd services for auto-start
if [ "$ENABLE_AUTOSTART" = true ]; then
    echo -e "${YELLOW}Setting up auto-start services...${NC}"
    
    if [ "$USE_DOCKER" = true ]; then
        # Docker systemd service
        cat > /etc/systemd/system/jarvis-ui.service << EOF
[Unit]
Description=Jarvis UI (Docker)
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF
        
        systemctl daemon-reload
        systemctl enable jarvis-ui.service
        echo -e "${GREEN}Created systemd service: jarvis-ui${NC}"
        
    else
        # Backend systemd service
        cat > /etc/systemd/system/jarvis-backend.service << EOF
[Unit]
Description=Jarvis UI Backend
After=network.target postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR/backend
Environment="PATH=$INSTALL_DIR/backend/venv/bin"
ExecStart=$INSTALL_DIR/backend/venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 20005
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
        
        # Frontend systemd service (serves built files via backend, so not needed separately)
        # But if you want dev server:
        cat > /etc/systemd/system/jarvis-frontend.service << EOF
[Unit]
Description=Jarvis UI Frontend (Dev Server)
After=network.target jarvis-backend.service

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR/frontend
ExecStart=/usr/bin/npm run dev -- --host 0.0.0.0
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
        
        systemctl daemon-reload
        systemctl enable jarvis-backend.service
        # Don't enable frontend by default (production uses built files from backend)
        # systemctl enable jarvis-frontend.service
        
        echo -e "${GREEN}Created systemd services: jarvis-backend${NC}"
    fi
fi

# Start services
echo -e "${YELLOW}Starting services...${NC}"

if [ "$USE_DOCKER" = true ]; then
    systemctl start jarvis-ui.service 2>/dev/null || docker compose up -d
else
    systemctl start jarvis-backend.service
fi

echo ""
echo -e "${CYAN}=============================================${NC}"
echo -e "${CYAN}  Deployment Complete!${NC}"
echo -e "${CYAN}=============================================${NC}"
echo ""
echo -e "Access Jarvis UI at:"
echo -e "  ${GREEN}http://$(hostname -I | awk '{print $1}'):20005${NC}"
echo -e "  ${GREEN}http://localhost:20005${NC}"
echo ""
echo -e "API Documentation:"
echo -e "  ${GREEN}http://localhost:20005/docs${NC}"
echo ""
echo -e "Management commands:"
if [ "$USE_DOCKER" = true ]; then
    echo -e "  Start:   ${CYAN}systemctl start jarvis-ui${NC}"
    echo -e "  Stop:    ${CYAN}systemctl stop jarvis-ui${NC}"
    echo -e "  Status:  ${CYAN}systemctl status jarvis-ui${NC}"
    echo -e "  Logs:    ${CYAN}docker compose logs -f${NC}"
else
    echo -e "  Start:   ${CYAN}systemctl start jarvis-backend${NC}"
    echo -e "  Stop:    ${CYAN}systemctl stop jarvis-backend${NC}"
    echo -e "  Status:  ${CYAN}systemctl status jarvis-backend${NC}"
    echo -e "  Logs:    ${CYAN}journalctl -u jarvis-backend -f${NC}"
fi
echo ""

