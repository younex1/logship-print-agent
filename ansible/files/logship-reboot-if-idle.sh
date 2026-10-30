#!/bin/sh
# Night reboot only when (a) an update requires it and (b) no print job is open anywhere.
[ -f /run/reboot-required ] || exit 0
# CUPS queue empty?
if lpstat -o 2>/dev/null | grep -q .; then
  logger -t logship-reboot "reboot required but CUPS jobs pending — postponed"
  exit 0
fi
# agent still holds work? (spool dir non-empty = jobs between download and lp)
if [ -n "$(ls -A /var/lib/logship-print-agent/spool 2>/dev/null)" ]; then
  logger -t logship-reboot "reboot required but agent spool not empty — postponed"
  exit 0
fi
logger -t logship-reboot "rebooting for pending updates"
systemctl reboot
