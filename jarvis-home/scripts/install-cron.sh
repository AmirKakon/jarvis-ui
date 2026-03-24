#!/bin/bash
# Install Jarvis monitoring cron jobs.
# Safe to re-run — removes old Jarvis cron entries before adding fresh ones.

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPTS_DIR="$HOME/jarvis/scripts"

echo -e "${GREEN}Installing Jarvis monitoring cron jobs...${NC}"
echo ""

# Remove any existing Jarvis cron entries
crontab -l 2>/dev/null | grep -v '# jarvis-monitor' | grep -v 'jarvis/scripts/' > /tmp/jarvis-cron-clean
 
# Add new cron jobs
cat >> /tmp/jarvis-cron-clean << EOF

# jarvis-monitor: service & Docker health (every 15 min)
*/15 * * * * $SCRIPTS_DIR/service-monitor.sh

# jarvis-monitor: disk usage watchdog (every 6 hours)
0 */6 * * * $SCRIPTS_DIR/disk-watchdog.sh

# jarvis-monitor: SMART drive health (daily at 06:00)
0 6 * * * $SCRIPTS_DIR/smart-monitor.sh

# jarvis-monitor: backup freshness check (daily at 08:00)
0 8 * * * $SCRIPTS_DIR/backup-checker.sh

# jarvis-monitor: Samba share health (every 15 min)
*/15 * * * * $SCRIPTS_DIR/samba-monitor.sh

# jarvis-monitor: HA auto-update (weekly Sunday 03:00)
0 3 * * 0 $SCRIPTS_DIR/ha-update.sh
EOF

crontab /tmp/jarvis-cron-clean
rm -f /tmp/jarvis-cron-clean

echo "  Cron jobs installed:"
echo ""
echo "    Every 15 min  — service-monitor.sh  (Docker + systemd health)"
echo "    Every 15 min  — samba-monitor.sh   (Samba share health)"
echo "    Every 6 hours — disk-watchdog.sh    (filesystem usage)"
echo "    Daily 06:00   — smart-monitor.sh    (drive SMART health)"
echo "    Daily 08:00   — backup-checker.sh   (HA backup freshness)"
echo "    Sunday 03:00  — ha-update.sh        (HA auto-update)"
echo ""
echo -e "  Verify with: ${YELLOW}crontab -l${NC}"
echo -e "  Logs in:     ${YELLOW}~/jarvis/logs/${NC}"
echo ""
