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
echo -e "${GREEN}[1/6]${NC} Setting up global Claude config (~/.claude/CLAUDE.md)..."
mkdir -p "$GLOBAL_CLAUDE_DIR"
cp "$SCRIPT_DIR/global-claude/CLAUDE.md" "$GLOBAL_CLAUDE_DIR/CLAUDE.md"
echo "  Done."

# --- Step 2: Project CLAUDE.md ---
echo -e "${GREEN}[2/6]${NC} Setting up Jarvis project directory ($JARVIS_DIR)..."
mkdir -p "$JARVIS_DIR"
cp "$SCRIPT_DIR/CLAUDE.md" "$JARVIS_DIR/CLAUDE.md"
echo "  Done."

# --- Step 3: Rules (clean sync) ---
echo -e "${GREEN}[3/6]${NC} Syncing rules ($JARVIS_DIR/.claude/rules/)..."
mkdir -p "$JARVIS_DIR/.claude/rules"
rm -f "$JARVIS_DIR/.claude/rules/"*.md
cp "$SCRIPT_DIR/.claude/rules/"*.md "$JARVIS_DIR/.claude/rules/"
echo "  Done."

# --- Step 4: Commands (clean sync) ---
echo -e "${GREEN}[4/6]${NC} Syncing commands ($JARVIS_DIR/.claude/commands/)..."
mkdir -p "$JARVIS_DIR/.claude/commands"
rm -f "$JARVIS_DIR/.claude/commands/"*.md
cp "$SCRIPT_DIR/.claude/commands/"*.md "$JARVIS_DIR/.claude/commands/"
echo "  Done."

# --- Step 5: Agents (clean sync) ---
echo -e "${GREEN}[5/6]${NC} Syncing subagents ($JARVIS_DIR/.claude/agents/)..."
mkdir -p "$JARVIS_DIR/.claude/agents"
rm -f "$JARVIS_DIR/.claude/agents/"*.md
cp "$SCRIPT_DIR/.claude/agents/"*.md "$JARVIS_DIR/.claude/agents/"
echo "  Done."

# --- Step 6: Settings ---
echo -e "${GREEN}[6/6]${NC} Setting up project settings ($JARVIS_DIR/.claude/settings.json)..."
cp "$SCRIPT_DIR/.claude/settings.json" "$JARVIS_DIR/.claude/settings.json"
echo "  Done."

# --- Shell alias ---
echo ""

ALIAS_CMD='alias jarvis="cd ~/jarvis && claude --dangerously-skip-permissions"'
UPDATE_CMD='alias jarvis-update="cd ~/repos/jarvis-ui && sudo git pull origin feature/claude-code && cd jarvis-home && bash setup.sh"'
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
    echo 'alias jarvis-update="cd ~/repos/jarvis-ui && sudo git pull origin feature/claude-code && cd jarvis-home && bash setup.sh"' >> "$SHELL_RC"

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
echo "    ~/jarvis/.claude/commands/         (status, docker, services, jellyfin)"
echo "    ~/jarvis/.claude/agents/           (diagnostics, docker-ops, research)"
echo "    ~/jarvis/.claude/settings.json     (permissions)"
echo ""
echo "  To start Jarvis:"
echo ""
echo "    cd ~/jarvis && claude --dangerously-skip-permissions"
echo ""
echo "  Or if you have the alias:"
echo ""
echo "    jarvis"
echo ""
