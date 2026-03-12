Manage systemd services. Argument: $ARGUMENTS

Interpret the user's intent from the arguments and execute the appropriate systemctl command.

## Common Patterns

- **No arguments or "list"**: Show all active services with `systemctl --user list-units --type=service --state=running` and `sudo systemctl list-units --type=service --state=running`
- **"failed"**: Show failed services with `systemctl --user list-units --state=failed` and `sudo systemctl list-units --state=failed`
- **"status <name>"**: Run `systemctl --user status <name>` (try user-level first, fall back to `sudo systemctl status <name>`)
- **"restart <name>"**: Confirm, then restart the service. Try user-level first.
- **"stop <name>"**: Confirm, then stop. Warn about impact.
- **"logs <name>"**: Run `journalctl --user-unit <name> -n 50 --no-pager` (or `sudo journalctl -u <name>` for system services)
- **"enable <name>"**: Enable the service to start on boot
- **"disable <name>"**: Confirm, then disable

## Detection
- First try `systemctl --user status <name>` to check if it's a user service
- If not found, try `sudo systemctl status <name>` for system services
- Report which level (user/system) the service runs at
