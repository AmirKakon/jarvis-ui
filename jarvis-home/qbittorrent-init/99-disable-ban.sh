#!/bin/bash
# LinuxServer.io custom-init script: disable IP ban for failed auth attempts.
# The bot's login retries can trigger bans on the local network,
# which is unnecessary since qBT is only accessible internally.

QBT_CONF="/config/qBittorrent/qBittorrent.conf"

if [ -f "$QBT_CONF" ]; then
    if grep -q "WebUI\\\\MaxAuthenticationFailCount" "$QBT_CONF"; then
        sed -i 's/WebUI\\MaxAuthenticationFailCount=.*/WebUI\\MaxAuthenticationFailCount=0/' "$QBT_CONF"
    else
        sed -i '/^\[Preferences\]/a WebUI\\MaxAuthenticationFailCount=0' "$QBT_CONF"
    fi
fi
