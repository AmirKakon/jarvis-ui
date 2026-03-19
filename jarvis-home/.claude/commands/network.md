Check network status and connected devices. Argument: $ARGUMENTS

## Common Patterns

- **No arguments or "overview"**: Run all key checks and present a summary:
  1. `ip -br addr` — interfaces with IPs
  2. `ip route | head -5` — default gateway and routes
  3. `cat /etc/resolv.conf` — DNS servers
  4. `ss -tulnp` — listening ports with process names

- **"devices" or "scan"**: Discover devices on the local network:
  1. Find the local subnet: `ip route | grep 'src' | head -1`
  2. Scan with: `sudo arp-scan --localnet 2>/dev/null` or `arp -a` as fallback
  3. If arp-scan not installed, use: `sudo nmap -sn 192.168.68.0/24` or the detected subnet
  4. Present as a table: IP, MAC, hostname (if available)
  5. Note: arp-scan requires `sudo apt install arp-scan` if missing

- **"ports" or "listening"**: Show all listening services:
  1. `ss -tulnp` — TCP/UDP listeners with process names
  2. Group by: well-known ports (22, 80, 443) vs application ports (20000+)
  3. Flag any unexpected listeners

- **"connections" or "active"**: Show active connections:
  1. `ss -tunp` — established TCP/UDP connections
  2. Summarise by remote IP and process

- **"speed" or "bandwidth"**: Quick bandwidth test:
  1. `cat /proc/net/dev` — interface byte counters
  2. Sleep 2 seconds, read again, calculate throughput
  3. Or if available: `ifstat -t 2 1` or `nload` output
  4. Show per-interface throughput

- **"dns"**: DNS configuration and resolution test:
  1. `cat /etc/resolv.conf`
  2. `dig google.com +short` or `nslookup google.com`
  3. Report resolution time

- **"wifi"**: Wireless status (if applicable):
  1. `iwconfig 2>/dev/null` or `nmcli dev wifi list`

## Warnings
- Flag interfaces that are DOWN
- Flag if default gateway is unreachable (`ping -c1 -W2 <gateway>`)
- Flag unexpected listening ports
