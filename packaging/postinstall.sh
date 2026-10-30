#!/bin/sh
set -e
mkdir -p /var/lib/logship-print-agent/spool
chmod 750 /var/lib/logship-print-agent
chmod 600 /etc/logship-print-agent/agent.env 2>/dev/null || true
systemctl daemon-reload || true
systemctl enable logship-print-agent.service >/dev/null 2>&1 || true
# fresh install or upgrade: (re)start so the new bundle runs; jobs resume from the server spool
if systemctl is-active --quiet logship-print-agent.service; then
  systemctl restart logship-print-agent.service || true
else
  systemctl start logship-print-agent.service || true
fi
exit 0
