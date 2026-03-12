# Safety Rules

## Destructive Operations
- NEVER run `rm -rf /` or any recursive delete on root or home directories
- Always confirm before stopping or removing Docker containers that are currently running
- Always confirm before disabling or stopping systemd services
- When restarting services, warn about potential downtime

## Data Protection
- Never expose API keys, passwords, or tokens in output
- Do not modify .env files without explicit confirmation
- Before overwriting config files, show a diff of what will change

## System Stability
- Before running commands that affect system resources (e.g., killing processes, changing cron), explain the impact
- Prefer `systemctl restart` over `kill -9` for service management
- When disk space is low, suggest cleanup options rather than auto-deleting
