#!/bin/sh
# Runs once on a freshly cloned image (marker /var/lib/logship-print-agent/.first-boot, created by
# `touch` before imaging): new ssh host keys, machine-id, unique hostname suffix, empty agent token.
set -e
MARK=/var/lib/logship-print-agent/.first-boot
[ -f "$MARK" ] || exit 0
rm -f /etc/ssh/ssh_host_*
dpkg-reconfigure -f noninteractive openssh-server >/dev/null 2>&1 || ssh-keygen -A
rm -f /etc/machine-id /var/lib/dbus/machine-id
systemd-machine-id-setup
ln -sf /etc/machine-id /var/lib/dbus/machine-id
SUFFIX=$(cut -c1-4 /etc/machine-id)
hostnamectl set-hostname "logship-print-${SUFFIX}" || true
sed -i "s/^127\.0\.1\.1.*/127.0.1.1 logship-print-${SUFFIX}/" /etc/hosts || true
# never ship a token from the golden image
sed -i 's/^LOGSHIP_AGENT_TOKEN=.*/LOGSHIP_AGENT_TOKEN=/' /etc/logship-print-agent/agent.env || true
rm -rf /var/lib/logship-print-agent/spool/* /var/lib/logship-print-agent/ledger.json
rm -f "$MARK"
logger -t logship-first-boot "identity regenerated, hostname logship-print-${SUFFIX}"
