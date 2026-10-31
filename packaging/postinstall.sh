#!/bin/sh
# logship-print-agent postinst — idempotent; runs on install and every upgrade.
set -e
ENV=/etc/logship-print-agent/agent.env
mkdir -p /var/lib/logship-print-agent/spool
chmod 750 /var/lib/logship-print-agent
touch "$ENV"; chmod 600 "$ENV"

# Local CUPS admin (lpadmin group, no shell) used by the LogShip CUPS web relay; password stays on the box.
if ! grep -q '^CUPS_ADMIN_USER=' "$ENV" 2>/dev/null; then
  if ! id logship-cups >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin -G lpadmin logship-cups 2>/dev/null || adduser --system --no-create-home --shell /usr/sbin/nologin --ingroup lpadmin logship-cups
  fi
  PW=$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-24)
  echo "logship-cups:$PW" | chpasswd
  printf 'CUPS_ADMIN_USER=logship-cups\nCUPS_ADMIN_PASS=%s\n' "$PW" >> "$ENV"
fi

# CUPS limits for label bursts (Debian default MaxJobs 500 rejects big batches with "Too many active jobs").
CONF=/etc/cups/cupsd.conf
if [ -f "$CONF" ] && ! grep -q '^# logship-print-agent limits' "$CONF"; then
  for k in MaxJobs MaxJobsPerPrinter PreserveJobHistory PreserveJobFiles; do sed -i "/^$k /d" "$CONF"; done
  printf '\n# logship-print-agent limits\nMaxJobs 5000\nMaxJobsPerPrinter 2000\nPreserveJobHistory 1d\nPreserveJobFiles No\n' >> "$CONF"
  systemctl reload cups 2>/dev/null || systemctl restart cups 2>/dev/null || true
fi

systemctl daemon-reload || true
systemctl enable cups.service >/dev/null 2>&1 || true
systemctl start cups.service >/dev/null 2>&1 || true
systemctl enable logship-print-agent.service >/dev/null 2>&1 || true
if systemctl is-active --quiet logship-print-agent.service; then
  systemctl restart logship-print-agent.service || true
else
  systemctl start logship-print-agent.service || true
fi
exit 0
