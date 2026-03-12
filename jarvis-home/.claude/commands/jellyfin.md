Interact with the Jellyfin media server. Argument: $ARGUMENTS

Use curl to interact with the Jellyfin API. The Jellyfin server runs locally.

## Common Patterns

- **No arguments or "status"**: Check if Jellyfin is running (`docker ps | grep jellyfin` or `systemctl status jellyfin`) and report its status
- **"sessions"**: Show active streaming sessions
- **"libraries"**: List all media libraries
- **"search <query>"**: Search for media items by name
- **"scan"**: Trigger a library scan
- **"activity"**: Show recent activity log

## Notes
- Jellyfin API typically requires an API key — check if one is configured in the environment
- If Jellyfin runs in Docker, use `docker logs jellyfin` for troubleshooting
