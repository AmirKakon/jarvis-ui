Run a full system health check and present a concise summary.

Gather the following information using shell commands:

1. **Uptime**: `uptime -p`
2. **CPU**: `top -bn1 | head -5` (extract load averages)
3. **Memory**: `free -h`
4. **Disk**: `df -h /`
5. **Docker**: `docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"` (list running containers)
6. **Failed services**: `systemctl --user list-units --state=failed` and `sudo systemctl list-units --state=failed`
7. **Network**: `ip -br addr` (brief interface summary)

Present results as a clean, organised summary table. Flag any warnings:
- CPU load > 80%
- Memory usage > 85%
- Disk usage > 90%
- Any stopped containers or failed services
