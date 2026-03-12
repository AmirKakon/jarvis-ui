Manage Docker containers. Argument: $ARGUMENTS

Interpret the user's intent from the arguments and execute the appropriate docker command.

## Common Patterns

- **No arguments or "list"**: Run `docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}"` and show all containers
- **"stats"**: Run `docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}"` for resource usage
- **"logs <name>"**: Run `docker logs --tail 50 <name>` to show recent logs
- **"restart <name>"**: Run `docker restart <name>` after confirming with the user
- **"stop <name>"**: Run `docker stop <name>` after confirming with the user
- **"start <name>"**: Run `docker start <name>`
- **"compose up"**: Run `docker compose up -d` in the relevant project directory
- **"prune"**: Run `docker system df` first to show usage, then confirm before running `docker system prune`

## Safety
- Always confirm before stopping or removing containers
- Show container status after any start/stop/restart operation
- When showing logs, default to last 50 lines unless specified otherwise
