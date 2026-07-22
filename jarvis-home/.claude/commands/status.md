Run a full system health check and present a concise summary.

Hand off to the **diagnostics** subagent — it is the canonical definition of which metrics to gather (uptime, CPU load, memory, disk, Docker containers, failed systemd services, network) and how to flag warnings. Do not re-list or re-run the individual commands here.

Present the subagent's report as a clean, organised summary, keeping its warning flags for CPU load > cores, memory > 85%, disk > 90%, and any stopped containers or failed services.
