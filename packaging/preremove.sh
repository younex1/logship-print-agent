#!/bin/sh
set -e
if [ "$1" = "remove" ]; then
  systemctl stop logship-print-agent.service || true
  systemctl disable logship-print-agent.service >/dev/null 2>&1 || true
  systemctl stop logship-print-support.service 2>/dev/null || true
fi
exit 0
