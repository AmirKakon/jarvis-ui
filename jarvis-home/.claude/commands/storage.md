Check storage health and usage. Argument: $ARGUMENTS

## Common Patterns

- **No arguments or "overview"**: Run all of the following and present a unified summary:
  1. `df -h` — disk usage for all mounted filesystems
  2. `lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT,MODEL` — block devices and mount points
  3. `mount | grep -E '/dev/sd|/dev/nvm'` — currently mounted drives

- **"health" or "smart"**: Check SMART health for all drives:
  1. `ls /dev/sd?` to find drives
  2. For each drive: `sudo smartctl -H /dev/sdX` (overall health)
  3. For details: `sudo smartctl -A /dev/sdX` (attributes with thresholds)
  4. Flag any attributes with VALUE approaching THRESHOLD
  5. Note: requires smartmontools (`sudo apt install smartmontools` if missing)

- **"usage" or "space"**: Detailed space breakdown:
  1. `df -h` for all filesystems
  2. `du -sh ~/shared-storage ~/shared-storage-2` for external drive usage
  3. Flag any filesystem above 85% usage

- **"samba" or "shares"**: Samba file sharing status:
  1. `smbstatus --shares` — active share connections
  2. `smbstatus --processes` — connected users/clients
  3. `testparm -s 2>/dev/null | grep -A5 '\['` — configured shares
  4. `systemctl status smbd` — service status

- **"mounts"**: Show mount details:
  1. `findmnt --real` — tree view of real filesystems
  2. Check for any failed mounts in `dmesg | grep -i 'mount\|error' | tail -10`

- **"top" or "largest"**: Find largest files/directories:
  1. `du -sh ~/shared-storage/*/ ~/shared-storage-2/*/ 2>/dev/null | sort -rh | head -20`

## Warnings
- Flag drives with SMART health != PASSED
- Flag filesystems above 85% (warning) or 95% (critical)
- Flag unmounted drives that are present in `lsblk` but not mounted

## Storage Paths
- **Internal SSD** (`/dev/sda`, 476G): Boot drive, OS, home directory
- **External drive 1** (`/dev/sdb`, 931G, exfat): `~/shared-storage` — movies, tv-shows, music, gopro, camera, dji, google-data, programming, etc.
- **External drive 2** (`/dev/sdc`, 4.5T, ntfs): `~/shared-storage-2` — movies, tv-shows, ha-backups (Home Assistant backups)
- Both external drives are shared via Samba
- Note: shared-storage-2 may not auto-mount on boot (fstab uses /dev/sdc1 which can be unreliable for USB drives — consider switching to UUID)
