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

# jarvis-monitor: network device scanner (every hour)
0 */1 * * * $SCRIPTS_DIR/network-scanner.sh

# jarvis-monitor: SSH intrusion detection (every hour)
0 */1 * * * $SCRIPTS_DIR/ssh-monitor.sh

# jarvis-monitor: SSL certificate expiry (daily at 07:00)
0 7 * * * $SCRIPTS_DIR/ssl-monitor.sh

# jarvis-monitor: firewall & port audit (daily at 07:30)
30 7 * * * $SCRIPTS_DIR/firewall-audit.sh

# jarvis-monitor: HA auto-update (weekly Sunday 03:00)
0 3 * * 0 $SCRIPTS_DIR/ha-update.sh

# jarvis-monitor: Docker security audit (weekly Sunday 04:00)
0 4 * * 0 $SCRIPTS_DIR/docker-security.sh
EOF

crontab /tmp/jarvis-cron-clean
rm -f /tmp/jarvis-cron-clean

echo "  Cron jobs installed:"
echo ""
echo "    Every 15 min  — service-monitor.sh  (Docker + systemd health)"
echo "    Every 15 min  — samba-monitor.sh   (Samba share health)"
echo "    Every 6 hours — disk-watchdog.sh    (filesystem usage)"
echo "    Every hour    — network-scanner.sh  (unknown device detection)"
echo "    Every hour    — ssh-monitor.sh      (SSH intrusion detection)"
echo "    Daily 06:00   — smart-monitor.sh    (drive SMART health)"
echo "    Daily 07:00   — ssl-monitor.sh      (SSL cert expiry)"
echo "    Daily 07:30   — firewall-audit.sh   (firewall & port audit)"
echo "    Daily 08:00   — backup-checker.sh   (HA backup freshness)"
echo "    Sunday 03:00  — ha-update.sh        (HA auto-update)"
echo "    Sunday 04:00  — docker-security.sh  (Docker security audit)"
echo ""
echo -e "  Verify with: ${YELLOW}crontab -l${NC}"
echo -e "  Logs in:     ${YELLOW}~/jarvis/logs/${NC}"
echo ""
