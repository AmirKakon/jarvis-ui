#!/bin/bash
# Jarvis Claude Code Setup Script
# Run this on the Linux machine to deploy the Claude Code configuration.
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

# --- Step 1: Global Claude config ---
echo -e "${GREEN}[1/5]${NC} Setting up global Claude config (~/.claude/CLAUDE.md)..."
mkdir -p "$GLOBAL_CLAUDE_DIR"
cp "$SCRIPT_DIR/global-claude/CLAUDE.md" "$GLOBAL_CLAUDE_DIR/CLAUDE.md"
echo "  Done."

# --- Step 2: Project directory ---
echo -e "${GREEN}[2/5]${NC} Setting up Jarvis project directory ($JARVIS_DIR)..."
mkdir -p "$JARVIS_DIR"
cp "$SCRIPT_DIR/CLAUDE.md" "$JARVIS_DIR/CLAUDE.md"
echo "  Done."

# --- Step 3: Rules ---
echo -e "${GREEN}[3/5]${NC} Setting up rules ($JARVIS_DIR/.claude/rules/)..."
mkdir -p "$JARVIS_DIR/.claude/rules"
cp "$SCRIPT_DIR/.claude/rules/"*.md "$JARVIS_DIR/.claude/rules/"
echo "  Done."

# --- Step 4: Commands ---
echo -e "${GREEN}[4/5]${NC} Setting up commands ($JARVIS_DIR/.claude/commands/)..."
mkdir -p "$JARVIS_DIR/.claude/commands"
cp "$SCRIPT_DIR/.claude/commands/"*.md "$JARVIS_DIR/.claude/commands/"
echo "  Done."

# --- Step 5: Settings ---
echo -e "${GREEN}[5/5]${NC} Setting up project settings ($JARVIS_DIR/.claude/settings.json)..."
cp "$SCRIPT_DIR/.claude/settings.json" "$JARVIS_DIR/.claude/settings.json"
echo "  Done."

# --- Shell alias ---
echo ""
echo -e "${YELLOW}Optional:${NC} Add a shell alias for quick access."
echo ""

ALIAS_LINE='alias jarvis="cd ~/jarvis && claude"'
SHELL_RC=""

if [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
elif [ -f "$HOME/.zshrc" ]; then
    SHELL_RC="$HOME/.zshrc"
fi

if [ -n "$SHELL_RC" ]; then
    if grep -q 'alias jarvis=' "$SHELL_RC" 2>/dev/null; then
        echo -e "  Alias already exists in $SHELL_RC"
    else
        read -p "  Add 'jarvis' alias to $SHELL_RC? [y/N] " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo "" >> "$SHELL_RC"
            echo "# Jarvis — Claude Code assistant" >> "$SHELL_RC"
            echo "$ALIAS_LINE" >> "$SHELL_RC"
            echo -e "  ${GREEN}Alias added.${NC} Run 'source $SHELL_RC' or open a new terminal."
        else
            echo "  Skipped. You can add it manually:"
            echo "    $ALIAS_LINE"
        fi
    fi
else
    echo "  Could not detect shell config file. Add manually:"
    echo "    $ALIAS_LINE"
fi

# --- Summary ---
echo ""
echo -e "${CYAN}=============================================${NC}"
echo -e "${CYAN}  Setup Complete${NC}"
echo -e "${CYAN}=============================================${NC}"
echo ""
echo "  Structure created:"
echo ""
echo "    ~/.claude/CLAUDE.md                (global preferences)"
echo "    ~/jarvis/CLAUDE.md                 (project context)"
echo "    ~/jarvis/.claude/rules/            (persona, safety, infrastructure)"
echo "    ~/jarvis/.claude/commands/         (status, docker, services, jellyfin)"
echo "    ~/jarvis/.claude/settings.json     (permissions)"
echo ""
echo "  To start Jarvis:"
echo ""
echo "    cd ~/jarvis && claude"
echo ""
echo "  Or if you added the alias:"
echo ""
echo "    jarvis"
echo ""
